import { reconstructCheckpointState, type Checkpointer } from '@relavium/core';
import type { RunHistoryStore } from '@relavium/db';

/**
 * A {@link Checkpointer} that rebuilds a run's `CheckpointState` from the durable event log (2.H) — the read
 * side of cross-process gate resume (**2.G**). `engine.resumeFromCheckpoint(runId, …)` calls
 * `host.checkpointer.load(runId)` to seed the rehydrated run; for the SQLite {@link RunHistoryStore} that is
 * `loadRunEventLogForReplay(runId)` folded through {@link reconstructCheckpointState} — the **same** 1.R reconstruction
 * the engine's in-memory checkpointer uses, but over persisted rows instead of an in-process buffer (so a
 * `relavium gate` in a fresh process sees the state a prior `relavium run` left behind). Returns `undefined`
 * for a run with no persisted `run:started` (unknown / never-persisted), exactly as the port specifies.
 */
export function createHistoryCheckpointer(store: RunHistoryStore): Checkpointer {
  return {
    // `async`, so the strict read's refusal arrives as a REJECTION. The port types `load` as returning a
    // Promise, and `loadRunEventLogForReplay` throws synchronously — an `async` function can only ever reject,
    // never throw synchronously, which is the same guarantee `persistEvent` leans on for the same reason.
    load: async (runId) => {
      // `loadRunEventLogForReplay` — the STRICT read (ADR-0075). This fold does not display a log; it decides
      // what work still has to happen, and a row this binary cannot interpret may have been a node terminal, a
      // job submission, a gate decision or a cost commitment. Tolerating the hole means re-running completed
      // work or re-submitting an already-billed media job, silently.
      //
      // This REPLACES the high-water-mark repair that used to live here. That repair was real — a skipped TAIL
      // row left `lastSequenceNumber` below what is stored, so the resumed run collided on
      // `UNIQUE(run_id, seq)` and settled as `run:failed` — but it addressed the write collision while leaving
      // the lost STATE unaddressed, which is the more dangerous half. Refusing covers both, so folding the
      // skipped `seq` values back in is now unreachable: the strict read never returns with any.
      return await Promise.resolve(
        reconstructCheckpointState(store.loadRunEventLogForReplay(runId)),
      );
    },
  };
}
