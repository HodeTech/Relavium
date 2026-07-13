import { describe, expect, it } from 'vitest';

import { catalogPricing, pricedModelIds, toPricing } from './catalog/pricing.js';
import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import { cost } from './cost-tracker.js';
import { estimateMaxNextCost } from './budget-estimator.js';
import { contextWindowForModel } from './pricing.js';

/**
 * `contextWindowForModel` (ADR-0062 §7) — the pure lookup the CLI's context-fullness footer uses without going
 * through the provider seam. It must return the SAME window the adapters' `contextLimit` returns, and `undefined`
 * for a model the catalog does not carry (which degrades the indicator + auto-compaction to "not applicable",
 * never a crash).
 *
 * It read the hand-typed table until ADR-0071 §1, and the table said `gpt-5.5`'s window was 1 000 000 while the
 * generated catalog said 1 050 000 — so the percentage every user saw was computed against a window the model does
 * not have. Nothing compared the two, which is the whole reason there is now only one.
 */
describe('contextWindowForModel (ADR-0062 §7)', () => {
  it('returns the CATALOG window — the one source, never a second opinion about it', () => {
    for (const [id, entry] of Object.entries(CATALOG_SNAPSHOT)) {
      expect(contextWindowForModel(id), id).toBe(entry.contextWindowTokens);
    }
  });

  it('returns a concrete window for a pinned model', () => {
    expect(contextWindowForModel('gpt-5.5')).toBe(1_050_000);
  });

  it('returns undefined for a model the catalog does not carry (a custom base URL)', () => {
    expect(contextWindowForModel('some-custom-base-url-model-xyz')).toBeUndefined();
    expect(contextWindowForModel('')).toBeUndefined();
  });
});

/** The catalog, read as a price (ADR-0071 §1) — what `MODEL_PRICING` used to be, generated instead of typed. */
describe('catalogPricing — the projection that replaced the hand-typed table', () => {
  it('prices every model the catalog carries, and only those', () => {
    expect(pricedModelIds().length).toBe(Object.keys(CATALOG_SNAPSHOT).length);
    expect(pricedModelIds().length).toBeGreaterThan(50); // the retired table had twelve rows
    for (const id of pricedModelIds()) {
      const priced = catalogPricing(id);
      expect(priced, id).toBeDefined();
      expect(priced?.inputPerMtokMicrocents, id).toBeGreaterThanOrEqual(0);
      expect(priced?.outputPerMtokMicrocents, id).toBeGreaterThan(0);
    }
    expect(catalogPricing('a-model-nobody-has-heard-of')).toBeUndefined();
  });

  it("names the model by the catalog's id — there was never a second, `native` name", () => {
    // The retired contract carried a `nativeId` alongside the key, for a provider that called the model something
    // else. No row ever used it: every single one set `nativeId` equal to its own key.
    for (const [id, entry] of Object.entries(CATALOG_SNAPSHOT)) {
      expect(toPricing(entry).nativeId, id).toBe(id);
    }
  });

  it('NEVER bills a cached read at zero — a model with no published cache rate pays the full input rate', () => {
    // The first projection wrote `?? 0`. `cost()` computes `cacheReadTokens × rate / 1e6`, so 0 does not mean
    // "charge the normal rate" — it means CHARGE NOTHING, and eleven catalog models publish no cache rate. OpenAI
    // auto-caches, so the cached fraction of every prompt on `o1-pro` ($150/MTok in) billed at $0.00.
    //
    // Asserted as BEHAVIOUR, not as a restatement of the projection: the previous test compared `toPricing`'s output
    // to `x ?? 0` — the very expression it was testing — so it passed for any projection of the same bug.
    const uncached = Object.entries(CATALOG_SNAPSHOT).filter(
      ([, e]) => e.cachedInputPerMtokMicrocents === undefined,
    );
    expect(uncached.length).toBeGreaterThan(0); // the premise: such models exist

    // 100k cached tokens — deliberately under every context-tier threshold (the lowest is 200k), so this measures
    // the cache-rate fallback and nothing else. A 1M-token read would ALSO cross the tier boundary on the models
    // that have one, and would be measuring two things at once.
    const CACHED = 100_000;
    for (const [id, entry] of uncached) {
      const billed = cost(id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: CACHED });
      expect(billed, id).toBe(Math.round((CACHED * entry.inputPerMtokMicrocents) / 1_000_000));
      expect(billed, id).toBeGreaterThan(0); // the point: NOT zero
    }

    // …and a model that DOES publish a discount still gets it — the fallback is a floor, not a flattening.
    const discounted = Object.entries(CATALOG_SNAPSHOT).find(
      ([, e]) =>
        e.cachedInputPerMtokMicrocents !== undefined &&
        e.cachedInputPerMtokMicrocents < e.inputPerMtokMicrocents &&
        e.contextTiers === undefined,
    );
    expect(discounted).toBeDefined();
    if (discounted === undefined) return;
    const [id, entry] = discounted;
    expect(cost(id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(
      entry.cachedInputPerMtokMicrocents,
    );
  });

  it('prices a LONG prompt at the tier it actually landed in — not the cheap one (ADR-0071 §11)', () => {
    // `gemini-2.5-pro`: $1.25/$10 up to 200k, $2.50/$15 above. The tiers were parsed, guarded and exported — and
    // read by nothing, so every long-context turn billed at half price. That was a tolerable gap while these models
    // threw `UnknownModelError`; it became a silent 2× under-bill the moment the catalog started pricing them.
    const entry = CATALOG_SNAPSHOT['gemini-2.5-pro'];
    expect(entry?.contextTiers?.[0]?.aboveContextTokens).toBe(200_000); // the premise

    const base = entry?.inputPerMtokMicrocents ?? 0;
    const dear = entry?.contextTiers?.[0]?.inputPerMtokMicrocents ?? 0;
    const short = cost('gemini-2.5-pro', { inputTokens: 100_000, outputTokens: 0 });
    const long = cost('gemini-2.5-pro', { inputTokens: 300_000, outputTokens: 0 });
    expect(short).toBe(Math.round((100_000 * base) / 1_000_000)); // under the threshold: the base rate
    expect(long).toBe(Math.round((300_000 * dear) / 1_000_000)); // over it: the ABOVE rate
    expect(long / 3).toBeGreaterThan(short); // …strictly dearer PER TOKEN, which is the under-bill that was live
  });

  it('the pre-egress estimate takes the HIGHEST tier — a cap that under-estimates lets money escape', () => {
    // The estimate cannot know how long the prompt will be (the engine does not tokenize locally). On a SAFETY
    // control, guessing the cheap side is the guess that lets real money out.
    const entry = CATALOG_SNAPSHOT['gemini-2.5-pro'];
    const dearOutput = entry?.contextTiers?.[0]?.outputPerMtokMicrocents ?? 0;
    const baseOutput = entry?.outputPerMtokMicrocents ?? 0;
    expect(dearOutput).toBeGreaterThan(baseOutput); // the premise

    // The ask is also CLAMPED to the model's 65 536-token ceiling (ADR-0071 §7) — the two rules compose, and this
    // pins BOTH: the cap the wire will carry, priced at the tier the estimate must assume.
    const cap = entry?.maxOutputTokens ?? 0;
    expect(estimateMaxNextCost('gemini-2.5-pro', 1_000_000)).toBe(
      Math.round((cap * dearOutput) / 1_000_000),
    );
    // …and it is strictly dearer than the cheap tier would have been — which is the money that used to escape.
    expect(estimateMaxNextCost('gemini-2.5-pro', 1_000_000)).toBeGreaterThan(
      Math.round((cap * baseOutput) / 1_000_000),
    );
  });

  it('does NOT project a reasoning boolean — nothing should ever ask that question again', () => {
    const entry = CATALOG_SNAPSHOT['gpt-5.4-pro'];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect('reasoning' in toPricing(entry)).toBe(false);
  });
});
