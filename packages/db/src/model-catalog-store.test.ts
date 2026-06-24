import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { createModelCatalogStore, type ModelCatalogStore } from './model-catalog-store.js';
import { createProviderStore } from './provider-store.js';

const TS_MS = new Date('2026-06-25T12:00:00.000Z').getTime();

describe('createModelCatalogStore (2.S — media routing + load-check reader)', () => {
  let client: DbClient;
  let store: ModelCatalogStore;
  let providerId: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    let n = 0;
    const deps = {
      uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      now: () => TS_MS,
    };
    // model_catalog.provider_id is an FK into llm_providers — seed a provider first.
    providerId = createProviderStore(client.db, deps).upsert({
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
    // Same logical row updated in place (one active row for the model id).
    const rows = client.sqlite
      .prepare('SELECT COUNT(*) AS c FROM model_catalog WHERE model_id = ?')
      .get('gpt-image-1') as { c: number };
    expect(rows.c).toBe(1);
    expect(b.modelId).toBe(a.modelId);
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
