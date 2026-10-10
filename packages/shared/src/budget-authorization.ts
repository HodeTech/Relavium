/** Scalar durable budget authority and frozen price evidence (ADR-0097/0100/0101). */
import { z } from 'zod';
import { LLM_PROVIDERS, MEDIA_BILLED_MODALITIES } from './constants.js';

// JSON has one zero representation. Normalise only durable budget scalars, leaving the
// general structural comparator's Object.is semantics unchanged.
const normalizeZero = (value: number): number => (value === 0 ? 0 : value);
const quantity = z.number().finite().nonnegative().transform(normalizeZero);
// These are existing observations, not granted money. Preserve BudgetPausedEvent's range.
const observedMicrocents = z.number().finite().int().nonnegative().transform(normalizeZero);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const BudgetMicrocentsSchema = safeInteger.transform(normalizeZero);
const count = BudgetMicrocentsSchema;
const positiveCount = safeInteger.min(1).transform(normalizeZero);
export const EndpointKindSchema = z.enum(['official', 'custom']);
export type EndpointKind = z.infer<typeof EndpointKindSchema>;

const mediaUnitsShape = { modality: z.enum(MEDIA_BILLED_MODALITIES), units: quantity };
export const MediaUnitsEstimateSchema = z.object(mediaUnitsShape).strict().readonly();
export type MediaUnitsEstimate = z.infer<typeof MediaUnitsEstimateSchema>;
export const MediaEstimateBasisSchema = z
  .object({ ...mediaUnitsShape, rateMicrocents: quantity.optional() })
  .strict()
  .transform((basis) => {
    if (basis.rateMicrocents === undefined) delete basis.rateMicrocents;
    return basis;
  })
  .readonly();
export type MediaEstimateBasis = z.infer<typeof MediaEstimateBasisSchema>;
export const RequestEstimateBasisSchema = z
  .object({
    inputTokensEstimate: quantity,
    outputTokensReservation: quantity,
    inputRateKind: z.literal('non_cached'),
    inputPerMtokMicrocents: quantity,
    outputPerMtokMicrocents: quantity,
    contextTierAboveTokens: quantity.optional(),
    media: z.array(MediaEstimateBasisSchema).readonly(),
  })
  .strict()
  .transform((basis) => {
    if (basis.contextTierAboveTokens === undefined) delete basis.contextTierAboveTokens;
    return basis;
  })
  .readonly();
export type RequestEstimateBasis = z.infer<typeof RequestEstimateBasisSchema>;
const estimateEvidence = {
  basis: RequestEstimateBasisSchema,
  unpricedModalities: z.array(z.enum(MEDIA_BILLED_MODALITIES)).readonly(),
};
export const ResolvedRequestEstimateSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('priced'),
        microcents: BudgetMicrocentsSchema,
        ...estimateEvidence,
      })
      .strict(),
    z.object({ kind: z.literal('unrepresentable'), ...estimateEvidence }).strict(),
  ])
  .readonly();
export type ResolvedRequestEstimate = z.infer<typeof ResolvedRequestEstimateSchema>;

const entryIdentity = {
  index: count,
  model: z.string().min(1),
  provider: z.enum(LLM_PROVIDERS),
  endpoint: EndpointKindSchema,
};
export const AllowanceEntryIdentitySchema = z.object(entryIdentity).strict().readonly();
export type AllowanceEntryIdentity = z.infer<typeof AllowanceEntryIdentitySchema>;
export const AllowanceExcludedEntrySchema = z
  .object({
    ...entryIdentity,
    reason: z.enum(['unsupported', 'unpriced_model', 'unpriced_modality']),
  })
  .strict()
  .readonly();
export type AllowanceExcludedEntry = z.infer<typeof AllowanceExcludedEntrySchema>;
export const AllowancePricedEntrySchema = z
  .object({
    ...entryIdentity,
    attempts: positiveCount,
    estimate: ResolvedRequestEstimateSchema,
  })
  .strict()
  .readonly();
export type AllowancePricedEntry = z.infer<typeof AllowancePricedEntrySchema>;
export const AllowanceProvenanceSchema = z
  .object({
    version: z.literal(1),
    route: z.enum(['text', 'generative']),
    calls: positiveCount,
    attempts: positiveCount,
    entries: z.array(AllowancePricedEntrySchema).min(1).readonly(),
  })
  .strict()
  .readonly();
export type AllowanceProvenance = z.infer<typeof AllowanceProvenanceSchema>;
export const AllowanceAmountSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('representable'), microcents: BudgetMicrocentsSchema }).strict(),
    z.object({ kind: z.literal('unrepresentable') }).strict(),
  ])
  .readonly();
export type AllowanceAmount = z.infer<typeof AllowanceAmountSchema>;
export const AllowanceQuoteSchema = z
  .object({
    amount: AllowanceAmountSchema,
    provenance: AllowanceProvenanceSchema,
    excludedEntries: z.array(AllowanceExcludedEntrySchema).readonly(),
  })
  .strict()
  .readonly();
export type AllowanceQuote = z.infer<typeof AllowanceQuoteSchema>;
export const AllowanceQuoteResultSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('quoted'), quote: AllowanceQuoteSchema }).strict(),
    z
      .object({
        kind: z.literal('unpriced'),
        excludedEntries: z.array(AllowanceExcludedEntrySchema).min(1).readonly(),
      })
      .strict(),
  ])
  .readonly();
export type AllowanceQuoteResult = z.infer<typeof AllowanceQuoteResultSchema>;

/** Authorization data is scalar. Runtime ownership and preparation capabilities remain outside this schema. */
export const BudgetAllowanceStateSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('frozen'), quote: AllowanceQuoteResultSchema }).strict(),
    z.object({ kind: z.literal('legacy_no_allowance') }).strict(),
  ])
  .readonly();
export type BudgetAllowanceState = z.infer<typeof BudgetAllowanceStateSchema>;

// The run/node/gate event envelope is owned by run-event.ts.
const deadlineFields = {
  timeoutMs: z.number().finite().int().nonnegative().transform(normalizeZero).optional(),
  timeoutAction: z.enum(['approve', 'reject']).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
};
export const BudgetAuthorizationStateSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('paused'),
        allowance: BudgetAllowanceStateSchema,
        spentMicrocents: observedMicrocents,
        limitMicrocents: observedMicrocents,
        ...deadlineFields,
      })
      .strict(),
    z
      .object({
        state: z.literal('decided'),
        allowance: BudgetAllowanceStateSchema,
        decision: z.enum(['approved', 'rejected']),
        decidedBy: z.string().min(1),
        approvedAmountMicrocents: BudgetMicrocentsSchema.optional(),
        ...deadlineFields,
      })
      .strict(),
  ])
  .superRefine((state, ctx) => {
    // Preserve the existing gate's deadline fields exactly, including historical partial tuples.
    // Authorization never invents a missing deadline or restarts its authored duration.
    if (state.state !== 'decided') return;
    if (state.decision === 'rejected') {
      if (state.approvedAmountMicrocents !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rejection cannot grant an amount',
          path: ['approvedAmountMicrocents'],
        });
      }
      return;
    }
    const allowance = state.allowance;
    if (allowance.kind === 'legacy_no_allowance') {
      if (state.approvedAmountMicrocents !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'legacy approval grants no amount',
          path: ['approvedAmountMicrocents'],
        });
      }
      return;
    }
    const result = allowance.quote;
    if (result.kind !== 'quoted' || result.quote.amount.kind !== 'representable') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorization has no approvable amount',
        path: ['decision'],
      });
      return;
    }
    if (state.approvedAmountMicrocents !== result.quote.amount.microcents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approval amount must equal frozen amount',
        path: ['approvedAmountMicrocents'],
      });
    }
  })
  .transform((state) => {
    // Optional absence has one parsed representation before and after JSON persistence.
    // Strict validation above still rejects unknown fields, including undefined ones.
    if (state.timeoutMs === undefined) delete state.timeoutMs;
    if (state.timeoutAction === undefined) delete state.timeoutAction;
    if (state.expiresAt === undefined) delete state.expiresAt;
    if (state.state === 'decided' && state.approvedAmountMicrocents === undefined)
      delete state.approvedAmountMicrocents;
    return state;
  })
  .readonly();
export type BudgetAuthorizationState = z.infer<typeof BudgetAuthorizationStateSchema>;
