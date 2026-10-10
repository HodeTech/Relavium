import { eq } from 'drizzle-orm';

import type { Db, TxDb } from './client.js';
import { withBusyRetry } from './retry.js';
import { agentSessions } from './schema.js';

/** Fixed, content-free failures of the session coverage foundation (ADR-0104). */
export class SessionUsageError extends Error {
  readonly code: 'transaction_active' | 'history_invalid' | 'revision_exhausted' | 'not_fresh';

  constructor(code: SessionUsageError['code'], options?: ErrorOptions) {
    super('session usage coverage operation refused', options);
    this.name = 'SessionUsageError';
    this.code = code;
  }
}

export function validateUsageRevision(revision: number, acknowledged: number): void {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Number.isSafeInteger(acknowledged) ||
    acknowledged < 0 ||
    acknowledged > revision
  )
    throw new SessionUsageError('history_invalid');
}

/** Read ENTRY state before any business write; acknowledging never clears inherited uncertainty. */
function latchEntryTaint(tx: TxDb, sessionId: string): void {
  const entry = tx
    .select({
      revision: agentSessions.usageMutationRevision,
      acknowledged: agentSessions.usageAckRevision,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (entry === undefined) return; // generic/fresh INSERT is inside the same outer transaction
  validateUsageRevision(entry.revision, entry.acknowledged);
  if (entry.revision !== entry.acknowledged) {
    tx.update(agentSessions)
      .set({ usageUnverified: true })
      .where(eq(agentSessions.id, sessionId))
      .run();
  }
}

function acknowledgeFinalRevision(tx: TxDb, sessionId: string): void {
  const entry = tx
    .select({
      revision: agentSessions.usageMutationRevision,
      acknowledged: agentSessions.usageAckRevision,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (entry === undefined) return; // an explicit parent deletion has no surviving coverage owner
  validateUsageRevision(entry.revision, entry.acknowledged);
  tx.update(agentSessions)
    .set({ usageAckRevision: entry.revision })
    .where(eq(agentSessions.id, sessionId))
    .run();
}

/** Convert only our migration-owned fixed overflow marker, retaining the native cause. */
function isRevisionExhaustion(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message === 'session_usage_revision_exhausted') return true;
    current = current.cause;
  }
  return false;
}

/**
 * The single OUTER transaction for session business writes. Private to this package: callers name
 * every old/new owner before writing, then use only `tx`. Busy retry repeats the entire rolled-back
 * operation. A nested savepoint cannot make a pending marker durable before the method returns.
 */
export function withSessionUsageWrite<T>(
  db: Db,
  sessionIds: readonly string[],
  body: (tx: TxDb) => T,
): T {
  if (db.$client.inTransaction) throw new SessionUsageError('transaction_active');
  const owners = [...new Set(sessionIds)];
  try {
    return withBusyRetry(() =>
      db.transaction(
        (tx) => {
          for (const owner of owners) latchEntryTaint(tx, owner);
          const result = body(tx);
          for (const owner of owners) acknowledgeFinalRevision(tx, owner);
          return result;
        },
        { behavior: 'immediate' },
      ),
    );
  } catch (error) {
    if (isRevisionExhaustion(error))
      throw new SessionUsageError('revision_exhausted', { cause: error });
    throw error;
  }
}
