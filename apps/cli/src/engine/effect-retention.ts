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
async function writeWarning(io: CliIo, text: string): Promise<void> {
  // The async boundary also converts a synchronous host-port throw into a rejected promise.
  await io.writeErrAcknowledged(`${text}\n`);
}

function warn(io: CliIo, text: string): void {
  // A failed output sink must not change the outcome or trigger another cleanup attempt.
  void writeWarning(io, text).catch(() => undefined);
}

/** Delete only committed rows of a RUN the caller knows can no longer be resumed. */
export function sweepCommittedEffects(io: CliIo, db: Db, runId: string): void {
  try {
    createEffectJournalStore(db, { uuid: randomUUID, now: Date.now }).sweepCommittedForRun(runId);
  } catch {
    warn(io, RETENTION_FAILED);
  }
}

/** A notice is inserted inside the terminal ownership interval and acknowledged before it is released. */
export type NoticeFlush = (publish?: () => void | Promise<void>) => Promise<void>;

export interface ResumedSessionEffectOptions {
  readonly io: CliIo;
  readonly db: Db;
  readonly sessionId: string;
  readonly sanitize: (text: string) => string;
  /** The ACTIVE transcript or acknowledged stderr writer. Throwing/rejection prevents the sweep. */
  readonly deliverNotice: (text: string) => void | Promise<void>;
  /** TTY/Home also acknowledge the rendered notice before destructive retention. */
  readonly flushNotice?: NoticeFlush;
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
  let notice: string | undefined;
  let published = false;
  let delivered: Promise<boolean> | undefined;
  const warning = (text: string): void | Promise<void> => {
    if (!active()) return;
    try {
      const delivered = options.deliverNotice(text);
      if (delivered !== undefined) return delivered.catch(() => warn(options.io, text));
    } catch {
      warn(options.io, text);
    }
  };
  try {
    snapshot = store.readSessionDisclosureSnapshot(options.sessionId);
    if (!active()) return;
    notice = sessionEffectNotice(snapshot, options.sanitize);
  } catch {
    // Read and delivery failures are the SAME retention answer: zero deletion.
    return warning(DISCLOSURE_FAILED);
  }
  const sweep = (): void | Promise<void> => {
    if (!active()) return;
    try {
      const swept = store.sweepCommittedForSession(options.sessionId, snapshot.committed);
      if (swept.checkpoint === 'deferred') return warning(CHECKPOINT_DEFERRED);
    } catch {
      // A checkpoint can fail AFTER logical deletion committed: do not assert all rows remain.
      return warning('warning: session effect retention or WAL erasure could not be completed.');
    }
  };
  const publish = (): void | Promise<void> => {
    if (!active() || notice === undefined) return;
    const result = options.deliverNotice(notice);
    published = true;
    if (result !== undefined)
      delivered = result.then(
        () => true,
        () => false,
      );
    return result;
  };
  const acknowledged = (): void | Promise<void> => {
    if (!active()) return;
    // A flush adapter must actually publish, and cannot discard an asynchronous delivery failure.
    if (notice !== undefined && !published) return warning(DISCLOSURE_FAILED);
    return delivered === undefined
      ? sweep()
      : delivered.then((success) => (success ? sweep() : warning(DISCLOSURE_FAILED)));
  };
  try {
    if (options.flushNotice !== undefined)
      return options.flushNotice(publish).then(acknowledged, () => warning(DISCLOSURE_FAILED));
    void publish();
    return acknowledged();
  } catch {
    return warning(DISCLOSURE_FAILED);
  }
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
      let reason: string;
      if (record.reason === 'unresolved') reason = `unresolved: ${record.state}`;
      else if (record.reason === 'turn_incomplete')
        reason = 'landed in a turn that did not complete';
      else reason = 'may belong to a turn that did not complete; durable attribution unavailable';
      return `${sanitize(record.toolId)} (${reason})`;
    })
    .join(', ');
  return (
    `note: ${String(snapshot.disclosures.length)} external effect(s) from earlier turns need attention — ` +
    `${listed}. They are NOT retried; check the target before sending the message again.`
  );
}
