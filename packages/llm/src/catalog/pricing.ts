import type { ModelPricing } from '../pricing.js';

import type { CatalogModel } from './catalog-model.js';
import { catalogModel, catalogModelIds } from './lookup.js';

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
 * - **`deprecatedAt`** — a provider's retirement announcement. models.dev publishes a `status` FLAG, not a date, and
 *   a flag cannot tell a user *"this stops working in eleven days"*. It lives in Relavium's own small overlay
 *   ({@link MODEL_DEPRECATIONS}), which ADR-0071 §10 always specified and the first cut of this swap wrongly deleted:
 *   the theory was that the live provider list would carry it, but **no adapter populates `ModelListing.deprecatedAt`**
 *   (the OpenAI list is id-only), so `deprecated` went permanently `false` for every model in the product.
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
    // ABSENT ⇒ THE FULL INPUT RATE. Never 0 (ADR-0071 §10, which exists because of exactly this line).
    //
    // The first version wrote `?? 0` with a comment claiming that 0 "bills a cached read at the full input price".
    // It does not. `cost()` computes `cacheReadTokens × rate / 1e6`, so 0 bills the cached fraction of every prompt
    // at NOTHING — and eleven catalog models publish no cache rate, including `gpt-5.4-pro` and `o1-pro`. OpenAI
    // auto-caches, so on a 1M-token prompt that is 90% cached, `o1-pro` billed $0.00 for 900 000 tokens that cost
    // $135. Worse than a wrong invoice: `max_cost_microcents` is a SAFETY control, and it cannot trip on money it
    // never counts.
    //
    // "No published cache rate" means the provider does not DISCOUNT cache reads, not that it gives them away. The
    // full input rate is the honest reading, and it is the one the ADR wrote down before the code got it wrong.
    cachedInputPerMtokMicrocents:
      entry.cachedInputPerMtokMicrocents ?? entry.inputPerMtokMicrocents,
    ...(entry.cacheWritePerMtokMicrocents === undefined
      ? {}
      : { cacheWritePerMtokMicrocents: entry.cacheWritePerMtokMicrocents }),
    // The context tiers ride onto the contract (ADR-0071 §11). They were parsed, guarded and exported — and read by
    // nothing, so a >200k `gemini-2.5-pro` turn billed at the CHEAP rate. Tolerable while those models threw
    // `UnknownModelError` (a loud gap); a silent 2× under-bill the moment the catalog started pricing them.
    ...(entry.contextTiers === undefined ? {} : { contextTiers: entry.contextTiers }),
    // `reasoning` was a BOOLEAN on the retired contract, and answering it was the bug (ADR-0071 §6): "does this
    // model reason" is not the question the wire asks. The catalog carries the CONTROL — which tiers, in which
    // shape — and `effortTiersFor` is what every surface asks now. The boolean is not projected, because nothing
    // should ever ask it again.
  };
}

/**
 * Every model id we can price — the diagnostic list an `UnknownModelError` names.
 *
 * A FUNCTION, not a const: a `models refresh --catalog` adds models, and a constant captured at import time would go
 * on naming yesterday's list in the error that tells a user which models exist.
 */
export function pricedModelIds(): readonly string[] {
  return catalogModelIds();
}
