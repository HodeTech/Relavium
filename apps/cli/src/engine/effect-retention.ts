/**
 * Retention for the effect journal
 * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §9).
 *
 * One shared module rather than the same block on each surface, because they must not drift: a sweep that
 * ran on one and not another would leave `history.db` growing on exactly the path a long-lived session or
 * automation uses most.
 *
 * **`committed` rows only**, and that is the whole safety argument. Unresolved rows (`prepared`,
 * `dispatched`, `ambiguous`, `needs_attention`) are never swept by age or by terminal: they are the record
 * an operator needs, and they outlive their correlation deliberately — which is also why `run_effects`
 * carries no foreign key to `runs`. An exit-7 run is terminal, so the run sweep runs on it too, and its
 * blocking rows must survive.
 *
 * Best-effort throughout. A retention failure must never change a run's exit code or cost a user their
 * session: a row that failed to delete costs disk, not correctness.
 */

import { randomUUID } from 'node:crypto';

import { createEffectJournalStore, type Db } from '@relavium/db';
import type { EffectRecord } from '@relavium/shared';

import type { CliIo } from '../process/io.js';

/** Delete the `committed` effect rows of a run that can no longer be resumed. */
export function sweepCommittedEffects(io: CliIo, db: Db, runId: string): void {
  sweepQuietly(io, db, `run ${runId}`, (store) => store.sweepCommittedForRun(runId));
}

/**
 * Delete the `committed` rows of a session's PAST turns (`beforeTurn` exclusive, so the live turn is safe).
 *
 * A past conversational turn can never be resumed, so its committed rows have no reader — and until this
 * existed every session-scoped row was permanent on the surfaces that actually ship (`chat`, `chat-resume`,
 * `agent run`, the bare-`relavium` Home). Those rows carry a durable `args_digest`, which §11 reasons about
 * as a permanent offline equality oracle; keeping them forever made it a growing one.
 */
export function sweepCommittedSessionEffects(
  io: CliIo,
  db: Db,
  sessionId: string,
  beforeTurn: number,
): void {
  sweepQuietly(io, db, `session ${sessionId}`, (store) =>
    store.sweepCommittedForSession(sessionId, beforeTurn),
  );
}

function sweepQuietly(
  io: CliIo,
  db: Db,
  what: string,
  sweep: (store: ReturnType<typeof createEffectJournalStore>) => number,
): void {
  try {
    sweep(createEffectJournalStore(db, { uuid: randomUUID, now: Date.now }));
  } catch (error) {
    io.writeErr(
      `warning: effect-journal retention failed for ${what}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * The unresolved-effect disclosure for a RESUMED session
 * ([effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §8), as one line of text —
 * or `undefined` when there is nothing to say.
 *
 * **Text, not a write.** The two session surfaces disclose through different channels and must not fight
 * over one: `chat-resume` writes stderr (so `--json` stdout stays a clean event stream), while the
 * full-screen Home routes it into the transcript as a notice, because raw stderr lands on the alternate
 * buffer for one frame and is gone. Returning the sentence lets each say it its own way.
 *
 * **A session discloses and does not block**, unlike the run gate. A chat has no operator queue and no run
 * to pause, so refusing to resume it would halt a conversation over a row nobody can act on from inside the
 * REPL. Tier 3's guarantee — never auto-retried, because nothing re-dispatches a session's prior turns — is
 * unchanged; what changes is that the fact reaches the one person who can go look at the target.
 *
 * Best-effort: a journal read that throws returns `undefined`. Losing a session over an audit row would be
 * a worse outcome than the missing disclosure.
 */
export function unresolvedEffectNotice(
  db: Db,
  sessionId: string,
  sanitize: (text: string) => string,
): string | undefined {
  let unresolved: readonly EffectRecord[];
  try {
    unresolved = createEffectJournalStore(db, {
      uuid: randomUUID,
      now: Date.now,
    }).unresolvedForSession(sessionId);
  } catch {
    return undefined;
  }
  if (unresolved.length === 0) return undefined;
  const listed = unresolved
    .map((record) => `${sanitize(record.identity.toolId)} (${record.state})`)
    .join(', ');
  return (
    `note: ${String(unresolved.length)} external effect(s) from earlier turns of this session were never ` +
    `resolved — ${listed}. They are NOT retried; check the target before assuming they did or did not happen.`
  );
}

