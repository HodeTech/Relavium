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
    load: (runId) => {
      // `loadRunEventLog`, not `loadRunEvents`: a row written by a NEWER binary is dropped from the fold
      // (ADR-0074 §5), and if that row is the log's TAIL the fold's `lastSequenceNumber` lands BELOW what is
      // actually stored. `engine.resumeFromCheckpoint` seeds the bus with `lastSequenceNumber + 1`, so the
      // resumed run would re-use a taken `seq`, hit `UNIQUE(run_id, seq)`, and fail the durable write — which
      // the engine treats as an `internal` fault and settles as `run:failed`. A run that merely needed a newer
      // binary to read one row would become terminally unresumable, by either binary. So the skipped rows'
      // authoritative `seq` column is folded back in.
      const log = store.loadRunEventLog(runId);
      const state = reconstructCheckpointState(log.events);
      if (state === undefined) {
        return Promise.resolve(undefined);
      }
      const lastSequenceNumber = log.skipped.reduce(
        (max, row) => Math.max(max, row.sequenceNumber),
        state.lastSequenceNumber,
      );
      return Promise.resolve({ ...state, lastSequenceNumber });
    },
  };
}
