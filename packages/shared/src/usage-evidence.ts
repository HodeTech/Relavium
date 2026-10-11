/** Canonical complete quantities and inert W8 evidence foundations (ADR-0104). */
import { z } from 'zod';
import { MEDIA_BILLED_MODALITIES } from './constants.js';

const nonNegativeInt = z.number().int().nonnegative();

/** Inline media's disjoint billing axis; separate-endpoint fractional durations are not this type. */
export const MediaUnitsEntrySchema = z.object({
  modality: z.enum(MEDIA_BILLED_MODALITIES),
  direction: z.enum(['input', 'output']),
  units: nonNegativeInt,
  unit: z.enum(['count', 'second']),
});
export type MediaUnitsEntry = z.infer<typeof MediaUnitsEntrySchema>;

const usageFields = {
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  cacheReadTokens: nonNegativeInt.optional(),
  cacheWriteTokens: nonNegativeInt.optional(),
  // Observability only: reasoning is already included in billed output.
  reasoningTokens: nonNegativeInt.optional(),
  mediaUnits: z.array(MediaUnitsEntrySchema).optional(),
  // Computed by Relavium, never a provider-supplied price.
  costMicrocents: nonNegativeInt.optional(),
};
const reasoningIsSubset = (usage: {
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}): boolean =>
  usage.reasoningTokens === undefined ||
  usage.outputTokens === undefined ||
  usage.reasoningTokens <= usage.outputTokens;
const reasoningIssue = {
  message: 'reasoningTokens must be ≤ outputTokens (reasoning is counted inside output)',
  path: ['reasoningTokens'],
};

/** Existing complete arithmetic contract; its historical parse/strip behavior is preserved. */
export const UsageSchema = z.object(usageFields).refine(reasoningIsSubset, reasoningIssue);
export type Usage = z.infer<typeof UsageSchema>;

// Strengthen the same quantity definitions at the new boundary. Do not change the legacy schema
// or its consumers until the adapter/consumer migration activates the evidence protocol together.
const safeCount = nonNegativeInt.max(Number.MAX_SAFE_INTEGER);
const evidenceMediaEntry = MediaUnitsEntrySchema.extend({
  units: MediaUnitsEntrySchema.shape.units.max(Number.MAX_SAFE_INTEGER),
}).strict();
// The array keeps the legacy entry's vocabulary, with safe counts, strict fields and bounded axes.
const boundedMedia = z
  .array(evidenceMediaEntry)
  .max(MEDIA_BILLED_MODALITIES.length * 2)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => `${entry.modality}:${entry.direction}`)).size ===
      entries.length,
    'Each media billing axis occurs at most once',
  );
const evidenceQuantities = {
  inputTokens: usageFields.inputTokens.max(Number.MAX_SAFE_INTEGER),
  outputTokens: usageFields.outputTokens.max(Number.MAX_SAFE_INTEGER),
  cacheReadTokens: usageFields.cacheReadTokens.unwrap().max(Number.MAX_SAFE_INTEGER).optional(),
  cacheWriteTokens: usageFields.cacheWriteTokens.unwrap().max(Number.MAX_SAFE_INTEGER).optional(),
  reasoningTokens: usageFields.reasoningTokens.unwrap().max(Number.MAX_SAFE_INTEGER).optional(),
  mediaUnits: boundedMedia.optional(),
};

/** Absence stays absent; even an explicit undefined property is not quantity evidence. */
function noUndefinedFields(value: object): boolean {
  return Object.values(value).every((field: unknown) => field !== undefined);
}
const completeEvidenceUsage = z
  .object({ ...evidenceQuantities, costMicrocents: safeCount.optional() })
  .strict()
  .refine(noUndefinedFields, 'Quantity fields must be present values or absent')
  .refine(reasoningIsSubset, reasoningIssue);

export const KnownUsageQuantitiesSchema = z
  .object({
    ...evidenceQuantities,
    inputTokens: evidenceQuantities.inputTokens.optional(),
    outputTokens: evidenceQuantities.outputTokens.optional(),
  })
  .strict()
  .refine(noUndefinedFields, 'Quantity fields must be present values or absent')
  .refine(
    (known) =>
      Object.values(known).some((value: unknown) => typeof value === 'number') ||
      (known.mediaUnits !== undefined && known.mediaUnits.length > 0),
    'Partial evidence must contain a known quantity',
  )
  .refine(reasoningIsSubset, reasoningIssue);
export type KnownUsageQuantities = z.infer<typeof KnownUsageQuantitiesSchema>;

/** Closed, content-free reasons; both incomplete arms use the same vocabulary. */
export const UsageEvidenceReasonSchema = z.enum([
  'not_reported',
  'missing_fields',
  'invalid_fields',
  'contradictory_fields',
  'interrupted',
]);
export type UsageEvidenceReason = z.infer<typeof UsageEvidenceReasonSchema>;

export const CompleteUsageEvidenceSchema = z
  .object({ kind: z.literal('complete'), usage: completeEvidenceUsage })
  .strict();
export const PartialUsageEvidenceSchema = z
  .object({
    kind: z.literal('partial'),
    known: KnownUsageQuantitiesSchema,
    reason: UsageEvidenceReasonSchema,
  })
  .strict();
export const MissingUsageEvidenceSchema = z
  .object({ kind: z.literal('missing'), reason: UsageEvidenceReasonSchema })
  .strict();
export const UsageEvidenceSchema = z.discriminatedUnion('kind', [
  CompleteUsageEvidenceSchema,
  PartialUsageEvidenceSchema,
  MissingUsageEvidenceSchema,
]);
export type UsageEvidence = z.infer<typeof UsageEvidenceSchema>;

/** The owned boundary never exposes input, Zod issues or a hostile trap's cause. */
export class InvalidUsageEvidenceError extends Error {
  readonly code = 'invalid_usage_evidence';
  constructor() {
    super('Invalid usage evidence');
    this.name = 'InvalidUsageEvidenceError';
  }
}

/**
 * Inspect own descriptors before reading data; neither property getters nor toJSON run here.
 * The supported graph fits in 16 containers, four levels, eight keys/container and 32 chars/key
 * or string. These pre-parse limits also bound malformed graphs instead of asking Zod to walk them.
 */
function copyEvidenceData(value: unknown, seen: Set<object>, depth = 0): unknown {
  if (depth > 4) throw new InvalidUsageEvidenceError();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new InvalidUsageEvidenceError();
    return value;
  }
  if (typeof value === 'string' && value.length <= 32) return value;
  if (typeof value !== 'object' || value === null || seen.has(value) || seen.size >= 16) {
    throw new InvalidUsageEvidenceError();
  }
  seen.add(value);
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
  ) {
    throw new InvalidUsageEvidenceError();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 8) throw new InvalidUsageEvidenceError();
  const descriptors = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== 'string' || key.length > 32) throw new InvalidUsageEvidenceError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      (!descriptor.enumerable && !(array && key === 'length'))
    ) {
      throw new InvalidUsageEvidenceError();
    }
    const field: unknown = descriptor.value;
    descriptors.set(key, field);
  }
  if (array) {
    const length = descriptors.get('length');
    if (
      typeof length !== 'number' ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 6 ||
      descriptors.size !== length + 1
    ) {
      throw new InvalidUsageEvidenceError();
    }
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (!descriptors.has(String(index))) throw new InvalidUsageEvidenceError();
      result.push(copyEvidenceData(descriptors.get(String(index)), seen, depth + 1));
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of descriptors) {
    Object.defineProperty(result, key, {
      value: copyEvidenceData(field, seen, depth + 1),
      enumerable: true,
    });
  }
  return result;
}

function freezeQuantities(quantities: KnownUsageQuantities | Usage): void {
  if (quantities.mediaUnits !== undefined) {
    for (const entry of quantities.mediaUnits) Object.freeze(entry);
    Object.freeze(quantities.mediaUnits);
  }
  Object.freeze(quantities);
}

/** Own and deeply freeze valid evidence, or throw only InvalidUsageEvidenceError. */
export function ownUsageEvidence(value: unknown): UsageEvidence {
  try {
    const evidence = UsageEvidenceSchema.parse(copyEvidenceData(value, new Set()));
    if (evidence.kind === 'complete') freezeQuantities(evidence.usage);
    if (evidence.kind === 'partial') freezeQuantities(evidence.known);
    return Object.freeze(evidence);
  } catch {
    throw new InvalidUsageEvidenceError();
  }
}
