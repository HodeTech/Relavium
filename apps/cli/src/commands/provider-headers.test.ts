import { isProviderHeaderPolicyError, type ProviderStore } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LEGACY_HEADERS,
  LEGACY_HEADERS_JSON,
  SYNTHETIC_PROVIDER_KEY,
  isolateSdkEnvironment,
  offlineOpenAiRefusal,
  offlineOpenAiReply,
  seedLegacyProvider,
  syntheticKeychain,
} from '../engine/fixtures/provider-header-fixture.js';
import { createProviderResolver, KNOWN_PROVIDERS } from '../engine/providers.js';
import type { FetchLike } from '../engine/validated-fetch.js';
import { toUserFacing } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { renderError } from '../process/render-error.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { runProviderCommand, type ProviderCommandDeps } from './provider.js';

const BASE_URL = 'https://wave7-command.example/v1';
const POLICY_MESSAGE = 'Provider headers are disabled until keychain custody is implemented.';
const CORRUPT_MESSAGE = 'Stored provider headers are invalid.';
const INTERNAL_MESSAGE = 'An unexpected internal error occurred.';
const MALFORMED_HEADERS = '{"x-wave7-malformed-opaque":"cedar-river-legacy",';
const NONSTRING_HEADERS = '{"x-wave7-nonstring-opaque":37}';
const ERROR_SENTINELS = [
  'x-wave7-malformed-opaque',
  'cedar-river-legacy',
  'x-wave7-nonstring-opaque',
];

function globalOptions(json: boolean): GlobalOptions {
  return {
    json,
    color: false,
    cwd: '/synthetic-provider-command',
    configPath: undefined,
    verbosity: 'normal',
  };
}

function assertNoLegacy(text: string, marker = 'Provider header data must stay private.'): void {
  for (const sentinel of [
    ...Object.keys(LEGACY_HEADERS),
    ...Object.values(LEGACY_HEADERS),
    ...ERROR_SENTINELS,
    SYNTHETIC_PROVIDER_KEY,
  ]) {
    expect(text, marker).not.toContain(sentinel);
  }
}

function assertTrustedLegacy(store: ProviderStore): void {
  expect(store.get('openai')?.defaultHeaders).toEqual(LEGACY_HEADERS);
  expect(store.list().map((row) => row.defaultHeaders)).toEqual([LEGACY_HEADERS]);
}

function commandDeps(
  store: ProviderStore,
  json: boolean,
  fetch: FetchLike,
  key: string | null = SYNTHETIC_PROVIDER_KEY,
): ProviderCommandDeps & { capture: ReturnType<typeof captureIo> } {
  const capture = captureIo({});
  const keychain = syntheticKeychain('openai', key);
  const resolver = createProviderResolver({}, keychain, {
    providerStore: store,
    validatedFetch: fetch,
  });
  return {
    capture,
    io: capture.io,
    store,
    keychain,
    resolver,
    readSecret: () =>
      Promise.reject(new Error('Unexpected secret input in provider-header command fixture.')),
    global: globalOptions(json),
  };
}

/** Capture the real thrown value; succeeding is a test failure, never an empty safety assertion. */
async function captureFailure(action: () => unknown): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof Error))
      throw new TypeError('Expected an Error from provider header refusal.');
    return error;
  }
  throw new Error('Expected provider header refusal, but operation succeeded.');
}

describe('ADR-0108 provider-header command projections', () => {
  beforeEach(() => {
    isolateSdkEnvironment();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('Unexpected global provider fetch.'))),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  for (const json of [false, true]) {
    for (const outcome of ['offline', 'success', 'refusal', 'no-key'] as const) {
      it(`FS_CAUSAL_PROVIDER_HEADER_PUBLIC ${json ? 'NDJSON' : 'human'} list preserves public fields with ${outcome}`, async () => {
        const { client, store } = seedLegacyProvider('openai', BASE_URL);
        try {
          assertTrustedLegacy(store);
          const requests: Request[] = [];
          const fetch: FetchLike = (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(
              outcome === 'refusal'
                ? offlineOpenAiRefusal()
                : offlineOpenAiReply(KNOWN_PROVIDERS.openai.testModel),
            );
          };
          const deps = commandDeps(
            store,
            json,
            fetch,
            outcome === 'no-key' ? null : SYNTHETIC_PROVIDER_KEY,
          );
          if (outcome !== 'no-key')
            expect(deps.resolver.keyFor('openai')).toBe(SYNTHETIC_PROVIDER_KEY);
          expect(
            await runProviderCommand({ action: 'list', verify: outcome !== 'offline' }, deps),
          ).toBe(0);
          expect(deps.capture.err()).toBe('');
          const output = deps.capture.out();
          expect(output.trimEnd().split('\n')).toHaveLength(1);
          assertNoLegacy(output + deps.capture.err(), 'FS_CAUSAL_PROVIDER_HEADER_PUBLIC');
          const verified = outcome === 'success' ? true : outcome === 'refusal' ? false : null;
          if (json) {
            const records = parseNdjson(output);
            expect(records).toHaveLength(1);
            const record = records[0];
            if (record === undefined) throw new Error('Missing provider output record.');
            expect(Object.keys(record).sort()).toEqual([
              'baseUrl',
              'keySet',
              'name',
              'verified',
              'verifyDetail',
            ]);
            expect(record).toMatchObject({
              name: 'openai',
              baseUrl: BASE_URL,
              keySet: true,
              verified,
            });
            if (outcome === 'refusal')
              expect(record['verifyDetail']).toBe('key test failed — 400 offline refusal');
            else expect(record['verifyDetail']).toBe(outcome === 'no-key' ? 'no key' : null);
          } else {
            const status =
              outcome === 'offline'
                ? 'key set'
                : outcome === 'success'
                  ? 'verified'
                  : outcome === 'no-key'
                    ? 'no key'
                    : 'failed — key test failed — 400 offline refusal';
            expect(output).toBe(`openai\t${BASE_URL}\t[${status}]\n`);
          }
          expect(requests).toHaveLength(outcome === 'success' || outcome === 'refusal' ? 1 : 0);
          for (const request of requests) {
            expect(request.method).toBe('POST');
            expect(request.url).toBe(`${BASE_URL}/chat/completions`);
            expect(request.headers.get('authorization')).toBe(`Bearer ${SYNTHETIC_PROVIDER_KEY}`);
            expect(request.headers.get('content-type')).toBe('application/json');
            for (const name of Object.keys(LEGACY_HEADERS))
              expect(request.headers.has(name)).toBe(false);
            for (const value of request.headers.values()) {
              for (const legacy of Object.values(LEGACY_HEADERS))
                expect(value).not.toContain(legacy);
            }
            const body: unknown = await request.json();
            expect(body).toMatchObject({
              model: KNOWN_PROVIDERS.openai.testModel,
              messages: [{ role: 'user', content: 'ping' }],
            });
          }
          expect(globalThis.fetch).not.toHaveBeenCalled();
          assertTrustedLegacy(store);
        } finally {
          client.sqlite.close();
        }
      });
    }
  }

  it('actual provider add after explicit store clear never resurrects legacy headers', async () => {
    const { client, store } = seedLegacyProvider('openai', BASE_URL);
    try {
      assertTrustedLegacy(store);
      store.upsert({
        name: 'openai',
        displayName: 'Cleared provider',
        baseUrl: BASE_URL,
        defaultHeaders: {},
      });
      const fetch = vi.fn(() => Promise.reject(new Error('Unexpected add fetch.')));
      const deps = commandDeps(store, false, fetch);
      expect(await runProviderCommand({ action: 'add', name: 'openai' }, deps)).toBe(0);
      expect(store.get('openai')).toMatchObject({
        name: 'openai',
        displayName: KNOWN_PROVIDERS.openai.displayName,
        baseUrl: BASE_URL,
        defaultHeaders: {},
      });
      expect(store.list()[0]?.defaultHeaders).toEqual({});
      expect(
        client.sqlite
          .prepare('SELECT default_headers FROM llm_providers WHERE name = ?')
          .pluck()
          .get('openai'),
      ).toBe('{}');
      expect(deps.capture.out()).toContain(`Registered provider 'openai' (${BASE_URL})`);
      assertNoLegacy(deps.capture.out() + deps.capture.err());
      expect(fetch).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      client.sqlite.close();
    }
  });

  for (const source of [
    'policy',
    'malformed-command',
    'nonstring-command',
    'malformed-factory',
    'nonstring-factory',
  ] as const) {
    for (const json of [false, true]) {
      for (const verbose of [false, true]) {
        it(`FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC ${source} ${json ? 'JSON' : 'human'} verbose=${verbose} stays loud and content-free`, async () => {
          const raw = source.startsWith('malformed')
            ? MALFORMED_HEADERS
            : source.startsWith('nonstring')
              ? NONSTRING_HEADERS
              : LEGACY_HEADERS_JSON;
          const { client, store } = seedLegacyProvider('openai', BASE_URL, raw);
          try {
            const keychain = syntheticKeychain('openai');
            const fetch = vi.fn(() => Promise.reject(new Error('Unexpected diagnostic fetch.')));
            const commandIo = captureIo({});
            const error = await captureFailure(() => {
              if (source === 'policy')
                return store.upsert({
                  name: 'openai',
                  displayName: 'Refused',
                  baseUrl: BASE_URL,
                  defaultHeaders: LEGACY_HEADERS,
                });
              if (source.endsWith('factory'))
                return createProviderResolver({}, keychain, {
                  providerStore: store,
                  validatedFetch: fetch,
                });
              // The real command core reads its real store. A separately constructed safe resolver keeps the
              // command's own read reachable; the factory variants independently exercise eager composition.
              return runProviderCommand(
                { action: 'list' },
                {
                  io: commandIo.io,
                  store,
                  keychain,
                  resolver: createProviderResolver({}, keychain),
                  readSecret: () => Promise.reject(new Error('Unexpected secret read.')),
                  global: globalOptions(json),
                },
              );
            });
            const policy = source === 'policy';
            const projected = toUserFacing(error);
            const rendered = captureIo({});
            renderError(error, { json, verbose }, rendered.io);
            expect(rendered.out()).toBe('');
            expect(commandIo.out()).toBe('');
            expect(commandIo.err()).toBe('');
            if (json)
              expect(parseNdjson(rendered.err())).toEqual([
                { type: 'error', code: projected.code, message: projected.message },
              ]);
            else {
              expect(rendered.err()).toContain(`relavium: ${projected.message}\n`);
              if (verbose) {
                expect(rendered.err()).toContain(`${error.name}: ${error.message}\n`);
                expect(rendered.err()).toMatch(/\n\s+at /u);
              } else expect(rendered.err()).toBe(`relavium: ${projected.message}\n`);
            }
            // The causal diagnostic witness must inspect real verbose output before internal error-shape
            // checks: a key-bearing parser diagnostic should fail at its public rendering boundary.
            assertNoLegacy(rendered.err(), 'FS_CAUSAL_PROVIDER_HEADER_DIAGNOSTIC');
            expect(isProviderHeaderPolicyError(error)).toBe(policy);
            expect(error.name).toBe(policy ? 'ProviderHeaderPolicyError' : 'TypeError');
            expect(error.message).toBe(policy ? POLICY_MESSAGE : CORRUPT_MESSAGE);
            expect(Object.hasOwn(error, 'cause')).toBe(false);
            const ownProperties = Object.getOwnPropertyNames(error).map((key) => {
              const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value;
              return [key, value];
            });
            assertNoLegacy(JSON.stringify(ownProperties));
            expect(projected).toEqual({
              code: policy ? 'invalid_invocation' : 'internal',
              message: policy ? POLICY_MESSAGE : INTERNAL_MESSAGE,
              exitCode: policy ? 2 : 1,
            });
            expect(fetch).not.toHaveBeenCalled();
            expect(globalThis.fetch).not.toHaveBeenCalled();
            if (policy) assertTrustedLegacy(store);
          } finally {
            client.sqlite.close();
          }
        });
      }
    }
  }
});
