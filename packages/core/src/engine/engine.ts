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
  GateDecisionSchema,
  RETRYABLE_ERROR_CODES,
  RunEventSchema,
  containsDurableUnsafeMedia,
  deInlineMedia,
  type ExecutionMode,
  type GateDecision,
  type MaskedSecret,
  type NodeSkippedReason,
  type Retry,
  type RunEvent,
  type RunStatus,
  type TokensUsed,
} from '@relavium/shared';

import { buildRunPlan, type BuildRunPlanOptions } from '../dag.js';
import { resolveContext } from '../interpolation/resolve.js';
import type { ResolverCapabilities } from '../interpolation/scope.js';
import type { PlanVertex, RunPlan } from '../run-plan.js';
import type { WorkflowDefinition } from '../parser.js';
import { EngineStateError } from './errors.js';
import { RunEventBus, type RunEventDraft } from './event-bus.js';
import { RunLoopInvariantError } from './invariant-error.js';
import { BudgetGovernor, DEFAULT_MAX_TOKENS_ESTIMATE } from './budget-governor.js';
import type { CheckpointState } from './checkpoint.js';
import type { AbortControllerLike, ExecutionHost } from './execution-host.js';
import type {
  GateRequest,
  NodeExecContext,
  NodeExecutor,
  NodeFailure,
  NodeOutcome,
  NodeStreamEvent,
} from './node-executor.js';
import { createClosedRunHandle, createRunHandle, type RunHandle } from './run-handle.js';

/** A vertex's live status in one run. `paused` (at a gate) and `running` are not yet *settled*. */
type VertexStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'paused';

interface VertexState {
  status: VertexStatus;
  output?: unknown;
  /** For a settled `condition`: the immediate target ids it selected (the live out-edges). */
  selectedTargets?: ReadonlySet<string>;
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
 * **Invariant (caller's responsibility):** `workflow`, `inputs`, `executionMode`, and `planOptions` must
 * be the SAME values the run started with. The checkpoint persists the workflow identity (verified — a
 * mismatch throws `workflow_mismatch`) but does not yet persist `inputs` / `executionMode`, so passing
 * different ones would silently diverge the rehydrated execution from its `run:started` state. A future
 * revision will reconstruct these from the checkpoint and ignore the caller-supplied values.
 */
export interface ResumeFromCheckpointInput {
  readonly runId: string;
  /** The workflow to resume against — the engine refuses one whose identity differs (workflow_mismatch). */
  readonly workflow: WorkflowDefinition;
  /** MUST match the run's original inputs (not yet checkpoint-derived — see the interface note). */
  readonly inputs?: Readonly<Record<string, unknown>>;
  /** MUST match the run's original mode (not yet checkpoint-derived — see the interface note). */
  readonly executionMode?: ExecutionMode;
  readonly planOptions?: BuildRunPlanOptions;
  /** The gate to resolve + the decision to apply (the run was suspended at this gate). */
  readonly gateId: string;
  readonly decision: GateDecision;
}

/** Construction dependencies for the engine — the injected host and node-executor seams. */
export interface WorkflowEngineDeps {
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
  /** The run-level wall-clock timeout timer, when a `timeout_ms` is configured (ADR-0028). */
  #runTimeoutDisarm: (() => void) | undefined;
  /** The pre-egress budget governor, when a workflow `budget` is configured (ADR-0028, 1.AC). */
  readonly #budgetGovernor: BudgetGovernor | undefined;
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
  /** Serializes event DELIVERY by sequenceNumber so an async store can't deliver events out of order. */
  #deliveryTail: Promise<void> = Promise.resolve();
  #startEpochMs = 0;
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
    resolverCapabilities: ResolverCapabilities;
    maxTokensEstimate?: number;
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
    this.#abort = params.host.newAbortController();

    const secretNames = new Set(
      (params.workflow.workflow.inputs ?? [])
        .filter((input) => input.type === 'secret')
        .map((input) => input.name),
    );
    this.#secretInputNames = secretNames;
    this.#maskedInputs = maskInputs(params.inputs, secretNames);
    this.#maxTokensEstimate = params.maxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
    if (params.plan.budget !== undefined) {
      this.#budgetGovernor = new BudgetGovernor({
        budget: params.plan.budget,
        defaultMaxTokensEstimate: this.#maxTokensEstimate,
        emit: (draft) => this.#emitDurable({ ...draft, runId: this.runId }),
      });
    }

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
    );
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
    } catch {
      // Could not even start the run (e.g. the store rejected) — close with the single terminal event
      // rather than leaving a started-but-never-finished run. Never swallowed: it becomes run:failed.
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
    this.#runTimeoutDisarm = this.#host.setTimer(timeoutMs, () => {
      void this.#onRunTimeout(timeoutMs);
    });
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
    await this.#emitDurable({
      type: 'run:timeout',
      runId: this.runId,
      elapsedMs,
      timeoutMs,
    });
    if (!this.#settled) {
      this.#failure = {
        error: {
          code: 'run_timeout',
          message: `the run exceeded its ${timeoutMs} ms timeout`,
          retryable: false,
        },
      };
      this.#abort.abort();
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
    }
    for (const gate of cp.pendingGates) {
      // No gate-timeout timer is re-armed on rehydration: the gate this resume targets has its decision
      // applied immediately. Re-arming a *remaining* gate's deadline is deferred to the Phase-2
      // crash-reconciliation that re-arms from persisted policy + a real clock (shared-core-engine.md) —
      // the data it needs (timeoutAction + expiresAt) is now carried on `human_gate:paused`, so no backfill.
      this.#pendingGates.set(gate.gateId, {
        vertexId: gate.nodeId,
        isBudgetGate: gate.isBudgetGate,
      });
    }
    for (const gateId of cp.resolvedGateIds) {
      this.#resolvedGates.add(gateId);
    }
    this.#totalInputTokens = cp.totalInputTokens;
    this.#totalOutputTokens = cp.totalOutputTokens;
    this.#cumulativeCostMicrocents = cp.cumulativeCostMicrocents;
    // Re-seed the budget governor with the restored cumulative cost (H2): it starts at 0 and only advances
    // on `cost:updated`, which a resume does NOT replay — so without this a resumed budgeted run would
    // under-block by up to ~a full cap on its first post-resume pre-egress check (ADR-0028).
    this.#budgetGovernor?.updateCost(cp.cumulativeCostMicrocents);
    // Post-resume events continue gap-free from the last persisted sequence number.
    bus.seedSequence(runId, cp.lastSequenceNumber + 1);
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
    if (!(await this.#resolveContextOrFail())) {
      await this.#settle(this.#cancelling ? 'run:cancelled' : 'run:failed');
      return;
    }
    if (gateAlreadyResolved) {
      this.#schedule();
    } else {
      await this.resume(gateId, decision);
    }
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

  async resume(gateId: string, decision: GateDecision): Promise<void> {
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
    const gate = this.#assertGatePending(gateId);
    this.#resolvedGates.add(gateId);
    this.#pendingGates.delete(gateId);
    this.#disarmTimer(gateId); // a decision arrived before the timeout — cancel the armed timer (1.Q)
    this.#pauseEpisode = false; // a later idle-with-gates re-emits run:paused for the remaining gates

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
    const state = this.#states.get(gate.vertexId);
    if (state !== undefined) {
      state.status = 'completed';
      state.output = decision.payload ?? { decision: decision.decision };
    }
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
        ...(decision.payload === undefined ? {} : { payload: decision.payload }),
      });
    } catch {
      if (this.#failure === undefined && !this.#cancelling) {
        this.#failure = {
          nodeId: gate.vertexId,
          error: {
            code: 'internal',
            message: 'the gate decision payload could not be made durable-safe',
            retryable: false,
          },
        };
        this.#abort.abort();
      }
    }
    this.#schedule();
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

    const ready = this.#claimReady(running);
    if (ready.length === 0) {
      await this.#handleIdle(running);
      return;
    }
    // The vertices are already marked `running` (claimed synchronously above), so these awaits cannot
    // make a later step see a transient "nothing running" view.
    for (const vertex of ready) {
      await this.handle.whenConsumersReady(); // coarse backpressure (no-drop)
      await this.#emitDurable({
        type: 'node:started',
        runId: this.runId,
        nodeId: vertex.id,
        nodeType: vertex.type,
      });
      void this.#dispatch(vertex, 1);
    }
  }

  /** Nothing was ready this step: while idle, pause if a gate pends, else stall loudly (invariant). */
  async #handleIdle(running: number): Promise<void> {
    if (running > 0) {
      return; // still executing — wait for the next settlement to re-evaluate
    }
    if (this.#pendingGates.size > 0) {
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
  #claimReady(alreadyRunning: number): PlanVertex[] {
    const cap = this.#plan.maxParallel ?? Number.POSITIVE_INFINITY;
    const claimed: PlanVertex[] = [];
    let running = alreadyRunning;
    for (const vertexId of this.#plan.order) {
      if (running >= cap) {
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
   * Dispatch a vertex with its above-chain node-retry budget (1.S, ADR-0040). The vertex stays `running`
   * across the whole loop — including the backoff sleep — so it never frees its slot or lets the run go
   * idle mid-retry. Attempt 1's `node:started` was emitted by `#step`; this loop emits `node:started` for
   * each re-dispatch. A retryable failure within budget (and admitted by `retry_on`) emits a non-terminal
   * `node:retrying`, sleeps the backoff (abort-aware — cancel wins), and re-runs; any other outcome (or an
   * exhausted budget, or a fatal/`retry_on`-excluded failure) settles via `#onOutcome`.
   *
   * Trade-off: a node waiting out its backoff keeps occupying a `max_parallel` slot (it stays `running`), so
   * under a tight cap a long `backoff_ms` can serialize otherwise-ready sibling branches (ADR-0040 A.3 — keep
   * `backoff_ms` modest under a tight cap). Freeing the slot mid-backoff would re-introduce the idle race.
   */
  async #dispatch(vertex: PlanVertex, firstAttempt: number): Promise<void> {
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
      const outcome = await this.#runAttempt(vertex, attempt, budgetApproved);
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
        await this.#onOutcome(vertex, outcome, startedAtMs, attempt);
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
   * it sees the run's current cumulative cost and may emit a one-time `budget:warning` or throw
   * `BudgetExceededError` / `BudgetPauseError` for `fail` / `pause_for_approval`.
   */
  #makePreEgressHook(): import('./agent-turn.js').PreEgressHook | undefined {
    if (this.#budgetGovernor === undefined) {
      return undefined;
    }
    const governor = this.#budgetGovernor;
    return (info) => governor.checkPreEgress(info.model, info.maxTokens);
  }

  /** Run one attempt of a vertex; returns its outcome (an uncaught handler throw → a single `internal`). */
  async #runAttempt(
    vertex: PlanVertex,
    attemptNumber: number,
    budgetApproved: boolean,
  ): Promise<NodeOutcome> {
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
          this.#nodeEmit(event);
        },
        signal: this.#abort.signal,
        attemptNumber,
        ...(preEgress === undefined ? {} : { preEgress }),
      };
      return await this.#executor.execute(ctx);
    } catch {
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
  ): Promise<void> {
    if (this.#settled) {
      return; // terminal already emitted — ignore a late settle (e.g. an aborted straggler)
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
      }
    } catch {
      // Backstop for an UNEXPECTED throw while settling a node — e.g. a bus/Zod stamp failure on a
      // malformed event. (A durable persist rejection no longer reaches here: #emitDurable is total.)
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
      const disarm = this.#host.setTimer(gate.timeoutMs, () => {
        void this.#onGateTimeout(gateId, vertex.id, effectiveAction);
      });
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
    if (state?.status === 'running') {
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
    await this.#emitDurable({
      type: 'run:paused',
      runId: this.runId,
      pendingGateCount: gateIds.length,
      gateIds,
    });
  }

  async #settle(type: 'run:completed' | 'run:failed' | 'run:cancelled'): Promise<void> {
    if (this.#settled) {
      return; // exactly-one-terminal-event: idempotent
    }
    this.#settled = true;
    this.#abort.abort(); // make sure any straggler executor sees cancellation
    // The run is closing — no gate timer may fire afterwards (1.Q). Disarm each, then clear in one shot.
    for (const disarm of this.#gateTimers.values()) {
      disarm();
    }
    this.#gateTimers.clear();
    this.#budgetApprovedVertices.clear(); // drop any unconsumed budget-approval (a sibling failure/cancel
    // can settle the run between resume() arming it and the re-dispatch — no stale entry on the retained run)
    this.#disarmRunTimeout();
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
      };
    } else {
      draft = { type, runId: this.runId };
    }
    await this.#emitDurable(draft);
    this.#onSettled(this.runId);
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

  #nodeEmit(event: NodeStreamEvent): void {
    const runId = this.runId;
    // The non-cost cases all pass through with only the correlation key added — `{ ...event, runId }`
    // distributes the object spread over the case-narrowed union, so a shared fallthrough body keeps
    // each member's required fields (no cast). `cost:updated` is the one exception: the engine owns the
    // run-wide `cumulativeCostMicrocents` (a per-node executor cannot know it), so it is recomputed here
    // authoritatively rather than passed through.
    switch (event.type) {
      case 'agent:token':
      case 'agent:tool_call':
      case 'agent:tool_result':
      case 'agent:file_patch_proposed':
        this.#bus.emit({ ...event, runId });
        return;
      case 'cost:updated':
        this.#cumulativeCostMicrocents += event.costMicrocents;
        this.#budgetGovernor?.updateCost(this.#cumulativeCostMicrocents);
        this.#bus.emit({
          ...event,
          runId,
          cumulativeCostMicrocents: this.#cumulativeCostMicrocents,
        });
        return;
    }
  }

  async #emitDurable(draft: RunEventDraft): Promise<void> {
    // Persist the boundary/terminal event, then deliver (ADR-0036 persist-before-deliver, so a crash
    // can never re-run a completed node or lose its output). This method is **total**: a store fault
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
    // event's deliver. Persists stay concurrent; only delivery is serialized. (The de-inline `await`
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
    const event = this.#bus.next(durable);
    const prior = this.#deliveryTail;
    const settled = (async (): Promise<void> => {
      try {
        await this.#host.store.persistEvent(event);
      } catch {
        if (!TERMINAL_TYPES.has(event.type) && this.#failure === undefined && !this.#cancelling) {
          this.#failure = {
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
      await prior; // deliver in seq order: the lower-seq event's deliver must land first
      this.#bus.deliver(event);
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
      return (await deInlineMedia(draft, store)) as RunEventDraft;
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

  #elapsedMs(): number {
    return Date.parse(this.#host.clock.now()) - this.#startEpochMs;
  }
}

/**
 * The engine façade every surface drives: `start` / `resume` / `cancel`, plus `reconcile` for
 * crash recovery. Surface-agnostic and platform-free — host concerns (clock, ids, persistence) and
 * node execution are injected ({@link WorkflowEngineDeps}).
 */
export class WorkflowEngine {
  readonly #host: ExecutionHost;
  readonly #executor: NodeExecutor;
  readonly #validateEvents: boolean;
  readonly #capacity: number;
  readonly #resolverCapabilities: ResolverCapabilities;
  readonly #maxTokensEstimate: number;
  readonly #runs = new Map<string, RunExecution>();

  constructor(deps: WorkflowEngineDeps) {
    this.#host = deps.host;
    this.#executor = deps.executor;
    this.#validateEvents = deps.validateEvents ?? true;
    this.#capacity = deps.eventBufferCapacity ?? 256;
    this.#resolverCapabilities = deps.resolverCapabilities ?? {};
    this.#maxTokensEstimate = deps.maxTokensEstimate ?? DEFAULT_MAX_TOKENS_ESTIMATE;
  }

  /**
   * Start a run. Builds the `RunPlan` (a {@link buildRunPlan} graph error throws here — a run never
   * starts on an invalid graph), then returns a {@link RunHandle} immediately; `run:started` and the
   * walk happen on the returned handle's stream (the handle subscribes before `run:started`, so the
   * consumer can attach lazily without a race).
   */
  start(input: StartInput): RunHandle {
    const plan = buildRunPlan(input.workflow, input.planOptions);
    const runId = this.#host.ids.newId();
    const bus = new RunEventBus({ now: this.#host.clock.now, validate: this.#validateEvents });
    const execution = new RunExecution({
      runId,
      plan,
      workflow: input.workflow,
      inputs: input.inputs ?? {},
      executionMode: input.executionMode ?? 'local',
      host: this.#host,
      executor: this.#executor,
      bus,
      capacity: this.#capacity,
      onSettled: () => {
        /* settled runs are retained so resume/cancel can report run_already_terminal; a long-lived
           host may prune them on a TTL — out of 1.N scope. */
      },
      resolverCapabilities: this.#resolverCapabilities,
      maxTokensEstimate: this.#maxTokensEstimate,
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
  async resumeFromCheckpoint(input: ResumeFromCheckpointInput): Promise<RunHandle> {
    const parsed = GateDecisionSchema.safeParse(input.decision);
    if (!parsed.success) {
      throw new EngineStateError('invalid_decision', 'the gate decision failed validation', {
        runId: input.runId,
        gateId: input.gateId,
      });
    }
    if (this.#runs.has(input.runId)) {
      throw new EngineStateError(
        'run_already_active',
        'the run is already in memory — use resume() rather than resumeFromCheckpoint()',
        { runId: input.runId },
      );
    }
    const checkpoint = await this.#host.checkpointer.load(input.runId);
    if (checkpoint === undefined) {
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
    const expectedWorkflowId = await this.#host.store.resolveWorkflowId(input.workflow.workflow.id);
    if (expectedWorkflowId !== checkpoint.workflowId) {
      throw new EngineStateError(
        'workflow_mismatch',
        'the supplied workflow is not the one this run started on',
        { runId: input.runId },
      );
    }
    if (TERMINAL_RUN_STATUSES.has(checkpoint.runStatus)) {
      // The run already settled in the prior process — re-delivery is a safe no-op (the terminal event
      // is in the persisted log). Returning a closed handle avoids re-emitting/re-persisting a terminal.
      return createClosedRunHandle(input.runId);
    }
    const plan = buildRunPlan(input.workflow, input.planOptions);
    const bus = new RunEventBus({ now: this.#host.clock.now, validate: this.#validateEvents });
    const execution = new RunExecution({
      runId: input.runId,
      plan,
      workflow: input.workflow,
      inputs: input.inputs ?? {},
      executionMode: input.executionMode ?? 'local',
      host: this.#host,
      executor: this.#executor,
      bus,
      capacity: this.#capacity,
      onSettled: () => {
        /* retained like a started run (see start) */
      },
      resolverCapabilities: this.#resolverCapabilities,
      maxTokensEstimate: this.#maxTokensEstimate,
      checkpoint,
    });
    this.#runs.set(input.runId, execution);
    try {
      // beginResume re-resolves the workflow context (not checkpointed) then drives: kick if the gate was
      // already resolved in the prior process (no re-apply), else apply the decision. The events buffer on
      // the returned handle for the consumer.
      await execution.beginResume(
        input.gateId,
        parsed.data,
        checkpoint.resolvedGateIds.includes(input.gateId),
      );
    } catch (error) {
      // resume() validates the gate AFTER rehydration; an unknown_gate / run_not_paused throw must not
      // strand the half-initialized execution in #runs (a retry would then wrongly hit run_already_active).
      this.#runs.delete(input.runId);
      throw error;
    }
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
    const interrupted = await this.#host.store.listInterruptedRuns();
    const reconciled: RunEvent[] = [];
    for (const run of interrupted) {
      if (run.resumable) {
        // A run parked at a gate is intentionally left for the checkpoint/resume path (1.R):
        // rehydrating its full RunExecution from the persisted step_executions + run_events is the
        // Checkpointer's job, not 1.N's, and failing it here would destroy the resumability 1.R
        // restores. Until 1.R wires that rehydration, resume() on a not-yet-rehydrated run throws
        // unknown_run by design — never silently, and never a corrupted half-run.
        continue;
      }
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
        await this.#host.store.persistEvent(event);
        reconciled.push(event);
      } catch {
        // A store fault reconciling one run must not abandon the rest: skip it (it stays interrupted
        // and is retried on the next reconcile). Reconciliation is best-effort and idempotent.
      }
    }
    return reconciled;
  }
}
