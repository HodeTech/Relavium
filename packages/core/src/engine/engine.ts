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
  type RunEvent,
  type TokensUsed,
} from '@relavium/shared';

import { buildRunPlan, type BuildRunPlanOptions } from '../dag.js';
import type { PlanVertex, RunPlan } from '../run-plan.js';
import type { WorkflowDefinition } from '../parser.js';
import { EngineStateError } from './errors.js';
import { RunEventBus, type RunEventDraft } from './event-bus.js';
import type { AbortControllerLike, ExecutionHost } from './execution-host.js';
import type {
  GateRequest,
  NodeExecContext,
  NodeExecutor,
  NodeFailure,
  NodeOutcome,
  NodeStreamEvent,
} from './node-executor.js';
import { createRunHandle, type RunHandle } from './run-handle.js';

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
  const masked: Record<string, unknown> = {};
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
  readonly #executionMode: ExecutionMode;
  readonly #host: ExecutionHost;
  readonly #executor: NodeExecutor;
  readonly #bus: RunEventBus;
  readonly #onSettled: (runId: string) => void;

  readonly #abort: AbortControllerLike;
  readonly #states = new Map<string, VertexState>();
  readonly #pendingGates = new Map<string, { readonly vertexId: string }>();

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
    this.#maskedInputs = maskInputs(params.inputs, secretNames);

    for (const id of params.plan.vertices.keys()) {
      this.#states.set(id, { status: 'pending' });
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
    this.#pendingGates.delete(gateId);
    this.#pauseEpisode = false; // a later idle-with-gates re-emits run:paused for the remaining gates
    await this.#emitDurable({
      type: 'human_gate:resumed',
      runId: this.runId,
      nodeId: gate.vertexId,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
      ...(decision.payload === undefined ? {} : { payload: decision.payload }),
    });
    const state = this.#states.get(gate.vertexId);
    if (state !== undefined) {
      state.status = 'completed';
      state.output = decision.payload ?? { decision: decision.decision };
    }
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
    this.#propagateSkips();
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

  /** A `paused` outcome: park the gate and emit `human_gate:paused`. */
  async #settlePaused(vertex: PlanVertex, gate: GateRequest): Promise<void> {
    const gateId = gate.gateId ?? this.#host.ids.newId();
    const state = this.#states.get(vertex.id);
    if (state !== undefined) {
      state.status = 'paused';
    }
    this.#pendingGates.set(gateId, { vertexId: vertex.id });
    await this.#emitDurable({
      type: 'human_gate:paused',
      runId: this.runId,
      nodeId: vertex.id,
      gateId,
      gateType: gate.gateType,
      message: gate.message,
      ...(gate.assignee === undefined ? {} : { assignee: gate.assignee }),
      ...(gate.timeoutMs === undefined ? {} : { timeoutMs: gate.timeoutMs }),
      ...(gate.expiresAt === undefined ? {} : { expiresAt: gate.expiresAt }),
    });
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

  #propagateSkips(): void {
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
        changed = true;
      }
    }
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
    const outputs: Record<string, unknown> = {};
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
    // The four non-cost cases look identical, but each must NARROW `event` to a single union member so
    // the `{ ...event, runId }` spread keeps that member's required fields — spreading the union value
    // directly collapses to its common fields (a type error), and bridging that with a cast would
    // violate the no-unsafe-`as` rule. So the apparent duplication is the type-safe choice. The engine
    // owns the run-wide `cumulativeCostMicrocents` (a per-node executor cannot know it), so cost is
    // recomputed here authoritatively; the rest pass through with only the correlation key added.
    switch (event.type) {
      case 'agent:token':
        this.#bus.emit({ ...event, runId });
        return;
      case 'agent:tool_call':
        this.#bus.emit({ ...event, runId });
        return;
      case 'agent:tool_result':
        this.#bus.emit({ ...event, runId });
        return;
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
