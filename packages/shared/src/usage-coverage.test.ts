import { describe, expect, it } from 'vitest';

import {
  isUsageCoverageComplete,
  UsageCoverageSchema,
  UsageCoverageStartedPayloadSchema,
  UsageDispositionPayloadSchema,
  UsageDispositionSchema,
  UsageInvocationSchema,
  UsageModelSchema,
  UsagePendingPayloadSchema,
} from './usage-coverage.js';

const invocation = {
  producerId: 'producer-1',
  ordinal: 1,
  dispatchId: 'dispatch-1',
  round: 0,
  chainAttempt: 1,
};

describe('usage coverage foundations (ADR-0104)', () => {
  for (const disposition of [
    { kind: 'incomplete', evidence: { kind: 'missing', reason: 'interrupted' } },
    { kind: 'not_invoked', reason: 'credentials' },
    { kind: 'official_refusal', reason: 'pre_content_refusal' },
  ] as const)
    it(`${disposition.kind}: only incomplete usage may retain a pending receipt`, () => {
      const payload = { model: 'model', invocation, disposition };
      expect(UsageDispositionPayloadSchema.safeParse(payload).success).toBe(true);
      expect(
        UsageDispositionPayloadSchema.safeParse({ ...payload, receiptPending: true }).success,
      ).toBe(disposition.kind === 'incomplete');
    });

  it('requires every uncertainty axis to be clear before any complete/free presentation', () => {
    const cases = [
      { coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 0 }, complete: true },
      { coverage: { unverified: true, pendingInvocations: 0, unknownCalls: 0 }, complete: false },
      { coverage: { unverified: false, pendingInvocations: 1, unknownCalls: 0 }, complete: false },
      { coverage: { unverified: false, pendingInvocations: 0, unknownCalls: 1 }, complete: false },
      { coverage: { unverified: true, pendingInvocations: 1, unknownCalls: 1 }, complete: false },
    ];
    for (const { coverage, complete } of cases) {
      expect(isUsageCoverageComplete(UsageCoverageSchema.parse(coverage))).toBe(complete);
    }
    // No amount or pricing flag is allowed to override the independently durable coverage account.
    expect(
      UsageCoverageSchema.safeParse({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
        costMicrocents: 0,
      }).success,
    ).toBe(false);
    expect(
      UsageCoverageSchema.safeParse({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 1,
        complete: true,
      }).success,
    ).toBe(false);
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unrepresentable coverage count %s without clamping',
    (count) => {
      for (const key of ['pendingInvocations', 'unknownCalls']) {
        expect(
          UsageCoverageSchema.safeParse({
            unverified: false,
            pendingInvocations: 0,
            unknownCalls: 0,
            [key]: count,
          }).success,
        ).toBe(false);
      }
    },
  );

  it('retains explicit zero and safe maximum counts without inferring legacy completeness', () => {
    expect(
      UsageCoverageSchema.parse({
        unverified: true,
        pendingInvocations: 0,
        unknownCalls: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ unverified: true, pendingInvocations: 0, unknownCalls: Number.MAX_SAFE_INTEGER });
    expect(UsageCoverageSchema.safeParse({ pendingInvocations: 0, unknownCalls: 0 }).success).toBe(
      false,
    );
  });

  it('keeps invocation correlation distinct from resettable chain and node retry counters', () => {
    expect(UsageInvocationSchema.parse(invocation)).toEqual(invocation);
    expect(UsageInvocationSchema.safeParse({ chainAttempt: 1 }).success).toBe(false);
    for (const key of ['ordinal', 'chainAttempt']) {
      expect(UsageInvocationSchema.safeParse({ ...invocation, [key]: 0 }).success).toBe(false);
    }
    for (const key of ['ordinal', 'round', 'chainAttempt']) {
      expect(
        UsageInvocationSchema.safeParse({ ...invocation, [key]: Number.MAX_SAFE_INTEGER + 1 })
          .success,
      ).toBe(false);
    }
    expect(UsageInvocationSchema.safeParse({ ...invocation, retryAuthority: true }).success).toBe(
      false,
    );
    expect(
      UsageInvocationSchema.safeParse({ ...invocation, dispatchId: 'd'.repeat(257) }).success,
    ).toBe(false);
    expect(UsageInvocationSchema.safeParse({ ...invocation, producerId: '' }).success).toBe(false);
  });

  it('bounds model attribution while allowing ordinary custom model strings', () => {
    expect(UsageModelSchema.parse('(pre-2.6.C)')).toBe('(pre-2.6.C)');
    expect(UsageModelSchema.parse('m'.repeat(4096))).toHaveLength(4096);
    expect(UsageModelSchema.safeParse('m'.repeat(4097)).success).toBe(false);
    expect(UsageModelSchema.safeParse('').success).toBe(false);
  });

  it('retains partial zero and missing evidence in content-free dispositions without guessed money', () => {
    const partial = {
      kind: 'incomplete',
      evidence: { kind: 'partial', known: { outputTokens: 0 }, reason: 'missing_fields' },
    };
    const missing = { kind: 'incomplete', evidence: { kind: 'missing', reason: 'not_reported' } };
    expect(UsageDispositionSchema.parse(partial)).toEqual(partial);
    expect(UsageDispositionSchema.parse(missing)).toEqual(missing);
    expect(
      UsageDispositionSchema.safeParse({
        kind: 'incomplete',
        evidence: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
      }).success,
    ).toBe(false);
    expect(UsageDispositionSchema.safeParse({ ...partial, costMicrocents: 0 }).success).toBe(false);
    expect(UsageDispositionSchema.safeParse({ ...partial, raw: 'provider response' }).success).toBe(
      false,
    );
  });

  it('distinguishes proven non-invocation and official refusal from unknown charge', () => {
    expect(UsageDispositionSchema.parse({ kind: 'not_invoked', reason: 'credentials' })).toEqual({
      kind: 'not_invoked',
      reason: 'credentials',
    });
    expect(
      UsageDispositionSchema.parse({ kind: 'official_refusal', reason: 'pre_content_refusal' }),
    ).toEqual({ kind: 'official_refusal', reason: 'pre_content_refusal' });
    expect(
      UsageDispositionSchema.safeParse({ kind: 'not_invoked', reason: 'provider text' }).success,
    ).toBe(false);
    expect(
      UsageDispositionSchema.safeParse({ kind: 'official_refusal', reason: 'not_reported' })
        .success,
    ).toBe(false);
  });

  it('makes basis and invocation payloads independent foundations without request content', () => {
    expect(UsageCoverageStartedPayloadSchema.parse({ basis: 'legacy_unverified' })).toEqual({
      basis: 'legacy_unverified',
    });
    expect(
      UsageCoverageStartedPayloadSchema.safeParse({ basis: 'complete', reset: true }).success,
    ).toBe(false);
    const pending = { model: 'custom-model', invocation };
    expect(UsagePendingPayloadSchema.parse(pending)).toEqual(pending);
    expect(UsagePendingPayloadSchema.safeParse({ ...pending, messages: [] }).success).toBe(false);
    const disposition = {
      ...pending,
      disposition: { kind: 'incomplete', evidence: { kind: 'missing', reason: 'interrupted' } },
    };
    expect(UsageDispositionPayloadSchema.parse(disposition)).toEqual(disposition);
    expect(
      UsageDispositionPayloadSchema.safeParse({ ...disposition, actualCostMicrocents: 0 }).success,
    ).toBe(false);
  });
});
