/**
 * Retention for the effect journal
 * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §9).
 *
 * One shared helper rather than the same block on `run` and `gate`, because the two must not drift: a sweep
 * that ran on one surface and not the other would leave `history.db` growing on exactly the path a long-lived
 * automation uses most.
 */

import { createEffectJournalStore, type Db } from '@relavium/db';
import { randomUUID } from 'node:crypto';

import type { CliIo } from '../process/io.js';

/**
 * Delete the `committed` effect rows of a run that can no longer be resumed.
 *
 * **Committed only**, and that is the whole safety argument. Unresolved rows (`prepared`, `dispatched`,
 * `ambiguous`, `needs_attention`) are never swept by age or by terminal: they are the record an operator
 * needs, and they outlive their run deliberately — which is also why `run_effects` carries no foreign key to
 * `runs`. An exit-7 run is terminal, so this runs on it too, and its blocking rows must survive.
 *
 * Best-effort. A retention failure must never change a run's exit code — the run's outcome is the answer the
 * caller asked for, and a row that failed to delete costs disk, not correctness.
 */
export function sweepCommittedEffects(io: CliIo, db: Db, runId: string): void {
  try {
    createEffectJournalStore(db, { uuid: randomUUID, now: Date.now }).sweepCommittedForRun(runId);
  } catch (error) {
    io.writeErr(
      `warning: effect-journal retention failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
