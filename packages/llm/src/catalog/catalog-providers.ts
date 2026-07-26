import { LLM_PROVIDERS } from '@relavium/shared';

import type { ProviderId } from '../types.js';

/**
 * Relavium's {@link ProviderId} → the provider's key in the upstream metadata catalog
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §2).
 *
 * **The ONLY place the two vocabularies meet.** Everything downstream — the sync tool, the merge, the picker —
 * iterates {@link LLM_PROVIDERS} rather than a literal list, so **adding a provider is one line here**, not a
 * rewrite (see the `add-llm-adapter` skill, step 5).
 *
 * Two traps this table closes, both of which cost real money if missed:
 *
 *   • **`gemini` ≠ `google`.** Upstream keys Gemini as `google`. A hand-written `provider === 'gemini'` lookup
 *     against the raw payload silently finds nothing — every Gemini model would arrive UNPRICED, and an unpriced
 *     model skips the ADR-0028 cost cap entirely. The typed `Record<ProviderId, string>` makes the mapping
 *     exhaustive: a new `ProviderId` is a **compile error** here until it is mapped.
 *   • **`google-vertex` is NOT imported.** It republishes the same Gemini ids at *different* prices. A naive
 *     flatten over every upstream provider would register each Gemini model twice, and the second write would
 *     win — pricing the user's Gemini traffic at Vertex rates. Only the mapped key is ever read; the other
 *     ~162 upstream providers are dropped, because Relavium cannot call them at all.
 */
export const CATALOG_PROVIDER_KEYS: Record<ProviderId, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  deepseek: 'deepseek',
};

/**
 * The upstream keys we import, in {@link LLM_PROVIDERS} order — what the sync tool iterates.
 * Derived, never hand-listed, so it cannot drift from the enum.
 */
export const CATALOG_UPSTREAM_KEYS: readonly string[] = LLM_PROVIDERS.map(
  (id) => CATALOG_PROVIDER_KEYS[id],
);

/** The {@link ProviderId} an upstream key maps back to, or `undefined` for a provider we have no adapter for. */
export function providerIdForCatalogKey(upstreamKey: string): ProviderId | undefined {
  return LLM_PROVIDERS.find((id) => CATALOG_PROVIDER_KEYS[id] === upstreamKey);
}
