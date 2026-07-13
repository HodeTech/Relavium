import type { ReasoningEffort } from '@relavium/shared';

import { acceptedTiers } from '../reasoning-wire.js';

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

/**
 * The reasoning-effort tiers **this model id** accepts — the ONE predicate every surface must ask.
 *
 * There is exactly one right answer to "can the user set effort on this model, and to what", and it has to be the
 * same answer for the picker, the `/effort` command, the engine's gate, the footer, and the wire. It has not been:
 * the CLI was carrying three separately-written copies of `catalogModel(m)` + `acceptedTiers(...)` plus a fourth,
 * older boolean (`modelSupportsReasoning`, an id heuristic over the hand-typed pricing table) that disagreed with
 * them on sixteen shipped models. Agreement by convention is not agreement; this is the construction that makes
 * divergence impossible.
 *
 * The empty set means "no controllable tier", and it has two distinct causes the caller may want to tell apart:
 * the model is not in the catalog at all (a custom `base_url`, or one newer than our snapshot), or it is and
 * publishes no knob (`deepseek-reasoner`). Both withhold the field; only the first is fixed by a catalog refresh.
 * Use {@link catalogModel} directly to distinguish them.
 */
export function effortTiersFor(modelId: string): ReadonlySet<ReasoningEffort> {
  const entry = catalogModel(modelId);
  return entry === undefined ? new Set() : acceptedTiers(entry.provider, entry.reasoning);
}
