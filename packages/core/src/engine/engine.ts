/**
 * `WorkflowEngine` (1.N) — the run loop that walks a `RunPlan` (1.M), dispatches every vertex whose
 * dependencies are satisfied, and emits the canonical `RunEvent` stream
 * ([ADR-0036](../../../../docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md),
 * sse-event-schema.md). It owns the *loop*, not the node bodies: each ready vertex is dispatched
 * through the injected {@link NodeExecutor} seam, which the `AgentRunner` (1.O) and the node-type
 * handlers (1.P) fill — so the loop is proven here with stub executors and a real executor plugs in
 * unchanged. The engine is **completion-driven** (a vertex becomes ready the moment its last dependency
 * settles — the JS event loop is the scheduler, never a sleep/poll), runs independent branches
 * concurrently under the `max_parallel` cap, and threads one `AbortSignal` so cancellation is
 * cooperative end-to-end.
 *
 * The two guarantees this file is responsible for:
 * - **Skip-propagation.** When a `condition` routes away from a branch (or any vertex is skipped), every
 *   vertex reachable *only* through it is skipped — gated so a vertex skips only when *all* its
 *   dependencies route away (no surviving live upstream path). A downstream `fan_in` counts a skipped
 *   branch as settled, so it joins instead of waiting forever.
 * - **Exactly one terminal event.** Every run ends in exactly one of `run:completed | run:failed |
 *   run:cancelled` (cancel wins a race with a late failure; an uncaught node-handler throw maps to a
 *   single `run:failed{internal}`; {@link WorkflowEngine.reconcile} fails a crashed non-resumable run
 *   to `run:failed`, never a stuck `run:started`). `run:paused` / `human_gate:paused` are non-terminal.
 *
 * 1.N deliberately does **not** own: real node execution (1.O/1.P), node-level retry above the provider
 * chain (1.S), the pre-egress budget gate/estimator (1.AC — 1.N only provides the concurrency-cap
 * scheduling point and would emit the governance events), real `Checkpointer` persistence and gate
 * timeouts (1.R/1.Q). It dispatches a `fan_in` once all its branches have settled and hands the
 * `joinStrategy` + live branch set to the executor, which performs the merge (true `wait_first`
 * early-cancel is a 1.P refinement) — see run-plan.md §fan-in.
 */

import {
  DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES,
  GateDecisionSchema,
  MEDIA_JOB_POLL_DEFAULTS,
  RETRYABLE_ERROR_CODES,
  RunEventSchema,
  collectDurableMediaHandles,
  countUnpinnedMedia,
  containsDurableUnsafeMedia,
  deInlineMedia,
  type DurableMediaMeta,
  type ExecutionMode,
  type GateDecision,
  type LlmProviderId,
  type MaskedSecret,
  type MediaBilledModality,
  type MediaEgressHooks,
  type NodeSkippedReason,
  RUN_LEASE_HEARTBEAT_MS,
  RUN_LEASE_TTL_MS,
  isLeaseFencedError,
  type Retry,
  type RunDurability,
  type RunEvent,
  type RunFence,
  type RunStatus,
  type TokensUsed,
  type EffectCorrelation,
  type EffectDispatchPort,
  type EffectResumePort,
  type UnresolvedEffect,
  openDeadline,
  type DeadlineScope,
  armLongTimer,
} from '@relavium/shared';
import type { EndpointKind, MediaJobStatus, PricingOverlay, ProviderId } from '@relavium/llm';

import { buildRunPlan, type BuildRunPlanOptions } from '../dag.js';
import { InterpolationError } from '../errors.js';
import { resolveContext, resolveTemplate } from '../interpolation/resolve.js';
import type { ResolverCapabilities, RunScope } from '../interpolation/scope.js';
import { ADMISSION_CEILINGS, DEFAULT_MAX_PARALLEL } from '../limits.js';
import {
  describeBreach,
  measureDraft,
  measureNodeOutput,
  measureWorkflowState,
} from './size-bounds.js';
import type { PlanVertex, RunPlan } from '../run-plan.js';
import type { WorkflowDefinition } from '../parser.js';
import { resolveAndValidateWorkflowInputs } from './input-admission.js';
import { verifyFrozenWorkflowContent, verifyResumeIdentity } from './resume-identity.js';
import { EngineStateError } from './errors.js';
import { RunEventBus, type RunEventDraft } from './event-bus.js';
import { RunLoopInvariantError } from './invariant-error.js';
import {
  BudgetGovernor,
  CommitmentDurabilityError,
  DEFAULT_MAX_TOKENS_ESTIMATE,
  type BudgetAdmission,
} from './budget-governor.js';
import type {
  CheckpointPendingGate,
  CheckpointPendingMediaJob,
  CheckpointState,
} from './checkpoint.js';
import {
  LedgerDurabilityError,
  MoneyDurability,
  isLedgerDurabilityError,
} from './money-durability.js';
import type { AbortControllerLike, ExecutionHost, InterruptedRun } from './execution-host.js';
import type {
  GateRequest,
  MediaJobSubmission,
  NodeExecContext,
  NodeExecutor,
  NodeFailure,
  NodeOutcome,
  NodeStreamEvent,
} from './node-executor.js';
import { NodeMediaPinError } from './media-pin-error.js';
import { codeForLlmError } from './agent-turn.js';
import {
  DEFAULT_MEDIA_UNIT_ESTIMATE,
  generativeUnits,
  realizedMediaCost,
  takeMediaJobAdmission,
} from './agent-runner.js';
import { createClosedRunHandle, createRunHandle, type RunHandle } from './run-handle.js';

/** A vertex's live status in one run. `paused` (at a gate) and `running` are not yet *settled*. */
type VertexStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

interface VertexState {
  status: VertexStatus;
  output?: unknown;
  /** For a settled `condition`: the immediate target ids it selected (the live out-edges). */
  selectedTargets?: ReadonlySet<string>;
}

/**
 * A parked async media job (1.AG Section D, [ADR-0045](../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)) —
 * the in-memory record the engine polls. Keyed by `nodeId` (the AG-A-FC-3 disambiguator vs `#pendingGates`,
 * which is keyed by gateId). The credential is NEVER stored here (re-resolved per poll via the executor);
 * `units` is the authored volume for the lone realized cost addend (recomputed from the node config on
 * cross-process resume); `backoffMs` grows per poll (exp, capped at `pollMaxMs`).
 */
interface ParkedMediaJob {
  readonly jobId: string;
  readonly provider: LlmProviderId;
  readonly model: string;
  readonly modality: MediaBilledModality;
  readonly units: number;
  /** ISO-8601 absolute deadline; a poll where `now > deadlineAt` abandons the job as a retryable timeout. */
  readonly deadlineAt: string;
  /** Elapsed-ms-since-run-start at submission — the basis for the completed node's full LRO `durationMs`
   *  (submit→done wall-clock, not the ~0 of the synchronous settle). Recoverable across a resume from the
   *  persisted `startedAt` (M2). */
  readonly submittedAtMs: number;
  /** The current poll interval (ms), grown exponentially per `pending` poll, capped at `pollMaxMs`. */
  backoffMs: number;
  /** Process-local cost-cap reservation for an already-submitted job; reconstructed on checkpoint resume. */
  admission?: BudgetAdmission;
  /** Guards every terminal/error sweep from emitting the paid-job addend more than once. */
  costAccounted?: boolean;
}

/** A vertex status counts as *settled* (its dependents can evaluate) when it is one of these. */
const SETTLED: ReadonlySet<VertexStatus> = new Set<VertexStatus>([
  'completed',
  'failed',
  'skipped',
]);

/** The three events that close a run — exactly one ever fires (ADR-0036). */
const TERMINAL_TYPES: ReadonlySet<RunEvent['type']> = new Set<RunEvent['type']>([
  'run:completed',
  'run:failed',
  'run:cancelled',
]);

/**
 * Strip the best-effort media-bearing payload from a TERMINAL draft to an empty record (1.AF). Used only
 * as the last-resort fallback when `deInlineMedia` cannot run (a media-bearing run with no `MediaStore`
 * injected): the terminal event MUST still emit (exactly-one-terminal-event), and it must carry no inline
 * bytes (I3), so `run:completed.outputs` / `run:failed.partialOutputs` are emptied rather than blocking
 * the terminal or leaking. The run still settles; the `run:failed` error explains the cause.
 */
function stripTerminalMediaPayload(draft: RunEventDraft): RunEventDraft {
  if (draft.type === 'run:completed') {
    return { ...draft, outputs: {} };
  }
  if (draft.type === 'run:failed') {
    return { ...draft, partialOutputs: {} };
  }
  return draft;
}

/** The terminal `RunStatus` values — a checkpoint in one of these is a finished run (1.R resume no-op). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** The above-chain node-retry backoff base (ms) when `retry.backoff_ms` is unset (ADR-0040 A.3, the runner
 *  constant — distinct from the within-chain FallbackChain base). */
const DEFAULT_NODE_RETRY_BACKOFF_MS = 1000;

/** Hard ceiling (ms, 24h) on a computed node-retry backoff — so a large (schema-valid) `retry.max` with
 *  exponential growth can never overflow `delayMs` past the run-event integer range (a stamp-time throw) or
 *  arm an absurd timer. A node-retry that needs a >24h wait should be a scheduled job, not a backoff. */
const MAX_NODE_RETRY_BACKOFF_MS = 86_400_000;

/** The input to {@link WorkflowEngine.start} — a parsed workflow plus its run inputs and mode. */
export interface StartInput {
  /** The parsed, validated workflow (the host read the file and called `parseWorkflow`). */
  readonly workflow: WorkflowDefinition;
  /** The run inputs (the `inputs` namespace); a `secret`-typed input is masked in `run:started`. */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** The execution mode stamped on `run:started` (default `local`). */
  readonly executionMode?: ExecutionMode;
  /** Forwarded to {@link buildRunPlan} (e.g. the resolved-agent registry). */
  readonly planOptions?: BuildRunPlanOptions;
}

/**
 * Inputs to {@link WorkflowEngine.resumeFromCheckpoint} — resume a run from a PRIOR process (1.R).
 *
 * **Identity is VERIFIED, not assumed (ADR-0083 §5).** This used to carry an "invariant (caller's
 * responsibility)" that `inputs` and `executionMode` be the same values the run started with, checked by
 * nothing — so a caller that reconstructed either differently, or passed neither, silently continued the run
 * under a state its own `run:started` never had. They are now folded from that event into `CheckpointState`
 * and the caller's copies are **checked against the record and then discarded**: a difference is a typed
 * refusal (`input_mismatch` / `execution_mode_mismatch`), and an omission takes the recorded value rather
 * than a default. `workflow` identity is still verified by surrogate id (`workflow_mismatch`).
 *
 * A `secret` input is the one thing the record cannot hold — it is persisted as `{ secret: true, ref }` — so
 * the caller **re-supplies it by name** or the resume is refused (`secret_input_missing`). §6 states exactly
 * what that proves: the SLOT, not the credential.
 *
 * `planOptions` is verified by agent ID, not by content (§5) — an agent file edited between processes is
 * not detected, recorded as a limitation in §10.
 */
export interface ResumeFromCheckpointInput {
  readonly runId: string;
  /** The workflow to resume against — the engine refuses one whose identity differs (workflow_mismatch). */
  readonly workflow: WorkflowDefinition;
  /**
   * The caller's copy of the run's inputs, VERIFIED against the admission record rather than used. Omit it
   * and the record is used unchanged — except for a `secret`, which must be re-supplied here by name.
   */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** VERIFIED against the recorded mode; omit to take the recorded one (never a `'local'` default). */
  readonly executionMode?: ExecutionMode;
  readonly planOptions?: BuildRunPlanOptions;
  /**
   * The gate to resolve + the decision to apply, when the run was suspended at a HUMAN GATE. **Both omitted**
   * for a run suspended ONLY on an async media job (1.AG Section D, ADR-0045 §3) — that resume re-attaches +
   * re-polls the persisted job(s) with no external decision. When a run is parked on BOTH a gate and a media
   * job (AG-A-FC-3), pass the gate's `gateId`/`decision`: the gate decision advances while `#seedFromCheckpoint`
   * independently re-attaches the parked media job(s).
   */
  readonly gateId?: string;
  readonly decision?: GateDecision;
}

/**
 * Validate a {@link ResumeFromCheckpointInput}'s gate fields (1.R / 1.AG Section D). A gate resume supplies
 * BOTH `gateId` + `decision`; a media-only resume supplies NEITHER — a half-supplied pair is a caller misuse,
 * and a supplied `decision` must parse. Throws a typed {@link EngineStateError} (`invalid_decision`); pulled
 * out of `resumeFromCheckpoint` so the entry stays within the cognitive-complexity budget.
 */
function assertValidResumeInput(input: ResumeFromCheckpointInput): void {
  if ((input.gateId === undefined) !== (input.decision === undefined)) {
    throw new EngineStateError(
      'invalid_decision',
      'resumeFromCheckpoint needs BOTH gateId + decision (a gate resume) or NEITHER (a media-job resume)',
      { runId: input.runId, ...(input.gateId === undefined ? {} : { gateId: input.gateId }) },
    );
  }
  if (input.decision !== undefined && !GateDecisionSchema.safeParse(input.decision).success) {
    throw new EngineStateError('invalid_decision', 'the gate decision failed validation', {
      runId: input.runId,
      ...(input.gateId === undefined ? {} : { gateId: input.gateId }),
    });
  }
}

/** Construction dependencies for the engine — the injected host and node-executor seams. */
export interface WorkflowEngineDeps {
  /**
   * Builds a per-node effect journal from a run correlation (ADR-0080) — a FACTORY rather than a port,
   * because the correlation differs per node and per retry attempt and only the run loop knows both.
   *
   * Absent ⇒ a dispatch gets `unwiredEffectJournal()` and an EFFECT IS REFUSED. That is the fail-closed
   * direction: a host with no journal must not silently dispatch unrecorded effects.
   */
  readonly effectJournal?: (correlation: EffectCorrelation) => EffectDispatchPort;
  /**
   * The journal's READ half, consumed by the resume gate
   * ([effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §4). Optional for the same
   * reason `effectJournal` is: a host with no journal has no rows to gate on. A host that wires the WRITE
   * half and forgets this one is the dangerous combination, and `resumeFromCheckpoint` says so out loud.
   */
  readonly effectResume?: EffectResumePort;

  readonly host: ExecutionHost;
  readonly executor: NodeExecutor;
  /** Validate every emitted event against `RunEventSchema` (default `true`; off only for a hot path). */
  readonly validateEvents?: boolean;
  /** Per-consumer event-buffer high-water mark before the producer is asked to await a drain. */
  readonly eventBufferCapacity?: number;
  /**
   * Resolver capabilities (e.g. `readFile`) the engine uses to resolve the workflow `context:` map once at
   * run start (the `ctx.*` namespace; see {@link NodeExecContext.ctx}). A surface that allows `read_file`
   * in a `context:` value injects it here — the same purity seam the node handlers use; omit ⇒ no `read_file`.
   */
  readonly resolverCapabilities?: ResolverCapabilities;
  /**
   * Per-call output-token default the pre-egress budget governor uses when a node/session omits
   * `maxTokens` (ADR-0028). Not the model's absolute max, which would over-block.
   */
  readonly maxTokensEstimate?: number;
  /**
   * The user-pricing overlay (2.5.G S10, [ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md)
   * §2) — a `ReadonlyMap<modelId, ModelPricing>` the host projects from the `model_catalog` `source='user'` rows.
   * It feeds the workflow PRE-EGRESS budget governor so a model with no static price, once user-priced, is enforced
   * by `budget.max_cost_microcents`. The USER tier outranks the catalog (ADR-0071 §1).
   * Injected exactly like the realized path's overlay, which the node executor's runner already carries; omit ⇒
   * an unknown model degrades cost governance to `allow` loudly, unchanged.
   */
  readonly resolvePrice?: PricingOverlay;
  /**
   * Is a model's provider on its own API, or behind a custom `base_url` (ADR-0071 §7)? Forwarded to the pre-egress
   * {@link BudgetGovernor}: the adapter clamps an authored `max_tokens` to the model's ceiling only on an official
   * endpoint, and an estimate that assumes otherwise stops describing the request the wire will carry. Absent ⇒
   * official (the adapter's own default).
   */
  readonly resolveEndpoint?: (provider: ProviderId) => EndpointKind;
  /**
   * Called once per model when a turn runs UNPRICED, so the cost cap could not apply to it (ADR-0071 §K7). The
   * engine cannot print; the host routes it (`run` → stderr). Absent ⇒ silent (`strict_cost_cap` is the block).
   */
  readonly onUnpriced?: (
    model: string,
    capMicrocents: number,
    /** Present ⇒ the MODEL is priced and only these billed modalities are not (ADR-0089 §4). */
    modalities?: readonly MediaBilledModality[],
  ) => void;
  /**
   * Called once when new egress is HELD because a resumed media job's cost basis is unknown — a row written
   * before ADR-0074 §3 froze it. §3 requires this fallback be observable; without it a `resume` looks like an
   * unexplained stall. The engine cannot print; the host routes it (`gate` → stderr), exactly as
   * {@link onUnpriced}. Absent ⇒ silent.
   *
   * Only `gate` wires it, and only `gate` CAN reach it: the hold is registered from `#restoreParkedMediaJob`,
   * reachable only through `resumeFromCheckpoint`, and a fresh `relavium run` has no checkpoint to restore a
   * legacy job from. Stated because this line claimed `run` routed it too, which was harmless only while the
   * sink was dead.
   */
  readonly onLegacyMediaJobHold?: (nodeIds: readonly string[]) => void;
}

function maskInputs(
  inputs: Readonly<Record<string, unknown>>,
  secretNames: ReadonlySet<string>,
): Record<string, unknown> {
  // Null-prototype: an input name MAY be `__proto__` (the `[A-Za-z0-9_-]+` grammar permits `_`), so a
  // plain object would let `masked['__proto__'] = …` pollute Object.prototype.
  const masked: Record<string, unknown> = { __proto__: null };
  for (const [key, value] of Object.entries(inputs)) {
    masked[key] = secretNames.has(key)
      ? ({ secret: true, ref: `inputs.${key}` } satisfies MaskedSecret)
      : value;
  }
  return masked;
}

/**
 * One run's execution state and loop. Created per `start`; holds the plan, the per-vertex states, the
 * bus, and the handle. All mutation happens on the single (serialized) drive loop, so there is no
 * cross-vertex data race despite concurrent branch execution.
 */
/**
 * A run's ownership of its own lease (ADR-0079). Five states, because two booleans could not tell the cases
 * apart and the confusion cost a real bug: a parked run fenced ITSELF out against the row it had released.
 *
 * - `unclaimed` — before the first acquire. `run:started` is written here, unfenced, because the lease row
 *   references `runs.id` and so cannot exist until that event is folded.
 * - `held` — this process owns the run and may write.
 * - `parked` — a gate park handed the lease back (§4). The run is not being executed, but its gate deadline,
 *   the run-level `timeout_ms` and cooperative cancel all stay armed, so a write can still arrive: it must
 *   RE-TAKE the claim first, which is usually uncontended.
 * - `lost` — another process owns the run. Write nothing, claim nothing (§5).
 * - `done` — the run settled and the lease was released. Terminal: a later write must not resurrect the row
 *   (`acquire` computes `(current?.generation ?? 0) + 1`, so a re-acquire over a deleted row would insert a
 *   `run_leases` row nothing ever releases). **Defence in depth, not a demonstrated path**: no test in the
 *   suite dies when this arm is made permissive — measured, not assumed — because `#settled` already turns
 *   every known post-terminal caller away earlier. It is kept because the cost is one switch arm and the
 *   failure it guards is a silent, unbounded row leak.
 *
 * The same is true of the `lost` arm and of `#settle`'s post-terminal `#lostOwnership()` guard: making either
 * permissive also leaves the suite green. The reason is the same in all three cases and is deliberate —
 * `#fence` is RETAINED after ownership ends, so the store's own transactional check refuses the stale token
 * independently of what this switch decides. Two backstops, and the store's is the one proven across
 * processes. Do not read the redundancy as dead code; read it as the engine refusing to rely on the store
 * being reachable to know what it is entitled to write.
 */
type RunOwnership = 'unclaimed' | 'held' | 'parked' | 'lost' | 'done';

class RunExecution {
  readonly runId: string;
  readonly handle: RunHandle;

  readonly #plan: RunPlan;
  readonly #workflow: WorkflowDefinition;
  readonly #inputs: Readonly<Record<string, unknown>>;
  readonly #maskedInputs: Record<string, unknown>;
  /** The names of `secret`-typed inputs — threaded to handlers so they keep raw secrets out of outputs. */
  readonly #secretInputNames: ReadonlySet<string>;
  readonly #executionMode: ExecutionMode;
  readonly #host: ExecutionHost;
  readonly #executor: NodeExecutor;
  readonly #bus: RunEventBus;
  readonly #onSettled: (runId: string) => void;
  readonly #resolverCapabilities: ResolverCapabilities;
  readonly #maxTokensEstimate: number;
  readonly #resolvePrice: PricingOverlay | undefined;
  /** The resolved workflow `context:` (`ctx.*`), folded once at run start (or re-resolved on resume). */
  #resolvedContext: Readonly<Record<string, string>> = {};

  readonly #abort: AbortControllerLike;
  readonly #states = new Map<string, VertexState>();
  readonly #pendingGates = new Map<
    string,
    { readonly vertexId: string; readonly isBudgetGate: boolean }
  >();
  /** Gate ids whose decision was already applied — a re-delivery is an idempotent no-op (1.R). */
  readonly #resolvedGates = new Set<string>();
  /** Disarm callbacks for armed gate-timeout timers, by gateId — disarmed on resume / settle (1.Q). */
  readonly #gateTimers = new Map<string, () => void>();
  /** Parked async media jobs by nodeId (1.AG Section D) — the engine-owned poll/checkpoint/resume/cancel loop. */
  readonly #pendingMediaJobs = new Map<string, ParkedMediaJob>();
  /** Disarm callbacks for armed media-job poll timers, by nodeId — disarmed on settle/cancel (ADR-0045 §4). */
  readonly #mediaJobTimers = new Map<string, () => void>();
  /** The run-level wall-clock timeout timer, when a `timeout_ms` is configured (ADR-0028). */
  #runTimeoutDisarm: (() => void) | undefined;
  /** ADR-0085 §3's post-abort grace window; armed off the abort signal, disarmed on settle. */
  #graceDisarm: (() => void) | undefined;
  /** Set synchronously when the grace window elapses: no vertex may be dispatched after this (ADR-0085 §3). */
  #noNewDispatch = false;
  /** ADR-0085 §5's fence: the dispatch id currently authoritative for each vertex. */
  readonly #activeDispatchByVertex = new Map<string, number>();
  /** Media parts this run has re-hosted — the run-scope half of `CR-54`'s ceiling (ADR-0086 §4). */
  #pinnedMediaParts = 0;

  /** The dispatch id a vertex's in-flight work was started under — the value `#isLive` is checked against. */
  readonly #dispatchIdForVertex = new Map<string, number>();
  /**
   * When each vertex's node deadline started, so `timeout_ms` is absolute across RE-dispatches too
   * (ADR-0085 §2). Set on a vertex's first dispatch and never reset while the run lives: an approved budget
   * gate returns the vertex to `pending`, `#claimReady` re-claims it, and a fresh full-length bound would
   * hand the node a second helping of the patience its author granted once.
   */
  readonly #nodeDeadlineStartMs = new Map<string, number>();
  /** The armed node-deadline timer per vertex — run-owned, disarmed only at the node's terminal. */
  readonly #nodeDeadlineDisarm = new Map<string, () => void>();
  /** The attempt number a vertex is currently on, so an ABANDONED node logs its real attempt, not 1. */
  readonly #lastAttemptByVertex = new Map<string, number>();
  /** Monotonic per-run dispatch id — see {@link #activeDispatchByVertex}. */
  #nextDispatchId = 0;
  /** The pre-egress budget governor, when a workflow `budget` is configured (ADR-0028, 1.AC). */
  readonly #budgetGovernor: BudgetGovernor | undefined;
  /** The money-durability barrier for BOTH chains — always present, cap or no cap (ADR-0077 §5). */
  readonly #money: MoneyDurability;
  /** Vertices whose budget gate was APPROVED — their next re-dispatch (and all its node-retry attempts) skips
   *  the pre-egress check so the deferred LLM call actually issues (H3). Consumed once per dispatch in
   *  `#dispatch` and cleared on `#settle`. */
  readonly #budgetApprovedVertices = new Set<string>();

  #workflowId = '';
  #settled = false;
  #cancelling = false;
  #failure: { readonly nodeId?: string; readonly error: NodeFailure } | undefined;
  #scheduling = false;
  #rerun = false;
  #pauseEpisode = false;
  /**
   * Serializes the run's durable APPEND, its write and its DELIVERY, in that order (ADR-0078 §1).
   *
   * It began as a delivery-only tail — the persist was started before `await prior` — which left two events
   * for one run overlapping in flight. Moving the await above the write made the one tail carry all three,
   * which is what makes {@link #lastAskedSequenceNumber} well-defined at the call site.
   */
  #deliveryTail: Promise<void> = Promise.resolve();
  /**
   * The sequence number last ASKED of the store for this run, or `-1` before the first append.
   *
   * Advanced for a guarded (non-terminal) event whether or not its write lands — see
   * `DurableWriteContext.expectedLastSequenceNumber` for why "asked" rather than "committed" is the value
   * that makes the next append fail closed after a lost write.
   */
  #lastAskedSequenceNumber = -1;
  /**
   * Whether the run's TERMINAL reached the durable log (ADR-0078 §5), surfaced through
   * `RunHandle.durability`. `'uncertain'` means the terminal was delivered in-process but its write did not
   * land and it was handed to the host's `TerminalOutbox` instead — the one state in which a caller must not
   * be told the run completed.
   */
  #terminalDurability: RunDurability = 'pending';
  /**
   * This run's ownership claim (ADR-0079). Carried on every durable write, so the store refuses one from a
   * process that has been taken over.
   *
   * `undefined` only before the first acquire — which includes `run:started` itself, because the lease row
   * references `runs.id` and so cannot exist until that event is folded. **Deliberately RETAINED after a
   * release**: a released row makes the store's missing-lease arm fire, so a write that somehow escapes the
   * `#owned` check below is still refused rather than silently accepted unguarded.
   */
  #fence: RunFence | undefined;
  /**
   * Whether this process currently HOLDS the lease, as distinct from merely remembering a fence.
   *
   * The two came apart when §4 began releasing on a gate park. A parked run is not being executed, but it is
   * not inert either — its gate deadline, the run-level `timeout_ms` and a cooperative cancel all stay armed
   * by design, and every one of them ends at `#settle`. Without this flag those paths wrote a terminal while
   * unowned, and because a terminal is exempt from the append guard (ADR-0078 §2) and an ABSENT fence is a
   * pass rather than a refusal, the store accepted it — putting a second terminal into a run another process
   * was finishing. That is precisely the divergence ADR-0079 exists to prevent, reintroduced by §4 itself.
   */
  #ownership: RunOwnership = 'unclaimed';
  /**
   * Builds a per-node effect journal from a run correlation (ADR-0080). Injected as a FACTORY rather than a
   * port, because the correlation differs per node and per retry attempt and only the run loop knows both.
   */
  readonly #effectJournal: ((correlation: EffectCorrelation) => EffectDispatchPort) | undefined;
  /** The journal's READ half — the resume gate (effect-journal.md §4). Absent when no host wired one. */
  readonly #effectResume: EffectResumePort | undefined;
  /** The owning engine's identity — passed in, never minted here, so one engine is one owner. */
  readonly #ownerId: string;
  /**
   * Set when a durable write was refused by the FENCE rather than by a store fault (ADR-0079 §5).
   *
   * It suppresses the terminal entirely. A fenced process knows it lost; it does NOT know what happened to
   * the run, because the new owner may be completing it right now. Writing `run:failed` would be a durable
   * lie about somebody else's run — and could not be written anyway, since the fence rejects it too.
   */
  /** Guards {@link RunExecution.#settleFenced} so overlapping discovery points tear down exactly once. */
  #fencedSettled = false;
  /** Consecutive heartbeats that could not be written — bounded tolerance, see `#beat`. */
  #missedBeats = 0;
  /** Disarms the lease heartbeat. Cleared at settle, like every other timer this run arms. */
  #heartbeatDisarm: (() => void) | undefined;
  /** Ends the handle's iteration without a terminal — the fenced path only (ADR-0079 §5). */
  #closeStream: (() => void) | undefined;
  #startEpochMs = 0;
  /**
   * Node dispatches this run has made — ADR-0086 §4's runtime backstop, and the one W3 ceiling that cannot
   * be checked at admission because it is a property of what a run DOES, not of what it says.
   *
   * Incremented where `node:started` is emitted, and seeded from the checkpoint on resume, so it counts the
   * run rather than this process's slice of it.
   */
  #nodeDispatches = 0;
  /** Serialised bytes of every node output kept so far — `CR-32`'s workflow-state bound. */
  #workflowStateBytes = 0;
  #cumulativeCostMicrocents = 0;
  #totalInputTokens = 0;
  #totalOutputTokens = 0;

  constructor(params: {
    runId: string;
    plan: RunPlan;
    workflow: WorkflowDefinition;
    inputs: Readonly<Record<string, unknown>>;
    executionMode: ExecutionMode;
    host: ExecutionHost;
    executor: NodeExecutor;
    bus: RunEventBus;
    capacity: number;
    onSettled: (runId: string) => void;
    /** The owning engine's lease identity (ADR-0079 §1). */
    ownerId: string;
    /** Builds a per-node effect journal from a run correlation (ADR-0080); absent ⇒ effects are refused. */
    effectJournal?: (correlation: EffectCorrelation) => EffectDispatchPort;
    effectResume?: EffectResumePort;
    resolverCapabilities: ResolverCapabilities;
    maxTokensEstimate?: number;
    /** The user-pricing overlay (2.5.G S10, ADR-0065 §2) — into the workflow PRE-EGRESS governor so a user-priced
     *  model is enforced by `budget`. Host-injected; the realized path rides the runner's own `resolvePrice`. */
    resolvePrice?: PricingOverlay;
    resolveEndpoint?: (provider: ProviderId) => EndpointKind;
    onUnpriced?: (
      model: string,
      capMicrocents: number,
      modalities?: readonly MediaBilledModality[],
    ) => void;
    onLegacyMediaJobHold?: (nodeIds: readonly string[]) => void;
    /** When present, the run is REHYDRATED from this checkpoint (resume) rather than started fresh (1.R). */
    checkpoint?: CheckpointState;
  }) {
    this.runId = params.runId;
    this.#plan = params.plan;
    this.#workflow = params.workflow;
    this.#inputs = params.inputs;
    this.#executionMode = params.executionMode;
    this.#host = params.host;
    this.#executor = params.executor;
    this.#resolverCapabilities = params.resolverCapabilities;
    this.#bus = params.bus;
    this.#onSettled = params.onSettled;
    this.#ownerId = params.ownerId;
    this.#effectJournal = params.effectJournal;
    this.#effectResume = params.effectResume;
    this.#abort = params.host.newAbortController();

    const secretNames = new Set(
      (params.workflow.workflow.inputs ?? [])
        .filter((input) => input.type === 'secret')
        .map((input) => input.name),
    );
    this.#secretInputNames = secretNames;
    this.#maskedInputs = maskInputs(params.inputs, secretNames);
    this.#maxTokensEstimate = params.maxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    this.#resolvePrice = params.resolvePrice;
    // UNCONDITIONAL, unlike the governor below (ADR-0077 §5). The conservative half is inherently
    // budget-scoped — no cap, nothing to reserve — but a run without a budget still spends real money, so a
    // ledger that only existed alongside a governor would silently skip every unbudgeted run. It fronts the
    // join for BOTH chains, so `flushConservative` is wired to the governor once that exists.
    this.#money = new MoneyDurability({
      emit: async (draft, cumulativeCostMicrocents) => {
        // **The observe half, and it has to be here rather than in `MoneyDurability`.** `#emitDurable` is
        // TOTAL for store faults: it absorbs a `persistEvent` rejection into `#failure` and RESOLVES. So the
        // ledger's own `.catch` never fires for the failure mode it exists to catch, and a barrier that only
        // awaited would sail straight past a run whose money write did not land — exactly the trap ADR-0076
        // §1 named and ADR-0077 kept. Comparing `#failure` across the await is what turns the absorbed fault
        // back into something the barrier can throw. It can over-trigger when a SIBLING fails in the same
        // window; that direction is fail-closed and correct at a money barrier.
        const failureBefore = this.#failure;
        await this.#emitDurable({
          ...draft,
          type: 'cost:attempt_settled',
          runId: this.runId,
          // The total CAPTURED AT `record()` TIME, passed in — deliberately not a fresh read of
          // `#cumulativeCostMicrocents` here. `#nodeEmit`'s `cost:updated` arm folds the charge into the
          // counter and the turn core records strictly after that, so the captured value satisfies
          // `refineCostAttemptSettled`'s "cumulative already includes this charge" by construction. Reading it
          // HERE would not: this callback is chained behind the previous write's `persistEvent`, so under a
          // `fan_out` — concurrent nodes sharing one chain — it can run after several more attempts have
          // settled and report their money as this attempt's running total.
          cumulativeCostMicrocents,
        });
        if (this.#failure !== failureBefore) {
          // Typed, not a bare `Error` (error-handling.md). `#emitDurable` discards the store error in its own
          // catch, so there is no `cause` left to preserve — the run's `#failure` carries the user-facing
          // reason instead, and this class exists to keep the node attribution that would otherwise be lost
          // when the chain flattens a `preAttempt` throw.
          throw new LedgerDurabilityError(
            new Error('the run failed while this realized charge was being made durable'),
            draft.nodeId,
          );
        }
      },
      ...(params.plan.budget === undefined
        ? {}
        : { flushConservative: async () => this.#budgetGovernor?.flushCommitments() }),
    });
    if (params.plan.budget !== undefined) {
      this.#budgetGovernor = new BudgetGovernor({
        budget: params.plan.budget,
        defaultMaxTokensEstimate: this.#maxTokensEstimate,
        emit: (draft) => this.#emitDurable({ ...draft, runId: this.runId }),
        ...(params.resolvePrice === undefined ? {} : { resolvePrice: params.resolvePrice }),
        ...(params.resolveEndpoint === undefined
          ? {}
          : { resolveEndpoint: params.resolveEndpoint }),
        ...(params.onUnpriced === undefined ? {} : { onUnpriced: params.onUnpriced }),
        ...(params.onLegacyMediaJobHold === undefined
          ? {}
          : { onLegacyMediaJobHold: params.onLegacyMediaJobHold }),
      });
      // ADR-0074 §3: an abort must ALWAYS be able to break the legacy-media-job hold. A `checkPreEgress`
      // suspended in it keeps its node counted as `running`, so `#step` never reaches `#countRunning() === 0`
      // and the run never emits a terminal — an unkillable run, which is strictly worse than the
      // under-reservation the hold prevents. The awaited job cannot rescue it either: its poll returns silently
      // once the signal is aborted. Registered ONCE here, so no future abort site can forget it.
      //
      // Covered at the ENGINE level since #W15-16 (`engine.test.ts`, "an abort always breaks the legacy
      // media-job hold"): a budgeted resume with a legacy media job AND a concurrent sibling, cancelled
      // mid-hold. Deleting this listener makes that test TIME OUT rather than fail an assertion — the run
      // never terminates, which is the defect stated exactly. The governor's own release stays pinned in
      // isolation by `budget-governor.test.ts`; this composition — unit-correct parts, untested together —
      // is what let the hang ship.
      this.#abort.signal.addEventListener('abort', () => {
        this.#budgetGovernor?.releaseAllLegacyMediaJobHolds();
      });
    }

    // **ADR-0085 §3 — one grace window, armed off the abort signal itself.** Registered here,
    // UNCONDITIONALLY, and both of those words are the decision. Here, because the listener above solved
    // this exact class once already and its comment says why: "registered ONCE here, so no future abort site
    // can forget it" — there are eleven `#abort.abort()` sites and a per-site arm is a per-site omission
    // waiting to happen. Unconditionally, because that sibling sits inside `plan.budget !== undefined` and
    // therefore never protects an unbudgeted run; this one bounds the CLASS, including causes nobody has
    // enumerated yet.
    //
    // What it bounds is the wait for the EXECUTOR, not the durability of the terminal. `NodeExecutor.execute`
    // returns an arbitrary promise (`node-executor.ts`), so an implementation that ignores `ctx.signal` and
    // never settles keeps its vertex `running`, `#step` never reaches `#countRunning() === 0`, and the run
    // has no terminal — forever. ADR-0036's Consequences call that "structurally impossible"; it was not,
    // and ADR-0085 §6 states which half stays conditional (a `RunStore` that never settles still hangs).
    this.#abort.signal.addEventListener('abort', () => {
      this.#armGraceWindow();
    });

    if (params.checkpoint === undefined) {
      for (const id of params.plan.vertices.keys()) {
        this.#states.set(id, { status: 'pending' });
      }
    } else {
      this.#seedFromCheckpoint(params.plan, params.checkpoint, params.bus, params.runId);
    }
    this.handle = createRunHandle(
      params.bus,
      params.runId,
      () => {
        // The handle's cancel is a best-effort surface action (e.g. a UI button): idempotent and safe
        // to call after the run has already terminated. The programmatic `engine.cancel(runId)` keeps
        // the strict contract (throws `run_already_terminal` on misuse).
        try {
          this.requestCancel();
        } catch (error) {
          if (!(error instanceof EngineStateError && error.code === 'run_already_terminal')) {
            throw error;
          }
        }
      },
      params.capacity,
      () => this.#terminalDurability,
      (close) => {
        this.#closeStream = close;
      },
    );
  }

  /**
   * Pin a node's produced media to content-addressed handles, so everything downstream holds bytes we own
   * (`CR-54`). Named for the OUTPUT, not for urls: `deInlineMedia` rewrites **every** in-flight carrier, so
   * a `base64` source becomes a handle here too. That is the wider (and correct) behaviour — the run scope
   * ends up durable-safe rather than half-pinned — but it is wider than "a url", and an author reading
   * `run.outputs.gen.image.source.data` sees a handle where inline bytes used to be.
   *
   * Bounded before it fetches. A node output can legally carry thousands of url parts inside
   * `SIZE_BOUNDS.nodeOutputBytes` (a url part serialises to well under a hundred bytes, and the size check
   * measures the POINTER), and each one would become its own multi-megabyte download that no admission
   * reserved and no `cost:updated` reported. The producer need not even be a provider: an authored
   * `transform` can fabricate a url media part, and so can an MCP tool result, which ADR-0088 treats as
   * hostile outright. So the count is refused up front rather than discovered as egress.
   *
   * With no `MediaStore` the value is returned unchanged and the emit choke point makes the refusal one
   * step later — duplicating that check here would only change WHICH error a media-bearing run without a
   * store reports. **With a store wired this IS the I3 gate**, simply running earlier than it used to: the
   * full `deInlineMedia` hard-fails on a raw buffer, a loose base64 source, an unknown source kind, an
   * unknown mimeType, and a url with no streaming hook. An earlier draft of this comment called it "not a
   * second I3 gate", which read as "this cannot fail" — and the ordering of its failure is exactly what
   * had to be got right.
   *
   * The overwhelmingly common case is a text output, which pays `deInlineMedia`'s cheap scan and returns
   * the same reference.
   */
  async #pinMediaOutput(outcome: NodeOutcome, nodeId: string): Promise<NodeOutcome> {
    if (outcome.kind !== 'completed') {
      return outcome;
    }
    return { ...outcome, output: await this.#pinMediaValue(outcome.output, nodeId) };
  }

  /**
   * The pin itself, over any value. Shared by the node-output path and the human-gate resume payload —
   * a gate payload is a first resolution too (a human uploads or a surface attaches media), and it takes
   * the one route into `#states` that does not pass through `#settleCompleted`.
   */
  async #pinMediaValue(value: unknown, nodeId: string): Promise<unknown> {
    const store = this.#host.mediaStore;
    if (store === undefined) {
      return value;
    }
    const unpinned = countUnpinnedMedia(value);
    if (unpinned > ADMISSION_CEILINGS.mediaPartsPerNodeOutput) {
      throw new NodeMediaPinError(
        `node \`${nodeId}\` produced ${unpinned} media parts to re-host, over its limit of ${ADMISSION_CEILINGS.mediaPartsPerNodeOutput}`,
        'validation',
      );
    }
    // The RUN-level backstop. The per-node ceiling bounds one output; a 50-wide `fan_out` at 32 parts each
    // is ~1,600 fetches in one graph layer, which is the multiplication ADR-0086 §4 exists to catch.
    if (this.#pinnedMediaParts + unpinned > ADMISSION_CEILINGS.mediaPartsPerRun) {
      throw new NodeMediaPinError(
        `this run has re-hosted ${this.#pinnedMediaParts} media parts and node \`${nodeId}\` adds ${unpinned}, over the run limit of ${ADMISSION_CEILINGS.mediaPartsPerRun}`,
        'validation',
      );
    }
    this.#pinnedMediaParts += unpinned;
    try {
      return await deInlineMedia(value, store, this.#mediaEgress());
    } catch (error) {
      // Classified HERE, where the cause is still legible. Left to escape, it reached `#onOutcome`'s bare
      // catch and became `the engine failed while settling a node` with NO `node:failed` at all — an
      // ordinary provider-CDN hiccup reported as an engine defect, on what is now the happy path of every
      // Gemini video generation. The three distinctions the user needs already exist one layer down; this
      // keeps them, and keeps the url itself out of the message (I3).
      throw NodeMediaPinError.from(error, nodeId, this.#abort.signal.aborted);
    }
  }

  // --- lifecycle ------------------------------------------------------------------------------

  async begin(): Promise<void> {
    this.#startEpochMs = Date.parse(this.#host.clock.now());
    this.#armRunTimeout();
    try {
      this.#workflowId = await this.#host.store.resolveWorkflowId(this.#workflow.workflow.id);
      await this.#emitDurable({
        type: 'run:started',
        runId: this.runId,
        workflowId: this.#workflowId,
        inputs: this.#maskedInputs,
        executionMode: this.#executionMode,
      });
      // **Ownership is taken right AFTER `run:started`, not before it — a deviation from ADR-0079 §3 that
      // the FK forced, recorded rather than quietly absorbed.** §3 said the lease row is created inside the
      // same transaction as the fold; `run_leases.run_id` references `runs.id`, and that row only exists
      // once `run:started` has folded, so an acquire before the first event fails the foreign key. Doing it
      // here keeps the store free of any lease coupling.
      //
      // The window it opens is a run that is durable and momentarily unowned. It is not reachable in
      // practice — the `runId` came from `ids.newId()` in the same tick and no other process has yet had a
      // chance to see it — and it is not harmful even if it were: a racing process would acquire first, our
      // acquire would be refused, and this run would fail before executing a single node. Refused, never
      // duplicated.
      if (!(await this.#acquireLease())) {
        // Name it. Without a `#failure` this settles on the generic default — `internal: "the run failed"` —
        // so a user whose `history.db` is locked, unmigrated or read-only saw every `relavium run` die with a
        // message pointing at nothing. The docblock above already diagnoses this case; the event should say
        // it too. Secret-free: no path, no store detail, just what could not be established.
        this.#failure = {
          error: {
            code: 'internal',
            message:
              'the run could not take ownership of its own id — the host run-lease port refused a fresh run',
            retryable: false,
          },
        };
        await this.#settle('run:failed');
        return;
      }
    } catch (error) {
      // Could not even start the run (e.g. the store rejected) — close with the single terminal event
      // rather than leaving a started-but-never-finished run. Never swallowed: it becomes run:failed.
      //
      // **Carry the breach's own message when there is one.** A `RunLoopInvariantError` here already knows
      // WHICH invariant broke and with what numbers — an oversized `run:started`, or a media-bearing draft
      // with no store — and discarding it leaves the generic "the run failed", which is the undiagnosable
      // report the lease branch thirty lines above was written to avoid. The code stays `internal` (the
      // taxonomy is closed and this is an engine-side fault); only the message gets more useful.
      if (error instanceof RunLoopInvariantError && this.#failure === undefined) {
        this.#failure = { error: { code: 'internal', message: error.message, retryable: false } };
      }
      await this.#settle('run:failed');
      return;
    }
    // Resolve the workflow `context:` once (eager-once `ctx.*`) before any node runs. A failure closes the
    // run loudly (run:failed) rather than running nodes against an empty/partial context (a mis-route risk).
    if (!(await this.#resolveContextOrFail())) {
      await this.#settle(this.#cancelling ? 'run:cancelled' : 'run:failed');
      return;
    }
    this.#schedule();
  }

  /**
   * Arm the run-level `timeout_ms` timer (ADR-0028). Idempotent: disarms any prior timer first. The
   * timer fires once and fails the run with `run_timeout` if it elapses before the run settles.
   */
  #armRunTimeout(): void {
    this.#disarmRunTimeout();
    const timeoutMs = this.#plan.timeoutMs;
    if (timeoutMs === undefined) {
      return;
    }
    // **The REMAINING time, not the full duration — `CR-22`.** `timeout_ms` is a bound on the run's total
    // wall-clock (ADR-0028), and this method is called on a fresh `begin()` AND on both resume paths. Arming
    // the full duration each time made the cap renew on every resume: a run crashed and resumed ten times got
    // ten times its authored budget, which is the opposite of a cap. The engine already holds everything the
    // fix needs — `#seedFromCheckpoint` restores `#startEpochMs` from the checkpoint's `startedAtMs`
    // (deliberately, so a resumed run's terminal reports total wall-clock), and both resume call sites arm
    // AFTER that seeding. So `#elapsedMs()` is the true pre-resume elapsed here, and nothing new is
    // persisted: the absolute deadline is derived, not stored a second time.
    //
    // A run whose budget is ALREADY exhausted when it resumes arms at zero rather than being refused: the
    // timer fires on the next tick and settles through the one `#onRunTimeout` path, so an expired resume and
    // an expiring live run produce the identical `run:timeout` + `run_timeout` terminal. Refusing it here
    // instead would be a second, differently-shaped exit for the same condition.
    // Clamped on BOTH sides, the same way the gate re-arm is. `#elapsedMs()` differences this process's
    // clock against `#startEpochMs`, which `#seedFromCheckpoint` seeds from ANOTHER process's `run:started`
    // timestamp — so a resuming clock running behind produces a negative elapsed and a remaining LARGER than
    // the authored cap. Measured at an hour of skew: a 60 000 ms cap re-armed at 3 660 000 ms, 61×. The gate
    // half had this clamp from the Step 3 review and the run half twenty-five lines away did not; same
    // exposure, same one-line fix, simply not carried across.
    const remainingMs = Math.max(0, Math.min(timeoutMs, timeoutMs - this.#elapsedMs()));
    this.#runTimeoutDisarm = armLongTimer(
      remainingMs,
      () => {
        void this.#onRunTimeout(timeoutMs);
      },
      (ms, fire) => this.#host.setTimer(ms, fire, 'work'),
    );
  }

  /**
   * Arm the post-abort grace window (ADR-0085 §3). Idempotent: the abort signal fires once, but `abort()` is
   * called from several sites and a re-entrant arm would double-count the window.
   */
  #armGraceWindow(): void {
    if (this.#graceDisarm !== undefined || this.#settled) {
      return;
    }
    this.#graceDisarm = this.#host.setTimer(
      GRACE_WINDOW_MS,
      () => {
        // Nothing may float out of a timer callback (the same rule `#step`'s `#dispatch` call site follows).
        // `#onGraceElapsed` is the last thing standing between a hung executor and a run with no terminal,
        // so it must not itself become the reason there is none: an unhandled rejection here is fatal under
        // Node's default `--unhandled-rejections=throw`, and it would kill the process mid-run rather than
        // settle it.
        void this.#onGraceElapsed().catch(() => {
          if (!this.#settled && this.#failure === undefined && !this.#cancelling) {
            this.#failure = {
              error: {
                code: 'internal',
                message: 'the grace-window backstop failed while abandoning the run',
                retryable: false,
              },
            };
          }
          this.#schedule();
        });
      },
      // A backstop over work already in flight, not something the run is parked ON — the same role
      // `CR-21b`/`CR-21c` gave the media bounds, and the reason `TimerKind` has a third member at all.
      'deadline',
    );
  }

  /**
   * Re-arm one rehydrated gate's deadline against its ABSOLUTE `expiresAt` (`CR-22`).
   *
   * Extracted from `#seedFromCheckpoint`, which the inline version pushed to a cognitive complexity of 18
   * against Sonar-Way's threshold of 15 — a nested conditional with a nested ternary inside a loop. The
   * seeding loop reads as a list of restorations again, and this reads as one decision.
   *
   * This was deferred for a long time on the reasoning that "the gate this resume targets has its decision
   * applied immediately" — true of the TARGET gate, and silent about every other one. A multi-gate run, or a
   * crash while parked, rehydrated its remaining gates with no timer at all, so their deadlines stopped
   * existing until the next restart. The data was already durable on `human_gate:paused`, whose schema says
   * it rides there for exactly this; only the fold and this arm were missing.
   */
  #reArmGateDeadline(gate: CheckpointPendingGate): void {
    if (gate.expiresAt === undefined || gate.timeoutAction === undefined) {
      return;
    }
    // Clamped on BOTH sides. `Math.max` stops a past deadline arming a negative duration; `Math.min` stops a
    // resuming process whose clock runs BEHIND the one that parked the gate from granting more patience than
    // the author wrote — measured at an hour of skew, a 1 000 ms gate re-armed at 3 601 000 ms. The authored
    // duration is the ceiling; the absolute instant is the target.
    const untilExpiryMs = Date.parse(gate.expiresAt) - Date.parse(this.#host.clock.now());
    const remainingMs = Math.max(
      0,
      gate.timeoutMs === undefined ? untilExpiryMs : Math.min(untilExpiryMs, gate.timeoutMs),
    );
    // A gate whose deadline has ALREADY passed arms at zero and fires on the next tick rather than being
    // resolved inline: the timeout then travels the one `#onGateTimeout` path, so a past-deadline resume and
    // a live expiry produce the identical events in the identical order.
    const action = gate.timeoutAction;
    const disarm = armLongTimer(
      remainingMs,
      () => {
        void this.#onGateTimeout(gate.gateId, gate.nodeId, action);
      },
      (ms, fire) => this.#host.setTimer(ms, fire, 'work'),
    );
    this.#gateTimers.set(gate.gateId, disarm);
  }

  #disarmGraceWindow(): void {
    if (this.#graceDisarm !== undefined) {
      this.#graceDisarm();
      this.#graceDisarm = undefined;
    }
  }

  /**
   * The grace window elapsed and the run has still not settled — stop waiting for the executor.
   *
   * Every vertex still `running` is settled `node:failed` FIRST, so the durable log has no `node:started`
   * without a partner (ADR-0085 §4) and `step_executions` stays consistent. The message is fixed text
   * rather than free prose because `cancelled` alone would read as "the user cancelled this node", when
   * what happened is that the engine stopped waiting.
   */
  async #onGraceElapsed(): Promise<void> {
    this.#graceDisarm = undefined;
    if (this.#settled) {
      return;
    }
    // **Latch FIRST, synchronously, before any await.** Clearing the tokens alone was not a cutoff: `#step`
    // awaits its `node:started` persist and then calls `#dispatch` without re-reading the run's state, so a
    // node claimed before the window elapsed could still START after it — a fresh token, an executor invoked
    // on an already-aborted signal, and a `cost:updated` accepted for work the run had stopped waiting for.
    this.#noNewDispatch = true;
    this.#activeDispatchByVertex.clear();
    // **The LIVE `keys()`, not a `[...]` snapshot.** `Map.prototype.delete` tombstones the entry in place —
    // it never splices the backing list — and the map iterator advances past the entry it has already
    // yielded, so deleting the one this loop is standing on skips nothing. Measured, not assumed. A snapshot
    // would differ only for an entry ADDED mid-loop, and there the live form is the SAFER one: it disarms
    // the late arrival instead of leaking a timer past the terminal.
    for (const vertexId of this.#nodeDeadlineDisarm.keys()) this.#disarmNodeDeadline(vertexId);
    for (const [vertexId, state] of this.#states) {
      if (state.status !== 'running') continue;
      const vertex = this.#plan.vertices.get(vertexId);
      if (vertex === undefined) continue;
      // Through `#settleFailed`, not a hand-rolled draft. A first version wrote the event inline and it
      // silently lost three things `#settleFailed` stamps: the secret-free `correlationId` that ADR-0036
      // calls the single producer-side translation point, the `cumulativeCostMicrocents` snapshot whose
      // schema comment says "the engine always populates it", and the real attempt number — it hard-coded
      // 1, so a node abandoned on attempt 3 logged attempt 1. An abandoned node's record is the ONLY record
      // it gets; making it the thinnest one in the log is the wrong place to economise.
      try {
        await this.#settleFailed(
          vertex,
          { code: 'cancelled', message: GRACE_ABANDON_MESSAGE, retryable: false },
          this.#lastAttemptByVertex.get(vertexId) ?? 1,
        );
      } catch {
        // **One vertex's terminal failing must not abandon the others.** `#settleFailed` is not the total
        // path its callers assume: `#emitDurable` absorbs store faults, but `#bus.next` — which stamps the
        // sequence number and Zod-parses the candidate — runs OUTSIDE that try, and so does
        // `this.#host.ids.newId()` in the draft. A throw from either used to abort this whole loop, leaving
        // every remaining abandoned node with no `node:failed` (the omission §4 forbids), skipping the
        // `#failure` fallback below, and skipping `#schedule()` — a run with no terminal at all, produced by
        // the very backstop whose job is to guarantee one.
        //
        // Continuing is safe and is what the invariant wants: `#settleFailed` sets `status = 'failed'` and
        // records `#failure` BEFORE it emits, both synchronously, so the vertex is already marked and the
        // run already has a cause. What is lost is one durable event that could not be written anyway.
      }
    }
    // If nothing set a cause, the run-level `timeout_ms` is what aborted us — say so rather than shipping a
    // terminal with an undefined reason (ADR-0085 §3).
    if (this.#failure === undefined && !this.#cancelling) {
      this.#failure = {
        error: {
          code: 'run_timeout',
          message: 'the run was aborted and its executors did not settle within the grace window',
          retryable: false,
        },
      };
    }
    this.#schedule();
  }

  #disarmRunTimeout(): void {
    if (this.#runTimeoutDisarm !== undefined) {
      this.#runTimeoutDisarm();
      this.#runTimeoutDisarm = undefined;
    }
  }

  async #onRunTimeout(timeoutMs: number): Promise<void> {
    if (this.#settled) {
      return;
    }
    this.#disarmRunTimeout();
    const elapsedMs = this.#elapsedMs();
    // **Decide and ABORT first; write the diagnostic second (ADR-0085 §3).** This was the other way round,
    // and the ordering was load-bearing in the wrong direction: `#emitDurable` awaits the store, so a store
    // that never settles meant the abort never fired — and the grace window below, which arms off the abort
    // signal, never armed either. The rescue path was defeated by the very stall it exists to rescue. The
    // `run:timeout` event is a RECORD of a decision already taken, so nothing is lost by writing it after.
    this.#failure = {
      error: {
        code: 'run_timeout',
        message: `the run exceeded its ${timeoutMs} ms timeout`,
        retryable: false,
      },
    };
    this.#abort.abort();
    await this.#emitDurable({
      type: 'run:timeout',
      runId: this.runId,
      elapsedMs,
      timeoutMs,
    });
    if (!this.#settled) {
      this.#schedule();
    }
  }

  /**
   * Resolve the workflow `context:` map into the frozen `ctx.*` namespace (the spec's eager-once context),
   * threaded to every node via {@link NodeExecContext.ctx}. Returns `false` on failure: a cancel mid-resolve
   * leaves `#failure` unset (the caller settles `run:cancelled`); any other resolution error sets a typed
   * `validation` `#failure` (the caller settles `run:failed`). Used by both a fresh start and a resume —
   * `ctx` is re-resolved on resume because it is deliberately NOT carried in the checkpoint.
   */
  async #resolveContextOrFail(): Promise<boolean> {
    try {
      this.#resolvedContext = await resolveContext(
        this.#workflow,
        this.#inputs,
        this.#resolverCapabilities,
        this.#abort.signal,
      );
      return true;
    } catch (error) {
      if (this.#cancelling || this.#abort.signal.aborted) {
        return false; // a cancel raced context resolution — settle as cancelled, not a validation failure
      }
      this.#failure = {
        error: {
          code: 'validation',
          message: error instanceof Error ? error.message : 'workflow context resolution failed',
          retryable: false,
        },
      };
      return false;
    }
  }

  /**
   * **The resume gate** ([ADR-0080](../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §2b,
   * [effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §4). Returns `true` when the
   * run may proceed; on `false` the caller settles it, and `#failure` already carries the reason.
   *
   * Runs on EVERY resume, before anything is scheduled — which is the point. A crashed effectful node has a
   * durable row saying an external effect may have landed; re-running it is the duplicate this whole item
   * exists to prevent. The registry's own `prepare` would refuse the colliding call a second time, but only
   * if the re-run happens to reach the same tool at the same slot with the same args: a model that answers
   * differently sails past it, and the run would complete "successfully" with an ambiguous real-world effect
   * left unresolved. The gate is what makes that impossible.
   *
   * **Only nodes that will actually re-run are read.** A node the checkpoint records as `completed`,
   * `failed` or `skipped` is never re-dispatched (`#seedFromCheckpoint`), so its rows are history, not a
   * blocker. Everything else — `pending`, and the `paused` node this resume is here to advance — is queried.
   *
   * **Tier 1 and 2 fall through to the same refusal as tier 3, deliberately.** §4's table says those
   * reconcile from an idempotency key or a receipt lookup, and no reconciler exists yet. Treating "we have
   * not built the reconciler" as "proceed" would be the fail-open this contract rejects; the refusal is
   * conservative and names the tier, so the follow-up is visible rather than silently assumed.
   */
  async #effectResumeGateOrFail(): Promise<boolean> {
    if (this.#effectResume === undefined) return true;
    let blocking: readonly UnresolvedEffect[];
    try {
      // ONE range scan for the whole run, not one query per node. That is faster on the resume critical
      // path, and it is also more correct: a node RENAMED between the crash and the resume leaves rows
      // under an id a per-node loop would never think to ask about, and an orphaned row should block.
      blocking = await this.#effectResume.unresolvedForRun(this.runId);
    } catch (error) {
      // A read that FAILS is not "nothing is blocking" — the same answer ADR-0075 gives for an unreadable
      // event log. Refusing on an unreadable journal is the only honest option: the alternative is resuming
      // a run whose external effects are unknown.
      this.#failure = {
        error: {
          code: 'effect_needs_attention',
          message: `the effect journal could not be read, so this run cannot be resumed safely: ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
        },
      };
      return false;
    }
    if (blocking.length === 0) return true;
    this.#failure = {
      error: {
        code: 'effect_needs_attention',
        message:
          `${String(blocking.length)} external effect(s) from a prior attempt are unresolved, so this run ` +
          `cannot continue without a human: ` +
          blocking
            .map((b) => `${b.nodeId}/${b.identity.toolId} (${b.state}, tier ${String(b.tier)})`)
            .join(', ') +
          `. Check the target before resolving them — resuming again re-enters this gate and stops here.`,
        retryable: false,
      },
    };
    return false;
  }

  /**
   * Rehydrate ONE parked media job (ADR-0045 §2-3, ADR-0074 §3) — extracted from `#seedFromCheckpoint` so that
   * method stays inside its complexity budget. The whole of §3's frozen-vs-legacy branch lives here.
   */
  #restoreParkedMediaJob(plan: RunPlan, cp: CheckpointState, job: CheckpointPendingMediaJob): void {
    const vertex = plan.vertices.get(job.nodeId);
    // The agent branch is the only one ever taken in practice — a media job is ALWAYS sourced from an agent
    // vertex (executeGenerativeMedia), so `generativeUnits` (which honors the authored count/duration_seconds,
    // matching the submit-side compute exactly) is the real path. The else is a defensive last resort for a
    // vertex that is missing or non-agent (an invariant violation, e.g. a workflow edited between processes);
    // there is no AgentNode to read, so the conservative per-modality DEFAULT is the only available estimate —
    // it never executes on a well-formed resume.
    // ADR-0074 §3: prefer the basis FROZEN at submit time. Re-deriving `units` from the workflow definition
    // means a node edited between processes silently changes the volume an accepted job was priced on; the
    // fallback below stays only for legacy rows written before §3.
    const units =
      job.units ??
      (vertex?.config.kind === 'agent'
        ? generativeUnits(job.modality, vertex.config.node)
        : DEFAULT_MEDIA_UNIT_ESTIMATE[job.modality]);
    // This provider job was accepted before the crash, so normal cap policy cannot retroactively refuse it.
    // Recreate only its reservation before poll scheduling; the eventual terminal media-cost event reconciles
    // it with the realized charge exactly as in the original process.
    //
    // With a frozen `acceptedCostMicrocents` there is NO pricing lookup: a user-price or catalog change between
    // submission and resume must not move a commitment the provider already accepted, in either direction. A
    // legacy row has no frozen amount, so it falls back to re-pricing — which §3 requires be handled
    // fail-closed rather than trusted.
    let admission: BudgetAdmission | undefined;
    if (job.acceptedCostMicrocents === undefined) {
      admission = this.#budgetGovernor?.reserveCommittedEgress(
        job.model,
        0,
        [{ modality: job.modality, units }],
        job.provider,
      );
      // The reservation above is a re-price from TODAY's catalog, so it may be lower than what the provider
      // will actually bill. Register the node as an unknown basis: with a cap configured the governor then
      // refuses NEW egress until this job settles, rather than admitting spend against headroom that may not
      // exist. It clears itself when the job reports its real charge.
      this.#budgetGovernor?.registerLegacyMediaJob(job.nodeId);
    } else {
      admission = this.#budgetGovernor?.reserveAcceptedCost(job.model, job.acceptedCostMicrocents);
    }
    this.#pendingMediaJobs.set(job.nodeId, {
      jobId: job.jobId,
      provider: job.provider,
      model: job.model,
      modality: job.modality,
      units,
      deadlineAt: job.deadlineAt,
      // Recompute elapsed-at-submit from the persisted `startedAt` against the ORIGINAL run start so a
      // completed re-attached job reports its full submit→done wall-clock `durationMs` (M2). `cp.startedAtMs`
      // is the same value seeded into `#startEpochMs` below.
      submittedAtMs: Date.parse(job.startedAt) - cp.startedAtMs,
      backoffMs: MEDIA_JOB_POLL_DEFAULTS.pollInitialMs,
      ...(admission === undefined ? {} : { admission }),
    });
    this.#armMediaPoll(job.nodeId);
  }

  /** Seed `#states` / `#pendingGates` / tallies / the bus sequence from a checkpoint (rehydration, 1.R). */
  #seedFromCheckpoint(plan: RunPlan, cp: CheckpointState, bus: RunEventBus, runId: string): void {
    for (const id of plan.vertices.keys()) {
      const node = cp.nodeStates.get(id);
      if (node === undefined) {
        // Never started, OR running at the crash → re-run from `pending` (the idempotency key bounds a
        // half-applied side effect; a settled node is never re-run).
        this.#states.set(id, { status: 'pending' });
        continue;
      }
      this.#states.set(id, {
        status: node.status,
        ...(node.output === undefined ? {} : { output: node.output }),
        ...(node.selectedTargets === undefined
          ? {}
          : { selectedTargets: new Set(node.selectedTargets) }),
      });
      // **`CR-32`'s state total is seeded, not restarted.** A resume rehydrates every settled node's output
      // into `#states` above — that memory is real and already held — so starting the counter at zero would
      // hand a resumed run the whole 4 MiB again on top of what it just restored. It is the same defect
      // `nodeDispatches` has its own seed for, one bound over.
      this.#workflowStateBytes += measureNodeOutput(id, node.output).bytes;
    }
    for (const gate of cp.pendingGates) {
      this.#pendingGates.set(gate.gateId, {
        vertexId: gate.nodeId,
        isBudgetGate: gate.isBudgetGate,
      });
      this.#reArmGateDeadline(gate);
    }
    // Re-seed totals BEFORE restoring submitted-job reservations: a committed job must reserve alongside the
    // checkpoint's known spend, and its reservation must exist before the first re-armed poll/schedule can run.
    this.#totalInputTokens = cp.totalInputTokens;
    this.#totalOutputTokens = cp.totalOutputTokens;
    // Seeded, not restarted: the cap counts the RUN. Restarting here would hand every resume a fresh 500,
    // which is the same defect that disqualified the in-memory retry counters from carrying this at all.
    this.#nodeDispatches = cp.nodeDispatches;
    this.#cumulativeCostMicrocents = cp.cumulativeCostMicrocents;
    this.#budgetGovernor?.updateCost(cp.cumulativeCostMicrocents);
    // ADR-0074 §2: BOTH totals restored before any resumed work is scheduled. Without the conservative half the
    // first post-resume pre-egress check projects against a cap that has forgotten money a provider may already
    // have billed — a crash would reopen a strict cap, which is the bypass ADR-0074 exists to close. It must
    // precede the `reserveCommittedEgress` loop below, whose admissions project against this total.
    this.#budgetGovernor?.restoreConservativeCost(cp.conservativeCostMicrocents);

    // Re-attach each parked async media job (MJ-1, ADR-0045 §3): re-register it + RE-ARM a poll of the
    // persisted opaque jobId. NEVER re-call generateMedia — the node is `'paused'` (applyMediaJobEvent set it),
    // not absent, so it is not re-run via the `'pending'` path; this overrides the checkpoint
    // running-at-crash-re-runs default for the async-media node specifically. `units` IS persisted on the event
    // since ADR-0074 §3; the node-config recompute (count/duration_seconds) below survives only as the LEGACY
    // fallback for rows written before it.
    // Unlike a gate (whose decision arrives externally), a media job has no external trigger — only the
    // engine's own re-poll advances it, so the re-arm is unconditional here. A past-deadline job is
    // short-circuited to a timeout by the first `#pollMediaJob` (which checks `now > deadlineAt`).
    for (const job of cp.pendingMediaJobs) {
      this.#restoreParkedMediaJob(plan, cp, job);
    }
    // Suppress a DUPLICATE `run:paused` on resume ONLY when the prior process actually announced one — i.e. the
    // checkpoint's runStatus is already `'paused'` (L2). In the CRASH-IN-WINDOW case (`media_job:submitted`
    // persisted but `run:paused` not — RUN_STATUS_BY_EVENT has no entry for `media_job:submitted`, so runStatus
    // stays `'running'`) the prior process never emitted `run:paused`, so the resumed process MUST emit it
    // (gap-free stream, ADR-0036) — leaving `#pauseEpisode` false here. A gate resume independently resets this
    // in `resume()`; `#clearMediaJob` resets it when a job settles — so a genuinely later pause still emits.
    if (cp.pendingMediaJobs.length > 0 && cp.runStatus === 'paused') {
      this.#pauseEpisode = true;
    }
    for (const gateId of cp.resolvedGateIds) {
      this.#resolvedGates.add(gateId);
    }
    // Post-resume events continue gap-free from the last persisted sequence number.
    bus.seedSequence(runId, cp.lastSequenceNumber + 1);
    // …and so does the append guard. Left at `-1` a resumed leg's first append would claim the log is empty
    // and the store would refuse it, so ADR-0078 §2's guard would break resume outright. The checkpoint's
    // `lastSequenceNumber` is read from the durable rows, which is exactly the belief the store will check.
    this.#lastAskedSequenceNumber = cp.lastSequenceNumber;
    // Keep measuring durationMs from the ORIGINAL start, so a resumed run's terminal reports total
    // wall-clock (pre- + post-resume), not just the post-resume segment. NO `run:started` is re-emitted —
    // it is already in the persisted log.
    this.#startEpochMs = cp.startedAtMs;
  }

  /**
   * Drive a rehydrated run (resume entry, 1.R). Order matters:
   * 1. Validate the gate FIRST (non-kick path) — an invalid resume request (`unknown_gate` /
   *    `run_not_paused`) throws BEFORE the side-effectful context resolution, so the caller drops the run
   *    from `#runs` rather than the run being terminally settled `run:failed` because context resolution
   *    happened to fail on a request that should simply have been rejected.
   * 2. Re-resolve the workflow `context:` — `ctx.*` is not carried in the checkpoint, so post-resume nodes
   *    need it freshly derived; a resolution failure closes the run loudly (vs running against an empty ctx).
   * 3. Drive: `gateAlreadyResolved` (the prior process already applied this gate's decision — a cross-process
   *    double-delivery) → kick the loop WITHOUT re-applying (no second `human_gate:resumed`); otherwise
   *    apply the decision via {@link resume}. The terminal-checkpoint case never reaches here (closed handle).
   */
  /** Adopt the fence the engine acquired on the resume path, and start heartbeating it (ADR-0079 §4). */
  adoptLease(fence: RunFence): void {
    void this.#acquireLease(fence);
  }

  async beginResume(
    gateId: string,
    decision: GateDecision,
    gateAlreadyResolved: boolean,
  ): Promise<void> {
    // #startEpochMs was seeded from the checkpoint in #seedFromCheckpoint (preserves total durationMs).
    this.#armRunTimeout();
    if (!gateAlreadyResolved) {
      this.#assertGatePending(gateId); // fail fast on a bad gateId, before any context side effect
    }
    // **Disarm THIS gate's timer synchronously, before any await — the decision has already arrived.**
    // `CR-22` re-arms a deadline for every rehydrated gate, and that is its point: a run resumed ten times
    // must not renew the patience its author granted. But the gate this resume TARGETS is different — its
    // decision was handed to `resumeFromCheckpoint` before the timer existed, which is exactly the case
    // `execution-model.md` covers with "a decision that arrives first disarms the timer".
    //
    // Without this line the two race, and a past-deadline gate arms at zero so the timer is already due.
    // The window is the two awaits below (`#resolveContextOrFail`, `#effectResumeGateOrFail`), which run
    // before `resume()` claims the gate, while `#onGateTimeout` still sees it pending. Measured: with a
    // macrotask inside that window and `timeout_action: approve`, a caller's explicit `rejected` was
    // recorded as `human_gate:resumed{decision:'approved', decidedBy:'timeout'}` — a human's refusal
    // rewritten as an approval attributed to a timer. Unreachable on today's synchronous better-sqlite3
    // CLI, where both awaits settle in microtasks; live the moment any of these `Promise`-typed seams does
    // real I/O, which is what Phase-2's Postgres `EffectResumePort` is.
    //
    // Idempotent, so the `gateAlreadyResolved` kick path takes it harmlessly. Every OTHER pending gate
    // keeps its re-armed deadline, which is what `CR-22` exists to restore.
    this.#disarmTimer(gateId);
    if (!(await this.#resolveContextOrFail())) {
      await this.#settle(this.#cancelling ? 'run:cancelled' : 'run:failed');
      return;
    }
    // AFTER context resolution and BEFORE the gate decision is applied. Applying a decision first would let
    // an approval spend money on a run the next line refuses anyway; refusing first would report a journal
    // problem for a run whose inputs do not even resolve.
    if (!(await this.#effectResumeGateOrFail())) {
      await this.#settle('run:failed');
      return;
    }
    if (gateAlreadyResolved) {
      this.#schedule();
    } else {
      await this.resume(gateId, decision, true);
    }
  }

  /**
   * Resume a run suspended ONLY on async media job(s) (1.AG Section D, ADR-0045 §3) — no gate decision. The
   * media jobs were already re-attached + re-armed by `#seedFromCheckpoint` (MJ-1); this just re-resolves the
   * workflow context (not checkpointed) and kicks the loop, which the armed poll timers then advance. A run
   * with no pending media job AND no pending gate is a misuse (`run_not_paused`).
   */
  async beginResumeMediaJobs(): Promise<void> {
    this.#armRunTimeout();
    if (this.#pendingMediaJobs.size === 0) {
      // A media-only resume REQUIRES a parked media job. A run parked ONLY on a human gate must be resumed via
      // the gate form (gateId + decision) — resuming it here would silently re-park it forever (no decision).
      throw new EngineStateError(
        'run_not_paused',
        'the run has no pending media job to re-attach (a gate-parked run resumes via gateId + decision)',
        { runId: this.runId },
      );
    }
    if (this.#pendingGates.size > 0) {
      // The run is parked on BOTH a media job AND a human gate (AG-A-FC-3) but the caller supplied no gate
      // decision (the media-only resume form). Re-attaching the media job alone would leave the gate
      // unresolved: after the job settles the run would silently re-park on the gate with no caller signal.
      // Reject the misuse eagerly — the caller must pass the gate's gateId + decision (which advances the gate
      // while `#seedFromCheckpoint` independently re-attaches the media job).
      throw new EngineStateError(
        'pending_gate_requires_decision',
        "the run is also parked on a human gate — resume with that gate's gateId + decision (a media-only resume cannot resolve it)",
        { runId: this.runId },
      );
    }
    if (!(await this.#resolveContextOrFail())) {
      await this.#settle(this.#cancelling ? 'run:cancelled' : 'run:failed');
      return;
    }
    // The media-only resume takes the SAME gate. A run parked on a media job can still have a crashed
    // effectful node elsewhere in the graph, and this path used to be the untested twin that skipped
    // every guard the gate form got.
    if (!(await this.#effectResumeGateOrFail())) {
      await this.#settle('run:failed');
      return;
    }
    this.#schedule();
  }

  /**
   * Tear down a half-initialized execution that is being REJECTED before it ever ran for the caller — an
   * invalid `resumeFromCheckpoint` form whose validation guard threw AFTER the constructor's
   * `#seedFromCheckpoint` armed the parked jobs' media-poll timers (and after `beginResume*` armed the
   * run-timeout). Disarm every armed timer + abort so NO orphaned poll later hits the provider for a run the
   * caller saw rejected (which would also let a natural retry double-attach the same opaque jobId). Emits
   * NOTHING and runs no terminal — it is an abandon, not a settle; the façade drops the execution from `#runs`.
   */
  abandon(): void {
    if (this.#settled) {
      return; // already torn down (a real settle ran) — idempotent
    }
    this.#settled = true; // any straggler timer callback now short-circuits on the #settled guard
    this.#abort.abort();
    this.#stopHeartbeat();
    for (const disarm of this.#gateTimers.values()) {
      disarm();
    }
    this.#gateTimers.clear();
    for (const disarm of this.#mediaJobTimers.values()) {
      disarm();
    }
    this.#mediaJobTimers.clear();
    // ADR-0074 §3: release every unknown-basis HOLD before dropping the jobs. A `checkPreEgress` awaiting a job
    // that will now never settle would hang forever — worse than either failing or admitting. This is the reason
    // the bulk paths cannot simply drop the map.
    for (const nodeId of this.#pendingMediaJobs.keys()) {
      this.#budgetGovernor?.clearLegacyMediaJob(nodeId);
    }
    this.#pendingMediaJobs.clear();
    this.#disarmRunTimeout();
  }

  requestCancel(): void {
    if (this.#settled) {
      throw new EngineStateError('run_already_terminal', 'the run has already terminated', {
        runId: this.runId,
      });
    }
    if (this.#cancelling) {
      return; // idempotent — cancelling already in progress
    }
    this.#cancelling = true;
    this.#abort.abort();
    this.#schedule();
  }

  /** The pending gate for `gateId`, or throw the typed misuse (`run_not_paused` / `unknown_gate`). */
  #assertGatePending(gateId: string): {
    readonly vertexId: string;
    readonly isBudgetGate: boolean;
  } {
    if (this.#pendingGates.size === 0) {
      throw new EngineStateError('run_not_paused', 'the run has no pending gate to resume', {
        runId: this.runId,
        gateId,
      });
    }
    const gate = this.#pendingGates.get(gateId);
    if (gate === undefined) {
      throw new EngineStateError('unknown_gate', 'no pending gate matches the supplied gateId', {
        runId: this.runId,
        gateId,
      });
    }
    return gate;
  }

  async resume(
    gateId: string,
    decision: GateDecision,
    /** Set by `beginResume`, which already ran the effect gate — see the note at the claim below. */
    alreadyGated = false,
  ): Promise<void> {
    if (this.#resolvedGates.has(gateId)) {
      // Idempotent: this gate's decision was already applied (a re-delivery / reconnect) — never advance
      // the run twice (execution-model.md §gate). Checked BEFORE #settled so a re-delivery after the run
      // completed is a no-op, not a `run_already_terminal` error.
      return;
    }
    if (this.#settled) {
      throw new EngineStateError('run_already_terminal', 'the run has already terminated', {
        runId: this.runId,
        gateId,
      });
    }
    // **The gate claim is taken SYNCHRONOUSLY, before any await.** Everything from the `#resolvedGates.has`
    // check above to this line used to be one synchronous block, and that is what made a duplicate
    // `resume()` — an IPC double-submit, a retried request, a double-clicked button — absorb into the
    // documented idempotent no-op. Inserting an `await` above the claim opened a microtask window in which
    // both callers passed the `has` check, one won, and the loser got an uncaught
    // `EngineStateError('run_not_paused')` instead. A review reproduced it with two concurrent `resume()`
    // calls and no journal wired at all: the mere fact that the gate check is `async` was enough.
    const gate = this.#assertGatePending(gateId);
    this.#resolvedGates.add(gateId);
    // …and only now, holding the claim, the effect gate. **`#pendingGates.delete` stays BELOW this await**,
    // and that ordering is load-bearing in the other direction: with the gate already removed, the idle
    // check that runs during the await window sees no runnable node AND no pending gate, and settles the
    // run `internal` — "run stalled with no runnable node". A mutation test caught it. The run must keep
    // looking parked until it is actually being advanced. **The in-process resume takes the SAME gate**, so
    // the docblock's "every resume" is true of all three entry points rather than of the two that happen to
    // go through a checkpoint. A budget approval resets the node's attempt to 1 and re-dispatches it FROM
    // THE START — a replay of its tool calls in this very process — and `agent-turn.ts`'s CR-95 guard is
    // what stops that becoming a duplicate today; a second, structural check at the same choke point does
    // not depend on that guard staying correct.
    //
    // `alreadyGated` is set by `beginResume`, which runs the same check before it applies the decision:
    // without it a checkpoint-based gate resume scanned twice, contradicting the "ONE range scan" the
    // method's own docblock promises.
    if (!alreadyGated && !(await this.#effectResumeGateOrFail())) {
      this.#pendingGates.delete(gateId); // it is not resumable past this refusal; do not leave it pending
      await this.#settle('run:failed');
      return;
    }
    this.#pendingGates.delete(gateId);
    this.#disarmTimer(gateId); // a decision arrived before the timeout — cancel the armed timer (1.Q)
    this.#pauseEpisode = false; // a later idle-with-gates re-emits run:paused for the remaining gates
    // Re-take ownership **only if the pause actually released it** (§4), because a parked run is not being
    // executed. This is the IN-PROCESS resume, so it is normally uncontended — but if another process
    // claimed the run while it was parked, that process owns it now and this one must not proceed.
    //
    // `#owned` is the precise question "did we give ownership up", and it has to be asked. A CROSS-process
    // resume arrives here already holding the lease `resumeFromCheckpoint` acquired before it read the
    // checkpoint, and `acquire` treats a same-owner call as a renewal that still BUMPS the generation — so re-acquiring there would move the fence out from under the engine's own in-flight
    // claim (stranding the outer release path on a stale generation) and arm a second heartbeat. That is the
    // A resumed execution is born `held` (`adoptLease`), so `parked` is false there and nothing bumps the
    // generation under the engine's own in-flight claim — the hazard `resumeFromCheckpoint`'s comment names
    // as the subtlest way to get this wrong. `#emitDurable` is the guarantee; this is the early, cheap check,
    // kept because `resume()` mutates gate state before its first write.
    if (this.#ownership === 'parked' && !(await this.#reclaim())) return;

    // A budget gate's two decisions (reject ⇒ a run-level budget failure; approve ⇒ continue the deferred
    // pre-egress call) resolve in #resolveBudgetGate; a `true` return means it owned this gate — then only
    // #schedule(). Kept out of line so resume()'s cognitive complexity stays in budget (sonar S3776).
    if (await this.#resolveBudgetGate(gate, decision)) {
      this.#schedule();
      return;
    }

    // Mark the gate vertex completed SYNCHRONOUSLY before the await — mirroring #settleCompleted — so a
    // concurrent #step (e.g. a sibling gate's timeout firing during this persist) never sees this gate as
    // still `paused` while it is already out of #pendingGates, which would mis-read the run as stalled.
    // PIN the payload's media before it enters the scope (`CR-54`). A gate payload is a first resolution
    // like any node output — a human uploads a file, a surface attaches one — and it took the one route
    // into `#states` that `#settleCompleted` does not cover, so without this the durable event said
    // "handle" while the running run held a url, and the two could resolve to different bytes.
    //
    // Before the status write, because the pin awaits and that write must stay on one tick with the emit
    // below. A throw here is fatal for the run but must still `#schedule()`: the gate is already out of
    // `#pendingGates` and its timer disarmed, so returning early would strand the run with no terminal.
    let gateOutput: unknown;
    try {
      gateOutput = await this.#pinMediaValue(
        decision.payload ?? { decision: decision.decision },
        gate.vertexId,
      );
    } catch (error) {
      this.#failGateResume(
        gate.vertexId,
        NodeMediaPinError.from(error, gate.vertexId, false).failure,
      );
      this.#schedule();
      return;
    }
    const state = this.#states.get(gate.vertexId);
    if (state !== undefined) {
      state.status = 'completed';
      state.output = gateOutput;
    }
    // **A gate payload is a node output and counts as one (`CR-32`).** It is caller-supplied — a human typed
    // or a surface uploaded it — so it is exactly the input a size bound is for, and it took the one path
    // into `#states` that did not pass through `#settleCompleted`. Leaving it out also made the totals
    // DIVERGE across a resume, since `#seedFromCheckpoint` counts every restored output including this one:
    // a run that gated twice would come back holding more state than it had ever been charged for.
    //
    // Counted rather than refused: the gate is already resolved and the vertex already marked completed by
    // the lines above, so refusing here would strand a resumed run mid-settle. The run-level total is what
    // catches an abusive payload, at the next node that tries to add to it.
    this.#workflowStateBytes += measureNodeOutput(gate.vertexId, gateOutput).bytes;
    this.#disarmNodeDeadline(gate.vertexId); // the gate vertex is terminal — its node bound ends here
    // The payload (a gate `input` value, `z.unknown()`) is the one resume event that can carry media. If
    // de-inline cannot make it durable-safe, the emit throws — but the gate is already resolved + the
    // vertex marked completed, so we must NOT skip #schedule() (that would strand the resumed run with no
    // terminal). Mirror #onOutcome: fail the run on the throw, and ALWAYS #schedule(). (The gate's media
    // output then surfaces at the terminal, where the #emitDurable terminal-strip keeps it byte-free.)
    try {
      await this.#emitDurable({
        type: 'human_gate:resumed',
        runId: this.runId,
        nodeId: gate.vertexId,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        // The PINNED payload — the same value the run scope now holds (`CR-54`). Emitting
        // `decision.payload` raw made the choke point re-fetch what had just been pinned, so one url was
        // fetched twice and the scope and the record could disagree about the bytes.
        ...(decision.payload === undefined ? {} : { payload: gateOutput }),
      });
    } catch {
      this.#failGateResume(gate.vertexId, {
        code: 'internal',
        message: 'the gate decision payload could not be made durable-safe',
        retryable: false,
      });
    }
    this.#schedule();
  }

  /**
   * Record a fatal failure of the gate-resume path, once, without stomping a cancel or an earlier cause.
   * Both of `resume()`'s failure arms — the media pin and the durable emit — go through here; each used to
   * inline the same three lines, and the pin arm has to be the one that does NOT strand the run.
   */
  #failGateResume(nodeId: string, error: NodeFailure): void {
    if (this.#failure === undefined && !this.#cancelling) {
      this.#failure = { nodeId, error };
      this.#abort.abort();
    }
  }

  /**
   * Apply a decision to a BUDGET gate (the pre-egress governor's pause). Returns `true` when `gate` was a
   * budget gate AND the decision was handled here (the caller then only {@link resume}-schedules); `false`
   * to fall through to the general completed-gate path. Both arms only persist — the schedule()/return is
   * the caller's. Split out of resume() to keep its cognitive complexity in budget (sonar S3776).
   */
  async #resolveBudgetGate(
    gate: { readonly vertexId: string; readonly isBudgetGate: boolean },
    decision: GateDecision,
  ): Promise<boolean> {
    if (!gate.isBudgetGate) {
      return false;
    }
    const state = this.#states.get(gate.vertexId);
    // A rejected budget gate is a run-level budget failure, not a completed gate vertex.
    if (decision.decision === 'rejected') {
      if (state !== undefined) {
        state.status = 'failed';
      }
      this.#disarmNodeDeadline(gate.vertexId);
      if (this.#failure === undefined && !this.#cancelling) {
        this.#failure = {
          nodeId: gate.vertexId,
          error: {
            code: 'budget_exceeded',
            message: 'the budget gate was rejected',
            retryable: false,
          },
        };
        this.#abort.abort();
      }
      await this.#emitDurable({
        type: 'human_gate:resumed',
        runId: this.runId,
        nodeId: gate.vertexId,
        decision: 'rejected',
        decidedBy: decision.decidedBy,
      });
      return true;
    }
    // An APPROVED budget gate must CONTINUE the deferred call (H3): the agent vertex paused pre-egress and
    // produced no output, so completing it with the decision payload would short-circuit the call. Instead
    // arm a one-shot pre-egress bypass for the vertex and re-dispatch it (reset to `pending` → `#claimReady`
    // re-claims it). The first dispatch did no egress, so re-running is idempotent. Per the maintainer
    // decision (continue the call, one-shot per RE-RUN — never per-LLM-call, which would re-pause and, since
    // re-dispatch re-runs the turn from scratch, loop forever): `#runAttempt` consumes the one-shot so this
    // ONE re-dispatched step runs to completion uncapped, then the cap re-arms for the next step. (A budget
    // pause raised MID-tool-loop still re-runs the earlier in-turn calls on resume — the same limitation as
    // "checkpoint/resume of a mid-tool-loop turn", deferred; the common first-call pause is exact.)
    if (decision.decision === 'approved') {
      this.#budgetApprovedVertices.add(gate.vertexId);
      if (state !== undefined) {
        state.status = 'pending';
      }
      await this.#emitDurable({
        type: 'human_gate:resumed',
        runId: this.runId,
        nodeId: gate.vertexId,
        decision: 'approved',
        decidedBy: decision.decidedBy,
      });
      return true;
    }
    // An 'input_provided' decision on a budget gate is not expected — fall through to the general path.
    return false;
  }

  // --- the scheduler --------------------------------------------------------------------------
  //
  // A single serialized loop drives the run. Every state change (a node settled, a gate resolved, a
  // cancel) calls `#schedule`, which runs one `#step` and re-runs if anything changed meanwhile. The
  // decision phase reads "is anything running?" from the vertex *statuses* (`#countRunning`), never a
  // separate counter that could desync across an `await` — and ready vertices are *claimed* (marked
  // `running`) synchronously in `#claimReady` before any await, so a terminal/pause/stall verdict is
  // never reached on a transiently-inconsistent view. This is what makes the exactly-one-terminal-event
  // invariant and skip-propagation robust against the interleaving of concurrent branch settlements.

  #schedule(): void {
    if (this.#scheduling) {
      this.#rerun = true; // a settlement landed while a step was in flight — re-evaluate after it
      return;
    }
    this.#scheduling = true;
    void this.#loop();
  }

  async #loop(): Promise<void> {
    try {
      do {
        this.#rerun = false;
        await this.#step();
      } while (this.#rerun && !this.#settled);
    } finally {
      this.#scheduling = false;
    }
  }

  async #step(): Promise<void> {
    if (this.#settled) {
      return;
    }
    // Emit a durable `node:skipped` for each vertex the loop just dimmed — BEFORE any terminal settle —
    // so the event log is a complete, replayable record (1.R reconstructs a skipped vertex from this).
    for (const { id, reason } of this.#propagateSkips()) {
      this.#disarmNodeDeadline(id); // a skipped node is terminal too — ADR-0085 §2's bound ends here
      await this.#emitDurable({ type: 'node:skipped', runId: this.runId, nodeId: id, reason });
    }
    const running = this.#countRunning();

    if (this.#cancelling) {
      if (running === 0) {
        await this.#settle('run:cancelled');
      }
      return;
    }
    if (this.#failure !== undefined) {
      if (running === 0) {
        await this.#settle('run:failed');
      }
      return;
    }
    if (this.#allSettled()) {
      await this.#settle('run:completed');
      return;
    }

    // **ADR-0086 §4's run-level dispatch cap, checked BEFORE anything is CLAIMED.** Placement is the whole
    // correctness of it: `#claimReady` marks a vertex `running` synchronously, so refusing after the claim
    // left those vertices running with no dispatch behind them — `#handleIdle` then saw work in flight
    // forever and the run never terminated. Measured: a 60 s test timeout, not a slow test.
    //
    // It is the backstop for the multiplication the per-value ceilings still permit — a 500-node graph whose
    // nodes each retry 10 times is 5000 attempts, every one a real provider call.
    if (this.#nodeDispatches >= ADMISSION_CEILINGS.nodeDispatchesPerRun && !this.#settled) {
      this.#failure = {
        error: {
          // `turn_limit` is the taxonomy's limit-family code, and the taxonomy carries an explicit
          // anti-widening precedent (ADR-0082 §9) — a run-level cap is the same family as a turn cap.
          code: 'turn_limit',
          message: `the run reached its limit of ${ADMISSION_CEILINGS.nodeDispatchesPerRun} node dispatches`,
          retryable: false,
        },
      };
      this.#abort.abort();
      // **Re-enter the loop, or the terminal waits on the grace deadline.** With nothing running, returning
      // here leaves `#step` with no reason to be called again — the abort alone does not schedule one — so
      // the run would sit until the grace window elapsed before `#handleIdle` could publish `run:failed`.
      this.#schedule();
      return; // decided; claiming anything now would dispatch work the run has already refused
    }
    // **Clamped by the remaining headroom, not only by `max_parallel`.** The cap is a per-DISPATCH bound and
    // `#claimReady` claims a whole batch synchronously, so a tick whose ready set straddles the boundary
    // used to drain in full before the next tick could refuse anything — measured at 512 `node:started`
    // events against a ceiling of 500, overshooting by the batch width (up to 64).
    //
    // Clamping the CLAIM rather than breaking the dispatch loop is the fix that works: a mid-loop bail would
    // leave the already-claimed remainder `running` with nothing behind it, which is the hang this file's
    // comment above records as a measured 60 s timeout.
    const headroom = Math.max(0, ADMISSION_CEILINGS.nodeDispatchesPerRun - this.#nodeDispatches);
    const ready = this.#claimReady(running, headroom);
    if (ready.length === 0) {
      await this.#handleIdle(running);
      return;
    }
    // The vertices are already marked `running` (claimed synchronously above), so these awaits cannot
    // make a later step see a transient "nothing running" view.
    for (const vertex of ready) {
      await this.handle.whenConsumersReady(); // coarse backpressure (no-drop)
      this.#nodeDispatches += 1;
      await this.#emitDurable({
        type: 'node:started',
        runId: this.runId,
        nodeId: vertex.id,
        nodeType: vertex.type,
      });
      // Re-read the latch AFTER the durable `node:started` write above: the grace window may have elapsed
      // while it was pending, and a dispatch started past the cutoff is exactly what the latch forbids.
      if (this.#noNewDispatch || this.#settled) {
        return;
      }
      // **A dispatch may never float its rejection (Medium 9).** `#dispatch` is `async`, so even a
      // SYNCHRONOUS fault before its `try` — a host whose `setTimer` throws, which `#armNodeDeadline` calls
      // outside it — surfaces as a rejected promise here. Un-caught that is an `unhandledRejection` AND a
      // terminal-less run: the node stays `running`, `#handleIdle` sees work in flight forever, and nothing
      // ever publishes `run:failed`. Route it to the same settle every other node failure takes.
      void this.#dispatch(vertex, 1).catch(async (cause: unknown) => {
        const message = `dispatch failed unexpectedly: ${cause instanceof Error ? cause.message : String(cause)}`;
        try {
          // The FULL settle, not just the in-memory flag: `#failNodeInternal` marks the state and aborts but
          // emits no `node:failed`, so the graph never publishes this node's terminal. Measured — with the
          // flag alone the run still hung.
          await this.#settleFailed(vertex, { code: 'internal', message, retryable: false });
        } catch {
          // The settle itself faulted (the same broken host can fault the abort path's own timer arm).
          // Fall back to the in-memory backstop — an aborted run still beats a hung one.
          this.#failNodeInternal(vertex, message);
        }
        this.#schedule();
      });
    }
  }

  /** Nothing was ready this step: while idle, pause if a gate pends, else stall loudly (invariant). */
  async #handleIdle(running: number): Promise<void> {
    if (running > 0) {
      return; // still executing — wait for the next settlement to re-evaluate
    }
    if (this.#pendingGates.size > 0 || this.#pendingMediaJobs.size > 0) {
      // Parked on a human gate AND/OR an async media job (1.AG Section D, MJ-1) — the run is PAUSED, not
      // stalled. A media-parked node is invisible to #claimReady (it claims only 'pending'), so without this
      // the run would fall through to the loud stall-fail below; the poll timer (live) or the
      // #seedFromCheckpoint re-attach (resume) advances it. Reuses the human-gate pause emit (ADR-0045 §2).
      await this.#emitPausedOnce();
      return;
    }
    // A valid DAG always makes progress while nothing runs and no gate is pending; reaching here is an
    // engine-invariant breach (e.g. a skip-propagation bug) — fail loudly, never hang.
    this.#failure = {
      error: { code: 'internal', message: 'run stalled with no runnable node', retryable: false },
    };
    this.#schedule();
  }

  /** Synchronously claim every dispatchable vertex (up to the cap), marking it `running`. */
  #claimReady(alreadyRunning: number, headroom = Number.POSITIVE_INFINITY): PlanVertex[] {
    // **An omitted `max_parallel` is 8, not Infinity (ADR-0086 §3).** `Infinity` is the one value at which a
    // concurrency cap governs nothing, and it was the default — so every workflow that did not think about
    // concurrency ran as wide as its graph. The number is a fixed constant on every machine; deriving it
    // from host capacity would break the spec's guarantee that a file runs identically on every surface.
    const cap = this.#plan.maxParallel ?? DEFAULT_MAX_PARALLEL;
    const claimed: PlanVertex[] = [];
    let running = alreadyRunning;
    for (const vertexId of this.#plan.order) {
      // Two independent bounds, and both must hold before a vertex is marked `running`: the authored
      // concurrency width, and the run's remaining dispatch headroom (ADR-0086 §4).
      if (running >= cap || claimed.length >= headroom) {
        break;
      }
      const vertex = this.#plan.vertices.get(vertexId);
      const state = this.#states.get(vertexId);
      if (vertex === undefined || state?.status !== 'pending') {
        continue;
      }
      if (!this.#allDepsSettled(vertex) || !this.#hasLiveEdge(vertex)) {
        continue;
      }
      state.status = 'running';
      claimed.push(vertex);
      running += 1;
    }
    return claimed;
  }

  /**
   * Open a vertex's dispatch: claim ADR-0085 §5's per-vertex fence slot, arm the authored node deadline, run
   * the retry loop, and release the slot only once the node is genuinely terminal.
   *
   * The retry semantics themselves live in `#dispatchLoop`, documented there. This method owns the two
   * things that must bracket the loop rather than live inside it, because both outlive an individual
   * dispatch: the fence identity and the node bound.
   */
  async #dispatch(vertex: PlanVertex, firstAttempt: number): Promise<void> {
    // **ADR-0085 §5's fence.** A monotonic id per dispatch, claiming this vertex's slot. A re-dispatch of the
    // SAME vertex replaces only this vertex's entry, so two parallel siblings never stale each other — which
    // a single run-wide "current generation" would have done, and is why §5 specifies a per-vertex map
    // rather than a counter.
    const dispatchId = (this.#nextDispatchId += 1);
    this.#activeDispatchByVertex.set(vertex.id, dispatchId);
    this.#dispatchIdForVertex.set(vertex.id, dispatchId);
    // **The node deadline is owned by the RUN, not by this call.** It is armed once for the vertex and
    // disarmed only at the node's TERMINAL — see `#armNodeDeadline`. A first version opened it here and
    // disposed it in this method's `finally`, which silently dropped the bound on every path where
    // `#dispatch` returns without the node being finished: a `media_job` park, a human-gate park and a
    // budget-approval park are all non-terminal outcomes. A node authored `timeout_ms: 1000` that parked on
    // a media job then ran under ADR-0045's thirty-minute job deadline instead, and its eventual failure
    // classified `provider_unavailable`/retryable rather than `run_timeout`/fatal.
    this.#armNodeDeadline(vertex);
    try {
      await this.#dispatchLoop(vertex, firstAttempt);
    } finally {
      // **Release the slot only if this dispatch is really finished with it.**
      //
      // Not released while the node is still non-terminal: after a cancel the grace window governs and
      // `#dispatchLoop` may still settle cooperatively, and after a park the node resumes later. Releasing
      // early un-fences a node that is legitimately live — its `cost:updated` fold and, worse, its `save_to`
      // write would be refused. `#onGraceElapsed` clears the map when it stops waiting, `#isLive`'s
      // `!#settled` half refuses anything after the terminal, and the ownership check below keeps a newer
      // dispatch's claim intact.
      const status = this.#states.get(vertex.id)?.status;
      const nodeFinished = status === 'completed' || status === 'failed' || status === 'skipped';
      if (nodeFinished && this.#activeDispatchByVertex.get(vertex.id) === dispatchId) {
        this.#activeDispatchByVertex.delete(vertex.id);
      }
    }
  }

  /**
   * Arm the authored `agent.timeout_ms` for a vertex, once per NODE (ADR-0085 §2).
   *
   * Idempotent by vertex: a re-dispatch after a park or a budget approval finds the timer already armed and
   * leaves it alone, which is what makes the bound absolute across attempts, re-dispatches AND parks rather
   * than merely across the attempts of one dispatch.
   *
   * **It survives the dispatch that armed it, and that is the whole correction.** `paused` and `media_job`
   * are outcomes, not node terminals; a deadline tied to the dispatch promise vanished at exactly the moment
   * a node started waiting on something slow.
   */
  #armNodeDeadline(vertex: PlanVertex): void {
    const timeoutMs = vertex.config.kind === 'agent' ? vertex.config.node.timeout_ms : undefined;
    if (timeoutMs === undefined || this.#nodeDeadlineDisarm.has(vertex.id)) {
      return;
    }
    // ONE clock read: two would lose a tick between them on a per-read clock, so a first dispatch would arm
    // `timeoutMs - 1` and a test asserting the authored value would be pinning an off-by-one.
    const nowMs = this.#elapsedMs();
    const startedAtMs = this.#nodeDeadlineStartMs.get(vertex.id) ?? nowMs;
    this.#nodeDeadlineStartMs.set(vertex.id, startedAtMs);
    const remainingMs = Math.max(0, timeoutMs - (nowMs - startedAtMs));
    this.#nodeDeadlineDisarm.set(
      vertex.id,
      armLongTimer(
        remainingMs,
        () => {
          void this.#onNodeDeadline(vertex, timeoutMs);
        },
        // A backstop over work already in flight — never something the run is parked ON.
        (ms, fire) => this.#host.setTimer(ms, fire, 'deadline'),
      ),
    );
  }

  /**
   * ADR-0085 §5's fence predicate: may a write from `dispatchId` on `vertexId` still be admitted?
   *
   * True only while the run has not settled AND this dispatch is still its vertex's active one. Both halves
   * are needed: `#settled` alone is one boolean on one path, and it cannot tell dispatch N of a vertex from
   * dispatch N+1 — which is exactly what a budget-approved re-dispatch produces.
   */
  #isLive(vertexId: string, dispatchId: number): boolean {
    return !this.#settled && this.#activeDispatchByVertex.get(vertexId) === dispatchId;
  }

  #disarmNodeDeadline(vertexId: string): void {
    const disarm = this.#nodeDeadlineDisarm.get(vertexId);
    if (disarm !== undefined) {
      disarm();
      this.#nodeDeadlineDisarm.delete(vertexId);
    }
  }

  /**
   * The authored node bound elapsed with the node still unfinished.
   *
   * **Ownership is dropped SYNCHRONOUSLY, before the failure is persisted.** A first version awaited
   * `#onOutcome` and only then released the dispatch id, so for the whole duration of that durable write the
   * timed-out executor's `ctx.emit` cost folds and `ctx.effects.prepare()` calls still passed `#isLive` — a
   * timeout boundary that was not an ownership cutoff. Invalidating first makes the two the same instant.
   */
  async #onNodeDeadline(vertex: PlanVertex, timeoutMs: number): Promise<void> {
    this.#nodeDeadlineDisarm.delete(vertex.id);
    const status = this.#states.get(vertex.id)?.status;
    if (this.#settled || status === 'completed' || status === 'failed' || status === 'skipped') {
      return; // the node finished first — nothing to bound
    }
    this.#activeDispatchByVertex.delete(vertex.id); // the cutoff, before any await
    await this.#onOutcome(
      vertex,
      {
        kind: 'failed',
        error: {
          code: 'run_timeout',
          message: `node '${vertex.id}' exceeded its ${String(timeoutMs)} ms timeout_ms`,
          retryable: false,
        },
      },
      this.#elapsedMs(),
      this.#lastAttemptByVertex.get(vertex.id) ?? 1,
    );
  }

  /**
   * Open the authored node deadline (`agent.timeout_ms`), or `undefined` when the node declares none.
   *
   * `run_timeout` / `retryable: false` is the classification, and it is not a new decision: `#failGateOnTimeout`
   * already settles the HUMAN GATE's authored `timeout_ms` with exactly that. Both are authored node-level
   * liveness bounds on the same schema; giving the agent node a different one would mean two `timeout_ms`
   * fields resolving two different ways, which no author would predict.
   */
  /**
   * **Fence point 4 (ADR-0085 §5): the effect journal, PER METHOD.**
   *
   * A blanket "refuse a stale write" here would resurrect the exact defect `PR83-04` fixed — a row stuck
   * `prepared` forever, swept by nothing, reported as `needs_attention` for an effect that actually
   * completed. So the three methods split:
   *
   * - `prepare` is **refused**. The effect has not left the process, and refusing it is the whole point: a
   *   dispatch the grace window abandoned must not start new external work.
   * - `settle` is **allowed**. The effect already left under a valid claim; refusing its receipt would leave
   *   a durable row lying about an effect that completed.
   * - `discard` is **allowed**, for the same reason — it releases a `prepared` claim on a proven
   *   non-dispatch, and refusing it strands the row exactly as refusing `settle` would.
   *
   * The refusal rejects rather than resolves, so a caller that ignores it cannot mistake a refusal for a
   * durable claim and dispatch anyway.
   */
  #fenceEffects(port: EffectDispatchPort, vertexId: string): EffectDispatchPort {
    const dispatchId = this.#dispatchIdForVertex.get(vertexId) ?? -1;
    // Delegated method-by-method rather than spread. `{...port}` copies OWN properties only, so a host that
    // implements `EffectDispatchPort` as a CLASS would arrive here with `settle` and `discard` undefined —
    // TypeScript's spread-type inference hides it, and both shipping implementations happen to be object
    // literals, so it would have been latent until the first class-based one.
    return {
      settle: (...args: Parameters<EffectDispatchPort['settle']>) => port.settle(...args),
      discard: (...args: Parameters<EffectDispatchPort['discard']>) => port.discard(...args),
      prepare: async (...args: Parameters<EffectDispatchPort['prepare']>) => {
        const refuse = (): never => {
          throw new EngineStateError(
            'run_already_terminal',
            'the run stopped waiting on this dispatch; no new effect may be prepared',
            { runId: this.runId },
          );
        };
        if (!this.#isLive(vertexId, dispatchId)) refuse();
        const verdict = await port.prepare(...args);
        // **Re-checked AFTER the await, and that is the whole point.** The journal write is I/O: the grace
        // window can elapse and the run can reach its terminal while it is in flight. A verdict computed
        // before the cutoff and returned after it would hand the caller a `proceed` for a run that has
        // stopped — and `registry.ts` dispatches the external effect on that verdict with no further check.
        // A check that only guards the entry to an async call guards nothing at its exit.
        if (!this.#isLive(vertexId, dispatchId)) refuse();
        return verdict;
      },
    };
  }

  /**
   * Run a vertex's attempts against its above-chain node-retry budget (1.S, ADR-0040). The vertex stays
   * `running` across the whole loop — including the backoff sleep — so it never frees its slot or lets the
   * run go idle mid-retry. Attempt 1's `node:started` was emitted by `#step`; this loop emits `node:started`
   * for each re-dispatch. A retryable failure within budget (and admitted by `retry_on`) emits a
   * non-terminal `node:retrying`, sleeps the backoff (abort-aware — cancel wins), and re-runs; any other
   * outcome (or an exhausted budget, or a fatal/`retry_on`-excluded failure) settles via `#onOutcome`.
   *
   * Trade-off: a node waiting out its backoff keeps occupying a `max_parallel` slot (it stays `running`), so
   * under a tight cap a long `backoff_ms` can serialize otherwise-ready sibling branches (ADR-0040 A.3 — keep
   * `backoff_ms` modest under a tight cap). Freeing the slot mid-backoff would re-introduce the idle race.
   */
  async #dispatchLoop(vertex: PlanVertex, firstAttempt: number): Promise<void> {
    const retry = this.#retryConfig(vertex);
    let attempt = firstAttempt;
    // The node holds its slot from the FIRST attempt's node:started; the terminal durationMs measures the
    // whole node (all attempts + backoffs), not just the final attempt — consistent with that first start.
    const startedAtMs = this.#elapsedMs();
    // Consume the budget-approval ONCE per node dispatch (H3): an approved over-budget re-dispatch AND all
    // its above-chain node-retry attempts (ADR-0040) share the one-shot bypass, so a transient failure on the
    // approved call does not re-pause the (still-over-budget) node on its very next retry.
    const budgetApproved = this.#budgetApprovedVertices.delete(vertex.id);
    for (;;) {
      this.#lastAttemptByVertex.set(vertex.id, attempt);
      const outcome = await this.#runAttempt(vertex, attempt, budgetApproved);
      // ADR-0074 §2's other barrier: "the enclosing turn completion waits for the commitment's durability
      // acknowledgement." A commitment made inside this attempt must be durable before the node reaches ANY
      // boundary — its terminal, or a `node:retrying` that will dispatch again. The governor's own barrier covers
      // the next pre-egress check; this covers the node boundary, which a crash could otherwise land inside with
      // a possibly-billed call recorded nowhere. Awaited (not fire-and-forget) so a failed write fails the node
      // loudly; the conservative amount keeps consuming capacity either way.
      await this.#joinMoneyDurability(vertex.id);
      const willRetry =
        outcome.kind === 'failed' &&
        !this.#settled &&
        !this.#cancelling &&
        // …and the run is not already failing/aborting. A sibling node's failure sets `#failure` and aborts
        // the signal WITHOUT setting `#cancelling`; without these two guards a doomed node would emit a
        // non-terminal `node:retrying` it never honours (the backoff then short-circuits to `node:failed`).
        this.#failure === undefined &&
        !this.#abort.signal.aborted &&
        this.#shouldRetry(retry, outcome.error, attempt);
      if (!willRetry || outcome.kind !== 'failed') {
        await this.#onOutcome(vertex, outcome, startedAtMs, attempt, budgetApproved);
        return;
      }
      // **The cap is checked BEFORE the promise and before the wait.** A run with no dispatch headroom cannot
      // honour a retry, so it must not announce one or sleep for one: `node:retrying` is a promise to the
      // consumer that another attempt is coming, and `backoff_ms` is schema-unbounded up to the 24 h clamp —
      // so checking afterwards meant a run could wait a full day to be refused, having told every surface it
      // was about to try again. Routed through `#onOutcome` so it takes the same settled-status guard and the
      // same terminal path every other outcome takes.
      if (this.#nodeDispatches >= ADMISSION_CEILINGS.nodeDispatchesPerRun) {
        await this.#onOutcome(
          vertex,
          {
            kind: 'failed',
            error: {
              code: 'turn_limit',
              message: `the run made ${this.#nodeDispatches} node dispatches, its limit of ${ADMISSION_CEILINGS.nodeDispatchesPerRun}`,
              retryable: false,
            },
          },
          startedAtMs,
          attempt,
        );
        return;
      }
      const delayMs = this.#backoffMs(retry, attempt);
      await this.#emitDurable({
        type: 'node:retrying',
        runId: this.runId,
        nodeId: vertex.id,
        attemptNumber: attempt,
        error: {
          code: outcome.error.code,
          message: outcome.error.message,
          retryable: outcome.error.retryable,
        },
        delayMs,
      });
      const sleptFully = await this.#abortableSleep(delayMs);
      if (this.#settled) {
        return; // the run settled (e.g. a sibling failure/cancel) while we waited — drop this re-dispatch
      }
      if (this.#cancelling || this.#abort.signal.aborted) {
        // A cancel / sibling-abort landed on the same tick the timer fully elapsed (so sleptFully was true
        // but the run is now ending) — settle this node's last failure rather than waste a re-dispatch.
        await this.#onOutcome(vertex, outcome, startedAtMs, attempt);
        return;
      }
      if (!sleptFully) {
        // The run's AbortSignal fired during the backoff — a cancel OR a sibling node's failure (which
        // aborts to stop other branches). Do not re-dispatch; settle this node's last failure. #settleFailed
        // honours precedence: it won't overwrite an already-set #failure (a sibling's root cause) nor set one
        // while cancelling — so the run closes as the sibling's run:failed, or run:cancelled, accordingly.
        await this.#onOutcome(vertex, outcome, startedAtMs, attempt);
        return;
      }
      attempt += 1;
      // The retry loop's own dispatch, counted by the same rule as a fresh one (ADR-0086 §4): one
      // `node:started`, one dispatch. The headroom was checked above, before anything was promised.
      this.#nodeDispatches += 1;
      await this.#emitDurable({
        type: 'node:started',
        runId: this.runId,
        nodeId: vertex.id,
        nodeType: vertex.type,
        attemptNumber: attempt,
      });
    }
  }

  /**
   * Build the pre-egress hook for this run, when a budget is configured. The hook is stateful:
   * it sees the run's current cumulative cost and may emit a re-armable `budget:warning` or throw
   * `BudgetExceededError` / `BudgetPauseError` for `fail` / `pause_for_approval`.
   */
  #makePreEgressHook(): import('./agent-turn.js').PreEgressHook | undefined {
    if (this.#budgetGovernor === undefined) {
      return undefined;
    }
    const governor = this.#budgetGovernor;
    // Pass the media-unit estimate (1.AF/D17) so the governor folds a per-modality media addend into the
    // projection; `outputModalities` rides the hook info for request-lowering/observability but the cost
    // calc needs only the units.
    return (info) =>
      governor.checkPreEgress(info.model, info.maxTokens, info.mediaUnitsEstimate, info.provider);
  }

  /** Run one attempt of a vertex; returns its outcome (an uncaught handler throw → a single `internal`). */
  async #runAttempt(
    vertex: PlanVertex,
    attemptNumber: number,
    budgetApproved: boolean,
  ): Promise<NodeOutcome> {
    // **CAPTURED, not re-read — ADR-0085 §5.** A first version had both fence points call
    // `#dispatchIdForVertex.get(vertex.id)` at write time, which compares a value against itself: `#dispatch`
    // writes the same id into both maps, so while any dispatch of the vertex is active the two sides are
    // equal by construction and the predicate degenerates to `!#settled && has(vertex)` — precisely the
    // "second boolean latch" §5 rejects, because it cannot tell dispatch N from N+1 and the budget-approved
    // re-dispatch produces exactly that. Measured: a stale `cost:updated` of 999 999 from dispatch N was
    // DELIVERED while N+1 was in flight. `#fenceEffects` had it right; these two did not.
    const dispatchId = this.#dispatchIdForVertex.get(vertex.id) ?? -1;
    try {
      // A just-approved budget gate skips the pre-egress check for the WHOLE approved re-dispatch — every
      // above-chain node-retry attempt of it (H3 × ADR-0040). `budgetApproved` is consumed ONCE per dispatch
      // in `#dispatch`, so the approved agent step (and its retries) run to completion uncapped; the next,
      // separate step re-arms the cap. Per-re-dispatch (not per-LLM-call) by design — a per-call bypass would
      // re-pause and, since re-dispatch re-runs the turn, loop forever (see the resume() approve branch).
      const preEgress = budgetApproved ? undefined : this.#makePreEgressHook();
      const ctx: NodeExecContext = {
        vertex,
        runOutputs: this.#completedOutputs(),
        inputs: this.#inputs,
        ctx: this.#resolvedContext,
        secretInputNames: this.#secretInputNames,
        toolPolicy: this.#workflow.workflow.tools ?? {},
        emit: (event) => {
          // **Fence point 2 (ADR-0085 §5): the cost DELIVERY, not the fold.** A straggler from an abandoned
          // dispatch must not push a `cost:updated` at subscribers after the terminal has already reported
          // the run total.
          //
          // **But the fold must still happen, and getting that wrong lost real money.** The counter is what
          // `TurnMoneyPort.record` stamps as `cumulativeCostMicrocents`, and
          // `refineCostAttemptSettled` rejects a row whose cumulative is below its own `costMicrocents`.
          // Refusing the fold left the counter behind, so a genuinely billed attempt produced
          // `cumulative 0 < cost 77` — rejected at the producer gate, which runs in `#bus.next` OUTSIDE
          // `#emitDurable`'s try, so it threw in the one place the design assumes it cannot and the durable
          // ledger row was lost entirely. ADR-0045 §5's local-only-cancel position and §5's own money table
          // both say a charge already incurred is recorded either way; the fold is how that stays true.
          const live = this.#isLive(vertex.id, dispatchId);
          if (!live && event.type !== 'cost:updated') {
            return;
          }
          this.#nodeEmit(event, live);
        },
        // **ADR-0036's producer-await, handed to the executor (`CR-30`).** The run's own consumer ceiling,
        // so an executor that streams thousands of token deltas between node boundaries throttles instead
        // of growing the buffer. `#step` still awaits it once per node — that call bounds the run loop
        // itself; this one bounds a single node's stream, which is the unbounded case.
        whenReady: () => this.handle.whenConsumersReady(),
        signal: this.#abort.signal,
        attemptNumber,
        ...(preEgress === undefined ? {} : { preEgress }),
        // Unconditional, unlike `preEgress` above — which `budgetApproved` deliberately drops for an approved
        // re-dispatch. The ledger must not be dropped with it: an approved node is the one the user just
        // authorised MORE money on, so it is the last place to stop recording what that money was.
        money: this.#money.turnPort(() => this.#cumulativeCostMicrocents),
        // The durable effect journal (ADR-0080), with the RUN correlation closed over. Only the run loop
        // knows the `runId` and the node-retry attempt — exactly the reasoning that puts the ledger here.
        // Absent when no host wired a journal, in which case the dispatch gets `unwiredEffectJournal()` and
        // an effect is REFUSED rather than silently unrecorded.
        ...(this.#effectJournal === undefined
          ? {}
          : {
              effects: this.#fenceEffects(
                this.#effectJournal({
                  kind: 'run',
                  runId: this.runId,
                  nodeId: vertex.id,
                  attempt: attemptNumber,
                }),
                vertex.id,
              ),
            }),
      };
      // PIN the produced output ONCE, here, before anything reads it (`CR-54`,
      // [ADR-0043](../../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md) §3).
      //
      // A url is not a value; it is a promise about a value the world is free to break — the same URL can
      // return different bytes, a different redirect, or a different DNS answer on the next fetch. Gemini's
      // video generation is the live producer: `pollMediaJob` returns `{ kind: 'url' }`.
      //
      // **The dispatch boundary is the only place one pin serves every reader.** Pinning inside the settle
      // instead (the first version) left `save_to` to de-inline the RAW outcome on its own — so a drifting
      // url was fetched twice, the file written to the user's disk came from fetch #1 and the handle in the
      // durable record from fetch #2, and the run reported `run:completed` over two different objects. That
      // is the very defect `CR-54` exists to close, landing on the one path with a user-visible deliverable.
      // One pin here means `save_to`, the run scope, the durable event, every later reader and a resume all
      // see one handle for one fetch.
      //
      // It is also the only place the pin can await safely: a throw is classified by this method's own
      // catch, and the settle path stays synchronous from its size checks through its status write.
      const produced = await this.#pinMediaOutput(await this.#executor.execute(ctx), vertex.id);
      // After the executor completes, an `output` node with `save_to` writes its produced media to the
      // host (1.AF/D16). A write failure FAILS the node (→ run:failed) — save_to is a real deliverable.
      return await this.#applySaveTo(vertex, produced, dispatchId);
    } catch (error) {
      // A money-durability failure is NOT an anonymous handler throw. Barriers B1 and B2 (ADR-0077) both sit
      // INSIDE the turn, and `throwMappedChainError` has two arms whose only job is to keep the class and its
      // owning `nodeId` intact on the way out — under a `fan_out` the broken write may be a sibling's, and
      // the message that names the remedy differs between the estimate and realized halves. Then
      // `turnOutcomeForError` re-throws anything it cannot classify and the generic arm below reported `the
      // node handler threw an unexpected error`: preserved for exactly one frame, then discarded. B3 two
      // lines later cannot repair it either — `join()` surfaces a retained failure exactly ONCE, and the
      // in-turn barrier already consumed it.
      //
      // **When this arm is actually reached, stated because measuring it corrected a claim.** On the ordinary
      // path it is NOT: `#emitDurable` absorbs the store fault, sets `#failure` and aborts, so the turn ends
      // at `throwIfAborted` and the node classifies as cancelled before any barrier throws. It is reached
      // where the abort does not fire — `#emitDurable` skips it when `#failure` is already set by a sibling —
      // which is precisely ADR-0077's stated required regression, still unbuilt. The arm is here because the
      // flattening is wrong whenever it does happen, not because a test drives it today.
      if (isLedgerDurabilityError(error) || error instanceof CommitmentDurabilityError) {
        this.#failMoneyDurability(error, vertex.id);
        return {
          kind: 'failed',
          error: {
            code: 'internal',
            message: this.#failure?.error.message ?? 'a money write could not be made durable',
            retryable: false,
          },
        };
      }
      // A media-pin failure carries its own classification and a message that names WHICH of the three
      // things went wrong — a refused/oversized url, a transient network fault, or a cancel. Left to the
      // catch-all below it became `internal` / "the node handler threw an unexpected error", which is the
      // wrong shape twice over: a provider CDN hiccup is not an engine defect, and a transient failure
      // reported as non-retryable never gets the retry it deserves.
      if (error instanceof NodeMediaPinError) {
        return { kind: 'failed', error: error.failure };
      }
      // The catch-all: any uncaught throw from a node handler maps to a single internal failure
      // (a tool handler classifies its own failures as tool_failed; a sandbox throw as sandbox_error).
      return {
        kind: 'failed',
        error: {
          code: 'internal',
          message: 'the node handler threw an unexpected error',
          retryable: false,
        },
      };
    }
  }

  /** The above-chain retry budget for a vertex (ADR-0040): `node.retry`, defaulting an agent's `agent.retry`;
   *  `condition`/`transform`/`fan_in` carry their own; other types have none. */
  #retryConfig(vertex: PlanVertex): Retry | undefined {
    const config = vertex.config;
    switch (config.kind) {
      case 'agent':
        return config.node.retry ?? config.resolvedAgent?.retry;
      case 'condition':
      case 'transform':
      case 'fan_in':
        return config.node.retry;
      default:
        return undefined;
    }
  }

  /** Whether to re-dispatch after a failed attempt: a budget exists, the failure is retryable, attempts
   *  remain (`attempt < max`, where `max` is total attempts incl. the first), and `retry_on` admits the code. */
  #shouldRetry(retry: Retry | undefined, error: NodeFailure, attempt: number): boolean {
    if (retry === undefined || !error.retryable || attempt >= retry.max) {
      return false;
    }
    // `retry_on` narrows which codes consume the budget; absent ⇒ the canonical retryable set. Gating the
    // absent case on RETRYABLE_ERROR_CODES too is defence-in-depth: the engine never re-dispatches a
    // non-transient code even if a future executor mis-sets `retryable: true` on, say, an `internal` failure.
    // Widen to `readonly string[]` (a safe widening, no cast) so `.includes` accepts the wider ErrorCode.
    const allowed: readonly string[] = retry.retry_on ?? RETRYABLE_ERROR_CODES;
    return allowed.includes(error.code);
  }

  /** The backoff delay before the retry after `attempt` (1-based retry index = `attempt`): `linear` ⇒
   *  `base * attempt`; `exponential` ⇒ `base * 2^(attempt-1)`. No jitter (deterministic replay). Capped at
   *  {@link MAX_NODE_RETRY_BACKOFF_MS} so a large (schema-valid) `max` can never overflow `delayMs` past the
   *  event schema's integer range (which would throw at stamp time) or arm an absurd one-shot timer. */
  #backoffMs(retry: Retry | undefined, attempt: number): number {
    const base = retry?.backoff_ms ?? DEFAULT_NODE_RETRY_BACKOFF_MS;
    const raw = retry?.backoff === 'exponential' ? base * 2 ** (attempt - 1) : base * attempt;
    return Math.min(raw, MAX_NODE_RETRY_BACKOFF_MS);
  }

  /** Sleep `ms` via the injected one-shot timer; resolves `true` if it elapsed, `false` if the run's
   *  `AbortSignal` fired first (cancel disarms the pending retry — ADR-0040 A.5). */
  #abortableSleep(ms: number): Promise<boolean> {
    if (this.#abort.signal.aborted) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const cleanup = (): void => {
        this.#abort.signal.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        disarm();
        cleanup();
        resolve(false);
      };
      const disarm = this.#host.setTimer(ms, () => {
        cleanup();
        resolve(true);
      });
      this.#abort.signal.addEventListener('abort', onAbort);
    });
  }

  async #onOutcome(
    vertex: PlanVertex,
    outcome: NodeOutcome,
    startedAtMs: number,
    attemptNumber = 1,
    /** H3's one-shot cap bypass was active for this dispatch — so NO pre-egress hook ran (ADR-0074 §3). */
    budgetApproved = false,
  ): Promise<void> {
    if (this.#settled) {
      return; // terminal already emitted — ignore a late settle (e.g. an aborted straggler)
    }
    // **Fence point 1 (ADR-0085 §5), and the predicate is the vertex's own STATUS, not the dispatch token.**
    // `#settled` alone does not cover the window this item created: a node whose `timeout_ms` tripped is
    // settled `failed` by `#onNodeDeadline` while `#dispatchLoop` keeps running beside a live sibling, so
    // its eventual outcome reaches here on a run that has NOT settled and would overwrite the timeout with a
    // `completed` — a node reporting success for work the engine already told the user had timed out.
    //
    // **The dispatch token is the wrong test here, and it is not merely wrong — it is unavailable.** An
    // earlier version of this comment blamed `#dispatch`'s `finally` releasing the slot on a park; that
    // stopped being true when the release was narrowed to a node TERMINAL (see `#dispatch`). Three reasons
    // survive, and none of them is about slot release:
    //
    //   1. `#onOutcome` is re-entered OUT OF BAND from three sites that hold no dispatch id at all —
    //      `#onNodeDeadline`, `#settleMediaJobDone`, and the media-job failure path. There is no token to
    //      compare, so the predicate could not even be written there.
    //   2. A cross-process resume rehydrates a parked media job (`#restoreParkedMediaJob`) into a NEW
    //      `RunExecution` whose `#activeDispatchByVertex` never held that vertex — `#dispatch` is the only
    //      writer. A token check would refuse every resumed job's completion.
    //   3. After `#onGraceElapsed` clears the map, an abandoned node's `cancelled` outcome must still land
    //      here: ADR-0085 §4 requires the node terminal, and §8.16 records what refusing it costs.
    //
    // The honest predicate is that a vertex which already reached a TERMINAL node status has had its
    // outcome; `paused` and `running` have not.
    const settledStatus = this.#states.get(vertex.id)?.status;
    if (
      settledStatus === 'completed' ||
      settledStatus === 'failed' ||
      settledStatus === 'skipped'
    ) {
      return;
    }
    try {
      switch (outcome.kind) {
        case 'completed':
        case 'branch':
          await this.#settleCompleted(vertex, outcome, startedAtMs, attemptNumber);
          break;
        case 'failed':
          await this.#settleFailed(vertex, outcome.error, attemptNumber);
          break;
        case 'paused':
          await this.#settlePaused(vertex, outcome.gate);
          break;
        case 'media_job':
          await this.#settleMediaJobParked(vertex, outcome.job, budgetApproved);
          break;
      }
    } catch {
      // Backstop while settling a node: a bus/Zod stamp failure on a malformed event, OR — by design — a
      // media de-inline failure re-thrown by #emitDurable for a NON-terminal media-bearing node output (an
      // un-re-hosted url, a non-canonical byte carrier, a missing/erroring MediaStore). Both map to a single
      // run:failed here. (A durable PERSIST rejection still never reaches here: #emitDurable absorbs persist
      // faults and self-schedules; only the de-inline transform re-throws, and only for non-terminal events.)
      this.#failNodeInternal(vertex, 'the engine failed while settling a node');
    }
    this.#schedule();
  }

  /** A `completed` / `branch` outcome: record output (+ selected branches), tally tokens, emit. */
  async #settleCompleted(
    vertex: PlanVertex,
    outcome: Extract<NodeOutcome, { kind: 'completed' | 'branch' }>,
    startedAtMs: number,
    attemptNumber = 1,
  ): Promise<void> {
    // Update status SYNCHRONOUSLY before emitting, so `#countRunning` is consistent the instant this
    // vertex settles — a concurrent step never sees it as still running.
    // **`CR-32`'s bounds, checked BEFORE the output is retained or emitted.** Retaining first would put the
    // oversized value in `#states` for the rest of the run — the memory this bound exists to refuse — and
    // emitting first would hand it to the store. A breach fails the NODE, which is what makes it safe: the
    // failure is itself a terminal, so a size rule can never leave a run unable to end.
    //
    // Rejection rather than truncation, unlike the tool-result bound: half a node's output silently flowing
    // into the next node's template is a wrong answer that looks like a right one.
    const measured = measureNodeOutput(vertex.id, outcome.output);
    const stateBreach =
      measured.breach === undefined
        ? measureWorkflowState(this.#workflowStateBytes + measured.bytes)
        : undefined;
    const breach = measured.breach ?? stateBreach;
    if (breach !== undefined) {
      await this.#settleFailed(
        vertex,
        { code: 'validation', message: describeBreach(breach), retryable: false },
        attemptNumber,
      );
      return;
    }
    this.#workflowStateBytes += measured.bytes;

    // `outcome.output` arrives ALREADY PINNED — `#pinMediaOutput` ran at the dispatch boundary, before
    // `save_to` and before this method (`CR-54`). Nothing here awaits, which is what keeps the status write
    // below on the same tick as the checks above: an `await` between them left the vertex `running` for the
    // length of a network fetch, and both the node-deadline guard and `#onOutcome`'s re-entrancy guard read
    // that status — so a deadline firing mid-pin produced `node:failed` AND `node:completed` for one node,
    // reopening exactly the window ADR-0085 §5 closed.
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'completed';
      state.output = outcome.output;
      if (outcome.kind === 'branch') {
        state.selectedTargets = new Set(outcome.selected);
      }
    }
    const tokens: TokensUsed = outcome.tokensUsed ?? { input: 0, output: 0 };
    this.#totalInputTokens += tokens.input;
    this.#totalOutputTokens += tokens.output;
    await this.#emitDurable({
      type: 'node:completed',
      runId: this.runId,
      nodeId: vertex.id,
      // The same pinned value the run scope holds — see the note above.
      output: outcome.output,
      tokensUsed: tokens,
      durationMs: Math.max(0, this.#elapsedMs() - startedAtMs),
      // Snapshot the run-wide cost running total onto the durable boundary so cross-process resume can
      // restore it (1.R) — cost:updated is streamed, not persisted. By here #cumulativeCostMicrocents
      // already includes this node's cost (its cost:updated fired during execution, before this boundary).
      cumulativeCostMicrocents: this.#cumulativeCostMicrocents,
      // A condition's branch selection — persisted so resume can restore `selectedTargets` (1.R).
      ...(outcome.kind === 'branch' ? { selected: [...outcome.selected] } : {}),
      // Which attempt produced the output, when a node-retry recovered (1.S) — absent ⇒ attempt 1.
      ...(attemptNumber > 1 ? { attemptNumber } : {}),
    });
  }

  /** A `failed` outcome (terminal — the node-retry budget is exhausted or the failure is fatal): record the
   *  root cause (cancel wins), then emit the single terminal `node:failed`. */
  async #settleFailed(vertex: PlanVertex, error: NodeFailure, attemptNumber = 1): Promise<void> {
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'failed';
    }
    // First failure is the root cause; cancel wins, so do not set #failure while cancelling.
    if (this.#failure === undefined && !this.#cancelling) {
      this.#failure = { nodeId: vertex.id, error };
      this.#abort.abort(); // cooperatively cancel sibling branches
    }
    await this.#emitDurable({
      type: 'node:failed',
      runId: this.runId,
      nodeId: vertex.id,
      // Stamp a secret-free correlation id at this single translation point (ADR-0036) so a surface
      // can quote it and it joins to the structured internal log.
      error: { ...error, correlationId: this.#host.ids.newId() },
      ...(attemptNumber > 1 ? { attemptNumber } : {}),
      // Snapshot the run-wide cost AT this node boundary onto the durable terminal (2.S/D-GC, ADR-0045 §5):
      // a billed-but-failed PAID media job folded its realized cost into the running total via cost:updated
      // (transient) — persisting it here keeps that fail-cost durable. Mirrors node:completed.
      cumulativeCostMicrocents: this.#cumulativeCostMicrocents,
    });
  }

  /** A `paused` outcome: park the gate, arm its timeout timer (1.Q), and emit `human_gate:paused`. */
  async #settlePaused(vertex: PlanVertex, gate: GateRequest): Promise<void> {
    const gateId = gate.gateId ?? this.#host.ids.newId();
    const isBudgetGate = gate.isBudgetGate === true;
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'paused';
    }
    this.#pendingGates.set(gateId, { vertexId: vertex.id, isBudgetGate });
    // Compute the wall-clock deadline from the host clock (the handler has none) and arm a one-shot timer
    // (1.Q). On fire, an `approve` action auto-resolves the gate; a `reject` (the safe default) fails the
    // run with run_timeout. The timer is disarmed on resume / terminal settle so it never fires twice.
    // The EFFECTIVE on-timeout policy (default the safe `reject`) — used for BOTH the armed timer and the
    // emitted event, so the persisted `human_gate:paused` always carries the exact policy the engine acts
    // on (even when a handler set timeoutMs but left timeoutAction implicit). A Phase-2 crash-resume reads
    // it back to re-arm. `undefined` only when no timeout is configured.
    const effectiveAction =
      gate.timeoutMs === undefined ? undefined : (gate.timeoutAction ?? 'reject');
    const expiresAt =
      gate.expiresAt ??
      (gate.timeoutMs === undefined
        ? undefined
        : new Date(Date.parse(this.#host.clock.now()) + gate.timeoutMs).toISOString());
    if (gate.timeoutMs !== undefined && effectiveAction !== undefined) {
      const disarm = armLongTimer(
        gate.timeoutMs,
        () => {
          void this.#onGateTimeout(gateId, vertex.id, effectiveAction);
        },
        (ms, fire) => this.#host.setTimer(ms, fire, 'work'),
      );
      this.#gateTimers.set(gateId, disarm);
    }
    if (gate.spentMicrocents !== undefined && gate.limitMicrocents !== undefined) {
      await this.#emitDurable({
        type: 'budget:paused',
        runId: this.runId,
        nodeId: vertex.id,
        gateId,
        spentMicrocents: gate.spentMicrocents,
        limitMicrocents: gate.limitMicrocents,
      });
    }
    await this.#emitDurable({
      type: 'human_gate:paused',
      runId: this.runId,
      nodeId: vertex.id,
      gateId,
      gateType: gate.gateType,
      message: gate.message,
      ...(gate.assignee === undefined ? {} : { assignee: gate.assignee }),
      ...(gate.timeoutMs === undefined ? {} : { timeoutMs: gate.timeoutMs }),
      ...(effectiveAction === undefined ? {} : { timeoutAction: effectiveAction }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
  }

  /** Disarm and forget a gate's timeout timer (idempotent — safe if absent or already fired). */
  #disarmTimer(gateId: string): void {
    const disarm = this.#gateTimers.get(gateId);
    if (disarm !== undefined) {
      this.#gateTimers.delete(gateId);
      disarm();
    }
  }

  // --- Async media-job loop (1.AG Section D, ADR-0045) -----------------------------------------

  /**
   * A `media_job` outcome (ADR-0045 §2/§3): park the node for the engine-owned poll loop. Set status
   * `'paused'` (slot-free, like a gate — keyed by nodeId, the AG-A-FC-3 disambiguator vs `#pendingGates`),
   * record the job, emit the durable `media_job:submitted`, and arm the first poll. The realized cost is
   * emitted by the poll loop at `done`, NEVER here (§5).
   */
  async #settleMediaJobParked(
    vertex: PlanVertex,
    job: MediaJobSubmission,
    budgetApproved = false,
  ): Promise<void> {
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'paused';
    }
    const startedAt = this.#host.clock.now();
    const deadlineAt = new Date(
      Date.parse(startedAt) + (job.deadlineMs ?? MEDIA_JOB_POLL_DEFAULTS.deadlineMs),
    ).toISOString();
    // Consume the exact submission object before the first await. The runner's WeakMap never crosses persistence;
    // after this point the parked-job record owns the lease through poll, cancel, failure and completion.
    const admission = takeMediaJobAdmission(job);
    this.#pendingMediaJobs.set(vertex.id, {
      jobId: job.jobId,
      provider: job.provider,
      model: job.model,
      modality: job.modality,
      units: job.units,
      deadlineAt,
      // Derive from the SAME `startedAt` that is persisted on `media_job:submitted`, so the resume-side
      // recompute (from the checkpoint slot) yields an identical value (M2).
      submittedAtMs: Date.parse(startedAt) - this.#startEpochMs,
      backoffMs: MEDIA_JOB_POLL_DEFAULTS.pollInitialMs,
      ...(admission === undefined ? {} : { admission }),
    });
    await this.#emitDurable({
      type: 'media_job:submitted',
      runId: this.runId,
      nodeId: vertex.id,
      jobId: job.jobId,
      provider: job.provider,
      model: job.model,
      modality: job.modality,
      startedAt,
      deadlineAt,
      // ADR-0074 §3 — freeze the money basis at submit time. `units` is the authored volume this submission was
      // priced on, and `acceptedCostMicrocents` is what the admission actually reserved (0 when the model was
      // unpriced and the allow-degrade path held no admission). Resume restores from these instead of
      // re-deriving, so neither a workflow edit nor a price change can move an accepted commitment.
      units: job.units,
      // ADR-0074 §3. `0` means "the gate RAN and reserved nothing" — an unpriced model's allow-degrade path.
      // Under H3's approved bypass NO hook runs at all (`#runAttempt` passes `preEgress: undefined`), so there
      // is no priced basis to freeze, and emitting `0` would claim one. That is not a cosmetic difference: on
      // resume the frozen branch would call `reserveAcceptedCost(model, 0)`, reserve NOTHING, and skip
      // `registerLegacyMediaJob` — so a job deliberately submitted OVER the cap would come back holding no
      // reservation and no hold, letting a sibling spend headroom that is still owed. Omitting it routes the
      // resume through the legacy branch, which re-prices AND fails closed — the conservative answer, and the
      // one the pre-§3 code already gave.
      ...(budgetApproved ? {} : { acceptedCostMicrocents: admission?.reservedMicrocents ?? 0 }),
    });
    this.#armMediaPoll(vertex.id);
  }

  /** Arm (or re-arm) the one-shot poll timer for a parked media job via the INJECTED host timer (never an
   *  ambient `setTimeout` — engine purity). Disarm-then-arm so a re-arm never leaks a prior timer. */
  #armMediaPoll(nodeId: string): void {
    const job = this.#pendingMediaJobs.get(nodeId);
    if (job === undefined) {
      return;
    }
    this.#disarmMediaTimer(nodeId);
    const disarm = this.#host.setTimer(job.backoffMs, () => {
      void this.#pollMediaJob(nodeId);
    });
    this.#mediaJobTimers.set(nodeId, disarm);
  }

  /** Disarm and forget a media-job poll timer (idempotent). */
  #disarmMediaTimer(nodeId: string): void {
    const disarm = this.#mediaJobTimers.get(nodeId);
    if (disarm !== undefined) {
      this.#mediaJobTimers.delete(nodeId);
      disarm();
    }
  }

  /** Remove a parked media job + disarm its timer (on done/failed). Resetting `#pauseEpisode` mirrors the gate
   *  `resume()` so a LATER pause (a downstream gate / a second media job parking in a fresh idle cycle) re-emits
   *  an accurate aggregate `run:paused` instead of being suppressed. */
  #clearMediaJob(nodeId: string): void {
    this.#pendingMediaJobs.delete(nodeId);
    this.#disarmMediaTimer(nodeId);
    this.#pauseEpisode = false;
    // ADR-0074 §3: the job is over, so its unknown-basis hold ends with it — done, failed, deadline or cancel
    // alike, because every one of those settles the realized charge (`#emitMediaJobCost` fires on all of them).
    //
    // This is the choke point for every PER-JOB exit, so a future one cannot forget it and strand the cap in a
    // permanent refusal. It is deliberately not the only place `#pendingMediaJobs` shrinks: the two bulk
    // `.clear()`s are run TEARDOWN, and there the governor is discarded with the run, so a leftover registration
    // cannot outlive anything. Stated explicitly because "every path goes through here" would be false.
    this.#budgetGovernor?.clearLegacyMediaJob(nodeId);
  }

  /** Emit the lone realized media-cost addend for a job (ADR-0045 §5) — folded into the run cumulative +
   *  streamed by `#nodeEmit`. Emitted exactly once per job: at `done`, or — for a paid job abandoned by a
   *  fail/deadline/cancel — at that settle (the provider bills regardless, a cost-integrity requirement). */
  #emitMediaJobCost(nodeId: string, job: ParkedMediaJob): void {
    if (job.costAccounted === true) {
      return;
    }
    // Mark before the first side effect. A terminal/error path may re-enter while a sink is unwinding; the provider
    // has only one submitted job, so the engine must never manufacture a second billed addend for it.
    job.costAccounted = true;
    const realized = realizedMediaCost(job.model, job.modality, job.units, this.#resolvePrice);
    // Reconcile the lease BEFORE publishing the engine cost event. If event delivery faults after a provider-paid
    // job, the reservation cannot be released as though the submission were free. Clear the process-local handle
    // after its idempotent settle so every terminal sweep remains exactly-once from the governor's perspective.
    job.admission?.settle(realized.costMicrocents);
    delete job.admission;
    this.#nodeEmit({
      type: 'cost:updated',
      nodeId,
      model: job.model,
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: realized.costMicrocents,
      cumulativeCostMicrocents: 0, // #nodeEmit overwrites with the authoritative run-wide total
      // The async-job half of ADR-0089 §4. A minute-scale video generation is the single most expensive thing
      // this engine emits a cost for, so a `0` here that cannot be told from "free" is the worst version of
      // `CR-55` — and this settle runs on EVERY terminal (success, fail, deadline, cancel), because the
      // provider bills regardless. `false` only; absence is the ordinary, fully-priced case.
      ...(realized.priced ? {} : { priced: false }),
    });
  }

  /**
   * One poll of a parked media job (ADR-0045 §3). Idempotent against a settled run / cleared job. Past the
   * deadline → abandon as a retryable `provider_unavailable` timeout (a node-retry MAY re-submit; the loop
   * itself never silently re-submits). Otherwise delegate the poll to the executor (which owns provider +
   * credential resolution), passing the run abort signal so a cancel aborts the in-flight poll.
   */
  async #pollMediaJob(nodeId: string): Promise<void> {
    this.#disarmMediaTimer(nodeId);
    const job = this.#pendingMediaJobs.get(nodeId);
    if (this.#settled || job === undefined) {
      return; // run terminal, or the job was already cleared (nothing to clean up)
    }
    const vertex = this.#plan.vertices.get(nodeId);
    if (vertex === undefined) {
      // The parked node no longer exists in the plan — only reachable via same-slug workflow CONTENT drift on
      // resume (the identity guard checks the surrogate workflow id, not content). A silent return would strand
      // the run paused forever on a job that can never re-attach. The provider billed the submitted job
      // regardless of the drift, so emit its lone realized cost addend BEFORE clearing (ADR-0045 §5: exactly
      // one addend on EVERY terminal path — there is no vertex to settle node:failed against, but the cost is
      // still owed). Then clear + drive the loop so the now-jobless idle settles the run instead of hanging.
      this.#emitMediaJobCost(nodeId, job);
      this.#clearMediaJob(nodeId);
      this.#schedule();
      return;
    }
    // The whole settle path is wrapped: a synchronous bus/Zod throw (or a #nodeEmit fault) must NOT escape the
    // fire-and-forget `void #pollMediaJob` as an unhandled rejection — route it to a single run:failed instead
    // (mirroring the #onOutcome backstop), keeping the run total for faults.
    try {
      if (Date.parse(this.#host.clock.now()) > Date.parse(job.deadlineAt)) {
        await this.#settleMediaJobFailed(vertex, job, {
          code: 'provider_unavailable',
          message: `media job '${job.jobId}' exceeded its deadline (${job.deadlineAt})`,
          retryable: true,
        });
        return;
      }
      if (this.#executor.pollMediaJob === undefined) {
        await this.#settleMediaJobFailed(vertex, job, {
          code: 'internal',
          message: 'the executor implements no pollMediaJob (host-wiring gap)',
          retryable: false,
        });
        return;
      }
      const submission: MediaJobSubmission = {
        jobId: job.jobId,
        provider: job.provider,
        model: job.model,
        modality: job.modality,
        units: job.units,
      };
      let status: MediaJobStatus;
      // **Bound the individual poll CALL, not only the loop (`CR-21c`).** ADR-0045 §7 gives the job an
      // absolute `deadlineAt`, and it is consulted at the TOP of each tick — twenty-five lines above this
      // await. Nothing raced the await itself, so a provider whose poll never settles (and ignores its
      // signal, which is a request rather than a guarantee — ADR-0082 §5) stranded the run past its own
      // thirty-minute deadline indefinitely. The loop was bounded; one call inside it was not.
      //
      // The bound is `MEDIA_JOB_POLL_DEFAULTS.pollCallTimeoutMs`, CLAMPED to whatever is left of
      // `deadlineAt`. The clamp is what makes the item's title true: bounding the call alone still lets a
      // job outlive its deadline by up to one call.
      //
      // A deadline abort here falls into the catch below, which already classifies a poll fault as the
      // retryable `provider_unavailable` that ADR-0045 §3/§6 specify — so this adds a bound, not a new
      // outcome. The scope is disposed on every exit, success included.
      const pollDeadline = this.#openPollDeadline(job);
      try {
        status = await this.#racePoll(pollDeadline, submission);
      } catch {
        // A cancel (the abort surfaced as a throw) / terminal / cleared job → return silently; the #settle
        // path emits run:cancelled. Only a genuine poll fault on a live job settles node:failed.
        if (this.#settled || this.#abort.signal.aborted || !this.#pendingMediaJobs.has(nodeId)) {
          // This job will never settle now, so anything waiting on its unknown basis must be released here too
          // (ADR-0074 §3). The abort listener above is the primary guarantee; this covers the
          // job-already-cleared case, where no abort fires at all.
          this.#budgetGovernor?.clearLegacyMediaJob(nodeId);
          return;
        }
        // A raw throw escaping the executor poll on a LIVE job (the missing-adapter + credential cases are
        // already mapped to a `failed` status upstream) is a transient provider/transport fault — classify it
        // like the deadline path: a retryable `provider_unavailable`, so when async-node retry wiring lands
        // (1.AH) a transient poll fault re-submits a fresh job rather than being a dead-end `internal` (N2).
        await this.#settleMediaJobFailed(vertex, job, {
          code: 'provider_unavailable',
          message: `media job '${job.jobId}' poll failed`,
          retryable: true,
        });
        return;
      }
      if (this.#settled || this.#abort.signal.aborted || !this.#pendingMediaJobs.has(nodeId)) {
        this.#budgetGovernor?.clearLegacyMediaJob(nodeId); // see the catch above — never strand a waiter
        return; // a cancel / terminal raced the poll await — let #settle close the run
      }
      await this.#applyMediaJobStatus(vertex, job, status);
    } catch {
      if (!this.#settled) {
        this.#clearMediaJob(nodeId);
        this.#failNodeInternal(vertex, 'the media job poll loop failed while settling the node');
        // Drive the loop so `#step` observes `#failure` and settles `run:failed`. Unlike `#onOutcome` (whose
        // backstop is followed by an unconditional `#schedule()`), this poll is fired out-of-band from a timer
        // — nothing else re-enters the loop, so without this the run would hang at `run:paused` forever (M1).
        this.#schedule();
      }
    }
  }

  /**
   * Open a deadline for ONE poll call.
   *
   * **It always returns one** — unlike `FallbackChain#openDeadline` and `openGenerativeDeadline`, whose
   * both-or-neither checks are real because THEIR deps are optional. `ExecutionHost.setTimer` and
   * `.newAbortController` are required members, so there is no host that can reach this without them. An
   * earlier version declared `| undefined` and had the caller branch on it; the branch was unreachable and
   * its docblock described a host that cannot exist.
   *
   * Clamped to the job's remaining `deadlineAt`. The top-of-tick short-circuit is a strict `>`, so a job at
   * EXACTLY its deadline still reaches here and arms zero — harmless (the same retryable terminal either
   * way), and stated because "a job already past it never reaches here" is off by that boundary.
   */
  #openPollDeadline(job: ParkedMediaJob): DeadlineScope {
    const remainingToJobDeadlineMs = Math.max(
      0,
      Date.parse(job.deadlineAt) - Date.parse(this.#host.clock.now()),
    );
    const boundMs = Math.min(MEDIA_JOB_POLL_DEFAULTS.pollCallTimeoutMs, remainingToJobDeadlineMs);
    // The KIND is bound here rather than widened into `SetDeadlineTimer`. The shared primitive's signature
    // stays `(ms, fire) => disarm` — honest about the only two things a deadline needs — and the caller,
    // which is the only party that knows what role its timer plays, supplies the third argument.
    return openDeadline(
      boundMs,
      this.#host.newAbortController,
      (ms, fire) => this.#host.setTimer(ms, fire, 'deadline'),
      this.#abort.signal,
    );
  }

  /**
   * One poll call, raced against its deadline. A trip resolves as a thrown `timeout`, which the caller's
   * existing catch maps to the retryable `provider_unavailable` — the classification ADR-0045 §3 already
   * chose for a poll that cannot complete, reached by a new route rather than a new code.
   */
  async #racePoll(
    deadline: DeadlineScope,
    submission: MediaJobSubmission,
  ): Promise<MediaJobStatus> {
    try {
      const poll = this.#executor.pollMediaJob?.(submission, deadline.signal);
      if (poll === undefined) {
        throw new Error('the executor implements no pollMediaJob');
      }
      const raced = await deadline.race(poll);
      if (raced.outcome === 'deadline') {
        throw new Error(
          `the media-job poll did not respond within its ${String(MEDIA_JOB_POLL_DEFAULTS.pollCallTimeoutMs)}ms bound`,
        );
      }
      return raced.value;
    } finally {
      deadline.dispose();
    }
  }

  /** Route one `MediaJobStatus` to: re-arm (pending) / complete (done) / fail (failed). */
  async #applyMediaJobStatus(
    vertex: PlanVertex,
    job: ParkedMediaJob,
    status: MediaJobStatus,
  ): Promise<void> {
    switch (status.state) {
      case 'pending': {
        // Exponential backoff (no jitter) capped at pollMaxMs, then re-arm. Progress is TRANSIENT (ADR-0045
        // §2) — never persisted; no run event today.
        job.backoffMs = Math.min(job.backoffMs * 2, MEDIA_JOB_POLL_DEFAULTS.pollMaxMs);
        try {
          this.#armMediaPoll(vertex.id);
        } catch {
          // The job was already accepted by the provider. A host timer fault is an engine failure, not evidence
          // that the job was free: settle its single paid addend before failing the node, so both the admission and
          // durable terminal total survive this otherwise easy-to-miss out-of-band path.
          await this.#settleMediaJobFailed(vertex, job, {
            code: 'internal',
            message: 'the media job poll timer could not be re-armed',
            retryable: false,
          });
        }
        return;
      }
      case 'done':
        await this.#settleMediaJobDone(vertex, job, status.media);
        return;
      case 'failed':
        await this.#settleMediaJobFailed(vertex, job, {
          code: codeForLlmError(status.error),
          message: status.error.message,
          retryable: status.error.retryable,
        });
        return;
      default:
        // Defense-in-depth: an out-of-union job state (a future seam value / a non-conforming adapter) would
        // otherwise fall through, leaving the node parked with no re-arm and no terminal — a silent hang. Fail
        // loudly with a terminal node:failed instead (the closed-union switch above type-checks without this).
        await this.#settleMediaJobFailed(vertex, job, {
          code: 'internal',
          message: 'media poll returned an unrecognized job state',
          retryable: false,
        });
    }
  }

  /** A media job resolved `done`: emit the lone realized cost addend, then drive the node to `completed`
   *  through `#onOutcome` (which de-inlines the media at `#emitDurable` + re-schedules — the out-of-band poll
   *  is not on the `#onOutcome→#schedule` path, so completion must re-enter it). */
  async #settleMediaJobDone(
    vertex: PlanVertex,
    job: ParkedMediaJob,
    media: Extract<MediaJobStatus, { state: 'done' }>['media'],
  ): Promise<void> {
    this.#clearMediaJob(vertex.id);
    this.#emitMediaJobCost(vertex.id, job); // the lone realized cost:updated (ADR-0045 §5)
    // The pure-media node output ({ text:'', media }) matches the SYNC generative shape exactly (so a downstream
    // {{ outputs.x.text }} resolves to '' regardless of sync-vs-LRO) and de-inlines to a media:// handle at
    // #emitDurable (the I3 boundary); `media` is the seam MediaPart (base64 or a re-hostable url).
    await this.#onOutcome(
      vertex,
      {
        kind: 'completed',
        output: { text: '', media: [media] },
        tokensUsed: { input: 0, output: 0, model: job.model },
      },
      // The job's submit time (not `now`) — so `node:completed.durationMs` is the full async wall-clock
      // (submit→done), parallel to how `#dispatch` captures `startedAtMs` before a synchronous node's await (M2).
      job.submittedAtMs,
    );
  }

  /** A media job failed / timed out: emit the paid job's lone cost addend (§5 — the provider billed even though
   *  it failed), clear it, and drive the node to `failed` through `#onOutcome`. */
  async #settleMediaJobFailed(
    vertex: PlanVertex,
    job: ParkedMediaJob,
    error: NodeFailure,
  ): Promise<void> {
    this.#clearMediaJob(vertex.id);
    this.#emitMediaJobCost(vertex.id, job);
    // `startedAtMs` is unused by the `failed` settle path (no `durationMs`), but pass the submit time for
    // symmetry with the `done` path (M2).
    await this.#onOutcome(vertex, { kind: 'failed', error }, job.submittedAtMs);
  }

  /**
   * A gate's timeout elapsed with no decision (1.Q). Idempotent: a no-op once the gate resolved (a human
   * beat the timer — resume disarmed it, but a fired-and-queued callback still guards here) or the run
   * settled. `approve` auto-resolves the gate as approved (`decidedBy: 'timeout'`); `reject` fails the run.
   */
  async #onGateTimeout(
    gateId: string,
    vertexId: string,
    action: 'approve' | 'reject',
  ): Promise<void> {
    this.#disarmTimer(gateId);
    if (this.#settled || !this.#pendingGates.has(gateId)) {
      return; // already resolved or terminal
    }
    if (action === 'approve') {
      await this.resume(gateId, { decision: 'approved', decidedBy: 'timeout' });
      return;
    }
    await this.#failGateOnTimeout(gateId, vertexId);
  }

  /** Timeout with `timeout_action: reject` — fail the run with `run_timeout` (execution-model.md). */
  async #failGateOnTimeout(gateId: string, vertexId: string): Promise<void> {
    this.#pendingGates.delete(gateId);
    // Mark the gate resolved (symmetry with resume / the approve path) so a late re-delivery of this
    // gate's decision is an idempotent no-op rather than a `run_already_terminal` throw.
    this.#resolvedGates.add(gateId);
    const vertex = this.#plan.vertices.get(vertexId);
    if (vertex === undefined) {
      return; // unreachable: a pending gate always maps to a plan vertex
    }
    await this.#settleFailed(vertex, {
      code: 'run_timeout',
      message: 'the human gate timed out without a decision',
      retryable: false,
    });
    this.#schedule();
  }

  /** Mark a vertex failed and fail the run (unless already cancelling/failing) — the internal backstop. */
  #failNodeInternal(vertex: PlanVertex, message: string): void {
    const state = this.#states.get(vertex.id);
    // A media-parked node is `'paused'`, not `'running'`, when its poll loop's settle-path backstop fires —
    // transition it to `'failed'` too so the in-memory state matches the run's terminal outcome (L1).
    if (state?.status === 'running' || state?.status === 'paused') {
      state.status = 'failed';
    }
    if (!this.#settled && this.#failure === undefined && !this.#cancelling) {
      this.#failure = { nodeId: vertex.id, error: { code: 'internal', message, retryable: false } };
      this.#abort.abort();
    }
  }

  async #emitPausedOnce(): Promise<void> {
    if (this.#pauseEpisode) {
      return;
    }
    this.#pauseEpisode = true;
    const gateIds = [...this.#pendingGates.keys()];
    const mediaJobNodeIds = [...this.#pendingMediaJobs.keys()];
    // **Only for a GATE park, never a media park** — measured, and getting it wrong hung twenty-two tests.
    // `run:paused` covers both, but they are opposite situations: a run waiting on a human is not being
    // executed by anyone, while a run parked on an async media job is still being polled by THIS process on
    // its own timer. Surrendering the latter would hand ownership away mid-work and fence this process out
    // of its own in-flight job.
    //
    // The lease is held while the run EXECUTES. A run waiting on a human gate is not executing and may wait
    // for days; holding its lease would refuse every other process for the TTL over a run nobody is working
    // on, and would make the second decision of a two-gate workflow fail against this process's own stale
    // claim. Whichever process resumes re-acquires (ADR-0079 §4).
    //
    // **Defence in depth, not the sole protection** — measured, and worth stating so a future refactor judges
    // the risk correctly. Two other mechanisms already cover this: `#emitDurable` re-reads the ownership
    // state at WRITE time rather than caching it, and `#schedule`'s single-flight guard means a post-gate
    // dispatch cannot begin until the `#step()` containing this whole function has unwound. A reviewer moved
    // the hand-off back after the emit AND injected a real delay to force the race, and the suite stayed
    // green. The ordering is kept because it makes the invariant true by construction rather than by two
    // coincidences, but it is not load-bearing alone.
    //
    // **The claim is dropped BEFORE the pause is observable, and the row is deleted after.** Both halves are
    // forced, in opposite directions. The row must go last because `run:paused` is itself a fence-guarded
    // write — deleting first would make the run's own pause event fail its own guard. But `#owned` must drop
    // FIRST, because `#emitDurable` delivers to consumers, and an inline prompter (`relavium gate`'s
    // interactive re-pause) resumes the instant it sees `run:paused` — synchronously, before this function
    // continues. Dropping `#owned` after the emit let that resume observe `#owned === true`, skip its
    // re-acquire, and then have the row deleted out from under it; its very next `node:started` was fenced
    // and the run died `uncertain` on the happy path. Deleting the row late is safe because `release` is
    // scoped to `(ownerId, generation)`: if a resume already re-acquired, the generation has moved and this
    // delete matches nothing.
    await this.#emitDurable(
      {
        type: 'run:paused',
        runId: this.runId,
        pendingGateCount: gateIds.length,
        gateIds,
        ...(mediaJobNodeIds.length === 0 ? {} : { pendingMediaJobNodeIds: mediaJobNodeIds }),
      },
      { handOff: mediaJobNodeIds.length === 0 },
    );
    const parked = this.#ownership === 'parked' ? this.#fence : undefined;
    if (parked !== undefined) await this.#releaseLeaseRow(parked);
  }

  /**
   * Acquire this run's lease and start its heartbeat (ADR-0079 §3, §6).
   *
   * For a FRESH run this is uncontended by construction — the `runId` came from `ids.newId()` moments ago —
   * so a refusal here means the host's lease port is broken rather than that someone else owns the run. It
   * still fails the run rather than proceeding unowned: an unfenced run is exactly what CR-11 exists to
   * prevent, and silently continuing would make the guarantee optional in practice.
   *
   * A RESUMED run already holds a fence, acquired before the checkpoint was read, and passes it in.
   */
  async #acquireLease(existing?: RunFence): Promise<boolean> {
    if (existing !== undefined) {
      this.#fence = existing;
      this.#ownership = 'held';
      this.#startHeartbeat();
      return true;
    }
    const fence = await this.#host.runLeases.acquire(this.runId, this.#ownerId, RUN_LEASE_TTL_MS);
    if (fence === undefined) return false;
    this.#fence = fence;
    this.#ownership = 'held';
    this.#startHeartbeat();
    return true;
  }

  /**
   * Re-arm the lease every {@link RUN_LEASE_HEARTBEAT_MS} through the host's timer seam — the ADR-0045
   * media-poll precedent, so the platform-free engine names no `setInterval`.
   *
   * A heartbeat that returns `false` means the lease was taken over. That is the SAME state a fenced write
   * produces, and it is handled the same way: the run stops without claiming an outcome. Discovering it here
   * rather than at the next write matters — a run between nodes may not write for a while, and every second
   * it keeps executing is a second it may call a tool the new owner is also calling.
   */
  #startHeartbeat(): void {
    const fence = this.#fence;
    if (fence === undefined) return;
    // Arming is IDEMPOTENT: only one disarm handle is ever held, so arming over a live beat would strand the
    // previous timer with no way to stop it — a heartbeat that keeps renewing a stale fence for the life of
    // the process, long after the run it belonged to settled.
    this.#stopHeartbeat();
    // **`'liveness'`, not a work timer** — the kind is the whole reason the seam carries one. This beat
    // advances nothing and re-arms itself for as long as the run lives, so it must not join the set a test
    // fires to drive a run forward (a drive-to-quiescence loop would never terminate) nor the set that
    // answers "is this run waiting on something", and it must not be what holds a CLI process open. See
    // {@link TimerKind}.
    this.#heartbeatDisarm = this.#host.setTimer(
      RUN_LEASE_HEARTBEAT_MS,
      () => void this.#beat(fence),
      'liveness',
    );
  }

  /** One heartbeat: refresh the lease, then either re-arm or stop as a fenced run. */
  async #beat(fence: RunFence): Promise<void> {
    if (this.#settled || this.#ownership !== 'held') return;
    let alive = false;
    try {
      alive = await this.#host.runLeases.heartbeat(this.runId, fence, RUN_LEASE_TTL_MS);
      this.#missedBeats = 0;
    } catch {
      // A heartbeat that cannot be WRITTEN is not a takeover — we still hold the row, and the next write's
      // fence check is the authority. Treating an I/O blip as a loss would stop a run that still owns itself.
      //
      // But the tolerance is BOUNDED, because unbounded it hides the one failure §6 names as its reason for
      // existing. A store that is persistently unwritable means the lease provably expires, somebody takes
      // the run over, and this process keeps dispatching nodes and calling tools with no beat ever telling
      // it. Once the misses cover the whole TTL the lease is expired whatever the store says, so the claim
      // is one this process can no longer prove — and §5's rule is that an unprovable claim stops.
      this.#missedBeats += 1;
      alive = this.#missedBeats * RUN_LEASE_HEARTBEAT_MS < RUN_LEASE_TTL_MS;
    }
    // Re-checked, and against `held` rather than `lost`: the await above suspends, and a gate park during it
    // hands the claim back without setting `lost`. A beat that then acted would either re-arm a timer for a
    // parked run or read a deliberate release as a takeover.
    if (this.#settled || this.#ownership !== 'held') return;
    if (!alive) {
      this.#loseOwnership();
      return;
    }
    this.#startHeartbeat(); // re-arm; one-shot timers only (ADR-0036 Decision 5)
  }

  /**
   * Whether ownership was lost — read through a METHOD, deliberately.
   *
   * `#loseOwnership()` mutates `#ownership` from inside a call TypeScript's control-flow analysis cannot see
   * through, so a bare `this.#ownership === 'lost'` after an earlier check on the same field narrows to
   * `never` and is reported as an unintentional comparison. The two sites that need this are the ones asking
   * "did the await I just finished take my ownership away", which is exactly when the field can have moved.
   */
  #lostOwnership(): boolean {
    return this.#ownership === 'lost';
  }

  /** The one transition into `lost` (§5) — every discovery point routes here, so the teardown is identical. */
  #loseOwnership(): void {
    this.#ownership = 'lost';
    this.#terminalDurability = 'uncertain';
    this.#settleFenced();
  }

  /**
   * Reconcile the ownership claim before a durable write. **Never rejects** — `#emitDurable` must stay TOTAL
   * for non-terminal events or ADR-0077's B1/B2/B3 barrier argument rots.
   *
   * Returns `false` only when this process must not write at all.
   */
  async #authorizeWrite(): Promise<boolean> {
    switch (this.#ownership) {
      case 'held':
      case 'unclaimed':
        return true;
      case 'parked':
        return await this.#reclaim();
      case 'lost':
      case 'done':
        return false;
    }
  }

  /**
   * Re-take the claim a gate park handed back (§4). Uncontended in the common case — nobody took the run
   * over, and the user is simply cancelling or the gate simply timed out.
   *
   * **Fails CLOSED, unlike `#beat`, and the asymmetry is deliberate.** A beat that cannot reach the store
   * still HOLDS its row, so silence is not evidence of a takeover and treating it as one would kill a healthy
   * run. A parked run definitely had a row and deleted it, so a claim it cannot prove is a claim it does not
   * have.
   */
  async #reclaim(): Promise<boolean> {
    let acquired = false;
    try {
      acquired = await this.#acquireLease();
    } catch {
      acquired = false;
    }
    if (acquired) return true;
    this.#loseOwnership();
    return false;
  }

  #stopHeartbeat(): void {
    this.#heartbeatDisarm?.();
    this.#heartbeatDisarm = undefined;
  }

  async #settle(type: 'run:completed' | 'run:failed' | 'run:cancelled'): Promise<void> {
    if (this.#settled) {
      return; // exactly-one-terminal-event: idempotent
    }
    this.#settled = true;
    // **A fenced run settles LOCALLY and emits nothing (ADR-0079 §5).** It still disarms its timers, closes
    // its stream and reports `uncertain` — the consumer's `for await` must complete rather than hang — but
    // the terminal is the new owner's to write. Placed before the timer sweep so the state is identical
    // either way; the only difference is that no event leaves this process.
    if (this.#ownership === 'lost') {
      this.#settleFenced();
      return;
    }
    this.#abort.abort(); // make sure any straggler executor sees cancellation
    // The run is closing — no gate or media-poll timer may fire afterwards (1.Q / ADR-0045 §4). Disarm each,
    // then clear in one shot. The #abort.abort() above also aborts any in-flight pollMediaJob (the signal is
    // threaded into the executor poll), so a cancelled job's open provider request is dropped, not just its
    // next schedule.
    for (const disarm of this.#gateTimers.values()) {
      disarm();
    }
    this.#gateTimers.clear();
    // A paid media job still pending at the terminal (a cancel, or a sibling's failure abandoning it) was
    // billed by the provider even though its output is discarded — emit its lone cost addend before clearing
    // (ADR-0045 §5, the local-only-cancel cost-integrity caveat). run:completed never reaches here with a
    // pending job (each completes + clears at its own `done`). Emit BEFORE the terminal so the run total folds it.
    for (const [nodeId, job] of this.#pendingMediaJobs) {
      this.#emitMediaJobCost(nodeId, job);
    }
    for (const disarm of this.#mediaJobTimers.values()) {
      disarm();
    }
    this.#mediaJobTimers.clear();
    // ADR-0074 §3: release every unknown-basis HOLD before dropping the jobs. A `checkPreEgress` awaiting a job
    // that will now never settle would hang forever — worse than either failing or admitting. This is the reason
    // the bulk paths cannot simply drop the map.
    for (const nodeId of this.#pendingMediaJobs.keys()) {
      this.#budgetGovernor?.clearLegacyMediaJob(nodeId);
    }
    this.#pendingMediaJobs.clear();
    this.#budgetApprovedVertices.clear(); // drop any unconsumed budget-approval (a sibling failure/cancel
    // can settle the run between resume() arming it and the re-dispatch — no stale entry on the retained run)
    this.#disarmRunTimeout();
    this.#disarmGraceWindow(); // ADR-0085 §3 — a settled run leaves no backstop holding the loop open
    // Live `keys()` — see the note at the `#onGraceElapsed` sweep for why deleting during iteration is safe.
    for (const vertexId of this.#nodeDeadlineDisarm.keys()) this.#disarmNodeDeadline(vertexId);
    const durationMs = Math.max(0, this.#elapsedMs());
    let draft: RunEventDraft;
    if (type === 'run:completed') {
      draft = {
        type,
        runId: this.runId,
        outputs: this.#collectOutputs('output'),
        totalTokensUsed: { input: this.#totalInputTokens, output: this.#totalOutputTokens },
        totalCostMicrocents: this.#cumulativeCostMicrocents,
        durationMs,
      };
    } else if (type === 'run:failed') {
      const failure = this.#failure ?? {
        error: { code: 'internal' as const, message: 'the run failed', retryable: false },
      };
      draft = {
        type,
        runId: this.runId,
        error: {
          ...failure.error,
          ...(failure.nodeId === undefined ? {} : { nodeId: failure.nodeId }),
          correlationId: this.#host.ids.newId(),
        },
        partialOutputs: this.#collectOutputs('completed'),
        // Snapshot the run-wide cost onto the durable terminal (2.S/D-GC, ADR-0045 §5), mirroring run:cancelled
        // below. The root-cause node's node:failed snapshotted the cumulative as of that node; a SIBLING's paid
        // media job abandoned by this failure had its lone estimate addend emitted just above (#emitMediaJobCost,
        // before this terminal), so the cumulative now includes it and the fail-cost is durable here (cost:updated
        // is transient). The checkpoint fold reads cost only from node:completed, so this never affects resume.
        cumulativeCostMicrocents: this.#cumulativeCostMicrocents,
      };
    } else {
      // run:cancelled — snapshot the run-wide cost onto the durable terminal (2.S/D-GC, ADR-0045 §5). A paid
      // media job pending at the cancel had its lone estimate addend emitted just above (#emitMediaJobCost,
      // before this terminal), so the cumulative now includes it and the fail-cost is durable here (cost:updated
      // is transient). run:completed carries the same figure as totalCostMicrocents.
      draft = { type, runId: this.runId, cumulativeCostMicrocents: this.#cumulativeCostMicrocents };
    }
    // **Re-take ownership before claiming an outcome, if a park gave it up (ADR-0079 §4/§5).** A gate
    // deadline, the run-level `timeout_ms` and a cooperative cancel all stay armed across a park and all end
    // here, so this is the one place a parked process can still speak for the run. Usually nobody took it
    // over and the re-acquire is uncontended — a user Ctrl-C-ing their own parked run must still record the
    // cancellation. When somebody DID take it over, the acquire fails and this process stops without
    await this.#emitDurable(draft);
    // The terminal was REFUSED (§5) — `#emitDurable` reconciled ownership, found it gone, and `#settleFenced`
    // already tore the run down without writing or delivering anything. Returning stops a loser from freeing
    // the winner's lease row and from firing `#onSettled` a second time.
    if (this.#lostOwnership()) return;
    // **Ownership ends with the run, and only AFTER the terminal is written** (ADR-0079 §4). The order is
    // forced: the terminal is itself fence-checked, so releasing first would make this run's own last write
    // fail its own guard.
    //
    // Both halves are load-bearing. An un-disarmed beat re-arms itself forever, so a finished run would keep
    // writing a lease renewal every 20s for the life of the process; an unreleased lease leaves a
    // `run_leases` row per run, growing without bound in `history.db`. Released even when the terminal write
    // FAILED (the run is `uncertain` and its terminal is in the outbox): letting another process take the run
    // over is exactly what should happen next, and the generation only moves forward, so this process stays
    // fenced if it ever wakes.
    await this.#releaseOwnership();
    this.#onSettled(this.runId);
  }

  /**
   * Tear the run down as a FENCED loser: disarm everything, close the stream, emit nothing (ADR-0079 §5).
   *
   * **Called directly at each point the loss is discovered, never left to the scheduler.** Handing the job to
   * `#schedule()` looked equivalent and is not: `#step()` returns early only on `#settled`, so a fenced run
   * with nothing runnable — one parked at a gate, or between nodes — simply finds no work, never reaches
   * `#settle`, and leaves the consumer's `for await` hanging forever. §5 promises the opposite in terms.
   *
   * Idempotent, because the two discovery points can overlap: a beat can lose the lease while a write is
   * already failing its fence check, and `#settle` may reach the fenced branch afterwards.
   *
   * The lease is deliberately NOT released here — it belongs to the new owner now, and `release` is scoped to
   * (owner, generation) precisely so a loser on its way down can never free the winner's claim.
   */
  #settleFenced(): void {
    if (this.#fencedSettled) return;
    this.#fencedSettled = true;
    this.#settled = true; // no terminal may be emitted after this point, by any path
    this.#stopHeartbeat();
    this.#abort.abort();
    // ADR-0085 §8.12 requires the grace window disarmed on a FENCED settle as well as a normal one, and it
    // was not: `#settle` reaches its fenced branch and returns BEFORE its own `#disarmGraceWindow()`. The
    // cost is concrete rather than theoretical — the CLI deliberately does not `unref` a `deadline` timer,
    // and sets `process.exitCode` rather than calling `process.exit`, so a fenced `relavium run` sat idle
    // for the full 10 s after it had finished.
    this.#disarmGraceWindow();
    // **And the node deadlines, for the same reason and by the same measurement.** §8.12's grace-window
    // finding was one instance of a general asymmetry: `#settle` sweeps every timer this run armed, but its
    // fenced branch returns to `#settleFenced` BEFORE reaching that sweep. A node deadline outlives the
    // fenced teardown — it is armed for the node's whole life by design, so a node in flight (a slow
    // provider call, a media park, a gate park) still holds one when the lease is lost. The CLI does not
    // `unref` a `deadline` timer and sets `process.exitCode` rather than calling `process.exit`, so a fenced
    // `relavium run` sat idle for the node's full authored `timeout_ms` — minutes, where the grace leak cost
    // ten seconds.
    for (const vertexId of this.#nodeDeadlineDisarm.keys()) this.#disarmNodeDeadline(vertexId);
    for (const disarm of this.#gateTimers.values()) disarm();
    this.#gateTimers.clear();
    for (const disarm of this.#mediaJobTimers.values()) disarm();
    this.#mediaJobTimers.clear();
    // The same ADR-0074 §3 obligation `#settle` discharges: a `checkPreEgress` awaiting a job that will now
    // never settle would hang forever. This teardown exists to leave nothing behind, and a fenced run is
    // exactly as final as a settled one for anything waiting on it.
    for (const nodeId of this.#pendingMediaJobs.keys()) {
      this.#budgetGovernor?.clearLegacyMediaJob(nodeId);
    }
    this.#pendingMediaJobs.clear();
    this.#disarmRunTimeout();
    this.#closeStream?.();
    this.#onSettled(this.runId);
  }

  /** Stop beating and give the lease back — the run is over, one way or another (ADR-0079 §4). */
  async #releaseOwnership(): Promise<void> {
    const fence = this.#ownership === 'held' ? this.#fence : undefined;
    this.#stopHeartbeat();
    // `done` is terminal, and it is load-bearing: without it a post-terminal write would re-acquire the row
    // this just released (`acquire` computes `(current?.generation ?? 0) + 1` over a deleted row), inserting
    // a `run_leases` row nothing will ever release.
    this.#ownership = 'done';
    if (fence !== undefined) await this.#releaseLeaseRow(fence);
  }

  /**
   * Drop the ownership CLAIM synchronously, returning the fence whose row still needs deleting.
   *
   * Split from the row delete so the two can straddle an await — see `#emitPausedOnce`, where dropping the
   * claim must happen before the pause is observable while the delete must happen after the pause is
   * durable. `#fence` is deliberately KEPT: clearing it would make a subsequent write unguarded (an absent
   * fence is a pass, not a refusal), which is the failure this pair of fields exists to close.
   */
  #park(): RunFence | undefined {
    if (this.#ownership !== 'held') return undefined;
    this.#stopHeartbeat();
    this.#ownership = 'parked';
    return this.#fence; // deliberately retained — see the `#fence` docblock
  }

  /** Delete the lease row for `fence`. Scoped to `(ownerId, generation)`, so it can never steal a successor. */
  async #releaseLeaseRow(fence: RunFence): Promise<void> {
    try {
      await this.#host.runLeases.release(this.runId, fence);
    } catch {
      // A release that cannot be written leaves the lease to expire on its own TTL — slower, never wrong.
    }
  }

  // --- readiness, skip-propagation, edges -----------------------------------------------------

  #allDepsSettled(vertex: PlanVertex): boolean {
    for (const dep of vertex.dependencies) {
      const state = this.#states.get(dep);
      if (state === undefined || !SETTLED.has(state.status)) {
        return false;
      }
    }
    return true;
  }

  /** A vertex has a live in-edge when ≥1 dependency reached it on a *taken* path (a root is always live). */
  #hasLiveEdge(vertex: PlanVertex): boolean {
    if (vertex.dependencies.length === 0) {
      return true; // a root vertex (e.g. an `input`) is always live
    }
    for (const dep of vertex.dependencies) {
      const state = this.#states.get(dep);
      if (state?.status !== 'completed') {
        continue; // an unknown, skipped, or failed dependency carries no live edge
      }
      const depVertex = this.#plan.vertices.get(dep);
      if (depVertex?.type === 'condition') {
        if (state.selectedTargets?.has(vertex.id) === true) {
          return true; // the condition selected the branch leading to this vertex
        }
        continue; // the condition routed away from this vertex
      }
      return true; // a normally-completed non-condition dependency is a live edge
    }
    return false;
  }

  /** Skip-propagate to a fixpoint; return the vertices newly skipped this call (the caller emits them). */
  #propagateSkips(): Array<{ readonly id: string; readonly reason: NodeSkippedReason }> {
    const skipped: Array<{ id: string; reason: NodeSkippedReason }> = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, state] of this.#states) {
        if (state.status !== 'pending') {
          continue;
        }
        const vertex = this.#plan.vertices.get(id);
        if (vertex === undefined || !this.#allDepsSettled(vertex) || this.#hasLiveEdge(vertex)) {
          continue;
        }
        state.status = 'skipped'; // all deps settled and every in-edge is dead → unreachable
        skipped.push({ id, reason: this.#skipReason(vertex) });
        changed = true;
      }
    }
    return skipped;
  }

  /** Why a vertex was skipped: a completed `condition` dependency routed away from it, else an upstream
   *  dependency was itself skipped/failed (so this vertex is unreachable). */
  /**
   * Precedence (deliberate): a vertex is `branch_not_taken` if **any** dependency is a *completed*
   * `condition` (one that ran and routed away from it) — that is the most specific, actionable cause.
   * Only when no such dependency exists is the skip attributed to `upstream_unreachable` (a dead in-edge
   * from a skipped/failed upstream). So a node downstream of both a taken-away condition and an
   * unreachable upstream reports `branch_not_taken`.
   */
  #skipReason(vertex: PlanVertex): NodeSkippedReason {
    for (const dep of vertex.dependencies) {
      const depVertex = this.#plan.vertices.get(dep);
      if (depVertex?.type === 'condition' && this.#states.get(dep)?.status === 'completed') {
        return 'branch_not_taken';
      }
    }
    return 'upstream_unreachable';
  }

  /** How many vertices are currently executing — derived from status, the single source of truth. */
  #countRunning(): number {
    let running = 0;
    for (const state of this.#states.values()) {
      if (state.status === 'running') {
        running += 1;
      }
    }
    return running;
  }

  #allSettled(): boolean {
    for (const state of this.#states.values()) {
      if (!SETTLED.has(state.status)) {
        return false;
      }
    }
    return true;
  }

  // --- helpers --------------------------------------------------------------------------------

  #completedOutputs(): ReadonlyMap<string, unknown> {
    const outputs = new Map<string, unknown>();
    for (const [id, state] of this.#states) {
      if (state.status === 'completed') {
        outputs.set(id, state.output);
      }
    }
    return outputs;
  }

  #collectOutputs(mode: 'output' | 'completed'): Record<string, unknown> {
    // Null-prototype: keys are vertex ids (kebab grammar excludes `__proto__`, so not reachable), but
    // a null-proto accumulator keeps the engine's output projections consistent with the 1.P handlers.
    const outputs: Record<string, unknown> = { __proto__: null };
    for (const [id, state] of this.#states) {
      if (state.status !== 'completed') {
        continue;
      }
      if (mode === 'output' && this.#plan.vertices.get(id)?.type !== 'output') {
        continue;
      }
      outputs[id] = state.output ?? null;
    }
    return outputs;
  }

  /**
   * @param deliver false when the fold must still happen but the event must not reach subscribers — a
   * straggler's `cost:updated` after the terminal. See the call site for why the two are separable.
   */
  #nodeEmit(event: NodeStreamEvent, deliver = true): void {
    const runId = this.runId;
    // The non-cost cases all pass through with only the correlation key added — `{ ...event, runId }`
    // distributes the object spread over the case-narrowed union, so a shared fallthrough body keeps
    // each member's required fields (no cast). `cost:updated` is the one exception: the engine owns the
    // run-wide `cumulativeCostMicrocents` (a per-node executor cannot know it), so it is recomputed here
    // authoritatively rather than passed through.
    switch (event.type) {
      case 'agent:token':
      case 'agent:reasoning':
      case 'agent:tool_call':
      case 'agent:tool_result':
      case 'agent:file_patch_proposed':
        this.#bus.emit({ ...event, runId });
        return;
      case 'cost:updated':
        // The FOLD is unconditional: it is what keeps `#cumulativeCostMicrocents` a truthful record of money
        // the provider actually took, and what `TurnMoneyPort.record` stamps onto the durable ledger row.
        this.#cumulativeCostMicrocents += event.costMicrocents;
        this.#budgetGovernor?.updateCost(this.#cumulativeCostMicrocents);
        // The DELIVERY is not: a straggler must not re-announce a total the terminal already published.
        if (deliver) {
          this.#bus.emit({
            ...event,
            runId,
            cumulativeCostMicrocents: this.#cumulativeCostMicrocents,
          });
        }
        return;
      default: {
        // Exhaustiveness guard over `NodeStreamEvent` (`InNodeEventType`): a future in-node event must add a
        // case above, not silently fall through here. EA6 (`agent:reasoning`) added a member that this bare
        // switch had dropped — the `never` assignment makes the next such omission a compile error, not a
        // silent run-path drop of an event the session path still emitted.
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }

  /**
   * Await BOTH money chains at a node boundary — the conservative commitments (ADR-0074 §2) and the realized
   * ledger (ADR-0077 §4). Named for the join rather than for the commitments it once awaited alone: since
   * ADR-0077 this is the single barrier fronting `MoneyDurability`, and `#flushBudgetCommitments` read as
   * though the ledger were still someone else's to await. (The host-supplied
   * `AgentSessionDeps.flushBudgetCommitments` keeps that name and is correct — the SESSION path has no
   * realized ledger to join, because its per-attempt increment is already written synchronously.)
   *
   * **The await is the substance.** `#emitDurable` resolves only after `persistEvent` has settled (its `await
   * settled` at the end), so waiting here means a commitment made inside the attempt is on disk — or has already
   * failed the run — before the node reaches any boundary. Without it the node could settle while the write was
   * still in flight, and a crash in that window loses money the provider may have billed.
   *
   * The catch below is a BACKSTOP, and on the run path it is deliberately unreachable: `#emitDurable` is total for
   * store faults, so a failed non-terminal write sets `#failure` and aborts there rather than rejecting. **That
   * still holds under ADR-0078's ordered append** — §2's `AppendConflictError` is a non-terminal store
   * rejection like any other, absorbed by the same catch, so the write path still resolves and this argument
   * is unchanged rather than merely un-revisited. It
   * matters for a HOST-wired governor whose sink can reject — the chat path, once §4 gives it a real durable
   * write. Kept here so the two surfaces cannot diverge in what a durability failure means: never a released
   * reservation, always a loud failure.
   */
  async #joinMoneyDurability(nodeId: string): Promise<void> {
    // **Barrier B3 (ADR-0077)** — and it is now the SINGLE join for both money chains. The old
    // `if (governor === undefined) return;` is gone: it was one of §5's three barrier holes, because a run
    // without a budget has no conservative commitments but does have a realized ledger, and returning early
    // left that ledger started and never joined — exactly the fire-and-forget state ADR-0076 exists to remove.
    // `MoneyDurability.join()` fronts both, so there is no supported way to await half the money.
    try {
      await this.#money.join();
    } catch (error) {
      this.#failMoneyDurability(error, nodeId);
    }
  }

  /**
   * Record a money-durability failure against the node whose write actually broke, and abort.
   *
   * Shared by B3's own catch and by `#runAttempt`'s catch-all, and the second caller is why it is a method:
   * barriers B1 and B2 live INSIDE the turn, so their throw arrives as a bare `LedgerDurabilityError` /
   * `CommitmentDurabilityError` that the catch-all used to flatten. See the note at that call site for when
   * that path is actually reached — it is narrower than it looks.
   *
   * `??=` throughout: a sibling's already-recorded root cause always wins, which is also why this is usually
   * a no-op on the ordinary path (`#emitDurable` has already set `#failure` from the same fault).
   */
  #failMoneyDurability(error: unknown, nodeId: string): void {
    // Attribute it to the node whose write actually failed, not to whichever node reached this barrier
    // first — under a `fan_out` both branches await the same chain link, so the first to flush may have made no
    // commitment at all. Falls back to this node when the error carries no owner.
    const ledger = isLedgerDurabilityError(error);
    const owner =
      error instanceof CommitmentDurabilityError || ledger ? (error.nodeId ?? nodeId) : nodeId;
    this.#failure ??= {
      nodeId: owner,
      error: {
        code: 'internal',
        // The cause is deliberately NOT in the message: a durable-write failure can carry a filesystem path, and
        // a user-facing `run:failed` message must not. It survives on the error's `cause` for a host that
        // narrows on the class — which is the only carrier, since this path has no store to log it. The two
        // messages are distinct because the remedies differ: an estimate that could not be recorded leaves the
        // cap conservative, while a realized charge that could not be recorded leaves it UNDERSTATED.
        message: ledger
          ? 'a realized provider charge could not be made durable'
          : 'a conservative budget commitment could not be made durable',
        retryable: false,
      },
    };
    this.#abort.abort();
  }

  async #emitDurable(draft: RunEventDraft, opts?: { readonly handOff?: boolean }): Promise<void> {
    const handOff = opts?.handOff === true;
    // **`CR-32`'s durable-event bound, and the terminal is exempt.** A run that cannot publish its terminal
    // is worse in every way than one that wrote an oversized final event: the stream never closes, the lease
    // is never released, and no surface can tell whether the run finished. ADR-0078 §6 draws the same line
    // for a store fault. A non-terminal breach is safe to refuse precisely because refusing it fails the run,
    // which produces a terminal.
    //
    // Thrown rather than returned: this method's callers already route a non-terminal fault to the
    // `#onOutcome` / `#begin` backstops that map it to a single `run:failed`, which is exactly the handling
    // an oversized event needs and is the same path the media de-inline failure takes.

    // Persist the boundary/terminal event, then deliver (ADR-0036 persist-before-deliver, so a crash
    // can never re-run a completed node or lose its output). This method is **total for store faults**, with
    // TWO deliberate exceptions, both of which re-throw to the #onOutcome/#begin backstops for a NON-terminal
    // event and are exempt for a terminal: the media de-inline (see MEDIA DE-INLINE) and `CR-32`'s
    // durable-event size bound (below, after the de-inline). A store fault
    // must neither break the exactly-one-terminal-event invariant nor escape as an unhandled rejection
    // out of the fire-and-forget `#loop`. So the `sequenceNumber` is assigned once at the single
    // authoritative point (`next`), and the event is **always delivered** — keeping the stream gap-free
    // and guaranteeing a terminal always closes the consumer's `for await`. On a persist failure of a
    // **non-terminal** event we additionally fail the run (we must never report progress the durable
    // log lacks); a terminal whose write fails is still delivered in-process, and `reconcile()` repairs
    // the durable record on restart.
    //
    // DELIVERY IS ORDERED BY sequenceNumber, not by persist-resolution order. The media de-inline runs
    // first (the `await` below), THEN `#bus.next` assigns the seq and the per-run `#deliveryTail` capture
    // happens — with NO `await` between them, so seq-assignment-and-delivery-chaining stays atomic per
    // event; chaining each deliver onto the single tail makes a higher-seq event wait for the lower-seq
    // event's deliver. **The tail now serializes the ASK, the WRITE and the DELIVERY** (ADR-0078 §1) — it
    // once serialized delivery only, with each `persistEvent` started before the previous was joined, and
    // "persists stay concurrent" is the sentence ADR-0078's Context quotes as the defect. (The de-inline `await`
    // moves WHEN the seq is assigned relative to other emits — gap-free + monotonic still hold, since the
    // counter only advances on a successful `next`, and concurrent events have no canonical order.)
    // Without the tail, two concurrent leaf nodes under an ASYNC store (1.R SQLite, cloud) could resolve
    // out of order — delivering a later node:completed (or the terminal) first, closing the stream, and
    // dropping the earlier event (a gap-free / no-drop violation). InMemoryRunStore resolves
    // synchronously, which masks it; the seam exists precisely so an async store plugs in.
    //
    // MEDIA DE-INLINE (1.AF, ADR-0042 §2): run `deInlineMedia` on the draft FIRST — before `#bus.next`
    // stamps + validates and before the durable write + delivery below — so the numbered, persisted,
    // delivered event is handle-only (I3); the durable schema's typed media positions are handle-only and
    // would reject in-flight base64 at validation. This single `await` is the only addition; the
    // synchronous seq-assign / persist-before-deliver / `#deliveryTail` ordering below is unchanged, and a
    // no-media draft pays only a cheap cycle-safe scan (no store round-trip). Secret masking already
    // happened upstream (input masking at run setup; per-node output masking via `secretInputNames`), so
    // de-inline is the sole emit-time transform here and composes with masking only by sequence.
    let durable: RunEventDraft;
    try {
      durable = await this.#deInlineDraft(draft);
    } catch (error) {
      // The de-inline could not make this draft durable-safe — a missing MediaStore, a `store.put`
      // rejection (disk full / transient IO), an un-re-hosted url, a non-canonical byte carrier, or
      // invalid base64. For a NON-terminal event, re-throw — the #onOutcome / #begin backstops map it to
      // a single run:failed. For a TERMINAL event the run MUST still settle (exactly-one-terminal-event
      // is sacred), so strip its best-effort media payload to empty (stripTerminalMediaPayload yields a
      // byte-free draft) rather than block the terminal forever (a hang + unhandled rejection out of the
      // catch-less #loop) or leak inline bytes (I3). This rescues ANY de-inline failure on a terminal,
      // not only the missing-store one; the run:failed error (set when the first media-bearing
      // node:completed threw and #onOutcome caught it) states the cause.
      if (TERMINAL_TYPES.has(draft.type)) {
        durable = stripTerminalMediaPayload(draft);
      } else {
        throw error;
      }
    }
    // **`CR-32`'s durable-event bound, measured on the DE-INLINED draft.** Measuring `draft` here was the
    // same mistake as measuring a node's raw output: an in-flight media part is base64 until this point and
    // a `media://` handle after it, so the pre-de-inline size is not the size anything writes or receives.
    //
    // A terminal is exempt. A run that cannot publish its terminal is worse in every way than one that wrote
    // an oversized final event — the stream never closes, the lease is never released, and no surface can
    // tell whether the run finished. ADR-0078 §6 draws the same line for a store fault. A non-terminal
    // breach is safe to refuse because refusing it fails the run, which produces a terminal; it is thrown so
    // the `#onOutcome` / `#begin` backstops map it to a single `run:failed`, the same path a de-inline
    // failure takes.
    const sizeBreach = measureDraft(durable.type, durable, TERMINAL_TYPES.has(durable.type));
    if (sizeBreach !== undefined) {
      throw new RunLoopInvariantError('event_too_large', describeBreach(sizeBreach));
    }

    const event = this.#bus.next(durable);
    // Record the run's reference for every produced durable media handle (1.AF/D12c), then release the
    // run's references at its terminal event (D11 sweep). Best-effort + synchronous-to-the-stream: a
    // retention failure never touches the I3 / gap-free / exactly-one-terminal guarantees below.
    this.#recordProducedMedia(durable);
    // NOTE: the terminal media reclaim used to sit here, before the write. It now runs only after the
    // terminal's persist SUCCEEDS — see the write below (ADR-0078 §1 re-timing ADR-0042 §4).
    const prior = this.#deliveryTail;
    // **The ordered append (ADR-0078 §1), and it is one line.** `expectedLastSequenceNumber` is read HERE,
    // synchronously, before the region is entered — reading it inside would race with a concurrent emitter
    // that has already advanced it, which is the very interleaving the tail exists to remove.
    //
    // **The terminal stays exempt, and CR-92 is where that was DECIDED rather than deferred.** The original
    // reason — "a terminal the store will not take has nowhere to go" — is gone: §4's outbox now gives it a
    // home, so a guarded terminal that conflicted would report `uncertain` and be re-appended by the drain
    // with a fresh belief. It is exempt on a different ground. Guarding it would convert the COMMON case —
    // a non-terminal write was lost, so `#lastAskedSequenceNumber` no longer matches the log — into a run
    // whose terminal is refused, reported `uncertain`, and only lands at the next `reconcile()`. That trades
    // a run that ends correctly-but-with-a-hole for one that does not durably end at all, on the failure
    // path, which is the wrong direction. Exactly-one-terminal (ADR-0036) also outranks the guard.
    //
    // The residual is stated rather than hidden: a terminal can still land past a hole left by a lost
    // non-terminal write. `checkDurableTruth` reports that log as ordered and `createAppendAudit` reports it
    // as holed — which is the honest pair, since the run really did end and really did lose an event.
    const expectedLastSequenceNumber = this.#lastAskedSequenceNumber;
    const guarded = !TERMINAL_TYPES.has(event.type);
    if (guarded) {
      this.#lastAskedSequenceNumber = event.sequenceNumber;
    }
    // This closure's branch count is NOT extractable, and the reason is written throughout it:
    // every branch below is an ORDERING guarantee relative to `await prior` and the persist. Moving any of
    // them into a helper inserts a microtask hop at exactly the point the comments below record as having
    // reordered the log once already, and the `held`/`unclaimed` fast path exists specifically to AVOID that
    // hop. A metric is not worth re-opening the race this function was written to close (CR-10, CR-92).
    const settled = (async (): Promise<void> => {
      // `await prior` moved ABOVE the persist. Below it, the previous event's write had already been
      // STARTED but not joined, so two events for one run overlapped — nothing but the store's timing kept
      // the log a prefix. The same single tail now serializes the ask, the write and the delivery.
      await prior;
      try {
        // **Ownership is reconciled HERE, and only here.** `#emitDurable` is the run's single durable
        // writer, so every path that can write after a gate park — a cooperative cancel, a gate deadline,
        // the run-level `timeout_ms`, the skip-propagation sweep — is covered by one check instead of a
        // guard per call site that the next path added would silently miss. It sits after `await prior`
        // and inside the region deliberately: it must read the state the previous write left, and two
        // concurrent emits must not both acquire, since a same-owner acquire is a RENEWAL that bumps the
        // generation and the loser would then persist under a fence the winner had already moved.
        // The `held`/`unclaimed` fast path is taken WITHOUT awaiting, and that is not a micro-optimisation.
        // Awaiting unconditionally inserts a microtask between `await prior` and the persist, which reordered
        // ADR-0077's money-durability barrier: the emit's own catch began winning the race to set `#failure`,
        // so a rejected ledger write was attributed to "a durable run-event write failed" instead of the
        // cancellation that actually stopped the run. Only the states that genuinely need I/O suspend.
        const settledClaim = this.#ownership === 'held' || this.#ownership === 'unclaimed';
        if (!settledClaim && !(await this.#authorizeWrite())) {
          // Refused. A TERMINAL is not delivered either: `handle.subscribe` observers outlive the stream
          // close, and telling them the run ended is §5's "durable lie" in delivered form.
          if (!TERMINAL_TYPES.has(event.type)) this.#bus.deliver(event);
          return;
        }
        // A terminal is exempt from the APPEND guard (ADR-0078 §2) but NOT from the fence: a process that
        // has been taken over must not write the run's terminal either — that is the whole of ADR-0079 §5.
        // The two claims are independent fields precisely so this asymmetry is expressible.
        await this.#host.store.persistEvent(event, {
          ...(guarded ? { expectedLastSequenceNumber } : {}),
          ...(this.#fence === undefined ? {} : { fence: this.#fence }),
        });
        if (handOff && !TERMINAL_TYPES.has(event.type)) {
          // The pause is now durable and was written AS THE OWNER; hand the claim back only after that.
          // Entering `parked` here rather than before the write means the write that creates the state can
          // never observe it, and a pause that fails for an ordinary store fault KEEPS ownership instead of
          // stranding a dropped claim.
          this.#park();
        }
        if (TERMINAL_TYPES.has(event.type)) {
          this.#terminalDurability = 'durable';
          // **The media reclaim happens HERE, not before the write** (ADR-0078 §1, re-timing ADR-0042 §4).
          // It used to run at the emit, so a terminal whose write then failed had already released the run's
          // media references — the outbox could retry the terminal into a log whose media was gone.
          this.#reclaimRunMedia();
        }
      } catch (writeError) {
        // **A FENCE rejection is not a store fault, and must not be treated as one (ADR-0079 §5).** Another
        // process owns the run now. This one stops: it does not fail the run, does not write a terminal, and
        // does not hand the terminal to the outbox — the run's real outcome belongs to the new owner, and
        // recording anything here would be a durable lie about somebody else's run.
        if (isLeaseFencedError(writeError)) {
          this.#loseOwnership();
          if (TERMINAL_TYPES.has(event.type)) return; // §5 again, on the race path: deliver nothing
        } else if (TERMINAL_TYPES.has(event.type)) {
          // **The terminal outbox** (ADR-0078 §4). The run is settling and the caller is about to be handed
          // this terminal in-process; the durable record does not have it. Hold the intended payload OUTSIDE
          // the store — the store is the thing that just failed — so a later start can retry it under the
          // same identity, and report `uncertain` so no surface says `completed` on a record that disagrees.
          this.#terminalDurability = 'uncertain';
          await this.#bestEffortOutbox(event);
        }
        if (
          this.#ownership !== 'lost' &&
          !TERMINAL_TYPES.has(event.type) &&
          this.#failure === undefined &&
          !this.#cancelling
        ) {
          this.#failure = {
            // Attribute it when the event names a node. This is the failure a user ACTUALLY sees for a failed
            // durable write — including a `budget:estimate_committed`, whose typed
            // `CommitmentDurabilityError` never fires here because this catch is total and resolves rather than
            // rejecting. Without the id, `run:failed` said only "a durable run-event write failed" with nothing
            // to point at, in a run that may have dozens of nodes.
            ...('nodeId' in event && typeof event.nodeId === 'string'
              ? { nodeId: event.nodeId }
              : {}),
            error: {
              code: 'internal',
              message: 'a durable run-event write failed',
              retryable: false,
            },
          };
          this.#abort.abort();
          // Re-enter the scheduler so the run actually settles. Most callers re-schedule after
          // #emitDurable (begin/resume) or via #onOutcome's unconditional #schedule, but #emitPausedOnce
          // (the run:paused path) returns straight to #step's bare `return` — without this, a gate-pause
          // persist failure would set #failure yet never reach #settle, re-creating the zombie run.
          this.#schedule();
        }
      }
      this.#bus.deliver(event); // still in seq order — `prior` is now awaited above, before the write
    })();
    this.#deliveryTail = settled.catch(() => undefined);
    await settled;
  }

  /**
   * The flight→durable media transform for the one emit choke point (1.AF, ADR-0042 §2). With a media
   * store injected, `deInlineMedia` rewrites every in-flight base64 media part to a handle (a no-op
   * cheap scan when there is no media — the dominant text/tool-only case), and the result is still a
   * `RunEventDraft` (structure-preserving — it only swaps a media leaf's base64 source for a handle;
   * `#bus.next` re-validates it against the durable schema regardless). With NO store injected, a
   * **media-bearing** draft cannot be made handle-only — throwing is the only safe option (never
   * persist/deliver inline bytes, I3). The throw is the same class as a malformed-draft Zod failure, so
   * it is caught by the same backstops: `#onOutcome`'s try/catch (the node-settle path) and `#begin`'s
   * (the `run:started` path) map it to a single `run:failed`. A text-only draft passes straight through.
   */
  async #deInlineDraft(draft: RunEventDraft): Promise<RunEventDraft> {
    const store = this.#host.mediaStore;
    if (store !== undefined) {
      // Pass the host media-egress hook (D9) so a `url` media source is re-hosted to a handle; undefined
      // when the host has no egress mechanism, in which case a `url` hard-fails inside deInlineMedia (I3).
      return (await deInlineMedia(draft, store, this.#mediaEgress())) as RunEventDraft;
    }
    // No store: a draft carrying inline bytes OR an un-re-hosted url media part cannot be made
    // durable-safe — throw (the broadened #emitDurable catch + the #onOutcome/#begin backstops map it to
    // a single run:failed; a terminal is stripped). `containsDurableUnsafeMedia` (not the byte-only scan)
    // also catches a url-only payload, so it cannot pass silently.
    if (containsDurableUnsafeMedia(draft)) {
      throw new RunLoopInvariantError(
        'media_store_unavailable',
        'a media-bearing event was emitted but no MediaStore was injected into the ExecutionHost (1.AF, I3)',
      );
    }
    return draft;
  }

  /**
   * Build the `deInlineMedia` url-rehost hooks (1.AF/D9, ADR-0089 §2) from the host media-egress ports,
   * bound to this run's size-bound **policy** ({@link DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES}) and abort signal —
   * so the host mechanism receives the engine-supplied bound. Either hook may be absent; with no STREAMING
   * one a `url` media source hard-fails inside `deInlineMedia` (an un-re-hosted url may never persist, I3,
   * and the url path must never be whole-buffered).
   */
  #mediaEgress(): MediaEgressHooks {
    const fetchMedia = this.#host.fetchMedia;
    const streamMedia = this.#host.streamMedia;
    return {
      // The url path takes the STREAMING hook (ADR-0089 §2); the whole-buffer one is carried for a
      // sub-ceiling caller and is deliberately NOT a fallback for it.
      ...(streamMedia === undefined
        ? {}
        : {
            streamUrl: (url: string) =>
              streamMedia(url, DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES, this.#abort.signal),
          }),
      ...(fetchMedia === undefined
        ? {}
        : {
            fetchUrl: (url: string) =>
              fetchMedia(url, DEFAULT_MAX_MEDIA_DOWNLOAD_BYTES, this.#abort.signal),
          }),
    };
  }

  /**
   * The typed failure both `save_to` fence paths return when the run stopped waiting on this dispatch
   * (ADR-0085 §5, fence point 3).
   *
   * `cancelled` and `retryable: false` deliberately: the cutoff that trips this fence is a cancel or an
   * elapsed grace window, and cancel-wins precedence means `#settleFailed` leaves an already-recorded
   * `#failure` alone — so this classifies the NODE without ever overwriting the run's real cause. Message
   * is path-free and byte-free (I3).
   */
  #saveToAbandoned(): NodeFailure {
    return {
      code: 'cancelled',
      message: 'the run stopped waiting on this dispatch before `save_to` was written',
      retryable: false,
    };
  }

  /**
   * Apply an `output` node's `save_to` (1.AF/D16, ADR-0044 §2) once its executor has `completed`: returns
   * the outcome unchanged when there is nothing to write (not an output node, no `save_to`, or a
   * non-`completed` outcome), else writes the produced media and returns the outcome on success or a typed
   * `failed` outcome on error. `save_to` is a real deliverable, so a failure FAILS the node (→ run:failed)
   * — it is NOT best-effort (contrast the retention {@link #recordProducedMedia}). Output nodes carry no
   * node-retry budget ({@link #retryConfig}), so the write runs once.
   */
  async #applySaveTo(
    vertex: PlanVertex,
    outcome: NodeOutcome,
    dispatchId: number,
  ): Promise<NodeOutcome> {
    if (outcome.kind !== 'completed') {
      return outcome;
    }
    const config = vertex.config;
    if (config.kind !== 'output' || config.node.save_to === undefined) {
      return outcome;
    }
    // **Fence point 3 (ADR-0085 §5): `save_to`.** Unguarded before this, and the only fence point that
    // writes BYTES TO THE USER'S FILESYSTEM — on the executor's return, before `#onOutcome`'s `#settled`
    // latch is ever reached. A dispatch the grace window abandoned must not still deliver a file for a run
    // that already reported its terminal.
    //
    // The check is threaded INTO the write rather than only guarding its entry: `#performSaveTo` resolves a
    // template, de-inlines media and consults the store before it calls `mediaWrite`, and every one of those
    // is an await the cutoff can land inside. Guarding only the entry left a TOCTOU whose losing side is a
    // file on the user's disk.
    //
    // **Both fence paths return a FAILURE, not the completed outcome.** Returning `outcome` unchanged was
    // the first version and it defeated the fence it was part of: `#isLive` goes false the instant
    // `#onGraceElapsed` clears the dispatch map, which is BEFORE `#settled` is set and before the grace loop
    // reaches this vertex — so an output node still `running` at that moment passed `#onOutcome`'s status
    // guard and persisted `node:completed` for a deliverable that was never written. A `save_to` is a real
    // deliverable ({@link #performSaveTo}), so an unwritten one is a failed node, not a completed one.
    if (!this.#isLive(vertex.id, dispatchId)) {
      return { kind: 'failed', error: this.#saveToAbandoned() };
    }
    const failure = await this.#performSaveTo(config.node.save_to, outcome.output, () =>
      this.#isLive(vertex.id, dispatchId),
    );
    return failure === undefined ? outcome : { kind: 'failed', error: failure };
  }

  /**
   * The `save_to` write itself (1.AF/D16): resolve the template's `{{ run.id }}` to a relative path,
   * extract the SINGLE produced media handle from the (de-inlined) output, resolve it to bytes via the host
   * `MediaStore`, and write through the host media-write port. Returns `undefined` on success, else a typed,
   * secret-free {@link NodeFailure}. The bytes/handle/resolved-path never enter the message (I3).
   */
  async #performSaveTo(
    saveTo: string,
    output: unknown,
    stillOurs: () => boolean,
  ): Promise<NodeFailure | undefined> {
    const store = this.#host.mediaStore;
    const write = this.#host.mediaWrite;
    if (store === undefined || write === undefined) {
      return {
        code: 'validation',
        message:
          'an output node declares `save_to` but the host wired no media store / media-write port',
        retryable: false,
      };
    }
    try {
      // Resolve `save_to` with ONLY `run.id` in scope (no inputs/ctx/run.outputs): a filesystem path
      // template must not draw arbitrary authored data into the path. The host realpath+commonpath jail is
      // the binding control; this narrows the surface (defense-in-depth).
      const scope: RunScope = { inputs: {}, ctx: {}, outputs: {}, runId: this.runId };
      const relativePath = await resolveTemplate(saveTo, scope, {}, this.#abort.signal);
      // `output` arrives ALREADY PINNED from `#pinMediaOutput` at the dispatch boundary, so the handles are
      // simply read off it — no second de-inline, and no second fetch.
      //
      // **That double fetch was a real defect, not a tradeoff, once `CR-54` landed.** The note here used to
      // say a `url` part is fetched twice and shrug, on the grounds that a content-addressed `put` dedupes
      // the bytes. It does — for bytes that do not change. A drifting url returns different bytes on the
      // second fetch, and `CR-54` made the SECOND fetch's handle the one the durable record carries: so the
      // file written to the user's disk and the handle in the run history were different objects, and the
      // run reported `run:completed` over both. One pin upstream removes the second fetch entirely.
      const handles = collectDurableMediaHandles(output);
      if (handles.length !== 1) {
        return {
          code: 'validation',
          message:
            handles.length === 0
              ? 'output node `save_to`: the captured output contains no media handle to write'
              : `output node \`save_to\`: the captured output contains ${handles.length} media handles — save_to writes exactly one`,
          retryable: false,
        };
      }
      const [handle] = handles;
      if (handle === undefined) {
        return { code: 'internal', message: 'output node `save_to`: no handle', retryable: false }; // unreachable (length === 1)
      }
      const bytes = await store.get(handle.handle);
      // **The last check, immediately before the irreversible step.** Everything above is I/O — a template
      // resolve, a de-inline, a store read — and the cancellation cutoff can land inside any of it. A host
      // that honours its contract but treats the abort signal as advisory would otherwise write a file for a
      // run that had already reported its terminal.
      if (!stillOurs()) {
        // A FAILURE, not `undefined`. `undefined` is this method's success signal, so returning it here
        // told `#applySaveTo` the deliverable had been written — the same defect as the entry fence above,
        // one await later.
        return this.#saveToAbandoned();
      }
      await write(relativePath, bytes, this.#abort.signal);
      return undefined;
    } catch (error) {
      if (this.#abort.signal.aborted) {
        // A cancel / sibling-abort raced the write — surface a fatal cancel (never a retryable failure), so
        // the engine's cancel-wins precedence closes the run as cancelled / the sibling's cause.
        return { code: 'cancelled', message: 'the run was cancelled', retryable: false };
      }
      if (error instanceof InterpolationError) {
        // A bad `save_to` path TEMPLATE (e.g. a non-`run.id` reference that resolves to nothing) is an
        // authoring/validation fault, not an engine fault — classify it as `validation`, distinct from a
        // genuine write failure below. Secret-free: the template/value never enters the message.
        return {
          code: 'validation',
          message: 'output node `save_to`: the path template could not be resolved',
          retryable: false,
        };
      }
      return {
        code: 'internal',
        message: 'output node `save_to`: the media write failed',
        retryable: false,
      };
    }
  }

  /**
   * Record the producing run's reference for every durable media handle a just-stamped event carries
   * (1.AF/D12c, ADR-0042 §3). **Best-effort**: a collection or host-write failure is swallowed — it never
   * touches the I3 / gap-free / exactly-one-terminal guarantees (a missing ref only risks GC
   * over/under-retention). No-op without a `mediaReferences` host port or when the event carries no handle.
   */
  #recordProducedMedia(durable: RunEventDraft): void {
    const port = this.#host.mediaReferences;
    if (port === undefined) {
      return;
    }
    let produced: DurableMediaMeta[];
    try {
      produced = collectDurableMediaHandles(durable);
    } catch {
      return; // a collection failure is never fatal
    }
    for (const meta of produced) {
      this.#bestEffortMediaRef(() => port.recordRunMedia(meta, this.runId));
    }
  }

  /**
   * Hand a terminal the store refused to the host's outbox (ADR-0078 §4), swallowing its own failure.
   *
   * Best-effort by necessity, and the ADR says so: a host whose outbox write ALSO fails has no further
   * recourse — the run already reports `uncertain`, which is the honest floor. Throwing here would break
   * exactly-one-terminal on the way out of a path that exists to protect it, and `#emitDurable` must stay
   * total for the fire-and-forget `#loop`.
   */
  async #bestEffortOutbox(event: RunEvent): Promise<void> {
    try {
      await this.#host.terminalOutbox.put(event);
    } catch {
      // Nothing left to do. `#terminalDurability` is already `'uncertain'`, which is the report.
    }
  }

  /**
   * D11 terminal-state sweep: reclaim the run's `run`-kind media references at its terminal event (ADR-0042
   * §4), best-effort like {@link #recordProducedMedia}. A `session`/`workspace` reference (a read-grant)
   * survives the sweep, keeping shared media alive past the run.
   */
  #reclaimRunMedia(): void {
    const port = this.#host.mediaReferences;
    if (port === undefined) {
      return;
    }
    this.#bestEffortMediaRef(() => port.reclaimRun(this.runId));
  }

  /** Run a media-reference port call best-effort: a sync throw or an async rejection is swallowed, so a
   *  retention failure never breaks the run (the port is documented best-effort, ADR-0042 §3-4). */
  #bestEffortMediaRef(call: () => void | Promise<void>): void {
    try {
      const result = call();
      if (result instanceof Promise) {
        result.catch(() => undefined); // never an unhandled rejection
      }
    } catch {
      // best-effort retention; the run is unaffected (I3 / totality untouched)
    }
  }

  #elapsedMs(): number {
    return Date.parse(this.#host.clock.now()) - this.#startEpochMs;
  }
}

/**
 * The engine façade every surface drives: `start` / `resume` / `cancel`, plus `reconcile` for
 * crash recovery. Surface-agnostic and platform-free — host concerns (clock, ids, persistence) and
 * node execution are injected ({@link WorkflowEngineDeps}).
 */
/**
 * ADR-0085 §3's post-abort grace window, in milliseconds.
 *
 * **It bounds how long the engine waits for the EXECUTOR, not how long the terminal takes to become
 * durable.** That distinction is the whole of §3's scope: terminal durability belongs to ADR-0078's ordered
 * append and outbox, and a single `persistEvent` has a documented ~25 s worst case under contention
 * (database-schema.md). A window shorter than one legitimate durable write is correct for what it bounds and
 * would be absurd as a bound on settling.
 *
 * The value follows from what the window is FOR: cooperative unwinding after the executor has already been
 * told to stop — flushing a stream, closing an iterator, returning a failure. Not 2 000 ms (the CLI's
 * `FORCE_TEARDOWN_MS`, which waits on a child-process close, while a dispatch may be mid-await on a stream
 * ADR-0082 gives up to 120 s), and not 30 000 ms (half a minute after a cancel reads as the hang this
 * removes). It cannot be disabled: "unbounded" is the state being removed.
 */
const GRACE_WINDOW_MS = 10_000;

/**
 * What an abandoned node's `node:failed` says (ADR-0085 §4). Fixed text, not free prose: the code is
 * `cancelled`, which alone would read as "the user cancelled this node" when what happened is that the
 * engine stopped waiting for an executor that would not settle.
 */
const GRACE_ABANDON_MESSAGE =
  'the node did not settle within the grace period after the run was aborted; the engine stopped waiting';

export class WorkflowEngine {
  readonly #host: ExecutionHost;
  readonly #executor: NodeExecutor;
  readonly #validateEvents: boolean;
  readonly #capacity: number;
  readonly #resolverCapabilities: ResolverCapabilities;
  readonly #maxTokensEstimate: number;
  readonly #resolvePrice: PricingOverlay | undefined;
  // Stored + forwarded to every RunExecution, exactly like #resolvePrice. They reached this class through
  // WorkflowEngineDeps and then died here — the constructor never read them, so `start()`/`resumeFromCheckpoint()`
  // built a governor without an endpoint resolver (ADR-0071 §7 — the estimate assumed `official` and under-
  // authorized a custom-base_url turn) and without an unpriced sink (§K7 — the notice was dead on `run`/`gate`).
  readonly #resolveEndpoint: ((provider: ProviderId) => EndpointKind) | undefined;
  readonly #onUnpriced:
    | ((model: string, capMicrocents: number, modalities?: readonly MediaBilledModality[]) => void)
    | undefined;
  /**
   * The THIRD occurrence of the same bug the comment above records, found by the #W15-16 review: declared on
   * `WorkflowEngineDeps`, forwarded by `build-engine.ts` from a real `gate.ts` sentence, and never read here —
   * so the governor's hold notice was dead on `run` / `gate`. ADR-0074 §3 requires the legacy-media-job hold be
   * OBSERVABLE precisely so a resume is not a silent stall, and it was exactly that.
   */
  readonly #onLegacyMediaJobHold: ((nodeIds: readonly string[]) => void) | undefined;
  readonly #runs = new Map<string, RunExecution>();
  /**
   * Settled run ids in settle order — `CR-33`'s retention queue
   * ([ADR-0086](../../../docs/decisions/0086-absolute-admission-ceilings-on-authored-values.md)).
   *
   * **Count-based rather than age-based, and that is the decision.** An age policy needs a clock, and a
   * clock in `packages/core` means a new host seam for a bound that a count expresses exactly as well —
   * "the last N runs stay addressable" is a promise a caller can reason about, where "runs younger than T"
   * depends on how busy the process was. It also makes the eviction deterministic, so a test asserts it
   * rather than waiting for one.
   *
   * Only a run that actually SETTLED enters this queue. A parked run — waiting on a human gate or a media
   * job — is still live work this process owns, and evicting one would strand it.
   */
  readonly #settledOrder: string[] = [];
  /**
   * This engine instance's opaque identity as a lease holder (ADR-0079 §1).
   *
   * From `host.ids.newId()` rather than a process id: the engine is platform-free and has no notion of a
   * process, and two engines in ONE process must still be distinguishable — otherwise a second engine would
   * silently "renew" the first one's lease instead of being refused, which is the whole failure this closes.
   */
  readonly #ownerId: string;
  /** ADR-0080's per-node journal factory, threaded into every `RunExecution` this engine builds. */
  readonly #effectResume: EffectResumePort | undefined;
  readonly #effectJournalFactory:
    | ((correlation: EffectCorrelation) => EffectDispatchPort)
    | undefined;

  constructor(deps: WorkflowEngineDeps) {
    this.#host = deps.host;
    this.#executor = deps.executor;
    this.#validateEvents = deps.validateEvents ?? true;
    this.#capacity = deps.eventBufferCapacity ?? 256;
    this.#resolverCapabilities = deps.resolverCapabilities ?? {};
    this.#maxTokensEstimate = deps.maxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    this.#resolvePrice = deps.resolvePrice;
    this.#resolveEndpoint = deps.resolveEndpoint;
    this.#onUnpriced = deps.onUnpriced;
    this.#onLegacyMediaJobHold = deps.onLegacyMediaJobHold;
    this.#ownerId = deps.host.ids.newId();
    this.#effectJournalFactory = deps.effectJournal;
    this.#effectResume = deps.effectResume;
  }

  /**
   * Start a run. Builds the `RunPlan` (a {@link buildRunPlan} graph error throws here — a run never
   * starts on an invalid graph), then returns a {@link RunHandle} immediately; `run:started` and the
   * walk happen on the returned handle's stream (the handle subscribes before `run:started`, so the
   * consumer can attach lazily without a race).
   */
  start(input: StartInput): RunHandle {
    const plan = buildRunPlan(input.workflow, input.planOptions);
    // **Admission runs BEFORE the run id and before the first event** (ADR-0083 §1). That ordering is the
    // decision, not an implementation detail: a rejected run must leave no `runId`, no `run:started` and no
    // row, so a caller retrying with corrected inputs is not reasoning about a half-created run. It sits
    // after `buildRunPlan` because a graph fault is the more fundamental refusal and already throws here.
    const admitted = resolveAndValidateWorkflowInputs(input.workflow, input.inputs);
    if (!admitted.ok) {
      // The issues travel STRUCTURED on the error, and the message names only what admission guarantees is
      // echo-safe. An earlier version joined every `issue.name` into the message — but an unknown key is
      // caller-supplied and constrained by nothing, so that reintroduced one layer down the terminal-escape
      // path `workflow.ts` had just removed from the parser, with a strictly less trusted source.
      throw new EngineStateError(
        'input_admission_failed',
        `the supplied inputs do not satisfy this workflow's contract: ${admitted.issues
          .map((issue) =>
            issue.name === undefined ? issue.message : `${issue.name} — ${issue.message}`,
          )
          .join('; ')}`,
        { issues: admitted.issues },
      );
    }
    const runId = this.#host.ids.newId();
    const bus = new RunEventBus({ now: this.#host.clock.now, validate: this.#validateEvents });
    const execution = new RunExecution({
      runId,
      plan,
      workflow: input.workflow,
      // The ADMITTED map — defaults applied, validated, and built fresh rather than taken from the caller
      // (§7). Mutating the caller's object after `start()` returns cannot reach the run.
      inputs: admitted.inputs,
      executionMode: input.executionMode ?? 'local',
      host: this.#host,
      executor: this.#executor,
      bus,
      capacity: this.#capacity,
      onSettled: (settledRunId) => this.#retainSettled(settledRunId),
      ownerId: this.#ownerId,
      ...(this.#effectJournalFactory === undefined
        ? {}
        : { effectJournal: this.#effectJournalFactory }),
      ...(this.#effectResume === undefined ? {} : { effectResume: this.#effectResume }),
      resolverCapabilities: this.#resolverCapabilities,
      maxTokensEstimate: this.#maxTokensEstimate,
      ...(this.#resolvePrice === undefined ? {} : { resolvePrice: this.#resolvePrice }),
      ...(this.#resolveEndpoint === undefined ? {} : { resolveEndpoint: this.#resolveEndpoint }),
      ...(this.#onUnpriced === undefined ? {} : { onUnpriced: this.#onUnpriced }),
      ...(this.#onLegacyMediaJobHold === undefined
        ? {}
        : { onLegacyMediaJobHold: this.#onLegacyMediaJobHold }),
    });
    this.#runs.set(runId, execution);
    void execution.begin();
    return execution.handle;
  }

  /** Apply a gate decision and continue the run. Throws {@link EngineStateError} on a misuse. */
  async resume(runId: string, gateId: string, decision: GateDecision): Promise<void> {
    const parsed = GateDecisionSchema.safeParse(decision);
    if (!parsed.success) {
      throw new EngineStateError('invalid_decision', 'the gate decision failed validation', {
        runId,
        gateId,
      });
    }
    const execution = this.#runs.get(runId);
    if (execution === undefined) {
      throw new EngineStateError('unknown_run', 'no run matches the supplied runId', { runId });
    }
    await execution.resume(gateId, parsed.data);
  }

  /**
   * Resume a run suspended at a gate in a PRIOR process (1.R): reconstruct its {@link CheckpointState}
   * from the persisted event stream, rehydrate a {@link RunExecution} (seed node states / pending gates /
   * tallies / the sequence counter — no `run:started` is re-emitted), apply the gate decision, and return
   * the {@link RunHandle} so the caller observes the rest of the run.
   *
   * Idempotent re-delivery is a no-op (never advances the run twice; never re-emits a terminal event):
   * - if the checkpoint is already **terminal** (the run finished in the prior process), a closed handle
   *   is returned and nothing is re-emitted or re-persisted;
   * - if the target gate was already **resolved** but the run has not finished (a remaining gate, or
   *   downstream work the prior process did not reach), the decision is NOT re-applied — the run is just
   *   driven forward.
   *
   * Throws `unknown_run` when no checkpoint exists, or `run_already_active` when the run is already in
   * memory (use {@link resume}). Within a single process the same guarantee holds via {@link resume}; the cross-process
   * guarantee is bounded by the store's durable single-writer of `human_gate:resumed` per gate — a true
   * concurrent double-resolve (two processes loading the same pending gate before either persists) is
   * closed by a Phase-2 store-level uniqueness constraint, not the in-memory reference (checkpoint.ts).
   */
  /**
   * Why the lease could not be taken — naming the holder and WHEN, not just "shortly".
   *
   * `RunLeaseInfo` already carries `expiresAt`, so the bound on the wait is free, and it is the difference
   * between a caller that can back off intelligently and one that guesses. The holder id is opaque by design
   * ([ADR-0079](../../../../docs/decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §1 —
   * an owner is a process, not a name), so the deadline is the only concrete thing this message can offer.
   */
  async #ownedElsewhereMessage(runId: string): Promise<string> {
    const holder = await this.#host.runLeases.read(runId);
    if (holder === undefined) return 'another process owns this run';
    const seconds = Math.max(0, Math.ceil((holder.expiresAt - this.#nowMs()) / 1000));
    return `another process owns this run (held by ${holder.ownerId}) — retry once it finishes, or in at most ${String(seconds)}s when its lease expires`;
  }

  // One point over the threshold, and the branches ARE the ordering: the lease before any read,
  // the identity guard before the checkpoint, the checkpoint before the workflow. Each comment below states
  // which line it must precede, and a helper that hid one of those steps would make the sequence the reader
  // has to reconstruct rather than the one they can see (ADR-0079 §4, ADR-0083 §5).
  //
  // What CAN move out is a message the ordering does not depend on — see `#ownedElsewhereMessage`.
  async resumeFromCheckpoint(input: ResumeFromCheckpointInput): Promise<RunHandle> {
    // A gate resume supplies gateId + decision; a media-ONLY resume (1.AG Section D) supplies neither.
    const isGateResume = input.gateId !== undefined && input.decision !== undefined;
    assertValidResumeInput(input); // a half-supplied pair, or a malformed decision, is a caller misuse
    if (this.#runs.has(input.runId)) {
      throw new EngineStateError(
        'run_already_active',
        'the run is already in memory — use resume() rather than resumeFromCheckpoint()',
        { runId: input.runId },
      );
    }
    // **The lease is acquired BEFORE anything is read (ADR-0079 §4).** Not after the checkpoint, not after
    // the identity guard: a loser must never become a second producer even briefly, and every line below
    // this one is work only the owner is entitled to do. The refusal names the current holder, so the
    // message is actionable rather than "something else has it".
    const fence = await this.#host.runLeases.acquire(input.runId, this.#ownerId, RUN_LEASE_TTL_MS);
    if (fence === undefined) {
      throw new EngineStateError(
        'run_owned_elsewhere',
        await this.#ownedElsewhereMessage(input.runId),
        { runId: input.runId },
      );
    }
    // Every CALL between the acquire and `adoptLease` is wrapped — not just the awaits, and not just the ones
    // that refuse deliberately (ADR-0079 §4). A review measured two live leaks here: `checkpointer.load`
    // rejecting with ADR-0075's `UnreadableRunEventLogError` — which `createHistoryCheckpointer` is `async`
    // precisely to deliver — and `resolveWorkflowId` failing on any store fault. A second review then found a
    // third: a SYNCHRONOUS `RangeError` out of the content check, which the first version of this comment
    // invited by saying "every await" and counting only the async sites. Wrapped individually rather than by
    // one span around the whole preparation: the terminal branch below exits by RETURNING a closed handle, so
    // a single catch would have to model a non-throw exit, and a wrap at each site says that this line owns
    // the obligation.
    const checkpoint = await this.#releaseFenceOnThrow(input.runId, fence, () =>
      this.#host.checkpointer.load(input.runId),
    );
    if (checkpoint === undefined) {
      // Release what we just took: the run does not exist, so holding its lease would lock a runId nobody
      // can use. Every refusal below this point does the same — an acquire that leads nowhere must not leak.
      await this.#host.runLeases.release(input.runId, fence);
      throw new EngineStateError('unknown_run', 'no checkpoint exists for the supplied runId', {
        runId: input.runId,
      });
    }
    // Only CHECKPOINT_SCHEMA_VERSION (v1) exists today, so no migration/guard runs here yet. When the
    // derivation shape changes, this is the single point a future engine must refuse or migrate an older
    // `checkpoint.schemaVersion` before consuming the state (the field exists precisely for that, 1.R).
    // Identity guard: the workflow handed in must be the one the run started on. Comparing the surrogate
    // `workflows.id` UUID catches resuming the wrong workflow entirely (a different slug). A subtler
    // same-slug-edited-content drift needs a content hash on `run:started` — deferred (a canonical event
    // contract change; checkpoint.ts), so resuming an edited-but-same-slug workflow is the caller's risk.
    const expectedWorkflowId = await this.#releaseFenceOnThrow(input.runId, fence, () =>
      this.#host.store.resolveWorkflowId(input.workflow.workflow.id),
    );
    if (expectedWorkflowId !== checkpoint.workflowId) {
      await this.#host.runLeases.release(input.runId, fence);
      throw new EngineStateError(
        'workflow_mismatch',
        'the supplied workflow is not the one this run started on',
        { runId: input.runId },
      );
    }
    if (TERMINAL_RUN_STATUSES.has(checkpoint.runStatus)) {
      // The run already settled in the prior process — re-delivery is a safe no-op (the terminal event
      // is in the persisted log). Returning a closed handle avoids re-emitting/re-persisting a terminal.
      //
      // **Release first.** This is a refusal like the ones above, and §4's rule covers it: an acquire that
      // leads nowhere must not leak. Holding it would convert the documented idempotent no-op into a
      // transient refusal (exit 6) for a full TTL, over a run that has been over for hours, and leave a
      // `run_leases` row per re-delivery that nothing ever deletes.
      await this.#host.runLeases.release(input.runId, fence);
      return createClosedRunHandle(input.runId);
    }
    // **The graph's CONTENT, not just its id (ADR-0083 §5).** The surrogate-id guard above catches resuming
    // the wrong workflow entirely; it cannot catch the same slug with edited content, which its own comment
    // named and deferred to a content hash. The frozen definition answers it — it lives in `runs`, not in the
    // event log, which is why `RunStore` grew one read method for it. A store that holds no snapshot answers
    // `undefined`, and content verification is skipped with that fact stated rather than silently absent.
    const frozenWorkflow = await this.#releaseFenceOnThrow(input.runId, fence, () =>
      this.#host.store.readWorkflowSnapshot(input.runId),
    );
    if (frozenWorkflow !== undefined) {
      // Wrapped like every other call in this region — not because it is async (it is not) but because the
      // region's obligation is about THROWS, and a synchronous one leaks exactly as thoroughly. This was the
      // one bare call between `acquire` and `adoptLease`, and it was the one processing untrusted durable
      // data; the guard inside it is the primary fix and this is the belt.
      const contentRefusal = await this.#releaseFenceOnThrow(input.runId, fence, () =>
        verifyFrozenWorkflowContent(frozenWorkflow, input.workflow),
      );
      if (contentRefusal !== undefined) {
        await this.#host.runLeases.release(input.runId, fence);
        throw new EngineStateError(contentRefusal.code, contentRefusal.message, {
          runId: input.runId,
        });
      }
    }
    // **Identity, verified rather than assumed (ADR-0083 §5/§6/§8).** The caller's `inputs` and
    // `executionMode` used to be taken on trust, under an interface note that called it "the caller's
    // responsibility" — so a `relavium gate` in a fresh process that reconstructed either one differently,
    // or simply passed `{}`, continued the run under a state its own `run:started` never had. The record
    // folded from that event is the authority; the caller's copy is checked against it and then discarded.
    // Wrapped too: it is documented to RETURN every refusal, but it walks a caller-supplied map, and an
    // exotic value's trap can throw out of `deepStructuralEquals` no matter how carefully the entry guards.
    const identity = await this.#releaseFenceOnThrow(input.runId, fence, () =>
      verifyResumeIdentity({
        workflow: input.workflow,
        recordedInputs: checkpoint.admittedInputs,
        recordedExecutionMode: checkpoint.executionMode,
        suppliedInputs: input.inputs,
        suppliedExecutionMode: input.executionMode,
      }),
    );
    if (!identity.ok) {
      // §5: a refusal releases the lease. Every identity check sits after ownership was acquired, and
      // ADR-0079 §4's rule — an acquire that leads nowhere must not leak — covers these exactly as it
      // covers `workflow_mismatch` above.
      await this.#host.runLeases.release(input.runId, fence);
      throw new EngineStateError(identity.refusal.code, identity.refusal.message, {
        runId: input.runId,
      });
    }
    // From here to `adoptLease`, ANY throw must release the claim — `buildRunPlan` on an edited workflow and
    // the `RunExecution` constructor's checkpoint rehydration both throw outside the try below, and both
    // used to strand the lease for a TTL. The claim about the CONSTRUCTOR was false until now: only
    // `buildRunPlan` was wrapped, while `new RunExecution(...)` — which runs `#seedFromCheckpoint`, including
    // `#restoreParkedMediaJob` — sat bare. The comment and the code had disagreed since `cf93e32`.
    const plan = await this.#releaseFenceOnThrow(input.runId, fence, () =>
      buildRunPlan(input.workflow, input.planOptions),
    );
    const bus = new RunEventBus({ now: this.#host.clock.now, validate: this.#validateEvents });
    const execution = await this.#releaseFenceOnThrow(
      input.runId,
      fence,
      () =>
        new RunExecution({
          runId: input.runId,
          plan,
          workflow: input.workflow,
          // The VERIFIED record, not the caller's map — built fresh with a null prototype by the same §7
          // discipline `start()` uses, so a resume and a start hand `RunExecution` the same shape.
          inputs: identity.inputs,
          // **Inert on this path today, and said out loud rather than assumed pinned.** `#executionMode` is read
          // in exactly one place — the `run:started` emit — which a resume does not repeat, so no engine-level
          // test can distinguish this line from the `?? 'local'` default it replaces; a review measured the whole
          // suite staying green under that revert. What IS pinned is the DECISION (`verifyResumeIdentity`'s unit
          // tests) and the REFUSAL (`execution_mode_mismatch`, end to end). The moment anything downstream reads
          // the mode, this is the line that has to be right, which is why it is the recorded value and not a
          // default.
          executionMode: identity.executionMode,
          ownerId: this.#ownerId,
          ...(this.#effectJournalFactory === undefined
            ? {}
            : { effectJournal: this.#effectJournalFactory }),
          ...(this.#effectResume === undefined ? {} : { effectResume: this.#effectResume }),
          host: this.#host,
          executor: this.#executor,
          bus,
          capacity: this.#capacity,
          onSettled: (settledRunId) => this.#retainSettled(settledRunId),
          resolverCapabilities: this.#resolverCapabilities,
          maxTokensEstimate: this.#maxTokensEstimate,
          ...(this.#resolvePrice === undefined ? {} : { resolvePrice: this.#resolvePrice }),
          ...(this.#resolveEndpoint === undefined
            ? {}
            : { resolveEndpoint: this.#resolveEndpoint }),
          ...(this.#onUnpriced === undefined ? {} : { onUnpriced: this.#onUnpriced }),
          ...(this.#onLegacyMediaJobHold === undefined
            ? {}
            : { onLegacyMediaJobHold: this.#onLegacyMediaJobHold }),
          checkpoint,
        }),
    );
    this.#runs.set(input.runId, execution);
    try {
      // beginResume re-resolves the workflow context (not checkpointed) then drives: kick if the gate was
      // already resolved in the prior process (no re-apply), else apply the decision. A media-ONLY resume
      // (no gate) re-attaches + re-polls the parked job(s). The events buffer on the returned handle.
      // The engine acquired this fence before the checkpoint was read (§4); the execution adopts it rather
      // than acquiring again — a second acquire would bump the generation and fence the engine's own
      // in-flight claim, which is the subtlest way to get this wrong.
      execution.adoptLease(fence);
      if (isGateResume && input.gateId !== undefined && input.decision !== undefined) {
        await execution.beginResume(
          input.gateId,
          input.decision,
          checkpoint.resolvedGateIds.includes(input.gateId),
        );
      } else {
        await execution.beginResumeMediaJobs();
      }
    } catch (error) {
      // resume() validates the gate AFTER rehydration; an unknown_gate / run_not_paused /
      // pending_gate_requires_decision throw must not strand the half-initialized execution in #runs (a retry
      // would then wrongly hit run_already_active) NOR leave its armed timers firing — the constructor's
      // #seedFromCheckpoint already armed a media-poll timer per parked job and beginResume* armed the
      // run-timeout. Abandon (disarm + abort) BEFORE dropping it, else an orphan poll would later hit the
      // provider for a run the caller saw rejected (and a natural retry could double-attach the same jobId).
      execution.abandon();
      this.#runs.delete(input.runId);
      await this.#host.runLeases.release(input.runId, fence);
      throw error;
    }
    // **No release here — the resumed execution owns its own lease lifetime now.**
    //
    // This is where a `#releaseIfIdle(input.runId, fence)` used to sit, and it was wrong in a way worth
    // recording: `beginResume` returns as soon as the resume has been KICKED, not when the run has finished
    // or re-parked. Releasing on that return handed the lease back while the run was still executing, so the
    // resumed leg's very next durable write was fenced out by its own release — every cross-process gate
    // resume stopped dead with no terminal and hung its caller.
    //
    // Ownership is given up at the two moments the process actually stops working on the run, both inside
    // the execution where that is observable: `#emitPausedOnce` releases on a gate park (§4), and `#settle`
    // releases after the terminal is durable. A run abandoned without reaching either is covered by the TTL,
    // which is what the TTL is for.
    return execution.handle;
  }

  /** Request cooperative cancellation. Throws {@link EngineStateError} for an unknown/terminal run. */
  cancel(runId: string): void {
    const execution = this.#runs.get(runId);
    if (execution === undefined) {
      throw new EngineStateError('unknown_run', 'no run matches the supplied runId', { runId });
    }
    execution.requestCancel();
  }

  /**
   * Crash reconciliation (startup). For every run the store reports as interrupted-and-not-resumable
   * (started, no terminal event, not parked at a gate), persist a terminal `run:failed{internal}`
   * continuing that run's `sequenceNumber` — so a crashed run never lingers as a stuck `run:started`.
   * Returns the reconciled events. Resumable runs (parked at a gate) are left for `resume`.
   */
  async reconcile(): Promise<readonly RunEvent[]> {
    // **Drain the outbox FIRST (ADR-0078 §4), and the order is load-bearing.** A crashed process leaves its
    // terminal here; if reconciliation ran first it would see a run with no durable terminal, conclude it
    // needs repair, and write `run:failed{internal}` for a run that actually COMPLETED — the exact
    // divergence the outbox exists to close, reintroduced by ordering. §3's "no terminal present" condition
    // makes the two writers safe within one process; across processes only this order does.
    const interrupted = await this.#host.store.listInterruptedRuns();
    const reconciled: RunEvent[] = [...(await this.#drainTerminalOutbox(interrupted))];
    for (const run of interrupted) {
      if (run.resumable) {
        // A run parked at a gate is intentionally left for the checkpoint/resume path (1.R):
        // rehydrating its full RunExecution from the persisted step_executions + run_events is the
        // Checkpointer's job, not 1.N's, and failing it here would destroy the resumability 1.R
        // restores. Until 1.R wires that rehydration, resume() on a not-yet-rehydrated run throws
        // unknown_run by design — never silently, and never a corrupted half-run.
        continue;
      }
      // **Never terminate a run another process is working on (ADR-0079 §7).** `reconcile()` writes a
      // terminal for every non-resumable interrupted run, and it runs from a process that may not own any of
      // them. A run holding a LIVE lease is mid-execution somewhere else — leaving it interrupted is correct,
      // because whoever owns it will settle it.
      //
      // An EXPIRED lease is taken over rather than ignored, and the takeover is what makes this safe: the
      // acquire bumps the generation, so if the dead owner ever wakes, its every write is fenced. Reconciling
      // under the old generation would leave a zombie able to append past the terminal written here.
      const fence = await this.#claimForReconcile(run.runId);
      if (fence === undefined) continue;
      const event = RunEventSchema.parse({
        type: 'run:failed',
        runId: run.runId,
        timestamp: this.#host.clock.now(),
        sequenceNumber: run.lastSequenceNumber + 1,
        error: {
          code: 'internal',
          message: 'the run was interrupted before completion and reconciled on restart',
          retryable: false,
          correlationId: this.#host.ids.newId(), // matches the #settle / node:failed live-failure paths
        },
        partialOutputs: {},
      });
      try {
        // **`reconcile()` is a SECOND durable write path** — it bypasses `#emitDurable` entirely, so every
        // property established at that choke point has to be re-established here or it holds for one of two
        // writers (ADR-0078 §3). It passes the guard with the belief it actually has: `listInterruptedRuns`
        // read `lastSequenceNumber` from the durable rows, so a run another process has since advanced —
        // or settled — makes this append fail closed instead of appending a second terminal past it.
        await this.#host.store.persistEvent(event, {
          expectedLastSequenceNumber: run.lastSequenceNumber,
          fence,
        });
        reconciled.push(event);
        // Reclaim the crashed run's media references at this terminal (1.AF/D11, ADR-0042 §4): a
        // non-resumable run never ran its in-process #reclaimRunMedia (the process died), and reconcile()
        // bypasses #emitDurable, so without this the run's `run`-kind refs survive forever and the partial
        // media is never GC-eligible (refcount stuck > 0). Best-effort + idempotent like the in-process
        // sweep — a retention failure must never abandon reconciliation (mirrors RunExecution's
        // #bestEffortMediaRef; reclaimRun on a run with no rows is a harmless no-op).
        this.#bestEffortReclaim(run.runId);
      } catch {
        // A store fault reconciling one run must not abandon the rest: skip it (it stays interrupted
        // and is retried on the next reconcile). Reconciliation is best-effort and idempotent.
      } finally {
        // Give the takeover claim back either way. The run is settled (nothing left to own) or the write
        // failed (the next reconcile re-claims, bumping the generation again) — holding it would only block
        // the retry for a TTL. The generation still only moves forward, so nothing is un-fenced by this.
        await this.#releaseReconcileClaim(run.runId, fence);
      }
    }
    return reconciled;
  }

  /**
   * Take ownership of an interrupted run so it can be reconciled, or decline it (ADR-0079 §7).
   *
   * Returns `undefined` — "leave this run alone" — whenever the takeover does not succeed, which is exactly
   * when another process holds a LIVE lease on the run. That is `acquire`'s own rule ("a different owner
   * holding a live lease is the only refusal"), so the acquire IS the check; an expired lease is a takeover
   * that bumps the generation, which is what fences the dead owner if it ever wakes.
   *
   * Deliberately not a `read` followed by an `acquire`. The read would be redundant with the refusal and,
   * worse, not atomic with it — the lease can expire or change hands between the two, so the pair can decide
   * on a state that no longer holds while the acquire alone decides inside one transaction.
   */
  /** Epoch-ms now, derived from the host's ISO clock — core has no second notion of time (ADR-0079 §6). */
  #nowMs(): number {
    return Date.parse(this.#host.clock.now());
  }

  /**
   * Retain a settled run, and evict the oldest once more than
   * {@link ADMISSION_CEILINGS.retainedSettledRuns} are held (`CR-33`).
   *
   * **What eviction costs, stated rather than discovered.** A retained settled run exists so `resume` and
   * `cancel` can answer `run_already_terminal` instead of `unknown_run` — that is the whole reason the map
   * kept them. After eviction those calls report `unknown_run`, which is a less specific answer to a
   * question about a run that finished long ago. That is the trade a bound buys: without it a long-lived
   * host running many workflows grows forever, and "forever" is not a nicer answer to anything.
   *
   * The run's OUTCOME is not lost — it is in the durable log, which is where a surface reads a finished
   * run's result from anyway (`relavium logs <runId>`). Only the in-memory shortcut goes.
   *
   * **It also drops `resumeFromCheckpoint`'s `run_already_active` guard for that run**, which the first
   * version of this comment did not say. That is a convenience refusal rather than a safety one, and the
   * safety it looks like it provides lives elsewhere: `resumeFromCheckpoint` independently refuses a
   * checkpoint whose `runStatus` is terminal and returns a closed handle. The one shape that slips through
   * is a run whose terminal WRITE failed — `durability: 'uncertain'`, terminal held in the outbox — where the
   * checkpoint does not yet read terminal. Re-driving that run is what `reconcile()` exists to do, so the
   * outcome is the intended recovery rather than a hazard; it is recorded here because a reader deciding
   * whether eviction is safe should not have to re-derive it.
   *
   * Idempotent on a repeated settle: `#settleFenced` and `#settle` can both reach `onSettled` for the same
   * run, and a second entry would evict a live run one slot early.
   */
  #retainSettled(runId: string): void {
    if (this.#settledOrder.includes(runId)) {
      return;
    }
    this.#settledOrder.push(runId);
    while (this.#settledOrder.length > ADMISSION_CEILINGS.retainedSettledRuns) {
      const evicted = this.#settledOrder.shift();
      if (evicted !== undefined) {
        this.#runs.delete(evicted);
      }
    }
  }

  async #claimForReconcile(runId: string): Promise<RunFence | undefined> {
    // **Never claim a run THIS engine is executing.** `acquire`'s refusal rule is "a different owner holding
    // a live lease", so for our OWN runs it is not a refusal at all — it is a renewal that bumps the
    // generation, which would fence our live execution out at its next write and then delete its row in the
    // caller's `finally`. The lease cannot express this because the two claimants share an `ownerId`; the
    // in-memory run table can, and it is the authority on what this process is running.
    if (this.#runs.has(runId)) return undefined;
    try {
      return await this.#host.runLeases.acquire(runId, this.#ownerId, RUN_LEASE_TTL_MS);
    } catch {
      // A lease port that cannot be reached is not licence to reconcile blind — the whole point is to avoid
      // terminating somebody else's run, and an unreachable lease means we cannot tell. Fail closed.
      return undefined;
    }
  }

  /**
   * Run `body`, releasing the resume-path lease if it throws (ADR-0079 §4: "every refusal path also releases
   * what it just took"). The claim was taken before the checkpoint was read, so every exit between there and
   * `adoptLease` owns that obligation — including the ones that throw rather than return.
   *
   * **`return await`, not `return`.** The signature already returned a `Promise`, but the body was returned
   * un-awaited — so a REJECTING async body skipped the catch entirely and stranded the claim for a full TTL.
   * Latent while the only caller was the synchronous `buildRunPlan`; the store read this now also guards is
   * genuinely async, and a helper whose whole job is "release on throw" must not have a class of throw it
   * cannot see.
   */
  async #releaseFenceOnThrow<T>(
    runId: string,
    fence: RunFence,
    body: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await body();
    } catch (error) {
      await this.#releaseReconcileClaim(runId, fence);
      throw error;
    }
  }

  /** Hand back a reconcile takeover claim; a failure only costs a TTL, never correctness. */
  async #releaseReconcileClaim(runId: string, fence: RunFence): Promise<void> {
    try {
      await this.#host.runLeases.release(runId, fence);
    } catch {
      // Left to expire on its own TTL — slower, never wrong.
    }
  }

  /**
   * Retry every terminal a prior process could not write, and forget the ones that no longer need retrying.
   *
   * **A drained entry is reconciled against the log, not replayed blindly.** An entry whose run already
   * carries a durable terminal is DROPPED rather than appended — the original write may have committed and
   * only its acknowledgement been lost, and appending would break exactly-one-terminal in the other
   * direction. That check is why this reads the run's events before writing anything.
   *
   * Best-effort throughout: a store still refusing, or an outbox that cannot be read, leaves the entry for
   * the next start. Nothing here may throw, because `reconcile()` must repair every OTHER run even when one
   * of them cannot be repaired.
   */
  /**
   * Retry every terminal a prior process could not write — the PUBLIC entry point, and it exists because
   * without one the mechanism was unreachable.
   *
   * `reconcile()` drains as its first step, but `reconcile()` has no shipping caller: it also REPAIRS every
   * interrupted run, which is a much larger behaviour to switch on, so no surface has ever called it. That
   * left `CR-92`'s outbox written, tested, certified — and dead. A user who saw the `uncertain` exit code had
   * no command that would ever move their run to `durable`, while the exit code's own documentation said one
   * would. Draining is the narrow half a surface can call at start with no other consequence: it writes only
   * terminals the engine itself already produced, and only for runs whose log still lacks one.
   */
  async drainTerminalOutbox(): Promise<readonly RunEvent[]> {
    const interrupted = await this.#host.store.listInterruptedRuns();
    return this.#drainTerminalOutbox(interrupted);
  }

  async #drainTerminalOutbox(interrupted: readonly InterruptedRun[]): Promise<readonly RunEvent[]> {
    let held: readonly RunEvent[];
    try {
      held = await this.#host.terminalOutbox.list();
    } catch {
      return [];
    }
    // `listInterruptedRuns` is the port's own answer to "does this run still lack a terminal" — a run that
    // has one is not in it. Using it rather than adding a read method keeps the drain inside the three
    // methods `RunStore` already declares, which is what lets a Phase-2 cloud store implement this at all.
    const stillOpen = new Map(interrupted.map((r) => [r.runId, r]));
    const written: RunEvent[] = [];
    for (const event of held) {
      const runId = event.runId;
      if (runId === undefined) continue;
      const open = stillOpen.get(runId);
      if (open === undefined) {
        // Either the terminal DID land and only its acknowledgement was lost, or the run has no durable
        // `run:started` at all. Both mean appending would make things worse — a second terminal in the first
        // case, a headless log in the second — so the entry is dropped, never replayed.
        await this.#forgetOutbox(runId);
        continue;
      }
      // **A run another process is actively running must not receive a DEAD process's terminal.** The same
      // §7 hazard `reconcile()` has, and it is sharper here: the held event is a terminal a crashed process
      // built from ITS view of the run. If a live owner has since resumed that run — a gate resume, say —
      // writing this would durably contradict the run it is finishing right now. Left in the outbox and
      // re-evaluated on the next start, when it will almost always be dropped as already-terminal.
      const fence = await this.#claimForReconcile(runId);
      if (fence === undefined) continue;
      try {
        await this.#host.store.persistEvent(event, {
          expectedLastSequenceNumber: open.lastSequenceNumber,
          fence,
        });
        await this.#forgetOutbox(runId);
        // The D11 terminal sweep, exactly as `reconcile()`'s own repair arm does it (ADR-0042 §4). The
        // crashed process never ran its in-process reclaim — that is why the terminal is here — so without
        // this the run's media references survive forever and its partial media is never GC-eligible.
        this.#bestEffortReclaim(runId);
        written.push(event);
      } catch {
        // Still unwritable, or another process moved the log first. The entry stays for the next start; the
        // run keeps reporting `uncertain`.
      } finally {
        await this.#releaseReconcileClaim(runId, fence);
      }
    }
    return written;
  }

  /** Drop an outbox entry, swallowing a failure — a stale entry costs one read next start, never a wrong terminal. */
  async #forgetOutbox(runId: string): Promise<void> {
    try {
      await this.#host.terminalOutbox.remove(runId);
    } catch {
      // Nothing to do; the next drain re-evaluates it against the log and drops it again.
    }
  }

  /** Best-effort terminal media-ref reclaim for a reconciled run — swallows a sync throw + an async
   *  rejection so retention never breaks reconciliation (ADR-0042 §3-4; retention is never run-correctness). */
  #bestEffortReclaim(runId: string): void {
    const port = this.#host.mediaReferences;
    if (port === undefined) {
      return;
    }
    try {
      const result = port.reclaimRun(runId);
      if (result instanceof Promise) {
        result.catch(() => undefined);
      }
    } catch {
      // best-effort retention; reconciliation is unaffected
    }
  }
}
