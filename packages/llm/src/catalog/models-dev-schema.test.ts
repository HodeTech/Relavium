import { describe, expect, it } from 'vitest';

import {
  CATALOG_PROVIDER_KEYS,
  CATALOG_UPSTREAM_KEYS,
  providerIdForCatalogKey,
} from './catalog-providers.js';
import { ModelsDevPayloadSchema, normalizeCatalog } from './models-dev-schema.js';

/**
 * THE BOUNDARY (ADR-0071 §11) — where a third-party payload becomes a Relavium type, and where a money surface
 * and a wire parameter get decided. Everything here is about what must NOT happen: a wrong price, a `0` that
 * means "free" when it means "unknown", a model silently missing, or one provider's rates written under another
 * provider's id.
 */

/** A minimal upstream model. Overrides are shallow-merged so a test can express exactly one deviation. */
const upstreamModel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm1',
  name: 'Model One',
  limit: { context: 200_000, output: 64_000 },
  cost: { input: 5, output: 25 },
  ...over,
});

const payload = (providers: Record<string, Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(providers).map(([key, models]) => [key, { id: key, models }]));

describe('CATALOG_PROVIDER_KEYS — the one place the two vocabularies meet', () => {
  it('maps `gemini` to `google` — the upstream key is NOT our ProviderId', () => {
    // Miss this and every Gemini model arrives UNPRICED — and an unpriced model silently skips the cost cap.
    expect(CATALOG_PROVIDER_KEYS.gemini).toBe('google');
    expect(providerIdForCatalogKey('google')).toBe('gemini');
  });

  it('is EXHAUSTIVE over ProviderId — a new provider is a compile error until it is mapped', () => {
    // The type is `Record<ProviderId, string>`, so this is really a compile-time claim; the runtime check pins
    // that no entry was left as an empty string, which would silently match nothing.
    for (const key of CATALOG_UPSTREAM_KEYS) expect(key).not.toBe('');
    expect(CATALOG_UPSTREAM_KEYS).toHaveLength(Object.keys(CATALOG_PROVIDER_KEYS).length);
  });

  it('does NOT map an upstream provider we have no adapter for', () => {
    expect(providerIdForCatalogKey('google-vertex')).toBeUndefined();
    expect(providerIdForCatalogKey('requesty')).toBeUndefined();
    expect(providerIdForCatalogKey('azure')).toBeUndefined();
  });
});

describe('normalizeCatalog — what we import, and what we refuse to', () => {
  it('imports ONLY our four providers — the other ~162 are not callable and must not enter the catalog', () => {
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: { m1: upstreamModel({ id: 'gpt-x' }) },
        // Not ours: no adapter, no key, no way to call it. A row here would be an uncallable model in the picker.
        'some-aggregator': { m1: upstreamModel({ id: 'aggregated-x' }) },
      }),
    );
    const { catalog } = normalizeCatalog(raw);
    expect(Object.keys(catalog)).toEqual(['gpt-x']);
  });

  it('IGNORES `google-vertex` — it republishes the same Gemini ids at DIFFERENT prices', () => {
    // A naive flatten registers every Gemini model twice and the second write wins — pricing the user's Gemini
    // traffic at Vertex rates. The mapping is a lookup, never an iteration over the payload's own keys.
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        google: { m: upstreamModel({ id: 'gemini-x', cost: { input: 1.25, output: 10 } }) },
        'google-vertex': { m: upstreamModel({ id: 'gemini-x', cost: { input: 99, output: 99 } }) },
      }),
    );
    const { catalog } = normalizeCatalog(raw);
    expect(catalog['gemini-x']?.provider).toBe('gemini');
    expect(catalog['gemini-x']?.inputPerMtokMicrocents).toBe(125_000_000); // $1.25, NOT $99
  });

  it('REGRESSION: a malformed model under a provider we do NOT import cannot kill the sync', () => {
    // This is not hypothetical — it broke the first run. `requesty` publishes `budget_tokens` with no `min`,
    // and a single strict schema over the whole 166-provider payload died on it. We can never call `requesty`;
    // being hostage to its data quality for data we never read is the bug. Validate what we consume.
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: { good: upstreamModel({ id: 'gpt-x' }) },
        requesty: {
          bad: upstreamModel({
            id: 'whatever',
            reasoning: true,
            reasoning_options: [{ type: 'budget_tokens' }], // no `min` — invalid for us, irrelevant to us
          }),
        },
      }),
    );
    const { catalog, dropped } = normalizeCatalog(raw);
    expect(catalog['gpt-x']).toBeDefined(); // the sync SURVIVES
    expect(dropped).toEqual([]); // and never even looked at `requesty`
  });

  it('drops a malformed model of OUR OWN provider — one bad row, not a dead sync — and REPORTS it', () => {
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: {
          'gpt-x': upstreamModel({ id: 'gpt-x' }),
          'gpt-bad': upstreamModel({ id: 'gpt-bad', cost: { input: -1, output: 5 } }), // a NEGATIVE rate
        },
      }),
    );
    const { catalog, dropped } = normalizeCatalog(raw);
    expect(catalog['gpt-x']).toBeDefined();
    expect(catalog['gpt-bad']).toBeUndefined(); // a negative rate would corrupt the cap — never written
    expect(dropped).toHaveLength(1); // …and never silent: the sync prints it
    expect(dropped[0]?.modelId).toBe('gpt-bad');
  });

  it('a dropped model is reported by its OWN id, never the record key — the shipped-model guard depends on it', () => {
    // The sync FAILS if a model we already ship would be dropped (losing its price silently un-caps it). That
    // guard compares the dropped id against the committed snapshot, which is keyed by MODEL ID. Upstream keys
    // its record by id today — but if that ever diverges, reporting the key would make the guard look at the
    // wrong name and wave the regression straight through. So the id is read from the model, not the key.
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: {
          'some-record-key': upstreamModel({ id: 'gpt-real-id', cost: null }), // key ≠ id, and unpriceable
        },
      }),
    );
    const { dropped } = normalizeCatalog(raw);
    expect(dropped[0]?.modelId).toBe('gpt-real-id'); // NOT 'some-record-key'
  });

  it('…and falls back to the record key only when the failed row has no usable id of its own', () => {
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: { 'fallback-key': { name: 'no id at all', cost: { input: 1, output: 1 } } },
      }),
    );
    const { dropped } = normalizeCatalog(raw);
    expect(dropped[0]?.modelId).toBe('fallback-key');
  });

  it('drops an UNPRICEABLE model rather than writing it at $0 — a $0 row PASSES the cost cap', () => {
    // Upstream carries `cost: null` on image models (they bill per image, an axis we do not model). Importing
    // one at zero is worse than its absence: an unpriced model is FLAGGED, a $0 model sails through the cap.
    const raw = ModelsDevPayloadSchema.parse(
      payload({ openai: { img: upstreamModel({ id: 'gpt-image', cost: null }) } }),
    );
    const { catalog, dropped } = normalizeCatalog(raw);
    expect(catalog['gpt-image']).toBeUndefined();
    expect(dropped[0]?.reason).toContain('unpriceable');
  });

  it('THROWS on a real cross-provider id collision rather than letting one price silently win', () => {
    const raw = ModelsDevPayloadSchema.parse(
      payload({
        openai: { a: upstreamModel({ id: 'shared-id' }) },
        anthropic: { b: upstreamModel({ id: 'shared-id' }) },
      }),
    );
    // The catalog is keyed by model id (matching the merge), so this is a genuine ambiguity — and a generator
    // that quietly halves its own output is exactly the failure mode this whole workstream exists to end.
    expect(() => normalizeCatalog(raw)).toThrow(/appears under BOTH/);
  });
});

describe('ENRICHMENT is decoupled from the money gate — a priced model is never evicted by a field we enrich with (review M7)', () => {
  const one = (over: Record<string, unknown>): ReturnType<typeof normalizeCatalog> =>
    normalizeCatalog(
      ModelsDevPayloadSchema.parse(payload({ openai: { m: upstreamModel({ id: 'm', ...over }) } })),
    );

  it('an UNKNOWN reasoning_options shape is SKIPPED, not fatal — the priced model survives with a thinner descriptor', () => {
    // Upstream adds a control type we do not recognize alongside one we do. A whole-array discriminatedUnion would
    // fail the row and DROP a fully-priced model — which reads to the §9 guard as a vanished price. It must stay.
    const { catalog, dropped } = one({
      reasoning: true,
      reasoning_options: [
        { type: 'verbosity', values: ['terse', 'verbose'] }, // unknown — skip it
        { type: 'effort', values: ['low', 'high'] }, // known — keep it
      ],
    });
    expect(dropped).toHaveLength(0);
    expect(catalog['m']?.inputPerMtokMicrocents).toBe(500_000_000); // still priced
    expect(catalog['m']?.reasoning).toEqual({ effortValues: ['low', 'high'] }); // only the recognized control
  });

  it('a MALFORMED known option is skipped too (an `effort` with no values), model kept', () => {
    const { catalog, dropped } = one({
      reasoning: true,
      reasoning_options: [{ type: 'effort' }, { type: 'budget_tokens', min: 1024 }],
    });
    expect(dropped).toHaveLength(0);
    expect(catalog['m']?.reasoning).toEqual({ budgetTokens: { min: 1024 } });
  });

  it('`reasoning: null` is treated as "no reasoning", not a parse error — the model is admitted, priced, unreasoning', () => {
    const { catalog, dropped } = one({ reasoning: null });
    expect(dropped).toHaveLength(0);
    expect(catalog['m']?.outputPerMtokMicrocents).toBe(2_500_000_000);
    expect(catalog['m']).not.toHaveProperty('reasoning');
  });

  it('`limit: null` drops the model CLEANLY (no ceiling to clamp), not via a fatal parse of the whole row', () => {
    const { catalog, dropped } = one({ limit: null });
    expect(catalog['m']).toBeUndefined(); // dropped — but as an unpriceable-shape drop, reported, not a crash
    expect(dropped.some((d) => d.modelId === 'm')).toBe(true);
  });

  it('carries per-model REQUEST capabilities, storing ONLY the rejected ones (ADR-0071 amendment)', () => {
    // Upstream marks this model as rejecting temperature + structured_output, accepting tool_call + attachment.
    const { catalog } = one({
      temperature: false,
      structured_output: false,
      tool_call: true,
      attachment: true,
    });
    // Only the `false` (rejected) parameters are stored; the accepted ones add nothing (absent ⇒ accepted).
    expect(catalog['m']?.requestCapabilities).toEqual({
      temperature: false,
      structuredOutput: false,
    });
  });

  it('a model that accepts everything carries NO requestCapabilities (the common case adds nothing)', () => {
    const { catalog } = one({ temperature: true, tool_call: true });
    expect(catalog['m']).not.toHaveProperty('requestCapabilities');
  });

  it('a missing/odd capability value degrades to accepted (never a parse failure)', () => {
    const { catalog, dropped } = one({ temperature: null }); // null ⇒ accepted, model still priced
    expect(dropped).toHaveLength(0);
    expect(catalog['m']).not.toHaveProperty('requestCapabilities');
  });
});

describe('the money boundary — integer micro-cents, and absent ≠ zero', () => {
  const one = (over: Record<string, unknown>): ReturnType<typeof normalizeCatalog> =>
    normalizeCatalog(
      ModelsDevPayloadSchema.parse(payload({ openai: { m: upstreamModel({ id: 'm', ...over }) } })),
    );

  it('converts USD-per-Mtok to INTEGER micro-cents — no float ever reaches the cost cap', () => {
    const { catalog } = one({ cost: { input: 0.435, output: 0.87 } });
    expect(catalog['m']?.inputPerMtokMicrocents).toBe(43_500_000);
    expect(catalog['m']?.outputPerMtokMicrocents).toBe(87_000_000);
    expect(Number.isInteger(catalog['m']?.inputPerMtokMicrocents)).toBe(true);
  });

  it('an ABSENT cache-read rate stays UNDEFINED — writing 0 would bill cached input as FREE', () => {
    // `0` means "no discount" in ModelPricing. 19 of our ~97 models have no cache-read rate (gpt-5.4-pro among
    // them). Coercing absent → 0 is a silent undercharge in the exact mechanism this work is hardening.
    const { catalog } = one({ cost: { input: 5, output: 25 } });
    expect(catalog['m']).not.toHaveProperty('cachedInputPerMtokMicrocents');
  });

  it('a PRESENT cache-read rate of 0 is kept as 0 — that is a real "no discount", not a missing value', () => {
    const { catalog } = one({ cost: { input: 5, output: 25, cache_read: 0 } });
    expect(catalog['m']?.cachedInputPerMtokMicrocents).toBe(0);
  });

  it('carries CONTEXT TIERS — a flat rate understates long-context spend by up to 2x', () => {
    const { catalog } = one({
      cost: {
        input: 1.25,
        output: 10,
        tiers: [{ input: 2.5, output: 15, tier: { type: 'context', size: 200_000 } }],
      },
    });
    expect(catalog['m']?.contextTiers).toEqual([
      {
        aboveContextTokens: 200_000,
        inputPerMtokMicrocents: 250_000_000,
        outputPerMtokMicrocents: 1_500_000_000,
      },
    ]);
  });
});

describe('the reasoning descriptor — the shape is PER MODEL, which a boolean could never say', () => {
  const reasoningOf = (over: Record<string, unknown>): unknown =>
    normalizeCatalog(
      ModelsDevPayloadSchema.parse(payload({ openai: { m: upstreamModel({ id: 'm', ...over }) } })),
    ).catalog['m']?.reasoning;

  it('a non-reasoning model has NO descriptor', () => {
    expect(reasoningOf({})).toBeUndefined();
  });

  it('an EFFORT model carries its PROVIDER-WIRE values verbatim — never re-read as our tiers', () => {
    // `gpt-5.4-pro` accepts {medium, high, xhigh} and REJECTS `low` — the maintainer's bug report, in one row.
    expect(
      reasoningOf({
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['medium', 'high', 'xhigh'] }],
      }),
    ).toEqual({ effortValues: ['medium', 'high', 'xhigh'] });
  });

  it('a BUDGET model carries min/max — and `min` is what says whether `off` is even possible', () => {
    // gemini-2.5-pro: min 128 ⇒ thinking CANNOT be disabled (Google: "N/A: Cannot disable thinking").
    // gemini-2.5-flash: min 0 ⇒ it can. One field, and the `off` tier's availability falls straight out of it.
    expect(
      reasoningOf({
        reasoning: true,
        reasoning_options: [{ type: 'budget_tokens', min: 128, max: 32_768 }],
      }),
    ).toEqual({ budgetTokens: { min: 128, max: 32_768 } });
  });

  it('carries BOTH axes when a model has both (toggle + budget, or effort + budget)', () => {
    expect(
      reasoningOf({
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 0, max: 24_576 }],
      }),
    ).toEqual({ toggle: true, budgetTokens: { min: 0, max: 24_576 } });
  });

  it('an EMPTY descriptor is a distinct, real state: the model reasons but has NO controllable tier', () => {
    // `deepseek-reasoner`. This is NOT the same as "does not reason" — it tells the picker to offer NOTHING,
    // rather than to offer everything (which is precisely today's bug).
    expect(reasoningOf({ reasoning: true })).toEqual({});
  });
});
