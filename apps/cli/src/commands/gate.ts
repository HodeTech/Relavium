import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import {
  EngineStateError,
  type CheckpointState,
  type RunHandle,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';
import { createRunHistoryStore, loadRunSnapshot, type Db } from '@relavium/db';
import { MaskedSecretSchema, WorkflowSchema, type RunStatus } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { onceEffortNotice, unpricedModelNote } from '../chat/effort-notice.js';
import { createCliHost } from '../engine/host.js';
import {
  sweepHostMediaBestEffort as defaultSweepMedia,
  sweepMediaAtTerminal,
} from '../engine/media-gc.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import { readUserPricingOverlay } from '../engine/pricing-overlay.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { decisionFromFlags, type GateFlags } from '../gate/decision.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import {
  assertWorkflowCatalogValid,
  driveRun,
  isTerminalOutcome,
  outcomeToExitCode,
} from './drive.js';

export interface GateCommandArgs extends GateFlags {
  readonly runId: string;
  /** `--gate <gateId>`: which pending gate to resolve (required only when more than one is pending). */
  readonly gate?: string;
}

export interface GateCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable so tests drive a stub provider + the in-memory host engine. */
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  /** Injectable provider seam (the engine's resolver for a post-gate agent node). Defaults to the env resolver. */
  readonly providers?: ProviderResolver;
  /** Injectable history-db opener — tests pass an in-memory db; production opens `~/.relavium/history.db`. */
  readonly openDb?: (homeDir: string) => { db: Db; close: () => void };
  readonly selectRenderer?: (io: CliIo, global: GlobalOptions) => RunRenderer;
  readonly selectGatePrompter?: (io: CliIo, global: GlobalOptions) => GatePrompter | undefined;
  /** Injectable run-end host media GC (2.S/D-GC); defaults to {@link defaultSweepMedia}. Tests spy on it. */
  readonly sweepMedia?: typeof defaultSweepMedia;
}

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

/**
 * The `save_to` scope root for a resumed run: the ORIGINAL run's persisted `runs.project_root` when it still
 * exists on THIS machine AS A DIRECTORY — so a run started in dir A and resumed from B writes its deliverables
 * under A — else the resumer's cwd. The directory check (`statSync` with `throwIfNoEntry: false`, then
 * `isDirectory`) keeps a cross-machine / CI resume, a deleted-or-moved original dir, OR a path now occupied by a
 * file (a non-dir would only fail the downstream `mkdir`/write with an opaque ENOTDIR) from being used as the jail
 * root; each falls back gracefully, as does a `null` (pre-column run). Known benign window: the dir is checked
 * here but `realpath`'d again at write time (media-write.ts), so a symlink-target swap in between changes only the
 * destination — the realpath+commonpath jail still holds, never escaping the root.
 */
export function resolveSaveToRoot(projectRoot: string | null, resumerCwd: string): string {
  if (
    projectRoot !== null &&
    statSync(projectRoot, { throwIfNoEntry: false })?.isDirectory() === true
  ) {
    return projectRoot;
  }
  return resumerCwd;
}

/**
 * Resume the run from its checkpoint, mapping a typed engine refusal (e.g. `workflow_mismatch` on a corrupt
 * store) to a clean exit-2 invocation fault rather than an unhandled crash — surfaced with the engine's reason.
 */
async function resumeOrFail(
  engine: WorkflowEngine,
  params: Parameters<WorkflowEngine['resumeFromCheckpoint']>[0],
): Promise<RunHandle> {
  try {
    return await engine.resumeFromCheckpoint(params);
  } catch (err) {
    if (err instanceof EngineStateError) {
      throw new CliError(
        'invalid_invocation',
        `cannot resume run ${params.runId}: ${err.message}`,
        {
          cause: err,
        },
      );
    }
    throw err;
  }
}

/**
 * The `relavium gate` core (**2.G**) — resolve a pending human gate from the terminal, the surface-agnostic
 * resume path for a `human_gate:paused` run (an interactive run that paused, or a CI run that exited `3`). It
 * runs in a **fresh process** from the original `relavium run`, so it rebuilds the run's `WorkflowDefinition`
 * + inputs from the durable snapshot (2.H), reconstructs the checkpoint from the persisted event log
 * (`createHistoryCheckpointer`), and calls `engine.resumeFromCheckpoint` over the same store — then drives the
 * resumed run to its terminal through the shared {@link driveRun} core.
 *
 * Resume is **idempotent**: a doubled decision (the run already finished, or this gate was already resolved) is
 * a clean exit-`0` no-op, never a double-advance — leaning on the engine's checkpoint/gate-state idempotency.
 * Flag/lookup faults are typed {@link CliError}s (exit `2`); run-time outcomes map to `0`/`1`/`3`.
 */
export async function gateCommand(args: GateCommandArgs, deps: GateCommandDeps): Promise<ExitCode> {
  // Validate the resolution flags FIRST (cheap, before touching the db): exactly one of --approve/--reject/
  // --input, mutually exclusive, --comment not with --input.
  const flags = decisionFromFlags(args);
  if (!flags.ok) {
    throw new CliError('invalid_invocation', flags.error);
  }
  const decision = flags.decision;

  const { config, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  let opened: { db: Db; close: () => void };
  try {
    opened = (deps.openDb ?? openLocalDb)(homeDir);
  } catch (err) {
    throw new CliError(
      'invalid_invocation',
      `could not open the run history database: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    const snapshot = loadRunSnapshot(opened.db, args.runId);
    if (snapshot === undefined) {
      throw new CliError('invalid_invocation', `no run found with id ${args.runId}`);
    }

    const workflow = parseSnapshot(snapshot.workflowDefinitionSnapshot, args.runId);
    const inputs = parseInputs(snapshot.inputJson, args.runId);
    assertNoMaskedSecretInputs(inputs, args.runId);

    // The workflow-scoped store records the NEW resume events (persist-before-deliver) and resolves the
    // workflow id for the engine's identity guard; the checkpointer reconstructs the paused state from the log.
    // `projectRoot` is intentionally OMITTED here: the engine never re-emits `run:started` on resume, so the only
    // consumer of `deps.projectRoot` (the run:started insert) is unreachable — the original run already persisted
    // `runs.project_root` at its start, and this resume READS it back via `snapshot.projectRoot` above.
    const store = createRunHistoryStore(opened.db, {
      uuid: () => randomUUID(),
      now: () => Date.now(),
      workflow: {
        slug: workflow.workflow.id,
        name: workflow.workflow.name ?? workflow.workflow.id,
        definitionJson: snapshot.workflowDefinitionSnapshot,
      },
    });
    const checkpointer = createHistoryCheckpointer(store);
    let checkpoint: CheckpointState | undefined;
    try {
      checkpoint = await checkpointer.load(args.runId);
    } catch (err) {
      // A malformed run_events row (bad JSON / failed schema parse during the fold) — surface a corrupt log
      // as a clean exit-2 fault, matching the snapshot/inputs handling, never a raw escaping error.
      throw new CliError(
        'invalid_invocation',
        `the persisted event log for run ${args.runId} could not be read`,
        { cause: err },
      );
    }
    if (checkpoint === undefined) {
      // A run row with a snapshot but no reconstructable checkpoint (no run:started in the log) — corrupt/partial.
      throw new CliError('invalid_invocation', `run ${args.runId} has no resumable state`);
    }

    // The reconstructed `checkpoint.runStatus` is the authoritative run state (folded fresh from the event log
    // right here), so it drives the terminal/idempotency decision — not the `runs.status` column, which a
    // racing process could have advanced between the snapshot read and now (and which the engine would then
    // surface as a closed-handle resume → a misleading exit 1).
    const selection = selectGate(checkpoint, checkpoint.runStatus, args.gate);
    if (selection.kind === 'invalid') {
      throw new CliError('invalid_invocation', selection.message);
    }
    if (selection.kind === 'idempotent') {
      // A doubled decision (run finished / gate already resolved) — a clean no-op, NOT a double-advance.
      deps.io.writeOut(`${selection.message}\n`);
      return EXIT_CODES.success;
    }

    const providers = deps.providers ?? createProviderResolver(deps.io.env);
    // Media host-wiring (2.S), the SAME helper `run` uses: a gate-resumed run that produces media must wire the
    // same CAS + retention + catalog as the original run (else it would be silently text-only). The checkpointer
    // stays. `save_to`'s scope root is the ORIGINAL run's project root when it still exists here (see
    // resolveSaveToRoot), else the resumer's cwd — so a same-machine resume writes under the original dir, while
    // a resume on a different machine / after that dir was deleted falls back gracefully instead of failing.
    const saveToRoot = resolveSaveToRoot(snapshot.projectRoot, deps.global.cwd);
    const wiring = buildMediaEngineWiring(opened.db, homeDir, saveToRoot, config, (m) =>
      deps.io.writeErr(`${m}\n`),
    );
    // D15 catalog load-check on the resume path too (the SAME helper `run` uses) — re-validate the snapshot's
    // authored `output_modalities` against the CURRENT catalog, so a model that lost a capability between the
    // original run and this resume is rejected consistently (exit 2), not silently routed at runtime.
    assertWorkflowCatalogValid(workflow, wiring.workflowModelCatalog);
    // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — read from the SAME durable `history.db`, so the resumed
    // workflow's post-gate continuation enforces `budget.max_cost_microcents` on a user-priced model exactly like
    // the original `run` did (pre-egress + realized). Without it a gated run would silently uncap that model on the
    // far side of the gate — the very ADR-0064 §6 gap this closes. Non-fatal read (an empty map ⇒ no user pricing).
    const resolvePrice = readUserPricingOverlay(opened.db);
    const engine = await (deps.buildEngine ?? defaultBuildEngine)({
      providers,
      // ADR-0071 §6: the far side of a gate re-runs agent nodes, so an authored tier the bound model rejects is
      // withheld here too — and this surface has no other safety net (no picker, no footer, no client-side check).
      // stderr, never stdout (`--json`).
      onEffortWithheld: onceEffortNotice((note) => deps.io.writeErr(`warning: ${note}\n`)),
      // ADR-0071 §K7: a resumed agent node on an unpriced model degrades to `allow`, so `budget.max_cost_microcents`
      // did not apply to it — say so on stderr (never stdout, `--json`). `budget.strict_cost_cap` blocks instead.
      onUnpriced: (model, capMicrocents) =>
        deps.io.writeErr(
          `warning: ${unpricedModelNote(model, capMicrocents)}\n`,
        ),
      // 2.5.A (ADR-0055): wire the SAME read+write fs + process ToolHost the `relavium run` path wires, jailed
      // to the ORIGINAL run's project root (`saveToRoot` — the original `runs.project_root` when it still exists
      // on this machine, else the resumer's cwd, exactly like the `save_to` root) at the resolved `fs_scope`. So a
      // tool-using agent node on the FAR side of a human gate reads/writes the ORIGINAL project context
      // (checkpoint/resume parity), not the gate caller's directory, and not `tool_unavailable`.
      toolEnv: { workspaceDir: saveToRoot, fsScopeTier: config.fsScope ?? 'sandboxed' },
      host: createCliHost(store, { checkpointer, media: wiring.media }),
      resolveMediaSurface: wiring.resolveMediaSurface,
      ...(wiring.mediaCostEstimate === undefined
        ? {}
        : { mediaCostEstimate: wiring.mediaCostEstimate }),
      ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
    });
    const handle = await resumeOrFail(engine, {
      runId: args.runId,
      workflow,
      inputs,
      gateId: selection.gateId,
      decision,
    });

    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global),
      gatePrompter: (deps.selectGatePrompter ?? selectGatePrompter)(deps.io, deps.global),
      io: deps.io,
    });

    if (outcome === undefined) {
      // The resumed handle closed with NO events. The engine returns a closed handle when its own internal
      // checkpoint re-read already found the run terminal — i.e. a concurrent `relavium gate` settled it in the
      // window between our selectGate pre-check and the engine's re-read. That is an idempotent no-op (the run
      // already completed), not a failure: exit 0, mirroring the selectGate terminal path.
      deps.io.writeOut(`run ${args.runId} already settled; nothing to resume\n`);
      return EXIT_CODES.success;
    }

    // Host media GC (2.S/D-GC, ADR-0042 §4) — only when the gate-resumed run reaches a TERMINAL event, exactly as
    // `run` does (the SAME helper). A re-pause (a second gate / budget pause) is NOT terminal, so the still-paused
    // run's media survives for the next resume; a GC failure is swallowed (never a correctness break).
    await sweepMediaAtTerminal({
      sweep: deps.sweepMedia ?? defaultSweepMedia,
      isTerminal: isTerminalOutcome(outcome),
      db: opened.db,
      casRoot: wiring.media.casRoot,
      currentRunId: args.runId,
      graceMs: config.mediaGcGraceMs,
    });
    return outcomeToExitCode(outcome);
  } finally {
    opened.close();
  }
}

/** The chosen gate, or a typed disposition: an idempotent no-op (exit 0) or an invalid invocation (exit 2). */
type GateSelection =
  | { readonly kind: 'resume'; readonly gateId: string }
  | { readonly kind: 'idempotent'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

/**
 * Choose which gate to resume — or report an idempotent no-op / invalid invocation. Budget gates
 * (`isBudgetGate`) are excluded: they are the `relavium budget resume` surface (ADR-0028), not a human gate.
 * Auto-fills when exactly one human gate is pending; requires `--gate` to disambiguate more than one.
 */
export function selectGate(
  checkpoint: CheckpointState,
  status: RunStatus,
  requested: string | undefined,
): GateSelection {
  if (TERMINAL_STATUSES.has(status)) {
    return { kind: 'idempotent', message: `run ${status}; nothing to resume` };
  }
  const pending = checkpoint.pendingGates.filter((gate) => !gate.isBudgetGate);
  const resolved = new Set(checkpoint.resolvedGateIds);

  if (requested !== undefined) {
    if (pending.some((gate) => gate.gateId === requested)) {
      return { kind: 'resume', gateId: requested };
    }
    if (resolved.has(requested)) {
      return { kind: 'idempotent', message: `gate ${requested} already resolved` };
    }
    return {
      kind: 'invalid',
      message: `no pending gate ${requested} on run${pendingList(pending)}`,
    };
  }
  if (pending.length === 0) {
    return resolved.size > 0
      ? { kind: 'idempotent', message: 'the run has no pending human gate (already resolved)' }
      : { kind: 'invalid', message: 'the run is not paused at a human gate' };
  }
  const [only, ...rest] = pending;
  if (rest.length === 0 && only !== undefined) {
    return { kind: 'resume', gateId: only.gateId }; // exactly one human gate pending → auto-fill
  }
  return {
    kind: 'invalid',
    message: `more than one gate is pending — pass --gate <gateId>:${pendingList(pending)}`,
  };
}

function pendingList(pending: readonly { readonly gateId: string }[]): string {
  return pending.length === 0 ? '' : ` (pending: ${pending.map((gate) => gate.gateId).join(', ')})`;
}

/** Re-validate the frozen snapshot JSON against the shared schema — a corrupt snapshot is an exit-2 fault. */
function parseSnapshot(snapshotJson: string, runId: string): WorkflowDefinition {
  try {
    return WorkflowSchema.parse(JSON.parse(snapshotJson));
  } catch (err) {
    throw new CliError(
      'invalid_invocation',
      `the stored workflow snapshot for run ${runId} could not be parsed`,
      { cause: err },
    );
  }
}

/** A non-null, non-array object — the shape a run's restored inputs must have (a guard, so no `as` cast). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Restore the run's inputs from the frozen `input_json`. A corrupt / non-object value is an exit-2 fault
 * (matching {@link parseSnapshot}) — never a silent `{}`, which would resume with every `{{ inputs.x }}`
 * evaluating to `undefined` and fail confusingly at a downstream node instead of cleanly up front.
 */
function parseInputs(inputJson: string, runId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch (err) {
    throw new CliError(
      'invalid_invocation',
      `the stored inputs for run ${runId} could not be parsed`,
      { cause: err },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new CliError(
      'invalid_invocation',
      `the stored inputs for run ${runId} are not a JSON object`,
    );
  }
  return parsed; // narrowed by isPlainObject — no cast
}

/**
 * Fail closed if any restored input is a {@link MaskedSecret} placeholder. The durable `run:started.inputs`
 * the engine persists are **masked** — a `secret`-typed input is stored as `{ secret: true, ref }`, never its
 * plaintext (ADR-0006/0036). So a cross-process resume genuinely cannot restore the real value: resuming with
 * the masked placeholder would let a post-gate `{{ inputs.<secret> }}` silently evaluate to the placeholder
 * object, diverging from the in-process run. We refuse (exit 2) with an actionable message rather than resume
 * a secret-bearing run incorrectly. (Re-providing secret inputs on resume is a tracked follow-up — see
 * [deferred-tasks](../../../../docs/roadmap/deferred-tasks.md).)
 */
function assertNoMaskedSecretInputs(inputs: Record<string, unknown>, runId: string): void {
  const masked = Object.keys(inputs).filter(
    (key) => MaskedSecretSchema.safeParse(inputs[key]).success,
  );
  if (masked.length > 0) {
    throw new CliError(
      'invalid_invocation',
      `run ${runId} has secret input(s) [${masked.join(', ')}] that are not persisted in plaintext, so a ` +
        `cross-process resume cannot restore them — re-run the workflow instead of resuming.`,
    );
  }
}
