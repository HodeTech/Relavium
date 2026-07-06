import { eq, sql } from 'drizzle-orm';
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
    expect(b.defaultHeaders).toEqual({}); // not double-encoded into a "{}" string on update
    expect(store.list()).toHaveLength(1);
  });

  it('preserves non-empty defaultHeaders verbatim across an update that omits them', () => {
    store.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      defaultHeaders: { 'x-org': 'acme', 'x-beta': 'on' },
    });
    // An update that omits defaultHeaders must keep the stored object — never drop it, never re-encode
    // the already-JSON string into a `"{...}"` string (the regression fixed in 8ae794c).
    const b = store.upsert({
      name: 'openai',
      displayName: 'OpenAI (proxied)',
      baseUrl: 'https://proxy.example/v1',
    });
    expect(b.defaultHeaders).toEqual({ 'x-org': 'acme', 'x-beta': 'on' });
    expect(typeof b.defaultHeaders).toBe('object'); // a parsed object, not a double-encoded string
  });

  it('round-trips the provider kind + pricingReferenceUrl, preserving them on an update that omits them (ADR-0065 §5)', () => {
    store.upsert({
      name: 'deepseek',
      displayName: 'DeepSeek',
      baseUrl: 'https://my-proxy.example/v1',
      kind: 'openai-compatible',
      pricingReferenceUrl: 'https://prices.example',
    });
    const got = store.get('deepseek');
    expect(got?.kind).toBe('openai-compatible');
    expect(got?.pricingReferenceUrl).toBe('https://prices.example');
    // An update that omits kind / pricingReferenceUrl keeps the stored values (like defaultHeaders).
    const updated = store.upsert({
      name: 'deepseek',
      displayName: 'DeepSeek (proxied)',
      baseUrl: 'https://my-proxy.example/v1',
    });
    expect(updated.kind).toBe('openai-compatible');
    expect(updated.pricingReferenceUrl).toBe('https://prices.example');
  });

  it('reads an absent kind / pricingReferenceUrl as undefined (a plain add omits them)', () => {
    store.upsert({ name: 'anthropic', displayName: 'Anthropic', baseUrl: 'https://api.anthropic.com' });
    const got = store.get('anthropic');
    expect(got?.kind).toBeUndefined();
    expect(got?.pricingReferenceUrl).toBeUndefined();
  });

  it('coerces a FOREIGN stored kind to undefined at the read boundary (fail-closed, no DB CHECK)', () => {
    const rec = store.upsert({ name: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    // Simulate a tampered/foreign value written outside the typed setter (no DB CHECK on the ALTER-ADD column).
    client.db.run(sql`update llm_providers set kind = 'rogue-protocol' where id = ${rec.id}`);
    expect(store.get('openai')?.kind).toBeUndefined(); // a non-PROVIDER_KINDS value is never trusted
  });

  it('preserves createdAt and advances updatedAt on update', () => {
    let clock = 1_000;
    const timed = createProviderStore(client.db, {
      uuid: () => '00000000-0000-4000-8000-000000000abc',
      now: () => clock,
    });
    const a = timed.upsert({ name: 'gemini', displayName: 'Gemini', baseUrl: 'https://g.example' });
    clock = 2_000;
    const b = timed.upsert({
      name: 'gemini',
      displayName: 'Gemini 2',
      baseUrl: 'https://g.example',
    });
    expect(b.createdAt).toBe(a.createdAt); // createdAt is never clobbered on update
    expect(new Date(b.updatedAt).getTime()).toBeGreaterThan(new Date(a.updatedAt).getTime());
  });

  it('rejects a corrupt default_headers value at the read boundary (loud, not silent)', () => {
    store.upsert({ name: 'openai', displayName: 'OpenAI', baseUrl: 'https://api.openai.com/v1' });
    // Simulate a corrupt/foreign-shaped column (a direct edit / bad migration) — the read must abort.
    client.db
      .update(llmProviders)
      .set({ defaultHeaders: '["not","an","object"]' })
      .where(eq(llmProviders.name, 'openai'))
      .run();
    expect(() => store.get('openai')).toThrowError(/not a JSON object/);
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
