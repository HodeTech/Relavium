import type { UsageDisposition } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient, type Db } from './client.js';
import { createSessionStore, type SessionCostEntry } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';
import { type SessionUsageReceipt } from './session-usage-receipt.js';
import { SessionUsageError } from './session-usage-write.js';

let client: DbClient;
beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
});
afterEach(() => {
  client.sqlite.close();
});
const missing: UsageDisposition = {
  kind: 'incomplete',
  evidence: { kind: 'missing', reason: 'not_reported' },
};
function setup(db: Db = client.db) {
  const usage = createSessionUsageStore(db);
  usage.createFreshSession({
    id: 's',
    agentSlug: 'a',
    context: { workingDir: '/tmp', fsScopeTier: 'sandboxed' },
    createdAt: '2026-10-10T00:00:00.000Z',
  });
  const costs = createSessionStore(db);
  const begin = (model = 'm') =>
    usage.beginInvocation({
      sessionId: 's',
      model,
      producerId: 'p',
      dispatchId: 'd',
      round: 0,
      chainAttempt: 1,
    });
  const entry = (receipt: SessionUsageReceipt): SessionCostEntry => ({
    id: `c-${receipt.invocation.ordinal}`,
    sessionId: 's',
    model: receipt.model,
    inputTokens: 1,
    outputTokens: 2,
    costMicrocents: 7,
    priced: true,
    ts: 1,
    usageReceipt: receipt,
  });
  return { usage, costs, begin, entry };
}

describe('ADR-0104 production session coverage', () => {
  it('creates a hidden complete-zero one-shot owner once and admits only its exact live owner capability', () => {
    const usage = createSessionUsageStore(client.db),
      costs = createSessionStore(client.db);
    const owner = usage.createFreshOneShotOwner({ sessionId: 'one', now: 1 });
    expect(owner.effectTurnKey).toBe(1);
    expect(costs.loadSession('one')).toBeUndefined();
    expect(costs.listSessions()).toEqual([]);
    expect(costs.loadMessages('one')).toEqual([]);
    expect(usage.loadCoverage('one')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(() => usage.createFreshOneShotOwner({ sessionId: 'one', now: 2 })).toThrow();
    const input = {
      sessionId: 'one',
      model: 'm',
      producerId: 'p',
      dispatchId: 'd',
      round: 0,
      chainAttempt: 1,
    };
    expect(() => usage.beginInvocation(input)).toThrow(SessionUsageError);
    expect(() => usage.beginInvocation(input, { ...owner })).toThrow(SessionUsageError);
    const receipt = usage.beginInvocation(input, owner);
    expect(
      costs.recordSessionCost({
        id: 'one-cost',
        sessionId: 'one',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        costMicrocents: 0,
        priced: true,
        ts: 2,
        usageReceipt: receipt,
      }),
    ).toBe(true);
    expect(usage.loadCoverage('one')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(costs.listSessions()).toEqual([]);
    expect(costs.loadFull('one')).toBeUndefined();
  });

  it('atomically settles only exact live receipts through the sole cost writer', () => {
    const { usage, costs, begin, entry } = setup();
    const receipt = begin();
    expect(usage.loadCoverage('s')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 1,
      unknownCalls: 0,
    });
    expect(() => costs.recordSessionCost(entry({ ...receipt }))).toThrow(SessionUsageError);
    usage.createFreshSession({
      id: 'other-existing',
      agentSlug: 'a',
      context: { workingDir: '/tmp', fsScopeTier: 'sandboxed' },
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    const original = costs.loadSessionCostBreakdown('s');
    const other = costs.loadSessionCostBreakdown('other-existing');
    // Use the real live capability against another existing owner/model: a cloned receipt
    // alone would be refused by the WeakMap before reaching the correlation guard.
    expect(
      () => costs.recordSessionCost({ ...entry(receipt), sessionId: 'other-existing' }),
      'USAGE_CAUSAL_RECEIPT_OWNER',
    ).toThrow(SessionUsageError);
    expect(() => costs.recordSessionCost({ ...entry(receipt), model: 'other-model' })).toThrow(
      SessionUsageError,
    );
    expect(costs.loadSessionCostBreakdown('s')).toEqual(original);
    expect(costs.loadSessionCostBreakdown('other-existing')).toEqual(other);
    expect(usage.loadCoverage('s')?.coverage.pendingInvocations).toBe(1);
    expect(costs.recordSessionCost(entry(receipt))).toBe(true);
    expect(costs.recordSessionCost(entry(receipt))).toBe(false);
    expect(usage.disposition(receipt, missing)).toBe(false);
    expect(costs.loadSessionCostBreakdown('s')).toMatchObject({
      totalCostMicrocents: 7,
      coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    });
    expect(costs.loadSessionCosts('s')[0]?.callCount).toBe(1);
    expect(
      client.sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get(),
    ).toEqual({ n: 0 });
  });

  it('preserves unknown on retirement and accepts one still-authorized late complete receipt', () => {
    const { usage, costs, begin, entry } = setup();
    const retired = begin('unknown');
    expect(usage.disposition(retired, missing)).toBe(true);
    expect(usage.disposition(retired, missing)).toBe(false);
    usage.retire(retired);
    expect(costs.recordSessionCost(entry(retired))).toBe(false);
    const late = begin('late');
    usage.disposition(late, missing);
    expect(costs.recordSessionCost(entry(late))).toBe(true);
    expect(costs.recordSessionCost(entry(late))).toBe(false);
    expect(usage.loadCoverage('s')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 1,
    });
    expect(costs.loadSessionCostBreakdown('s').models).toEqual([
      { model: 'late', coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 } },
      { model: 'unknown', coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 } },
    ]);
  });

  it.each<UsageDisposition>([
    { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } },
    {
      kind: 'incomplete',
      evidence: { kind: 'partial', known: { outputTokens: 3 }, reason: 'missing_fields' },
    },
    { kind: 'incomplete', evidence: { kind: 'missing', reason: 'invalid_fields' } },
  ])(
    'retires final incomplete late evidence without recounting unknown or retaining receipt identity: %j',
    (finalDisposition) => {
      const { usage, costs, begin, entry } = setup();
      const receipt = begin('late');
      expect(usage.disposition(receipt, missing)).toBe(true);
      // The late receipt resolved without complete evidence. The producer's final disposition
      // does not establish another unknown call; positive authority-end separately retires its row.
      expect(usage.disposition(receipt, finalDisposition)).toBe(false);
      usage.retire(receipt);
      usage.retire(receipt);
      expect(usage.disposition(receipt, finalDisposition)).toBe(false);
      expect(costs.recordSessionCost(entry(receipt))).toBe(false);
      expect(
        client.sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get(),
      ).toEqual({ n: 0 });
      expect(costs.loadSessionCostBreakdown('s')).toMatchObject({
        totalCostMicrocents: 0,
        rows: [],
        coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 },
        models: [
          {
            model: 'late',
            coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 },
          },
        ],
      });
    },
  );

  it('does not re-admit retired ordinals or grant authority by reading/reopening a store', () => {
    const { usage, begin } = setup();
    const receipt = begin();
    usage.retire(receipt);
    const next = begin();
    expect(next.invocation.ordinal).toBe(receipt.invocation.ordinal + 1);
    expect(usage.loadCoverage('s')?.coverage.pendingInvocations).toBe(2);
    expect(() =>
      usage.disposition({ ...next, invocation: { ...next.invocation } }, missing),
    ).toThrow(SessionUsageError);
    expect(createSessionUsageStore(client.db).loadCoverage('s')?.coverage.pendingInvocations).toBe(
      2,
    );
  });

  it.each([
    { kind: 'not_invoked', reason: 'credentials' },
    { kind: 'official_refusal', reason: 'pre_content_refusal' },
  ] as const)('releases $kind without inventing a call or actual charge', (disposition) => {
    const { usage, costs, begin } = setup();
    const receipt = begin();
    expect(usage.disposition(receipt, disposition)).toBe(true);
    expect(usage.disposition(receipt, disposition)).toBe(false);
    expect(usage.loadCoverage('s')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(costs.loadSessionCosts('s')).toEqual([]);
  });

  it('rolls back settlement and keeps receipt authority if final acknowledgement fails', () => {
    const { usage, costs, begin, entry } = setup();
    const receipt = begin();
    client.sqlite.exec(
      "CREATE TRIGGER break_ack BEFORE UPDATE OF usage_ack_revision ON agent_sessions BEGIN SELECT RAISE(ABORT, 'test'); END",
    );
    expect(() => costs.recordSessionCost(entry(receipt))).toThrow();
    expect(costs.loadSession('s')?.totalCostMicrocents).toBe(0);
    expect(usage.loadCoverage('s')?.coverage.pendingInvocations).toBe(1);
    client.sqlite.exec('DROP TRIGGER break_ack');
    expect(costs.recordSessionCost(entry(receipt))).toBe(true);
  });

  it('refuses nested pending writes and fails atomically at bounded allocator exhaustion', () => {
    const { usage, begin } = setup();
    expect(() => client.db.transaction(() => begin())).toThrow(SessionUsageError);
    client.sqlite.exec('UPDATE agent_sessions SET usage_invocation_high_water = 9007199254740991');
    expect(() => begin()).toThrow(SessionUsageError);
    expect(usage.loadCoverage('s')?.coverage.pendingInvocations).toBe(0);
  });

  it('qualifies uncorrelated legacy money and preserves explicit native media accounting', () => {
    const { usage, costs, begin, entry } = setup();
    const receipt = begin();
    usage.disposition(receipt, { kind: 'not_invoked', reason: 'cancelled' });
    const { usageReceipt: heldReceipt, ...uncorrelated } = entry(receipt);
    expect(heldReceipt).toBe(receipt);
    costs.recordSessionCost({
      ...uncorrelated,
      accountingBasis: 'native_media',
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(usage.loadCoverage('s')?.coverage.unverified).toBe(false);
    costs.recordSessionCost(uncorrelated);
    expect(usage.loadCoverage('s')?.coverage.unverified).toBe(true);
    costs.releaseSessionConservativeCommitments('s', 1);
    expect(usage.loadCoverage('s')?.coverage.unverified).toBe(true);
  });
});
