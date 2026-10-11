import {
  AgentSessionSchema,
  UsageCoverageSchema,
  type UsageCoverage,
  type AgentSessionRecord,
} from '@relavium/shared';
import { and, desc, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { agentSessions, sessionCosts } from './schema.js';
import { validateUsageRevision } from './session-usage-write.js';
import { epochMsToIso } from './time.js';

const summaryFields = {
  id: true,
  agentSlug: true,
  title: true,
  status: true,
  modelId: true,
  createdAt: true,
  updatedAt: true,
  totalCostMicrocents: true,
} as const;
const SummaryIdentitySchema = AgentSessionSchema.pick(summaryFields);

type SummaryIdentity = Pick<AgentSessionRecord, keyof typeof summaryFields>;

/** Discovery/accounting only: no transcript, context or per-model attribution is loaded. */
export type SessionSummary = SummaryIdentity & {
  readonly usageCoverage: UsageCoverage;
  readonly unpricedCalls: number;
};

/**
 * Exhaust all live owners in indexed 256-row keyset pages under ONE read snapshot. The visitor is
 * synchronous; rows are not accumulated by the store. Page size bounds working memory, not results.
 */
export function visitSessionSummaries(db: Db, visit: (summary: SessionSummary) => void): void {
  db.transaction((tx) => {
    let cursor: { readonly updatedAt: number; readonly id: string } | undefined;
    for (;;) {
      const rows = tx
        .select({
          id: agentSessions.id,
          agentSlug: agentSessions.agentSlug,
          title: agentSessions.title,
          status: agentSessions.status,
          modelId: agentSessions.modelId,
          createdAt: agentSessions.createdAt,
          updatedAt: agentSessions.updatedAt,
          totalCostMicrocents: agentSessions.totalCostMicrocents,
          revision: agentSessions.usageMutationRevision,
          acknowledged: agentSessions.usageAckRevision,
          unverified: agentSessions.usageUnverified,
          pendingInvocations: agentSessions.usagePendingInvocations,
          unknownCalls: agentSessions.usageUnknownCalls,
        })
        .from(agentSessions)
        .where(
          and(
            isNull(agentSessions.deletedAt),
            cursor === undefined
              ? undefined
              : sql`(${agentSessions.updatedAt}, ${agentSessions.id}) < (${cursor.updatedAt}, ${cursor.id})`,
          ),
        )
        .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id))
        .limit(256)
        .all();
      if (rows.length === 0) return;
      const unpriced = new Map(
        tx
          .select({
            sessionId: sessionCosts.sessionId,
            count: sql<number>`sum(${sessionCosts.unpricedCalls})`,
          })
          .from(sessionCosts)
          .where(
            inArray(
              sessionCosts.sessionId,
              rows.map((row) => row.id),
            ),
          )
          .groupBy(sessionCosts.sessionId)
          .all()
          .map<[string, number]>((row) => [row.sessionId, row.count]),
      );
      for (const row of rows) {
        validateUsageRevision(row.revision, row.acknowledged);
        const identity = SummaryIdentitySchema.parse({
          id: row.id,
          agentSlug: row.agentSlug,
          ...(row.title === null ? {} : { title: row.title }),
          status: row.status,
          ...(row.modelId === null ? {} : { modelId: row.modelId }),
          createdAt: epochMsToIso(row.createdAt),
          updatedAt: epochMsToIso(row.updatedAt),
          totalCostMicrocents: row.totalCostMicrocents,
        });
        visit({
          ...identity,
          usageCoverage: UsageCoverageSchema.parse({
            unverified: row.unverified || row.revision !== row.acknowledged,
            pendingInvocations: row.pendingInvocations,
            unknownCalls: row.unknownCalls,
          }),
          unpricedCalls: UsageCoverageSchema.shape.unknownCalls.parse(unpriced.get(row.id) ?? 0),
        });
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < 256) return;
      cursor = { updatedAt: last.updatedAt, id: last.id };
    }
  });
}
