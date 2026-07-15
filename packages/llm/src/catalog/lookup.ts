import type { ReasoningEffort } from '@relavium/shared';

import { acceptedTiers } from '../reasoning-wire.js';

import type { CatalogModel, RequestCapabilities } from './catalog-model.js';
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
 * The **additive-admission gate** (ADR-0071 §4, ADR-0072 point 3) — **additive only, and the shipped snapshot is
 * the FLOOR.** Returns the subset of `models` that may be installed as the refreshed overlay.
 *
 * A refresh only ADDS models the snapshot never carried — it **never** touches a shipped model, not even to enrich
 * it (ADR-0071 §9: a change to an already-shipped row is a human decision, surfaced as a red CI check, never a
 * silent runtime write). So a row is taken ONLY when the snapshot does not carry the model at all AND the refreshed
 * row is priced on both sides: a malformed, truncated, or half-fetched payload degrades to the snapshot rather than
 * to a blank catalog, and a model that was priced yesterday cannot become unpriced today because a third-party
 * aggregator had a bad deploy. The cost cap is a safety control; it does not get to lapse because someone else's
 * JSON changed.
 *
 * This is a **pure** function typed over {@link CatalogModel} (never a DB row type), so BOTH the in-memory overlay
 * install ({@link installCatalogRefresh}) and the host DB writer call the SAME gate — the dependency direction stays
 * `apps/cli → @relavium/llm`, never the reverse, and the two paths admit the identical set from the same input
 * (ADR-0072 point 3 / the parity test).
 */
export function admitRefreshedModels(
  models: Readonly<Record<string, CatalogModel>>,
): Readonly<Record<string, CatalogModel>> {
  const kept: Record<string, CatalogModel> = {};
  for (const [id, model] of Object.entries(models)) {
    // (a) SNAPSHOT-MEMBERSHIP EXCLUSION — a model the SHIPPED snapshot pins is NEVER touched, and the exclusion keys
    // on COMPILE-TIME `CATALOG_SNAPSHOT` membership, NOT a mutable DB `origin` column (ADR-0072 point 3a). The
    // snapshot's price is human-verified, and a runtime refresh does not get to move it (ADR-0071 §9). THIS is the
    // floor §4.2 promises, airtight for the reason that matters: the refresh cannot make a known model cheaper,
    // because it does not write one. Keying on `origin` instead would be a trap — a long-tail id promoted INTO a
    // later snapshot could still be shadowed by its stale `origin='refreshed'` DB row before a reseed flips it.
    //
    // The first version of this was a bug wearing a floor's comment. It read `if (shipped === undefined ||
    // model.output > 0)` — but the line above had already dropped every `output <= 0`, so the second clause was
    // ALWAYS true and the whole guard was `if (true)`. A refreshed row replaced its shipped row wholesale: a moved
    // (lower) price, a dropped context tier, fewer reasoning tiers all sailed through. A hostile — or simply
    // typo'd — upstream `output: 0.00000001` on `gpt-5.5` recorded $14.50 of real spend as $0.00, and a cost cap of
    // any value never tripped. The safety control the ADR exists to build, defeated by the code that builds it.
    if (CATALOG_SNAPSHOT[id] !== undefined) continue;
    // (b) FINITE-AND-POSITIVE base price. A NEW model — the long tail the snapshot does not carry — is admitted only
    // if it carries a real price on BOTH sides: an unpriceable row is not an enrichment, and a priced-maybe-wrong
    // new model is still strictly better than an unknown one (which degrades the cap to `allow` entirely). The
    // FINITE check comes FIRST and is load-bearing (ADR-0072 point 3b): `NaN <= 0` is `false`, so a torn or
    // NaN-coerced money value crossing the DB boundary would slip a bare `<= 0` guard and propagate `NaN` into the
    // governor. Guarding only OUTPUT (the original bug) let an `input: 0` model in with input billed FREE.
    const { inputPerMtokMicrocents: input, outputPerMtokMicrocents: output } = model;
    if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) continue;
    kept[id] = model;
  }
  return kept;
}

/**
 * Install a refreshed catalog into the module-state overlay (ADR-0071 §4), through the shared
 * {@link admitRefreshedModels} gate. Returns the count ACTUALLY admitted (new, priced, not shadowing a shipped id).
 */
export function installCatalogRefresh(models: Readonly<Record<string, CatalogModel>>): number {
  const kept = admitRefreshedModels(models);
  refreshed = kept;
  // The count of models ACTUALLY admitted — new, priced, and not shadowing a shipped id. The host reports this as
  // `added`, and returning it here is what keeps that number honest: computing it host-side by re-applying the
  // gate's predicates by hand is exactly how a report drifts from what got installed (a payload with one priced
  // and one unpriced new model reported `added: 2` while only one landed).
  return Object.keys(kept).length;
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
 * Does **this model** accept a given request PARAMETER (ADR-0071 amendment)? `temperature`, `tool_call`,
 * `structured_output` and `attachment` vary per model within a provider, so an adapter must ask the catalog before
 * it puts the parameter on the wire — sending one a model rejects (e.g. `temperature` on `gpt-5.6-luna`) is a 400.
 *
 * `true` unless the catalog explicitly says `false`: an un-described model (custom `base_url`, brand-new id) or one
 * with no capability data is assumed to ACCEPT the parameter — the same degrade-to-supported default the rest of
 * the catalog uses, so we never withhold a parameter a model actually takes on the strength of missing metadata.
 */
export function modelAccepts(modelId: string, param: keyof RequestCapabilities): boolean {
  return catalogModel(modelId)?.requestCapabilities?.[param] !== false;
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
