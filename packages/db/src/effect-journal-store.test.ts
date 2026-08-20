import { randomUUID } from 'node:crypto';

import { effectScope, isEffectConflictError, type EffectCorrelation } from '@relavium/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createEffectJournalPort,
  createEffectJournalStore,
  type EffectJournalStore,
} from './effect-journal-store.js';

/**
 * The journal against a real SQLite database (ADR-0080). What is proven here is the half only the store can
 * answer: that the UNIQUE identity really is the concurrency boundary, and that a record round-trips with
 * everything the resume gate needs to decide.
 */
describe('the effect journal store', () => {
  let client: DbClient;
  let store: EffectJournalStore;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    store = createEffectJournalStore(client.db, { uuid: () => randomUUID(), now: () => 1_700_000 });
  });

  const RUN: EffectCorrelation = { kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 };
  const ID = { scope: 'run:r1:n1', slot: 0, toolId: 'http_request' };
  const ATTEMPT = { providerAttempt: 1, toolCallId: 'tc1', nodeAttempt: 1 };

  it('a second prepare for the same identity is REFUSED — the concurrency boundary', () => {
    // This is what makes two processes preparing one effect resolve to a single dispatch. Without it the
    // journal is a log, not a mechanism: both would prepare, both would dispatch, both would settle.
    store.prepare(ID, RUN, ATTEMPT, 3, 'digest-a');
    let caught: unknown;
    try {
      store.prepare(ID, RUN, ATTEMPT, 3, 'digest-b');
    } catch (error) {
      caught = error;
    }
    expect(isEffectConflictError(caught)).toBe(true);
    expect(store.recordsFor(RUN)).toHaveLength(1); // …and the loser wrote nothing
  });

  it('a DIFFERENT slot in the same node is a different effect', () => {
    // One model response can contain several tool calls. Keying on the correlation alone would make the
    // second legitimate effect of a turn collide with the first.
    store.prepare(ID, RUN, ATTEMPT, 3, 'd1');
    store.prepare({ ...ID, slot: 1 }, RUN, ATTEMPT, 3, 'd2');
    expect(store.recordsFor(RUN).map((r) => r.identity.slot)).toEqual([0, 1]);
  });

  it('a record is found by a scope that DROPPED the retry attempt', () => {
    // The resume-gate property, end to end through the store: the row is written under one attempt and found
    // again after a crash-resume has reset it — which is precisely when the gate must see it.
    store.prepare(ID, { kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 3 }, ATTEMPT, 3, 'd');
    expect(store.recordsFor({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 })).toHaveLength(
      1,
    );
  });

  it('settle carries the result when there is one, and leaves it ABSENT when there is not', () => {
    // The absence is load-bearing: the gate refuses a `committed` row it cannot re-deliver, so "no result"
    // must be distinguishable from "a result that happens to be undefined".
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    store.settle(ID, 'committed', { ok: true });
    expect(store.recordsFor(RUN)[0]).toMatchObject({ state: 'committed', result: { ok: true } });

    store.prepare({ ...ID, slot: 1 }, RUN, ATTEMPT, 3, 'd');
    store.settle({ ...ID, slot: 1 }, 'ambiguous');
    const second = store.recordsFor(RUN)[1];
    expect(second?.state).toBe('ambiguous');
    expect(second !== undefined && 'result' in second).toBe(false);
  });

  it('a session effect lives in the same table with no run at all', () => {
    // `run_events.run_id` is NOT NULL with a foreign key, which is why the journal is its own table: a
    // session effect has no run to reference and must still be journaled.
    const session: EffectCorrelation = { kind: 'session', sessionId: 's1', turn: 2 };
    store.prepare(
      { scope: 'session:s1:2', slot: 0, toolId: 'run_command' },
      session,
      ATTEMPT,
      3,
      'd',
    );
    expect(store.recordsFor(session)).toHaveLength(1);
    expect(store.recordsFor(RUN)).toHaveLength(0); // …and does not leak into a run's scope
  });

  it('a settle out of a TERMINAL state is refused — the durable answer is not overwritten', () => {
    // `committed → ambiguous` is strictly a loss: the row would claim we do not know what the target did
    // while still carrying the result proving we do, and the resume gate reads exactly that pair.
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    store.settle(ID, 'committed', { ticket: 42 });
    store.settle(ID, 'ambiguous');

    expect(store.recordsFor(RUN)[0]).toMatchObject({ state: 'committed', result: { ticket: 42 } });
  });

  it('a replay verdict round-trips the retained result, and a DIFFERENT digest is refused', () => {
    // §4's one forward path, against the store that actually ships. A review neutered the whole replay
    // branch (`held.state === 'committed' &&` → `false &&`) and every one of the 2,406 CLI + 336 db tests
    // stayed green — only the in-memory reference proved anything, which is the divergence this file's own
    // header says the repo has been bitten by before.
    store.prepare(ID, RUN, ATTEMPT, 3, 'digest-1');
    store.settle(ID, 'committed', { ok: true });

    expect(store.prepare(ID, RUN, ATTEMPT, 3, 'digest-1')).toEqual({
      outcome: 'replay',
      result: { ok: true },
    });
    // A different digest at the same slot is a DIFFERENT call that landed in the same ordinal — answering it
    // with the old answer would be a silent wrong result, so it refuses.
    expect(() => store.prepare(ID, RUN, ATTEMPT, 3, 'digest-2')).toThrow();
    try {
      store.prepare(ID, RUN, ATTEMPT, 3, 'digest-2');
    } catch (error) {
      expect(isEffectConflictError(error)).toBe(true);
    }
  });

  it('a committed row with NO retained result refuses rather than replaying', () => {
    // "A committed row is not a green light" at the dispatch site: with nothing to re-deliver, waving the
    // call through would re-fire the effect to obtain a result we failed to keep.
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    store.settle(ID, 'committed'); // …no result
    expect(() => store.prepare(ID, RUN, ATTEMPT, 3, 'd')).toThrow();
  });

  it('an UNRESOLVED row refuses — it is the live-collision case, not a replay', () => {
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    expect(() => store.prepare(ID, RUN, ATTEMPT, 3, 'd')).toThrow();
  });

  it('a CORRUPT retained result refuses instead of throwing a raw SyntaxError', () => {
    // Reached through `prepare`, an unparsable row escaped the ladder as a plain `SyntaxError`: not an
    // `EffectConflictError`, so the node re-dispatched, re-hit the same corrupt row, and burned its whole
    // retry budget while reporting a JSON syntax error as a tool failure. An unparsable retained result IS
    // a committed row we cannot re-deliver, which is §4's refusal.
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    store.settle(ID, 'committed', { ok: true });
    client.sqlite
      .prepare(`UPDATE run_effects SET result_json = ? WHERE scope = ?`)
      .run('{not json', ID.scope);

    try {
      store.prepare(ID, RUN, ATTEMPT, 3, 'd');
      expect.unreachable('a corrupt retained result must refuse');
    } catch (error) {
      expect(isEffectConflictError(error)).toBe(true);
    }
  });

  it('flagForAttention is terminal and visible to the gate', () => {
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    store.flagForAttention(ID);
    expect(store.recordsFor(RUN)[0]?.state).toBe('needs_attention');
  });

  it('an UNRECOGNISED persisted state and tier degrade toward caution, not toward safety', () => {
    // The direction is the whole point and it was untested: these rows are read back by a FUTURE build, and
    // a downgrade schema-migration, a partial write, or a hand-edited `history.db` can put a value here that
    // this build has no case for. Degrading an unknown state to `committed` would let a resume conclude the
    // effect is done; degrading an unknown tier to 1 would claim the target deduplicates when nothing knows
    // that it does. So: `needs_attention` (stop and ask a human) and tier 3 (promise least).
    store.prepare(ID, RUN, ATTEMPT, 3, 'd');
    client.sqlite
      .prepare(`UPDATE run_effects SET state = ?, tier = ? WHERE scope = ?`)
      .run('quantum_superposition', 7, 'run:r1:n1');

    expect(store.recordsFor(RUN)[0]).toMatchObject({ state: 'needs_attention', tier: 3 });
  });

  it('retains the tier and the target idempotency key a tier-1 retry would reuse', () => {
    store.prepare(ID, RUN, ATTEMPT, 1, 'd', 'idem-key-1');
    expect(store.recordsFor(RUN)[0]).toMatchObject({ tier: 1, targetIdempotencyKey: 'idem-key-1' });
  });

  it('retention sweeps COMMITTED rows of one run and leaves everything else standing', () => {
    // §9. Committed rows have no reader once the run can no longer be resumed. Unresolved rows are never
    // swept — they are the record an operator needs, which is also why `run_effects` has no FK to `runs`.
    store.prepare({ scope: 'run:r1:done', slot: 0, toolId: 'http_request' }, RUN, ATTEMPT, 3, 'd');
    store.settle({ scope: 'run:r1:done', slot: 0, toolId: 'http_request' }, 'committed', { ok: 1 });
    store.prepare({ scope: 'run:r1:stuck', slot: 0, toolId: 'http_request' }, RUN, ATTEMPT, 3, 'd');
    // …a DIFFERENT run whose id shares a prefix with this one: `r1` must not sweep `r10`'s rows.
    const other: EffectCorrelation = { kind: 'run', runId: 'r10', nodeId: 'n', attempt: 1 };
    store.prepare({ scope: 'run:r10:n', slot: 0, toolId: 'http_request' }, other, ATTEMPT, 3, 'd');
    store.settle({ scope: 'run:r10:n', slot: 0, toolId: 'http_request' }, 'committed', { ok: 2 });

    expect(store.sweepCommittedForRun('r1')).toBe(1);
    expect(
      store.recordsFor({ kind: 'run', runId: 'r1', nodeId: 'stuck', attempt: 1 }),
    ).toHaveLength(1);
    expect(store.recordsFor(other)).toHaveLength(1); // the prefix neighbour survived
  });

  it('a `:` inside an id cannot cross into another run’s or session’s rows', () => {
    // The separator is `:`, so an unencoded id containing one silently extends the prefix. A review proved
    // both halves against a real SQLite file: `unresolvedForSession('a')` disclosed session `a:9`'s rows,
    // and `sweepCommittedForRun('b')` DELETED run `b:9`'s committed rows — destroying the replay evidence
    // §4's gate reads for a run that was still resumable.
    const nested: EffectCorrelation = { kind: 'run', runId: 'b:9', nodeId: 'n', attempt: 1 };
    store.prepare(
      { scope: effectScope(nested), slot: 0, toolId: 'http_request' },
      nested,
      ATTEMPT,
      3,
      'd',
    );
    store.settle({ scope: effectScope(nested), slot: 0, toolId: 'http_request' }, 'committed', 1);

    expect(store.sweepCommittedForRun('b')).toBe(0); // …the neighbour is untouched
    expect(store.recordsFor(nested)).toHaveLength(1);

    const nestedSession: EffectCorrelation = { kind: 'session', sessionId: 'a:9', turn: 0 };
    store.prepare(
      { scope: effectScope(nestedSession), slot: 0, toolId: 'run_command' },
      nestedSession,
      ATTEMPT,
      3,
      'd',
    );
    expect(store.unresolvedForSession('a')).toHaveLength(0);
    expect(store.unresolvedForSession('a:9')).toHaveLength(1);
  });

  it('an id carrying LIKE wildcards cannot widen the match', () => {
    // The scope query is a byte-range, not a `LIKE` — drizzle emits no `ESCAPE` clause, so a `%` in a
    // caller-supplied id would otherwise match everything under `session:`.
    const wild: EffectCorrelation = { kind: 'session', sessionId: '%', turn: 0 };
    const real: EffectCorrelation = { kind: 'session', sessionId: 'real', turn: 0 };
    store.prepare(
      { scope: 'session:real:0', slot: 0, toolId: 'run_command' },
      real,
      ATTEMPT,
      3,
      'd',
    );

    expect(store.unresolvedForSession('%')).toHaveLength(0);
    expect(store.unresolvedForSession('real')).toHaveLength(1);
    void wild;
  });

  it('unresolvedForSession spans every TURN and reports only what blocks', () => {
    // A session's rows are spread across one scope per turn, and §8's disclosure is about the session.
    const t0: EffectCorrelation = { kind: 'session', sessionId: 's9', turn: 0 };
    const t1: EffectCorrelation = { kind: 'session', sessionId: 's9', turn: 1 };
    store.prepare({ scope: 'session:s9:0', slot: 0, toolId: 'run_command' }, t0, ATTEMPT, 3, 'd');
    store.settle({ scope: 'session:s9:0', slot: 0, toolId: 'run_command' }, 'committed', 'out');
    store.prepare({ scope: 'session:s9:1', slot: 0, toolId: 'run_command' }, t1, ATTEMPT, 3, 'd');

    const unresolved = store.unresolvedForSession('s9');
    expect(unresolved.map((r) => r.identity.scope)).toEqual(['session:s9:1']);
  });

  describe('the port digests its args through the SHARED canonical form (ADR-0084 §3 landing)', () => {
    const port = (): ReturnType<typeof createEffectJournalPort> =>
      createEffectJournalPort(store, RUN, ATTEMPT);

    it('a realistic redacted argument shape digests, and key ORDER cannot change it', async () => {
      // `canonicalJson` moved to `@relavium/shared` and grew refusals it never had. This is the behaviour
      // that must NOT have changed: a JSON-derived tool-argument shape — which is all a redacted arg ever
      // is — still produces a digest, and key order still cannot change it, which is what ADR-0080's dedup
      // rests on. The same arguments in the other order are the SAME effect, so the second prepare is
      // refused as a duplicate rather than admitted as a new one.
      const first = await port().prepare(0, 'fs_write', 3, { path: '/tmp/a', body: 'x' });
      expect(first.outcome).toBe('proceed');
      await expect(
        port().prepare(0, 'fs_write', 3, { body: 'x', path: '/tmp/a' }),
      ).rejects.toBeDefined();
    });

    it('a shape with no canonical form REJECTS rather than crashing the dispatch', async () => {
      // The stricter form throws where the old permissive copy silently served `{}`, merging two different
      // values into one digest. The port already wraps `prepare` in a try/catch, so the throw arrives as a
      // rejection — pinned here, because an uncaught throw would take down a tool dispatch.
      await expect(port().prepare(0, 'fs_write', 3, { when: new Date(0) })).rejects.toBeDefined();
    });
  });
});
