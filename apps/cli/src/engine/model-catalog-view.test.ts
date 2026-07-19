import type { ModelCatalogListing } from '@relavium/db';
import { CATALOG_SNAPSHOT, catalogPricing, datedPinBase, type ProviderId } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { buildMergedCatalog, buildUserPricing } from './model-catalog-view.js';

/** Two known static anthropic model ids (derived from the registry so the test survives a pricing.ts edit). */
function twoAnthropicIds(): readonly [string, string] {
  const ids = Object.entries(CATALOG_SNAPSHOT)
    .filter(([, pricing]) => pricing.provider === 'anthropic')
    .map(([id]) => id);
  const [present, absent] = ids;
  if (present === undefined || absent === undefined) {
    throw new Error('test precondition: the catalog must carry ≥2 anthropic models');
  }
  return [present, absent];
}
const [MODEL_PRESENT, MODEL_ABSENT] = twoAnthropicIds();

/** The first snapshot model + its provider — guarded (no bare `!`), for the visibility tests. */
function firstSnapshotModel(): { readonly id: string; readonly provider: ProviderId } {
  const [id] = Object.keys(CATALOG_SNAPSHOT);
  const model = id === undefined ? undefined : CATALOG_SNAPSHOT[id];
  if (id === undefined || model === undefined) {
    throw new Error('test precondition: CATALOG_SNAPSHOT must be non-empty');
  }
  return { id, provider: model.provider };
}

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
    cachedInputStated: false,
    isActive: true,
    visible: true,
    ...partial,
  };
}

/** A slug resolver over a fixed UUID→slug map (an unmapped uuid falls back to itself — like the real one). */
function slugResolver(map: Record<string, string>): (uuid: string) => string {
  return (uuid) => map[uuid] ?? uuid;
}

describe('buildMergedCatalog', () => {
  it('seeds the full static registry (minus collapsed alias↔dated-pin duplicates) — never an empty picker', () => {
    const view = buildMergedCatalog({ rows: [], providerSlug: slugResolver({}), now: 0 });
    // Every static model is seeded EXCEPT an Anthropic dated pin whose rolling alias is also shipped — the pair
    // collapses to the alias for the picker (ADR-0064 amendment). Derive the expected drop from the snapshot so the
    // count stays correct as the catalog grows, and assert it is non-zero so the dedup is actually exercised.
    const collapsed = Object.values(CATALOG_SNAPSHOT).filter((m) => {
      if (m.provider !== 'anthropic') return false;
      const base = datedPinBase(m.modelId);
      return base !== undefined && CATALOG_SNAPSHOT[base]?.provider === 'anthropic';
    }).length;
    expect(collapsed).toBeGreaterThan(0); // the shipped snapshot HAS such pairs — the assertion is meaningful
    expect(view.entries).toHaveLength(Object.keys(CATALOG_SNAPSHOT).length - collapsed);
    // …and NO surviving row is a collapsed dated pin.
    expect(
      view.entries.some(
        (e) =>
          e.provider === 'anthropic' &&
          datedPinBase(e.modelId) !== undefined &&
          CATALOG_SNAPSHOT[datedPinBase(e.modelId) ?? '']?.provider === 'anthropic',
      ),
    ).toBe(false);
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

  it('HIDES a model whose row is visible=false — a HARD filter, distinct from the dim rule (ADR-0072 point 4)', () => {
    const view = buildMergedCatalog({
      rows: [
        row({ modelId: MODEL_PRESENT, providerId: 'p-anthropic', source: 'live', visible: false }),
        row({ modelId: MODEL_ABSENT, providerId: 'p-anthropic', source: 'live' }),
      ],
      providerSlug: slugResolver({ 'p-anthropic': 'anthropic' }),
      now: 0,
    });
    const ids = view.entries.map((e) => e.modelId);
    // The hidden model is GONE entirely — not merely dimmed (which is what an UNavailable model gets)…
    expect(ids).not.toContain(MODEL_PRESENT);
    // …while a still-visible model of the same provider remains in the list.
    expect(ids).toContain(MODEL_ABSENT);
  });

  it('the hard filter is TIER-INDEPENDENT — a visible=false row hides even a STATIC (snapshot) model', () => {
    // A snapshot model is seeded by the static tier regardless of input rows; a `visible=false` row (mapped to the
    // model's real provider) must still hide it, proving the filter is built from ALL rows, not just live ones.
    const { id, provider } = firstSnapshotModel();
    const view = buildMergedCatalog({
      rows: [row({ modelId: id, providerId: 'p-s', source: 'static', visible: false })],
      providerSlug: slugResolver({ 'p-s': provider }),
      now: 0,
    });
    expect(view.entries.map((e) => e.modelId)).not.toContain(id);
  });

  it('is PROVIDER-ANCHORED — hiding a modelId under a DIFFERENT provider does NOT hide the entry (ADR-0065 §6)', () => {
    // `visible` is per (provider_id, model_id), and an id can be reused across providers. A `visible=false` row for
    // a DIFFERENT provider than the one the entry carries must leave the entry visible — else hiding one provider's
    // model would silently drop another's same-id model. (`source: 'static'` so no competing live entry is created.)
    const { id, provider } = firstSnapshotModel();
    const wrong = provider === 'openai' ? 'gemini' : 'openai';
    const view = buildMergedCatalog({
      rows: [row({ modelId: id, providerId: 'p-wrong', source: 'static', visible: false })],
      providerSlug: slugResolver({ 'p-wrong': wrong }),
      now: 0,
    });
    expect(view.entries.map((e) => e.modelId)).toContain(id); // survives — the hide named a different provider
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
          cachedInputStated: true,
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

/**
 * A USER OVERRIDE OF A MODEL THE CATALOG KNOWS (ADR-0071 §1) — the case the whole precedence flip is FOR, and the
 * one this file never tested. Every fixture above prices a model the catalog has never heard of (`acme-custom-1`,
 * `no-limits`, `shared-id`), which is what the user tier was originally invented for and is no longer all it does.
 *
 * Three defects lived in exactly this gap, and a Sonnet review found all three: a partial override zeroed the
 * catalog's limits, its cache rate and its context tiers; a cache hit could cost FIVE TIMES a cache miss; and a row
 * whose provider contradicted the catalog was billed by the cost path while the picker showed the catalog's price.
 */
describe('a user override of a CATALOG model — a partial override must stay partial', () => {
  const OPENAI = 'uuid-openai';
  const slugs = slugResolver({ [OPENAI]: 'openai' });
  // `undefined` when the model / field is UNKNOWN — kept distinct from a real `0` (an explicitly-free rate), so a
  // caller cannot silently divide by a coerced zero and read "unknown" as "free".
  const catalogRate = (
    id: string,
    field: 'inputPerMtokMicrocents' | 'cachedInputPerMtokMicrocents',
  ): number | undefined => catalogPricing(id)?.[field];

  it('INHERITS the window, the ceiling and the cache DISCOUNT that the user never stated', () => {
    // `models pricing gpt-5.5 --input 0.10 --output 1` — two flags, and nothing else said. The DB's columns are NOT
    // NULL DEFAULT 0, so the window, the ceiling and the cache rate all arrive here as zeroes.
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'gpt-5.5',
          providerId: OPENAI,
          source: 'user',
          inputCostPerMtokMicrocents: 10_000_000, // $0.10/MTok — a negotiated rate
          outputCostPerMtokMicrocents: 100_000_000,
        }),
      ],
      providerSlug: slugs,
    });
    const mine = overlay.get('gpt-5.5');
    expect(mine).toBeDefined();
    if (mine === undefined) return;

    // The limits come from the catalog — the picker showed a 0-token context window for GPT-5.5 before this.
    expect(mine.contextWindowTokens).toBe(1_050_000);
    expect(mine.maxOutputTokens).toBe(128_000);

    // The cache rate is the catalog's DISCOUNT, not its absolute number. Inheriting the absolute $0.50 against a
    // $0.10 input would have made a cache HIT cost five times a cache MISS — a price nobody has ever been charged.
    const cachedRate = catalogRate('gpt-5.5', 'cachedInputPerMtokMicrocents');
    const inputRate = catalogRate('gpt-5.5', 'inputPerMtokMicrocents');
    // A known priced model — assert both rates are REAL so a lost/unknown price fails loudly here, rather than
    // silently producing a 0 ratio (the unknown-vs-zero distinction the helper now preserves).
    expect(cachedRate).toBeGreaterThan(0);
    expect(inputRate).toBeGreaterThan(0);
    const ratio = (cachedRate ?? 0) / (inputRate ?? 1);
    expect(mine.cachedInputPerMtokMicrocents).toBe(Math.round(10_000_000 * ratio));
    expect(mine.cachedInputPerMtokMicrocents).toBeLessThanOrEqual(mine.inputPerMtokMicrocents);
  });

  it('BELIEVES an explicit `--cached 0` — a stored zero means free only when the user said so', () => {
    // One money column cannot hold both "the user typed 0" and "the user said nothing"; the FACT of the statement
    // rides in its own flag (migration 0011). Without it, a self-hosted endpoint with a genuinely free cache could
    // never be described — the zero was read as "unset" and silently replaced with the full input rate.
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'gpt-5.5',
          providerId: OPENAI,
          source: 'user',
          inputCostPerMtokMicrocents: 10_000_000,
          outputCostPerMtokMicrocents: 100_000_000,
          cachedInputCostPerMtokMicrocents: 0,
          cachedInputStated: true, // they typed `--cached 0`
        }),
      ],
      providerSlug: slugs,
    });
    expect(overlay.get('gpt-5.5')?.cachedInputPerMtokMicrocents).toBe(0);
  });

  it('KEEPS the context tiers — as multipliers, so a long prompt still costs more', () => {
    // A tiered model is tiered whoever is paying. Dropping the tiers because the user stated a flat price reopens
    // the silent 2× under-bill on every long-context turn — the exact hole the tiers were wired up to close.
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'gemini-2.5-pro',
          providerId: 'uuid-gemini',
          source: 'user',
          inputCostPerMtokMicrocents: 100_000_000, // $1/MTok
          outputCostPerMtokMicrocents: 800_000_000,
        }),
      ],
      providerSlug: slugResolver({ 'uuid-gemini': 'gemini' }),
    });
    const mine = overlay.get('gemini-2.5-pro');
    const shipped = catalogPricing('gemini-2.5-pro');
    expect(shipped?.contextTiers?.[0]?.aboveContextTokens).toBe(200_000); // the premise

    const tier = mine?.contextTiers?.[0];
    expect(tier?.aboveContextTokens).toBe(200_000);
    // The catalog DOUBLES input above the threshold. So does the user's price — the multiple is a fact about the
    // model; the absolute $2.50 is a fact about a price the user is no longer paying.
    const multiple =
      (shipped?.contextTiers?.[0]?.inputPerMtokMicrocents ?? 0) /
      (shipped?.inputPerMtokMicrocents ?? 1);
    expect(tier?.inputPerMtokMicrocents).toBe(Math.round(100_000_000 * multiple));
    expect(tier?.inputPerMtokMicrocents).toBeGreaterThan(mine?.inputPerMtokMicrocents ?? 0);
  });

  it('DROPS a row whose provider contradicts the catalog — the merge already did, the cost path did not', () => {
    // The sharpest hole the flip opened. `mergeModelCatalog` dropped a cross-provider row (so the picker kept showing
    // the catalog's price and said `pricingSource: 'catalog'`), while `priceModel` read the overlay unconditionally
    // and BILLED it. One command could zero a shipped model's cost while the UI displayed $5/MTok.
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'gpt-5.5', // OpenAI's model…
          providerId: 'uuid-anthropic', // …priced under Anthropic
          source: 'user',
          inputCostPerMtokMicrocents: 1,
          outputCostPerMtokMicrocents: 1,
        }),
      ],
      providerSlug: slugResolver({ 'uuid-anthropic': 'anthropic' }),
    });
    expect(overlay.has('gpt-5.5')).toBe(false); // …and it is not billed
  });

  it('a model the catalog does NOT know has nothing to inherit — its cache read still is not free', () => {
    const overlay = buildUserPricing({
      rows: [
        row({
          modelId: 'acme-local-1',
          providerId: OPENAI,
          source: 'user',
          inputCostPerMtokMicrocents: 300_000_000,
          outputCostPerMtokMicrocents: 900_000_000,
        }),
      ],
      providerSlug: slugs,
    });
    const mine = overlay.get('acme-local-1');
    expect(mine?.cachedInputPerMtokMicrocents).toBe(300_000_000); // the input rate, not zero
    expect(mine?.contextTiers).toBeUndefined();
  });
});
