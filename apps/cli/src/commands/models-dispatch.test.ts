import { tmpdir } from 'node:os';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { LlmProvider, ModelListing, ProviderId } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProviderResolver } from '../engine/providers.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import {
  createProviderSlugResolver,
  withModelsDeps,
  type DispatchContext,
  type ModelsDbPorts,
} from './dispatch.js';

/**
 * `withModelsDeps` integration wiring tests (2.5.G S5, ADR-0064) — the real-db half `models.test.ts` (the pure
 * command core) cannot cover: the S5 refresh service over the S4 catalog store, the LAZY-after-refresh
 * uuid→slug resolver, and the close-on-fault db lifecycle. NETWORK-FREE: an INJECTED stub resolver whose
 * `listModels` returns canned {@link ModelListing}s over a real in-memory `history.db` (via injectable
 * {@link ModelsDbPorts}) — the native keychain and the real `history.db` are never touched.
 */

const SECRET_KEY = 'sk-super-secret-key-value';

/** A minimal {@link LlmProvider} — only `id` + `listModels` matter here; the seam methods throw (never reached). */
function stubProvider(id: ProviderId, listModels: LlmProvider['listModels']): LlmProvider {
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

/** A resolver stub: `models[id]` are that provider's live listings; `keys[id]` its key (absent ⇒ keyFor throws). */
function stubResolver(
  models: Partial<Record<ProviderId, ModelListing[]>>,
  keys: Partial<Record<ProviderId, string>>,
): Pick<ProviderResolver, 'resolveProvider' | 'keyFor'> {
  return {
    resolveProvider: (id) => {
      const listings = models[id];
      return listings === undefined ? undefined : stubProvider(id, () => Promise.resolve(listings));
    },
    keyFor: (id) => {
      const key = keys[id];
      if (key === undefined) {
        throw new Error(`no key for ${id}`);
      }
      return key;
    },
  };
}

function listing(id: string, contextWindowTokens?: number): ModelListing {
  return {
    id,
    displayName: id,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  };
}

describe('withModelsDeps (2.5.G S5 — real-db wiring + lazy slug + close-on-fault)', () => {
  let client: DbClient;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  /** A `cwd` outside any `.relavium/` project so `loadResolvedConfig` resolves clean defaults (no committed layers). */
  function context(io: CliIo, json: boolean): DispatchContext {
    return {
      io,
      global: { json, color: false, cwd: tmpdir(), configPath: undefined, verbosity: 'normal' },
    };
  }

  /** Ports over the shared in-memory db + an injected resolver; `onClose` records that the finally-close ran. */
  function testPorts(
    resolver: Pick<ProviderResolver, 'resolveProvider' | 'keyFor'>,
    onClose?: () => void,
  ): ModelsDbPorts {
    return {
      // The shared client is closed by afterEach — the spy only records the call, so a real close never
      // double-closes the better-sqlite3 handle.
      openDb: () => ({ db: client.db, close: () => onClose?.() }),
      makeResolver: () => resolver,
      // NETWORK-FREE (ADR-0071 §4a). A `models refresh` now has a models.dev leg, and a unit test must never take it:
      // this port is what keeps the whole wiring — including the close-on-fault lifecycle — testable offline.
      refreshCatalog: () =>
        Promise.resolve({ status: 'refreshed' as const, models: 80, added: 0 }),
    };
  }

  /** A provider store over the SAME db withModelsDeps wrote through — reads back what a first-run refresh created. */
  function readProviderStore() {
    return createProviderStore(client.db, { uuid: () => 'unused', now: () => 0 });
  }

  it('a first-run refresh that discovers a NEW provider renders its SLUG (not the internal uuid) in the same invocation', async () => {
    const { io, out } = captureIo();
    // Only anthropic has a key ⇒ it is the sole connected provider; its provider row does NOT exist yet, so the
    // first-run refresh DISCOVERS it (upserts the llm_providers row) mid-invocation.
    const resolver = stubResolver(
      { anthropic: [listing('claude-x', 200_000)] },
      { anthropic: SECRET_KEY },
    );

    const code = await withModelsDeps(context(io, false), { refresh: false }, testPorts(resolver));
    expect(code).toBe(EXIT_CODES.success);

    const text = out();
    expect(text).toContain('claude-x'); // the freshly-refreshed model
    expect(text).toContain('anthropic'); // rendered by its SLUG

    // ...and NEVER by the internal llm_providers uuid the catalog row carries. This pins the lazy-after-refresh
    // ordering: the slug map is built on first render (post-refresh), so a provider discovered THIS invocation is
    // captured — a refactor that hoisted the map build ahead of the refresh would print this uuid instead.
    const uuid = readProviderStore().get('anthropic')?.id;
    expect(uuid).toBeDefined();
    if (uuid !== undefined) {
      expect(text).not.toContain(uuid);
    }
  });

  it('closes the db even when the command throws (zero providers connected → the CliError path)', async () => {
    const { io } = captureIo();
    // No keys at all ⇒ every provider is skipped-no-key ⇒ `models refresh` throws the zero-connected CliError.
    const resolver = stubResolver({}, {});
    let closed = false;

    await expect(
      withModelsDeps(
        context(io, false),
        { refresh: true, axis: 'providers' },
        testPorts(resolver, () => {
          closed = true;
        }),
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.invalidInvocation });
    expect(closed).toBe(true); // the `finally` ran despite the throw — no leaked db handle
  });

  it('createProviderSlugResolver builds the slug map LAZILY (captures a provider registered AFTER construction) and falls back to the uuid for an unknown id', () => {
    const store = readProviderStore();
    const providerSlug = createProviderSlugResolver(store);
    // Register a provider AFTER building the closure but BEFORE its first call — the lazy `??=` build must still
    // capture it (exactly the "map built while rendering, after the refresh upserted the row" ordering).
    const rec = store.upsert({
      name: 'anthropic',
      displayName: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(providerSlug(rec.id)).toBe('anthropic');
    // An unmapped uuid falls back to itself (never throws) — the memoized map has no such id.
    expect(providerSlug('00000000-0000-4000-8000-ffffffffffff')).toBe(
      '00000000-0000-4000-8000-ffffffffffff',
    );
  });
});
