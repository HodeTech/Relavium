import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createSessionStore } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';

let client: DbClient;
beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
});
afterEach(() => client.sqlite.close());

describe('accounting snapshots independently of session discovery', () => {
  it.each(['visible', 'one-shot', 'deleted'] as const)(
    'preserves actual money and independent qualifications for a %s owner',
    (kind) => {
      const costs = createSessionStore(client.db);
      const usage = createSessionUsageStore(client.db);
      const owner =
        kind === 'one-shot' ? usage.createFreshOneShotOwner({ sessionId: 's', now: 1 }) : undefined;
      if (owner === undefined) {
        usage.createFreshSession({
          id: 's',
          agentSlug: 'a',
          context: { workingDir: '/tmp', fsScopeTier: 'sandboxed' },
          createdAt: '2026-10-11T00:00:00.000Z',
        });
      }
      expect(costs.loadSessionCostBreakdown('s')).toEqual({
        totalCostMicrocents: 0,
        rows: [],
        coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
        models: [],
      });
      const begin = (model: string) =>
        usage.beginInvocation(
          {
            sessionId: 's',
            model,
            producerId: 'p',
            dispatchId: 'd',
            round: 0,
            chainAttempt: 1,
          },
          owner,
        );
      for (const [model, amount, priced] of [
        ['positive', 123, true],
        ['zero', 0, true],
        ['unpriced', 0, false],
      ] as const) {
        const receipt = begin(model);
        const entry = {
          id: model,
          sessionId: 's',
          model,
          inputTokens: 1,
          outputTokens: 2,
          costMicrocents: amount,
          priced,
          ts: 2,
          usageReceipt: receipt,
        };
        expect(costs.recordSessionCost(entry)).toBe(true);
        expect(costs.recordSessionCost(entry)).toBe(false);
      }
      const unknown = begin('unknown');
      expect(
        usage.disposition(unknown, {
          kind: 'incomplete',
          evidence: { kind: 'missing', reason: 'not_reported' },
        }),
      ).toBe(true);
      usage.retire(unknown);
      begin('pending');
      if (kind === 'deleted') {
        const record = costs.loadSession('s');
        if (record === undefined) throw new Error('missing visible control owner');
        costs.updateSession({ ...record, deletedAt: '2026-10-11T00:01:00.000Z' });
      }
      const snapshot = costs.loadSessionCostBreakdown('s');
      expect(snapshot.totalCostMicrocents).toBe(123);
      expect(snapshot.rows.reduce((sum, row) => sum + row.costMicrocents, 0)).toBe(123);
      expect(snapshot.rows.reduce((sum, row) => sum + row.callCount, 0)).toBe(3);
      expect(snapshot.rows.reduce((sum, row) => sum + row.unpricedCalls, 0)).toBe(1);
      expect(snapshot.coverage).toEqual({
        unverified: false,
        pendingInvocations: 1,
        unknownCalls: 1,
      });
      expect(snapshot.models).toHaveLength(5);
      expect(
        client.sqlite.prepare('SELECT total_cost_microcents FROM agent_sessions').get(),
      ).toEqual({
        total_cost_microcents: 123,
      });
      if (kind !== 'visible') {
        expect(costs.loadSession('s')).toBeUndefined();
        expect(costs.loadFull('s')).toBeUndefined();
        expect(costs.listSessions()).toEqual([]);
        expect(costs.loadMessages('s')).toEqual([]);
      } else {
        expect(costs.loadSession('s')?.totalCostMicrocents).toBe(123);
        expect(costs.listSessions()).toHaveLength(1);
      }
    },
  );

  it('keeps an absent owner unverified without inventing money or discovery', () => {
    const costs = createSessionStore(client.db);
    expect(costs.loadSessionCostBreakdown('absent')).toEqual({
      totalCostMicrocents: 0,
      rows: [],
      coverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
      models: [],
    });
    expect(costs.listSessions()).toEqual([]);
  });

  it.each([-1, 'invalid-total'])(
    'retains canonical numeric validation for a hidden owner with total %j',
    (total) => {
      createSessionUsageStore(client.db).createFreshOneShotOwner({ sessionId: 'bad', now: 1 });
      client.sqlite
        .prepare('UPDATE agent_sessions SET total_cost_microcents = ? WHERE id = ?')
        .run(total, 'bad');
      expect(() => createSessionStore(client.db).loadSessionCostBreakdown('bad')).toThrow();
    },
  );
});
