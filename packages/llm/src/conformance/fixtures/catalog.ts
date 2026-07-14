import type { CatalogModel } from '../../catalog/catalog-model.js';

/**
 * A minimal, well-formed {@link CatalogModel} row for a test that needs to INSTALL one (via
 * `installCatalogRefresh`) rather than lean on the shipped snapshot — the per-model capability gates, the
 * alias↔dated-pin scoping tests, and the adapter request-building tests all do.
 *
 * The defaults are only there to be valid: a positive price on BOTH sides (the refresh floor rejects a `0` on
 * either — an unpriced row is not an enrichment), a real context/output window, and a display name. No test asserts
 * on them; every one that cares overrides the field it cares about. `provider` defaults to `openai` and is the
 * override each adapter's suite passes.
 *
 * Lives under `src/conformance/` because that path is EXCLUDED from `tsconfig.build.json` — a test-only helper must
 * not ship in the published `dist`.
 */
export function catalogModelFixture(
  over: Partial<CatalogModel> & Pick<CatalogModel, 'modelId'>,
): CatalogModel {
  return {
    provider: 'openai',
    displayName: over.modelId,
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    inputPerMtokMicrocents: 1_000_000,
    outputPerMtokMicrocents: 2_000_000,
    ...over,
  };
}
