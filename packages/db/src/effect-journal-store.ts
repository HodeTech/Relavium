/**
 * The durable effect journal's SQLite store ([ADR-0080](../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md);
 * canonical contract in [effect-journal.md](../../../docs/reference/shared-core/effect-journal.md)).
 *
 * **Its own store, not a fourth method on `RunHistoryStore`.** ADR-0079 set the precedent when the lease
 * became `RunLeasePort` rather than growing the run store: `RunStore` is deliberately three methods, and a
 * journal row is not a run event — it has no `runId` at all on the session path, where `run_events.run_id`
 * is `NOT NULL` with a foreign key.
 *
 * **`prepare` is the concurrency boundary, and that is why it can reject.** The UNIQUE index on
 * `(scope, slot, tool_id)` is what makes two processes preparing the same effect resolve to one dispatch:
 * the loser gets `EffectConflictError` and learns another attempt exists. That is a refusal, not a fault —
 * so, like `AppendConflictError` and `LeaseFencedError`, it must never be swept into the busy-retry set.
 */

import { and, asc, eq } from 'drizzle-orm';

import {
  EffectConflictError,
  effectScope,
  type EffectAttemptId,
  type EffectCorrelation,
  type EffectIdentity,
  type EffectRecord,
  type EffectState,
  type EffectTier,
} from '@relavium/shared';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import { runEffects, type NewRunEffectRow } from './schema.js';

/** The clock + id source the journal needs, injected exactly as the run-history store's are. */
export interface EffectJournalStoreDeps {
  readonly uuid: () => string;
  readonly now: () => number;
}

/** The synchronous store; `createEffectJournalPort` adapts it to the engine's Promise-typed seam. */
export interface EffectJournalStore {
  prepare: (
    identity: EffectIdentity,
    correlation: EffectCorrelation,
    attempt: EffectAttemptId,
    tier: EffectTier,
    argsDigest: string,
    targetIdempotencyKey?: string,
  ) => void;
  settle: (
    identity: EffectIdentity,
    state: Extract<EffectState, 'committed' | 'ambiguous'>,
    result?: unknown,
  ) => void;
  flagForAttention: (identity: EffectIdentity) => void;
  recordsFor: (correlation: EffectCorrelation) => readonly EffectRecord[];
}

export function createEffectJournalStore(db: Db, deps: EffectJournalStoreDeps): EffectJournalStore {
  const whereIdentity = (identity: EffectIdentity) =>
    and(
      eq(runEffects.scope, identity.scope),
      eq(runEffects.slot, identity.slot),
      eq(runEffects.toolId, identity.toolId),
    );

  return {
    prepare: (identity, correlation, attempt, tier, argsDigest, targetIdempotencyKey) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            // Read-then-insert inside ONE `BEGIN IMMEDIATE`, so the check and the claim cannot interleave —
            // the same reasoning ADR-0078 §2's compare-and-append uses. The UNIQUE index is the backstop; this
            // read is what turns a driver constraint error into the typed refusal callers narrow on.
            const held = tx.select().from(runEffects).where(whereIdentity(identity)).get();
            if (held !== undefined) throw new EffectConflictError(identity);
            const now = deps.now();
            const row: NewRunEffectRow = {
              id: deps.uuid(),
              scope: identity.scope,
              slot: identity.slot,
              toolId: identity.toolId,
              tier,
              state: 'prepared',
              argsDigest,
              targetIdempotencyKey: targetIdempotencyKey ?? null,
              resultJson: null,
              attemptJson: JSON.stringify(attempt),
              createdAt: now,
              updatedAt: now,
            };
            void correlation; // the scope already encodes it; kept in the signature for the port's shape
            tx.insert(runEffects).values(row).run();
          },
          { behavior: 'immediate' },
        ),
      ),

    settle: (identity, state, result) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            tx.update(runEffects)
              .set({
                state,
                // Retained ONLY when the caller had one to give. Its absence is load-bearing: the resume gate
                // refuses a `committed` row it cannot re-deliver, rather than waving the node through.
                ...(result === undefined ? {} : { resultJson: JSON.stringify(result) }),
                updatedAt: deps.now(),
              })
              .where(whereIdentity(identity))
              .run();
          },
          { behavior: 'immediate' },
        ),
      ),

    flagForAttention: (identity) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            tx.update(runEffects)
              .set({ state: 'needs_attention', updatedAt: deps.now() })
              .where(whereIdentity(identity))
              .run();
          },
          { behavior: 'immediate' },
        ),
      ),

    recordsFor: (correlation) => {
      const scope = effectScope(correlation);
      return db
        .select()
        .from(runEffects)
        .where(eq(runEffects.scope, scope))
        .orderBy(asc(runEffects.slot))
        .all()
        .map(
          (row): EffectRecord => ({
            identity: { scope: row.scope, slot: row.slot, toolId: row.toolId },
            state: row.state as EffectState,
            tier: row.tier as EffectTier,
            ...(row.resultJson === null ? {} : { result: JSON.parse(row.resultJson) as unknown }),
            ...(row.targetIdempotencyKey === null
              ? {}
              : { targetIdempotencyKey: row.targetIdempotencyKey }),
          }),
        );
    },
  };
}
