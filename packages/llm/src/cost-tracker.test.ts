import { describe, expect, it } from 'vitest';

import { CostTracker, cost, mediaCost, priceModel } from './cost-tracker.js';
import { UnknownModelError } from './errors.js';
import { KNOWN_MODEL_IDS, MODEL_PRICING, type ModelPricing } from './pricing.js';

/** A throwaway priced model carrying media-output rates — no 1.AF table row has them, so tests construct one. */
const PRICED_MEDIA: ModelPricing = {
  provider: 'gemini',
  nativeId: 'test-media',
  displayName: 'Test Media',
  contextWindowTokens: 1_000,
  maxOutputTokens: 1_000,
  inputPerMtokMicrocents: 0,
  outputPerMtokMicrocents: 0,
  cachedInputPerMtokMicrocents: 0,
  mediaOutputRates: { image: 1_000, audio: 200, video: 5_000 }, // µ¢ per image / audio-sec / video-sec
};

describe('priceModel', () => {
  it('returns pricing for a known canonical model id', () => {
    const p = priceModel('claude-opus-4-8');
    expect(p.provider).toBe('anthropic');
    expect(p.inputPerMtokMicrocents).toBe(500_000_000); // $5/MTok → 5e8 micro-cents
  });

  it('prices the current DeepSeek ids deepseek-v4-flash (default) and deepseek-v4-pro (premium)', () => {
    // Verified 2026-07-03 against api-docs.deepseek.com/quick_start/pricing. nativeId is the exact wire string.
    const flash = priceModel('deepseek-v4-flash');
    expect(flash.provider).toBe('deepseek');
    expect(flash.nativeId).toBe('deepseek-v4-flash');
    expect(flash.inputPerMtokMicrocents).toBe(14_000_000); // $0.14/MTok
    expect(flash.outputPerMtokMicrocents).toBe(28_000_000); // $0.28/MTok
    expect(flash.cachedInputPerMtokMicrocents).toBe(280_000); // $0.0028/MTok cache-hit
    const pro = priceModel('deepseek-v4-pro');
    expect(pro.provider).toBe('deepseek');
    expect(pro.nativeId).toBe('deepseek-v4-pro');
    expect(pro.inputPerMtokMicrocents).toBe(43_500_000); // $0.435/MTok
    expect(pro.outputPerMtokMicrocents).toBe(87_000_000); // $0.87/MTok
    expect(pro.cachedInputPerMtokMicrocents).toBe(362_500); // $0.003625/MTok cache-hit
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
    // deepseek-chat: 1000 in @ $0.14/MTok = 14_000µ¢; 500 out @ $0.28/MTok = 14_000µ¢
    expect(cost('deepseek-chat', { inputTokens: 1000, outputTokens: 500 })).toBe(28_000);
  });

  it('ignores cache-write tokens for a provider with no cache-write price (gpt-5.5)', () => {
    // gpt-5.5 has no cacheWritePerMtokMicrocents → the 1000 cache-write tokens cost 0.
    expect(cost('gpt-5.5', { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 1000 })).toBe(
      500_000,
    ); // 1000 in @ $5.00/MTok = 500_000
  });

  it('rounds the per-class micro-cent figure (half-up)', () => {
    // gpt-5.4-mini cached input $0.075/MTok = 7_500_000µ¢/MTok → 1 token = 7.5 → rounds to 8.
    expect(cost('gpt-5.4-mini', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1 })).toBe(8);
  });
});

describe('mediaCost (1.AF/D17 — per-modality media output addend)', () => {
  it('prices output image (per count), audio + video (per second), summed', () => {
    expect(
      mediaCost(PRICED_MEDIA, [
        { modality: 'image', direction: 'output', units: 3, unit: 'count' }, // 3 × 1_000
        { modality: 'audio', direction: 'output', units: 10, unit: 'second' }, // 10 × 200
        { modality: 'video', direction: 'output', units: 2, unit: 'second' }, // 2 × 5_000
      ]),
    ).toBe(3_000 + 2_000 + 10_000);
  });

  it('never charges INPUT-direction media (it bills as input tokens already)', () => {
    expect(
      mediaCost(PRICED_MEDIA, [{ modality: 'image', direction: 'input', units: 5, unit: 'count' }]),
    ).toBe(0);
  });

  it('rounds a fractional addend to an integer micro-cent (a fractional durationSeconds × rate)', () => {
    // 2.5s × 201/s = 502.5 → ROUNDED to 503; the cost path must never emit a non-integer micro-cent (1.AG §5).
    const oddAudio: ModelPricing = { ...PRICED_MEDIA, mediaOutputRates: { audio: 201 } };
    const total = mediaCost(oddAudio, [
      { modality: 'audio', direction: 'output', units: 2.5, unit: 'second' },
    ]);
    expect(total).toBe(503);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('skips a modality the model does not rate (degrade-to-0, never hard-fail)', () => {
    const onlyImage: ModelPricing = { ...PRICED_MEDIA, mediaOutputRates: { image: 1_000 } };
    expect(
      mediaCost(onlyImage, [{ modality: 'audio', direction: 'output', units: 10, unit: 'second' }]),
    ).toBe(0);
    // No rates at all → 0 (the 1.AF reality for every real table row). The key is omitted entirely
    // (not set to `undefined`, which exactOptionalPropertyTypes rejects).
    const noRates: ModelPricing = {
      provider: 'gemini',
      nativeId: 'no-rates',
      displayName: 'No Rates',
      contextWindowTokens: 1_000,
      maxOutputTokens: 1_000,
      inputPerMtokMicrocents: 0,
      outputPerMtokMicrocents: 0,
      cachedInputPerMtokMicrocents: 0,
    };
    expect(
      mediaCost(noRates, [{ modality: 'image', direction: 'output', units: 3, unit: 'count' }]),
    ).toBe(0);
  });

  it('treats a token-`count` audio unit as observability-only when only a per-second rate exists', () => {
    // A token-based provider reports audio as a raw token count (unit: 'count'); with only a per-second
    // audio rate it does NOT bill (ADR-0044 §3 — never a fabricated tokens→seconds conversion).
    expect(
      mediaCost(PRICED_MEDIA, [
        { modality: 'audio', direction: 'output', units: 500, unit: 'count' },
      ]),
    ).toBe(0);
  });

  it('undefined mediaUnits contributes 0 (the dominant text/handle-only case)', () => {
    expect(mediaCost(PRICED_MEDIA, undefined)).toBe(0);
  });

  it('cost() folds media as a disjoint addend, never into the token path (real rows price media at 0)', () => {
    // A real table row carries no media rate, so a media-bearing usage adds 0 over the token cost.
    expect(
      cost('claude-opus-4-8', {
        inputTokens: 1000, // 500_000
        outputTokens: 500, // 1_250_000
        mediaUnits: [{ modality: 'image', direction: 'output', units: 2, unit: 'count' }],
      }),
    ).toBe(1_750_000);
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
    const b = tracker.record('gpt-5.5', { inputTokens: 1000, outputTokens: 0 });
    expect(b.costMicrocents).toBe(500_000);
    expect(b.cumulativeCostMicrocents).toBe(2_250_000); // 1_750_000 + 500_000
    expect(tracker.cumulativeCostMicrocents).toBe(2_250_000);
  });
});

describe('user-pricing overlay (2.5.G S10, ADR-0065 §2)', () => {
  // A user-supplied price for a model the static registry does NOT know (a custom-endpoint id).
  const OVERLAY: ReadonlyMap<string, ModelPricing> = new Map([
    [
      'acme-custom-1',
      {
        provider: 'openai',
        nativeId: 'acme-custom-1',
        displayName: 'Acme Custom 1',
        contextWindowTokens: 32_000,
        maxOutputTokens: 4_000,
        inputPerMtokMicrocents: 300_000_000, // $3/MTok
        outputPerMtokMicrocents: 900_000_000, // $9/MTok
        cachedInputPerMtokMicrocents: 0,
      },
    ],
    // A user row that COLLIDES with a canonical id — the static registry must still win (no silent misprice).
    [
      'claude-opus-4-8',
      {
        provider: 'anthropic',
        nativeId: 'claude-opus-4-8',
        displayName: 'Tampered Opus',
        contextWindowTokens: 1,
        maxOutputTokens: 1,
        inputPerMtokMicrocents: 1, // absurd override — must be ignored
        outputPerMtokMicrocents: 1,
        cachedInputPerMtokMicrocents: 0,
      },
    ],
  ]);

  it('priceModel fills an UNKNOWN id from the overlay', () => {
    const p = priceModel('acme-custom-1', OVERLAY);
    expect(p.inputPerMtokMicrocents).toBe(300_000_000);
    expect(p.provider).toBe('openai');
  });

  it('priceModel keeps the STATIC registry authoritative for a known id even when the overlay collides', () => {
    const p = priceModel('claude-opus-4-8', OVERLAY);
    expect(p.displayName).toBe('Claude Opus 4.8'); // the static row, not the tampered overlay
    expect(p.inputPerMtokMicrocents).toBe(500_000_000); // $5/MTok, not the overlay's 1µ¢
  });

  it('priceModel still throws UnknownModelError for an id absent from BOTH tiers', () => {
    expect(() => priceModel('not-anywhere', OVERLAY)).toThrowError(UnknownModelError);
  });

  it('cost() prices a user-priced unknown model via the overlay (the cost-cap gap is closed)', () => {
    // 1000 in @ $3/MTok = 300_000µ¢; 500 out @ $9/MTok = 450_000µ¢ → 750_000µ¢.
    expect(cost('acme-custom-1', { inputTokens: 1000, outputTokens: 500 }, OVERLAY)).toBe(750_000);
  });

  it('cost() without an overlay still throws for the same unknown model (no silent zero)', () => {
    expect(() => cost('acme-custom-1', { inputTokens: 1000, outputTokens: 500 })).toThrowError(
      UnknownModelError,
    );
  });

  it('CostTracker records realized cost for a user-priced model when constructed with the overlay', () => {
    const tracker = new CostTracker(OVERLAY);
    const r = tracker.record('acme-custom-1', { inputTokens: 1000, outputTokens: 500 });
    expect(r.costMicrocents).toBe(750_000);
    expect(tracker.cumulativeCostMicrocents).toBe(750_000);
  });

  it('CostTracker WITHOUT an overlay throws on the same unknown model (degrades loudly, never a silent 0)', () => {
    const tracker = new CostTracker();
    expect(() => tracker.record('acme-custom-1', { inputTokens: 1000, outputTokens: 500 })).toThrowError(
      UnknownModelError,
    );
  });
});

describe('MODEL_PRICING table invariants (the values seeded into model_catalog)', () => {
  it('keys match KNOWN_MODEL_IDS and every catalog-projection field is complete + integer', () => {
    const byLocale = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(MODEL_PRICING).sort(byLocale)).toEqual([...KNOWN_MODEL_IDS].sort(byLocale));
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
