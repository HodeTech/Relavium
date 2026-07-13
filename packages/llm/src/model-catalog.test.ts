import { describe, expect, it } from 'vitest';

import { mergeModelCatalog, type ModelCatalogEntry } from './model-catalog.js';
import { catalogPricing } from './catalog/pricing.js';
import { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
import type { ModelPricing } from './pricing.js';
import type { ModelListing, ProviderId } from './types.js';

// A fixed clock so the deprecation check is deterministic. deepseek-chat/-reasoner deprecate 2026-07-24 15:59Z.
const BEFORE_DEEPSEEK_DEPRECATION = Date.parse('2026-07-05T00:00:00Z');
const AFTER_DEEPSEEK_DEPRECATION = Date.parse('2026-08-01T00:00:00Z');

const byId = (entries: readonly ModelCatalogEntry[], id: string): ModelCatalogEntry | undefined =>
  entries.find((e) => e.modelId === id);

const liveMap = (
  rows: ReadonlyArray<readonly [ProviderId, readonly ModelListing[]]>,
): ReadonlyMap<ProviderId, readonly ModelListing[]> => new Map(rows);

/** A minimal user-supplied ModelPricing (ADR-0065 USER tier — which now OUTRANKS the catalog, ADR-0071 §1). */
const userPricing = (provider: ProviderId): ModelPricing => ({
  provider,
  nativeId: 'x',
  displayName: 'Custom Model',
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000,
  inputPerMtokMicrocents: 100,
  outputPerMtokMicrocents: 200,
  cachedInputPerMtokMicrocents: 10,
});

describe('mergeModelCatalog (ADR-0064 §6)', () => {
  it('with no live/user data, surfaces every CATALOG model as catalog-priced and available', () => {
    const entries = mergeModelCatalog({ now: BEFORE_DEEPSEEK_DEPRECATION });
    expect(entries).toHaveLength(Object.keys(CATALOG_SNAPSHOT).length);
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus).toMatchObject({
      provider: 'anthropic',
      displayName: 'Claude Opus 4.8',
      pricingSource: 'catalog',
      priceKnown: true,
      available: true, // no live data for anthropic -> catalog presence
      deprecated: false,
    });
    expect(opus?.pricing).toEqual(catalogPricing('claude-opus-4-8'));
    expect(opus?.contextWindowTokens).toBe(1_000_000);
  });

  // The two tests that lived here asserted `ModelCatalogEntry.supportsReasoning`, a field that is GONE (ADR-0071
  // §6) along with the id heuristic behind it. They were asserting the wrong question — "does this model reason" —
  // and the answer to the right one ("which tiers does it accept") is now catalog data, tested in
  // `reasoning-wire.test.ts` and `catalog/lookup`'s `effortTiersFor` against every one of the 80 shipped models.

  it('availability: a static model NOT in a CONNECTED provider live list is dimmed, one present is available', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-opus-4-8' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(byId(entries, 'claude-opus-4-8')?.available).toBe(true);
    // sonnet is in the registry but NOT in the live list -> dimmed
    expect(byId(entries, 'claude-sonnet-4-6')?.available).toBe(false);
    // a provider with NO live data (openai absent from the map) -> static presence
    expect(byId(entries, 'gpt-5.5')?.available).toBe(true);
  });

  it('an EMPTY live list for a provider dims all that provider’s static models', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['anthropic', []]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(byId(entries, 'claude-opus-4-8')?.available).toBe(false);
    expect(byId(entries, 'claude-haiku-4-5')?.available).toBe(false);
    // deepseek not in the map -> static presence
    expect(byId(entries, 'deepseek-v4-flash')?.available).toBe(true);
  });

  it('surfaces a LIVE-only model (absent from the registry) as selectable-but-unpriced', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'gpt-6-preview', displayName: 'GPT-6 preview' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const fresh = byId(entries, 'gpt-6-preview');
    expect(fresh).toMatchObject({
      provider: 'openai',
      displayName: 'GPT-6 preview',
      pricingSource: 'none',
      priceKnown: false,
      available: true,
    });
    expect(fresh?.pricing).toBeUndefined();
  });

  it('a live-only model with no displayName falls back to the model id', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'gpt-6-preview' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(byId(entries, 'gpt-6-preview')?.displayName).toBe('gpt-6-preview');
  });

  it('price precedence: the USER WINS over the catalog, even for a model the catalog knows (THE FLIP)', () => {
    // Asserted the opposite until ADR-0071 §1. Registry-first protected the user from mispricing a model WE had
    // verified; the catalog is a generated snapshot of a third party, and the user is holding the invoice.
    const mine = userPricing('anthropic');
    const entries = mergeModelCatalog({
      userPricing: new Map([['claude-opus-4-8', mine]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.pricingSource).toBe('user'); // …and the badge names the price we would actually bill at
    expect(opus?.pricing).toBe(mine);
  });

  it('price precedence: the USER tier fills an UNKNOWN id', () => {
    const custom = userPricing('openai');
    const entries = mergeModelCatalog({
      userPricing: new Map([['my-custom-model', custom]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const entry = byId(entries, 'my-custom-model');
    expect(entry).toMatchObject({ provider: 'openai', pricingSource: 'user', priceKnown: true });
    expect(entry?.pricing).toBe(custom);
    // the user tier also supplies context/output when no registry or live value exists
    expect(entry?.contextWindowTokens).toBe(custom.contextWindowTokens);
    expect(entry?.maxOutputTokens).toBe(custom.maxOutputTokens);
  });

  it('three tiers on one id: USER wins price, LIVE wins context, availability by live membership', () => {
    // claude-opus-4-8 present in ALL THREE tiers at once — the full per-field split (ADR-0064 §6, ADR-0071 §1).
    // The two authorities are deliberately different: the PROVIDER is freshest about its own model's limits, and
    // the USER is authoritative about what they are being charged.
    const mine = userPricing('anthropic');
    const entries = mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-opus-4-8', contextWindowTokens: 500_000 }]]]),
      userPricing: new Map([['claude-opus-4-8', mine]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.pricingSource).toBe('user');
    expect(opus?.pricing).toBe(mine);
    expect(opus?.contextWindowTokens).toBe(500_000); // live wins for context
    expect(opus?.priceKnown).toBe(true);
    expect(opus?.available).toBe(true); // in the live list
  });

  it('context/output: the LIVE value wins over the catalog for BOTH fields when present, else the catalog', () => {
    const entries = mergeModelCatalog({
      live: liveMap([
        [
          'anthropic',
          [{ id: 'claude-opus-4-8', contextWindowTokens: 500_000, maxOutputTokens: 7_000 }],
        ],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.contextWindowTokens).toBe(500_000); // live wins
    expect(opus?.maxOutputTokens).toBe(7_000); // live wins for maxOutput too (not the static value)
    // a model with no live entry of its own falls back to the static values
    const sonnet = byId(entries, 'claude-sonnet-4-6');
    expect(sonnet?.contextWindowTokens).toBe(
      CATALOG_SNAPSHOT['claude-sonnet-4-6']?.contextWindowTokens,
    );
    expect(sonnet?.maxOutputTokens).toBe(CATALOG_SNAPSHOT['claude-sonnet-4-6']?.maxOutputTokens);
  });

  it("DEPRECATION survives the swap — it is Relavium's editorial call, not a price (ADR-0071 §10)", () => {
    // The first cut of the big swap DELETED these two dates, on the argument that "the provider is the only one who
    // knows when the provider is retiring something, so it should come from the live list". The argument is right and
    // the conclusion was wrong: NO adapter populates `ModelListing.deprecatedAt` — the OpenAI-compatible list is
    // id-only, and the Anthropic/Gemini mappers carry limits and names and nothing else. So `deprecated` went
    // permanently `false` for every model in the product, and `deepseek-chat` was set to stop working on 2026-07-24
    // with nothing anywhere to say so. Information we already had, thrown away.
    //
    // models.dev publishes a `status` FLAG, and a flag cannot say "this stops working in eleven days". The date lives
    // in a Relavium-owned overlay — one date per model, from a published announcement, and not a second price table.
    const before = mergeModelCatalog({ now: BEFORE_DEEPSEEK_DEPRECATION });
    expect(byId(before, 'deepseek-chat')?.deprecated).toBe(false);
    expect(byId(before, 'deepseek-chat')?.deprecatedAt).toBe('2026-07-24T15:59:00Z'); // announced, not yet past

    const after = mergeModelCatalog({ now: AFTER_DEEPSEEK_DEPRECATION });
    expect(byId(after, 'deepseek-chat')?.deprecated).toBe(true);
    expect(byId(after, 'deepseek-v4-flash')?.deprecated).toBe(false); // its replacement stays clear
  });

  it('deprecation is still a UNION of live and user — the EARLIER date is effective', () => {
    const entries = mergeModelCatalog({
      live: liveMap([
        ['deepseek', [{ id: 'deepseek-v4-flash', deprecatedAt: '2026-07-01T00:00:00Z' }]],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const flash = byId(entries, 'deepseek-v4-flash');
    expect(flash?.deprecatedAt).toBe('2026-07-01T00:00:00Z');
    expect(flash?.deprecated).toBe(true); // now (07-05) >= live date (07-01)

    // A user who knows a retirement date the provider's list has not published yet still gets the earlier one.
    const both = mergeModelCatalog({
      live: liveMap([
        ['deepseek', [{ id: 'deepseek-chat', deprecatedAt: '2027-01-01T00:00:00Z' }]],
      ]),
      userPricing: new Map([
        ['deepseek-chat', { ...userPricing('deepseek'), deprecatedAt: '2026-07-24T15:59:00Z' }],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(byId(both, 'deepseek-chat')?.deprecatedAt).toBe('2026-07-24T15:59:00Z');
  });

  it('an unparseable deprecatedAt is treated as not-deprecated (never throws)', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'weird', deprecatedAt: 'not-a-date' }]]]),
      now: AFTER_DEEPSEEK_DEPRECATION,
    });
    const weird = byId(entries, 'weird');
    expect(weird?.deprecated).toBe(false);
    expect(weird?.deprecatedAt).toBeUndefined();
  });

  it('ignores a live listing whose id collides with a DIFFERENT provider’s catalog model (no field corruption)', () => {
    // a rogue / mis-keyed 'deepseek' live list claims 'gpt-5.5' (a real OpenAI catalog id) with junk fields
    const entries = mergeModelCatalog({
      live: liveMap([
        [
          'deepseek',
          [
            {
              id: 'gpt-5.5',
              contextWindowTokens: 1,
              maxOutputTokens: 1,
              displayName: 'HIJACKED',
              deprecatedAt: '2000-01-01T00:00:00Z',
            },
          ],
        ],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const gpt = byId(entries, 'gpt-5.5');
    expect(gpt?.provider).toBe('openai'); // stays openai
    expect(gpt?.displayName).toBe(CATALOG_SNAPSHOT['gpt-5.5']?.displayName); // the catalog, NOT 'HIJACKED'
    expect(gpt?.contextWindowTokens).toBe(CATALOG_SNAPSHOT['gpt-5.5']?.contextWindowTokens); // the catalog, not 1
    expect(gpt?.maxOutputTokens).toBe(CATALOG_SNAPSHOT['gpt-5.5']?.maxOutputTokens);
    expect(gpt?.deprecated).toBe(false); // the rogue deprecatedAt is dropped
    expect(gpt?.deprecatedAt).toBeUndefined();
    // openai has NO live list (only the mis-keyed deepseek one) -> gpt-5.5 falls back to static presence
    expect(gpt?.available).toBe(true);
  });

  it('USER-tier availability is tier-agnostic: a user id omitted from its connected provider’s live list is dimmed', () => {
    const entries = mergeModelCatalog({
      // openai is connected (has a live list) but that list does NOT include the user-declared id
      live: liveMap([['openai', [{ id: 'gpt-5.5' }]]]),
      userPricing: new Map([['my-custom-openai-model', userPricing('openai')]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const custom = byId(entries, 'my-custom-openai-model');
    expect(custom?.pricingSource).toBe('user');
    expect(custom?.available).toBe(false); // dimmed — openai has live data and this id isn't in it
  });

  it('deprecation union includes the USER tier: a user-priced id with a past deprecatedAt is flagged', () => {
    const custom: ModelPricing = { ...userPricing('openai'), deprecatedAt: '2020-01-01T00:00:00Z' };
    const entries = mergeModelCatalog({
      userPricing: new Map([['old-custom-model', custom]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const entry = byId(entries, 'old-custom-model');
    expect(entry?.deprecatedAt).toBe('2020-01-01T00:00:00Z');
    expect(entry?.deprecated).toBe(true);
  });

  it('orders AVAILABLE models first (alphabetical), then unavailable (alphabetical) — maintainer 2.5.G', () => {
    // openai has live data (only gpt-6-preview), so its static-but-not-live models are dimmed (available:false);
    // every other provider has no live data ⇒ static presence (available:true).
    const entries = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'gpt-6-preview' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    // Availability is the PRIMARY key: every available entry precedes every unavailable one.
    const firstUnavailable = entries.findIndex((e) => !e.available);
    expect(firstUnavailable).toBeGreaterThan(0); // there ARE dimmed entries (openai's non-live static models)
    expect(entries.slice(0, firstUnavailable).every((e) => e.available)).toBe(true);
    expect(entries.slice(firstUnavailable).every((e) => !e.available)).toBe(true);
    // Within each availability group, entries are displayName-sorted (en locale), stable + no duplicates.
    const availableNames = entries.filter((e) => e.available).map((e) => e.displayName);
    expect(availableNames).toEqual([...availableNames].sort((a, b) => a.localeCompare(b, 'en')));
    const dimmedNames = entries.filter((e) => !e.available).map((e) => e.displayName);
    expect(dimmedNames).toEqual([...dimmedNames].sort((a, b) => a.localeCompare(b, 'en')));
    // The modelId tiebreaker + insertion-order independence: two user-priced unknown ids that TIE on
    // provider (openai) + displayName ('Custom Model') must order by modelId ascending, regardless of the
    // input Map's insertion order (proves the model-catalog.ts sort tiebreaker, not a same-input re-run).
    const forward = mergeModelCatalog({
      userPricing: new Map([
        ['zeta-model', userPricing('openai')],
        ['alpha-model', userPricing('openai')],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const reversed = mergeModelCatalog({
      userPricing: new Map([
        ['alpha-model', userPricing('openai')],
        ['zeta-model', userPricing('openai')],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const forwardCustom = forward
      .filter((e) => e.displayName === 'Custom Model')
      .map((e) => e.modelId);
    expect(forwardCustom).toEqual(['alpha-model', 'zeta-model']); // modelId tiebreaker, not insertion order
    expect(reversed.map((e) => e.modelId)).toEqual(forward.map((e) => e.modelId)); // insertion-order independent
  });

  it('does not mutate the CATALOG SNAPSHOT', () => {
    const snapshot = JSON.stringify(CATALOG_SNAPSHOT);
    mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-opus-4-8', contextWindowTokens: 1 }]]]),
      userPricing: new Map([['x', userPricing('openai')]]),
      now: AFTER_DEEPSEEK_DEPRECATION,
    });
    expect(JSON.stringify(CATALOG_SNAPSHOT)).toBe(snapshot);
  });
});

describe('mergeModelCatalog — key-awareness (2.5.G, ADR-0064 §6 clarification)', () => {
  it('marks a model of an UNKEYED provider unavailable with reason `no-key`, regardless of static presence', () => {
    // anthropic is NOT in keyedProviders → all its static models are no-key (uncallable), even with no live data.
    const entries = mergeModelCatalog({
      keyedProviders: new Set<ProviderId>(['openai']),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8'); // anthropic — unkeyed
    expect(opus?.available).toBe(false);
    expect(opus?.unavailableReason).toBe('no-key');
    const gpt = entries.find((e) => e.provider === 'openai'); // openai — keyed, no live data → static presence
    expect(gpt?.available).toBe(true);
    expect(gpt?.unavailableReason).toBeUndefined();
  });

  it('PRESERVES the §6 static-presence safe default for a KEYED provider with no live data', () => {
    const entries = mergeModelCatalog({
      keyedProviders: new Set<ProviderId>(['anthropic']),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8'); // keyed + no live data → available (unchanged)
    expect(opus?.available).toBe(true);
    expect(opus?.unavailableReason).toBeUndefined();
  });

  it('a KEYED provider WITH live data still dims a static model absent from its list as `not-on-key`', () => {
    const entries = mergeModelCatalog({
      keyedProviders: new Set<ProviderId>(['anthropic']),
      // anthropic has live data, but the list omits claude-opus-4-8 → not-on-key (the pre-existing dim).
      live: liveMap([['anthropic', [{ id: 'claude-haiku-4-5' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.available).toBe(false);
    expect(opus?.unavailableReason).toBe('not-on-key');
  });

  it('keyedProviders ABSENT ⇒ availability is not key-gated (the `available` boolean is unchanged)', () => {
    const gated = mergeModelCatalog({ now: BEFORE_DEEPSEEK_DEPRECATION });
    // Every entry is available (no live data, no key gate) and carries no unavailableReason.
    expect(gated.every((e) => e.available && e.unavailableReason === undefined)).toBe(true);
  });

  it('keyedProviders ABSENT + live data still labels a live-omitted static model `not-on-key` (additive field)', () => {
    // The `available` boolean is unchanged from pre-change; only the additive `unavailableReason` is new here.
    const entries = mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-haiku-4-5' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.available).toBe(false); // unchanged
    expect(opus?.unavailableReason).toBe('not-on-key'); // additive-optional reason
  });
});
