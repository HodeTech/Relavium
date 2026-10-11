import {
  UsageDispositionSchema,
  UsageInvocationSchema,
  UsageModelSchema,
  type UsageDisposition,
  type UsageInvocation,
} from '@relavium/shared';
import { and, eq, sql } from 'drizzle-orm';

import type { Db, TxDb } from './client.js';
import { agentSessions, sessionUsageCoverage, sessionUsageInvocations } from './schema.js';
import { reserveOneShotSessionEffectTurnKey } from './session-effect-turns.js';
import { SessionUsageError, withSessionUsageWrite } from './session-usage-write.js';

/** An in-process authority. Copying/serializing these public fields does not copy that authority. */
export interface SessionUsageReceipt {
  readonly sessionId: string;
  readonly model: string;
  readonly invocation: UsageInvocation;
}
export interface SessionUsageInvocationInput {
  readonly sessionId: string;
  readonly model: string;
  readonly producerId: string;
  readonly dispatchId: string;
  readonly round: number;
  readonly chainAttempt: number;
}
/** Only the exact returned object can admit work against its freshly inserted hidden owner. */
export interface SessionUsageOwner {
  readonly sessionId: string;
  readonly effectTurnKey: number;
}
const oneShotOwners = new WeakMap<SessionUsageOwner, Db>();
export function createFreshOneShotUsageOwner(
  db: Db,
  input: { readonly sessionId: string; readonly now: number },
): SessionUsageOwner {
  const effectTurnKey = reserveOneShotSessionEffectTurnKey(db, input.sessionId, input.now, true);
  const owner = Object.freeze({ sessionId: input.sessionId, effectTurnKey });
  oneShotOwners.set(owner, db);
  return owner;
}

interface ReceiptAuthority {
  readonly db: Db;
  retired: boolean;
}
// Weak keys, never a completed-invocation registry. Only a still-held live receipt retains its entry.
const authorities = new WeakMap<SessionUsageReceipt, ReceiptAuthority>();

function authority(db: Db, receipt: SessionUsageReceipt): ReceiptAuthority {
  const held = authorities.get(receipt);
  if (held === undefined || held.db !== db) throw new SessionUsageError('receipt_invalid');
  return held;
}
function identityWhere(receipt: SessionUsageReceipt) {
  return and(
    eq(sessionUsageInvocations.sessionId, receipt.sessionId),
    eq(sessionUsageInvocations.producerId, receipt.invocation.producerId),
    eq(sessionUsageInvocations.ordinal, receipt.invocation.ordinal),
  );
}
function state(tx: TxDb, receipt: SessionUsageReceipt): 'pending' | 'incomplete' {
  const row = tx.select().from(sessionUsageInvocations).where(identityWhere(receipt)).get();
  if (
    row === undefined ||
    row.model !== receipt.model ||
    row.dispatchId !== receipt.invocation.dispatchId ||
    row.round !== receipt.invocation.round ||
    row.chainAttempt !== receipt.invocation.chainAttempt ||
    (row.coverageState !== 'pending' && row.coverageState !== 'incomplete')
  )
    throw new SessionUsageError('history_invalid');
  return row.coverageState;
}
function changeCoverage(
  tx: TxDb,
  receipt: SessionUsageReceipt,
  pending: number,
  unknown: number,
): void {
  const changed = tx
    .update(sessionUsageCoverage)
    .set({
      pendingInvocations: sql`${sessionUsageCoverage.pendingInvocations} + ${pending}`,
      unknownCalls: sql`${sessionUsageCoverage.unknownCalls} + ${unknown}`,
    })
    .where(
      and(
        eq(sessionUsageCoverage.sessionId, receipt.sessionId),
        eq(sessionUsageCoverage.model, receipt.model),
      ),
    )
    .run();
  if (changed.changes !== 1) throw new SessionUsageError('history_invalid');
  const owner = tx
    .update(agentSessions)
    .set({
      usagePendingInvocations: sql`${agentSessions.usagePendingInvocations} + ${pending}`,
      usageUnknownCalls: sql`${agentSessions.usageUnknownCalls} + ${unknown}`,
    })
    .where(eq(agentSessions.id, receipt.sessionId))
    .run();
  if (owner.changes !== 1) throw new SessionUsageError('history_invalid');
}

export function beginSessionUsageInvocation(
  db: Db,
  input: SessionUsageInvocationInput,
  ownerAuthority?: SessionUsageOwner,
): SessionUsageReceipt {
  if (
    ownerAuthority !== undefined &&
    (oneShotOwners.get(ownerAuthority) !== db || ownerAuthority.sessionId !== input.sessionId)
  )
    throw new SessionUsageError('receipt_invalid');
  const model = UsageModelSchema.parse(input.model);
  const context = UsageInvocationSchema.parse({
    producerId: input.producerId,
    ordinal: 1,
    dispatchId: input.dispatchId,
    round: input.round,
    chainAttempt: input.chainAttempt,
  });
  const receipt = withSessionUsageWrite(db, [input.sessionId], (tx) => {
    const owner = tx
      .select({
        highWater: agentSessions.usageInvocationHighWater,
        deletedAt: agentSessions.deletedAt,
      })
      .from(agentSessions)
      .where(eq(agentSessions.id, input.sessionId))
      .get();
    if (
      owner === undefined ||
      (owner.deletedAt !== null && ownerAuthority === undefined) ||
      !Number.isSafeInteger(owner.highWater) ||
      owner.highWater < 0
    )
      throw new SessionUsageError('history_invalid');
    if (owner.highWater === Number.MAX_SAFE_INTEGER)
      throw new SessionUsageError('revision_exhausted');
    const invocation = Object.freeze({ ...context, ordinal: owner.highWater + 1 });
    const result = Object.freeze({ sessionId: input.sessionId, model, invocation });
    tx.update(agentSessions)
      .set({ usageInvocationHighWater: invocation.ordinal })
      .where(eq(agentSessions.id, input.sessionId))
      .run();
    tx.insert(sessionUsageInvocations)
      .values({ sessionId: input.sessionId, model, ...invocation })
      .run();
    tx.insert(sessionUsageCoverage)
      .values({ sessionId: input.sessionId, model })
      .onConflictDoNothing()
      .run();
    changeCoverage(tx, result, 1, 0);
    return result;
  });
  authorities.set(receipt, { db, retired: false });
  return receipt;
}

export function disposeSessionUsageInvocation(
  db: Db,
  receipt: SessionUsageReceipt,
  value: UsageDisposition,
): boolean {
  const disposition = UsageDispositionSchema.parse(value);
  const held = authority(db, receipt);
  if (held.retired) return false;
  const accepted = withSessionUsageWrite(db, [receipt.sessionId], (tx) => {
    const current = state(tx, receipt);
    if (current === 'incomplete') return false;
    changeCoverage(tx, receipt, -1, disposition.kind === 'incomplete' ? 1 : 0);
    if (disposition.kind === 'incomplete') {
      tx.update(sessionUsageInvocations)
        .set({ coverageState: 'incomplete' })
        .where(identityWhere(receipt))
        .run();
    } else tx.delete(sessionUsageInvocations).where(identityWhere(receipt)).run();
    return true;
  });
  if (accepted && disposition.kind !== 'incomplete') held.retired = true;
  return accepted;
}

/** Called ONLY inside recordSessionCost's owning transaction, before either actual-money write. */
export function completeSessionUsageInvocation(
  db: Db,
  tx: TxDb,
  receipt: SessionUsageReceipt,
  sessionId: string,
  model: string,
): boolean {
  const held = authority(db, receipt);
  if (receipt.sessionId !== sessionId || receipt.model !== model)
    throw new SessionUsageError('receipt_invalid');
  if (held.retired) return false;
  const current = state(tx, receipt);
  changeCoverage(tx, receipt, current === 'pending' ? -1 : 0, current === 'incomplete' ? -1 : 0);
  tx.delete(sessionUsageInvocations).where(identityWhere(receipt)).run();
  return true;
}
/** Authority is consumed only AFTER the entire actual-cost transaction successfully commits. */
export function acknowledgeSessionUsageComplete(db: Db, receipt: SessionUsageReceipt): void {
  authority(db, receipt).retired = true;
}

export function retireSessionUsageInvocation(db: Db, receipt: SessionUsageReceipt): void {
  const held = authority(db, receipt);
  if (held.retired) return;
  withSessionUsageWrite(db, [receipt.sessionId], (tx) => {
    state(tx, receipt);
    tx.delete(sessionUsageInvocations).where(identityWhere(receipt)).run();
  });
  // Retirement cannot erase pending possibility or an established unknown call. No reload grants authority.
  held.retired = true;
}
