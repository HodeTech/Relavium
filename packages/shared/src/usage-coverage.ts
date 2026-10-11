import { z } from 'zod';

import { MissingUsageEvidenceSchema, PartialUsageEvidenceSchema } from './usage-evidence.js';
import { refineUsageDispositionReceipt } from './usage-disposition-validation.js';

/** ADR-0104 accounting metadata, separate from actual money and admission estimates. */
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCount = safeCount.min(1);
const correlationId = z.string().min(1).max(256);

/** Raw model attribution, never a catalog FK or a legacy model sentinel. */
export const UsageModelSchema = z.string().min(1).max(4096);

/** Pending is possibility, not observed invocation or an invented billable-call count. */
export const UsageCoverageSchema = z
  .object({
    unverified: z.boolean(),
    pendingInvocations: safeCount,
    unknownCalls: safeCount,
  })
  .strict();
export type UsageCoverage = z.infer<typeof UsageCoverageSchema>;

/**
 * Coverage correlation only. Existing run-sequence and session-model money keys do not change.
 * The producer's ordinal is allocated monotonically across its dispatches, not reset per round.
 * Reading a persisted identity never recovers permission to invoke or deliver a late receipt.
 */
export const UsageInvocationSchema = z
  .object({
    producerId: correlationId,
    ordinal: positiveCount,
    dispatchId: correlationId,
    round: safeCount,
    chainAttempt: positiveCount,
  })
  .strict();
export type UsageInvocation = z.infer<typeof UsageInvocationSchema>;

export const UsageCoverageBasisSchema = z.enum(['complete', 'legacy_unverified']);
export type UsageCoverageBasis = z.infer<typeof UsageCoverageBasisSchema>;

/** Complete settlement remains the existing sole actual-money write, never a disposition write. */
export const UsageDispositionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('incomplete'),
      evidence: z.union([PartialUsageEvidenceSchema, MissingUsageEvidenceSchema]),
    })
    .strict(),
  z
    .object({
      kind: z.literal('not_invoked'),
      reason: z.enum(['cancelled', 'credentials', 'admission_refused', 'preflight_refused']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('official_refusal'),
      reason: z.literal('pre_content_refusal'),
    })
    .strict(),
]);
export type UsageDisposition = z.infer<typeof UsageDispositionSchema>;

// ADR-0104 bounded durable accounting payloads.
export const UsageCoverageStartedPayloadSchema = z
  .object({ basis: UsageCoverageBasisSchema })
  .strict();
export const UsagePendingPayloadSchema = z
  .object({ model: UsageModelSchema, invocation: UsageInvocationSchema })
  .strict();
export const UsageDispositionPayloadSchema = z
  .object({
    model: UsageModelSchema,
    invocation: UsageInvocationSchema,
    disposition: UsageDispositionSchema,
    receiptPending: z.literal(true).optional(),
  })
  .strict()
  .superRefine(refineUsageDispositionReceipt);

/** Every total reader uses all three coverage axes before presenting a complete/free total. */
export function isUsageCoverageComplete(coverage: UsageCoverage): boolean {
  return !coverage.unverified && coverage.pendingInvocations === 0 && coverage.unknownCalls === 0;
}
