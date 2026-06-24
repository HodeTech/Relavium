import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createModelCatalogStore, type ModelCatalogStore } from './model-catalog-store.js';
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
    expect(rows.length).toBe(1);
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
    expect(both.length).toBe(2);
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

  it('fail-closed: a non-object capabilities value aborts the read loudly', () => {
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
    expect(() => store.getByModelId('gpt-image-1')).toThrow(TypeError);
    // resolveMediaSurface does not parse capabilities, so it stays usable for routing.
    expect(store.resolveMediaSurface('gpt-image-1')).toBe('chat');
    // A genuinely malformed (non-JSON) value takes the distinct JSON.parse-throws branch (SyntaxError) — also
    // fail-closed, so a refactor that swallowed the parse error would be caught here too.
    client.sqlite
      .prepare("UPDATE model_catalog SET capabilities = '{' WHERE model_id = ?")
      .run('gpt-image-1');
    expect(() => store.getByModelId('gpt-image-1')).toThrow(SyntaxError);
  });
});
