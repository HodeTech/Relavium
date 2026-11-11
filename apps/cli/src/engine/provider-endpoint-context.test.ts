import { createClient, createProviderStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';
import {
  createProviderResolver,
  providerEndpointContext,
  validateProviderKey,
} from './providers.js';
import type { FetchLike } from './validated-fetch.js';

it.each([
  'https://synthetic-user:synthetic-password@gateway.example/v1?private=query',
  'https://127.0.0.1/v1',
  'not-a-url-with-private-configuration',
])('refuses an invalid stored destination without reflecting it in setup: %s', async (baseUrl) => {
  const client = createClient(':memory:');
  runMigrations(client.db);
  try {
    const store = createProviderStore(client.db, { uuid: () => 'provider', now: () => 1 });
    store.upsert({ name: 'openai', displayName: 'OpenAI', kind: 'openai-compatible', baseUrl });
    const fetch = vi.fn<FetchLike>(() => Promise.reject(new Error('Unexpected egress')));
    const resolver = createProviderResolver({}, undefined, {
      providerStore: store,
      validatedFetch: fetch,
    });
    expect(providerEndpointContext(resolver, 'openai')).toBe(
      'Custom endpoint configuration is invalid.',
    );
    const adapter = resolver.resolveProvider('openai');
    if (adapter === undefined) throw new Error('Missing refusing adapter');
    expect((await validateProviderKey(adapter, 'synthetic-key', 'gpt-4o-mini')).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    client.sqlite.close();
  }
});
