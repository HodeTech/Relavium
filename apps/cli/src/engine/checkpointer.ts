import { reconstructCheckpointState, type Checkpointer } from '@relavium/core';
import type { RunHistoryStore } from '@relavium/db';

/**
 * A {@link Checkpointer} that rebuilds a run's `CheckpointState` from the durable event log (2.H) — the read
 * side of cross-process gate resume (**2.G**). `engine.resumeFromCheckpoint(runId, …)` calls
 * `host.checkpointer.load(runId)` to seed the rehydrated run; for the SQLite {@link RunHistoryStore} that is
 * `loadRunEvents(runId)` folded through {@link reconstructCheckpointState} — the **same** 1.R reconstruction
 * the engine's in-memory checkpointer uses, but over persisted rows instead of an in-process buffer (so a
 * `relavium gate` in a fresh process sees the state a prior `relavium run` left behind). Returns `undefined`
 * for a run with no persisted `run:started` (unknown / never-persisted), exactly as the port specifies.
 */
export function createHistoryCheckpointer(store: RunHistoryStore): Checkpointer {
  return {
    load: (runId) => Promise.resolve(reconstructCheckpointState(store.loadRunEvents(runId))),
  };
}
