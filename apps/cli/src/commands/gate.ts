import { EgressWorkScope } from '../engine/egress-work.js';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';

import {
  EngineStateError,
  budgetAllowancePricesMatch,
  isTransientEngineStateError,
  type CheckpointState,
  type RunHandle,
  type WorkflowDefinition,
  type WorkflowEngine,
} from '@relavium/core';
import {
  createEffectJournalPort,
  createEffectResumePort,
  createEffectJournalStore,
  createRunHistoryStore,
  createRunLeasePort,
  isCorruptRunEventError,
  isUnreadableRunEventLogError,
  loadRunSnapshot,
  type Db,
} from '@relavium/db';
import {
  MaskedSecretSchema,
  WorkflowSchema,
  type GateDecision,
  type RunStatus,
} from '@relavium/shared';
import { liveMcpChildPids } from '@relavium/mcp';

import { loadResolvedConfig } from '../config/load.js';
import { openLocalDb } from '../db/open.js';
import { terminalOutboxPath } from '../history/open.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { onceEffortNotice, unpricedModelNote } from '../chat/effort-notice.js';
import { sweepCommittedEffects } from '../engine/effect-retention.js';
import { createCliHost } from '../engine/host.js';
import {
  sweepHostMediaBestEffort as defaultSweepMedia,
  sweepMediaAtTerminal,
} from '../engine/media-gc.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import { readBudgetPricingOverlay, readUserPricingOverlay } from '../engine/pricing-overlay.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { decisionFromFlags, type GateFlags } from '../gate/decision.js';
import {
  assertBudgetDecision,
  budgetDecisionFromFlags,
  resumeCommandBase,
  selectBudgetGate,
  type BudgetDecisionFlags,
} from '../gate/budget.js';
import {
  connectWorkflowMcp,
  workflowDeclaresMcp,
  surfaceMcpSkipped,
  type StdioConsentGate,
  type WorkflowMcpRuntime,
} from '../engine/mcp-servers.js';
import { createConsentGate } from '../engine/mcp-consent-gate.js';
import { guardMcpTeardown } from '../engine/mcp-signal-teardown.js';
import { defaultSubscribeSignals } from '../process/signals.js';
import { createConsentPrompter } from '../mcp/consent-prompt.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import type { GatePrompter } from '../gate/prompter.js';
import { selectGatePrompter } from '../gate/select-prompter.js';
import { readSecretFromStdin, type StdinSecretContext } from '../secrets/read-secret.js';
import { CliError } from '../process/errors.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import type { RunRenderer } from '../render/renderer.js';
import { selectRenderer } from '../render/select.js';
import { sanitizeInline } from '../render/sanitize.js';
import {
  assertWorkflowCatalogValid,
  driveRun,
  isTerminalOutcome,
  outcomeToExitCode,
} from './drive.js';

/** How many held node ids the ADR-0074 §3 hold notice names before it elides — the same bound-the-diagnostic
 *  reasoning as `logs.ts`'s `MAX_REPORTED_SKIPS`: the COUNT is the signal, the first few ids are the lead. */
const MAX_REPORTED_HELD_NODES = 8;

/**
 * The ADR-0074 §3 hold notice — a resumed media job submitted by an older Relavium has no recorded cost
 * basis, so the cap holds new egress until it settles. Without the sentence a resume is an unexplained stall,
 * which is precisely what §3's observability clause forbids.
 *
 * SANITIZED and BOUNDED, like every other place a node id reaches this terminal. A node id is authored rather
 * than model-controlled, but `renderer.ts` runs `sanitizeInline` over one for the same reason — a workflow
 * YAML can arrive from anywhere — and an unbounded id list is not a diagnostic: the COUNT is the signal and
 * the first few ids are the lead (`logs.ts`'s `MAX_REPORTED_SKIPS`).
 *
 * Exported for its test. The engine sink that feeds it was DEAD until the wiring was fixed, so this line had
 * never rendered in production and nothing pinned it.
 */
export function legacyMediaJobHoldNotice(nodeIds: readonly string[]): string {
  const one = nodeIds.length === 1;
  const subject = one ? 'a media job' : `${nodeIds.length} media jobs`;
  const shown = nodeIds.slice(0, MAX_REPORTED_HELD_NODES).map((id) => sanitizeInline(id));
  const ids = nodeIds.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
  return (
    `note: holding new model calls until ${subject} submitted by an older version of Relavium ` +
    `settle${one ? 's' : ''} (node${one ? '' : 's'} ${ids}) — their cost was not ` +
    `recorded, so the budget cap cannot be applied until then\n`
  );
}

export interface ResumeGateArgs {
  readonly runId: string;
  /** `--gate <gateId>`: which pending gate to resolve (required only when more than one is pending). */
  readonly gate?: string;
  /**
   * `--secret-stdin`: re-supply the run's `secret` inputs from stdin, one `name=value` per line
   * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
   * §6). A `secret` is never persisted — the durable record holds only a masked slot — so a secret-bearing
   * run cannot resume without it, and before this flag existed the only advice was "re-run the workflow".
   *
   * **Values never travel through argv**, which is why the flag is a boolean and not `--secret name=value`:
   * a credential on a command line leaks to `ps`, shell history and CI logs. `relavium provider set-key`
   * takes a key on stdin for exactly this reason.
   */
  readonly secretStdin?: boolean;
  readonly allowMcpStdio?: readonly string[];
}

export interface GateCommandArgs extends ResumeGateArgs, GateFlags {}
export interface BudgetCommandArgs extends ResumeGateArgs, BudgetDecisionFlags {}

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
  /**
   * Read the whole of stdin, for `--secret-stdin`. Injected so a test never touches the real stdin — and
   * never has to put a credential-shaped string anywhere but its own closure.
   */
  readonly readSecretInput?: () => Promise<string>;
  readonly startMcpClient?: typeof import('@relavium/mcp').startMcpClient;
  readonly consentGate?: StdioConsentGate;
  readonly mcpSecretResolver?: McpSecretResolver;
  /** After selection/amount refusal, production reads providers from the command's existing db. */
  readonly resolveKeys?: (db: Db) => {
    readonly providers: ProviderResolver;
    readonly mcpSecretResolver: McpSecretResolver;
  };
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
      // A TRANSIENT refusal gets its own code, and therefore its own exit code (ADR-0079 §7). Another
      // process is running this gate right now; the caller should retry shortly, not conclude the command
      // was malformed. Every other engine-state refusal is a permanent invocation fault.
      const code = isTransientEngineStateError(err) ? 'run_owned_elsewhere' : 'invalid_invocation';
      throw new CliError(code, `cannot resume run ${params.runId}: ${err.message}`, {
        cause: err,
      });
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
  return resumeGateCommand(args, deps, 'human', flags.decision);
}

/** Exact amount transport is validated before any database, secret, MCP or ownership access. */
export async function budgetCommand(
  args: BudgetCommandArgs,
  deps: GateCommandDeps,
): Promise<ExitCode> {
  return resumeGateCommand(args, deps, 'budget', budgetDecisionFromFlags(args));
}

/** Build only a copyable invocation; input-provided decisions require a different transport. */
function formatResumeInvocation(
  commandBase: string | undefined,
  kind: 'human' | 'budget',
  decision: GateDecision,
): string | undefined {
  if (commandBase === undefined || decision.decision === 'input_provided') return undefined;
  let flag: string;
  if (kind === 'budget') {
    flag =
      decision.decision === 'rejected'
        ? '--abort'
        : `--approve-amount ${decision.approvedAmountMicrocents}`;
  } else {
    flag = decision.decision === 'rejected' ? '--reject' : '--approve';
  }
  return `${commandBase} ${flag}`;
}

async function resumeGateCommand(
  args: ResumeGateArgs,
  deps: GateCommandDeps,
  kind: 'human' | 'budget',
  decision: GateDecision,
): Promise<ExitCode> {
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

  let mcpRuntime: WorkflowMcpRuntime | undefined;
  const mcpWork = new EgressWorkScope();
  let unguardMcp = (): void => undefined;
  let unguardResume = (): void => undefined;
  let resumeEngine: WorkflowEngine | undefined;
  const resumeCancel = new AbortController();
  let resumeStarted = false;
  const interruptedBeforeResume = (): ExitCode => {
    deps.io.writeErr(
      'resume interrupted before a decision was recorded; the gate remains pending\n',
    );
    return EXIT_CODES.workflowFailed;
  };
  try {
    const snapshot = loadRunSnapshot(opened.db, args.runId);
    if (snapshot === undefined) {
      throw new CliError('invalid_invocation', `no run found with id ${args.runId}`);
    }

    const workflow = parseSnapshot(snapshot.workflowDefinitionSnapshot, args.runId);

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
      throwGateLoadFault(err, args.runId);
    }
    if (checkpoint === undefined) {
      // A run row with a snapshot but no reconstructable checkpoint (no run:started in the log) — corrupt/partial.
      throw new CliError('invalid_invocation', `run ${args.runId} has no resumable state`);
    }

    // The reconstructed `checkpoint.runStatus` is the authoritative run state (folded fresh from the event log
    // right here), so it drives the terminal/idempotency decision — not the `runs.status` column, which a
    // racing process could have advanced between the snapshot read and now (and which the engine would then
    // surface as a closed-handle resume → a misleading exit 1).
    const selection =
      kind === 'budget'
        ? selectBudgetGate(checkpoint, args.gate)
        : selectGate(checkpoint, checkpoint.runStatus, args.gate);
    if (selection.kind === 'invalid') {
      throw new CliError('invalid_invocation', selection.message);
    }
    if (selection.kind === 'idempotent') {
      // A doubled decision (run finished / gate already resolved) — a clean no-op, NOT a double-advance.
      if (deps.global.json) deps.io.writeErr(`${selection.message}\n`);
      else deps.io.writeOut(`${selection.message}\n`);
      return EXIT_CODES.success;
    }

    if (kind === 'budget') {
      const gate = checkpoint.pendingGates.find((entry) => entry.gateId === selection.gateId);
      assertBudgetDecision(gate?.allowance, decision);
    }
    // Recorded priced quantities let stale rates refuse before secrets/key-resolver construction/MCP.
    // A match grants nothing; the later full preparation reads a fresh price snapshot again.
    if (kind === 'budget' && decision.decision === 'approved') {
      const gate = checkpoint.pendingGates.find((entry) => entry.gateId === selection.gateId);
      if (
        gate?.allowance?.kind === 'frozen' &&
        !budgetAllowancePricesMatch(gate.allowance.quote, readBudgetPricingOverlay(opened.db))
      )
        throw new CliError(
          'invalid_invocation',
          'the frozen budget quote no longer matches current pricing; reject this gate and start a new run',
        );
    }
    const commandBase = resumeCommandBase(kind, args.runId, selection.gateId);
    const resumeInvocation = formatResumeInvocation(commandBase, kind, decision);
    const inputs = await resolveSecretInputs(
      parseInputs(snapshot.inputJson, args.runId),
      args,
      deps,
      resumeInvocation,
    );
    const keys =
      kind === 'budget' && decision.decision === 'rejected'
        ? undefined
        : deps.resolveKeys?.(opened.db);
    const providers = deps.providers ?? keys?.providers ?? createProviderResolver(deps.io.env);
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
    // Cancellation belongs to the resume command even when no MCP server is declared. During passive
    // preparation Core latches cancel(runId); once registered it cancels the actual execution.
    unguardResume = defaultSubscribeSignals(() => {
      if (resumeCancel.signal.aborted) return;
      resumeCancel.abort();
      if (!resumeStarted || resumeEngine === undefined) return;
      try {
        resumeEngine.cancel(args.runId);
      } catch (error) {
        if (
          !(error instanceof EngineStateError) ||
          (error.code !== 'unknown_run' && error.code !== 'run_already_terminal')
        )
          throw error;
        // The signal can precede registration or follow settlement. The latch is checked on handoff.
      }
    });
    // A budget rejection is fatal and dispatches no agent. Do not spawn tools merely to reject it.
    if (workflowDeclaresMcp(workflow) && !(kind === 'budget' && decision.decision === 'rejected')) {
      unguardMcp = guardMcpTeardown(
        async () => {
          await mcpRuntime?.client.close();
        },
        () => liveMcpChildPids(),
        { reapOnly: true },
      );
      mcpRuntime = await connectWorkflowMcp(workflow, {
        cwd: saveToRoot,
        preserveFrozenGrants: true,
        connectSignal: resumeCancel.signal,
        work: mcpWork,
        registrations: config.mcpServers,
        resolveSecret:
          deps.mcpSecretResolver ?? keys?.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
        artifact: `frozen run ${args.runId}`,
        consentGate:
          deps.consentGate ??
          createConsentGate({
            io: deps.io,
            global: deps.global,
            homeDir,
            allowedDigests: args.allowMcpStdio ?? [],
            prompt: createConsentPrompter(),
          }),
        ...(deps.startMcpClient === undefined ? {} : { startMcpClient: deps.startMcpClient }),
      });
      if (mcpRuntime !== undefined) surfaceMcpSkipped(deps.io, mcpRuntime.client.skipped);
    }

    // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — read from the SAME durable `history.db`, so the resumed
    // workflow's post-gate continuation enforces `budget.max_cost_microcents` on a user-priced model exactly like
    // the original `run` did (pre-egress + realized). Without it a gated run would silently uncap that model on the
    // far side of the gate — the very ADR-0064 §6 gap this closes. Non-fatal read (an empty map ⇒ no user pricing).
    const resolvePrice = readUserPricingOverlay(opened.db);
    const engine = await (deps.buildEngine ?? defaultBuildEngine)({
      ...(mcpRuntime === undefined
        ? {}
        : {
            mcp: {
              toolDefs: mcpRuntime.client.toolDefs,
              capability: mcpRuntime.client.capability,
            },
          }),
      // The durable effect journal (ADR-0080). A gate resume runs the FAR side of a human gate, which is
      // precisely where a tool-using agent node does its work — leaving it unwired refused every effectful
      // tool on exactly the path the gate exists to enable.
      effectJournal: (correlation) =>
        createEffectJournalPort(
          createEffectJournalStore(opened.db, { uuid: randomUUID, now: Date.now }),
          correlation,
          { providerAttempt: 1, toolCallId: 'gate' },
        ),
      // …and its READ half. THIS is the gate's home surface: a gate resume is the canonical "the process
      // died mid-node and came back" case, which is exactly what effect-journal.md §4 exists to refuse.
      effectResume: createEffectResumePort(
        createEffectJournalStore(opened.db, { uuid: randomUUID, now: Date.now }),
      ),
      providers,
      // ADR-0071 §6: the far side of a gate re-runs agent nodes, so an authored tier the bound model rejects is
      // withheld here too — and this surface has no other safety net (no picker, no footer, no client-side check).
      // stderr, never stdout (`--json`).
      onEffortWithheld: onceEffortNotice((note) => deps.io.writeErr(`warning: ${note}\n`)),
      // ADR-0071 §K7: a resumed agent node on an unpriced model degrades to `allow`, so `budget.max_cost_microcents`
      // did not apply to it — say so on stderr (never stdout, `--json`). `budget.strict_cost_cap` blocks instead.
      onUnpriced: (model, capMicrocents, modalities) =>
        deps.io.writeErr(
          `warning: ${unpricedModelNote(model, capMicrocents, 'budget.strict_cost_cap', modalities)}\n`,
        ),
      // ADR-0074 §3: new egress is HELD while a resumed media job submitted by an older Relavium settles — its
      // cost basis was not recorded, so the cap cannot be trusted until the job reports its real charge. Say so,
      // or a resume looks like an unexplained stall. stderr, never stdout (`--json` stays a pure event stream).
      // stderr, never stdout, so `--json` stays a pure event stream. The SENTENCE is
      // {@link legacyMediaJobHoldNotice} so it can be pinned directly — this sink reached the terminal for the
      // first time only when the engine wiring was fixed, and nothing had ever rendered it.
      onLegacyMediaJobHold: (nodeIds) => {
        deps.io.writeErr(legacyMediaJobHoldNotice(nodeIds));
      },
      // 2.5.A (ADR-0055): wire the SAME read+write fs + process ToolHost the `relavium run` path wires, jailed
      // to the ORIGINAL run's project root (`saveToRoot` — the original `runs.project_root` when it still exists
      // on this machine, else the resumer's cwd, exactly like the `save_to` root) at the resolved `fs_scope`. So a
      // tool-using agent node on the FAR side of a human gate reads/writes the ORIGINAL project context
      // (checkpoint/resume parity), not the gate caller's directory, and not `tool_unavailable`.
      toolEnv: { workspaceDir: saveToRoot, fsScopeTier: config.fsScope ?? 'sandboxed' },
      host: createCliHost(store, {
        checkpointer,
        media: wiring.media,
        // Same outbox as the  path, and it must be the SAME FILE: a gate resume settles a run whose
        // terminal a different process may already have failed to write (ADR-0078 §4).
        terminalOutboxPath: terminalOutboxPath(homeDir),
        // Same durable lease as the `run` path — a gate resume is exactly where two processes contend.
        runLeases: createRunLeasePort(store),
      }),
      resolveMediaSurface: wiring.resolveMediaSurface,
      ...(wiring.maxTokensEstimate === undefined
        ? {}
        : { maxTokensEstimate: wiring.maxTokensEstimate }),
      ...(wiring.mediaCostEstimate === undefined
        ? {}
        : { mediaCostEstimate: wiring.mediaCostEstimate }),
      ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
    });
    resumeEngine = engine;
    // Same drain as the `run` path (ADR-0078 §4/§5) — a gate resume is equally "the next `relavium` start",
    // and it is the one a user reaches for after seeing the `durabilityUncertain` exit code on a gated run.
    if (resumeCancel.signal.aborted) return interruptedBeforeResume();
    await engine.drainTerminalOutbox().catch(() => undefined);
    if (resumeCancel.signal.aborted) return interruptedBeforeResume();
    resumeStarted = true;
    const handle = await resumeOrFail(engine, {
      runId: args.runId,
      workflow,
      inputs,
      gateId: selection.gateId,
      decision,
    });

    if (resumeCancel.signal.aborted) handle.cancel();

    const outcome = await driveRun({
      engine,
      handle,
      makeRenderer: () => (deps.selectRenderer ?? selectRenderer)(deps.io, deps.global),
      // **`--secret-stdin` makes this invocation non-interactive, and the prompter must know.**
      // `selectGatePrompter` decides on STDOUT alone, so a `printf … | relavium gate … --secret-stdin` run
      // from a terminal still selects a `@clack/prompts` prompter — over a stdin that was drained to EOF to
      // read the credential. If the resumed run hits a SECOND gate, clack is asked to read from a closed
      // stream: it either resolves its cancel sentinel (the gate goes unresolved, exit 3) or throws on raw
      // mode. Both are wrong, so the honest answer is the one this invocation actually has — no prompter,
      // and a later gate exits 3 the way every other non-interactive resume does.
      makeGatePrompter: () =>
        args.secretStdin === true
          ? undefined
          : (deps.selectGatePrompter ?? selectGatePrompter)(deps.io, deps.global),
      io: deps.io,
      json: deps.global.json,
    });

    const departure = await handle.depart();
    if (departure.kind === 'continue')
      throw new CliError('internal', 'run departure was not acknowledged');
    const exitCode = outcomeToExitCode(
      outcome,
      handle.durability(),
      handle.terminalError(),
      departure,
      true,
    );

    // An uncertain NONTERMINAL outcome is fenced, including a buffered stale pause. A delivered
    // terminal with uncertainty instead belongs to the outbox/exit-5 path below. A durable later
    // pause still exits 3. Neither durability nor the outcome alone makes these distinctions.
    if (exitCode === EXIT_CODES.runOwnedElsewhere) {
      throw new CliError(
        'run_owned_elsewhere',
        `this process could not confirm ownership of run ${args.runId} during the resume and stopped — read \`relavium logs ${args.runId}\` for its real outcome, then retry if the gate is still pending`,
      );
    }
    if (outcome === undefined && exitCode === EXIT_CODES.success) {
      // **Two very different runs close with no `run:*` event, and telling them apart matters.** A closed
      // handle (the engine's own checkpoint re-read found the run terminal — a concurrent `relavium gate`
      // settled it between our pre-check and the engine's) is an idempotent no-op. A run FENCED mid-resume
      // (ADR-0079 §5) also emits no terminal by design — and reporting that as "already settled … exit 0"
      // is the worst available answer: this process cannot report settlement, even when its earlier gate
      // decision is already durable, and an automation loop records success. The disposition separates them at no
      // cost: `createClosedRunHandle` reports `durable`, a fenced handle reports `uncertain`.
      const notice = `run ${args.runId} already settled; nothing to resume\n`;
      if (deps.global.json) deps.io.writeErr(notice);
      else deps.io.writeOut(notice);
      return EXIT_CODES.success;
    }

    // Host media GC (2.S/D-GC, ADR-0042 §4) — only when the gate-resumed run reaches a TERMINAL event, exactly as
    // `run` does (the SAME helper). A re-pause (a second gate / budget pause) is NOT terminal, so the still-paused
    // run's media survives for the next resume; a GC failure is swallowed (never a correctness break).
    // Retention (effect-journal.md §9). A terminal run can no longer be resumed — `resumeFromCheckpoint`
    // returns a closed handle for one — so its COMMITTED rows have no reader left and go. Unresolved rows
    // are untouched by construction: they are the record an operator needs, and an exit-7 run's rows must
    // survive precisely because its run is over.
    if (isTerminalOutcome(outcome)) {
      sweepCommittedEffects(deps.io, opened.db, args.runId);
    }
    await sweepMediaAtTerminal({
      sweep: deps.sweepMedia ?? defaultSweepMedia,
      isTerminal: isTerminalOutcome(outcome),
      db: opened.db,
      casRoot: wiring.media.casRoot,
      currentRunId: args.runId,
      graceMs: config.mediaGcGraceMs,
    });
    // Same rule as  (ADR-0078 §5) — the resumed leg's terminal is durable, or the run says so.
    // **Read off the HANDLE, never from a `subscribe()` here.** The resume gate settles `run:failed` INSIDE
    // `resumeFromCheckpoint`'s await, before this code has a handle to subscribe to, and `subscribe` has no
    // replay — a review measured a late subscriber seeing `undefined` and this surface reporting exit 1 for
    // a run that had stopped for an unresolved external effect. `terminalError()` is captured on the
    // handle's own construction-time subscription, which no ordering can outrun.
    return exitCode;
  } catch (err) {
    // The pre-connect guard owns child cleanup; this command owns the run-style interruption exit.
    // Once resume has started, the handle/engine error remains authoritative.
    if (!resumeStarted && resumeCancel.signal.aborted) return interruptedBeforeResume();
    throw err;
  } finally {
    try {
      try {
        // Cleanup must not replace a primary refusal or a durably completed command result.
        await mcpRuntime?.client.close().catch(() => {
          deps.io.writeErr('warning: the MCP client could not close cleanly\n');
        });
      } finally {
        mcpWork.seal();
        await mcpWork.done;
        opened.close();
      }
    } finally {
      unguardMcp();
      unguardResume();
    }
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
      return {
        kind: 'idempotent',
        message: `gate ${requested} already resolved`,
      };
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
 * How many names a refusal lists before the rest become a count — the convention this file already uses for
 * held nodes. A malformed paste on the SECRET channel would otherwise produce a stderr line as long as the
 * payload, echoing whatever the user pasted.
 */
const MAX_REPORTED_SECRET_NAMES = 8;

function nameList(names: readonly string[]): string {
  return names.length <= MAX_REPORTED_SECRET_NAMES
    ? names.join(', ')
    : `${names.slice(0, MAX_REPORTED_SECRET_NAMES).join(', ')}, and ${String(names.length - MAX_REPORTED_SECRET_NAMES)} more`;
}

function secretPipeHint(resumeInvocation: string | undefined): string {
  return resumeInvocation === undefined
    ? 'Re-run the same decision with the recorded run and gate IDs and --secret-stdin, supplying name=value lines on stdin.'
    : "Pipe the run's secret inputs as name=value lines on stdin — e.g. " +
        `\`printf 'api_key=%s\\n' "$VALUE" | ${resumeInvocation} --secret-stdin\` ` +
        '(a credential is never passed as an argument).';
}

/** The two refusals `readSecretFromStdin` prints, written for THIS command rather than `provider set-key`. */
const SECRET_STDIN_CONTEXT = (
  runId: string,
  resumeInvocation: string | undefined,
): StdinSecretContext => ({
  pipeHint: secretPipeHint(resumeInvocation),
  emptyMessage: `no \`secret\` inputs were read from stdin for run ${runId} (empty input).`,
});

/**
 * Re-supply the run's `secret` inputs, or refuse the resume
 * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §6).
 *
 * The durable record holds a `secret` input as `{ secret: true, ref }` and nothing else — there is no
 * credential in it to restore. Passing the placeholder through would let a post-gate `{{ inputs.<secret> }}`
 * evaluate to a marker object; the engine refuses that outright (`secret_input_missing`), and this refuses it
 * earlier with a message that names the remedy.
 *
 * **`name=value` lines on stdin, behind an explicit `--secret-stdin`.** The flag is what keeps the command
 * from blocking on a pipe nobody attached, and the VALUES never appear in argv, where a credential leaks to
 * `ps`, shell history and CI logs. The name in the line is not itself a secret, and carrying it there rather
 * than in a repeated flag removes the order dependency that would silently swap two credentials.
 *
 * Every masked slot must be supplied and nothing else may be: a name the run has no slot for is a mistake
 * worth naming rather than ignoring, and an empty value is refused explicitly rather than by omission — the
 * engine would accept `''` as "re-supplied", and a blank line in a piped heredoc is the likeliest way to
 * produce one by accident.
 */
async function resolveSecretInputs(
  inputs: Record<string, unknown>,
  args: ResumeGateArgs,
  deps: GateCommandDeps,
  resumeInvocation: string | undefined,
): Promise<Record<string, unknown>> {
  const masked = Object.keys(inputs).filter(
    (key) => MaskedSecretSchema.safeParse(inputs[key]).success,
  );
  if (masked.length === 0) {
    if (args.secretStdin === true) {
      throw new CliError(
        'invalid_invocation',
        `run ${args.runId} has no \`secret\` inputs to re-supply — drop --secret-stdin.`,
      );
    }
    return inputs;
  }
  if (args.secretStdin !== true) {
    throw new CliError(
      'invalid_invocation',
      `run ${args.runId} needs its \`secret\` input(s) [${masked.join(', ')}] re-supplied to resume — ` +
        `they are never persisted. ${secretPipeHint(resumeInvocation)}`,
    );
  }
  const read =
    deps.readSecretInput ??
    ((): Promise<string> =>
      readSecretFromStdin(SECRET_STDIN_CONTEXT(args.runId, resumeInvocation)));
  const supplied = parseSecretLines(await read(), args.runId);
  const missing = masked.filter((name) => !Object.hasOwn(supplied, name));
  if (missing.length > 0) {
    throw new CliError(
      'invalid_invocation',
      `stdin did not supply the \`secret\` input(s) [${nameList(missing)}] this run needs.`,
    );
  }
  const unexpected = Object.keys(supplied).filter((name) => !masked.includes(name));
  if (unexpected.length > 0) {
    throw new CliError(
      'invalid_invocation',
      `stdin supplied [${nameList(unexpected)}], which run ${args.runId} has no \`secret\` slot for.`,
    );
  }
  // A fresh null-prototype map, filled from the restored inputs and then the re-supplied secrets — never a
  // spread of a `JSON.parse` result into a `{}`, which would put an input named `__proto__` through the
  // prototype setter (ADR-0083 §7, the same hazard the engine's own accumulators avoid).
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(inputs)) merged[key] = inputs[key];
  for (const key of Object.keys(supplied)) merged[key] = supplied[key];
  return merged;
}

/**
 * Split stdin into `name=value` pairs. Blank lines are ignored; everything else must be a pair with a
 * non-empty name and value, so a malformed paste fails loudly instead of resuming with a wrong credential.
 *
 * A VALUE may contain `=` (the split is on the first one). It may not contain a newline — a credential that
 * does is outside what this transport can express, and saying so is better than truncating one silently.
 * No value is ever echoed, here or in any error below.
 */
function parseSecretLines(raw: string, runId: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const line of raw.split('\n')) {
    // Only the CRLF carriage return is stripped from the line. The NAME is trimmed; the VALUE is taken
    // VERBATIM after the first `=`. A first version trimmed the whole line, which silently removed a
    // credential's trailing whitespace while preserving its leading whitespace — an asymmetry that turns a
    // pasted key into a different key and reports it as an opaque 401 from the provider hours later.
    const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (stripped.trim() === '') continue;
    const at = stripped.indexOf('=');
    const name = at === -1 ? '' : stripped.slice(0, at).trim();
    const value = at === -1 ? '' : stripped.slice(at + 1);
    // An all-whitespace value is refused with the empty one: it is not a credential, and accepting it would
    // hand the run a blank secret that fails somewhere far from here.
    if (name === '' || value.trim() === '') {
      throw new CliError(
        'invalid_invocation',
        `stdin for run ${runId} must be \`name=value\` lines with a non-empty value.`,
      );
    }
    if (Object.hasOwn(out, name)) {
      throw new CliError(
        'invalid_invocation',
        `stdin for run ${runId} supplied the same \`secret\` name twice.`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * Map a checkpoint-read fault to the surface error it deserves, and never return. Extracted from
 * `gateCommand` so its three branches do not count against that function's cognitive-complexity budget —
 * they belong together and nowhere else.
 */
function throwGateLoadFault(err: unknown, runId: string): never {
  // ADR-0075's refusal passes through UNTOUCHED. This catch pre-dates it and would otherwise fold a
  // "your Relavium is too old" into the generic branch below: the user would get no count, no `seq`
  // values, no upgrade remedy, no "your history is still readable" — and exit 2 (`invalid_invocation`),
  // which is semantically wrong, since the invocation was valid. `toUserFacing` already renders this
  // error properly; re-wrapping it here made that mapper unreachable.
  if (isUnreadableRunEventLogError(err)) {
    throw err;
  }
  // A damaged row passes through typed too, for the SAME reason and to fix an asymmetry the reasoning
  // above exposed: `relavium logs` on a corrupt log exits 1 (its typed error reaches `toUserFacing`),
  // while `gate` on the IDENTICAL log exited 2 because this catch re-wrapped it as `invalid_invocation`.
  // The invocation was valid in both. `toUserFacing`'s corrupt branch already composes the better
  // sentence — the run, the `seq`, the `event_type`, and what is still listable — so re-wrapping made
  // `gate` both less diagnosable and inconsistent with every other single-run surface.
  if (isCorruptRunEventError(err)) {
    throw err;
  }
  // Anything else from the fold: an unreadable file, a closed handle, a driver fault. Still a clean
  // exit-2 invocation fault, matching the snapshot/inputs handling, never a raw escaping error.
  throw new CliError(
    'invalid_invocation',
    `the persisted event log for run ${runId} could not be read`,
    { cause: err },
  );
}
