import type { UsageDisposition } from '@relavium/shared';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { SessionUsageQueryGuard } from './fixtures/session-usage-query-guard.js';
import * as schema from './schema.js';
import { createSessionStore, type SessionCostEntry } from './session-store.js';
import type { SessionUsageReceipt } from './session-usage-receipt.js';
import { createSessionUsageStore } from './session-usage-store.js';

let client: DbClient;
beforeEach(() => {
  client = createClient();
  runMigrations(client.db);
});
afterEach(() => client.sqlite.close());

const missing: UsageDisposition = {
  kind: 'incomplete',
  evidence: { kind: 'missing', reason: 'not_reported' },
};

function setup() {
  const guard = new SessionUsageQueryGuard(client.sqlite);
  const db = drizzle(client.sqlite, { schema, logger: guard });
  const usage = createSessionUsageStore(db);
  const costs = createSessionStore(db);
  usage.createFreshSession({
    id: 'query-session',
    agentSlug: 'query-agent',
    context: { workingDir: '/tmp', fsScopeTier: 'sandboxed' },
    createdAt: '2026-10-11T00:00:00.000Z',
  });
  const receipt = usage.beginInvocation({
    sessionId: 'query-session',
    model: 'query-model',
    producerId: 'query-producer',
    dispatchId: 'query-dispatch',
    round: 0,
    chainAttempt: 1,
  });
  const entry: SessionCostEntry = {
    id: 'query-cost',
    sessionId: receipt.sessionId,
    model: receipt.model,
    inputTokens: 1,
    outputTokens: 2,
    costMicrocents: 7,
    priced: true,
    ts: 1,
    usageReceipt: receipt,
  };
  const withReceipt = <T>(operation: () => T) => guard.forReceipt(receipt, operation);
  return { db, guard, usage, costs, receipt, entry, withReceipt };
}

function counts(receipt: SessionUsageReceipt) {
  return client.sqlite
    .prepare('SELECT count(*) AS n FROM session_usage_invocations WHERE session_id = ?')
    .get(receipt.sessionId);
}

describe('session settlement exact-identity query shape', () => {
  it('prices a pending receipt once and performs no extra receipt lookup for duplicate settlement', () => {
    const { guard, usage, costs, receipt, entry, withReceipt } = setup();
    expect(withReceipt(() => costs.recordSessionCost(entry))).toBe(true);
    expect(guard.receiptLookups).toBe(1);
    expect(withReceipt(() => costs.recordSessionCost(entry))).toBe(false);
    expect(withReceipt(() => usage.disposition(receipt, missing))).toBe(false);
    withReceipt(() => usage.retire(receipt));
    expect(guard.receiptLookups).toBe(1);
    expect(guard.queryPlans).toBe(1);
    expect(guard.receiptMutations).toBe(1);
    expect(guard.mutationQueryPlans).toBe(1);
    expect(counts(receipt)).toEqual({ n: 0 });
    expect(costs.loadSessionCostBreakdown(receipt.sessionId)).toMatchObject({
      totalCostMicrocents: 7,
      coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
      rows: [{ callCount: 1 }],
    });
  });

  it('refines only the exact incomplete receipt and removes its unknown contribution once', () => {
    const { guard, usage, costs, receipt, entry, withReceipt } = setup();
    expect(withReceipt(() => usage.disposition(receipt, missing))).toBe(true);
    expect(withReceipt(() => costs.recordSessionCost(entry))).toBe(true);
    expect(withReceipt(() => costs.recordSessionCost(entry))).toBe(false);
    expect(guard.receiptLookups).toBe(2);
    expect(guard.queryPlans).toBe(1);
    expect(guard.receiptMutations).toBe(2);
    expect(guard.mutationQueryPlans).toBe(2);
    expect(counts(receipt)).toEqual({ n: 0 });
    expect(usage.loadCoverage(receipt.sessionId)?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    expect(costs.loadSessionCosts(receipt.sessionId)).toMatchObject([
      { costMicrocents: 7, callCount: 1 },
    ]);
  });

  it.each(['pending', 'incomplete'] as const)(
    'retires a %s receipt without rescanning or erasing uncertainty on later settlement',
    (state) => {
      const { guard, usage, costs, receipt, entry, withReceipt } = setup();
      if (state === 'incomplete')
        expect(withReceipt(() => usage.disposition(receipt, missing))).toBe(true);
      withReceipt(() => usage.retire(receipt));
      const lookups = state === 'incomplete' ? 2 : 1;
      expect(guard.receiptLookups).toBe(lookups);
      expect(withReceipt(() => costs.recordSessionCost(entry))).toBe(false);
      expect(withReceipt(() => usage.disposition(receipt, missing))).toBe(false);
      withReceipt(() => usage.retire(receipt));
      expect(guard.receiptLookups).toBe(lookups);
      expect(guard.queryPlans).toBe(1);
      expect(guard.receiptMutations).toBe(state === 'incomplete' ? 2 : 1);
      expect(guard.mutationQueryPlans).toBe(state === 'incomplete' ? 2 : 1);
      expect(counts(receipt)).toEqual({ n: 0 });
      expect(costs.loadSessionCostBreakdown(receipt.sessionId)).toMatchObject({
        totalCostMicrocents: 0,
        rows: [],
        coverage: {
          unverified: false,
          pendingInvocations: state === 'pending' ? 1 : 0,
          unknownCalls: state === 'incomplete' ? 1 : 0,
        },
      });
    },
  );
});

for (const operation of ['update', 'delete'] as const) {
  it(`${operation}: refuses a real owner-prefix mutation before touching either live receipt`, () => {
    const { db, guard, usage, receipt, withReceipt } = setup();
    usage.beginInvocation({
      sessionId: receipt.sessionId,
      model: 'second-model',
      producerId: 'second-producer',
      dispatchId: 'second',
      round: 0,
      chainAttempt: 1,
    });
    expect(() =>
      withReceipt(() =>
        operation === 'update'
          ? db
              .update(schema.sessionUsageInvocations)
              .set({ coverageState: 'incomplete' })
              .where(eq(schema.sessionUsageInvocations.sessionId, receipt.sessionId))
              .run()
          : db
              .delete(schema.sessionUsageInvocations)
              .where(eq(schema.sessionUsageInvocations.sessionId, receipt.sessionId))
              .run(),
      ),
    ).toThrow('USAGE_QUERY_NOT_EXACT_IDENTITY');
    expect(
      client.sqlite
        .prepare('SELECT coverage_state AS state FROM session_usage_invocations ORDER BY ordinal')
        .all(),
    ).toEqual([{ state: 'pending' }, { state: 'pending' }]);
    expect(usage.loadCoverage(receipt.sessionId)?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 2,
      unknownCalls: 0,
    });
    expect(guard.receiptMutations).toBe(0);
  });
}

for (const operation of ['select', 'update', 'delete'] as const) {
  for (const wrongKey of ['session', 'producer', 'ordinal'] as const) {
    it(`${operation}: cached plans still refuse a different ${wrongKey} binding`, () => {
      const { db, guard, receipt, withReceipt } = setup();
      const where = and(
        eq(schema.sessionUsageInvocations.sessionId, receipt.sessionId),
        eq(schema.sessionUsageInvocations.producerId, receipt.invocation.producerId),
        eq(schema.sessionUsageInvocations.ordinal, receipt.invocation.ordinal),
      );
      const statement =
        operation === 'select'
          ? db.select().from(schema.sessionUsageInvocations).where(where).toSQL()
          : operation === 'update'
            ? db
                .update(schema.sessionUsageInvocations)
                .set({ coverageState: 'incomplete' })
                .where(where)
                .toSQL()
            : db.delete(schema.sessionUsageInvocations).where(where).toSQL();
      withReceipt(() => guard.logQuery(statement.sql, statement.params));
      const params = [...statement.params];
      const offset = operation === 'update' ? 1 : 0;
      const index = offset + (wrongKey === 'session' ? 0 : wrongKey === 'producer' ? 1 : 2);
      params[index] = wrongKey === 'ordinal' ? receipt.invocation.ordinal + 1 : 'different-owner';
      expect(() => withReceipt(() => guard.logQuery(statement.sql, params))).toThrow(
        'USAGE_QUERY_NOT_EXACT_IDENTITY',
      );
      expect(guard.queryPlans + guard.mutationQueryPlans).toBe(1);
      expect(counts(receipt)).toEqual({ n: 1 });
    });
  }
  for (const { kind, suffix } of [
    { kind: 'expanded', suffix: ' or 1 = 1' },
    { kind: 'subquery', suffix: ' and exists (select 1 from "session_usage_invocations")' },
  ]) {
    it(`${operation}: refuses ${kind} predicates`, () => {
      const { guard, receipt, withReceipt } = setup();
      const prefix =
        operation === 'select'
          ? 'select * from "session_usage_invocations" where '
          : operation === 'update'
            ? 'update "session_usage_invocations" set "coverage_state" = ? where '
            : 'delete from "session_usage_invocations" where ';
      const where =
        '"session_usage_invocations"."session_id" = ? and "session_usage_invocations"."producer_id" = ? and "session_usage_invocations"."ordinal" = ?';
      const params = [
        ...(operation === 'update' ? ['incomplete'] : []),
        receipt.sessionId,
        receipt.invocation.producerId,
        receipt.invocation.ordinal,
      ];
      expect(() => withReceipt(() => guard.logQuery(prefix + where + suffix, params))).toThrow(
        'USAGE_QUERY_NOT_EXACT_IDENTITY',
      );
      expect(counts(receipt)).toEqual({ n: 1 });
    });
  }
}
