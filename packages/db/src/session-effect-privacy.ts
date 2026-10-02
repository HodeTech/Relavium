import { and, gte, isNotNull, lt } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import { runEffects } from './schema.js';

/** A busy reader postpones physical erasure; logical session-result suppression still holds. */
export type SessionEffectCheckpoint = 'complete' | 'deferred';

/** Fixed diagnostics: driver errors and stored content must never become disclosure text. */
export class SessionEffectPrivacyError extends Error {
  constructor(readonly code: 'transaction_active' | 'checkpoint_failed') {
    super(
      code === 'transaction_active'
        ? 'session effect maintenance requires its own transaction'
        : 'session effect WAL checkpoint failed',
    );
    this.name = 'SessionEffectPrivacyError';
  }
}

export function requireSessionEffectTransactionOwnership(db: Db): void {
  if (db.$client.inTransaction) throw new SessionEffectPrivacyError('transaction_active');
}

/** Run only AFTER the zeroing/deletion transaction has committed, including an empty sweep. */
export function checkpointSessionEffectPrivacy(db: Db): SessionEffectCheckpoint {
  requireSessionEffectTransactionOwnership(db);
  let result: unknown;
  try {
    result = db.$client.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
    ) {
      return 'deferred';
    }
    throw new SessionEffectPrivacyError('checkpoint_failed');
  }
  if (Array.isArray(result) && result.length === 1) {
    const row: unknown = result[0];
    if (
      row !== null &&
      typeof row === 'object' &&
      'busy' in row &&
      (row.busy === 0 || row.busy === 1) &&
      'log' in row &&
      typeof row.log === 'number' &&
      Number.isSafeInteger(row.log) &&
      row.log >= -1 &&
      'checkpointed' in row &&
      typeof row.checkpointed === 'number' &&
      Number.isSafeInteger(row.checkpointed) &&
      row.checkpointed >= -1
    ) {
      if (row.busy === 1) return 'deferred';
      // TRUNCATE success resets both counters; a non-WAL database reports -1 for both.
      if ((row.log === 0 && row.checkpointed === 0) || (row.log === -1 && row.checkpointed === -1))
        return 'complete';
    }
  }
  throw new SessionEffectPrivacyError('checkpoint_failed');
}

/** Open-time data repair, AFTER the durable turn high-water mark has been initialized. */
export function clearLegacySessionEffectResults(db: Db): SessionEffectCheckpoint {
  requireSessionEffectTransactionOwnership(db);
  withBusyRetry(() =>
    db.transaction(
      (tx) => {
        tx.update(runEffects)
          .set({ resultJson: null })
          .where(
            and(
              gte(runEffects.scope, 'session:'),
              lt(runEffects.scope, 'session;'),
              isNotNull(runEffects.resultJson),
            ),
          )
          .run();
      },
      { behavior: 'immediate' },
    ),
  );
  return checkpointSessionEffectPrivacy(db);
}
