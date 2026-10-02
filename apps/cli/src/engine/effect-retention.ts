/** Disclosure-before-retention for sessions; terminal-only retention for runs (ADR-0080/0098). */
import { randomUUID } from 'node:crypto';

import {
  createEffectJournalStore,
  type Db,
  type SessionEffectDisclosureSnapshot,
} from '@relavium/db';

import type { CliIo } from '../process/io.js';

const RETENTION_FAILED = 'warning: effect-journal retention could not be completed.';
const DISCLOSURE_FAILED =
  'warning: session effect disclosure could not be completed; audit evidence was retained.';
const CHECKPOINT_DEFERRED =
  'warning: session effect WAL erasure was deferred by a database reader; it will be retried on the next open or session sweep.';

/** Driver diagnostics, ids and database contents are never interpolated into a warning. */
function warn(io: CliIo, text: string): void {
  try {
    io.writeErr(`${text}\n`);
  } catch {
    // A failed output sink must not change the outcome or trigger another cleanup attempt.
  }
}

/** Delete only committed rows of a RUN the caller knows can no longer be resumed. */
export function sweepCommittedEffects(io: CliIo, db: Db, runId: string): void {
  try {
    createEffectJournalStore(db, { uuid: randomUUID, now: Date.now }).sweepCommittedForRun(runId);
  } catch {
    warn(io, RETENTION_FAILED);
  }
}

export interface ResumedSessionEffectOptions {
  readonly io: CliIo;
  readonly db: Db;
  readonly sessionId: string;
  readonly sanitize: (text: string) => string;
  /** The ACTIVE transcript for TTY/Home, stderr for plain/JSON. Throwing prevents the sweep. */
  readonly deliverNotice: (text: string) => void;
  /** TTY/Home acknowledge the rendered notice before destructive retention. Plain/JSON sinks are synchronous. */
  readonly flushNotice?: () => Promise<void>;
  /** Rechecked after delivery, which can synchronously trigger an exit or a session swap. */
  readonly isActive?: () => boolean;
}

/** A successful read, an active-surface disclosure, then the exact captured committed-row sweep. */
export function reconcileResumedSessionEffects(
  options: ResumedSessionEffectOptions,
): void | Promise<void> {
  const active = options.isActive ?? (() => true);
  if (!active()) return;
  const store = createEffectJournalStore(options.db, { uuid: randomUUID, now: Date.now });
  let snapshot: SessionEffectDisclosureSnapshot;
  try {
    snapshot = store.readSessionDisclosureSnapshot(options.sessionId);
    if (!active()) return;
    const notice = sessionEffectNotice(snapshot, options.sanitize);
    if (notice !== undefined) options.deliverNotice(notice);
  } catch {
    // Read and delivery failures are the SAME retention answer: zero deletion.
    if (active()) {
      try {
        options.deliverNotice(DISCLOSURE_FAILED);
      } catch {
        warn(options.io, DISCLOSURE_FAILED);
      }
    }
    return;
  }
  const sweep = (): void => {
    if (!active()) return;
    try {
      const swept = store.sweepCommittedForSession(options.sessionId, snapshot.committed);
      if (swept.checkpoint === 'deferred' && active()) options.deliverNotice(CHECKPOINT_DEFERRED);
    } catch {
      // A checkpoint can fail AFTER logical deletion committed: do not assert all rows remain.
      if (active()) {
        const warning = 'warning: session effect retention or WAL erasure could not be completed.';
        try {
          options.deliverNotice(warning);
        } catch {
          warn(options.io, warning);
        }
      }
    }
  };
  if (options.flushNotice === undefined) return sweep();
  return Promise.resolve()
    .then(options.flushNotice)
    .then(sweep, () => {
      if (active()) {
        try {
          options.deliverNotice(DISCLOSURE_FAILED);
        } catch {
          warn(options.io, DISCLOSURE_FAILED);
        }
      }
    });
}

/** Never resumable; the caller proves ownership by a successful one-shot turn-key reservation. */
export function sweepOneShotSessionEffects(io: CliIo, db: Db, sessionId: string): void {
  try {
    const store = createEffectJournalStore(db, { uuid: randomUUID, now: Date.now });
    const snapshot = store.readSessionDisclosureSnapshot(sessionId);
    const swept = store.sweepCommittedForSession(sessionId, snapshot.committed);
    if (swept.checkpoint === 'deferred') warn(io, CHECKPOINT_DEFERRED);
  } catch {
    warn(io, 'warning: one-shot effect retention or WAL erasure could not be completed.');
  }
}

function sessionEffectNotice(
  snapshot: SessionEffectDisclosureSnapshot,
  sanitize: (text: string) => string,
): string | undefined {
  if (snapshot.disclosures.length === 0) return undefined;
  const listed = snapshot.disclosures
    .map((record) => {
      const reason =
        record.reason === 'unresolved'
          ? `unresolved: ${record.state}`
          : record.reason === 'turn_incomplete'
            ? 'landed in a turn that did not complete'
            : 'may belong to a turn that did not complete; durable attribution unavailable';
      return `${sanitize(record.toolId)} (${reason})`;
    })
    .join(', ');
  return (
    `note: ${String(snapshot.disclosures.length)} external effect(s) from earlier turns need attention — ` +
    `${listed}. They are NOT retried; check the target before sending the message again.`
  );
}
