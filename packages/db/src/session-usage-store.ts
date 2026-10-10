import {
  UsageCoverageSchema,
  UsageModelSchema,
  type AgentSessionRecord,
  type UsageCoverage,
} from '@relavium/shared';
import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { agentSessions, sessionUsageCoverage } from './schema.js';
import { toAgentSessionRow } from './session-store.js';
import {
  SessionUsageError,
  validateUsageRevision,
  withSessionUsageWrite,
} from './session-usage-write.js';

/** Historical totals, lifecycle state and arbitrary coverage are deliberately not accepted. */
export type FreshSessionSeed = Pick<
  AgentSessionRecord,
  'id' | 'agentId' | 'agentSlug' | 'agentSnapshot' | 'title' | 'modelId' | 'context' | 'createdAt'
>;

export interface SessionUsageSnapshot {
  readonly coverage: UsageCoverage;
  /**
   * Rows present in session_usage_coverage. A future reader joining historical money-only models
   * must supply zero known pending/unknown counts and inherit aggregate coverage.unverified.
   */
  readonly models: readonly { readonly model: string; readonly coverage: UsageCoverage }[];
}

export interface SessionUsageStore {
  /**
   * Explicit NEW-owner privilege. Not called by shipping hosts in Step 4. It must never replace
   * resume/reseat/import or generic createSession. Throws SessionUsageError on existing ids,
   * historical fields, or nested transactions; ordinary persistence validation/faults propagate.
   */
  readonly createFreshSession: (seed: FreshSessionSeed) => void;
  /** Read-only, one SQLite snapshot, never an acknowledgement or receipt capability. */
  readonly loadCoverage: (sessionId: string) => SessionUsageSnapshot | undefined;
}

const FRESH_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'agentId',
  'agentSlug',
  'agentSnapshot',
  'title',
  'modelId',
  'context',
  'createdAt',
]);

/** ADR-0104 inert foundations. Invocation production/settlement is deliberately not exposed yet. */
export function createSessionUsageStore(db: Db): SessionUsageStore {
  return {
    createFreshSession: (seed) => {
      if (Object.keys(seed).some((key) => !FRESH_FIELDS.has(key)))
        throw new SessionUsageError('not_fresh');
      const row = toAgentSessionRow({
        ...seed,
        status: 'active',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        updatedAt: seed.createdAt,
      });
      withSessionUsageWrite(db, [row.id], (tx) => {
        // Physical existence includes tombstones: loadSession deliberately hides those rows.
        if (
          tx
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(eq(agentSessions.id, row.id))
            .get() !== undefined
        ) {
          throw new SessionUsageError('not_fresh');
        }
        tx.insert(agentSessions).values(row).run();
        // The ONLY clearing write: this transaction just inserted a genuinely new, empty owner.
        tx.update(agentSessions)
          .set({ usageUnverified: false })
          .where(eq(agentSessions.id, row.id))
          .run();
      });
    },
    loadCoverage: (sessionId) =>
      db.transaction((tx) => {
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
        const models = tx
          .select()
          .from(sessionUsageCoverage)
          .where(eq(sessionUsageCoverage.sessionId, sessionId))
          .orderBy(asc(sessionUsageCoverage.model))
          .all()
          .map((row) => ({
            model: UsageModelSchema.parse(row.model),
            coverage: UsageCoverageSchema.parse({
              unverified,
              pendingInvocations: row.pendingInvocations,
              unknownCalls: row.unknownCalls,
            }),
          }));
        return { coverage, models };
      }),
  };
}
