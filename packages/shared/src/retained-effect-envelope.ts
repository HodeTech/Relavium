import { z } from 'zod';

export type RetainedValuePresence =
  | { readonly hasValue: false; readonly value?: never }
  | { readonly hasValue: true; readonly value: unknown };
export type RetainedMappingPresence =
  | { readonly hasMappedValue: false; readonly mapped?: never }
  | { readonly hasMappedValue: true; readonly mapped: unknown };
export type RetainedEffectEnvelope = RetainedValuePresence &
  RetainedMappingPresence & {
    readonly v: 2;
    readonly truncated: boolean;
    readonly summary: string;
    readonly outputMapping: Readonly<Record<string, string>> | null;
  };

/** One strict decoder for storage, node admission and both dispatch replay entry points. */
const EnvelopeObjectSchema = z
  .object({
    v: z.literal(2),
    hasValue: z.boolean(),
    value: z.unknown().optional(),
    hasMappedValue: z.boolean(),
    mapped: z.unknown().optional(),
    truncated: z.boolean(),
    summary: z.string(),
    outputMapping: z
      .custom<Record<string, string>>(
        (value) =>
          ownDataRecord(value) && Object.values(value).every((item) => typeof item === 'string'),
      )
      .transform((value) => Object.fromEntries(Object.entries(value)))
      .nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [tag, key] of [
      ['hasValue', 'value'],
      ['hasMappedValue', 'mapped'],
    ] as const) {
      const present = Object.hasOwn(value, key);
      if (value[tag] ? !present || value[key] === undefined : present)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'inconsistent retained presence',
        });
    }
    if (value.outputMapping === null && value.hasMappedValue)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputMapping'],
        message: 'unconfigured mapping has a value',
      });
  });

function ownDataRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
  });
}
export const RetainedEffectEnvelopeSchema = z.preprocess((raw) => {
  if (!ownDataRecord(raw)) return undefined;
  const required = ['v', 'hasValue', 'hasMappedValue', 'truncated', 'summary', 'outputMapping'];
  if (!required.every((key) => Object.hasOwn(raw, key))) return undefined;
  const mapping = raw['outputMapping'];
  if (mapping !== null && !ownDataRecord(mapping)) return undefined;
  return raw;
}, EnvelopeObjectSchema);

export function decodeRetainedEffectEnvelope(raw: unknown): RetainedEffectEnvelope | undefined {
  const parsed = (() => {
    try {
      return RetainedEffectEnvelopeSchema.safeParse(raw);
    } catch {
      return undefined;
    } // Reflective traps are unusable evidence, never a guessed result.
  })();
  if (parsed === undefined || !parsed.success) return undefined;
  const value = parsed.data;
  return {
    v: 2,
    truncated: value.truncated,
    summary: value.summary,
    outputMapping: value.outputMapping,
    ...(value.hasValue ? { hasValue: true, value: value.value } : { hasValue: false }),
    ...(value.hasMappedValue
      ? { hasMappedValue: true, mapped: value.mapped }
      : { hasMappedValue: false }),
  };
}
