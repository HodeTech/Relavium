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

import { createHash } from 'node:crypto';

import { and, asc, eq } from 'drizzle-orm';

import {
  EFFECT_STATES,
  EFFECT_TIERS,
  EffectConflictError,
  effectScope,
  type EffectAttemptId,
  type EffectCorrelation,
  type EffectIdentity,
  type EffectRecord,
  type EffectDispatchPort,
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

/**
 * The synchronous store; `createEffectJournalPort` adapts its WRITE half to the engine's Promise-typed
 * dispatch seam. `recordsFor` and `flagForAttention` are the read half the resume gate will consume — they
 * are implemented and exported, and nothing calls them yet (ADR-0080 §2b is CR-12's remaining step).
 */
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
              // …and ONLY out of `prepared`. Without the state predicate the machine admitted
              // `committed → ambiguous`, which is strictly a loss of information: the row would claim we do
              // not know what the target did while still carrying the `resultJson` proving we do — and the
              // resume gate reads exactly that pair. A settle against an already-terminal row is a bug in the
              // caller, and the honest response is to leave the durable answer alone.
              .where(and(whereIdentity(identity), eq(runEffects.state, 'prepared')))
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
            state: coerceEffectState(row.state),
            tier: coerceEffectTier(row.tier),
            ...(row.resultJson === null ? {} : { result: JSON.parse(row.resultJson) as unknown }),
            ...(row.targetIdempotencyKey === null
              ? {}
              : { targetIdempotencyKey: row.targetIdempotencyKey }),
          }),
        );
    },
  };
}

/**
 * Adapt the synchronous store to the engine's dispatch-side port, with the correlation closed over
 * (ADR-0080 §7) — the shape a host wires, mirroring `createRunLeasePort`.
 *
 * **The hashing lives here, and that placement is forced.** `packages/core` is platform-free and cannot
 * compute SHA-256, but only the engine knows which argument keys are secret-tainted. So the engine redacts
 * and this hashes: the projection it receives has already had every secret removed, and it is reduced to a
 * digest before it touches the database.
 */
export function createEffectJournalPort(
  store: EffectJournalStore,
  correlation: EffectCorrelation,
  /**
   * The audit occurrence. **A known gap, recorded rather than hidden**: the provider failover attempt and
   * the provider's `toolCallId` are not threaded to the dispatch today, so what is stored is what is
   * reachable at wiring time. Nothing load-bearing depends on it — the dedup key is the identity and the
   * resume gate reads the scope; this field is the audit trail, and it is currently coarser than
   * `EffectAttemptId` describes.
   */
  attempt: EffectAttemptId,
): EffectDispatchPort {
  const identityFor = (slot: number, toolId: string): EffectIdentity => ({
    scope: effectScope(correlation),
    slot,
    toolId,
  });
  return {
    prepare: (slot, toolId, tier, redactedArgs, targetIdempotencyKey) => {
      try {
        store.prepare(
          identityFor(slot, toolId),
          correlation,
          attempt,
          tier,
          digestOf(redactedArgs),
          targetIdempotencyKey,
        );
        return Promise.resolve();
      } catch (error) {
        // A REJECTION, never a synchronous throw: the port is Promise-typed, and a synchronous throw out of
        // one breaks any caller using `.catch()` rather than `await`-in-`try`.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    settle: (slot, toolId, state, result) => {
      try {
        store.settle(identityFor(slot, toolId), state, result);
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * Read a persisted `state` back, degrading an unrecognised value to the CONSERVATIVE reading.
 *
 * An `as` here would be an unsafe cast on data crossing a persistence boundary — and it would fail OPEN in a
 * fail-closed mechanism: a garbage `state` is not one of the unresolved values, so the gate would read it as
 * "nothing to worry about" and let the node re-run. `needs_attention` is the answer that cannot be wrong.
 */
function coerceEffectState(value: string): EffectState {
  return (EFFECT_STATES as readonly string[]).includes(value)
    ? (value as EffectState)
    : 'needs_attention';
}

/** Read a persisted `tier` back; an unrecognised value degrades to 3, the tier that promises least. */
function coerceEffectTier(value: number): EffectTier {
  return (EFFECT_TIERS as readonly number[]).includes(value) ? (value as EffectTier) : 3;
}

/**
 * SHA-256 over a canonical JSON serialization — sorted keys, no insignificant whitespace — so the same
 * logical arguments always produce the same fingerprint regardless of key order.
 *
 * A vetted implementation (`node:crypto`), never a hand-rolled one: CLAUDE.md rule 3.
 */
function digestOf(redactedArgs: unknown): string {
  return createHash('sha256').update(canonicalJson(redactedArgs)).digest('hex');
}

/** Deterministic JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
