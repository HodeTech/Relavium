import { describe, expect, it } from 'vitest';

import { estimateMaxNextCost, estimateMediaCost } from './budget-estimator.js';
import { catalogPricing } from './catalog/pricing.js';
import type { ModelPricing } from './pricing.js';

describe('estimateMaxNextCost', () => {
  it('estimates output-only worst case at maxTokens', () => {
    const model = catalogPricing('claude-sonnet-4-6');
    if (model === undefined) throw new Error('claude-sonnet-4-6 is not priced');
    // 10_000 output tokens @ $15/MTok = 150_000 micro-cents
    expect(estimateMaxNextCost('claude-sonnet-4-6', 10_000)).toBe(
      Math.round((10_000 * model.outputPerMtokMicrocents) / 1_000_000),
    );
  });

  it('returns 0 for non-positive maxTokens', () => {
    expect(estimateMaxNextCost('claude-sonnet-4-6', 0)).toBe(0);
    expect(estimateMaxNextCost('claude-sonnet-4-6', -1)).toBe(0);
  });

  it('throws UnknownModelError for an unlisted model', () => {
    expect(() => estimateMaxNextCost('not-a-real-model', 1_000)).toThrow('unknown model id');
  });

  it('uses the cheaper mini rate for a mini model', () => {
    const model = catalogPricing('gpt-5.4-mini');
    if (model === undefined) throw new Error('gpt-5.4-mini is not priced');
    expect(estimateMaxNextCost('gpt-5.4-mini', 100_000)).toBe(
      Math.round((100_000 * model.outputPerMtokMicrocents) / 1_000_000),
    );
  });
});

describe('estimateMaxNextCost — the estimate must price the request we ACTUALLY send (ADR-0071 §7)', () => {
  it('prices the CLAMPED cap, not the authored one — the governor was killing runs over phantom money', () => {
    // `gemini-2.5-pro`'s output ceiling is 65_536. An agent authored with `max_tokens: 200000` used to be
    // pre-authorized for THREE TIMES the spend the model is physically capable of producing. With `on_exceed: fail`
    // that killed the run over money that could never be spent; with `pause_for_approval` it was a human gate for
    // the same phantom. Before the clamp landed the request simply 400'd, so the gap was invisible — now the
    // request is valid, and an estimate of an unsendable request is just wrong.
    const authored = estimateMaxNextCost('gemini-2.5-pro', 200_000);
    const ceiling = estimateMaxNextCost('gemini-2.5-pro', 65_536);
    expect(authored).toBe(ceiling); // the over-ceiling ask is priced at the ceiling — the only spend that can occur
    expect(authored).toBeLessThan(estimateMaxNextCost('gemini-2.5-pro', 65_536) * 3);
  });

  it('still prices a cap BELOW the ceiling at what was asked for — the clamp is one-directional', () => {
    const small = estimateMaxNextCost('gemini-2.5-pro', 1_000);
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(estimateMaxNextCost('gemini-2.5-pro', 65_536));
  });

  it('does NOT clamp a CUSTOM endpoint — the same bug pointing the other way, and the dangerous direction', () => {
    // The adapter deliberately does not clamp a custom `base_url` (it may serve anything under a familiar id). An
    // estimate that clamps ANYWAY lands BELOW what the wire can spend — so the governor under-authorizes and waves
    // through the very call it exists to stop. `on_exceed: fail` then fails to fail.
    //
    // Over-estimating kills a valid run; UNDER-estimating spends the user's money. The estimate has to make the
    // same call the adapter makes, and the host is the only one who knows which endpoint this is.
    const asOfficial = estimateMaxNextCost('gpt-5.5', 500_000, undefined, 'official');
    const asCustom = estimateMaxNextCost('gpt-5.5', 500_000, undefined, 'custom');
    expect(asOfficial).toBe(estimateMaxNextCost('gpt-5.5', 128_000)); // clamped to the ceiling
    expect(asCustom).toBeGreaterThan(asOfficial); // …and the gateway is priced for what it can actually emit
    expect(asCustom).toBe(estimateMaxNextCost('gpt-5.5', 500_000, undefined, 'custom'));
  });
});

describe('estimateMediaCost (1.AF/D17 — pre-egress per-modality media estimate)', () => {
  it('adds no estimate for a real model, and NAMES why (ADR-0089 §4)', () => {
    // REPLACES "degrades to 0 for a real model (no row carries a media rate in 1.AF)", which asserted only the
    // 0. The 0 is still correct — nothing is fabricated, and the H4 allow-degrade still holds on the non-strict
    // path — but a bare 0 is exactly what let a strict cap admit paid generation (`CR-55`). The estimate now
    // says which modalities it could not price, and the governor decides the policy.
    expect(
      estimateMediaCost('gemini-2.5-flash', [
        { modality: 'image', units: 4 },
        { modality: 'audio', units: 30 },
      ]),
    ).toEqual({ microcents: 0, unpricedModalities: ['image', 'audio'] });
  });

  it('an empty estimate is 0 with no gap — nothing was requested, so nothing is missing', () => {
    expect(estimateMediaCost('claude-opus-4-8', [])).toEqual({
      microcents: 0,
      unpricedModalities: [],
    });
  });

  it('names an unrated modality even at ZERO estimated units — the entry is the request, not the volume', () => {
    // REPLACES 'a zero-unit entry is not a gap (the estimate must not cry wolf on volume nobody asked for)',
    // which pinned the wrong reading. An entry reaches this function only because a node's `output_modalities`
    // asked for that modality; the COUNT is a configured guess (`[defaults].media_cost_estimate`), and that key
    // is `nonNegativeInt` — so `media_cost_estimate = { video = 0 }` in a git-committable `project.toml` made
    // the gap vanish and silently disabled `strict_cost_cap` for video output.
    //
    // The realized fold's `units === 0` guard is NOT the same rule and must not be unified with this one: there,
    // zero means the provider produced nothing, so an absent rate genuinely is not a gap.
    expect(estimateMediaCost('claude-opus-4-8', [{ modality: 'video', units: 0 }])).toEqual({
      microcents: 0,
      unpricedModalities: ['video'],
    });
  });

  it('a zero-unit entry on a RATED modality still contributes no cost', () => {
    // The other half of the rule above: once a rate EXISTS there is no gap to report, and a zero volume simply
    // multiplies to nothing. Without this, the fix could have been "always report every modality", which would
    // make the notice fire on every priced media turn.
    const overlay: ReadonlyMap<string, ModelPricing> = new Map([
      [
        'rated-video',
        {
          provider: 'openai',
          nativeId: 'rated-video',
          displayName: 'Rated Video',
          contextWindowTokens: 1_000,
          maxOutputTokens: 1_000,
          inputPerMtokMicrocents: 0,
          outputPerMtokMicrocents: 0,
          cachedInputPerMtokMicrocents: 0,
          mediaOutputRates: { video: 9_999 },
        },
      ],
    ]);
    expect(estimateMediaCost('rated-video', [{ modality: 'video', units: 0 }], overlay)).toEqual({
      microcents: 0,
      unpricedModalities: [],
    });
  });

  it('throws UnknownModelError for an unlisted model (the governor catches it → degrade-to-allow)', () => {
    expect(() => estimateMediaCost('not-a-real-model', [{ modality: 'image', units: 1 }])).toThrow(
      'unknown model id',
    );
  });
});

describe('user-pricing overlay (2.5.G S10, ADR-0065 §2)', () => {
  const OVERLAY: ReadonlyMap<string, ModelPricing> = new Map([
    [
      'acme-custom-1',
      {
        provider: 'openai',
        nativeId: 'acme-custom-1',
        displayName: 'Acme Custom 1',
        contextWindowTokens: 32_000,
        maxOutputTokens: 4_000,
        inputPerMtokMicrocents: 300_000_000,
        outputPerMtokMicrocents: 900_000_000, // $9/MTok
        cachedInputPerMtokMicrocents: 0,
      },
    ],
  ]);

  it('estimateMaxNextCost prices a user-priced unknown model via the overlay', () => {
    // 10_000 output tokens @ $9/MTok (900_000_000µ¢/MTok) = 10_000 × 900 = 9_000_000µ¢ — so
    // `max_cost_microcents` can pre-egress-block it (the acceptance: the cost-cap gap is closed).
    expect(estimateMaxNextCost('acme-custom-1', 10_000, OVERLAY)).toBe(9_000_000);
  });

  it('estimateMaxNextCost still throws for an id in neither tier (governor → degrade-to-allow)', () => {
    expect(() => estimateMaxNextCost('not-anywhere', 10_000, OVERLAY)).toThrow('unknown model id');
  });

  it('estimateMediaCost accepts the overlay (a user row with no media rate is a named gap, never a throw)', () => {
    expect(estimateMediaCost('acme-custom-1', [{ modality: 'image', units: 4 }], OVERLAY)).toEqual({
      microcents: 0,
      unpricedModalities: ['image'],
    });
  });
});
