import { createClient, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
