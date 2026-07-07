import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.restoreAllMocks();
    client.sqlite.close();
  });

  it('replaceProviderModels opens an IMMEDIATE write transaction (2.5.I — the ADR-0064 §5 concurrent-refresh path)', () => {
    const txnSpy = vi.spyOn(client.db, 'transaction');
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'bare-model', displayName: 'Bare' }],
      TS_MS,
    );
    // The bulk live-upsert reads existing rows then writes — BEGIN IMMEDIATE is what lets two concurrent
    // `relavium` refreshes race the DB write safely (ADR-0064 §5); a DEFERRED begin drops this config arg.
    expect(txnSpy).toHaveBeenCalledWith(expect.any(Function), { behavior: 'immediate' });
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

  it('catalogIdByModelId resolves a model string to its catalog row UUID (the FK target), undefined when uncataloged (ADR-0059)', () => {
    // providerStore.upsert (beforeEach) minted uuid #1; this first catalog upsert mints #2 — so the row's id is
    // deterministic. `catalogIdByModelId` returns THAT id (the `session_messages.model_id` FK target), never the
    // model string; an uncataloged model resolves to undefined (→ a NULL column, the pre-attribution bucket).
    store.upsert({
      providerId,
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindowTokens: 128_000,
      maxOutputTokens: 16_384,
    });
    expect(store.catalogIdByModelId('gpt-4o')).toBe('00000000-0000-4000-8000-000000000002');
    expect(store.catalogIdByModelId('not-in-catalog')).toBeUndefined();
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

  it('RETURNS the atomic added/updated/deactivated tallies (new added, kept updated, vanished deactivated)', () => {
    // First refresh: three brand-new live models ⇒ all counted as added.
    const first = store.replaceProviderModels(
      providerId,
      [
        { modelId: 'm1', displayName: 'M1' },
        { modelId: 'm2', displayName: 'M2' },
        { modelId: 'm3', displayName: 'M3' },
      ],
      TS_MS + 1000,
    );
    expect(first).toEqual({ added: 3, updated: 0, deactivated: 0 });

    // Second refresh: m1/m2 kept (updated in place), m3 vanishes (deactivated), m4 appears (added).
    const second = store.replaceProviderModels(
      providerId,
      [
        { modelId: 'm1', displayName: 'M1 v2' },
        { modelId: 'm2', displayName: 'M2 v2' },
        { modelId: 'm4', displayName: 'M4' },
      ],
      TS_MS + 2000,
    );
    expect(second).toEqual({ added: 1, updated: 2, deactivated: 1 });

    // Third refresh: m3 REAPPEARS ⇒ reactivated in place (counted `updated`, NOT `added`, since the same row id
    // is reused); m1/m2/m4 all vanish ⇒ deactivated:3; nothing brand-new ⇒ added:0.
    const third = store.replaceProviderModels(
      providerId,
      [{ modelId: 'm3', displayName: 'M3 back' }],
      TS_MS + 3000,
    );
    expect(third).toEqual({ added: 0, updated: 1, deactivated: 3 });
  });

  it('the returned tallies count LIVE rows only — a coexisting static/user row is never added/updated/deactivated', () => {
    // Seed a static (media-routing) row and a user (pricing) row BEFORE any refresh.
    store.upsert({
      providerId,
      modelId: 'static-model',
      displayName: 'Static',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      source: 'static',
    });
    store.upsert({
      providerId,
      modelId: 'user-model',
      displayName: 'User',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      source: 'user',
    });

    // First live refresh names two NEW live ids ⇒ added:2, updated:0, deactivated:0 — the static/user rows
    // contribute to NONE of the counts (provenance-protected: never part of the live delta).
    const first = store.replaceProviderModels(
      providerId,
      [
        { modelId: 'live-1', displayName: 'L1' },
        { modelId: 'live-2', displayName: 'L2' },
      ],
      TS_MS + 1000,
    );
    expect(first).toEqual({ added: 2, updated: 0, deactivated: 0 });

    // A refresh whose live list ALSO names the existing static + user ids (a collision) must still not count them:
    // they are provenance-`continue`-skipped (never `updated`), and dropping live-1 deactivates exactly one LIVE
    // row — a store count with no `source='live'` guard would report updated:3 / deactivated including them.
    const second = store.replaceProviderModels(
      providerId,
      [
        { modelId: 'live-2', displayName: 'L2 v2' },
        { modelId: 'static-model', displayName: 'collide' },
        { modelId: 'user-model', displayName: 'collide' },
      ],
      TS_MS + 2000,
    );
    expect(second).toEqual({ added: 0, updated: 1, deactivated: 1 });

    // Both provenance rows survived every refresh (never deactivated by the live delta).
    const ids = store.listByProvider(providerId).map((m) => m.modelId);
    expect(ids).toContain('static-model');
    expect(ids).toContain('user-model');
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

  it('source-rank: a static generative seed wins over a cross-provider live chat row for the same model id (no media shadow)', () => {
    // Provider A holds a source='static' generative media seed for the model id (createdAt = TS_MS).
    store.upsert({
      providerId,
      modelId: 'shared-media-id',
      displayName: 'Static Generative Seed',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    // Provider B publishes a source='live' row (media_surface defaults to 'chat') for the SAME model id, with an
    // EARLIER createdAt so a bare `asc(createdAt)` ordering would resolve to THIS live chat row and shadow the
    // generative seed — silently disabling generateMedia() routing. The source-rank tiebreaker must keep the
    // static seed (rank 0) authoritative over the live row (rank 1) regardless of createdAt.
    const providerB = providerStore.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    }).id;
    store.replaceProviderModels(
      providerB,
      [{ modelId: 'shared-media-id', displayName: 'Live Chat Model' }],
      TS_MS - 1000, // earlier createdAt than the static seed
    );
    // Both rows are active for the shared id; the static seed still wins for BOTH read paths (routing + record).
    expect(store.resolveMediaSurface('shared-media-id')).toBe('generative');
    expect(store.getByModelId('shared-media-id')?.mediaSurface).toBe('generative');
    expect(store.getByModelId('shared-media-id')?.providerId).toBe(providerId);
  });

  it('toListing maps the three text-token cost columns to distinct fields (catches a copy/paste swap)', () => {
    store.upsert({
      providerId,
      modelId: 'priced-model',
      displayName: 'Priced',
      contextWindowTokens: 8000,
      maxOutputTokens: 4000,
      source: 'user',
    });
    // `upsert` does not expose the text-token cost columns; set DISTINCT non-zero µ¢ directly so a swapped
    // (e.g. output←input) column mapping in `toListing` reads a different value and fails — mirroring the
    // media-cost columns' distinct-value discipline. Read them back THROUGH the listing path (not raw drizzle).
    client.sqlite
      .prepare(
        'UPDATE model_catalog SET input_cost_per_mtok_microcents = ?, output_cost_per_mtok_microcents = ?, cached_input_cost_per_mtok_microcents = ? WHERE model_id = ?',
      )
      .run(1234, 5678, 42, 'priced-model');
    const listing = store.listByProvider(providerId).find((m) => m.modelId === 'priced-model');
    expect(listing?.inputCostPerMtokMicrocents).toBe(1234);
    expect(listing?.outputCostPerMtokMicrocents).toBe(5678);
    expect(listing?.cachedInputCostPerMtokMicrocents).toBe(42);
  });

  it('providerRefreshedAt isolates by provider and ignores non-live rows', () => {
    const providerB = providerStore.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    }).id;
    const TA = TS_MS + 1000;
    const TB = TS_MS + 7777;
    store.replaceProviderModels(providerId, [{ modelId: 'a1', displayName: 'A1' }], TA);
    store.replaceProviderModels(providerB, [{ modelId: 'b1', displayName: 'B1' }], TB);
    // Cross-provider isolation: each provider reports ITS OWN max live stamp (the providerId filter). Dropping
    // that filter would return the global max (TB) for provider A.
    expect(store.providerRefreshedAt(providerId)).toBe(TA);
    expect(store.providerRefreshedAt(providerB)).toBe(TB);

    // A non-live row must NOT contribute even if it carries an (injected) last_refreshed_at newer than any live
    // stamp — the source='live' filter excludes it. Provider A still reports its live max (TA), not the injection.
    store.upsert({
      providerId,
      modelId: 'static-seed',
      displayName: 'Static',
      contextWindowTokens: 100,
      maxOutputTokens: 50,
    });
    client.sqlite
      .prepare('UPDATE model_catalog SET last_refreshed_at = ? WHERE model_id = ?')
      .run(TS_MS + 999_999, 'static-seed');
    expect(store.providerRefreshedAt(providerId)).toBe(TA);

    // A provider whose ONLY row is non-live (even carrying an injected stamp) has no live max ⇒ undefined,
    // not the injected non-live stamp.
    const providerC = providerStore.upsert({
      name: 'gemini',
      displayName: 'Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
    }).id;
    store.upsert({
      providerId: providerC,
      modelId: 'c-static',
      displayName: 'C Static',
      contextWindowTokens: 100,
      maxOutputTokens: 50,
    });
    client.sqlite
      .prepare('UPDATE model_catalog SET last_refreshed_at = ? WHERE model_id = ?')
      .run(TS_MS + 555, 'c-static');
    expect(store.providerRefreshedAt(providerC)).toBeUndefined();
  });

  it('toListing surfaces a non-null deprecationDate (the positive branch, distinct from other timestamps)', () => {
    const REFRESH_TS = TS_MS + 60_000;
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'soon-gone', displayName: 'Soon Gone' }],
      REFRESH_TS,
    );
    // A DISTINCTIVE deprecation epoch-ms, distinct from createdAt (REFRESH_TS) and lastRefreshedAt (REFRESH_TS)
    // so a `toListing` mapping that read created_at/last_refreshed_at by mistake reads a different value and fails.
    const DEPRECATION_TS = TS_MS + 424_242;
    client.sqlite
      .prepare('UPDATE model_catalog SET deprecation_date = ? WHERE model_id = ?')
      .run(DEPRECATION_TS, 'soon-gone');
    const listing = store.listByProvider(providerId).find((m) => m.modelId === 'soon-gone');
    expect(listing?.deprecationDate).toBe(DEPRECATION_TS);
  });

  it('upsert() does NOT demote an existing live row: source/lastRefreshedAt preserved when omitted', () => {
    const REFRESH_TS = TS_MS + 12_345;
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'was-live', displayName: 'Was Live' }],
      REFRESH_TS,
    );
    // A provider-sync-style upsert that patches display fields but OMITS source/lastRefreshedAt must not
    // demote the live row back to 'static' or null its stamp (the "never clobber" invariant).
    store.upsert({
      providerId,
      modelId: 'was-live',
      displayName: 'Was Live (patched)',
      contextWindowTokens: 200,
      maxOutputTokens: 100,
    });
    const patched = store.listByProvider(providerId).find((m) => m.modelId === 'was-live');
    expect(patched?.source).toBe('live'); // NOT demoted to 'static'
    expect(patched?.lastRefreshedAt).toBe(REFRESH_TS); // stamp preserved, not nulled
    expect(store.providerRefreshedAt(providerId)).toBe(REFRESH_TS); // still counted as a live row
    // ...while a TRUE insert still defaults to static / never-refreshed
    store.upsert({
      providerId,
      modelId: 'fresh-static',
      displayName: 'Fresh',
      contextWindowTokens: 1,
      maxOutputTokens: 1,
    });
    const fresh = store.listByProvider(providerId).find((m) => m.modelId === 'fresh-static');
    expect(fresh?.source).toBe('static');
    expect(fresh?.lastRefreshedAt).toBeUndefined();
  });

  it('upsert() PRESERVES media_surface / capabilities / supportsVision + cost columns when omitted (the S10 clobber fix)', () => {
    // Seed a full generative/media row (as the media fixture / a live-then-enriched sync would).
    store.upsert({
      providerId,
      modelId: 'media-then-priced',
      displayName: 'Media Then Priced',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
      supportsVision: true,
      capabilities: { media: { outputCombinations: [['image']] } },
      mediaImageCostMicrocents: 1_900_000,
    });
    // A `models pricing`-style PARTIAL upsert: it writes ONLY the text-token prices + source='user' and omits
    // every media/capability field. The never-clobber invariant must keep the generative routing + capabilities
    // intact (a reset to media_surface='chat' would silently disable generative routing).
    store.upsert({
      providerId,
      modelId: 'media-then-priced',
      displayName: 'Media Then Priced',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      source: 'user',
      inputCostPerMtokMicrocents: 300,
      outputCostPerMtokMicrocents: 900,
    });
    const rec = store.getByModelId('media-then-priced');
    expect(rec?.mediaSurface).toBe('generative'); // NOT reset to 'chat'
    expect(rec?.supportsVision).toBe(true); // NOT reset to false
    expect(rec?.capabilities).toEqual({ media: { outputCombinations: [['image']] } }); // NOT blanked to {}
    expect(rec?.mediaImageCostMicrocents).toBe(1_900_000); // media rate preserved
    const listing = store.listByProvider(providerId).find((m) => m.modelId === 'media-then-priced');
    expect(listing?.source).toBe('user'); // the write DID take (prices applied)
    expect(listing?.inputCostPerMtokMicrocents).toBe(300);
    expect(listing?.outputCostPerMtokMicrocents).toBe(900);

    // ...and a SUBSEQUENT re-price that omits the cost columns preserves the previously-entered prices.
    store.upsert({
      providerId,
      modelId: 'media-then-priced',
      displayName: 'Media Then Priced',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      source: 'user',
      outputCostPerMtokMicrocents: 950, // change ONLY output
    });
    const reListing = store
      .listByProvider(providerId)
      .find((m) => m.modelId === 'media-then-priced');
    expect(reListing?.inputCostPerMtokMicrocents).toBe(300); // preserved
    expect(reListing?.outputCostPerMtokMicrocents).toBe(950); // updated
  });

  it('upsert() distinguishes an OMITTED media cost (preserve) from an explicit null (CLEAR) — the `number | null` contract', () => {
    store.upsert({
      providerId,
      modelId: 'media-cost-clear',
      mediaImageCostMicrocents: 1_900_000,
      mediaAudioCostMicrocents: 2_000_000,
    });
    // OMITTED ⇒ the existing rate is preserved (the never-clobber invariant).
    store.upsert({ providerId, modelId: 'media-cost-clear', source: 'user' });
    const preserved = store.getByModelId('media-cost-clear');
    expect(preserved?.mediaImageCostMicrocents).toBe(1_900_000);
    expect(preserved?.mediaAudioCostMicrocents).toBe(2_000_000);
    // Explicit `null` ⇒ the stored rate is CLEARED (not treated as an omission by `??`), while a still-omitted
    // sibling is preserved.
    store.upsert({
      providerId,
      modelId: 'media-cost-clear',
      mediaImageCostMicrocents: null,
    });
    const cleared = store.getByModelId('media-cost-clear');
    expect(cleared?.mediaImageCostMicrocents).toBeNull(); // an explicit null cleared it
    expect(cleared?.mediaAudioCostMicrocents).toBe(2_000_000); // the omitted sibling survived
  });

  it('a pricing-only upsert PRESERVES the display name + limits of a SOFT-DEACTIVATED row (S10 re-price)', () => {
    // A live refresh discovers the model with a real name + context, then a later refresh drops it → soft-deactivated
    // (isActive=false, source='live', deletedAt=null). The active-only `listByProvider` the command reads can no
    // longer see it, so the pricing upsert must OMIT display/limits and let the store preserve the deactivated row's.
    store.replaceProviderModels(
      providerId,
      [{ modelId: 'vanishing', displayName: 'Vanishing Pro', contextWindowTokens: 128_000 }],
      TS_MS,
    );
    store.replaceProviderModels(providerId, [], TS_MS + 1); // the model vanishes ⇒ soft-deactivated
    expect(store.listByProvider(providerId).find((m) => m.modelId === 'vanishing')).toBeUndefined();
    // Pricing-only upsert (display/limits omitted) — the store finds the deactivated row (deletedAt IS NULL),
    // reactivates it as source='user', and PRESERVES its discovered name/context rather than zeroing them.
    store.upsert({
      providerId,
      modelId: 'vanishing',
      source: 'user',
      inputCostPerMtokMicrocents: 300,
      outputCostPerMtokMicrocents: 900,
    });
    const listing = store.listByProvider(providerId).find((m) => m.modelId === 'vanishing');
    expect(listing?.displayName).toBe('Vanishing Pro'); // NOT zeroed to the id
    expect(listing?.contextWindowTokens).toBe(128_000); // NOT zeroed
    expect(listing?.source).toBe('user');
    expect(listing?.inputCostPerMtokMicrocents).toBe(300);
  });

  it('a brand-new pricing-only upsert (no prior row) defaults displayName → the model id, limits → unknown', () => {
    store.upsert({
      providerId,
      modelId: 'fresh-priced',
      source: 'user',
      inputCostPerMtokMicrocents: 100,
      outputCostPerMtokMicrocents: 200,
    });
    const listing = store.listByProvider(providerId).find((m) => m.modelId === 'fresh-priced');
    expect(listing?.displayName).toBe('fresh-priced'); // defaulted to the id
    expect(listing?.contextWindowTokens).toBeUndefined(); // stored 0 sentinel ⇒ read back as absent
    expect(listing?.maxOutputTokens).toBeUndefined();
  });

  it('listByProvider/listAll exclude a soft-DELETED (deletedAt) row, not just an inactive one', () => {
    store.replaceProviderModels(
      providerId,
      [
        { modelId: 'keep', displayName: 'Keep' },
        { modelId: 'gone', displayName: 'Gone' },
      ],
      TS_MS,
    );
    // soft-DELETE (deletedAt set) 'gone' — a scenario distinct from the isActive=false deactivation path;
    // a refactor that dropped isNull(deletedAt) from the listing queries would otherwise stay green.
    client.sqlite
      .prepare('UPDATE model_catalog SET deleted_at = ? WHERE model_id = ?')
      .run(TS_MS + 1, 'gone');
    expect(store.listByProvider(providerId).map((m) => m.modelId)).toEqual(['keep']);
    expect(store.listAll().map((m) => m.modelId)).toEqual(['keep']);
  });
});
