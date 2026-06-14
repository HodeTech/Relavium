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
  RunEventSchema,
  type ExecutionMode,
  type GateDecision,
  type MaskedSecret,
  type NodeSkippedReason,
  type RunEvent,
  type RunStatus,
  type TokensUsed,
} from '@relavium/shared';

import { buildRunPlan, type BuildRunPlanOptions } from '../dag.js';
import type { PlanVertex, RunPlan } from '../run-plan.js';
import type { WorkflowDefinition } from '../parser.js';
import { EngineStateError } from './errors.js';
import { RunEventBus, type RunEventDraft } from './event-bus.js';
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

/** The terminal `RunStatus` values — a checkpoint in one of these is a finished run (1.R resume no-op). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'failed',
  'cancelled',
]);

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

  readonly #abort: AbortControllerLike;
  readonly #states = new Map<string, VertexState>();
  readonly #pendingGates = new Map<string, { readonly vertexId: string }>();
  /** Gate ids whose decision was already applied — a re-delivery is an idempotent no-op (1.R). */
  readonly #resolvedGates = new Set<string>();
  /** Disarm callbacks for armed gate-timeout timers, by gateId — disarmed on resume / settle (1.Q). */
  readonly #gateTimers = new Map<string, () => void>();

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
    try {
      this.#workflowId = await this.#host.store.resolveWorkflowId(this.#workflow.workflow.id);
      await this.#emitDurable({
        type: 'run:started',
        runId: this.runId,
        workflowId: this.#workflowId,
        inputs: this.#maskedInputs,
        executionMode: this.#executionMode,
      });
      this.#schedule();
    } catch {
      // Could not even start the run (e.g. the store rejected) — close with the single terminal event
      // rather than leaving a started-but-never-finished run. Never swallowed: it becomes run:failed.
      await this.#settle('run:failed');
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
      this.#pendingGates.set(gate.gateId, { vertexId: gate.nodeId });
    }
    for (const gateId of cp.resolvedGateIds) {
      this.#resolvedGates.add(gateId);
    }
    this.#totalInputTokens = cp.totalInputTokens;
    this.#totalOutputTokens = cp.totalOutputTokens;
    this.#cumulativeCostMicrocents = cp.cumulativeCostMicrocents;
    // Post-resume events continue gap-free from the last persisted sequence number.
    bus.seedSequence(runId, cp.lastSequenceNumber + 1);
    // Keep measuring durationMs from the ORIGINAL start, so a resumed run's terminal reports total
    // wall-clock (pre- + post-resume), not just the post-resume segment. NO `run:started` is re-emitted —
    // it is already in the persisted log.
    this.#startEpochMs = cp.startedAtMs;
  }

  /**
   * Drive a rehydrated run forward WITHOUT applying a gate decision — used by `resumeFromCheckpoint`
   * when the target gate was already resolved in the prior process (a cross-process double-delivery):
   * the decision must not be re-applied (no second `human_gate:resumed`), but the run still continues
   * any unfinished downstream work, or re-pauses on a remaining gate. The terminal-checkpoint case never
   * reaches here (it returns a closed handle); so this only ever finds work to do or another gate.
   */
  kick(): void {
    this.#schedule();
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
    this.#resolvedGates.add(gateId);
    this.#pendingGates.delete(gateId);
    this.#disarmTimer(gateId); // a decision arrived before the timeout — cancel the armed timer (1.Q)
    this.#pauseEpisode = false; // a later idle-with-gates re-emits run:paused for the remaining gates
    // Mark the gate vertex completed SYNCHRONOUSLY before the await — mirroring #settleCompleted — so a
    // concurrent #step (e.g. a sibling gate's timeout firing during this persist) never sees this gate as
    // still `paused` while it is already out of #pendingGates, which would mis-read the run as stalled.
    const state = this.#states.get(gate.vertexId);
    if (state !== undefined) {
      state.status = 'completed';
      state.output = decision.payload ?? { decision: decision.decision };
    }
    await this.#emitDurable({
      type: 'human_gate:resumed',
      runId: this.runId,
      nodeId: gate.vertexId,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
      ...(decision.payload === undefined ? {} : { payload: decision.payload }),
    });
    this.#schedule();
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
      void this.#execute(vertex);
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

  async #execute(vertex: PlanVertex): Promise<void> {
    const startedAtMs = this.#elapsedMs();
    let outcome: Awaited<ReturnType<NodeExecutor['execute']>>;
    try {
      const ctx: NodeExecContext = {
        vertex,
        runOutputs: this.#completedOutputs(),
        inputs: this.#inputs,
        secretInputNames: this.#secretInputNames,
        toolPolicy: this.#workflow.workflow.tools ?? {},
        emit: (event) => {
          this.#nodeEmit(event);
        },
        signal: this.#abort.signal,
        attemptNumber: 1,
      };
      outcome = await this.#executor.execute(ctx);
    } catch {
      // The catch-all: any uncaught throw from a node handler maps to a single internal failure
      // (a tool handler classifies its own failures as tool_failed; a sandbox throw as sandbox_error).
      outcome = {
        kind: 'failed',
        error: {
          code: 'internal',
          message: 'the node handler threw an unexpected error',
          retryable: false,
        },
      };
    }
    await this.#onOutcome(vertex, outcome, startedAtMs);
  }

  async #onOutcome(vertex: PlanVertex, outcome: NodeOutcome, startedAtMs: number): Promise<void> {
    if (this.#settled) {
      return; // terminal already emitted — ignore a late settle (e.g. an aborted straggler)
    }
    try {
      switch (outcome.kind) {
        case 'completed':
        case 'branch':
          await this.#settleCompleted(vertex, outcome, startedAtMs);
          break;
        case 'failed':
          await this.#settleFailed(vertex, outcome.error);
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
      // A condition's branch selection — persisted so resume can restore `selectedTargets` (1.R).
      ...(outcome.kind === 'branch' ? { selected: [...outcome.selected] } : {}),
    });
  }

  /** A `failed` outcome: record the root cause (cancel wins), then emit `node:failed`. */
  async #settleFailed(vertex: PlanVertex, error: NodeFailure): Promise<void> {
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
    });
  }

  /** A `paused` outcome: park the gate, arm its timeout timer (1.Q), and emit `human_gate:paused`. */
  async #settlePaused(vertex: PlanVertex, gate: GateRequest): Promise<void> {
    const gateId = gate.gateId ?? this.#host.ids.newId();
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'paused';
    }
    this.#pendingGates.set(gateId, { vertexId: vertex.id });
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
    // DELIVERY IS ORDERED BY sequenceNumber, not by persist-resolution order. `#bus.next` assigns the
    // seq synchronously in call order, and #emitDurable is invoked synchronously at the top of each
    // settle path before any await — so chaining each deliver onto a single per-run #deliveryTail makes
    // a higher-seq event wait for the lower-seq event's deliver. Persists stay concurrent; only delivery
    // is serialized. Without this, two concurrent leaf nodes under an ASYNC store (1.R SQLite, cloud)
    // could resolve out of order — delivering a later node:completed (or the terminal) first, closing
    // the stream, and dropping the earlier event (a gap-free / no-drop violation). InMemoryRunStore
    // resolves synchronously, which masks it; the seam exists precisely so an async store plugs in.
    const event = this.#bus.next(draft);
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
  readonly #runs = new Map<string, RunExecution>();

  constructor(deps: WorkflowEngineDeps) {
    this.#host = deps.host;
    this.#executor = deps.executor;
    this.#validateEvents = deps.validateEvents ?? true;
    this.#capacity = deps.eventBufferCapacity ?? 256;
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
      checkpoint,
    });
    this.#runs.set(input.runId, execution);
    try {
      if (checkpoint.resolvedGateIds.includes(input.gateId)) {
        // The gate was already resolved in the prior process (double-delivery); do not re-apply the
        // decision — just drive any unfinished downstream work (or re-pause on a remaining gate).
        execution.kick();
      } else {
        // Apply the decision + drive the loop (events buffer on the handle for the returned consumer).
        await execution.resume(input.gateId, parsed.data);
      }
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
