/**
 * The `/cost` release's record row ([ADR-0148](../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §6,
 * [ADR-0074](../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §1): with a slot, the release appends a content-free
 * `cost_release` row naming the amount it cleared, in the SAME transaction as the clearing, and only when that amount is above zero. A row
 * that cannot be inserted rolls the whole release back.
 */
import type { AgentSessionRecord } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createSessionStore, type SessionRecordSlot, type SessionStore } from './session-store.js';

const TS = '2026-11-25T00:00:00.000Z';
const session: AgentSessionRecord = {
  id: 'sess-1',
  agentSlug: 'chatter',
  context: { workingDir: '/workspace/s', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: TS,
  updatedAt: TS,
};
const slot = (
  sequenceNumber: number,
  over: Partial<SessionRecordSlot> = {},
): SessionRecordSlot => ({
  id: `record-${sequenceNumber}`,
  sequenceNumber,
  timestamp: TS,
  ...over,
});

let client: DbClient;
let store: SessionStore;
beforeEach(() => {
  client = createClient(':memory:');
  runMigrations(client.db);
  store = createSessionStore(client.db);
  store.createSession(session);
});
afterEach(() => {
  client.sqlite.close();
});

/** Hold `m1: 400` and `m2: 100` as conservative estimates. */
function hold(): void {
  for (const [model, amount] of [
    ['m1', 400],
    ['m2', 100],
  ] as const)
    store.recordSessionConservativeCommitment({
      id: `k-${model}`,
      sessionId: 'sess-1',
      model,
      estimateMicrocents: amount,
      ts: 1,
    });
}
const held = (): { readonly total: number; readonly rows: readonly number[] } => ({
  total: store.loadSession('sess-1')?.totalConservativeMicrocents ?? -1,
  rows: store
    .loadSessionCosts('sess-1')
    .map((row) => row.conservativeMicrocents)
    .sort((a, b) => a - b),
});

describe('the release record row (ADR-0148 §6)', () => {
  it('a release of a held amount appends one cost_release row with exactly that amount, and the holds read 0', () => {
    hold();
    expect(store.releaseSessionConservativeCommitments('sess-1', 9, slot(0))).toBe(500);
    expect(held()).toEqual({ total: 0, rows: [0, 0] });
    expect(store.loadMessages('sess-1')).toEqual([
      {
        id: 'record-0',
        sessionId: 'sess-1',
        sequenceNumber: 0,
        role: 'system',
        content: [],
        record: { kind: 'cost_release', microcents: 500 },
        timestamp: TS,
      },
    ]);
  });

  it('a release of nothing appends nothing, and its slot stays free', () => {
    expect(store.releaseSessionConservativeCommitments('sess-1', 9, slot(0))).toBe(0);
    expect(store.loadMessages('sess-1')).toEqual([]);
    // The slot was not taken: the next row the sequence owner writes there lands.
    store.appendMessage({
      id: 'next',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: TS,
    });
    expect(store.loadMessages('sess-1').map((row) => row.id)).toEqual(['next']);
  });

  it('a row that cannot be inserted (its sequence is taken) rolls the release back: every hold is intact and nothing is recorded', () => {
    hold();
    store.appendMessage({
      id: 'taken',
      sessionId: 'sess-1',
      sequenceNumber: 0,
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      timestamp: TS,
    });
    expect(() => store.releaseSessionConservativeCommitments('sess-1', 9, slot(0))).toThrow();
    expect(held()).toEqual({ total: 500, rows: [100, 400] });
    expect(store.loadMessages('sess-1').map((row) => row.id)).toEqual(['taken']);
  });

  it('a slot the record row is refused for (a malformed timestamp) rolls the release back too', () => {
    hold();
    expect(() =>
      store.releaseSessionConservativeCommitments('sess-1', 9, slot(0, { timestamp: 'yesterday' })),
    ).toThrow();
    expect(held()).toEqual({ total: 500, rows: [100, 400] });
    expect(store.loadMessages('sess-1')).toEqual([]);
  });

  it('without a slot the release writes no row, exactly as before', () => {
    hold();
    expect(store.releaseSessionConservativeCommitments('sess-1', 9)).toBe(500);
    expect(held()).toEqual({ total: 0, rows: [0, 0] });
    expect(store.loadMessages('sess-1')).toEqual([]);
  });
});
