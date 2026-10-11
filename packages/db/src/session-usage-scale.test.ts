import type { UsageDisposition } from '@relavium/shared';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient, type Db } from './client.js';
import { createSessionStore, type SessionCostEntry } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';
import { type SessionUsageReceipt } from './session-usage-receipt.js';
import * as schema from './schema.js';
import { SessionUsageQueryGuard } from './fixtures/session-usage-query-guard.js';

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

describe('ADR-0104 bounded native session settlement state', () => {
  it('retains only unresolved identities after 100000 settlements with 64 concurrent pending controls', async () => {
    let admissions = 0;
    let retirements = 0;
    let inspectLiveQueries = true;
    const queryGuard = new SessionUsageQueryGuard(client.sqlite);
    const observed = drizzle(client.sqlite, {
      schema,
      logger: {
        logQuery(query, params) {
          queryGuard.logQuery(query, params);
          if (inspectLiveQueries) {
            if (/insert into "session_usage_invocations"/i.test(query)) admissions += 1;
            if (/delete from "session_usage_invocations"/i.test(query)) retirements += 1;
            if (
              /select.*from "(?:session_usage_invocations|run_events)"/i.test(query) &&
              !/where/i.test(query)
            )
              throw new Error('live settlement attempted a full history scan');
          }
        },
      },
    });
    const { usage, costs, begin, entry } = setup(observed);
    const pending = Array.from({ length: 64 }, () => begin('held'));
    const duplicate = begin('paid');
    expect(queryGuard.forReceipt(duplicate, () => costs.recordSessionCost(entry(duplicate)))).toBe(
      true,
    );
    for (let index = 1; index < 100_000; index += 1) {
      const receipt = begin(index % 2 === 0 ? 'paid' : 'unknown');
      if (index % 2 === 0)
        queryGuard.forReceipt(receipt, () => costs.recordSessionCost(entry(receipt)));
      else {
        queryGuard.forReceipt(receipt, () => usage.disposition(receipt, missing));
        queryGuard.forReceipt(receipt, () => usage.retire(receipt));
      }
      // Keep Vitest's worker RPC responsive on contended CI machines. Every production
      // transaction and all 100000 settlements still execute; no elapsed-time assertion is used.
      if (index % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    inspectLiveQueries = false;
    expect(admissions).toBe(100_064);
    expect(retirements).toBe(100_000);
    expect(
      client.sqlite.prepare('SELECT count(*) AS n FROM session_usage_invocations').get(),
    ).toEqual({ n: 64 });
    expect(client.sqlite.prepare('SELECT count(*) AS n FROM session_usage_coverage').get()).toEqual(
      { n: 3 },
    );
    expect(
      client.sqlite.prepare('SELECT usage_invocation_high_water AS n FROM agent_sessions').get(),
    ).toEqual({ n: 100_064 });
    expect(usage.loadCoverage('s')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 64,
      unknownCalls: 50_000,
    });
    const retiredLookups = queryGuard.receiptLookups;
    expect(queryGuard.forReceipt(duplicate, () => costs.recordSessionCost(entry(duplicate)))).toBe(
      false,
    );
    expect(queryGuard.receiptLookups).toBe(retiredLookups);
    const live = pending[0];
    if (live === undefined) throw new Error('missing control');
    queryGuard.forReceipt(live, () => usage.disposition(live, missing));
    expect(queryGuard.forReceipt(live, () => costs.recordSessionCost(entry(live)))).toBe(true);
    expect(queryGuard.queryPlans).toBe(1);
    expect(queryGuard.receiptLookups).toBe(150_002);
    expect(client.sqlite.prepare('SELECT sum(call_count) AS n FROM session_costs').get()).toEqual({
      n: 50_001,
    });
    expect(usage.loadCoverage('s')?.coverage).toEqual({
      unverified: false,
      pendingInvocations: 63,
      unknownCalls: 50_000,
    });
    // This is a state/query-bound control, not a throughput benchmark: all 100000 settlements
    // execute roughly two million ORM/native statements in independently committed transactions.
    // The unchanged control took 163.5s in ordinary Linux CI; coverage and the Node-22 floor
    // exhausted the former 180s watchdog. Allow contended/instrumented workers to finish without
    // reducing the workload, batching away durable ACKs or relaxing any state/query assertion.
  }, 600_000);
});
