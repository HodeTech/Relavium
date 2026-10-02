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

import { and, asc, eq, gte, lt, or } from 'drizzle-orm';

import {
  canonicalJson,
  completedSessionTurns,
  EffectTransitionError,
  EFFECT_STATES,
  EFFECT_TIERS,
  EffectConflictError,
  effectScope,
  type EffectAttemptId,
  type EffectCorrelation,
  type EffectIdentity,
  type EffectRecord,
  type EffectDispatchPort,
  type EffectPrepareVerdict,
  type EffectResumePort,
  type UnresolvedEffect,
  blocksResume,
  nodeIdFromRunScope,
  type EffectState,
  type EffectTier,
  parseSessionToolCallId,
} from '@relavium/shared';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
import { runEffects, sessionMessages, type NewRunEffectRow } from './schema.js';
import { fromSessionMessageRow } from './session-store.js';
import {
  checkpointSessionEffectPrivacy,
  requireSessionEffectTransactionOwnership,
  type SessionEffectCheckpoint,
} from './session-effect-privacy.js';

/** Pair the physical id with its immutable effect address: an id alone is vulnerable to delete/reinsert. */
export interface CapturedSessionEffect {
  readonly id: string;
  readonly identity: EffectIdentity;
}

export interface SessionEffectDisclosure {
  readonly toolId: string;
  readonly state: EffectState;
  readonly reason: 'unresolved' | 'turn_incomplete' | 'unattributable';
}

export interface SessionEffectDisclosureSnapshot {
  readonly committed: readonly CapturedSessionEffect[];
  readonly disclosures: readonly SessionEffectDisclosure[];
}

export interface SessionEffectSweepResult {
  readonly deleted: number;
  readonly checkpoint: SessionEffectCheckpoint;
}

/** The clock + id source the journal needs, injected exactly as the run-history store's are. */
export interface EffectJournalStoreDeps {
  readonly uuid: () => string;
  readonly now: () => number;
}

/**
 * The synchronous store; `createEffectJournalPort` adapts its WRITE half to the engine's Promise-typed
 * dispatch seam, and `createEffectResumePort` adapts its READ half to the engine's resume gate (ADR-0080
 * §2b, effect-journal.md §4) — `recordsFor` feeds that gate and `unresolvedForSession` feeds `chat-resume`'s
 * disclosure. `flagForAttention` has no caller yet: it is the primitive the operator-resolution command will
 * use, which effect-journal.md §8 names as a follow-up.
 */
export interface EffectJournalStore {
  prepare: (
    identity: EffectIdentity,
    correlation: EffectCorrelation,
    attempt: EffectAttemptId,
    tier: EffectTier,
    argsDigest: string,
    targetIdempotencyKey?: string,
  ) => EffectPrepareVerdict;
  settle: (
    identity: EffectIdentity,
    state: Extract<EffectState, 'committed' | 'ambiguous'>,
    result?: unknown,
  ) => void;
  /** Release a `prepared` claim for an effect that provably never left the process — see the impl. */
  discard: (identity: EffectIdentity) => void;
  flagForAttention: (identity: EffectIdentity) => void;
  recordsFor: (correlation: EffectCorrelation) => readonly EffectRecord[];
  /**
   * Sweep `committed` rows for a correlation that can no longer be resumed
   * ([effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §9). Returns how many rows
   * went. UNRESOLVED rows are never swept by age — they are the record an operator needs, and they outlive
   * their run deliberately, which is why the row carries no foreign key to `runs`.
   */
  sweepCommittedForRun: (runId: string) => number;
  /**
   * Delete only still-committed rows captured by the successful disclosure read. No turn-count bound;
   * newly committed or replaced rows survive. Checkpoint after the owned write transaction commits.
   */
  sweepCommittedForSession: (
    sessionId: string,
    captured: readonly CapturedSessionEffect[],
  ) => SessionEffectSweepResult;
  /** One owned read transaction over effect metadata and ALL strictly decoded historical messages. */
  readSessionDisclosureSnapshot: (sessionId: string) => SessionEffectDisclosureSnapshot;
  /**
   * Every unresolved effect across ALL turns of one session
   * ([effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §8).
   *
   * A session-scoped query rather than `recordsFor` per turn, because a session's correlation carries the
   * turn and its rows are therefore spread across as many scopes as it has turns. A resumed chat needs the
   * whole set to disclose it once, and looping `recordsFor` over every prior turn would be one query per
   * turn to answer a question about the session.
   */
  unresolvedForSession: (sessionId: string) => readonly EffectRecord[];
  /** Every unresolved effect of one RUN, across all its nodes — the resume gate's single range scan. */
  unresolvedForRun: (runId: string) => readonly EffectRecord[];
}

/**
 * A half-open RANGE over one scope prefix — `[prefix, prefix')`, where `prefix'` is the prefix with its final
 * `:` bumped to `;` (0x3A → 0x3B, the next byte).
 *
 * **A range, deliberately, and not `LIKE`.** SQLite's `LIKE` treats `%` and `_` as wildcards and honours a
 * backslash escape ONLY when the statement carries an explicit `ESCAPE` clause — which drizzle's `like()`
 * does not emit. A session id is only schema-constrained to a non-empty string and `history.db` is shared
 * with other surfaces, so an id containing `%` would silently widen the match and an id containing a
 * backslash would be mangled by an escaping pass that the engine then ignores. A range has no such
 * semantics: under SQLite's default BINARY collation it is an exact byte-order prefix match, and it uses the
 * `scope` index rather than scanning.
 *
 * The separator lives INSIDE the prefix, so `s1` can never match `s10`'s rows.
 */
function scopeRange(prefix: string): { readonly from: string; readonly toExclusive: string } {
  return { from: prefix, toExclusive: `${prefix.slice(0, -1)};` };
}

export function createEffectJournalStore(db: Db, deps: EffectJournalStoreDeps): EffectJournalStore {
  const whereIdentity = (identity: EffectIdentity) =>
    and(
      eq(runEffects.scope, identity.scope),
      eq(runEffects.slot, identity.slot),
      eq(runEffects.toolId, identity.toolId),
    );

  /** Every BLOCKING record under one scope prefix — the shared body of both unresolved-* reads. */
  const unresolvedInScope = (prefix: string, session = false): readonly EffectRecord[] => {
    const range = scopeRange(prefix);
    return db
      .select()
      .from(runEffects)
      .where(and(gte(runEffects.scope, range.from), lt(runEffects.scope, range.toExclusive)))
      .orderBy(asc(runEffects.createdAt))
      .all()
      .map((row) => ({
        identity: { scope: row.scope, slot: row.slot, toolId: row.toolId },
        state: coerceEffectState(row.state),
        tier: coerceEffectTier(row.tier),
        ...retainedResult(row.scope, row.resultJson),
        ...(row.targetIdempotencyKey === null
          ? {}
          : { targetIdempotencyKey: row.targetIdempotencyKey }),
      }))
      .filter((record) => (session ? record.state !== 'committed' : blocksResume(record)));
  };

  return {
    prepare: (identity, correlation, attempt, tier, argsDigest, targetIdempotencyKey) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            // Read-then-insert inside ONE `BEGIN IMMEDIATE`, so the check and the claim cannot interleave —
            // the same reasoning ADR-0078 §2's compare-and-append uses. The UNIQUE index is the backstop; this
            // read is what turns a driver constraint error into the typed refusal callers narrow on.
            const held = tx.select().from(runEffects).where(whereIdentity(identity)).get();
            if (held !== undefined) {
              // §4's RUN replay row, decided HERE because only the host can compute the digest the comparison
              // needs. Same identity + same args digest + a retained result means this exact effect already
              // committed, so the stored result stands in for the call rather than the call happening twice.
              // Everything else — a different digest at the same slot, an unresolved row, a committed row we
              // cannot re-deliver — is the refusal, and a human has to look at it.
              if (
                !identity.scope.startsWith('session:') &&
                held.state === 'committed' &&
                held.argsDigest === argsDigest &&
                held.resultJson !== null
              ) {
                try {
                  return { outcome: 'replay', result: JSON.parse(held.resultJson) as unknown };
                } catch {
                  // An UNPARSABLE retained result is a committed row we cannot re-deliver — §4's refusal,
                  // reached by a different route. Letting the raw `SyntaxError` escape was worse than
                  // useless: it is not an `EffectConflictError`, so the registry rethrew it into the generic
                  // ladder, the node re-dispatched, re-hit the same corrupt row, and burned its whole retry
                  // budget while reporting a JSON syntax error as a tool failure.
                  throw new EffectConflictError(identity);
                }
              }
              throw new EffectConflictError(identity);
            }
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
            tx.insert(runEffects).values(row).run();
            return { outcome: 'proceed' };
          },
          { behavior: 'immediate' },
        ),
      ),

    settle: (identity, state, result) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            const changed = tx
              .update(runEffects)
              .set({
                state,
                // A session result is never inspected or serialized. RUN results retain §4's replay contract.
                ...(identity.scope.startsWith('session:')
                  ? { resultJson: null }
                  : result === undefined
                    ? {}
                    : { resultJson: JSON.stringify(result) }),
                updatedAt: deps.now(),
              })
              // …and ONLY out of `prepared`. Without the state predicate the machine admitted
              // `committed → ambiguous`, which is strictly a loss of information: the row would claim we do
              // not know what the target did while still carrying the `resultJson` proving we do — and the
              // resume gate reads exactly that pair. A settle against an already-terminal row is a bug in the
              // caller, and the honest response is to leave the durable answer alone.
              .where(and(whereIdentity(identity), eq(runEffects.state, 'prepared')))
              .run().changes;
            // **Leaving durable truth alone is right; REPORTING that the transition happened is not.**
            // The `changes` count was discarded, so a missing row and an already-terminal one both resolved
            // as success — and the registry proceeded believing a real external effect was journaled. A
            // review reproduced it: `settle` on an identity that had never been prepared returned normally
            // having changed zero rows. Corruption, an accidental delete, or a state-machine race was
            // converted from a loud fail-closed condition into a silent one, past the
            // `ToolEffectNeedsAttentionError` path that exists for exactly this.
            if (changed !== 1) {
              throw new EffectTransitionError(identity, state, changed);
            }
          },
          { behavior: 'immediate' },
        ),
      ),

    /**
     * Delete a `prepared` claim for an effect that PROVABLY never left the process (ADR-0080 §7).
     *
     * Constrained to `prepared`, like `settle`: a terminal row records something that DID happen, and this
     * must never be able to erase it. Zero rows changed is NOT an error here — unlike `settle`, this is a
     * best-effort release of a claim, and a claim that is already gone is the outcome it wanted.
     */
    discard: (identity) =>
      withBusyRetry(() =>
        db.transaction(
          (tx) => {
            tx.delete(runEffects)
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
            ...retainedResult(row.scope, row.resultJson),
            ...(row.targetIdempotencyKey === null
              ? {}
              : { targetIdempotencyKey: row.targetIdempotencyKey }),
          }),
        );
    },

    // Encoded to match `effectScope` byte for byte — the query and the writer must agree, and the trailing
    // `:` lives inside the prefix so `s1` can never reach `s10`'s rows.
    unresolvedForSession: (sessionId) =>
      unresolvedInScope(`session:${encodeURIComponent(sessionId)}:`, true),

    unresolvedForRun: (runId) => unresolvedInScope(`run:${encodeURIComponent(runId)}:`),

    readSessionDisclosureSnapshot: (sessionId) => {
      requireSessionEffectTransactionOwnership(db);
      const prefix = `session:${encodeURIComponent(sessionId)}:`;
      const range = scopeRange(prefix);
      return db.transaction((tx) => {
        // Do not even SELECT result_json. A legacy payload is outside this reader's projection.
        const rows = tx
          .select({
            id: runEffects.id,
            scope: runEffects.scope,
            slot: runEffects.slot,
            toolId: runEffects.toolId,
            state: runEffects.state,
            attemptJson: runEffects.attemptJson,
          })
          .from(runEffects)
          .where(and(gte(runEffects.scope, range.from), lt(runEffects.scope, range.toExclusive)))
          .orderBy(asc(runEffects.createdAt), asc(runEffects.id))
          .all();
        const calls = new Map<string, string>();
        const duplicates = new Set<string>();
        const history = tx
          .select()
          .from(sessionMessages)
          .where(eq(sessionMessages.sessionId, sessionId))
          .orderBy(asc(sessionMessages.sequenceNumber))
          .all()
          .map(fromSessionMessageRow);
        for (const message of history) {
          for (const part of message.content) {
            if (part.type !== 'tool_call') continue;
            if (calls.has(part.id)) duplicates.add(part.id);
            calls.set(part.id, part.name);
          }
        }
        // Schema-valid rows can still be unfinished, orphaned or abandoned. Only the shared
        // structural projector proves completion; working compaction/trim boundaries never filter it.
        const completedCalls = new Set(
          completedSessionTurns(history, false).flatMap((turn) =>
            turn.messages.flatMap((message) =>
              message.content.flatMap((part) => (part.type === 'tool_call' ? [part.id] : [])),
            ),
          ),
        );
        const committed: CapturedSessionEffect[] = [];
        const disclosures: SessionEffectDisclosure[] = [];
        for (const row of rows) {
          const state = coerceEffectState(row.state);
          if (state !== 'committed') {
            disclosures.push({ toolId: row.toolId, state, reason: 'unresolved' });
            continue;
          }
          committed.push({
            id: row.id,
            identity: { scope: row.scope, slot: row.slot, toolId: row.toolId },
          });
          // A committed user command is not a model turn, including legacy negative-slot commands.
          if (row.slot < 0) continue;
          const id = sessionAttemptToolCallId(row.attemptJson);
          const parsed = id === undefined ? undefined : parseSessionToolCallId(id);
          if (
            parsed === undefined ||
            row.scope !== `${prefix}${String(parsed.turnKey)}` ||
            row.slot !== parsed.slot ||
            (id !== undefined && duplicates.has(id))
          ) {
            disclosures.push({ toolId: row.toolId, state, reason: 'unattributable' });
          } else if (id !== undefined && calls.has(id) && calls.get(id) !== row.toolId) {
            disclosures.push({ toolId: row.toolId, state, reason: 'unattributable' });
          } else if (id !== undefined && calls.has(id) && !completedCalls.has(id)) {
            disclosures.push({ toolId: row.toolId, state, reason: 'unattributable' });
          } else if (id === undefined || !calls.has(id)) {
            disclosures.push({ toolId: row.toolId, state, reason: 'turn_incomplete' });
          }
        }
        return { committed, disclosures };
      });
    },

    sweepCommittedForSession: (sessionId, captured) => {
      requireSessionEffectTransactionOwnership(db);
      const range = scopeRange(`session:${encodeURIComponent(sessionId)}:`);
      const deleted = withBusyRetry(() =>
        db.transaction(
          (tx) => {
            let changes = 0;
            // Four bindings per captured address plus the range/state predicates, below 999 per statement.
            // All chunks share ONE transaction: failure cannot consume only part of the disclosed snapshot.
            for (let i = 0; i < captured.length; i += 100) {
              const addresses = captured
                .slice(i, i + 100)
                .map((row) => and(eq(runEffects.id, row.id), whereIdentity(row.identity)));
              changes += tx
                .delete(runEffects)
                .where(
                  and(
                    gte(runEffects.scope, range.from),
                    lt(runEffects.scope, range.toExclusive),
                    eq(runEffects.state, 'committed'),
                    or(...addresses),
                  ),
                )
                .run().changes;
            }
            return changes;
          },
          { behavior: 'immediate' },
        ),
      );
      return { deleted, checkpoint: checkpointSessionEffectPrivacy(db) };
    },

    sweepCommittedForRun: (runId) => {
      // Scoped to ONE run that can no longer be resumed, never "everything older than N days". Sweeping by
      // age would delete the evidence §4's gate reads while the run is still resumable, reintroducing the
      // duplicate this whole mechanism prevents — so the caller must be able to say "this run is over", and
      // only the caller knows that.
      //
      // `committed` ONLY. Unresolved rows are never swept: they are the record an operator needs, they
      // outlive their run deliberately, and that is why the row carries no foreign key to `runs` — a purge
      // is exactly when the record matters most.
      const range = scopeRange(`run:${encodeURIComponent(runId)}:`);
      const result = db
        .delete(runEffects)
        .where(
          and(
            gte(runEffects.scope, range.from),
            lt(runEffects.scope, range.toExclusive),
            eq(runEffects.state, 'committed'),
          ),
        )
        .run();
      return Number(result.changes);
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
   * Run wiring supplies node/fence audit fields. Session dispatch forwards the actual
   * provider attempt and engine-owned tool-call id per call, replacing these defaults.
   */
  attempt: EffectAttemptId,
): EffectDispatchPort {
  const identityFor = (slot: number, toolId: string): EffectIdentity => ({
    scope: effectScope(correlation),
    slot,
    toolId,
  });
  return {
    prepare: (slot, toolId, tier, redactedArgs, targetIdempotencyKey, callAttempt) => {
      try {
        return Promise.resolve(
          store.prepare(
            identityFor(slot, toolId),
            correlation,
            callAttempt === undefined ? attempt : { ...attempt, ...callAttempt },
            tier,
            digestOf(redactedArgs),
            targetIdempotencyKey,
          ),
        );
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
    discard: (slot, toolId) => {
      try {
        store.discard(identityFor(slot, toolId));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * Adapt the store's read half to the engine's {@link EffectResumePort} — the resume gate's whole seam
 * ([effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §4).
 *
 * The filtering happens HERE rather than in the engine because `blocksResume` needs the retained result, and
 * a result is host data: shipping every record across the seam so the engine could re-derive the same
 * predicate would move payloads it has no use for and no way to bound.
 */
export function createEffectResumePort(store: EffectJournalStore): EffectResumePort {
  return {
    unresolvedForRun: (runId) => {
      try {
        const blocking: UnresolvedEffect[] = store.unresolvedForRun(runId).map((record) => ({
          identity: record.identity,
          state: record.state,
          tier: record.tier,
          // Decoded from the scope, not carried separately: the scope IS the durable key, so deriving the
          // node from it cannot drift from what the row actually belongs to.
          nodeId: nodeIdFromRunScope(record.identity.scope) ?? '(unknown node)',
        }));
        return Promise.resolve(blocking);
      } catch (error) {
        // A read that FAILS is not "nothing is blocking". Rejecting sends the gate down its fail-closed
        // path, which is the same answer ADR-0075 gives for an unreadable event log.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/**
 * The retained result of a row, as a spreadable fragment — absent when there is none, and absent when the
 * stored JSON does not parse.
 *
 * **An unparsable result is NO result, not a crash.** `blocksResume` then reads the row as blocking, which
 * is the honest answer: a committed row we cannot re-deliver stops the resume exactly as an unresolved one
 * does. Throwing here instead would take out the whole gate read, and the gate's own catch would report a
 * JSON syntax error as the reason a run cannot continue.
 */
function retainedResult(scope: string, resultJson: string | null): { result?: unknown } {
  if (scope.startsWith('session:') || resultJson === null) return {};
  try {
    return { result: JSON.parse(resultJson) as unknown };
  } catch {
    return {};
  }
}

/** Attempt metadata is audit input, never a user-facing JSON/parser diagnostic. */
function sessionAttemptToolCallId(json: string): string | undefined {
  let attempt: unknown;
  try {
    attempt = JSON.parse(json);
  } catch {
    return undefined;
  }
  return attempt !== null &&
    typeof attempt === 'object' &&
    'toolCallId' in attempt &&
    typeof attempt.toolCallId === 'string'
    ? attempt.toolCallId
    : undefined;
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
 * A vetted implementation (`node:crypto`), never a hand-rolled one: CLAUDE.md rule 3. The canonical form
 * itself moved to `@relavium/shared` when ADR-0084's consent gate became a second caller — a digest defined
 * by one package's module-private helper is not a contract a second implementation can be held to.
 */
function digestOf(redactedArgs: unknown): string {
  return createHash('sha256').update(canonicalJson(redactedArgs)).digest('hex');
}
