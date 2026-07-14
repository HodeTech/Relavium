import { afterEach, describe, expect, it } from 'vitest';

import { cost } from '../cost-tracker.js';

import type { CatalogModel } from './catalog-model.js';
import {
  catalogModel,
  catalogModelIds,
  clearCatalogRefresh,
  installCatalogRefresh,
  modelAccepts,
} from './lookup.js';
import { CATALOG_SNAPSHOT } from './snapshot.js';

/**
 * The runtime catalog overlay (ADR-0071 §4). The refresh is installed as module state; these tests own the floor
 * that keeps it from making the product worse than the shipped snapshot.
 *
 * They live HERE, in `@relavium/llm`, and not in the CLI's `catalog-refresh.test.ts`, on purpose: the CLI test
 * imports `installCatalogRefresh` across the package boundary (from the built `dist`), so a break in this source
 * would not fail it until a rebuild — the exact stale-artifact trap that makes a break-verification lie. Tested at
 * the source, a broken floor fails immediately.
 */

afterEach(clearCatalogRefresh); // module state — a leaked refresh would poison every later test in the process

/** A well-formed refreshed row — override what a case cares about. */
function model(partial: Partial<CatalogModel> & Pick<CatalogModel, 'modelId'>): CatalogModel {
  return {
    provider: 'openai',
    displayName: partial.modelId,
    contextWindowTokens: 100_000,
    maxOutputTokens: 10_000,
    inputPerMtokMicrocents: 1_000_000,
    outputPerMtokMicrocents: 2_000_000,
    ...partial,
  };
}

describe('modelAccepts — per-model request-capability, default accepted (ADR-0071 amendment)', () => {
  it('returns false ONLY for a parameter the catalog explicitly marks unsupported', () => {
    installCatalogRefresh({
      'cap-tail': model({
        modelId: 'cap-tail',
        requestCapabilities: { temperature: false, structuredOutput: false },
      }),
    });
    expect(modelAccepts('cap-tail', 'temperature')).toBe(false);
    expect(modelAccepts('cap-tail', 'structuredOutput')).toBe(false);
    expect(modelAccepts('cap-tail', 'toolCall')).toBe(true); // not marked ⇒ accepted
    expect(modelAccepts('cap-tail', 'attachment')).toBe(true);
  });

  it('a model with no capability data, and an UNCATALOGUED id, both accept everything (the safe default)', () => {
    installCatalogRefresh({ 'plain-tail': model({ modelId: 'plain-tail' }) });
    expect(modelAccepts('plain-tail', 'temperature')).toBe(true);
    expect(modelAccepts('some-custom-base-url-model', 'temperature')).toBe(true); // never withhold on missing data
  });
});

describe('installCatalogRefresh — additive only, and the shipped snapshot is the FLOOR', () => {
  it('NEVER touches a shipped model — a priced-but-lower refresh is IGNORED (§9)', () => {
    // The money bug the first cut shipped. The "floor" guard was `if (shipped === undefined || model.output > 0)`,
    // and the line above had already dropped every `output <= 0`, so the second clause was ALWAYS true and the whole
    // thing was `if (true)`: a refreshed row replaced its shipped row wholesale. A hostile — or typo'd — upstream
    // `output: 1 microcent` on `gpt-5.5` then recorded real spend as ~nothing, and the cost cap stopped tripping.
    const shipped = CATALOG_SNAPSHOT['gpt-5.5'];
    expect(shipped).toBeDefined();
    if (shipped === undefined) return;

    installCatalogRefresh({
      'gpt-5.5': model({
        modelId: 'gpt-5.5',
        outputPerMtokMicrocents: 1, // ~free — the cap-defeating price
        inputPerMtokMicrocents: 1,
        contextWindowTokens: 8_000, // a hundredth of the real window
        reasoning: { effortValues: ['high'] }, // one tier, not five
      }),
    });

    // Every field is the SHIPPED one — the refresh did not write it.
    expect(catalogModel('gpt-5.5')).toEqual(shipped);
    // …so a $14.50 turn is still $14.50, not $0.00.
    const billed = cost('gpt-5.5', { inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(billed).toBeGreaterThan(1_000_000_000); // > $10, not the ~$0 the downgrade would have billed
  });

  it('ADDS a model the snapshot never carried — the long tail, which is the point of refreshing', () => {
    expect(catalogModel('gpt-7-tail')).toBeUndefined(); // the premise
    installCatalogRefresh({ 'gpt-7-tail': model({ modelId: 'gpt-7-tail' }) });
    expect(catalogModel('gpt-7-tail')?.outputPerMtokMicrocents).toBe(2_000_000);
    expect(catalogModelIds()).toContain('gpt-7-tail');
    expect(catalogModelIds()).toContain('gpt-5.5'); // …and the snapshot is still all there
  });

  it('does NOT admit a NEW model with no output price — we price a model or we do not carry it', () => {
    installCatalogRefresh({
      'gpt-7-free': model({ modelId: 'gpt-7-free', outputPerMtokMicrocents: 0 }),
    });
    expect(catalogModel('gpt-7-free')).toBeUndefined();
  });

  it('a later refresh REPLACES the earlier one — the overlay is the last install, not a union', () => {
    installCatalogRefresh({ 'gpt-7-a': model({ modelId: 'gpt-7-a' }) });
    installCatalogRefresh({ 'gpt-7-b': model({ modelId: 'gpt-7-b' }) });
    expect(catalogModel('gpt-7-a')).toBeUndefined(); // gone with the previous install
    expect(catalogModel('gpt-7-b')).toBeDefined();
  });

  it('clear drops the refresh — the snapshot answers alone again', () => {
    installCatalogRefresh({ 'gpt-7-tail': model({ modelId: 'gpt-7-tail' }) });
    clearCatalogRefresh();
    expect(catalogModel('gpt-7-tail')).toBeUndefined();
    expect(catalogModel('gpt-5.5')).toEqual(CATALOG_SNAPSHOT['gpt-5.5']);
  });
});
