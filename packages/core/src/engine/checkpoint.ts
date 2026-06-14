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
}

/** The derived state a rehydrating run is rebuilt from — never a persisted blob (reconstructed from rows). */
export interface CheckpointState {
  readonly schemaVersion: number;
  readonly runStatus: RunStatus;
  /** Per-vertex settled/paused state; a vertex absent here is `pending` (never started, or running at crash). */
  readonly nodeStates: ReadonlyMap<string, CheckpointNodeState>;
  /** Convenience projection of the `completed` vertices (the engine derives `pending` from the plan). */
  readonly completedNodeIds: readonly string[];
  /** Gates still pending a decision — the run is resumable via `engine.resume(runId, gateId, decision)`. */
  readonly pendingGates: readonly CheckpointPendingGate[];
  /** The highest persisted `sequenceNumber` — the resumed run seeds its counter to this + 1 (gap-free). */
  readonly lastSequenceNumber: number;
}

/**
 * The read port that reconstructs a run's {@link CheckpointState} from persisted rows. Returns
 * `undefined` for a run with no `run:started` (unknown / never-persisted). 1.N's {@link RunStore} is
 * write+enumerate only; this is the 1.R read side, kept a separate port (single responsibility).
 */
export interface Checkpointer {
  load: (runId: string) => Promise<CheckpointState | undefined>;
}

/**
 * Pure reconstruction: fold the ordered event stream into a {@link CheckpointState}. Total + deterministic
 * (same events → same state — the basis of idempotent resume). The caller passes events in persisted
 * (sequence) order; this does not re-sort (the store/bus already guarantee order).
 */
export function reconstructCheckpointState(
  events: readonly RunEvent[],
): CheckpointState | undefined {
  let started = false;
  let runStatus: RunStatus = 'running';
  let lastSequenceNumber = -1;
  const nodeStates = new Map<string, CheckpointNodeState>();
  const pendingGates = new Map<string, string>(); // gateId → nodeId

  for (const event of events) {
    lastSequenceNumber = Math.max(lastSequenceNumber, event.sequenceNumber);
    switch (event.type) {
      case 'run:started':
        started = true;
        runStatus = 'running';
        break;
      case 'run:paused':
        runStatus = 'paused';
        break;
      case 'run:completed':
        runStatus = 'completed';
        break;
      case 'run:failed':
        runStatus = 'failed';
        break;
      case 'run:cancelled':
        runStatus = 'cancelled';
        break;
      case 'node:completed':
        nodeStates.set(event.nodeId, {
          status: 'completed',
          output: event.output,
          ...(event.selected === undefined ? {} : { selectedTargets: event.selected }),
        });
        break;
      case 'node:failed':
        nodeStates.set(event.nodeId, {
          status: 'failed',
          error: {
            code: event.error.code,
            message: event.error.message,
            retryable: event.error.retryable,
          },
        });
        break;
      case 'node:skipped':
        nodeStates.set(event.nodeId, { status: 'skipped' });
        break;
      case 'human_gate:paused':
        nodeStates.set(event.nodeId, { status: 'paused' });
        pendingGates.set(event.gateId, event.nodeId);
        break;
      case 'human_gate:resumed':
        // The decision IS the gate vertex's output (engine resume: output = payload ?? { decision }).
        nodeStates.set(event.nodeId, {
          status: 'completed',
          output: event.payload === undefined ? { decision: event.decision } : event.payload,
        });
        for (const [gateId, nodeId] of pendingGates) {
          if (nodeId === event.nodeId) {
            pendingGates.delete(gateId);
          }
        }
        break;
      default:
        // node:started (no terminal yet → omit, re-run), agent:*/cost:*/budget:* — not state-bearing here.
        break;
    }
  }

  if (!started) {
    return undefined;
  }
  const completedNodeIds = [...nodeStates]
    .filter(([, s]) => s.status === 'completed')
    .map(([id]) => id);
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runStatus,
    nodeStates,
    completedNodeIds,
    pendingGates: [...pendingGates].map(([gateId, nodeId]) => ({ gateId, nodeId })),
    lastSequenceNumber,
  };
}
