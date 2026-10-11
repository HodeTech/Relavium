import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import * as schema from './schema.js';
import { createSessionStore } from './session-store.js';
import { createSessionUsageStore } from './session-usage-store.js';
import { visitSessionSummaries, type SessionSummary } from './session-summaries.js';

const at = '2026-10-11T00:00:00.000Z';
function seed(client: DbClient, count: number): void {
  const usage = createSessionUsageStore(client.db);
  for (let i = 0; i < count; i++)
    usage.createFreshSession({
      id: String(i).padStart(4, '0'),
      agentSlug: 'summary',
      context: { workingDir: '/private/context-not-in-discovery', fsScopeTier: 'sandboxed' },
      createdAt: at,
    });
}
function begin(client: DbClient, id: string, model = 'summary-model') {
  return createSessionUsageStore(client.db).beginInvocation({
    sessionId: id,
    model,
    producerId: 'summary-producer',
    dispatchId: 'turn',
    round: 0,
    chainAttempt: 1,
  });
}
function price(client: DbClient, id: string, amount: number, priced = true): void {
  const receipt = begin(client, id, priced ? 'priced' : 'unpriced');
  createSessionStore(client.db).recordSessionCost({
    id: `cost-${id}-${priced}`,
    sessionId: id,
    model: receipt.model,
    inputTokens: 1,
    outputTokens: 2,
    costMicrocents: amount,
    priced,
    ts: 1,
    usageReceipt: receipt,
  });
}
function details(rows: unknown[]): string[] {
  return rows.map((row) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('detail' in row) ||
      typeof row.detail !== 'string'
    )
      throw new Error('invalid native query plan');
    return row.detail;
  });
}

it('exhausts indexed tied-key pages with two queries per page and qualified summary-only accounting', () => {
  const client = createClient();
  try {
    runMigrations(client.db);
    seed(client, 600);
    client.sqlite
      .prepare("UPDATE agent_sessions SET deleted_at=1 WHERE id IN ('0010','0011','0012','0013')")
      .run();
    price(client, '0000', 17);
    price(client, '0000', 0, false);
    begin(client, '0001');
    const incomplete = begin(client, '0002');
    const usage = createSessionUsageStore(client.db);
    usage.disposition(incomplete, {
      kind: 'incomplete',
      evidence: { kind: 'missing', reason: 'not_reported' },
    });
    usage.retire(incomplete);
    // This metadata-only old write must be disclosed, even though amounts are still zero.
    client.sqlite.prepare("UPDATE agent_sessions SET title='old-writer' WHERE id='0003'").run();
    const queries: { sql: string; params: unknown[] }[] = [];
    const observed = drizzle(client.sqlite, {
      schema,
      logger: {
        logQuery(sql, params) {
          queries.push({ sql, params });
        },
      },
    });
    const summaries: SessionSummary[] = [];
    visitSessionSummaries(observed, (summary) => summaries.push(summary));
    expect(summaries.map((row) => row.id)).toEqual(
      Array.from({ length: 600 }, (_, i) => String(599 - i).padStart(4, '0')).filter(
        (id) => !['0010', '0011', '0012', '0013'].includes(id),
      ),
    );
    expect(summaries.find((row) => row.id === '0000')).toMatchObject({
      totalCostMicrocents: 17,
      unpricedCalls: 1,
      usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    });
    expect(summaries.find((row) => row.id === '0001')?.usageCoverage).toEqual({
      unverified: false,
      pendingInvocations: 1,
      unknownCalls: 0,
    });
    expect(summaries.find((row) => row.id === '0002')?.usageCoverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 1,
    });
    expect(summaries.find((row) => row.id === '0003')?.usageCoverage.unverified).toBe(true);
    expect(summaries.find((row) => row.id === '0599')?.usageCoverage).toEqual({
      unverified: false,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
    const reads = queries.filter((query) => /^select\b/.test(query.sql));
    expect(reads).toHaveLength(6);
    const owners = reads.filter((query) => query.sql.includes('from "agent_sessions"'));
    expect(owners).toHaveLength(3);
    expect(reads.filter((query) => query.sql.includes('sum('))).toHaveLength(3);
    for (const query of reads)
      expect(query.sql).not.toMatch(/context_json|agent_snapshot|session_messages|"model"/);
    for (const [index, query] of owners.entries()) {
      expect(query.params.at(-1)).toBe(256);
      const plan = details(
        client.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params),
      );
      expect(plan.join('\n')).toContain('idx_agent_sessions_updated');
      expect(plan.join('\n')).not.toMatch(/TEMP B-TREE/);
      if (index > 0) expect(plan.join('\n')).toMatch(/SEARCH.*idx_agent_sessions_updated/);
    }
    expect(JSON.stringify(summaries)).not.toContain('context-not-in-discovery');
  } finally {
    client.sqlite.close();
  }
});

// Keep all 600 independently acknowledged session writes; this is not a disk-throughput contract.
it('keeps every page, known sum and coverage in one WAL snapshot while another connection writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relavium-summary-snapshot-'));
  const reader = createClient(join(dir, 'history.db'));
  let writer: DbClient | undefined;
  try {
    runMigrations(reader.db);
    seed(reader, 600);
    writer = createClient(reader.path);
    const on = writer;
    const summaries: SessionSummary[] = [];
    visitSessionSummaries(reader.db, (summary) => {
      summaries.push(summary);
      if (summaries.length !== 1) return;
      const store = createSessionStore(on.db);
      const tail = store.loadSession('0000');
      if (tail === undefined) throw new Error('missing tail owner');
      price(on, '0000', 29);
      store.updateSession({
        ...tail,
        title: 'concurrent-title',
        updatedAt: '2026-10-11T01:00:00.000Z',
      });
      createSessionUsageStore(on.db).createFreshSession({
        id: 'concurrent-new',
        agentSlug: 'summary',
        context: { workingDir: '/tmp', fsScopeTier: 'sandboxed' },
        createdAt: at,
      });
    });
    expect(summaries).toHaveLength(600);
    expect(new Set(summaries.map((row) => row.id)).size).toBe(600);
    expect(summaries.at(-1)).toEqual({
      id: '0000',
      agentSlug: 'summary',
      status: 'active',
      createdAt: at,
      updatedAt: at,
      totalCostMicrocents: 0,
      unpricedCalls: 0,
      usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    });
    const after: SessionSummary[] = [];
    visitSessionSummaries(reader.db, (summary) => after.push(summary));
    expect(after).toHaveLength(601);
    expect(after[0]).toMatchObject({
      id: '0000',
      title: 'concurrent-title',
      totalCostMicrocents: 29,
      usageCoverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 },
    });
    expect(after.find((row) => row.id === 'concurrent-new')).toBeDefined();
  } finally {
    writer?.sqlite.close();
    reader.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it('releases the read transaction and preserves a visitor failure exactly', () => {
  const client = createClient();
  try {
    runMigrations(client.db);
    seed(client, 1);
    const marker = new Error('summary visitor failed');
    expect(() =>
      visitSessionSummaries(client.db, () => {
        throw marker;
      }),
    ).toThrow(marker);
    expect(client.sqlite.inTransaction).toBe(false);
    price(client, '0000', 7);
    expect(createSessionStore(client.db).loadSessionCostBreakdown('0000').totalCostMicrocents).toBe(
      7,
    );
  } finally {
    client.sqlite.close();
  }
});
