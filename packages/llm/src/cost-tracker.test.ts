import { describe, expect, it } from 'vitest';

import { CostTracker, cost, priceModel } from './cost-tracker.js';
import { UnknownModelError } from './errors.js';
import { KNOWN_MODEL_IDS, MODEL_PRICING, type ModelPricing } from './pricing.js';

describe('priceModel', () => {
  it('returns pricing for a known canonical model id', () => {
    const p = priceModel('claude-opus-4-8');
    expect(p.provider).toBe('anthropic');
    expect(p.inputPerMtokMicrocents).toBe(500_000_000); // $5/MTok → 5e8 micro-cents
  });

  it('throws a typed UnknownModelError (never a silent zero)', () => {
    expect(() => priceModel('gpt-9-ultra')).toThrowError(UnknownModelError);
    try {
      priceModel('gpt-9-ultra');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownModelError);
      if (err instanceof UnknownModelError) {
        expect(err.code).toBe('unknown_model');
        expect(err.modelId).toBe('gpt-9-ultra');
        expect(err.knownModels).toEqual(KNOWN_MODEL_IDS);
      }
    }
  });
});

describe('cost', () => {
  it('prices input + output in integer micro-cents (Opus 4.8)', () => {
    // 1000 in @ $5/MTok = 500_000µ¢; 500 out @ $25/MTok = 1_250_000µ¢
    expect(cost('claude-opus-4-8', { inputTokens: 1000, outputTokens: 500 })).toBe(1_750_000);
  });

  it('prices each token class once, including cache read + write (Opus 4.8)', () => {
    expect(
      cost('claude-opus-4-8', {
        inputTokens: 1000, // 500_000
        outputTokens: 500, // 1_250_000
        cacheReadTokens: 2000, // 2000 @ $0.50/MTok = 100_000
        cacheWriteTokens: 4000, // 4000 @ $6.25/MTok = 2_500_000
      }),
    ).toBe(4_350_000);
  });

  it('prices Sonnet 4.6 and DeepSeek from their own rows', () => {
    expect(cost('claude-sonnet-4-6', { inputTokens: 1000, outputTokens: 500 })).toBe(1_050_000);
    // deepseek-chat: 1000 in @ $0.27/MTok = 27_000µ¢; 500 out @ $1.10/MTok = 55_000µ¢
    expect(cost('deepseek-chat', { inputTokens: 1000, outputTokens: 500 })).toBe(82_000);
  });

  it('ignores cache-write tokens for a provider with no cache-write price (gpt-4o)', () => {
    // gpt-4o has no cacheWritePerMtokMicrocents → the 1000 cache-write tokens cost 0.
    expect(cost('gpt-4o', { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 1000 })).toBe(
      250_000,
    ); // 1000 in @ $2.50/MTok = 250_000
  });

  it('rounds the per-class micro-cent figure (half-up)', () => {
    // gpt-4o-mini cached input $0.075/MTok = 7_500_000µ¢/MTok → 1 token = 7.5 → rounds to 8.
    expect(cost('gpt-4o-mini', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 })).toBe(8);
  });
});

describe('CostTracker', () => {
  it('accumulates per-attempt cost across a failover', () => {
    const tracker = new CostTracker();
    const a = tracker.record('claude-opus-4-8', { inputTokens: 1000, outputTokens: 500 });
    expect(a).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      costMicrocents: 1_750_000,
      cumulativeCostMicrocents: 1_750_000,
    });
    const b = tracker.record('gpt-4o', { inputTokens: 1000, outputTokens: 0 });
    expect(b.costMicrocents).toBe(250_000);
    expect(b.cumulativeCostMicrocents).toBe(2_000_000); // 1_750_000 + 250_000
    expect(tracker.cumulativeCostMicrocents).toBe(2_000_000);
  });
});

describe('MODEL_PRICING table invariants (the values seeded into model_catalog)', () => {
  it('keys match KNOWN_MODEL_IDS and every catalog-projection field is complete + integer', () => {
    expect(Object.keys(MODEL_PRICING).sort()).toEqual([...KNOWN_MODEL_IDS].sort());
    const rows: Array<[string, ModelPricing]> = Object.entries(MODEL_PRICING);
    for (const [id, row] of rows) {
      expect(row.nativeId.length, id).toBeGreaterThan(0);
      expect(row.displayName.length, id).toBeGreaterThan(0);
      expect(row.contextWindowTokens, id).toBeGreaterThan(0);
      expect(row.maxOutputTokens, id).toBeGreaterThan(0);
      // Prices are integer micro-cents per MTok — never a float, and never negative.
      for (const price of [
        row.inputPerMtokMicrocents,
        row.outputPerMtokMicrocents,
        row.cachedInputPerMtokMicrocents,
        row.cacheWritePerMtokMicrocents ?? 0,
      ]) {
        expect(Number.isInteger(price), id).toBe(true);
        expect(price, id).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
