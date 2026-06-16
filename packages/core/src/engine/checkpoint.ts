/**
 * Checkpoint/resume (1.R) — the read-side that reconstructs a run's state from its persisted event
 * stream so a run interrupted (a crash, or suspended at a human gate) can resume without re-running the
 * work already done. There is **no checkpoint table** — the {@link CheckpointState} is *derived* from the
 * ordered `run_events` the {@link RunStore} already persists (ADR-0003; execution-model.md §5). The real
 * SQLite/cloud-backed `Checkpointer` is Phase-2/CLI; 1.R ships the in-memory reference
 * ({@link createInMemoryHost}).
 *
 * Reconstruction is a **pure replay**: walk the events in order and fold each into per-node state.
 * Crucially, a node that emitted `node:started` but no terminal event (it was running when the process
 * died) is simply ABSENT from {@link CheckpointState.nodeStates} — so the rehydrating engine seeds it
 * `pending` and re-runs it (a half-run side effect is bounded by the `runId+nodeId+retryCount`
 * idempotency key, not by skipping the node). A `condition`'s `selected` branch is restored from
 * `node:completed.selected` so a selected branch mid-flight at the crash re-runs rather than being
 * wrongly skip-propagated; the dimmed branches are restored from `node:skipped`.
 */

import type { RunEvent, RunStatus } from '@relavium/shared';

import type { NodeFailure } from './node-executor.js';

/** The schema version of the *derivation* (not a stored blob) — lets a later engine refuse/migrate it. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** The reconstructed terminal-or-paused state of one vertex (a still-running vertex is omitted — re-run). */
export interface CheckpointNodeState {
  readonly status: 'completed' | 'failed' | 'skipped' | 'paused';
  /** The node output, for a `completed` vertex (incl. a resumed gate's decision payload). */
  readonly output?: unknown;
  /** The failure, for a `failed` vertex. */
  readonly error?: NodeFailure;
  /** A `completed` `condition`'s selected immediate target ids — restores `selectedTargets` on resume. */
  readonly selectedTargets?: readonly string[];
}

/** A gate still awaiting a decision at the checkpoint — the run resumes by applying a `GateDecision`. */
export interface CheckpointPendingGate {
  readonly gateId: string;
  readonly nodeId: string;
  /** True for a budget gate, so a rejected decision can still fail the run on resume. */
  readonly isBudgetGate: boolean;
}

/** The derived state a rehydrating run is rebuilt from — never a persisted blob (reconstructed from rows). */
export interface CheckpointState {
  readonly schemaVersion: number;
  readonly runStatus: RunStatus;
  /** The surrogate `workflows.id` UUID from `run:started` — resume refuses a different workflow (identity guard). */
  readonly workflowId: string;
  /** `run:started.timestamp` as epoch ms — the resumed run keeps measuring `durationMs` from the ORIGINAL
   *  start, so a terminal event reports total wall-clock across the pre- and post-resume segments. */
  readonly startedAtMs: number;
  /** Per-vertex settled/paused state; a vertex absent here is `pending` (never started, or running at crash). */
  readonly nodeStates: ReadonlyMap<string, CheckpointNodeState>;
  /** Convenience projection of the `completed` vertices (the engine derives `pending` from the plan). */
  readonly completedNodeIds: readonly string[];
  /** Gates still pending a decision — the run is resumable via `engine.resume(runId, gateId, decision)`. */
  readonly pendingGates: readonly CheckpointPendingGate[];
  /** Gate ids ALREADY resolved (a `human_gate:resumed` was persisted) — so re-delivering a decision after a
   *  reconnect is an idempotent no-op rather than advancing the run twice (execution-model.md §gate). */
  readonly resolvedGateIds: readonly string[];
  /** The highest persisted `sequenceNumber` — the resumed run seeds its counter to this + 1 (gap-free). */
  readonly lastSequenceNumber: number;
  /** Running token totals (summed from `node:completed`), restored so a resumed run's `run:completed` totals stay correct. */
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** The last `cost:updated.cumulativeCostMicrocents` (a running total), restored so post-resume cost stays cumulative. */
  readonly cumulativeCostMicrocents: number;
}

/**
 * The read port that reconstructs a run's {@link CheckpointState} from persisted rows. Returns
 * `undefined` for a run with no `run:started` (unknown / never-persisted). 1.N's {@link RunStore} is
 * write+enumerate only; this is the 1.R read side, kept a separate port (single responsibility).
 */
export interface Checkpointer {
  load: (runId: string) => Promise<CheckpointState | undefined>;
}

/** The mutable fold accumulator, threaded through the per-category appliers below. */
interface ReconAccumulator {
  started: boolean;
  workflowId: string;
  startedAtMs: number;
  runStatus: RunStatus;
  lastSequenceNumber: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cumulativeCostMicrocents: number;
  readonly nodeStates: Map<string, CheckpointNodeState>;
  readonly pendingGates: Map<string, { nodeId: string; isBudgetGate: boolean }>;
  readonly resolvedGateIds: Set<string>;
}

const RUN_STATUS_BY_EVENT: Partial<Record<RunEvent['type'], RunStatus>> = {
  'run:paused': 'paused',
  'run:completed': 'completed',
  'run:failed': 'failed',
  'run:cancelled': 'cancelled',
};

/** Run-level lifecycle: capture start identity/clock and fold the run status. */
function applyRunEvent(acc: ReconAccumulator, event: RunEvent): void {
  if (event.type === 'run:started') {
    acc.started = true;
    acc.workflowId = event.workflowId;
    acc.startedAtMs = Date.parse(event.timestamp);
    acc.runStatus = 'running';
    return;
  }
  const status = RUN_STATUS_BY_EVENT[event.type];
  if (status !== undefined) {
    acc.runStatus = status;
  }
}

/** Node-level settlements: completed (+ branch selection, token tally), failed, skipped. */
function applyNodeEvent(acc: ReconAccumulator, event: RunEvent): void {
  switch (event.type) {
    case 'node:completed':
      acc.nodeStates.set(event.nodeId, {
        status: 'completed',
        output: event.output,
        ...(event.selected === undefined ? {} : { selectedTargets: event.selected }),
      });
      acc.totalInputTokens += event.tokensUsed.input;
      acc.totalOutputTokens += event.tokensUsed.output;
      // Restore the run-wide cumulative cost from the durable node boundary (cost:updated is streamed, not
      // persisted, so it is otherwise lost on a plain-human-gate / crash resume). `Math.max` keeps it
      // monotonic and order-independent — it reconciles with the `budget:paused.spentMicrocents` restore
      // (applyGateEvent) regardless of which durable cost source has the higher sequence number.
      if (event.cumulativeCostMicrocents !== undefined) {
        acc.cumulativeCostMicrocents = Math.max(
          acc.cumulativeCostMicrocents,
          event.cumulativeCostMicrocents,
        );
      }
      break;
    case 'node:failed':
      acc.nodeStates.set(event.nodeId, {
        status: 'failed',
        error: {
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable,
        },
      });
      break;
    case 'node:skipped':
      acc.nodeStates.set(event.nodeId, { status: 'skipped' });
      break;
    default:
      // node:started (running at crash → omit, re-run) and node:retrying (a non-terminal retry attempt,
      // 1.S/ADR-0040 — the terminal is a later node:failed/node:completed) are non-state-bearing here.
      break;
  }
}

/** Human-gate / budget-gate lifecycle: park a pending gate, or resolve it (decision becomes the gate vertex output). */
function applyGateEvent(acc: ReconAccumulator, event: RunEvent): void {
  if (event.type === 'human_gate:paused' || event.type === 'budget:paused') {
    acc.nodeStates.set(event.nodeId, { status: 'paused' });
    acc.pendingGates.set(event.gateId, {
      nodeId: event.nodeId,
      // A budget gate emits BOTH `budget:paused` then a companion `human_gate:paused` with the SAME gateId
      // (engine `#settlePaused`). OR the flag so the later human_gate:paused never downgrades a budget gate
      // to a plain human gate on reconstruction — else a resumed `rejected` budget gate would not fail the
      // run with `budget_exceeded` (the resume reject branch is gated on `isBudgetGate`).
      isBudgetGate:
        acc.pendingGates.get(event.gateId)?.isBudgetGate === true || event.type === 'budget:paused',
    });
    // `cost:updated` is streamed (not persisted), so the running cost is otherwise unrecoverable on resume;
    // but `budget:paused.spentMicrocents` IS the durable cumulative-at-pause. Restore it so a resumed budgeted
    // run keeps its spend and the re-seeded governor blocks correctly (H2). (A budgeted run that paused at a
    // *plain human* gate still loses its cost on resume — cost-event persistence is the deferred general fix.)
    if (event.type === 'budget:paused') {
      acc.cumulativeCostMicrocents = event.spentMicrocents;
    }
    return;
  }
  if (event.type !== 'human_gate:resumed') {
    return;
  }
  // The decision IS the gate vertex's output (engine resume: output = payload ?? { decision }).
  acc.nodeStates.set(event.nodeId, {
    status: 'completed',
    output: event.payload === undefined ? { decision: event.decision } : event.payload,
  });
  // Collect this gate's pending ids first, then mutate — never delete while iterating the Map.
  const resolvedForNode = [...acc.pendingGates]
    .filter(([, entry]) => entry.nodeId === event.nodeId)
    .map(([gateId]) => gateId);
  for (const gateId of resolvedForNode) {
    acc.pendingGates.delete(gateId);
    acc.resolvedGateIds.add(gateId);
  }
}

/**
 * Pure reconstruction: fold the ordered event stream into a {@link CheckpointState}. Total + deterministic
 * (same events → same state — the basis of idempotent resume). The caller passes events in persisted
 * (sequence) order; this does not re-sort (the store/bus already guarantee order). The per-category
 * appliers ({@link applyRunEvent} / {@link applyNodeEvent} / {@link applyGateEvent}) keep this fold flat.
 */
export function reconstructCheckpointState(
  events: readonly RunEvent[],
): CheckpointState | undefined {
  const acc: ReconAccumulator = {
    started: false,
    workflowId: '',
    startedAtMs: 0,
    runStatus: 'running',
    lastSequenceNumber: -1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cumulativeCostMicrocents: 0,
    nodeStates: new Map(),
    pendingGates: new Map(),
    resolvedGateIds: new Set(),
  };

  for (const event of events) {
    acc.lastSequenceNumber = Math.max(acc.lastSequenceNumber, event.sequenceNumber);
    if (event.type === 'cost:updated') {
      acc.cumulativeCostMicrocents = event.cumulativeCostMicrocents; // already a running total
    }
    applyRunEvent(acc, event);
    applyNodeEvent(acc, event);
    applyGateEvent(acc, event);
  }

  if (!acc.started) {
    return undefined;
  }
  const completedNodeIds = [...acc.nodeStates]
    .filter(([, s]) => s.status === 'completed')
    .map(([id]) => id);
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runStatus: acc.runStatus,
    workflowId: acc.workflowId,
    startedAtMs: acc.startedAtMs,
    nodeStates: acc.nodeStates,
    completedNodeIds,
    pendingGates: [...acc.pendingGates].map(([gateId, entry]) => ({
      gateId,
      nodeId: entry.nodeId,
      isBudgetGate: entry.isBudgetGate,
    })),
    resolvedGateIds: [...acc.resolvedGateIds],
    lastSequenceNumber: acc.lastSequenceNumber,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    cumulativeCostMicrocents: acc.cumulativeCostMicrocents,
  };
}
