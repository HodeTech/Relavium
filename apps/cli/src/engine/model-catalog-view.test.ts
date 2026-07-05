import type { ModelCatalogListing } from '@relavium/db';
import { MODEL_PRICING } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { buildMergedCatalog } from './model-catalog-view.js';

/** Two known static anthropic model ids (derived from the registry so the test survives a pricing.ts edit). */
function twoAnthropicIds(): readonly [string, string] {
  const ids = Object.entries(MODEL_PRICING)
    .filter(([, pricing]) => pricing.provider === 'anthropic')
    .map(([id]) => id);
  const [present, absent] = ids;
  if (present === undefined || absent === undefined) {
    throw new Error('test precondition: MODEL_PRICING must carry ≥2 anthropic models');
  }
  return [present, absent];
}
const [MODEL_PRESENT, MODEL_ABSENT] = twoAnthropicIds();

/** A `model_catalog` row with sensible non-secret defaults; override what a case cares about. */
function row(
  partial: Pick<ModelCatalogListing, 'modelId' | 'providerId' | 'source'> &
    Partial<ModelCatalogListing>,
): ModelCatalogListing {
  return {
    displayName: partial.modelId,
    inputCostPerMtokMicrocents: 0,
    outputCostPerMtokMicrocents: 0,
    cachedInputCostPerMtokMicrocents: 0,
    isActive: true,
    ...partial,
  };
}

/** A slug resolver over a fixed UUID→slug map (an unmapped uuid falls back to itself — like the real one). */
function slugResolver(map: Record<string, string>): (uuid: string) => string {
  return (uuid) => map[uuid] ?? uuid;
}

describe('buildMergedCatalog', () => {
  it('seeds the full static registry even with no live rows (never an empty picker)', () => {
    const view = buildMergedCatalog({ rows: [], providerSlug: slugResolver({}), now: 0 });
    expect(view.entries.length).toBe(Object.keys(MODEL_PRICING).length);
    expect(view.refreshedAt).toBeUndefined();
    // With NO live data for any provider, every static model falls back to static presence (ADR-0064 §6).
    expect(view.entries.every((e) => e.available)).toBe(true);
  });

  it('a live row makes its provider "have live data": present models stay available, absent ones are dimmed', () => {
    const view = buildMergedCatalog({
      rows: [row({ modelId: MODEL_PRESENT, providerId: 'p-anthropic', source: 'live' })],
      providerSlug: slugResolver({ 'p-anthropic': 'anthropic' }),
      now: 0,
    });
    const present = view.entries.find((e) => e.modelId === MODEL_PRESENT);
    const absent = view.entries.find((e) => e.modelId === MODEL_ABSENT);
    expect(present?.available).toBe(true); // in the live list
    expect(absent?.available).toBe(false); // anthropic HAS live data, and this static id is not in it ⇒ dimmed
  });

  it('reports refreshedAt as the newest lastRefreshedAt across the live rows only', () => {
    const view = buildMergedCatalog({
      rows: [
        row({ modelId: MODEL_PRESENT, providerId: 'p-anthropic', source: 'live', lastRefreshedAt: 100 }),
        row({ modelId: MODEL_ABSENT, providerId: 'p-anthropic', source: 'live', lastRefreshedAt: 300 }),
        // a non-live row's stamp (if any) must NOT count toward freshness
        row({ modelId: 'x', providerId: 'p-anthropic', source: 'user', lastRefreshedAt: 999 }),
      ],
      providerSlug: slugResolver({ 'p-anthropic': 'anthropic' }),
      now: 0,
    });
    expect(view.refreshedAt).toBe(300);
  });

  it('ignores non-live rows for availability — a user/static row does NOT mark the provider as having live data', () => {
    // Only a `user` row for anthropic (no `live` row) ⇒ anthropic has NO live data ⇒ its statics stay available.
    const view = buildMergedCatalog({
      rows: [row({ modelId: MODEL_PRESENT, providerId: 'p-anthropic', source: 'user' })],
      providerSlug: slugResolver({ 'p-anthropic': 'anthropic' }),
      now: 0,
    });
    expect(view.entries.find((e) => e.modelId === MODEL_ABSENT)?.available).toBe(true);
    expect(view.refreshedAt).toBeUndefined();
  });

  it('drops a live row whose provider UUID resolves to a non-enum slug (no throw, no spurious dimming)', () => {
    // An unmapped uuid resolves to itself ('rogue'), which is not a ProviderId ⇒ the row is skipped, so anthropic
    // has NO live data and its statics stay available (the rogue row cannot dim an unrelated provider).
    const view = buildMergedCatalog({
      rows: [row({ modelId: MODEL_PRESENT, providerId: 'rogue', source: 'live', lastRefreshedAt: 50 })],
      providerSlug: slugResolver({}),
      now: 0,
    });
    expect(view.entries.find((e) => e.modelId === MODEL_ABSENT)?.available).toBe(true);
    // The skipped row contributes NOTHING — not availability, and not freshness (the stamp is read only AFTER the
    // slug is validated as a known ProviderId), so a rogue/custom-provider row can never skew the badge.
    expect(view.refreshedAt).toBeUndefined();
  });
});
