/** ADR-0098: durable session effect identity, separate from the reconstructed max_turns counter. */
import { and, eq, gte, inArray, lt, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import { agentSessions, runEffects, sessionMessages } from './schema.js';

type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export class SessionEffectTurnError extends Error {
  readonly code: 'session_missing' | 'history_invalid' | 'key_exhausted' | 'transaction_active';
  constructor(code: SessionEffectTurnError['code']) {
    super('session effect-turn key could not be allocated');
    this.name = 'SessionEffectTurnError';
    this.code = code;
  }
}

function safeKey(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new SessionEffectTurnError('history_invalid');
  return value;
}

function completedAssistant(contentParts: string | null, content: string | null): boolean {
  if (contentParts === null) return content !== null;
  let parts: unknown;
  try {
    parts = JSON.parse(contentParts) as unknown;
  } catch {
    throw new SessionEffectTurnError('history_invalid');
  }
  if (!Array.isArray(parts)) throw new SessionEffectTurnError('history_invalid');
  let text = false;
  const values: readonly unknown[] = parts;
  for (const part of values) {
    if (typeof part !== 'object' || part === null || !('type' in part)) {
      throw new SessionEffectTurnError('history_invalid');
    }
    if (part.type === 'tool_call') return false;
    if (part.type === 'text') text = true;
  }
  return text;
}

/** Called under a write transaction, before any legacy session effect can be swept. */
function seedLegacyKey(on: Executor, sessionId: string): number {
  const session = on
    .select({ key: agentSessions.effectTurnHighWater })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (session === undefined) throw new SessionEffectTurnError('session_missing');
  const current = safeKey(session.key);
  if (current > 0) return current;

  const historical = on
    .select({ contentParts: sessionMessages.contentParts, content: sessionMessages.content })
    .from(sessionMessages)
    .where(and(eq(sessionMessages.sessionId, sessionId), eq(sessionMessages.role, 'assistant')))
    .all();
  let floor = historical.filter((row) => completedAssistant(row.contentParts, row.content)).length;
  const prefix = `session:${encodeURIComponent(sessionId)}:`;
  const effects = on
    .select({ scope: runEffects.scope })
    .from(runEffects)
    .where(and(gte(runEffects.scope, prefix), lt(runEffects.scope, `${prefix.slice(0, -1)};`)))
    .all();
  for (const effect of effects) {
    const suffix = effect.scope.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(suffix)) throw new SessionEffectTurnError('history_invalid');
    floor = Math.max(floor, safeKey(Number(suffix)));
  }
  safeKey(floor);
  on.update(agentSessions)
    .set({ effectTurnHighWater: floor })
    .where(eq(agentSessions.id, sessionId))
    .run();
  return floor;
}

/** Open-time backfill precedes journal cleanup; a later sweep cannot lower the issued high-water mark. */
export function initializeSessionEffectTurnKeys(db: Db): void {
  withBusyRetry(() =>
    db.transaction(
      (tx) => {
        // Empty idle sessions keep zero until their first reservation. Identify legacy evidence in
        // bounded batches, avoiding a separate history read/write for every unused session on open.
        const uninitialized = tx
          .select({ id: agentSessions.id })
          .from(agentSessions)
          .where(eq(agentSessions.effectTurnHighWater, 0))
          .all();
        const sessions = new Set<string>();
        const batchSize = 128; // 256 scope parameters remain below SQLite's portable variable ceiling.
        for (let offset = 0; offset < uninitialized.length; offset += batchSize) {
          const ids = uninitialized.slice(offset, offset + batchSize).map((row) => row.id);
          for (const row of tx
            .selectDistinct({ id: sessionMessages.sessionId })
            .from(sessionMessages)
            .where(
              and(inArray(sessionMessages.sessionId, ids), eq(sessionMessages.role, 'assistant')),
            )
            .all())
            sessions.add(row.id);
          const prefixes = ids.map((id) => ({ id, prefix: `session:${encodeURIComponent(id)}:` }));
          const byEncoded = new Map(ids.map((id) => [encodeURIComponent(id), id]));
          const effects = tx
            .selectDistinct({ scope: runEffects.scope })
            .from(runEffects)
            .where(
              or(
                ...prefixes.map(({ prefix }) =>
                  and(
                    gte(runEffects.scope, prefix),
                    lt(runEffects.scope, `${prefix.slice(0, -1)};`),
                  ),
                ),
              ),
            )
            .all();
          for (const effect of effects) {
            const separator = effect.scope.indexOf(':', 'session:'.length);
            const id = byEncoded.get(effect.scope.slice('session:'.length, separator));
            if (id !== undefined) sessions.add(id);
          }
        }
        for (const id of sessions) {
          try {
            seedLegacyKey(tx, id);
          } catch (error) {
            if (!(error instanceof SessionEffectTurnError) || error.code !== 'history_invalid')
              throw error;
            // Keep this session uninitialized, with its original evidence intact. Its reservation
            // path still refuses corrupt history; unrelated sessions and database operations remain
            // usable. Never guess a terminal-count floor that could reissue an old effect identity.
          }
        }
      },
      { behavior: 'immediate' },
    ),
  );
}

/** Allocate before dispatch. Gaps are intentional: a failed, aborted or crashed turn never returns its key. */
export function reserveSessionEffectTurnKey(db: Db, sessionId: string): number {
  // A nested better-sqlite3 transaction is only a SAVEPOINT. Returning from it would issue a key
  // that an outer rollback could erase and then reissue. Even an outer BEGIN IMMEDIATE cannot
  // make that key durable before this method returns, so reservation must own the outer commit.
  if (db.$client.inTransaction) throw new SessionEffectTurnError('transaction_active');
  return withBusyRetry(() =>
    db.transaction(
      (tx) => {
        const row = tx
          .select({ deletedAt: agentSessions.deletedAt })
          .from(agentSessions)
          .where(eq(agentSessions.id, sessionId))
          .get();
        if (row === undefined || row.deletedAt !== null)
          throw new SessionEffectTurnError('session_missing');
        const current = seedLegacyKey(tx, sessionId);
        if (current === Number.MAX_SAFE_INTEGER) throw new SessionEffectTurnError('key_exhausted');
        const key = current + 1;
        tx.update(agentSessions)
          .set({ effectTurnHighWater: key })
          .where(eq(agentSessions.id, sessionId))
          .run();
        return key;
      },
      { behavior: 'immediate' },
    ),
  );
}

/**
 * A one-shot is never resumable. Its fresh identity and tombstone commit together,
 * without a snapshot, context, prompt or transcript. Retain the mark after teardown.
 */
export function reserveOneShotSessionEffectTurnKey(db: Db, sessionId: string, now: number): number {
  if (db.$client.inTransaction) throw new SessionEffectTurnError('transaction_active');
  if (sessionId.length === 0 || !Number.isSafeInteger(now) || now < 0)
    throw new SessionEffectTurnError('history_invalid');
  return withBusyRetry(() =>
    db.transaction(
      (tx) => {
        const prefix = `session:${encodeURIComponent(sessionId)}:`;
        if (
          tx
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(eq(agentSessions.id, sessionId))
            .get() !== undefined ||
          tx
            .select({ scope: runEffects.scope })
            .from(runEffects)
            .where(
              and(gte(runEffects.scope, prefix), lt(runEffects.scope, `${prefix.slice(0, -1)};`)),
            )
            .get() !== undefined
        )
          throw new SessionEffectTurnError('history_invalid');
        tx.insert(agentSessions)
          .values({
            id: sessionId,
            agentSlug: 'one-shot',
            status: 'ended',
            effectTurnHighWater: 1,
            deletedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        return 1;
      },
      { behavior: 'immediate' },
    ),
  );
}
