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
  loadRunSnapshot,
  type Db,
} from '@relavium/db';
import {
  MaskedSecretSchema,
  WorkflowSnapshotSchema,
  type GateDecision,
  type MediaBilledModality,
  type RunStatus,
} from '@relavium/shared';

import { onceEffortNotice, unpricedModelNote } from '../chat/effort-notice.js';
import { assertWorkflowCatalogValid } from '../commands/drive.js';
import type { ResolvedConfig } from '../config/resolve.js';
import { terminalOutboxPath } from '../history/open.js';
import {
  buildEngine as defaultBuildEngine,
  type BuildEngineOptions,
} from '../engine/build-engine.js';
import { createHistoryCheckpointer } from '../engine/checkpointer.js';
import { createCliHost } from '../engine/host.js';
import {
  connectWorkflowMcp,
  surfaceMcpSkipped,
  workflowDeclaresMcp,
  type StdioConsentGate,
} from '../engine/mcp-servers.js';
import { buildMediaEngineWiring } from '../engine/media-wiring.js';
import { readBudgetPricingOverlay, readUserPricingOverlay } from '../engine/pricing-overlay.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { assertBudgetDecision, resumeCommandBase, selectBudgetGate } from '../gate/budget.js';
import { assertDecisionFitsGateType } from '../gate/decision.js';
import { acquireNativeResource } from '../process/acquire-native-resource.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import type { GlobalOptions } from '../process/options.js';
import { sanitizeInline } from '../render/sanitize.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import type { RunLifetime } from './run-lifetime.js';
import type { RunResources } from './run-resources.js';

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

/** What a host asks `resumeRun` to resume: the run, the gate it names, and the decision it already holds. */
export interface ResumeRunRequest {
  readonly runId: string;
  /** Which pending gate to resolve (required only when more than one is pending). */
  readonly gate?: string | undefined;
  /** Whether the host will supply the run's `secret` inputs; a secret-bearing run refuses without it. */
  readonly secretStdin?: boolean | undefined;
  readonly kind: 'human' | 'budget';
  readonly decision: GateDecision;
}

/** The injectable services a resume uses. Every member is the one `GateCommandDeps` already carries. */
export interface ResumeRunDeps {
  readonly io: CliIo;
  readonly global: Pick<GlobalOptions, 'cwd'>;
  readonly buildEngine?: (options?: BuildEngineOptions) => Promise<WorkflowEngine>;
  readonly providers?: ProviderResolver;
  /** After selection/amount refusal, production reads providers from the command's existing db. */
  readonly resolveKeys?: (db: Db) => {
    readonly providers: ProviderResolver;
    readonly mcpSecretResolver: McpSecretResolver;
  };
  readonly startMcpClient?: typeof import('@relavium/mcp').startMcpClient;
  readonly mcpSecretResolver?: McpSecretResolver;
}

/** The host's already-loaded configuration: a resume never loads it, so a host cannot disagree with it. */
export interface ResumeRunHost {
  readonly config: ResolvedConfig;
  readonly homeDir: string;
}

/**
 * The prompts and the database a resume may need, as ports. The shell supplies the clack, stdin and
 * `history.db` implementations; the Home supplies its own native prompts and its one open connection
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §1, §2).
 */
export interface ResumeRunPorts {
  /** Open the history database. The host's `captureClose` custody applies, exactly as for any native resource. */
  readonly openDb: (captureClose: (close: () => void) => void) => {
    readonly db: Db;
    readonly close: () => void;
  };
  /**
   * The values for the run's masked `secret` slots, by name. Called only after the selection, the decision
   * and the price pre-check passed and only for a run that has masked slots and a host that said it will
   * supply them. Receives the copyable invocation the refusals name, when one exists.
   */
  readonly secretInputs: (context: {
    readonly resumeInvocation: string | undefined;
  }) => Promise<Readonly<Record<string, string>>>;
  /** The MCP stdio consent gate, built at the point the connector's options are assembled. */
  readonly consentGate: (homeDir: string) => StdioConsentGate;
}

export type ResumeRunResult =
  /** A doubled decision (the run finished, or the gate was already resolved): a no-op, never a double advance. */
  | { readonly kind: 'settled'; readonly message: string }
  | {
      readonly kind: 'resumed';
      readonly engine: WorkflowEngine;
      readonly handle: RunHandle;
      readonly db: Db;
      readonly mediaCasRoot: string | undefined;
    };

/**
 * The shared cross-process resume core ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §1) — the only path that resumes a run: `relavium gate`, `relavium budget resume` and, from step 3, the Home.
 *
 * It runs in a **fresh process** from the original run, so it rebuilds the run's `WorkflowDefinition` and inputs
 * from the durable snapshot (2.H), reconstructs the checkpoint from the persisted event log, selects the gate or
 * budget decision and checks it against the gate's type or frozen allowance, refuses a stale quote before any
 * secret, key or MCP work, re-supplies the secrets, reconnects MCP with the preserved grants, builds the engine
 * and calls `engine.resumeFromCheckpoint`. Nothing is driven: the host does that with the returned handle.
 *
 * The order is the contract (ADR-0083 §6, ADR-0097): every refusal that needs no service happens first, and
 * what it acquires is registered in `resources` for the host to release.
 */
export async function resumeRun(
  request: ResumeRunRequest,
  deps: ResumeRunDeps,
  host: ResumeRunHost,
  ports: ResumeRunPorts,
  lifetime: RunLifetime,
  resources: RunResources,
): Promise<ResumeRunResult> {
  const nativeProcesses = nativeProcessesForInvocation(lifetime.invocation);
  const { config, homeDir } = host;
  const { runId, kind, decision } = request;
  lifetime.checkpoint();
  const opened = acquireNativeResource((captureClose) => ports.openDb(captureClose), {
    assertAdmitting: () => lifetime.checkpoint(),
    captureClose: (close) => {
      resources.closeHistory = close;
    },
    cleanupUncertain: (cause) => lifetime.cleanupFailed(cause),
    isStoppedFailure: (cause) => lifetime.isStoppedFailure(cause),
  });
  const snapshot = loadRunSnapshot(opened.db, runId);
  if (snapshot === undefined) {
    throw new CliError('invalid_invocation', `no run found with id ${runId}`);
  }

  const workflow = parseSnapshot(snapshot.workflowDefinitionSnapshot, runId);

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
  const checkpoint = await checkpointer.load(runId);
  lifetime.checkpoint();
  if (checkpoint === undefined) {
    // A run row with a snapshot but no reconstructable checkpoint (no run:started in the log) — corrupt/partial.
    throw new CliError('invalid_invocation', `run ${runId} has no resumable state`);
  }

  // The reconstructed `checkpoint.runStatus` is the authoritative run state (folded fresh from the event log
  // right here), so it drives the terminal/idempotency decision — not the `runs.status` column, which a
  // racing process could have advanced between the snapshot read and now (and which the engine would then
  // surface as a closed-handle resume → a misleading exit 1).
  const selection =
    kind === 'budget'
      ? selectBudgetGate(checkpoint, request.gate)
      : selectGate(checkpoint, checkpoint.runStatus, request.gate);
  if (selection.kind === 'invalid') {
    throw new CliError('invalid_invocation', selection.message);
  }
  if (selection.kind === 'idempotent') {
    // A doubled decision (run finished / gate already resolved) — a clean no-op, NOT a double-advance.
    return { kind: 'settled', message: selection.message };
  }

  if (kind === 'budget') {
    const gate = checkpoint.pendingGates.find((entry) => entry.gateId === selection.gateId);
    assertBudgetDecision(gate?.allowance, decision);
  } else {
    const gate = checkpoint.pendingGates.find((entry) => entry.gateId === selection.gateId);
    assertDecisionFitsGateType(workflow, gate?.nodeId, decision);
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
  const commandBase = resumeCommandBase(kind, runId, selection.gateId);
  const resumeInvocation = formatResumeInvocation(commandBase, kind, decision);
  const inputs = await resolveSecretInputs(
    parseInputs(snapshot.inputJson, runId),
    request,
    ports,
    resumeInvocation,
  );
  lifetime.checkpoint();
  const keys =
    kind === 'budget' && decision.decision === 'rejected'
      ? undefined
      : deps.resolveKeys?.(opened.db);
  lifetime.checkpoint();
  const providers = deps.providers ?? keys?.providers ?? createProviderResolver(deps.io.env);
  // Media host-wiring (2.S), the SAME helper `run` uses: a gate-resumed run that produces media must wire the
  // same CAS + retention + catalog as the original run (else it would be silently text-only). The checkpointer
  // stays. `save_to`'s scope root is the ORIGINAL run's project root when it still exists here (see
  // resolveSaveToRoot), else the resumer's cwd — so a same-machine resume writes under the original dir, while
  // a resume on a different machine / after that dir was deleted falls back gracefully instead of failing.
  const saveToRoot = resolveSaveToRoot(snapshot.projectRoot, deps.global.cwd);
  const wiring = buildMediaEngineWiring(
    opened.db,
    homeDir,
    saveToRoot,
    config,
    lifetime.notification((m: string) => deps.io.writeErr(`${m}\n`)),
  );
  // D15 catalog load-check on the resume path too (the SAME helper `run` uses) — re-validate the snapshot's
  // authored `output_modalities` against the CURRENT catalog, so a model that lost a capability between the
  // original run and this resume is rejected consistently (exit 2), not silently routed at runtime.
  assertWorkflowCatalogValid(workflow, wiring.workflowModelCatalog);
  // A budget rejection is fatal and dispatches no agent. Do not spawn tools merely to reject it.
  if (workflowDeclaresMcp(workflow) && !(kind === 'budget' && decision.decision === 'rejected')) {
    resources.mcpRuntime = await connectWorkflowMcp(workflow, {
      ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
      cwd: saveToRoot,
      preserveFrozenGrants: true,
      connectSignal: lifetime.signal,
      assertAdmitting: () => lifetime.checkpoint(),
      onFailure: (cause) => {
        if (!lifetime.isStoppedFailure(cause)) lifetime.failure(cause);
      },
      onCloseError: resources.reportMcpCloseFailure,
      budget: lifetime.invocation.registry.budget,
      work: resources.mcpWork,
      registrations: config.mcpServers,
      resolveSecret:
        deps.mcpSecretResolver ?? keys?.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
      artifact: `frozen run ${runId}`,
      consentGate: ports.consentGate(homeDir),
      ...(deps.startMcpClient === undefined ? {} : { startMcpClient: deps.startMcpClient }),
    });
    lifetime.checkpoint();
    if (resources.mcpRuntime !== undefined)
      surfaceMcpSkipped(deps.io, resources.mcpRuntime.client.skipped);
  }
  const mcpRuntime = resources.mcpRuntime;

  lifetime.checkpoint();
  // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — read from the SAME durable `history.db`, so the resumed
  // workflow's post-gate continuation enforces `budget.max_cost_microcents` on a user-priced model exactly like
  // the original `run` did (pre-egress + realized). Without it a gated run would silently uncap that model on the
  // far side of the gate — the very ADR-0064 §6 gap this closes. Non-fatal read (an empty map ⇒ no user pricing).
  const resolvePrice = readUserPricingOverlay(opened.db);
  lifetime.checkpoint();
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
    onEffortWithheld: onceEffortNotice(
      lifetime.notification((note: string) => deps.io.writeErr(`warning: ${note}\n`)),
    ),
    // ADR-0071 §K7: a resumed agent node on an unpriced model degrades to `allow`, so `budget.max_cost_microcents`
    // did not apply to it — say so on stderr (never stdout, `--json`). `budget.strict_cost_cap` blocks instead.
    onUnpriced: lifetime.notification(
      (model: string, capMicrocents: number, modalities?: readonly MediaBilledModality[]) =>
        deps.io.writeErr(
          `warning: ${unpricedModelNote(model, capMicrocents, 'budget.strict_cost_cap', modalities)}\n`,
        ),
    ),
    // ADR-0074 §3: new egress is HELD while a resumed media job submitted by an older Relavium settles — its
    // cost basis was not recorded, so the cap cannot be trusted until the job reports its real charge. Say so,
    // or a resume looks like an unexplained stall. stderr, never stdout (`--json` stays a pure event stream).
    // stderr, never stdout, so `--json` stays a pure event stream. The SENTENCE is
    // {@link legacyMediaJobHoldNotice} so it can be pinned directly — this sink reached the terminal for the
    // first time only when the engine wiring was fixed, and nothing had ever rendered it.
    onLegacyMediaJobHold: lifetime.notification((nodeIds: readonly string[]) => {
      deps.io.writeErr(legacyMediaJobHoldNotice(nodeIds));
    }),
    // 2.5.A (ADR-0055): wire the SAME read+write fs + process ToolHost the `relavium run` path wires, jailed
    // to the ORIGINAL run's project root (`saveToRoot` — the original `runs.project_root` when it still exists
    // on this machine, else the resumer's cwd, exactly like the `save_to` root) at the resolved `fs_scope`. So a
    // tool-using agent node on the FAR side of a human gate reads/writes the ORIGINAL project context
    // (checkpoint/resume parity), not the gate caller's directory, and not `tool_unavailable`.
    toolEnv: {
      operatorHomeDir: homeDir,
      workspaceDir: saveToRoot,
      fsScopeTier: config.fsScope ?? 'sandboxed',
      ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
    },
    host: createCliHost(store, {
      operatorHomeDir: homeDir,
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
  lifetime.adoptEngine(engine, runId);
  // Same reconcile as the `run` path (ADR-0078 §4/§5, ADR-0079 §7) — a gate resume is equally "the next
  // `relavium` start", and it is the one a user reaches for after seeing the `durabilityUncertain` exit code
  // on a gated run. The run this command resumes is parked at its gate, so `reconcile()` leaves it alone.
  lifetime.checkpoint();
  await engine.reconcile().catch(() => undefined);
  lifetime.checkpoint();
  const handle = await resumeOrFail(engine, {
    runId,
    eventConsumption: 'iterated',
    workflow,
    inputs,
    gateId: selection.gateId,
    decision,
  });
  lifetime.adoptHandle(handle);
  return { kind: 'resumed', engine, handle, db: opened.db, mediaCasRoot: wiring.media.casRoot };
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
        message: `gate ${sanitizeInline(requested)} already resolved`,
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

/** Validate frozen JSON against the historical contract; new author-only rules never rewrite a parked run. */
function parseSnapshot(snapshotJson: string, runId: string): WorkflowDefinition {
  try {
    return WorkflowSnapshotSchema.parse(JSON.parse(snapshotJson));
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

/** The remedy a refusal names for a run whose secrets were not supplied; the shell's own reader reuses it. */
export function secretPipeHint(resumeInvocation: string | undefined): string {
  return resumeInvocation === undefined
    ? 'Re-run the same decision with the recorded run and gate IDs and --secret-stdin, supplying name=value lines on stdin.'
    : "Pipe the run's secret inputs as name=value lines on stdin — e.g. " +
        `\`printf 'api_key=%s\\n' "$VALUE" | ${resumeInvocation} --secret-stdin\` ` +
        '(a credential is never passed as an argument).';
}

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
 * Every masked slot must be supplied and nothing else may be. Unexpected source names are refused without
 * reflecting their untrusted bytes, and an empty value is refused explicitly rather than by omission — the
 * engine would accept `''` as "re-supplied", and a blank line in a piped heredoc is the likeliest way to
 * produce one by accident.
 */
async function resolveSecretInputs(
  inputs: Record<string, unknown>,
  request: ResumeRunRequest,
  ports: ResumeRunPorts,
  resumeInvocation: string | undefined,
): Promise<Record<string, unknown>> {
  const masked = Object.keys(inputs).filter(
    (key) => MaskedSecretSchema.safeParse(inputs[key]).success,
  );
  if (masked.length === 0) {
    if (request.secretStdin === true) {
      throw new CliError(
        'invalid_invocation',
        `run ${request.runId} has no \`secret\` inputs to re-supply — drop --secret-stdin.`,
      );
    }
    return inputs;
  }
  if (request.secretStdin !== true) {
    throw new CliError(
      'invalid_invocation',
      `run ${request.runId} needs its \`secret\` input(s) [${masked.join(', ')}] re-supplied to resume — ` +
        `they are never persisted. ${secretPipeHint(resumeInvocation)}`,
    );
  }
  const supplied = await ports.secretInputs({ resumeInvocation });
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
      `stdin supplied a name that run ${request.runId} has no \`secret\` slot for.`,
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
