import { UsageCoverageSchema, UsageModelSchema, type UsageCoverage } from '@relavium/shared';
import { and, asc, eq } from 'drizzle-orm';

import type { TxDb } from './client.js';
import { agentSessions, sessionCosts, sessionUsageCoverage } from './schema.js';
import { validateUsageRevision } from './session-usage-write.js';

export interface SessionUsageSnapshot {
  readonly coverage: UsageCoverage;
  /** Union of attributable money and coverage models; legacy aggregates are not model identities. */
  readonly models: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
}

/** Caller supplies one read snapshot; reads never acquire receipt or acknowledge mutation authority. */
export function readSessionCoverage(tx: TxDb, sessionId: string): SessionUsageSnapshot | undefined {
  const owner = tx
    .select({
      revision: agentSessions.usageMutationRevision,
      acknowledged: agentSessions.usageAckRevision,
      unverified: agentSessions.usageUnverified,
      pendingInvocations: agentSessions.usagePendingInvocations,
      unknownCalls: agentSessions.usageUnknownCalls,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .get();
  if (owner === undefined) return undefined;
  validateUsageRevision(owner.revision, owner.acknowledged);
  const unverified = owner.unverified || owner.revision !== owner.acknowledged;
  const coverage = UsageCoverageSchema.parse({
    unverified,
    pendingInvocations: owner.pendingInvocations,
    unknownCalls: owner.unknownCalls,
  });
  const models = new Map<string, UsageCoverage>();
  for (const row of tx
    .select({ model: sessionCosts.model })
    .from(sessionCosts)
    .where(and(eq(sessionCosts.sessionId, sessionId), eq(sessionCosts.isLegacy, false)))
    .all()) {
    // Historical money uses the existing raw attribution key, as loadSessionCosts does. The new
    // invocation bound must not retroactively reject or truncate valid pre-coverage model names.
    models.set(row.model, {
      unverified,
      pendingInvocations: 0,
      unknownCalls: 0,
    });
  }
  for (const row of tx
    .select()
    .from(sessionUsageCoverage)
    .where(eq(sessionUsageCoverage.sessionId, sessionId))
    .orderBy(asc(sessionUsageCoverage.model))
    .all()) {
    models.set(
      UsageModelSchema.parse(row.model),
      UsageCoverageSchema.parse({
        unverified,
        pendingInvocations: row.pendingInvocations,
        unknownCalls: row.unknownCalls,
      }),
    );
  }
  return {
    coverage,
    models: [...models]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, modelCoverage]) => ({ model, coverage: modelCoverage })),
  };
}
