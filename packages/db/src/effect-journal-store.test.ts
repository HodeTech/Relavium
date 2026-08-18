import { randomUUID } from 'node:crypto';

import { isEffectConflictError, type EffectCorrelation } from '@relavium/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createEffectJournalStore, type EffectJournalStore } from './effect-journal-store.js';

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
});
