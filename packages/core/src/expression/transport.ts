/** Strict, bounded primitive-only private VM result transport (ADR-0113). */
import { utf8ByteLength } from '@relavium/shared';
import { z } from 'zod';

import { SandboxError } from '../errors.js';

const valueType = z.enum([
  'undefined',
  'function',
  'symbol',
  'bigint',
  'boolean',
  'string',
  'number',
  'object',
]);
const numberTag = z.enum(['nan', 'positive_infinity', 'negative_infinity', 'negative_zero']);
const transportSchema = z.union([
  z.object({ version: z.literal(1), kind: z.literal('denied') }).strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('failure'),
      stage: z.literal('evaluation'),
      payloadJson: z.string(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('failure'),
      stage: z.literal('serialization'),
      originalType: valueType,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('success'),
      originalType: valueType,
      payloadJson: z.string(),
      numberTag: numberTag.optional(),
    })
    .strict(),
]);
export type PrivateExpressionTransport = z.infer<typeof transportSchema>;
type SuccessTransport = Extract<PrivateExpressionTransport, { kind: 'success' }>;

function invalidTransport(): SandboxError {
  return new SandboxError('runtime', 'the expression returned invalid private result transport');
}

export function readPrivateExpressionTransport(
  text: string,
  memoryBytes: number,
): PrivateExpressionTransport {
  // Cheap length screen precedes UTF-8 counting, then the only host JSON parse of the envelope.
  if (text.length > memoryBytes || utf8ByteLength(text) > memoryBytes)
    throw new SandboxError('memory', 'the expression result exceeded its transport limit');
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw invalidTransport();
  }
  const parsed = transportSchema.safeParse(raw);
  if (!parsed.success) throw invalidTransport();
  return parsed.data;
}

export function decodeExpressionPayload(transport: SuccessTransport): unknown {
  let value: unknown;
  try {
    value = JSON.parse(transport.payloadJson) as unknown;
  } catch {
    throw invalidTransport();
  }
  if (transport.numberTag !== undefined) {
    if (transport.originalType !== 'number' || value !== null) throw invalidTransport();
    switch (transport.numberTag) {
      case 'nan':
        return Number.NaN;
      case 'positive_infinity':
        return Number.POSITIVE_INFINITY;
      case 'negative_infinity':
        return Number.NEGATIVE_INFINITY;
      case 'negative_zero':
        return -0;
    }
  }
  switch (transport.originalType) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidTransport();
      break;
    case 'string':
      if (typeof value !== 'string') throw invalidTransport();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw invalidTransport();
      break;
    // Object toJSON scalar/null behavior is classified by the existing per-kind result validator.
    case 'object':
      break;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      if (value !== null) throw invalidTransport();
      break;
  }
  return value;
}

/** Only called after the full primitive envelope has passed the byte/shape bound. */
export function decodeThrownPayload(payloadJson: string): unknown {
  try {
    return JSON.parse(payloadJson) as unknown;
  } catch {
    throw invalidTransport();
  }
}
