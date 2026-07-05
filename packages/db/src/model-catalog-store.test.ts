import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import {
  createModelCatalogStore,
  ModelCatalogCapabilitiesError,
  type ModelCatalogStore,
} from './model-catalog-store.js';
import { createProviderStore, type ProviderStore } from './provider-store.js';
import { modelCatalog } from './schema.js';

const TS_MS = new Date('2026-06-25T12:00:00.000Z').getTime();

describe('createModelCatalogStore (2.S — media routing + load-check reader)', () => {
  let client: DbClient;
  let store: ModelCatalogStore;
  let providerStore: ProviderStore;
  let providerId: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    let n = 0;
    // Shared deps so provider rows + catalog rows mint ids from ONE increasing sequence (insertion order =
    // id order), which the `asc(createdAt), asc(id)` tiebreaker test relies on.
    const deps = {
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => TS_MS,
    };
    // model_catalog.provider_id is an FK into llm_providers — seed a provider first.
    providerStore = createProviderStore(client.db, deps);
    providerId = providerStore.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    store = createModelCatalogStore(client.db, deps);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  it('upserts a generative-surface row and reads it back (record shape + parsed capabilities)', () => {
    const rec = store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      supportsVision: true,
      capabilities: { media: { outputCombinations: [['image']] } },
      // Distinct per-modality rates so a swapped image/audio/video column in `fromRow` fails the test.
      mediaImageCostMicrocents: 1_900_000,
      mediaAudioCostMicrocents: 100,
      mediaVideoCostMicrocents: 200,
    });
    expect(rec.modelId).toBe('gpt-image-1');
    expect(rec.mediaSurface).toBe('generative');
    expect(rec.supportsVision).toBe(true);
    expect(rec.capabilities).toEqual({ media: { outputCombinations: [['image']] } });
    expect(rec.mediaImageCostMicrocents).toBe(1_900_000);
    expect(rec.mediaAudioCostMicrocents).toBe(100);
    expect(rec.mediaVideoCostMicrocents).toBe(200);
    // The capability flags the D15 CapabilityFlags projection consumes — pin the `fromRow` column mapping
    // (defaults false / true / false, since only `supportsVision` was set on the upsert).
    expect(rec.supportsToolCalling).toBe(false);
    expect(rec.supportsStreaming).toBe(true);
    expect(rec.supportsJsonMode).toBe(false);
    expect(store.getByModelId('gpt-image-1')).toEqual(rec);
  });

  it('resolveMediaSurface routes generative vs chat, and undefined for an unknown model', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    store.upsert({
      providerId,
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
      // mediaSurface omitted ⇒ defaults to 'chat'
    });
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('generative');
    expect(store.resolveMediaSurface('gpt-4o')).toBe('chat');
    expect(store.resolveMediaSurface('not-in-catalog')).toBeUndefined();
    // getByModelId takes a separate code path from resolveMediaSurface — assert its miss branch too.
    expect(store.getByModelId('not-in-catalog')).toBeUndefined();
  });

  it('fromRow maps each capability flag to its own column (non-default values)', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    // Set the three flags to NON-default values directly (the upsert API intentionally exposes only
    // `supportsVision`). Defaults are false/true/false, so a `fromRow` mapping that read the wrong column would
    // read a different value here and fail. (Three booleans cannot make every pairwise swap detectable — two
    // must share a value — but distinct-from-default catches a mapping that reads the wrong column.)
    client.sqlite
      .prepare(
        'UPDATE model_catalog SET supports_tool_calling = 1, supports_streaming = 0, supports_json_mode = 1 WHERE model_id = ?',
      )
      .run('gpt-4o');
    const rec = store.getByModelId('gpt-4o');
    expect(rec?.supportsToolCalling).toBe(true);
    expect(rec?.supportsStreaming).toBe(false);
    expect(rec?.supportsJsonMode).toBe(true);
  });

  it('a NULL media rate reads back as null (cost degrades to 0 — never fabricated)', () => {
    const rec = store.upsert({
      providerId,
      modelId: 'imagen-3',
      displayName: 'Imagen 3',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      // no media rate supplied
    });
    expect(rec.mediaImageCostMicrocents).toBeNull();
    expect(rec.mediaAudioCostMicrocents).toBeNull();
    expect(rec.mediaVideoCostMicrocents).toBeNull();
  });

  it('upsert is idempotent by (provider, model) — updates, never duplicates', () => {
    const a = store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
    });
    const b = store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1 (v2)',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    expect(b.mediaSurface).toBe('generative');
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('generative');
    // Same logical row updated in place (one active row for the model id) — read cast-free via drizzle.
    const rows = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'gpt-image-1'))
      .all();
    expect(rows).toHaveLength(1);
    expect(b.modelId).toBe(a.modelId);
  });

  it('the asc(id) tiebreaker — not insertion order — picks between two providers with equal createdAt', () => {
    const secondProviderId = providerStore.upsert({
      name: 'azure-openai',
      displayName: 'Azure OpenAI',
      baseUrl: 'https://example.openai.azure.com',
    }).id;
    // Mint ids in DESCENDING order so insertion order and id order DIVERGE: the row inserted FIRST gets the
    // HIGHER id, the row inserted SECOND gets the LOWER id. Only the `asc(id)` tiebreaker (NOT rowid/insertion
    // order) then yields the asserted winner — so this test fails if the tiebreaker is dropped (a bare
    // `asc(createdAt)` returns the first-inserted 'chat' row on the tie).
    const descendingIds = [
      'ffffffff-0000-4000-8000-000000000001',
      'aaaaaaaa-0000-4000-8000-000000000002',
    ];
    const descStore = createModelCatalogStore(client.db, {
      uuid: () => descendingIds.shift() ?? 'unexpected-extra-id',
      now: () => TS_MS,
    });
    // Inserted FIRST → higher id (ffff…) → 'chat'.
    descStore.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'high-id, inserted first',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
    });
    // Inserted SECOND → lower id (aaaa…) → 'generative'. This row must win under asc(id).
    descStore.upsert({
      providerId: secondProviderId,
      modelId: 'gpt-image-1',
      displayName: 'low-id, inserted second',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    // Two co-existing active rows; the lower-sorting minted id wins, stably across repeated reads — i.e. the
    // second-inserted row, NOT the first-inserted one a missing tiebreaker (rowid order) would return.
    const both = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'gpt-image-1'))
      .all();
    expect(both).toHaveLength(2);
    const surfaces = [0, 1, 2].map(() => store.resolveMediaSurface('gpt-image-1'));
    expect(surfaces).toEqual(['generative', 'generative', 'generative']);
    expect(store.getByModelId('gpt-image-1')?.providerId).toBe(secondProviderId);
  });

  it('an upsert re-activates a previously-deactivated row (the isActive:true reactivation branch)', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
    });
    client.sqlite
      .prepare('UPDATE model_catalog SET is_active = 0 WHERE model_id = ?')
      .run('gpt-image-1');
    expect(store.getByModelId('gpt-image-1')).toBeUndefined(); // deactivated ⇒ unreachable
    // Re-upsert through the store: `upsert` sets is_active = true, so the row becomes reachable again.
    const re = store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1 (re-synced)',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    expect(re.mediaSurface).toBe('generative');
    expect(store.getByModelId('gpt-image-1')?.mediaSurface).toBe('generative');
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('generative');
  });

  it('fail-closed read-scoping: a deactivated (is_active=0) or soft-deleted row is unreachable', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    // Deactivate the row directly — a retired generative model must NOT resolve (else a node routes onto it).
    client.sqlite
      .prepare('UPDATE model_catalog SET is_active = 0 WHERE model_id = ?')
      .run('gpt-image-1');
    expect(store.resolveMediaSurface('gpt-image-1')).toBeUndefined();
    expect(store.getByModelId('gpt-image-1')).toBeUndefined();
    // Re-activate, then soft-delete — the deletedAt filter must also exclude it.
    client.sqlite
      .prepare('UPDATE model_catalog SET is_active = 1, deleted_at = ? WHERE model_id = ?')
      .run(TS_MS, 'gpt-image-1');
    expect(store.resolveMediaSurface('gpt-image-1')).toBeUndefined();
    expect(store.getByModelId('gpt-image-1')).toBeUndefined();
  });

  it('fail-closed: a tampered media_surface value degrades to the safe chat surface (never generative)', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    // Tamper the column directly (a value the typed drizzle API cannot produce) — the read boundary must not
    // trust it and must NOT route a node to the generative path on a non-member value.
    client.sqlite
      .prepare("UPDATE model_catalog SET media_surface = 'bogus' WHERE model_id = ?")
      .run('gpt-image-1');
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('chat');
    expect(store.getByModelId('gpt-image-1')?.mediaSurface).toBe('chat');
  });

  it('fail-closed: a corrupt capabilities value aborts the read with a typed ModelCatalogCapabilitiesError', () => {
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
    });
    client.sqlite
      .prepare("UPDATE model_catalog SET capabilities = '[]' WHERE model_id = ?")
      .run('gpt-image-1');
    // A typed domain error (not a bare TypeError) so a caller can tell a corrupt row apart from a DB fault.
    expect(() => store.getByModelId('gpt-image-1')).toThrow(ModelCatalogCapabilitiesError);
    // resolveMediaSurface does not parse capabilities, so it stays usable for routing.
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('chat');
    // A genuinely malformed (non-JSON) value takes the distinct JSON.parse-throws branch — wrapped in the SAME
    // typed error (preserving the SyntaxError as `cause`) so the caller's catch handles both corrupt shapes.
    client.sqlite
      .prepare("UPDATE model_catalog SET capabilities = '{' WHERE model_id = ?")
      .run('gpt-image-1');
    let caught: unknown;
    try {
      store.getByModelId('gpt-image-1');
    } catch (err) {
      caught = err;
    }
    if (!(caught instanceof ModelCatalogCapabilitiesError)) {
      throw new Error('expected a ModelCatalogCapabilitiesError on a non-JSON capabilities column');
    }
    expect(caught.cause).toBeInstanceOf(SyntaxError);
  });
});

describe('createModelCatalogStore (2.5.G / ADR-0064 — live-discovery cache)', () => {
  let client: DbClient;
  let store: ModelCatalogStore;
  let providerStore: ProviderStore;
  let providerId: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    let n = 0;
    const deps = {
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => TS_MS,
    };
    providerStore = createProviderStore(client.db, deps);
    providerId = providerStore.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    store = createModelCatalogStore(client.db, deps);
  });

  afterEach(() => {
    client.sqlite.close();
  });

  it('a live model round-trips via replaceProviderModels → listByProvider (source live, stamp set, 0-context ⇒ undefined)', () => {
    const REFRESH_TS = TS_MS + 60_000;
    store.replaceProviderModels(
      providerId,
      [
        {
          modelId: 'gpt-4o',
          displayName: 'GPT-4o',
          contextWindowTokens: 128_000,
          maxOutputTokens: 16_384,
        },
        // No context/output ⇒ stored as the `0` "unknown" sentinel ⇒ read back as undefined.
        { modelId: 'o3', displayName: 'o3' },
      ],
      REFRESH_TS,
    );
    const listing = store.listByProvider(providerId);
    // Deterministic order by model id.
    expect(listing.map((m) => m.modelId)).toEqual(['gpt-4o', 'o3']);

    const gpt = listing.find((m) => m.modelId === 'gpt-4o');
    expect(gpt?.source).toBe('live');
    expect(gpt?.lastRefreshedAt).toBe(REFRESH_TS);
    expect(gpt?.isActive).toBe(true);
    expect(gpt?.contextWindowTokens).toBe(128_000);
    expect(gpt?.maxOutputTokens).toBe(16_384);
    // A live row carries no price (the static registry is the pricing authority) — integer µ¢ zeros.
    expect(gpt?.inputCostPerMtokMicrocents).toBe(0);
    expect(gpt?.outputCostPerMtokMicrocents).toBe(0);
    expect(gpt?.cachedInputCostPerMtokMicrocents).toBe(0);

    const o3 = listing.find((m) => m.modelId === 'o3');
    expect(o3?.contextWindowTokens).toBeUndefined();
    expect(o3?.maxOutputTokens).toBeUndefined();
    expect(o3?.displayName).toBe('o3');
    expect(o3?.deprecationDate).toBeUndefined();
  });

  it('replaceProviderModels falls back an empty displayName to the model id', () => {
    store.replaceProviderModels(providerId, [{ modelId: 'bare-model', displayName: '   ' }], TS_MS);
    expect(store.listByProvider(providerId)[0]?.displayName).toBe('bare-model');
  });

  it('upserts new, soft-deactivates a vanished live row (never hard-deletes), reactivates a reappearing one, preserves user/static rows', () => {
    const T1 = TS_MS + 1000;
    const T2 = TS_MS + 2000;
    const T3 = TS_MS + 3000;

    // A source='user' row (user pricing) and a source='static' row (a media-routing seed); NEITHER appears in
    // any live list below — a refresh must leave both alone.
    store.upsert({
      providerId,
      modelId: 'user-priced',
      displayName: 'User Priced',
      contextWindowTokens: 8000,
      maxOutputTokens: 4000,
      source: 'user',
    });
    // Distinctive pricing set directly (upsert doesn't expose the text-token cost columns) to prove preservation.
    client.sqlite
      .prepare('UPDATE model_catalog SET input_cost_per_mtok_microcents = ? WHERE model_id = ?')
      .run(1234, 'user-priced');
    store.upsert({
      providerId,
      modelId: 'seeded-generative',
      displayName: 'Seeded Generative',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative', // source defaults to 'static'
    });

    // First refresh: models a + b.
    store.replaceProviderModels(
      providerId,
      [
        { modelId: 'model-a', displayName: 'A', contextWindowTokens: 1000, maxOutputTokens: 500 },
        { modelId: 'model-b', displayName: 'B', contextWindowTokens: 2000, maxOutputTokens: 800 },
      ],
      T1,
    );
    expect(store.listByProvider(providerId).map((m) => m.modelId)).toEqual([
      'model-a',
      'model-b',
      'seeded-generative',
      'user-priced',
    ]);
    const bIdBefore = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'model-b'))
      .get()?.id;

    // Second refresh: a stays (updated in place), b vanishes, c appears.
    store.replaceProviderModels(
      providerId,
      [
        { modelId: 'model-a', displayName: 'A2', contextWindowTokens: 1500, maxOutputTokens: 600 },
        { modelId: 'model-c', displayName: 'C', contextWindowTokens: 3000, maxOutputTokens: 900 },
      ],
      T2,
    );
    // b soft-deactivated ⇒ absent from the active listing; user + static rows still present.
    expect(store.listByProvider(providerId).map((m) => m.modelId)).toEqual([
      'model-a',
      'model-c',
      'seeded-generative',
      'user-priced',
    ]);
    const a = store.listByProvider(providerId).find((m) => m.modelId === 'model-a');
    expect(a?.displayName).toBe('A2'); // updated in place
    expect(a?.contextWindowTokens).toBe(1500);
    expect(a?.lastRefreshedAt).toBe(T2);

    // b was NOT hard-deleted — same row still exists, just deactivated (deleted_at still NULL, source live).
    const bRow = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'model-b'))
      .get();
    expect(bRow?.id).toBe(bIdBefore);
    expect(bRow?.isActive).toBe(false);
    expect(bRow?.deletedAt).toBeNull();
    expect(bRow?.source).toBe('live');

    // user + static rows preserved: source unchanged, active, pricing + media routing intact.
    const userRow = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'user-priced'))
      .get();
    expect(userRow?.source).toBe('user');
    expect(userRow?.isActive).toBe(true);
    expect(userRow?.inputCostPerMtokMicrocents).toBe(1234);
    const staticRow = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'seeded-generative'))
      .get();
    expect(staticRow?.source).toBe('static');
    expect(staticRow?.isActive).toBe(true);
    expect(store.resolveMediaSurface('seeded-generative')).toBe('generative');

    // Third refresh: b REAPPEARS ⇒ reactivated, reusing the SAME row id (FK stability), not a duplicate insert.
    store.replaceProviderModels(
      providerId,
      [
        { modelId: 'model-a', displayName: 'A3', contextWindowTokens: 1500, maxOutputTokens: 600 },
        {
          modelId: 'model-b',
          displayName: 'B-back',
          contextWindowTokens: 2222,
          maxOutputTokens: 811,
        },
        { modelId: 'model-c', displayName: 'C', contextWindowTokens: 3000, maxOutputTokens: 900 },
      ],
      T3,
    );
    const bReactivated = store.listByProvider(providerId).find((m) => m.modelId === 'model-b');
    expect(bReactivated?.displayName).toBe('B-back');
    expect(bReactivated?.lastRefreshedAt).toBe(T3);
    const bRows = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'model-b'))
      .all();
    expect(bRows).toHaveLength(1); // reused, not duplicated
    expect(bRows[0]?.id).toBe(bIdBefore);
  });

  it('never clobbers an existing user/static row even when the live list names the same model id (the collision invariant)', () => {
    store.upsert({
      providerId,
      modelId: 'shared-id-user',
      displayName: 'User Row',
      contextWindowTokens: 8000,
      maxOutputTokens: 4000,
      source: 'user',
    });
    client.sqlite
      .prepare('UPDATE model_catalog SET input_cost_per_mtok_microcents = ? WHERE model_id = ?')
      .run(999, 'shared-id-user');
    store.upsert({
      providerId,
      modelId: 'shared-id-static',
      displayName: 'Static Seed',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      capabilities: { media: { outputCombinations: [['image']] } },
    });

    const REFRESH_TS = TS_MS + 5000;
    // The live list NAMES both existing ids (a collision) plus a genuinely new one.
    store.replaceProviderModels(
      providerId,
      [
        {
          modelId: 'shared-id-user',
          displayName: 'LIVE Overwrite Attempt',
          contextWindowTokens: 111,
          maxOutputTokens: 22,
        },
        {
          modelId: 'shared-id-static',
          displayName: 'LIVE Overwrite Attempt',
          contextWindowTokens: 111,
          maxOutputTokens: 22,
        },
        {
          modelId: 'brand-new-live',
          displayName: 'New',
          contextWindowTokens: 500,
          maxOutputTokens: 200,
        },
      ],
      REFRESH_TS,
    );

    // The user row is untouched: source, pricing, display, context all preserved; no refresh stamp.
    const userRow = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'shared-id-user'))
      .get();
    expect(userRow?.source).toBe('user');
    expect(userRow?.displayName).toBe('User Row');
    expect(userRow?.inputCostPerMtokMicrocents).toBe(999);
    expect(userRow?.contextWindowTokens).toBe(8000);
    expect(userRow?.lastRefreshedAt).toBeNull();

    // The static media-seed row is untouched: media routing intact.
    const staticRow = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'shared-id-static'))
      .get();
    expect(staticRow?.source).toBe('static');
    expect(staticRow?.mediaSurface).toBe('generative');
    expect(staticRow?.displayName).toBe('Static Seed');
    expect(store.resolveMediaSurface('shared-id-static')).toBe('generative');

    // Only the genuinely new id becomes a live row.
    const brandNew = store.listByProvider(providerId).find((m) => m.modelId === 'brand-new-live');
    expect(brandNew?.source).toBe('live');
    expect(brandNew?.lastRefreshedAt).toBe(REFRESH_TS);
  });

  it('providerRefreshedAt returns the max live stamp, or undefined when no live rows exist', () => {
    expect(store.providerRefreshedAt(providerId)).toBeUndefined(); // empty provider
    // A static seed alone does NOT count — only source='live' rows contribute.
    store.upsert({
      providerId,
      modelId: 'seed',
      displayName: 'Seed',
      contextWindowTokens: 100,
      maxOutputTokens: 50,
    });
    expect(store.providerRefreshedAt(providerId)).toBeUndefined();
    const T1 = TS_MS + 1000;
    store.replaceProviderModels(providerId, [{ modelId: 'm1', displayName: 'M1' }], T1);
    expect(store.providerRefreshedAt(providerId)).toBe(T1);
    const T2 = TS_MS + 9999;
    store.replaceProviderModels(
      providerId,
      [
        { modelId: 'm1', displayName: 'M1' },
        { modelId: 'm2', displayName: 'M2' },
      ],
      T2,
    );
    expect(store.providerRefreshedAt(providerId)).toBe(T2);
  });

  it('an empty live list soft-deactivates all of a provider live rows (never touches user/static)', () => {
    store.upsert({
      providerId,
      modelId: 'keep-static',
      displayName: 'Keep',
      contextWindowTokens: 100,
      maxOutputTokens: 50,
    });
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'gone', displayName: 'Gone', contextWindowTokens: 1, maxOutputTokens: 1 }],
      TS_MS + 1,
    );
    expect(store.listByProvider(providerId).map((m) => m.modelId)).toEqual(['gone', 'keep-static']);
    // A refresh returning nothing — the whole live set vanishes; the static row survives.
    store.replaceProviderModels(providerId, [], TS_MS + 2);
    expect(store.listByProvider(providerId).map((m) => m.modelId)).toEqual(['keep-static']);
    expect(store.providerRefreshedAt(providerId)).toBeUndefined(); // no active live rows left
  });

  it('listAll spans providers, active + non-deleted only, ordered by model id', () => {
    const otherProviderId = providerStore.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    }).id;
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'zzz-openai', displayName: 'Z' }],
      TS_MS + 1,
    );
    store.replaceProviderModels(
      otherProviderId,
      [{ modelId: 'aaa-claude', displayName: 'A' }],
      TS_MS + 1,
    );
    expect(store.listAll().map((m) => m.modelId)).toEqual(['aaa-claude', 'zzz-openai']);
  });

  it('fail-closed: a tampered source value degrades to static at the read boundary (coerceModelCatalogSource)', () => {
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'm1', displayName: 'M1', contextWindowTokens: 100, maxOutputTokens: 50 }],
      TS_MS + 1,
    );
    client.sqlite.prepare("UPDATE model_catalog SET source = 'bogus' WHERE model_id = ?").run('m1');
    expect(store.listByProvider(providerId).find((m) => m.modelId === 'm1')?.source).toBe('static');
  });

  it('the media-routing reader is unaffected by a coexisting live refresh', () => {
    store.upsert({
      providerId,
      modelId: 'imagen',
      displayName: 'Imagen',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      mediaImageCostMicrocents: 5000,
    });
    store.replaceProviderModels(
      providerId,
      [
        {
          modelId: 'text-model',
          displayName: 'Text',
          contextWindowTokens: 1000,
          maxOutputTokens: 500,
        },
      ],
      TS_MS + 1,
    );
    expect(store.resolveMediaSurface('imagen')).toBe('generative');
    expect(store.resolveMediaSurface('text-model')).toBe('chat'); // a live row defaults to the chat surface
    const rec = store.getByModelId('imagen');
    expect(rec?.mediaSurface).toBe('generative');
    expect(rec?.mediaImageCostMicrocents).toBe(5000);
  });
});
