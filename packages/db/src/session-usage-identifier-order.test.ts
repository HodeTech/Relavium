import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations, type Db } from './client.js';
import {
  agentSessions,
  sessionCosts,
  sessionUsageCoverage,
  sessionUsageInvocations,
} from './schema.js';
import {
  createSessionStore,
  LEGACY_COST_SENTINEL,
  type SessionCostEntry,
} from './session-store.js';
import type { SessionUsageReceipt } from './session-usage-receipt.js';
import { createSessionUsageStore } from './session-usage-store.js';

const SESSION_ID = 'identifier-order';
const timestamp = '2026-10-16T00:00:00.000Z';

function fresh(db: Db) {
  const usage = createSessionUsageStore(db);
  usage.createFreshSession({
    id: SESSION_ID,
    agentSlug: 'chatter',
    context: { workingDir: '/work', fsScopeTier: 'sandboxed' },
    createdAt: timestamp,
  });
  return { usage, costs: createSessionStore(db) };
}

function physicalSnapshot(db: Db) {
  return {
    owner: db.select().from(agentSessions).where(eq(agentSessions.id, SESSION_ID)).get(),
    money: db
      .select()
      .from(sessionCosts)
      .where(eq(sessionCosts.sessionId, SESSION_ID))
      .orderBy(sessionCosts.id)
      .all(),
    coverage: db
      .select()
      .from(sessionUsageCoverage)
      .where(eq(sessionUsageCoverage.sessionId, SESSION_ID))
      .orderBy(sessionUsageCoverage.model)
      .all(),
    invocations: db
      .select()
      .from(sessionUsageInvocations)
      .where(eq(sessionUsageInvocations.sessionId, SESSION_ID))
      .orderBy(sessionUsageInvocations.ordinal)
      .all(),
  };
}

function priced(
  receipt: SessionUsageReceipt,
  inputTokens: number,
  outputTokens: number,
  costMicrocents: number,
): SessionCostEntry {
  return {
    id: `actual-${receipt.model}`,
    sessionId: receipt.sessionId,
    model: receipt.model,
    inputTokens,
    outputTokens,
    costMicrocents,
    priced: true,
    ts: 1,
    usageReceipt: receipt,
  };
}

describe('W3S5 #259 public session usage model identifier ordering', () => {
  it.each([false, true])(
    'DB_MODEL_ORDER preserves real receipts, coverage and money with ambient comparator poisoned=%s',
    (poisoned) => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const { usage, costs } = fresh(client.db);
        const begin = (model: string) =>
          usage.beginInvocation({
            sessionId: SESSION_ID,
            model,
            producerId: `producer-${model}`,
            dispatchId: `dispatch-${model}`,
            round: 0,
            chainAttempt: 1,
          });
        // Deliberately scrambled allocation, all through real receipt authority.
        const underscore = begin('a_b');
        const hyphen = begin('a-b');
        const incomplete = begin('a');
        const pending = begin('Z');
        expect(
          usage.disposition(incomplete, {
            kind: 'incomplete',
            evidence: { kind: 'missing', reason: 'not_reported' },
          }),
        ).toBe(true);
        expect(costs.recordSessionCost(priced(hyphen, 11, 13, 7))).toBe(true);
        expect(costs.recordSessionCost(priced(underscore, 2, 3, 5))).toBe(true);
        const before = physicalSnapshot(client.db);
        expect(before.owner).toMatchObject({
          usageInvocationHighWater: 4,
          usageUnverified: false,
          usagePendingInvocations: 1,
          usageUnknownCalls: 1,
          totalCostMicrocents: 12,
          totalConservativeMicrocents: 0,
        });
        expect(before.owner?.usageAckRevision).toBe(before.owner?.usageMutationRevision);
        expect(before.invocations).toMatchObject([
          {
            model: 'a',
            coverageState: 'incomplete',
            producerId: 'producer-a',
            dispatchId: 'dispatch-a',
            ordinal: 3,
          },
          {
            model: 'Z',
            coverageState: 'pending',
            producerId: 'producer-Z',
            dispatchId: 'dispatch-Z',
            ordinal: 4,
          },
        ]);
        const receiptFields = [underscore, hyphen, incomplete, pending].map((receipt) => ({
          sessionId: receipt.sessionId,
          model: receipt.model,
          invocation: { ...receipt.invocation },
        }));
        const readPair = () => ({
          coverage: usage.loadCoverage(SESSION_ID),
          breakdown: costs.loadSessionCostBreakdown(SESSION_ID),
        });
        const transaction = vi.spyOn(client.db, 'transaction');
        const ambient = poisoned
          ? vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => {
              throw new Error('DB_AMBIENT_COLLATION_FORBIDDEN');
            })
          : undefined;
        let reads: ReturnType<typeof readPair>[];
        try {
          reads = [readPair(), readPair()];
        } finally {
          ambient?.mockRestore();
        }
        expect(transaction, 'DB_PUBLIC_SINGLE_SNAPSHOTS').toHaveBeenCalledTimes(4);
        if (ambient !== undefined)
          expect(ambient, 'DB_NO_AMBIENT_COMPARATOR').not.toHaveBeenCalled();
        const expectedModels = [
          { model: 'Z', coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 0 } },
          { model: 'a', coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 } },
          { model: 'a-b', coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 } },
          { model: 'a_b', coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 } },
        ];
        const expectedCoverage = { unverified: false, pendingInvocations: 1, unknownCalls: 1 };
        for (const read of reads) {
          expect(
            read.coverage?.models.map(({ model }) => model),
            'DB_MODEL_ORDER_COVERAGE',
          ).toEqual(['Z', 'a', 'a-b', 'a_b']);
          expect(
            read.breakdown.models.map(({ model }) => model),
            'DB_MODEL_ORDER_BREAKDOWN',
          ).toEqual(['Z', 'a', 'a-b', 'a_b']);
          expect(read.coverage).toEqual({ coverage: expectedCoverage, models: expectedModels });
          expect(read.breakdown).toEqual({
            totalCostMicrocents: 12,
            coverage: expectedCoverage,
            models: expectedModels,
            rows: [
              {
                model: 'a-b',
                modelCatalogId: undefined,
                inputTokens: 11,
                outputTokens: 13,
                costMicrocents: 7,
                conservativeMicrocents: 0,
                callCount: 1,
                unpricedCalls: 0,
                isLegacy: false,
              },
              {
                model: 'a_b',
                modelCatalogId: undefined,
                inputTokens: 2,
                outputTokens: 3,
                costMicrocents: 5,
                conservativeMicrocents: 0,
                callCount: 1,
                unpricedCalls: 0,
                isLegacy: false,
              },
            ],
          });
        }
        expect(physicalSnapshot(client.db), 'DB_READS_DO_NOT_MUTATE').toEqual(before);
        expect([underscore, hyphen, incomplete, pending]).toEqual(receiptFields);
        for (const receipt of [underscore, hyphen, incomplete, pending]) {
          expect(Object.isFrozen(receipt)).toBe(true);
          expect(Object.isFrozen(receipt.invocation)).toBe(true);
        }
        // Reads neither retire a live capability nor revive a consumed one.
        expect(
          costs.recordSessionCost(priced(hyphen, 11, 13, 7)),
          'DB_COMPLETED_RECEIPT_STAYS_CONSUMED',
        ).toBe(false);
        expect(
          costs.recordSessionCost(priced(incomplete, 17, 19, 23)),
          'DB_INCOMPLETE_RECEIPT_STAYS_LIVE',
        ).toBe(true);
        expect(
          usage.disposition(pending, { kind: 'not_invoked', reason: 'cancelled' }),
          'DB_PENDING_RECEIPT_STAYS_LIVE',
        ).toBe(true);
      } finally {
        vi.restoreAllMocks();
        client.sqlite.close();
      }
    },
  );

  it('DB_MONEY_MODEL_UNION keeps historical long names raw and excludes only the legacy aggregate identity', () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      const { usage, costs } = fresh(client.db);
      const longModel = `custom-${'m'.repeat(4090)}`; // 4097 units: valid historical money, beyond new invocation bound.
      const pending = usage.beginInvocation({
        sessionId: SESSION_ID,
        model: 'Z',
        producerId: 'producer',
        dispatchId: 'dispatch',
        round: 0,
        chainAttempt: 1,
      });
      expect(pending.model).toBe('Z');
      for (const [id, model, charge] of [
        ['long-money', longModel, 17],
        ['money-only', 'a_b', 11],
        ['sentinel-real', LEGACY_COST_SENTINEL, 5],
      ] as const) {
        expect(
          costs.recordSessionCost({
            id,
            sessionId: SESSION_ID,
            model,
            inputTokens: 2,
            outputTokens: 3,
            costMicrocents: charge,
            priced: true,
            ts: 1,
          }),
        ).toBe(true);
      }
      // Historical aggregate fixture, using the existing table's flag rather than
      // reserving a string that a real provider model is allowed to use.
      client.db
        .insert(sessionCosts)
        .values({
          id: 'legacy-aggregate',
          sessionId: SESSION_ID,
          model: LEGACY_COST_SENTINEL,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 31,
          callCount: 0,
          unpricedCalls: 0,
          isLegacy: true,
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
      client.db
        .update(agentSessions)
        .set({ totalCostMicrocents: 64 })
        .where(eq(agentSessions.id, SESSION_ID))
        .run();
      const before = physicalSnapshot(client.db);
      const expectedCoverage = { unverified: true, pendingInvocations: 1, unknownCalls: 0 };
      const cleanCoverage = { unverified: true, pendingInvocations: 0, unknownCalls: 0 };
      const expectedModels = [
        { model: LEGACY_COST_SENTINEL, coverage: cleanCoverage },
        { model: 'Z', coverage: expectedCoverage },
        { model: 'a_b', coverage: cleanCoverage },
        { model: longModel, coverage: cleanCoverage },
      ];
      const expectedRows = [
        {
          model: LEGACY_COST_SENTINEL,
          modelCatalogId: undefined,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 31,
          conservativeMicrocents: 0,
          callCount: 0,
          unpricedCalls: 0,
          isLegacy: true,
        },
        {
          model: longModel,
          modelCatalogId: undefined,
          inputTokens: 2,
          outputTokens: 3,
          costMicrocents: 17,
          conservativeMicrocents: 0,
          callCount: 1,
          unpricedCalls: 0,
          isLegacy: false,
        },
        {
          model: 'a_b',
          modelCatalogId: undefined,
          inputTokens: 2,
          outputTokens: 3,
          costMicrocents: 11,
          conservativeMicrocents: 0,
          callCount: 1,
          unpricedCalls: 0,
          isLegacy: false,
        },
        {
          model: LEGACY_COST_SENTINEL,
          modelCatalogId: undefined,
          inputTokens: 2,
          outputTokens: 3,
          costMicrocents: 5,
          conservativeMicrocents: 0,
          callCount: 1,
          unpricedCalls: 0,
          isLegacy: false,
        },
      ];
      for (let read = 0; read < 2; read++) {
        const coverage = usage.loadCoverage(SESSION_ID);
        const breakdown = costs.loadSessionCostBreakdown(SESSION_ID);
        expect(
          coverage?.models.map(({ model }) => model),
          'DB_HISTORICAL_UNION_ORDER',
        ).toEqual([LEGACY_COST_SENTINEL, 'Z', 'a_b', longModel]);
        expect(coverage).toEqual({ coverage: expectedCoverage, models: expectedModels });
        expect(breakdown).toEqual({
          totalCostMicrocents: 64,
          rows: expectedRows,
          coverage: expectedCoverage,
          models: expectedModels,
        });
        expect(
          breakdown.rows.find((row) => row.model === longModel)?.model.length,
          'DB_HISTORICAL_MODEL_NOT_TRUNCATED',
        ).toBe(4097);
      }
      expect(physicalSnapshot(client.db), 'DB_HISTORICAL_READS_DO_NOT_MUTATE').toEqual(before);
      expect(before.owner?.usageMutationRevision).toBeGreaterThan(
        before.owner?.usageAckRevision ?? 0,
      );
      expect(before.owner?.usageUnverified).toBe(true);
    } finally {
      client.sqlite.close();
    }
  });

  it('DB_LEGACY_ONLY does not invent a model identity for an unattributed aggregate', () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      const { usage, costs } = fresh(client.db);
      client.db
        .insert(sessionCosts)
        .values({
          id: 'legacy-only',
          sessionId: SESSION_ID,
          model: LEGACY_COST_SENTINEL,
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 31,
          callCount: 0,
          unpricedCalls: 0,
          isLegacy: true,
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
      client.db
        .update(agentSessions)
        .set({ totalCostMicrocents: 31 })
        .where(eq(agentSessions.id, SESSION_ID))
        .run();
      const before = physicalSnapshot(client.db);
      const expectedCoverage = { unverified: true, pendingInvocations: 0, unknownCalls: 0 };
      for (let read = 0; read < 2; read++) {
        expect(usage.loadCoverage(SESSION_ID), 'DB_LEGACY_ONLY_COVERAGE').toEqual({
          coverage: expectedCoverage,
          models: [],
        });
        expect(costs.loadSessionCostBreakdown(SESSION_ID), 'DB_LEGACY_ONLY_BREAKDOWN').toEqual({
          totalCostMicrocents: 31,
          coverage: expectedCoverage,
          models: [],
          rows: [
            {
              model: LEGACY_COST_SENTINEL,
              modelCatalogId: undefined,
              inputTokens: 0,
              outputTokens: 0,
              costMicrocents: 31,
              conservativeMicrocents: 0,
              callCount: 0,
              unpricedCalls: 0,
              isLegacy: true,
            },
          ],
        });
      }
      expect(physicalSnapshot(client.db), 'DB_LEGACY_ONLY_READS_DO_NOT_MUTATE').toEqual(before);
    } finally {
      client.sqlite.close();
    }
  });
});
