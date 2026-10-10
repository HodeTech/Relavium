import { type AgentSessionRecord, type UsageDisposition } from '@relavium/shared';
import { eq } from 'drizzle-orm';

import type { Db } from './client.js';
import { agentSessions } from './schema.js';
import { toAgentSessionRow } from './session-store.js';
import { SessionUsageError, withSessionUsageWrite } from './session-usage-write.js';

import {
  beginSessionUsageInvocation,
  createFreshOneShotUsageOwner,
  type SessionUsageOwner,
  disposeSessionUsageInvocation,
  retireSessionUsageInvocation,
  type SessionUsageInvocationInput,
  type SessionUsageReceipt,
} from './session-usage-receipt.js';

/** Historical totals, lifecycle state and arbitrary coverage are deliberately not accepted. */
export type FreshSessionSeed = Pick<
  AgentSessionRecord,
  'id' | 'agentId' | 'agentSlug' | 'agentSnapshot' | 'title' | 'modelId' | 'context' | 'createdAt'
>;

export type { SessionUsageSnapshot } from './session-usage-read.js';
import { readSessionCoverage, type SessionUsageSnapshot } from './session-usage-read.js';

export interface SessionUsageStore {
  readonly createFreshOneShotOwner: (input: {
    readonly sessionId: string;
    readonly now: number;
  }) => SessionUsageOwner;
  readonly beginInvocation: (
    input: SessionUsageInvocationInput,
    owner?: SessionUsageOwner,
  ) => SessionUsageReceipt;
  readonly disposition: (receipt: SessionUsageReceipt, disposition: UsageDisposition) => boolean;
  readonly retire: (receipt: SessionUsageReceipt) => void;
  /**
   * Explicit NEW-owner privilege. It must never replace
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

/** ADR-0104 session usage authority, independent from admission estimates and actual-money arithmetic. */
export function createSessionUsageStore(db: Db): SessionUsageStore {
  return {
    createFreshOneShotOwner: (input) => createFreshOneShotUsageOwner(db, input),
    beginInvocation: (input, owner) => beginSessionUsageInvocation(db, input, owner),
    disposition: (receipt, disposition) => disposeSessionUsageInvocation(db, receipt, disposition),
    retire: (receipt) => retireSessionUsageInvocation(db, receipt),
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
    loadCoverage: (sessionId) => db.transaction((tx) => readSessionCoverage(tx, sessionId)),
  };
}
