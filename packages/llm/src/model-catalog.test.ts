import { describe, expect, it } from 'vitest';

import { mergeModelCatalog, type ModelCatalogEntry } from './model-catalog.js';
import { MODEL_PRICING, type ModelPricing } from './pricing.js';
import type { ModelListing, ProviderId } from './types.js';

// A fixed clock so the deprecation check is deterministic. deepseek-chat/-reasoner deprecate 2026-07-24 15:59Z.
const BEFORE_DEEPSEEK_DEPRECATION = Date.parse('2026-07-05T00:00:00Z');
const AFTER_DEEPSEEK_DEPRECATION = Date.parse('2026-08-01T00:00:00Z');

const byId = (entries: readonly ModelCatalogEntry[], id: string): ModelCatalogEntry | undefined =>
  entries.find((e) => e.modelId === id);

const liveMap = (
  rows: ReadonlyArray<readonly [ProviderId, readonly ModelListing[]]>,
): ReadonlyMap<ProviderId, readonly ModelListing[]> => new Map(rows);

/** A minimal user-supplied ModelPricing for an id absent from MODEL_PRICING (ADR-0065 USER tier). */
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
  it('with no live/user data, surfaces every static model as registry-priced and available (static presence)', () => {
    const entries = mergeModelCatalog({ now: BEFORE_DEEPSEEK_DEPRECATION });
    expect(entries.length).toBe(Object.keys(MODEL_PRICING).length);
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus).toMatchObject({
      provider: 'anthropic',
      displayName: 'Claude Opus 4.8',
      pricingSource: 'registry',
      priceKnown: true,
      available: true, // no live data for anthropic -> static presence
      deprecated: false,
    });
    expect(opus?.pricing).toBe(MODEL_PRICING['claude-opus-4-8']);
    expect(opus?.contextWindowTokens).toBe(1_000_000);
  });

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

  it('price precedence: the static registry WINS for a known id even when user pricing is supplied', () => {
    const entries = mergeModelCatalog({
      userPricing: new Map([['claude-opus-4-8', userPricing('anthropic')]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.pricingSource).toBe('registry');
    expect(opus?.pricing).toBe(MODEL_PRICING['claude-opus-4-8']); // NOT the user object
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
  });

  it('context/output: the LIVE value wins over the static one when present, else static', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-opus-4-8', contextWindowTokens: 500_000 }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const opus = byId(entries, 'claude-opus-4-8');
    expect(opus?.contextWindowTokens).toBe(500_000); // live wins
    expect(opus?.maxOutputTokens).toBe(MODEL_PRICING['claude-opus-4-8'].maxOutputTokens); // no live -> static
  });

  it('deprecation: a static deprecatedAt flags the model only once now >= the date', () => {
    const before = mergeModelCatalog({ now: BEFORE_DEEPSEEK_DEPRECATION });
    expect(byId(before, 'deepseek-chat')?.deprecated).toBe(false);
    expect(byId(before, 'deepseek-chat')?.deprecatedAt).toBe('2026-07-24T15:59:00Z');

    const after = mergeModelCatalog({ now: AFTER_DEEPSEEK_DEPRECATION });
    expect(byId(after, 'deepseek-chat')?.deprecated).toBe(true);
    // a non-deprecated model stays clear
    expect(byId(after, 'deepseek-v4-flash')?.deprecated).toBe(false);
  });

  it('deprecation is a UNION: the EARLIER of the static and live dates is effective', () => {
    const entries = mergeModelCatalog({
      // deepseek-v4-flash has no static deprecation; a live list marks it deprecated earlier
      live: liveMap([
        ['deepseek', [{ id: 'deepseek-v4-flash', deprecatedAt: '2026-07-01T00:00:00Z' }]],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    const flash = byId(entries, 'deepseek-v4-flash');
    expect(flash?.deprecatedAt).toBe('2026-07-01T00:00:00Z');
    expect(flash?.deprecated).toBe(true); // now (07-05) >= live date (07-01)

    // when both are present, the earlier wins
    const both = mergeModelCatalog({
      live: liveMap([
        ['deepseek', [{ id: 'deepseek-chat', deprecatedAt: '2027-01-01T00:00:00Z' }]],
      ]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(byId(both, 'deepseek-chat')?.deprecatedAt).toBe('2026-07-24T15:59:00Z'); // static earlier than live
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

  it('is deterministically ordered: provider (seam order) then displayName then id', () => {
    const entries = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'gpt-6-preview' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    // provider order is anthropic < openai < gemini < deepseek
    const providers = entries.map((e) => e.provider);
    const firstOpenAi = providers.indexOf('openai');
    const lastAnthropic = providers.lastIndexOf('anthropic');
    const firstGemini = providers.indexOf('gemini');
    expect(lastAnthropic).toBeLessThan(firstOpenAi);
    expect(firstOpenAi).toBeLessThan(firstGemini);
    // within a provider, entries are displayName-then-id sorted (stable, no duplicates)
    const anthropic = entries.filter((e) => e.provider === 'anthropic').map((e) => e.displayName);
    expect(anthropic).toEqual([...anthropic].sort((a, b) => a.localeCompare(b)));
    // two runs produce byte-identical ordering
    const again = mergeModelCatalog({
      live: liveMap([['openai', [{ id: 'gpt-6-preview' }]]]),
      now: BEFORE_DEEPSEEK_DEPRECATION,
    });
    expect(entries.map((e) => e.modelId)).toEqual(again.map((e) => e.modelId));
  });

  it('does not mutate MODEL_PRICING', () => {
    const snapshot = JSON.stringify(MODEL_PRICING);
    mergeModelCatalog({
      live: liveMap([['anthropic', [{ id: 'claude-opus-4-8', contextWindowTokens: 1 }]]]),
      userPricing: new Map([['x', userPricing('openai')]]),
      now: AFTER_DEEPSEEK_DEPRECATION,
    });
    expect(JSON.stringify(MODEL_PRICING)).toBe(snapshot);
  });
});
