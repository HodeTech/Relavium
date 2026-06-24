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
      mediaImageCostMicrocents: 1_900_000,
    });
    expect(rec.modelId).toBe('gpt-image-1');
    expect(rec.mediaSurface).toBe('generative');
    expect(rec.supportsVision).toBe(true);
    expect(rec.capabilities).toEqual({ media: { outputCombinations: [['image']] } });
    expect(rec.mediaImageCostMicrocents).toBe(1_900_000);
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

  it('is deterministic for a model id offered by two providers (stable asc(createdAt), asc(id) pick)', () => {
    const secondProviderId = providerStore.upsert({
      name: 'azure-openai',
      displayName: 'Azure OpenAI',
      baseUrl: 'https://example.openai.azure.com',
    }).id;
    // Same modelId under both providers, distinct surfaces. The first-inserted catalog row (lower minted id)
    // wins the `asc(createdAt), asc(id)` tiebreaker even though both share the fixed `createdAt`.
    store.upsert({
      providerId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1 (openai)',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'generative',
    });
    store.upsert({
      providerId: secondProviderId,
      modelId: 'gpt-image-1',
      displayName: 'GPT Image 1 (azure)',
      contextWindowTokens: 4096,
      maxOutputTokens: 4096,
      mediaSurface: 'chat',
    });
    // Two co-existing active rows for the model id, but the resolved surface is stable across repeated reads.
    const both = client.db
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.modelId, 'gpt-image-1'))
      .all();
    expect(both.length).toBe(2);
    const surfaces = [0, 1, 2].map(() => store.resolveMediaSurface('gpt-image-1'));
    expect(surfaces).toEqual(['generative', 'generative', 'generative']); // first-inserted (lower id) wins, stably
    expect(store.getByModelId('gpt-image-1')?.providerId).toBe(providerId);
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
  });
});
