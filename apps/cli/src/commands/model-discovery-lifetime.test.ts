import {
  createClient,
  runMigrations,
  createModelCatalogStore,
  createProviderStore,
} from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';
import { invocationFixture } from '../process/invocation.test-support.js';
import { SessionWorkOwner } from '../chat/session-work-owner.js';
import { SessionHomeLifetime } from '../home/session-home-lifetime.js';
import { captureIo } from '../test-support.js';
import {
  createProviderResolver,
  validateProviderKey,
  KNOWN_PROVIDERS,
} from '../engine/providers.js';
import { createModelRefreshService } from '../engine/model-refresh.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { createModelCatalogPort } from '../engine/model-catalog-port.js';
import { withModelsDeps } from './dispatch.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const reactions = () => new Promise<void>((resolve) => setImmediate(resolve));
const listed = () =>
  new Response(JSON.stringify({ object: 'list', data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
function providers(fetch: FetchLike) {
  return createProviderResolver({ RELAVIUM_OPENAI_API_KEY: 'synthetic-discovery-key' }, undefined, {
    providerStore: {
      list: () => [
        {
          id: 'synthetic-custom-openai',
          name: 'openai',
          displayName: 'Synthetic discovery',
          baseUrl: 'https://review.example/v1',
          defaultHeaders: {},
          isActive: true,
          createdAt: '2026-10-17T00:00:00.000Z',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
      ],
    },
    validatedFetch: fetch,
  });
}
const global = {
  cwd: process.cwd(),
  json: true,
  color: false,
  configPath: undefined,
  verbosity: 'normal',
} as const;

describe('actual SDK discovery original-owner integration', () => {
  it('observes an opaque host transfer refusal before per-provider normalization without SDK entry', async () => {
    const client = createClient(':memory:');
    runMigrations(client.db);
    let reflections = 0;
    const cause = new Proxy(new Error('private original-owner refusal'), {
      get() {
        reflections += 1;
        throw new Error('reflection');
      },
      getPrototypeOf() {
        reflections += 1;
        throw new Error('reflection');
      },
    });
    const fetch = vi.fn(() => Promise.resolve(listed()));
    const resolver = providers(fetch);
    const observed = vi.fn();
    const storeDeps = { now: () => 0, uuid: () => 'synthetic-discovery' };
    const service = createModelRefreshService({
      invocationOptions: {
        retainWork: () => {
          throw cause;
        },
      },
      onHostFailure: observed,
      resolveProvider: resolver.resolveProvider,
      keyFor: resolver.keyFor,
      providerStore: createProviderStore(client.db, storeDeps),
      catalogStore: createModelCatalogStore(client.db, storeDeps),
      knownProviderIds: ['openai'],
      knownProviders: KNOWN_PROVIDERS,
      now: () => 0,
    });
    try {
      expect(await service.refresh()).toEqual({
        providers: [{ provider: 'openai', status: 'failed', error: 'refresh failed' }],
      });
      expect(observed).toHaveBeenCalledOnce();
      expect(Object.is(observed.mock.calls[0]?.[0], cause)).toBe(true);
      expect(reflections).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      expect(client.sqlite.prepare('SELECT COUNT(*) AS count FROM llm_providers').get()).toEqual({
        count: 0,
      });
    } finally {
      client.sqlite.close();
    }
  });

  it.each(['timeout', 'success'] as const)(
    'management keeps SQLite until actual SDK transport settles after %s',
    async (end) => {
      vi.useFakeTimers();
      const f = invocationFixture();
      const client = createClient(':memory:');
      runMigrations(client.db);
      const response = deferred<Response>();
      const entered = deferred<void>();
      const captured = captureIo();
      const resolver = providers(() => {
        entered.resolve();
        return response.promise;
      });
      const close = vi.fn(() => client.sqlite.close());
      let settled = false;
      const command = withModelsDeps(
        { io: captured.io, global, invocation: f.invocation },
        { refresh: true, axis: 'providers' },
        {
          openDb: () => ({ db: client.db, close }),
          makeResolver: () => resolver,
          refreshCatalog: () => Promise.reject(new Error('unused catalog axis')),
        },
      ).then((value) => {
        settled = true;
        return value;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled, 'MANAGEMENT_RESPONSE_PENDING_KEEPS_COMMAND_OPEN').toBe(false);
        expect(client.sqlite.open, 'MANAGEMENT_SUCCESS_WAITS_FOR_RAW_SDK').toBe(true);
        expect(client.sqlite.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
        expect(close).not.toHaveBeenCalled();
        expect(f.registry.activeOwners).toBe(1);
        if (end === 'timeout') {
          await vi.advanceTimersByTimeAsync(15_000);
          expect(captured.out()).toContain('model list timed out after 15000ms');
          expect(settled, 'MANAGEMENT_BOUNDED_REPORT_DOES_NOT_RETIRE_RAW_SDK').toBe(false);
          expect(client.sqlite.open).toBe(true);
          expect(close).not.toHaveBeenCalled();
          expect(f.registry.activeOwners).toBe(1);
        }
        response.resolve(listed());
        expect(await command).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(client.sqlite.open).toBe(false);
        expect(f.registry.activeOwners).toBe(0);
        expect(f.exit).not.toHaveBeenCalled();
      } finally {
        response.resolve(listed());
        await command;
        if (client.sqlite.open) client.sqlite.close();
        vi.useRealTimers();
      }
    },
  );

  it.each(['refresh', 'refreshIfStale'] as const)(
    'shared Home/chat %s retains timed-out discovery before the shared DB closes',
    async (operation) => {
      vi.useFakeTimers();
      const f = invocationFixture();
      const client = createClient(':memory:');
      runMigrations(client.db);
      const home = new SessionHomeLifetime(f.invocation, () => () => undefined);
      const close = vi.fn(() => client.sqlite.close());
      home.adoptStore({ close });
      const response = deferred<Response>();
      const entered = deferred<void>();
      const port = createModelCatalogPort({
        db: client.db,
        providers: providers(() => {
          entered.resolve();
          return response.promise;
        }),
        now: () => 0,
        uuid: () => 'synthetic-catalog',
        workOwner: home.surface.work,
      });
      let reported = false;
      let settled = false;
      const drive = home
        .execute(async () => {
          const result = await port[operation]();
          expect(result?.providers.find((row) => row.provider === 'openai')?.status).toBe('failed');
          reported = true;
          return 0;
        })
        .then((value) => {
          settled = true;
          return value;
        });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(reported, 'PICKER_DISCOVERY_REPORT_REMAINS_BOUNDED').toBe(true);
        expect(settled, 'PICKER_DISCOVERY_TAIL_PRECEDES_DATABASE_CLOSE').toBe(false);
        expect(client.sqlite.open).toBe(true);
        expect(close).not.toHaveBeenCalled();
        expect(f.registry.activeOwners).toBe(1);
        response.resolve(listed());
        expect(await drive).toBe(0);
        expect(close).toHaveBeenCalledOnce();
        expect(client.sqlite.open).toBe(false);
        expect(f.registry.activeOwners).toBe(0);
      } finally {
        response.resolve(listed());
        await drive;
        if (client.sqlite.open) client.sqlite.close();
        vi.useRealTimers();
      }
    },
  );

  it('key validation retains transitive native close after its actual SDK response succeeds', async () => {
    const f = invocationFixture();
    const cleanup = vi.fn(() => Promise.resolve());
    const owner = new SessionWorkOwner(f.invocation, 'home', { cancel: () => undefined, cleanup });
    const nativeClose = deferred<void>();
    let transferred = false;
    const resolver = providers((_input, _init, work) => {
      if (work?.retainWork !== undefined) {
        transferred = true;
        void work.retainWork(() => nativeClose.promise);
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'synthetic-validation',
            object: 'chat.completion',
            created: 0,
            model: 'gpt-4o-mini',
            choices: [
              { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    const provider = resolver.resolveProvider('openai');
    if (provider === undefined) throw new Error('missing synthetic provider');
    let closing: Promise<void> | undefined;
    try {
      expect(
        await validateProviderKey(provider, 'synthetic-discovery-key', 'gpt-4o-mini', 10_000, {
          signal: owner.signal,
          work: owner.work,
          assertAdmitting: owner.assertAdmitting,
        }),
      ).toMatchObject({ ok: true });
      let retired = false;
      closing = owner.close().then(() => {
        retired = true;
      });
      await reactions();
      expect(transferred, 'KEY_PROBE_FORWARDS_INVOCATION_DESCENDANTS').toBe(true);
      expect(retired, 'KEY_PROBE_SUCCESS_DOES_NOT_ACK_NATIVE_CLOSE').toBe(false);
      expect(cleanup).not.toHaveBeenCalled();
      expect(f.registry.activeOwners).toBe(1);
      nativeClose.resolve();
      await closing;
      expect(cleanup).toHaveBeenCalledOnce();
      expect(f.registry.activeOwners).toBe(0);
    } finally {
      nativeClose.resolve();
      await closing;
    }
  });
});
