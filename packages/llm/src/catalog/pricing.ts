import type { ModelPricing } from '../pricing.js';

import type { CatalogModel } from './catalog-model.js';
import { catalogModel } from './lookup.js';
import { CATALOG_SNAPSHOT } from './snapshot.js';

/**
 * The catalog, read as a **price** ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §1).
 *
 * `ModelPricing` survives the swap because it is a **contract**, not a table: the `CostTracker` bills against it,
 * the pre-egress governor estimates against it, and a user's `models pricing` row IS one (`PricingOverlay`). What
 * dies is the hand-typed `MODEL_PRICING` object that used to be its only source — twelve rows, maintained by hand,
 * that had already drifted from reality on two numbers before anything thought to compare them.
 *
 * Three fields the catalog cannot supply, and what happens to each:
 *
 * - **`nativeId`** — the provider-native id. Every row in the retired table set it equal to its own key, because
 *   the canonical id IS the provider's id; there was never a second name. The catalog key is that id.
 * - **`mediaOutputRates`** — per-modality media rates. The retired table declared the field and **no row ever set
 *   it**: media folds at 0 until a verified rate lands, and a fabricated rate is worse than none (ADR-0044 §3).
 *   A USER row can still carry one, which is the only way one has ever been carried.
 * - **`deprecatedAt`** — a provider's retirement announcement. models.dev does not publish it, and it is not a
 *   fact about the model that any data source we have exposes. It now comes from the **live provider list** alone
 *   (ADR-0064 §7 already unions a live deprecation date), which is the honest answer: the provider is the only one
 *   who knows when the provider is retiring something. See the ADR-0071 amendment.
 */
export function catalogPricing(modelId: string): ModelPricing | undefined {
  const entry = catalogModel(modelId);
  return entry === undefined ? undefined : toPricing(entry);
}

/** Project one catalog row onto the pricing contract. Pure — no lookup, so a caller with the row in hand can reuse it. */
export function toPricing(entry: CatalogModel): ModelPricing {
  return {
    provider: entry.provider,
    nativeId: entry.modelId, // the canonical id IS the provider's id — there was never a second name
    displayName: entry.displayName,
    contextWindowTokens: entry.contextWindowTokens,
    maxOutputTokens: entry.maxOutputTokens,
    inputPerMtokMicrocents: entry.inputPerMtokMicrocents,
    outputPerMtokMicrocents: entry.outputPerMtokMicrocents,
    // A provider that does not discount cache reads publishes no rate; the contract says 0, which bills a cached
    // read at the full input price — the same thing the retired table did for those providers.
    cachedInputPerMtokMicrocents: entry.cachedInputPerMtokMicrocents ?? 0,
    ...(entry.cacheWritePerMtokMicrocents === undefined
      ? {}
      : { cacheWritePerMtokMicrocents: entry.cacheWritePerMtokMicrocents }),
    // `reasoning` was a BOOLEAN on the retired contract, and answering it was the bug (ADR-0071 §6): "does this
    // model reason" is not the question the wire asks. The catalog carries the CONTROL — which tiers, in which
    // shape — and `effortTiersFor` is what every surface asks now. The boolean is not projected, because nothing
    // should ever ask it again.
  };
}

/** Every model id the catalog prices — the diagnostic list an `UnknownModelError` names. */
export const PRICED_MODEL_IDS: readonly string[] = Object.keys(CATALOG_SNAPSHOT);
