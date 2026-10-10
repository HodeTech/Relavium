import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  createSessionStore,
  createSessionUsageStore,
  LEGACY_COST_SENTINEL,
  runMigrations,
} from '@relavium/db';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { costNotice } from './repl-info.js';

const migrations = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

/** Upgrade a real pre-attribution session through shipped migrations, including the legacy backfill. */
function legacySession() {
  const staged = mkdtempSync(join(tmpdir(), 'relavium-cost-history-'));
  const client = createClient();
  try {
    const journal = z
      .object({ entries: z.array(z.object({ idx: z.number(), tag: z.string() }).passthrough()) })
      .passthrough()
      .parse(JSON.parse(readFileSync(join(migrations, 'meta/_journal.json'), 'utf8')));
    const entries = journal.entries.filter((entry) => entry.idx <= 8);
    expect(entries).toHaveLength(9);
    mkdirSync(join(staged, 'meta'));
    for (const entry of entries)
      copyFileSync(join(migrations, `${entry.tag}.sql`), join(staged, `${entry.tag}.sql`));
    writeFileSync(join(staged, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    migrate(client.db, { migrationsFolder: staged });
    client.sqlite
      .prepare(
        'INSERT INTO agent_sessions (id, agent_slug, total_cost_microcents, created_at, updated_at) VALUES (?, ?, ?, 0, 0)',
      )
      .run('legacy', 'a', 100_000_000);
    runMigrations(client.db);
    return client;
  } catch (error) {
    client.sqlite.close();
    throw error;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

it('a migrated legacy aggregate stays unavailable without inventing a zero-cost model', () => {
  const client = legacySession();
  try {
    const breakdown = createSessionStore(client.db).loadSessionCostBreakdown('legacy');
    expect(breakdown.totalCostMicrocents).toBe(100_000_000);
    expect(breakdown.rows).toMatchObject([
      { isLegacy: true, model: LEGACY_COST_SENTINEL, costMicrocents: 100_000_000 },
    ]);
    expect(breakdown.models).toEqual([]);
    expect(createSessionUsageStore(client.db).loadCoverage('legacy')?.models).toEqual([]);
    const notice = costNotice(breakdown.totalCostMicrocents, breakdown.rows, breakdown);
    expect(notice).toContain('before per-model attribution — breakdown unavailable');
    expect(notice).toContain('Session cost: $1.0000 known; usage unverified');
    expect(notice).not.toContain(LEGACY_COST_SENTINEL);
    expect(notice).not.toContain('$0.0000');
  } finally {
    client.sqlite.close();
  }
});

it('an attributable historical money row remains a model without a coverage row', () => {
  const client = legacySession();
  try {
    const costs = createSessionStore(client.db);
    expect(
      costs.recordSessionCost({
        id: 'historical-real-cost',
        sessionId: 'legacy',
        model: LEGACY_COST_SENTINEL,
        inputTokens: 2,
        outputTokens: 3,
        costMicrocents: 200_000_000,
        priced: true,
        ts: 1,
      }),
    ).toBe(true);
    const breakdown = costs.loadSessionCostBreakdown('legacy');
    expect(breakdown.models).toEqual([
      {
        model: LEGACY_COST_SENTINEL,
        coverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 },
      },
    ]);
    const notice = costNotice(breakdown.totalCostMicrocents, breakdown.rows, breakdown);
    expect(notice).toContain('(1 call, 5 tok)');
    expect(notice).toContain('breakdown unavailable');
    expect(notice).not.toContain('$0.0000');
    expect(breakdown.totalCostMicrocents).toBe(300_000_000);
  } finally {
    client.sqlite.close();
  }
});

it.each(['complete', 'unknown'] as const)(
  'a real model named like the legacy sentinel remains attributable: %s',
  (kind) => {
    const client = legacySession();
    try {
      const usage = createSessionUsageStore(client.db);
      const costs = createSessionStore(client.db);
      const receipt = usage.beginInvocation({
        sessionId: 'legacy',
        model: LEGACY_COST_SENTINEL,
        producerId: 'new-writer',
        dispatchId: 'turn',
        round: 0,
        chainAttempt: 1,
      });
      if (kind === 'complete') {
        expect(
          costs.recordSessionCost({
            id: 'real-cost',
            sessionId: 'legacy',
            model: LEGACY_COST_SENTINEL,
            inputTokens: 2,
            outputTokens: 3,
            costMicrocents: 200_000_000,
            priced: true,
            ts: 1,
            usageReceipt: receipt,
          }),
        ).toBe(true);
      } else {
        expect(
          usage.disposition(receipt, {
            kind: 'incomplete',
            evidence: { kind: 'missing', reason: 'not_reported' },
          }),
        ).toBe(true);
        usage.retire(receipt);
      }
      const breakdown = costs.loadSessionCostBreakdown('legacy');
      expect(breakdown.models).toEqual([
        {
          model: LEGACY_COST_SENTINEL,
          coverage: {
            unverified: true,
            pendingInvocations: 0,
            unknownCalls: kind === 'unknown' ? 1 : 0,
          },
        },
      ]);
      expect(breakdown.rows.filter((row) => row.isLegacy)).toMatchObject([
        { costMicrocents: 100_000_000, callCount: 0 },
      ]);
      const notice = costNotice(breakdown.totalCostMicrocents, breakdown.rows, breakdown);
      expect(notice.match(/breakdown unavailable/g)).toHaveLength(1);
      expect(notice.match(/\(pre-2\.6\.C\)/g)).toHaveLength(1);
      if (kind === 'complete') {
        expect(notice).toContain('(1 call, 5 tok)');
        expect(notice).not.toContain('$0.0000');
        expect(breakdown.totalCostMicrocents).toBe(300_000_000);
      } else {
        expect(notice).toContain('usage unknown for 1 call');
        expect(notice).not.toContain('(0 calls');
        expect(breakdown.totalCostMicrocents).toBe(100_000_000);
      }
    } finally {
      client.sqlite.close();
    }
  },
);
