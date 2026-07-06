import type { ModelCatalogListing } from '@relavium/db';
import { MODEL_PRICING } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { buildMergedCatalog, buildUserPricing } from './model-catalog-view.js';

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

  it('threads keyedProviders → a model of an UNKEYED provider is unavailable/no-key; a keyed one stays available (2.5.G)', () => {
    // Only openai is keyed; anthropic's static models become no-key even with no live rows.
    const view = buildMergedCatalog({
      rows: [],
      providerSlug: slugResolver({}),
      keyedProviders: new Set(['openai']),
      now: 0,
    });
    const anthropicEntry = view.entries.find((e) => e.provider === 'anthropic');
    expect(anthropicEntry?.available).toBe(false);
    expect(anthropicEntry?.unavailableReason).toBe('no-key');
    const openaiEntry = view.entries.find((e) => e.provider === 'openai');
    expect(openaiEntry?.available).toBe(true);
    expect(openaiEntry?.unavailableReason).toBeUndefined();
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
        row({
          modelId: MODEL_PRESENT,
          providerId: 'p-anthropic',
          source: 'live',
          lastRefreshedAt: 100,
        }),
        row({
          modelId: MODEL_ABSENT,
          providerId: 'p-anthropic',
          source: 'live',
          lastRefreshedAt: 300,
        }),
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
      rows: [
        row({ modelId: MODEL_PRESENT, providerId: 'rogue', source: 'live', lastRefreshedAt: 50 }),
      ],
      providerSlug: slugResolver({}),
      now: 0,
    });
    expect(view.entries.find((e) => e.modelId === MODEL_ABSENT)?.available).toBe(true);
    // The skipped row contributes NOTHING — not availability, and not freshness (the stamp is read only AFTER the
    // slug is validated as a known ProviderId), so a rogue/custom-provider row can never skew the badge.
    expect(view.refreshedAt).toBeUndefined();
  });
});

describe('buildUserPricing (2.5.G S10, ADR-0065 §2)', () => {
  it('projects a source="user" row into a ModelPricing keyed by model id', () => {
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'acme-custom-1',
          providerId: 'p-openai',
          source: 'user',
          inputCostPerMtokMicrocents: 300_000_000,
          outputCostPerMtokMicrocents: 900_000_000,
          cachedInputCostPerMtokMicrocents: 12_345,
          contextWindowTokens: 32_000,
          maxOutputTokens: 4_000,
        }),
      ],
      providerSlug: slugResolver({ 'p-openai': 'openai' }),
    });
    const priced = overlay.get('acme-custom-1');
    expect(priced?.provider).toBe('openai');
    expect(priced?.nativeId).toBe('acme-custom-1');
    expect(priced?.inputPerMtokMicrocents).toBe(300_000_000);
    expect(priced?.outputPerMtokMicrocents).toBe(900_000_000);
    expect(priced?.cachedInputPerMtokMicrocents).toBe(12_345);
    expect(priced?.contextWindowTokens).toBe(32_000);
    expect(priced?.maxOutputTokens).toBe(4_000);
  });

  it('includes ONLY source="user" rows (a live/static row is not a user price)', () => {
    const overlay = buildUserPricing({
      rows: [
        row({ modelId: 'live-model', providerId: 'p-openai', source: 'live' }),
        row({ modelId: 'static-model', providerId: 'p-openai', source: 'static' }),
        row({ modelId: 'user-model', providerId: 'p-openai', source: 'user' }),
      ],
      providerSlug: slugResolver({ 'p-openai': 'openai' }),
    });
    expect([...overlay.keys()]).toEqual(['user-model']);
  });

  it('is DETERMINISTIC on a cross-provider model-id collision — keeps the FIRST row, never last-write-wins', () => {
    // Two user rows for the SAME model id under different providers (reachable via custom base_url on openai vs
    // deepseek). The overlay keys by model id, so it can hold only one — the guard keeps the first, deterministically.
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'shared-id',
          providerId: 'p-openai',
          source: 'user',
          inputCostPerMtokMicrocents: 111,
        }),
        row({
          modelId: 'shared-id',
          providerId: 'p-deepseek',
          source: 'user',
          inputCostPerMtokMicrocents: 999,
        }),
      ],
      providerSlug: slugResolver({ 'p-openai': 'openai', 'p-deepseek': 'deepseek' }),
    });
    expect(overlay.size).toBe(1);
    expect(overlay.get('shared-id')?.inputPerMtokMicrocents).toBe(111); // the FIRST row, not the second (999)
    expect(overlay.get('shared-id')?.provider).toBe('openai');
  });

  it('drops a user row whose provider UUID resolves to a non-enum slug (never injects under a known provider)', () => {
    const overlay = buildUserPricing({
      rows: [row({ modelId: 'rogue-priced', providerId: 'rogue', source: 'user' })],
      providerSlug: slugResolver({}), // 'rogue' → 'rogue', not a ProviderId
    });
    expect(overlay.size).toBe(0);
  });

  it('defaults absent context/output limits to 0 (the "unknown" sentinel) without throwing', () => {
    const overlay = buildUserPricing({
      rows: [row({ modelId: 'no-limits', providerId: 'p-openai', source: 'user' })],
      providerSlug: slugResolver({ 'p-openai': 'openai' }),
    });
    const priced = overlay.get('no-limits');
    expect(priced?.contextWindowTokens).toBe(0);
    expect(priced?.maxOutputTokens).toBe(0);
  });

  it('buildMergedCatalog fills the merge userPricing tier from the user rows (an unknown id becomes priceKnown)', () => {
    const view = buildMergedCatalog({
      rows: [
        row({
          modelId: 'acme-custom-1',
          providerId: 'p-openai',
          source: 'user',
          inputCostPerMtokMicrocents: 300_000_000,
          outputCostPerMtokMicrocents: 900_000_000,
        }),
      ],
      providerSlug: slugResolver({ 'p-openai': 'openai' }),
      now: 0,
    });
    const entry = view.entries.find((e) => e.modelId === 'acme-custom-1');
    expect(entry?.pricingSource).toBe('user');
    expect(entry?.priceKnown).toBe(true);
    expect(entry?.pricing?.inputPerMtokMicrocents).toBe(300_000_000);
  });
});
