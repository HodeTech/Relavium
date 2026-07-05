import { randomUUID } from 'node:crypto';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type Db,
  type DbClient,
} from '@relavium/db';
import type { LlmProvider, ModelListing, ProviderId } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { KNOWN_PROVIDERS } from './providers.js';
import { createModelRefreshService, TTL_MS, type ModelRefreshDeps } from './model-refresh.js';

/**
 * S5 refresh-orchestrator tests (ADR-0064 §5). All NETWORK-FREE: a stub resolver whose `listModels` returns
 * canned {@link ModelListing}s or throws, over a real in-memory `history.db` (so the store diff / TTL / FK
 * ordering are exercised end-to-end). Asserts per-provider isolation, the skip statuses, the added/updated/
 * deactivated diff, the TTL, and — the security invariant — that no provider key ever appears in a report.
 */

const SECRET_KEY = 'sk-super-secret-key-value';

/** A minimal {@link LlmProvider} — only `id` + the optional `listModels` matter to the refresh; the required
 *  seam methods throw (never reached here). No `any` / unsafe `as`: the object satisfies the interface. */
function stubProvider(id: ProviderId, listModels?: LlmProvider['listModels']): LlmProvider {
  return {
    id,
    generate: () => Promise.reject(new Error('stub generate not used')),
    stream: () => {
      throw new Error('stub stream not used');
    },
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    ...(listModels === undefined ? {} : { listModels }),
  };
}

/** A resolver stub: `adapters[id]` is the (keyless) adapter; `keys[id]` is that provider's key (absent ⇒ throw). */
function stubResolver(config: {
  readonly adapters: Partial<Record<ProviderId, LlmProvider>>;
  readonly keys: Partial<Record<ProviderId, string>>;
}): Pick<ModelRefreshDeps, 'resolveProvider' | 'keyFor'> {
  return {
    resolveProvider: (id) => config.adapters[id],
    keyFor: (id) => {
      const key = config.keys[id];
      if (key === undefined) {
        throw new Error(`no key for ${id}`);
      }
      return key;
    },
  };
}

/** A single canned listing. */
function listing(id: string, contextWindowTokens?: number): ModelListing {
  return {
    id,
    displayName: id,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
}

describe('createModelRefreshService', () => {
  let client: DbClient;
  let db: Db;
  const nowRef = { value: 1_700_000_000_000 };

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    db = client.db;
    nowRef.value = 1_700_000_000_000;
  });
  afterEach(() => {
    client.sqlite.close();
  });

  function service(
    resolver: Pick<ModelRefreshDeps, 'resolveProvider' | 'keyFor'>,
    ids: ProviderId[],
  ) {
    const storeDeps = { uuid: () => randomUUID(), now: () => nowRef.value };
    const providerStore = createProviderStore(db, storeDeps);
    const catalogStore = createModelCatalogStore(db, storeDeps);
    const svc = createModelRefreshService({
      resolveProvider: resolver.resolveProvider,
      keyFor: resolver.keyFor,
      providerStore,
      catalogStore,
      knownProviderIds: ids,
      knownProviders: KNOWN_PROVIDERS,
      now: () => nowRef.value,
    });
    return { svc, providerStore, catalogStore };
  }

  it('isolates a per-provider failure — one provider throws, the others still refresh', async () => {
    const resolver = stubResolver({
      adapters: {
        anthropic: stubProvider('anthropic', () =>
          Promise.reject(new Error('anthropic list failed')),
        ),
        openai: stubProvider('openai', () => Promise.resolve([listing('gpt-x', 100)])),
      },
      keys: { anthropic: SECRET_KEY, openai: SECRET_KEY },
    });
    const { svc, catalogStore } = service(resolver, ['anthropic', 'openai']);

    const report = await svc.refresh();
    const byId = new Map(report.providers.map((p) => [p.provider, p]));
    expect(byId.get('anthropic')?.status).toBe('failed');
    expect(byId.get('anthropic')?.error).toBe('anthropic list failed');
    expect(byId.get('openai')).toMatchObject({ status: 'refreshed', added: 1 });
    // openai still wrote its row despite anthropic failing.
    expect(catalogStore.listAll().map((m) => m.modelId)).toEqual(['gpt-x']);
  });

  it('skips a provider with no resolvable key (skipped-no-key, not an error)', async () => {
    const resolver = stubResolver({
      adapters: { openai: stubProvider('openai', () => Promise.resolve([listing('gpt-x')])) },
      keys: { openai: SECRET_KEY }, // anthropic has no key
    });
    const { svc } = service(resolver, ['anthropic', 'openai']);

    const report = await svc.refresh();
    const byId = new Map(report.providers.map((p) => [p.provider, p]));
    expect(byId.get('anthropic')?.status).toBe('skipped-no-key');
    expect(byId.get('openai')?.status).toBe('refreshed');
  });

  it('skips a connected provider whose adapter has no listModels (skipped-unsupported)', async () => {
    const resolver = stubResolver({
      adapters: { gemini: stubProvider('gemini') }, // adapter present but no listModels
      keys: { gemini: SECRET_KEY },
    });
    const { svc, catalogStore } = service(resolver, ['gemini']);

    const report = await svc.refresh();
    expect(report.providers).toEqual([{ provider: 'gemini', status: 'skipped-unsupported' }]);
    expect(catalogStore.listAll()).toEqual([]);
  });

  it('reports added / updated / deactivated across two refreshes', async () => {
    let models: ModelListing[] = [listing('m1'), listing('m2'), listing('m3')];
    const resolver = stubResolver({
      adapters: { openai: stubProvider('openai', () => Promise.resolve(models)) },
      keys: { openai: SECRET_KEY },
    });
    const { svc } = service(resolver, ['openai']);

    const first = await svc.refresh();
    expect(first.providers[0]).toMatchObject({
      status: 'refreshed',
      added: 3,
      updated: 0,
      deactivated: 0,
    });

    // Drop m3, keep m1/m2, add m4.
    models = [listing('m1'), listing('m2'), listing('m4')];
    const second = await svc.refresh();
    expect(second.providers[0]).toMatchObject({
      status: 'refreshed',
      added: 1,
      updated: 2,
      deactivated: 1,
    });
  });

  it('counts only the LIVE delta — a source=static / source=user row is excluded (FIX 5a)', async () => {
    let models: ModelListing[] = [listing('m1'), listing('m2')];
    const resolver = stubResolver({
      adapters: { openai: stubProvider('openai', () => Promise.resolve(models)) },
      keys: { openai: SECRET_KEY },
    });
    const { svc, providerStore, catalogStore } = service(resolver, ['openai']);

    // Seed a static (media-routing) row and a user (pricing) row for the SAME provider BEFORE any refresh; a live
    // refresh must NEVER count them in its added/updated/deactivated diff (they are provenance-protected — S4).
    const providerUuid = providerStore.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
    }).id;
    catalogStore.upsert({
      providerId: providerUuid,
      modelId: 'static-model',
      displayName: 'Static',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      source: 'static',
    });
    catalogStore.upsert({
      providerId: providerUuid,
      modelId: 'user-model',
      displayName: 'User',
      contextWindowTokens: 1000,
      maxOutputTokens: 100,
      source: 'user',
    });

    // First refresh: two LIVE models. added=2, updated=0, deactivated=0. Without the `source==='live'` filter in
    // `liveModelIds`, the pre-existing static/user rows would be counted as "updated" (→ 2) — so this pins it.
    const first = await svc.refresh();
    expect(first.providers[0]).toMatchObject({
      status: 'refreshed',
      added: 2,
      updated: 0,
      deactivated: 0,
    });

    // Second refresh: drop m1, keep m2, add m3. added=1, updated=1 (only m2), deactivated=1 (only m1) — the
    // static/user rows stay out of every count (without the filter, `updated` would be 3).
    models = [listing('m2'), listing('m3')];
    const second = await svc.refresh();
    expect(second.providers[0]).toMatchObject({
      status: 'refreshed',
      added: 1,
      updated: 1,
      deactivated: 1,
    });

    // The static + user rows survived every live refresh (never deactivated).
    const ids = catalogStore.listByProvider(providerUuid).map((m) => m.modelId);
    expect(ids).toContain('static-model');
    expect(ids).toContain('user-model');
  });

  it('refreshIfStale refreshes on an empty cache, no-ops within the TTL, and refreshes again once stale', async () => {
    const resolver = stubResolver({
      adapters: { openai: stubProvider('openai', () => Promise.resolve([listing('m1')])) },
      keys: { openai: SECRET_KEY },
    });
    const { svc } = service(resolver, ['openai']);

    // Never-refreshed (empty) ⇒ stale ⇒ refreshes.
    const first = await svc.refreshIfStale();
    expect(first?.providers[0]?.status).toBe('refreshed');

    // Same clock ⇒ fresh ⇒ undefined (nothing stale).
    expect(await svc.refreshIfStale()).toBeUndefined();

    // Just under the TTL ⇒ still fresh.
    nowRef.value += TTL_MS - 1;
    expect(await svc.refreshIfStale()).toBeUndefined();

    // At/after the TTL ⇒ stale ⇒ refreshes again.
    nowRef.value += 1;
    const third = await svc.refreshIfStale();
    expect(third?.providers[0]?.status).toBe('refreshed');
  });

  it('bounds re-egress: refreshIfStale does NOT re-attempt a FAILED provider within the TTL, but does past it (FIX 3)', async () => {
    let calls = 0;
    const resolver = stubResolver({
      adapters: {
        openai: stubProvider('openai', () => {
          calls += 1;
          return Promise.reject(new Error('bad key'));
        }),
      },
      keys: { openai: SECRET_KEY },
    });
    const { svc } = service(resolver, ['openai']);

    // First refreshIfStale: empty cache ⇒ stale ⇒ attempts ⇒ FAILS. It writes NO live row, so
    // `providerRefreshedAt` stays undefined — the failure mode ADR-0064 §5c warns re-egresses on every trigger.
    const first = await svc.refreshIfStale();
    expect(first?.providers[0]?.status).toBe('failed');
    expect(calls).toBe(1);

    // Within the TTL: `providerRefreshedAt` is still undefined, but the in-service last-ATTEMPT stamp bounds it
    // ⇒ NOT stale ⇒ NO re-attempt (`listModels` call count unchanged).
    nowRef.value += TTL_MS - 1;
    expect(await svc.refreshIfStale()).toBeUndefined();
    expect(calls).toBe(1);

    // Past the TTL: the attempt stamp is now stale ⇒ re-attempts exactly once more.
    nowRef.value += 1;
    const third = await svc.refreshIfStale();
    expect(third?.providers[0]?.status).toBe('failed');
    expect(calls).toBe(2);

    // An explicit `refresh()` is NOT bounded — it always re-attempts (only background/if-stale is throttled).
    const forced = await svc.refresh();
    expect(forced.providers[0]?.status).toBe('failed');
    expect(calls).toBe(3);
  });

  it('never leaks a provider key — redacts the key in the error message AND never reads the cause (FIX 5b)', async () => {
    const resolver = stubResolver({
      adapters: {
        anthropic: stubProvider('anthropic', () =>
          // A NON-seam / raw adapter error that embeds the key in BOTH its `message` AND a key-bearing `cause`
          // (the real seam would redact first — this proves the SERVICE defends regardless): `secretFreeReason`
          // must redact the message occurrence AND never fold `cause` into the report.
          Promise.reject(
            new Error(`auth failed for key ${SECRET_KEY}`, {
              cause: new Error(`nested token=${SECRET_KEY}`),
            }),
          ),
        ),
        openai: stubProvider('openai', () => Promise.resolve([listing('gpt-x')])),
      },
      keys: { anthropic: SECRET_KEY, openai: SECRET_KEY },
    });
    const { svc } = service(resolver, ['anthropic', 'openai']);

    const report = await svc.refresh();
    const failed = report.providers.find((p) => p.provider === 'anthropic');
    expect(failed?.status).toBe('failed');
    // Neither the whole report nor the specific `.error` field carries the secret (message redacted, cause dropped).
    expect(JSON.stringify(report)).not.toContain(SECRET_KEY);
    expect(failed?.error ?? '').not.toContain(SECRET_KEY);
  });

  it('refreshInBackground never throws and swallows a rejecting refresh', async () => {
    // providerStore.get throws inside refreshIfStale ⇒ the refresh promise rejects ⇒ the fire-and-forget `.catch`
    // swallows it (no unhandled rejection, no thrown stack).
    const svc = createModelRefreshService({
      resolveProvider: () => stubProvider('openai', () => Promise.resolve([])),
      keyFor: () => SECRET_KEY,
      providerStore: {
        upsert: () => ({ id: 'u' }),
        get: () => {
          throw new Error('db unavailable');
        },
      },
      catalogStore: {
        replaceProviderModels: () => {},
        listByProvider: () => [],
        providerRefreshedAt: () => undefined,
      },
      knownProviderIds: ['openai'],
      knownProviders: KNOWN_PROVIDERS,
      now: () => 0,
    });

    expect(() => svc.refreshInBackground()).not.toThrow();
    // Let the rejected promise settle; the `.catch` must have handled it (an unhandled rejection would fail CI).
    await Promise.resolve();
    await Promise.resolve();
  });
});
