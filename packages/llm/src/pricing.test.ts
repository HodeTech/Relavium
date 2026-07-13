import { describe, expect, it } from 'vitest';

import { catalogPricing, PRICED_MODEL_IDS, toPricing } from './catalog/pricing.js';
import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
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
    expect(PRICED_MODEL_IDS.length).toBe(Object.keys(CATALOG_SNAPSHOT).length);
    expect(PRICED_MODEL_IDS.length).toBeGreaterThan(50); // the retired table had twelve rows
    for (const id of PRICED_MODEL_IDS) {
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

  it('never bills a cached read at less than the catalog says', () => {
    // `cachedInputPerMtokMicrocents` is REQUIRED on the contract and OPTIONAL in the catalog, so the projection has
    // to choose a value for a provider that publishes none. 0 is the contract's own "no cache discount" — the same
    // thing the retired table wrote for those providers — and it must never silently under-bill a rate that exists.
    for (const [id, entry] of Object.entries(CATALOG_SNAPSHOT)) {
      const priced = toPricing(entry);
      expect(priced.cachedInputPerMtokMicrocents, id).toBe(entry.cachedInputPerMtokMicrocents ?? 0);
      expect(priced.cachedInputPerMtokMicrocents, id).toBeLessThanOrEqual(
        priced.inputPerMtokMicrocents,
      );
    }
  });

  it('does NOT project a reasoning boolean — nothing should ever ask that question again', () => {
    const entry = CATALOG_SNAPSHOT['gpt-5.4-pro'];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect('reasoning' in toPricing(entry)).toBe(false);
  });
});
