import {
  createClient,
  createModelCatalogStore,
  createProviderStore,
  runMigrations,
  type DbClient,
} from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeController } from '../render/tui/home-controller.js';
import { isolateSdkEnvironment } from './fixtures/provider-header-fixture.js';
import { createModelCatalogPort } from './model-catalog-port.js';
import { createProviderResolver, providerHasKey } from './providers.js';
import { createStandardEnvKeyPolicy } from './standard-env-policy.js';
import type { KeychainStore } from '../secrets/keychain.js';
import type { FetchLike } from './validated-fetch.js';

const first = ['synthetic', 'credential', 'first'].join('-');
const second = ['synthetic', 'credential', 'second'].join('-');

describe('retained catalog credential changes', () => {
  let client: DbClient;
  beforeEach(() => {
    isolateSdkEnvironment();
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    vi.unstubAllEnvs();
  });

  function fixture() {
    let ordinal = 0;
    let stored: string | null = null;
    let time = 1_000;
    const storeDeps = { uuid: () => `catalog-credential-${++ordinal}`, now: () => time };
    const providerStore = createProviderStore(client.db, storeDeps);
    const provider = providerStore.upsert({
      name: 'openai',
      displayName: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/',
    });
    const catalogStore = createModelCatalogStore(client.db, storeDeps);
    const get = vi.fn((account: string) => (account === 'openai:default' ? stored : null));
    const keychain: KeychainStore = {
      get,
      set: (account, value) => {
        if (account === 'openai:default') stored = value;
      },
      delete: (account) => {
        if (account !== 'openai:default') return false;
        const existed = stored !== null;
        stored = null;
        return existed;
      },
    };
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: first };
    const policy = createStandardEnvKeyPolicy();
    const authorizations: Array<string | null> = [];
    const fetch: FetchLike = vi.fn((input: Parameters<FetchLike>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://api.openai.com/v1/models');
      authorizations.push(request.headers.get('authorization'));
      return Promise.resolve(
        new Response(
          JSON.stringify({ object: 'list', data: [{ id: 'gpt-fixture', object: 'model' }] }),
          { headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    // Actual resolver/SDK adapter: explicit official spelling permits a fully injected offline transport.
    const resolver = createProviderResolver(env, keychain, {
      providerStore,
      standardEnvPolicy: policy,
      validatedFetch: fetch,
    });
    const makePort = () =>
      createModelCatalogPort({ db: client.db, providers: resolver, ...storeDeps });
    const port = makePort();
    const openai = () => port.load().entries.filter((entry) => entry.provider === 'openai');
    const expectCurrent = (available: boolean) => {
      const entries = openai();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.available)).toBe(available);
      expect(entries.every((entry) => entry.unavailableReason === 'no-key')).toBe(!available);
      // A new port is an independent oracle over the same current resolver and durable rows.
      expect(entries).toEqual(
        makePort()
          .load()
          .entries.filter((entry) => entry.provider === 'openai'),
      );
      return entries;
    };
    return {
      port,
      provider,
      catalogStore,
      policy,
      resolver,
      env,
      keychain,
      get,
      authorizations,
      fetch,
      makePort,
      expectCurrent,
      advance: () => {
        time += 1000;
      },
    };
  }

  it('updates a retained static/live catalog after named-source grant, manual key changes, and removal', async () => {
    const f = fixture();
    f.catalogStore.replaceProviderModels(
      f.provider.id,
      [{ modelId: 'gpt-fixture', displayName: 'Fixture' }],
      1000,
    );
    const original = f.expectCurrent(false);
    expect(providerHasKey(f.resolver, 'openai')).toBe(false);
    expect(
      (await f.port.refresh()).providers.find((result) => result.provider === 'openai')?.status,
    ).toBe('skipped-no-key');
    expect(f.fetch).not.toHaveBeenCalled();
    f.policy.allowForInvocation('openai');
    expect(providerHasKey(f.resolver, 'openai')).toBe(true);
    const granted = f.expectCurrent(true);
    expect(original.every((entry) => entry.unavailableReason === 'no-key')).toBe(true);
    expect(granted.some((entry) => entry.modelId === 'gpt-fixture' && entry.available)).toBe(true);
    expect(
      (await f.port.refresh()).providers.find((result) => result.provider === 'openai')?.status,
    ).toBe('refreshed');
    expect(f.authorizations).toEqual([`Bearer ${first}`]);
    // Current values are resolved at discovery, not captured by the granted source or catalog view.
    f.env['OPENAI_API_KEY'] = second;
    await f.port.refresh();
    expect(f.authorizations.at(-1)).toBe(`Bearer ${second}`);
    f.env['OPENAI_API_KEY'] = '';
    f.expectCurrent(false);
    expect(
      (await f.port.refresh()).providers.find((result) => result.provider === 'openai')?.status,
    ).toBe('skipped-no-key');
    expect(f.authorizations).toHaveLength(2);
    f.keychain.set('openai:default', first);
    f.expectCurrent(true);
    await f.port.refresh();
    expect(f.authorizations.at(-1)).toBe(`Bearer ${first}`);
    f.keychain.set('openai:default', second);
    await f.port.refresh();
    expect(f.authorizations.at(-1)).toBe(`Bearer ${second}`);
    f.keychain.delete('openai:default');
    f.expectCurrent(false);
    expect(
      (await f.port.refresh()).providers.find((result) => result.provider === 'openai')?.status,
    ).toBe('skipped-no-key');
    expect(f.authorizations).toHaveLength(4);
  });

  it('makes a later manual key usable without granting a pending standard source, then returns to pending after removal', async () => {
    const f = fixture();
    f.expectCurrent(false);
    f.keychain.set('openai:default', second);
    f.expectCurrent(true);
    const report = await f.port.refresh();
    expect(report.providers.find((result) => result.provider === 'openai')?.status).toBe(
      'refreshed',
    );
    expect(f.authorizations).toEqual([`Bearer ${second}`]);
    f.keychain.delete('openai:default');
    f.expectCurrent(false);
    expect(() => f.resolver.keyFor('openai')).toThrow('has not been allowed');
    expect(
      (await f.port.refresh()).providers.find((result) => result.provider === 'openai')?.status,
    ).toBe('skipped-no-key');
    expect(f.authorizations).toHaveLength(1);
  });

  it('re-evaluates TTL refresh eligibility after a formerly pending source becomes authorized', async () => {
    const f = fixture();
    f.expectCurrent(false);
    expect(await f.port.refreshIfStale()).toBeUndefined();
    expect(f.fetch).not.toHaveBeenCalled();
    f.policy.allowForInvocation('openai');
    const report = await f.port.refreshIfStale();
    expect(report?.providers.find((result) => result.provider === 'openai')?.status).toBe(
      'refreshed',
    );
    f.expectCurrent(true);
    expect(f.authorizations).toEqual([`Bearer ${first}`]);
    f.env['OPENAI_API_KEY'] = '';
    f.expectCurrent(false);
    expect(await f.port.refreshIfStale()).toBeUndefined();
    expect(f.authorizations).toHaveLength(1);
  });

  it('samples on actual Home picker open/refresh events while repeated renderer snapshot reads do not probe keys', async () => {
    const f = fixture();
    const controller = createHomeController({
      startChat: () => Promise.reject(new Error('chat is not exercised')),
      homeStore: {
        read: () => ({
          attention: { gates: [], failedRuns: [] },
          recentSessions: [],
          recentRuns: [],
          recentAgents: [],
          unreadableRunIds: [],
          isEmpty: true,
        }),
      },
      doctorProbes: { keychain: () => undefined, config: () => undefined, toolHost: {} },
      onExit: vi.fn(),
      onError: vi.fn(),
      models: {
        ...f.port,
        currentDefault: () => undefined,
        currentEffort: () => undefined,
        writeDefault: () => undefined,
      },
    });
    const open = () => {
      for (const char of '/models') controller.handleKey(char, {});
      controller.handleKey('', { return: true });
    };
    open();
    await vi.waitFor(() => expect(controller.getSnapshot().modelPicker?.loading).toBe(false));
    const firstView = controller.getSnapshot().modelPicker;
    expect(
      firstView?.entries
        .filter((entry) => entry.provider === 'openai')
        .every((entry) => entry.unavailableReason === 'no-key'),
    ).toBe(true);
    const reads = f.get.mock.calls.length;
    for (let frame = 0; frame < 100; frame++)
      expect(controller.getSnapshot().modelPicker).toBe(firstView);
    expect(f.get).toHaveBeenCalledTimes(reads);
    controller.handleKey('', { escape: true });
    f.policy.allowForInvocation('openai');
    open();
    await vi.waitFor(() => expect(controller.getSnapshot().modelPicker?.loading).toBe(false));
    const secondView = controller.getSnapshot().modelPicker;
    expect(
      secondView?.entries.some((entry) => entry.provider === 'openai' && entry.available),
    ).toBe(true);
    expect(f.authorizations).toEqual([`Bearer ${first}`]);
    const afterRefresh = f.get.mock.calls.length;
    for (let frame = 0; frame < 100; frame++)
      expect(controller.getSnapshot().modelPicker).toBe(secondView);
    expect(f.get).toHaveBeenCalledTimes(afterRefresh);
    controller.handleKey('', { escape: true });
    f.env['OPENAI_API_KEY'] = '';
    open();
    await vi.waitFor(() => expect(controller.getSnapshot().modelPicker?.loading).toBe(false));
    expect(
      controller
        .getSnapshot()
        .modelPicker?.entries.filter((entry) => entry.provider === 'openai')
        .every((entry) => entry.unavailableReason === 'no-key'),
    ).toBe(true);
    expect(f.authorizations).toHaveLength(1);
    await controller.teardownActive();
  });
});
