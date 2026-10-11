import { describe, expect, it, vi } from 'vitest';
import {
  InvalidUsageEvidenceError,
  KnownUsageQuantitiesSchema,
  MediaUnitsEntrySchema,
  UsageEvidenceSchema,
  UsageSchema,
  ownUsageEvidence,
  type Usage,
  type UsageEvidence,
} from './usage-evidence.js';
import { MEDIA_BILLED_MODALITIES } from './constants.js';

function rejectsSafely(value: unknown): void {
  let caught: unknown;
  try {
    ownUsageEvidence(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InvalidUsageEvidenceError);
  if (!(caught instanceof InvalidUsageEvidenceError)) throw new Error('Expected typed rejection');
  expect(caught.message).toBe('Invalid usage evidence');
  expect(caught.code).toBe('invalid_usage_evidence');
  expect(caught.cause).toBeUndefined();
  expect(JSON.stringify(caught)).not.toContain('untrusted-secret');
  expect(String(caught)).toBe('InvalidUsageEvidenceError: Invalid usage evidence');
}

const completeZero = { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } };
const image = { modality: 'image', direction: 'output', units: 1, unit: 'count' };

describe('usage evidence foundation', () => {
  it('preserves explicit complete zero without adding absent optional quantities', () => {
    expect(ownUsageEvidence(completeZero)).toEqual(completeZero);
    const partial = ownUsageEvidence({
      kind: 'partial',
      known: { inputTokens: 0 },
      reason: 'missing_fields',
    });
    expect(partial).toEqual({
      kind: 'partial',
      known: { inputTokens: 0 },
      reason: 'missing_fields',
    });
    if (partial.kind !== 'partial') throw new Error('Expected partial');
    expect(Object.hasOwn(partial.known, 'outputTokens')).toBe(false);
    expect(Object.hasOwn(partial.known, 'cacheReadTokens')).toBe(false);
    expect(ownUsageEvidence({ kind: 'missing', reason: 'not_reported' })).toEqual({
      kind: 'missing',
      reason: 'not_reported',
    });
  });

  it('does not weaken the complete quantity type used by pricing', () => {
    // This mirrors the existing complete-only pricing parameter without a shared → llm dependency.
    const completeOnly = (usage: Usage): number => usage.inputTokens + usage.outputTokens;
    const evidence = UsageEvidenceSchema.parse({
      kind: 'partial',
      known: { outputTokens: 7 },
      reason: 'missing_fields',
    });
    if (evidence.kind !== 'partial') throw new Error('Expected partial');
    // @ts-expect-error Partial observations cannot satisfy the complete-only pricing boundary.
    completeOnly(evidence.known);
    // @ts-expect-error Evidence must be narrowed and its complete usage selected before pricing.
    completeOnly(evidence);
    const complete = ownUsageEvidence(completeZero);
    if (complete.kind !== 'complete') throw new Error('Expected complete');
    expect(completeOnly(complete.usage)).toBe(0);
  });

  it('preserves legacy schema behavior and strengthens only evidence admission', () => {
    const legacy = { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0, ignored: 'legacy' };
    expect(UsageSchema.parse(legacy)).toEqual({ inputTokens: legacy.inputTokens, outputTokens: 0 });
    expect(MediaUnitsEntrySchema.parse({ ...image, ignored: true })).toEqual(image);
    rejectsSafely({ kind: 'complete', usage: legacy });
    rejectsSafely({ kind: 'complete', usage: { inputTokens: 0 } });
    rejectsSafely({ kind: 'complete', usage: { inputTokens: 0, outputTokens: undefined } });
  });

  it.each([
    'not_reported',
    'missing_fields',
    'invalid_fields',
    'contradictory_fields',
    'interrupted',
  ])('accepts only fixed incomplete reasons: %s', (reason) => {
    expect(ownUsageEvidence({ kind: 'missing', reason })).toEqual({ kind: 'missing', reason });
    expect(ownUsageEvidence({ kind: 'partial', known: { cacheReadTokens: 0 }, reason })).toEqual({
      kind: 'partial',
      known: { cacheReadTokens: 0 },
      reason,
    });
  });

  it.each([
    { kind: 'partial', known: {}, reason: 'missing_fields' },
    { kind: 'partial', known: { mediaUnits: [] }, reason: 'missing_fields' },
    { kind: 'partial', known: { inputTokens: undefined }, reason: 'missing_fields' },
    {
      kind: 'partial',
      known: { inputTokens: 0, outputTokens: undefined },
      reason: 'missing_fields',
    },
    { kind: 'partial', known: { costMicrocents: 0 }, reason: 'missing_fields' },
    { kind: 'partial', known: { outputTokens: 1, costMicrocents: 0 }, reason: 'missing_fields' },
    { kind: 'missing', reason: 'untrusted-secret' },
    { kind: 'missing', reason: 'not_reported', usage: { inputTokens: 0, outputTokens: 0 } },
    { ...completeZero, raw: 'untrusted-secret' },
    { kind: 'complete', usage: { ...completeZero.usage, raw: 'untrusted-secret' } },
    {
      kind: 'complete',
      usage: { ...completeZero.usage, mediaUnits: [{ ...image, raw: 'untrusted-secret' }] },
    },
  ])('rejects empty, undefined, invented money and unknown fields', (value) => {
    expect(UsageEvidenceSchema.safeParse(value).success).toBe(false);
    rejectsSafely(value);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN])(
    'rejects unsafe quantity %s on every axis',
    (quantity) => {
      for (const field of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reasoningTokens',
        'costMicrocents',
      ]) {
        const value = { kind: 'complete', usage: { ...completeZero.usage, [field]: quantity } };
        expect(UsageEvidenceSchema.safeParse(value).success).toBe(false);
        rejectsSafely(value);
      }
      rejectsSafely({
        kind: 'partial',
        known: { mediaUnits: [{ ...image, units: quantity }] },
        reason: 'invalid_fields',
      });
    },
  );

  it('accepts safe bounds and enforces reasoning only against a known output', () => {
    expect(
      ownUsageEvidence({
        kind: 'complete',
        usage: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: Number.MAX_SAFE_INTEGER,
          reasoningTokens: Number.MAX_SAFE_INTEGER,
        },
      }).kind,
    ).toBe('complete');
    expect(KnownUsageQuantitiesSchema.parse({ reasoningTokens: 4 })).toEqual({
      reasoningTokens: 4,
    });
    expect(
      KnownUsageQuantitiesSchema.safeParse({ outputTokens: 3, reasoningTokens: 4 }).success,
    ).toBe(false);
    rejectsSafely({
      kind: 'complete',
      usage: { inputTokens: 0, outputTokens: 3, reasoningTokens: 4 },
    });
    expect(
      ownUsageEvidence({
        kind: 'partial',
        known: { outputTokens: 4, reasoningTokens: 4 },
        reason: 'interrupted',
      }).kind,
    ).toBe('partial');
  });

  it('admits six distinct media axes while rejecting duplicates, excess and fractional inline units', () => {
    const mediaUnits = MEDIA_BILLED_MODALITIES.flatMap((modality) => [
      { modality, direction: 'input', units: 0, unit: 'count' },
      { modality, direction: 'output', units: Number.MAX_SAFE_INTEGER, unit: 'second' },
    ]);
    const value = { kind: 'partial', known: { mediaUnits }, reason: 'interrupted' };
    expect(ownUsageEvidence(value)).toEqual(value);
    for (const invalidMedia of [
      [...mediaUnits, image],
      [image, { ...image, units: 3, unit: 'second' }],
      [{ ...image, units: 0.5 }],
    ]) {
      const invalid = { ...value, known: { mediaUnits: invalidMedia } };
      expect(UsageEvidenceSchema.safeParse(invalid).success).toBe(false);
      rejectsSafely(invalid);
    }
  });

  it.each(['complete', 'partial'])(
    'owns and freezes the %s nested graph before caller mutation',
    (kind) => {
      const usage = { inputTokens: 1, outputTokens: 2, mediaUnits: [{ ...image }] };
      const source =
        kind === 'complete' ? { kind, usage } : { kind, known: usage, reason: 'interrupted' };
      const owned = ownUsageEvidence(source);
      const quantities =
        owned.kind === 'complete'
          ? owned.usage
          : owned.kind === 'partial'
            ? owned.known
            : undefined;
      if (quantities === undefined) throw new Error('Expected quantities');
      usage.inputTokens = 999;
      const originalEntry = usage.mediaUnits[0];
      if (originalEntry === undefined) throw new Error('Expected media');
      originalEntry.units = 999;
      usage.mediaUnits.push({ ...image });
      expect(quantities.inputTokens).toBe(1);
      expect(quantities.mediaUnits).toEqual([image]);
      expect(Object.isFrozen(owned)).toBe(true);
      expect(Object.isFrozen(quantities)).toBe(true);
      expect(Object.isFrozen(quantities.mediaUnits)).toBe(true);
      expect(Object.isFrozen(quantities.mediaUnits?.[0])).toBe(true);
      expect(() => {
        quantities.inputTokens = 8;
      }).toThrow(TypeError);
    },
  );

  it('accepts inert null-prototype own data', () => {
    const source: unknown = Object.create(null);
    if (typeof source !== 'object' || source === null) throw new Error('Expected record');
    Object.defineProperties(source, {
      kind: { value: 'missing', enumerable: true },
      reason: { value: 'not_reported', enumerable: true },
    });
    expect(ownUsageEvidence(source)).toEqual({ kind: 'missing', reason: 'not_reported' });
  });

  it('rejects accessors without running them, including toJSON and hidden/symbol properties', () => {
    const getter = vi.fn(() => {
      throw new Error('untrusted-secret');
    });
    const source = { ...completeZero };
    Object.defineProperty(source, 'usage', { get: getter, enumerable: true });
    rejectsSafely(source);
    rejectsSafely({ ...completeZero, toJSON: getter });
    const hidden = { ...completeZero };
    Object.defineProperty(hidden, 'untrusted-secret', { get: getter });
    rejectsSafely(hidden);
    rejectsSafely({ ...completeZero, [Symbol('untrusted-secret')]: 0 });
    expect(getter).not.toHaveBeenCalled();
  });

  it('never reads proxy properties while owning faithful own descriptors', () => {
    const get = vi.fn(() => {
      throw new Error('untrusted-secret');
    });
    expect(ownUsageEvidence(new Proxy(completeZero, { get }))).toEqual(completeZero);
    expect(get).not.toHaveBeenCalled();
  });

  it('contains hostile reflection failures without retaining a cause', () => {
    for (const handler of [
      {
        getPrototypeOf: () => {
          throw new Error('untrusted-secret');
        },
      },
      {
        ownKeys: () => {
          throw new Error('untrusted-secret');
        },
      },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('untrusted-secret');
        },
      },
    ])
      rejectsSafely(new Proxy(completeZero, handler));
    const revoked = Proxy.revocable(completeZero, {});
    revoked.revoke();
    rejectsSafely(revoked.proxy);
  });

  it('rejects exotic objects, sparse arrays, cycles and oversized graphs before traversal', () => {
    rejectsSafely(new Date());
    rejectsSafely(Object.create({ kind: 'missing', reason: 'not_reported' }));
    rejectsSafely({ kind: 'partial', known: { mediaUnits: Array(1) }, reason: 'interrupted' });
    const cycle: Record<string, unknown> = { kind: 'partial', reason: 'interrupted' };
    cycle['known'] = cycle;
    rejectsSafely(cycle);
    rejectsSafely({ kind: 'missing', reason: 'x'.repeat(1_000_000) });
    const getter = vi.fn();
    const huge = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`key${index}`, 0]));
    Object.defineProperty(huge, 'key0', { get: getter, enumerable: true });
    rejectsSafely(huge);
    expect(getter).not.toHaveBeenCalled();
    let deep: unknown = 0;
    for (let index = 0; index < 20; index++) deep = { child: deep };
    rejectsSafely(deep);
  });
});

// Inferred complete arm retains the existing complete Usage parameter contract.
function completeQuantityType(evidence: UsageEvidence): Usage | undefined {
  return evidence.kind === 'complete' ? evidence.usage : undefined;
}
void completeQuantityType;
