import { randomUUID } from 'node:crypto';

import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
} from '@relavium/db';
import type { LlmProvider, ProviderId } from '@relavium/llm';
import { describe, expect, it, vi } from 'vitest';

import { modelsCommand, type ModelsCommandDeps } from '../commands/models.js';
import { captureIo, CHAT_TEXT_CAPABILITY_FLAGS, parseNdjson } from '../test-support.js';
import { createModelRefreshService } from './model-refresh.js';
import { KNOWN_PROVIDERS } from './providers.js';

const KEY = 'synthetic-refresh-key-private';

function provider(id: ProviderId, canList: boolean): LlmProvider {
  return {
    id,
    generate: () => Promise.reject(new Error('generate must not run during model discovery')),
    stream: () => {
      throw new Error('stream must not run during model discovery');
    },
    supports: CHAT_TEXT_CAPABILITY_FLAGS,
    ...(canList
      ? {
          listModels: () =>
            Promise.resolve([{ id: `${id}-fixture`, displayName: `${id} fixture` }]),
        }
      : {}),
  };
}

function fixture() {
  const client = createClient(':memory:');
  runMigrations(client.db);
  const stores = { uuid: () => randomUUID(), now: () => 1_700_000_000_000 };
  const adapters = {
    anthropic: provider('anthropic', true),
    deepseek: provider('deepseek', false),
    gemini: provider('gemini', true),
    openai: provider('openai', true),
  } satisfies Record<ProviderId, LlmProvider>;
  const svc = createModelRefreshService({
    resolveProvider: (id) => adapters[id],
    keyFor: (id) => {
      if (id === 'anthropic') throw new Error('synthetic key is absent');
      return KEY;
    },
    providerStore: createProviderStore(client.db, stores),
    catalogStore: createModelCatalogStore(client.db, stores),
    knownProviderIds: ['openai', 'gemini', 'anthropic', 'deepseek'],
    knownProviders: KNOWN_PROVIDERS,
    now: stores.now,
  });
  return { client, svc };
}

describe('provider identifiers through refresh and actual models JSON', () => {
  it('[REFRESH-IDENTIFIERS] orders grouped/skipped and refreshed valid ProviderIds without ambient collation', async () => {
    const { client, svc } = fixture();
    const collation = vi.spyOn(String.prototype, 'localeCompare');
    try {
      const report = await svc.refresh();
      expect(report.providers).toEqual([
        { provider: 'anthropic', status: 'skipped-no-key' },
        { provider: 'deepseek', status: 'skipped-unsupported' },
        { provider: 'gemini', status: 'refreshed', added: 1, updated: 0, deactivated: 0 },
        { provider: 'openai', status: 'refreshed', added: 1, updated: 0, deactivated: 0 },
      ]);
      expect(
        collation,
        '[REFRESH-NO-AMBIENT] actual refresh uses ordinal identifier ordering',
      ).not.toHaveBeenCalled();
      expect(JSON.stringify(report)).not.toContain(KEY);
    } finally {
      collation.mockRestore();
      client.sqlite.close();
    }
  });

  it('[REFRESH-JSON-JOIN] actual service emits four sorted key-free provider records through modelsCommand', async () => {
    const { client, svc } = fixture();
    const { io, out, err } = captureIo();
    const refreshCatalog = vi.fn<ModelsCommandDeps['refreshCatalog']>(() =>
      Promise.reject(new Error('catalog egress must not run on the providers axis')),
    );
    const deps: ModelsCommandDeps = {
      io,
      global: {
        json: true,
        color: false,
        cwd: '/fixture',
        configPath: undefined,
        verbosity: 'normal',
      },
      catalog: { listAll: () => [] },
      refreshService: svc,
      refreshCatalog,
      providerSlug: (id) => id,
    };
    const collation = vi.spyOn(String.prototype, 'localeCompare');
    try {
      expect(await modelsCommand({ refresh: true, axis: 'providers' }, deps)).toBe(0);
      const records = parseNdjson<{
        provider: string;
        status: string;
        added: number | null;
        updated: number | null;
        deactivated: number | null;
        error: string | null;
      }>(out());
      expect(
        records.map(({ provider: id }) => id),
        '[REFRESH-JSON-ORDER] real NDJSON preserves refresh ordering',
      ).toEqual(['anthropic', 'deepseek', 'gemini', 'openai']);
      // Provider records retain the existing wire shape (no source field); the catalog axis would
      // instead emit a separate source:'catalog' record. Pin actual command output, not a fake DTO.
      expect(records).toEqual([
        {
          provider: 'anthropic',
          status: 'skipped-no-key',
          added: null,
          updated: null,
          deactivated: null,
          error: null,
        },
        {
          provider: 'deepseek',
          status: 'skipped-unsupported',
          added: null,
          updated: null,
          deactivated: null,
          error: null,
        },
        {
          provider: 'gemini',
          status: 'refreshed',
          added: 1,
          updated: 0,
          deactivated: 0,
          error: null,
        },
        {
          provider: 'openai',
          status: 'refreshed',
          added: 1,
          updated: 0,
          deactivated: 0,
          error: null,
        },
      ]);
      expect(records.map(({ status }) => status)).toEqual([
        'skipped-no-key',
        'skipped-unsupported',
        'refreshed',
        'refreshed',
      ]);
      expect(records.slice(2).map(({ added }) => added)).toEqual([1, 1]);
      expect(refreshCatalog).not.toHaveBeenCalled();
      expect(collation).not.toHaveBeenCalled();
      expect(err()).toBe('');
      expect(out()).not.toContain(KEY);
    } finally {
      collation.mockRestore();
      client.sqlite.close();
    }
  });
});
