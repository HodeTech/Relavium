import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, ModelListing } from '@relavium/llm';
import { invocationFixture } from '../process/invocation.test-support.js';
import { CHAT_TEXT_CAPABILITY_FLAGS } from '../test-support.js';
import { SessionHomeLifetime } from '../home/session-home-lifetime.js';
import { CliError } from '../process/cli-error.js';

import { createModelCatalogPort } from './model-catalog-port.js';
import type { ProviderResolver } from './providers.js';

/**
 * The SHARED `/models` catalog port (the Home default-write picker + the chat reseat picker, ADR-0059/ADR-0064).
 * The refresh trio is a thin re-composition of already-tested pieces (buildMergedCatalog, the refresh service); the
 * load-bearing new behavior is that `load()` KEYS the merge off the resolver — a model whose provider has no key is
 * dimmed `no-key`, never offered as selectable. Registry-only (no db seed needed — `MODEL_PRICING` carries the id).
 */
describe('createModelCatalogPort', () => {
  let client: DbClient;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });

  const resolver = (hasKey: boolean): ProviderResolver => ({
    resolveProvider: () => undefined,
    keyFor: (): string => {
      if (!hasKey) throw new Error('no key');
      return 'k';
    },
    hasKey: () => hasKey,
  });

  it.each(['refresh', 'refreshIfStale'] as const)(
    '%s returns a rejecting Promise when its owner already stopped',
    async (method) => {
      const f = invocationFixture();
      const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
      const providers = resolver(true);
      const resolveProvider = vi.spyOn(providers, 'resolveProvider');
      const port = createModelCatalogPort({
        db: client.db,
        providers,
        now: () => 0,
        uuid: () => 'stopped-catalog',
        workOwner: home.surface.work,
      });
      home.surface.work.stop();
      // An immediate .catch is part of the Promise API, including refused entry.
      const cause = await port[method]().catch((error: unknown) => error);
      expect(home.surface.work.isStoppedFailure(cause)).toBe(true);
      expect(resolveProvider).not.toHaveBeenCalled();
      await home.surface.work.close();
    },
  );

  it.each(['refresh', 'refreshIfStale'] as const)(
    '%s enters admitted discovery before returning its Promise',
    async (method) => {
      const f = invocationFixture();
      const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
      const providers = resolver(false);
      const keyFor = vi.spyOn(providers, 'keyFor');
      const port = createModelCatalogPort({
        db: client.db,
        providers,
        now: () => 0,
        uuid: () => 'admitted-catalog',
        workOwner: home.surface.work,
      });
      const refresh = port[method]().catch((cause: unknown) => cause);
      try {
        expect(keyFor, 'CATALOG_ADMISSION_PRECEDES_PROMISE_RETURN').toHaveBeenCalled();
      } finally {
        await home.surface.work.close();
        await refresh;
      }
    },
  );

  it('retains the existing recoverable cache-read policy while joining its actual work', async () => {
    const f = invocationFixture();
    const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
    const close = vi.fn();
    home.adoptStore({ close });
    const port = createModelCatalogPort({
      db: client.db,
      providers: resolver(true),
      now: () => 0,
      uuid: () => 'synthetic-read',
      workOwner: home.surface.work,
    });
    const cause = new Error('PRIVATE_OPTIONAL_CACHE_READ');
    const read = vi.spyOn(client.sqlite, 'prepare').mockImplementation(() => {
      throw cause;
    });
    try {
      const drive = home.execute(async () => {
        await expect(port.refreshIfStale()).rejects.toBe(cause);
        expect(f.registry.observations.exitCode(), 'CATALOG_OPTIONAL_READ_STAYS_RECOVERABLE').toBe(
          0,
        );
        return 0;
      });
      expect(await drive).toBe(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      read.mockRestore();
    }
  });

  it.each(['clock', 'store'] as const)(
    'observes a local %s failure before a held sibling discovery settles',
    async (kind) => {
      const f = invocationFixture();
      const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
      const close = vi.fn();
      home.adoptStore({ close });
      const primary = new Error('PRIVATE_CATALOG_LOCAL_FAILURE');
      let finish: (models: ModelListing[]) => void = () => undefined;
      const listing = new Promise<ModelListing[]>((resolve) => {
        finish = resolve;
      });
      const provider = (id: 'anthropic' | 'openai'): LlmProvider => ({
        id,
        supports: CHAT_TEXT_CAPABILITY_FLAGS,
        generate: () => {
          throw new Error('unexpected generate');
        },
        stream: () => {
          throw new Error('unexpected stream');
        },
        listModels: () => (id === 'anthropic' ? listing : Promise.resolve([])),
      });
      let clockReads = 0;
      const port = createModelCatalogPort({
        db: client.db,
        workOwner: home.surface.work,
        providers: {
          resolveProvider: (id) =>
            id === 'anthropic' || id === 'openai' ? provider(id) : undefined,
          keyFor: (id) => {
            if (id !== 'anthropic' && id !== 'openai')
              throw new CliError('invalid_invocation', 'no synthetic key');
            return 'synthetic-catalog-key';
          },
        },
        uuid: () => {
          if (kind === 'store') throw primary;
          return 'synthetic-row';
        },
        now: () => {
          if (kind === 'clock' && ++clockReads === 2) throw primary;
          return 0;
        },
      });
      let settled = false;
      const drive = home
        .execute(async () => {
          await port.refresh();
          return 0;
        })
        .then((code) => {
          settled = true;
          return code;
        });
      await vi.waitFor(() => expect(home.surface.work.firstFailure?.cause).toBe(primary));
      expect(f.registry.observations.exitCode(), 'CATALOG_LOCAL_FAILURE_BEFORE_SIBLING_JOIN').toBe(
        9,
      );
      expect(f.registry.budget.deadline()).toBe(3000);
      expect(close).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      finish([]);
      expect(await drive).toBe(9);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('holds the shared Home database through raw discovery and refuses its post-stop write', async () => {
    const f = invocationFixture();
    const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
    const close = vi.fn();
    home.adoptStore({ close });
    let finish: (models: ModelListing[]) => void = () => undefined;
    const listing = new Promise<ModelListing[]>((resolve) => {
      finish = resolve;
    });
    const provider: LlmProvider = {
      id: 'anthropic',
      supports: CHAT_TEXT_CAPABILITY_FLAGS,
      generate: () => {
        throw new Error('unexpected generate');
      },
      stream: () => {
        throw new Error('unexpected stream');
      },
      listModels: () => listing,
    };
    const port = createModelCatalogPort({
      db: client.db,
      providers: {
        resolveProvider: (id) => (id === 'anthropic' ? provider : undefined),
        keyFor: () => 'synthetic-catalog-key',
      },
      now: () => 0,
      uuid: () => 'catalog-id',
      workOwner: home.surface.work,
    });
    let refresh: ReturnType<typeof port.refresh> | undefined;
    const drive = home.execute(() => {
      refresh = port.refresh();
      return Promise.resolve(0);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(close, 'HOME_DISCOVERY_BEFORE_SHARED_DATABASE_CLOSE').not.toHaveBeenCalled();
    expect(f.registry.activeOwners).toBe(1);
    finish([{ id: 'synthetic-late-model' }]);
    await drive;
    await refresh;
    expect(close).toHaveBeenCalledOnce();
    expect(client.sqlite.prepare('SELECT COUNT(*) AS count FROM llm_providers').get()).toEqual({
      count: 0,
    });
    expect(f.registry.activeOwners).toBe(0);
  });

  it('load() surfaces the static registry as AVAILABLE when the provider has a key', () => {
    const port = createModelCatalogPort({
      db: client.db,
      providers: resolver(true),
      now: () => 0,
      uuid: () => 'u',
    });
    const entry = port.load().entries.find((e) => e.modelId === 'claude-sonnet-4-6');
    expect(entry?.available).toBe(true); // anthropic keyed ⇒ its static model is selectable
  });

  it('load() DIMS a model whose provider has no key (no-key), never offering an uncallable model', () => {
    const port = createModelCatalogPort({
      db: client.db,
      providers: resolver(false),
      now: () => 0,
      uuid: () => 'u',
    });
    const entry = port.load().entries.find((e) => e.modelId === 'claude-sonnet-4-6');
    expect(entry?.available).toBe(false);
    expect(entry?.unavailableReason).toBe('no-key');
  });
});
