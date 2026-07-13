import type { ReasoningEffort } from '@relavium/shared';

import { acceptedTiers } from '../reasoning-wire.js';

import type { CatalogModel } from './catalog-model.js';
import { CATALOG_SNAPSHOT } from './snapshot.js';

/**
 * The REFRESHED catalog, if the host has one — models.dev as of the last `relavium models refresh --catalog`.
 *
 * Module state, and deliberately so. Reading a file is platform work and `@relavium/llm` does none; the host does
 * it and hands the result in as plain data, which is the same seam `keyFor` and the pricing overlay already use.
 * Threading a catalog through every adapter call instead would put a parameter on `contextLimitFor`,
 * `cappedMaxTokens`, `effortTiersFor` and four adapters, for a value that is a process-wide constant.
 *
 * Empty until installed. Nothing must depend on it being installed: with no refresh — which is the DEFAULT
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §4, `auto_refresh = false`)
 * — the shipped snapshot answers everything, offline, exactly as it was designed to.
 */
let refreshed: Readonly<Record<string, CatalogModel>> = {};

/**
 * Install a refreshed catalog (ADR-0071 §4). **Additive only, and the shipped snapshot is the FLOOR.**
 *
 * A refresh may add models the snapshot never carried and enrich ones it left thin — it may **never** leave a model
 * less described than it shipped. So a row is taken only when the snapshot does not have the model at all, or when
 * the refreshed row still carries a price: a malformed, truncated, or half-fetched payload degrades to the snapshot
 * rather than to a blank catalog, and a model that was priced yesterday cannot become unpriced today because a
 * third-party aggregator had a bad deploy. The cost cap is a safety control; it does not get to lapse because
 * someone else's JSON changed.
 */
export function installCatalogRefresh(models: Readonly<Record<string, CatalogModel>>): void {
  const kept: Record<string, CatalogModel> = {};
  for (const [id, model] of Object.entries(models)) {
    const shipped = CATALOG_SNAPSHOT[id];
    // A refreshed row without an output price is not an enrichment, it is a regression — drop it and keep whatever
    // the snapshot said. A model the snapshot never had is admitted on the same test: we price it, or we do not
    // pretend to.
    if (model.outputPerMtokMicrocents <= 0) continue;
    if (shipped === undefined || model.outputPerMtokMicrocents > 0) kept[id] = model;
  }
  refreshed = kept;
}

/** Drop the refreshed catalog — the shipped snapshot answers alone again. For tests, and for `--catalog` failures. */
export function clearCatalogRefresh(): void {
  refreshed = {};
}

/**
 * Look up a model's metadata: the refreshed catalog if the host installed one, else the shipped snapshot
 * ([ADR-0071](../../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md)).
 *
 * `undefined` for an id neither carries — a brand-new model, or one behind a custom `base_url`. That is a
 * **supported** state, not an error: such a model is simply unpriced and un-described, and every consumer degrades
 * the same way (the cost cap flags it; the reasoning field is withheld rather than guessed at).
 *
 * The adapters read this directly, which is not a new coupling: they already imported `MODEL_PRICING` for the same
 * purpose. What changes is only that the answer is generated and per-model, instead of hand-typed and per-provider.
 */
export function catalogModel(modelId: string): CatalogModel | undefined {
  return refreshed[modelId] ?? CATALOG_SNAPSHOT[modelId];
}

/** Every model id we can describe — the snapshot, plus whatever a refresh added. */
export function catalogModelIds(): readonly string[] {
  return [...new Set([...Object.keys(CATALOG_SNAPSHOT), ...Object.keys(refreshed)])];
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
