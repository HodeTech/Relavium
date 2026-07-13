import type { CatalogModel } from './catalog-model.js';
import { CATALOG_SNAPSHOT } from './snapshot.js';

/**
 * Look up a model's metadata in the shipped catalog
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md)).
 *
 * `undefined` for an id the catalog does not carry — a brand-new model, or one behind a custom `base_url`. That
 * is a **supported** state, not an error: such a model is simply unpriced and un-described, and every consumer
 * degrades the same way (the cost cap flags it; the reasoning field is withheld rather than guessed at).
 *
 * The adapters read this directly, which is not a new coupling: they already imported `MODEL_PRICING` for the
 * same purpose. What changes is only that the answer is now generated and per-model, instead of hand-typed and
 * per-provider.
 */
export function catalogModel(modelId: string): CatalogModel | undefined {
  return CATALOG_SNAPSHOT[modelId];
}
