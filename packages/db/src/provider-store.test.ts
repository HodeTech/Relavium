import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createClient, runMigrations, type DbClient } from './client.js';
import { llmProviders } from './schema.js';
import { createProviderStore, type ProviderStore } from './provider-store.js';

const TS_MS = new Date('2026-06-23T12:00:00.000Z').getTime();

describe('createProviderStore', () => {
  let client: DbClient;
  let store: ProviderStore;
  let next: number;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    next = 0;
    store = createProviderStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
      now: () => TS_MS,
    });
  });

  afterEach(() => {
    client.sqlite.close();
  });

  it('upserts a provider row and reads it back', () => {
    const rec = store.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(rec.name).toBe('anthropic');
    expect(rec.baseUrl).toBe('https://api.anthropic.com');
    expect(rec.apiKeyKeychainRef).toBeUndefined(); // no key set yet
    expect(store.get('anthropic')?.id).toBe(rec.id);
  });

  it('upsert is idempotent by name (updates, never duplicates)', () => {
    const a = store.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    });
    const b = store.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(b.id).toBe(a.id); // same row
    expect(b.baseUrl).toBe('https://proxy.example/v1'); // updated
    expect(store.list()).toHaveLength(1);
  });

  it('records and clears the keychain ref — and NEVER stores a key value', () => {
    store.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    store.setKeychainRef('anthropic', 'anthropic:default');
    expect(store.get('anthropic')?.apiKeyKeychainRef).toBe('anthropic:default');

    // The raw row holds only the ref — the schema has no column for a key value.
    const row = client.db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.name, 'anthropic'))
      .get();
    expect(row?.apiKeyKeychainRef).toBe('anthropic:default');
    expect(JSON.stringify(row)).not.toContain('sk-'); // no key-shaped material anywhere on the row

    store.clearKeychainRef('anthropic');
    expect(store.get('anthropic')?.apiKeyKeychainRef).toBeUndefined(); // ref cleared, row stays registered
    expect(store.get('anthropic')).toBeDefined();
  });

  it('lists active providers by name', () => {
    store.upsert({ name: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    store.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(store.list().map((p) => p.name)).toEqual(['anthropic', 'openai']); // sorted by name
  });
});
