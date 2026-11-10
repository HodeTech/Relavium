import type { ProviderRecord } from '@relavium/db';
import type { ProviderId } from '@relavium/llm';
import { GlobalConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../process/errors.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { isolateSdkEnvironment, offlineOpenAiReply } from './fixtures/provider-header-fixture.js';
import {
  createProviderResolver,
  KNOWN_PROVIDER_IDS,
  providerHasKey,
  providerKeyAvailability,
  providerKeyAvailabilityMessage,
  providerKeyEnvVar,
} from './providers.js';
import {
  createStandardEnvKeyPolicy,
  STANDARD_PROVIDER_KEY_ENV_VARS,
} from './standard-env-policy.js';

beforeEach(() => isolateSdkEnvironment());
afterEach(() => vi.unstubAllEnvs());

const first = ['synthetic', 'credential', 'first-secret-value'].join('-');
const second = ['synthetic', 'credential', 'second-secret-value'].join('-');
const third = ['synthetic', 'credential', 'third-secret-value'].join('-');

function fakeKeychain(get: KeychainStore['get'] = () => null): KeychainStore {
  return { get, set: vi.fn(), delete: vi.fn(() => false) };
}
function row(id: ProviderId, baseUrl: string): ProviderRecord {
  return {
    id: `synthetic-${id}`,
    name: id,
    displayName: id,
    baseUrl,
    defaultHeaders: {},
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function unavailable(): never {
  // Deliberately hostile backend detail must never be copied into an observation or missing-key error.
  throw new KeychainUnavailableError(`backend detail ${first}`, { cause: { credential: second } });
}

describe('MVP-2 per-attempt standard credential resolution', () => {
  it.each(KNOWN_PROVIDER_IDS)(
    'uses only the fixed %s source after keychain and Relavium env',
    (id) => {
      const standardName = STANDARD_PROVIDER_KEY_ENV_VARS[id];
      const relaviumName = providerKeyEnvVar(id);
      const env: Record<string, string | undefined> = {
        [standardName]: third,
        [relaviumName]: second,
      };
      let stored: string | null = first;
      const get = vi.fn(() => stored);
      const resolver = createProviderResolver(env, fakeKeychain(get));
      expect(resolver.keyFor(id)).toBe(first);
      expect(providerKeyAvailability(resolver, id)).toEqual({
        status: 'usable',
        source: { kind: 'keychain', label: 'OS keychain' },
        keychainHealth: 'available',
      });
      expect(get).toHaveBeenCalledWith(`${id}:default`);
      stored = null;
      expect(resolver.keyFor(id)).toBe(second);
      expect(providerKeyAvailability(resolver, id)).toMatchObject({
        source: { kind: 'relavium-env', name: relaviumName },
      });
      env[relaviumName] = '';
      expect(resolver.keyFor(id)).toBe(third);
      expect(providerKeyAvailability(resolver, id)).toMatchObject({
        source: { kind: 'standard-env', name: standardName },
      });
      env[standardName] = first;
      expect(resolver.keyFor(id)).toBe(first);
      env[standardName] = '';
      expect(providerHasKey(resolver, id)).toBe(false);
      expect(providerKeyAvailability(resolver, id)).toEqual({
        status: 'missing',
        keychainHealth: 'available',
      });
      expect(() => resolver.keyFor(id)).toThrow(CliError);
    },
  );

  it('guards actual adapter egress for chat/validation and model discovery, with current authorized values', async () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: first };
    const policy = createStandardEnvKeyPolicy();
    const headers: Array<string | null> = [];
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      headers.push(request.headers.get('authorization'));
      return Promise.resolve(
        request.method === 'GET'
          ? new Response(
              JSON.stringify({ object: 'list', data: [{ id: 'gpt-fixture', object: 'model' }] }),
              { headers: { 'content-type': 'application/json' } },
            )
          : offlineOpenAiReply('gpt-fixture'),
      );
    });
    const resolver = createProviderResolver(env, undefined, {
      standardEnvPolicy: policy,
      // Explicit official spelling retains endpointKind while injecting an entirely offline transport.
      providerStore: { list: () => [row('openai', 'https://api.openai.com/v1/')] },
      validatedFetch: fetch,
    });
    const provider = resolver.resolveProvider('openai');
    if (provider === undefined || provider.listModels === undefined)
      throw new Error('missing fixture adapter');
    const request = {
      model: 'gpt-fixture',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'offline' }] }],
      maxTokens: 1,
    };
    const generate = () => provider.generate(request, resolver.keyFor('openai'));
    const discover = () => provider.listModels?.(resolver.keyFor('openai'));
    expect(generate).toThrow('has not been allowed');
    expect(discover).toThrow('has not been allowed');
    expect(fetch).not.toHaveBeenCalled();
    policy.allowForInvocation('openai');
    await generate();
    env['OPENAI_API_KEY'] = second;
    expect(await discover()).toEqual([{ id: 'gpt-fixture' }]);
    expect(headers).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
    env['OPENAI_API_KEY'] = '';
    expect(generate).toThrow('no API key');
    expect(discover).toThrow('no API key');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never reads GOOGLE_API_KEY as a Gemini alias', () => {
    const reads: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>(
      { GOOGLE_API_KEY: first },
      {
        get: (target, name: string) => {
          reads.push(name);
          return target[name];
        },
      },
    );
    const resolver = createProviderResolver(env);
    expect(providerHasKey(resolver, 'gemini')).toBe(false);
    expect(reads).toEqual(['RELAVIUM_GEMINI_API_KEY', 'GEMINI_API_KEY']);
  });

  it('enforces interactive consent at actual keyFor and hasKey, reading the current value each time', () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: first };
    const policy = createStandardEnvKeyPolicy();
    const resolver = createProviderResolver(env, undefined, {
      standardEnvPolicy: policy,
      credentialSurface: 'home',
    });
    const egress = vi.fn();
    const attempt = (): void => {
      egress(resolver.keyFor('openai'));
    };
    expect(() => attempt()).toThrow('has not been allowed');
    expect(egress).not.toHaveBeenCalled();
    expect(providerHasKey(resolver, 'openai')).toBe(false);
    expect(providerKeyAvailability(resolver, 'openai')).toEqual({
      status: 'present-standard-not-allowed',
      source: { kind: 'standard-env', name: 'OPENAI_API_KEY' },
      keychainHealth: 'not-configured',
    });
    policy.defer('openai');
    expect(policy.isDeferred('openai')).toBe(true);
    expect(() => attempt()).toThrow('/providers');
    expect(egress).not.toHaveBeenCalled();
    env['OPENAI_API_KEY'] = second;
    policy.allowForInvocation('openai');
    expect(policy.isDeferred('openai')).toBe(false);
    attempt();
    expect(egress).toHaveBeenLastCalledWith(second);
    env['OPENAI_API_KEY'] = third;
    attempt();
    expect(egress).toHaveBeenLastCalledWith(third);
    env['OPENAI_API_KEY'] = '';
    expect(providerHasKey(resolver, 'openai')).toBe(false);
    expect(() => attempt()).toThrow('no API key');
    expect(egress).toHaveBeenCalledTimes(2);
  });

  it('initializes remembered names only from validated selected-global prefs; restart removes revoked/ephemeral grants', () => {
    const global = GlobalConfigSchema.parse({
      preferences: { standard_env_key_consent: { openai: 'OPENAI_API_KEY' } },
    });
    const policy = createStandardEnvKeyPolicy(global.preferences);
    const env = { OPENAI_API_KEY: first, GEMINI_API_KEY: second };
    const resolver = createProviderResolver(env, undefined, { standardEnvPolicy: policy });
    expect(resolver.keyFor('openai')).toBe(first);
    expect(() => resolver.keyFor('gemini')).toThrow('has not been allowed');
    expect(policy.allows('openai', 'GEMINI_API_KEY')).toBe(false);
    policy.allowForInvocation('gemini');
    expect(resolver.keyFor('gemini')).toBe(second);
    // A new invocation uses only what is actually read. Removal does not mutate an existing invocation.
    const empty = GlobalConfigSchema.parse({ preferences: { standard_env_key_consent: {} } });
    const restarted = createProviderResolver(env, undefined, {
      standardEnvPolicy: createStandardEnvKeyPolicy(empty.preferences),
    });
    expect(providerHasKey(restarted, 'openai')).toBe(false);
    expect(providerHasKey(restarted, 'gemini')).toBe(false);
    expect(resolver.keyFor('openai')).toBe(first);
    expect(global.preferences?.standard_env_key_consent).toEqual({ openai: 'OPENAI_API_KEY' });
  });

  it.each(['openai', 'deepseek'] as const)(
    'blocks a standard %s key on actual custom adapter, even with consent',
    (id) => {
      const env: Record<string, string | undefined> = {
        [STANDARD_PROVIDER_KEY_ENV_VARS[id]]: first,
      };
      const policy = createStandardEnvKeyPolicy();
      policy.allowForInvocation(id);
      const fetch = vi.fn(() => Promise.reject(new Error('no real network')));
      const resolver = createProviderResolver(env, fakeKeychain(), {
        providerStore: { list: () => [row(id, 'https://gateway.example/v1')] },
        validatedFetch: fetch,
        standardEnvPolicy: policy,
      });
      expect(resolver.endpointKind?.(id)).toBe('custom');
      expect(() => resolver.keyFor(id)).toThrow('custom endpoint');
      expect(providerHasKey(resolver, id)).toBe(false);
      expect(providerKeyAvailability(resolver, id)).toEqual({
        status: 'ineligible-custom-endpoint',
        source: { kind: 'standard-env', name: STANDARD_PROVIDER_KEY_ENV_VARS[id] },
        keychainHealth: 'available',
      });
      env[providerKeyEnvVar(id)] = second;
      expect(resolver.keyFor(id)).toBe(second);
      expect(fetch).not.toHaveBeenCalled();
      const stored = createProviderResolver(
        env,
        fakeKeychain(() => third),
        {
          providerStore: { list: () => [row(id, 'https://gateway.example/v1')] },
          validatedFetch: fetch,
        },
      );
      expect(stored.keyFor(id)).toBe(third);
    },
  );

  it.each([
    ['openai', 'https://API.OPENAI.COM./v1/'],
    ['deepseek', 'https://API.DEEPSEEK.COM./'],
  ] as const)(
    'allows standard %s on explicitly spelled official endpoint by actual adapter classification',
    (id, url) => {
      const resolver = createProviderResolver(
        { [STANDARD_PROVIDER_KEY_ENV_VARS[id]]: first },
        undefined,
        {
          providerStore: { list: () => [row(id, url)] },
          validatedFetch: vi.fn(() => Promise.reject(new Error('no real network'))),
        },
      );
      expect(resolver.endpointKind?.(id)).toBe('official');
      expect(resolver.keyFor(id)).toBe(first);
    },
  );

  it('also blocks standard credentials for a refusing malformed custom endpoint', () => {
    const resolver = createProviderResolver({ OPENAI_API_KEY: first }, undefined, {
      providerStore: { list: () => [row('openai', 'http://localhost/v1')] },
    });
    expect(resolver.endpointKind?.('openai')).toBe('custom');
    expect(() => resolver.keyFor('openai')).toThrow('custom endpoint');
  });
});

describe('MVP-2 value-free availability and independent keychain health', () => {
  it('preserves genuine unavailability with usable Relavium/standard env, pending/ineligible sources, and absence', () => {
    for (const env of [{ RELAVIUM_OPENAI_API_KEY: first }, { OPENAI_API_KEY: first }]) {
      const resolver = createProviderResolver(env, fakeKeychain(unavailable));
      expect(resolver.keyFor('openai')).toBe(first);
      expect(providerKeyAvailability(resolver, 'openai')).toMatchObject({
        status: 'usable',
        keychainHealth: 'unavailable',
      });
    }
    const policy = createStandardEnvKeyPolicy();
    const pending = createProviderResolver({ OPENAI_API_KEY: first }, fakeKeychain(unavailable), {
      standardEnvPolicy: policy,
    });
    expect(providerKeyAvailability(pending, 'openai')).toMatchObject({
      status: 'present-standard-not-allowed',
      keychainHealth: 'unavailable',
    });
    const custom = createProviderResolver({ OPENAI_API_KEY: first }, fakeKeychain(unavailable), {
      providerStore: { list: () => [row('openai', 'https://gateway.example')] },
    });
    expect(providerKeyAvailability(custom, 'openai')).toMatchObject({
      status: 'ineligible-custom-endpoint',
      keychainHealth: 'unavailable',
    });
    const missing = createProviderResolver({}, fakeKeychain(unavailable));
    expect(providerKeyAvailability(missing, 'openai')).toEqual({
      status: 'unavailable',
      keychainHealth: 'unavailable',
    });
    expect(() => missing.keyFor('openai')).toThrow('OS keychain is unavailable');
  });

  it('distinguishes a functioning empty backend from optional injection absence', () => {
    expect(
      providerKeyAvailability(createProviderResolver({}, fakeKeychain()), 'anthropic'),
    ).toEqual({ status: 'missing', keychainHealth: 'available' });
    expect(providerKeyAvailability(createProviderResolver({}), 'anthropic')).toEqual({
      status: 'missing',
      keychainHealth: 'not-configured',
    });
    expect(
      providerKeyAvailability(
        createProviderResolver(
          {},
          fakeKeychain(() => ''),
        ),
        'anthropic',
      ),
    ).toEqual({ status: 'missing', keychainHealth: 'available' });
  });

  it('propagates unexpected native binding faults on every actual resolver path', () => {
    const fault = new Error('unexpected native binding fault');
    const resolver = createProviderResolver(
      { OPENAI_API_KEY: first },
      fakeKeychain(() => {
        throw fault;
      }),
    );
    expect(() => resolver.keyFor('openai')).toThrow(fault);
    expect(() => providerHasKey(resolver, 'openai')).toThrow(fault);
    expect(() => providerKeyAvailability(resolver, 'openai')).toThrow(fault);
  });

  it('exposes fixed names/labels and no values, suffixes, backend details or nested causes', () => {
    const cases = [
      createProviderResolver({ OPENAI_API_KEY: first }, fakeKeychain(unavailable), {
        standardEnvPolicy: createStandardEnvKeyPolicy(),
        credentialSurface: 'home',
      }),
      createProviderResolver({}, fakeKeychain(unavailable)),
      createProviderResolver({ RELAVIUM_OPENAI_API_KEY: first }, fakeKeychain(unavailable)),
      createProviderResolver(
        {},
        fakeKeychain(() => first),
      ),
    ];
    for (const resolver of cases) {
      const observation = providerKeyAvailability(resolver, 'openai');
      let error: unknown;
      try {
        resolver.keyFor('openai');
      } catch (caught) {
        error = caught;
      }
      const publicText =
        JSON.stringify({ observation, error }) +
        (error instanceof Error ? error.message : '') +
        providerKeyAvailabilityMessage('openai', observation, 'home');
      for (const forbidden of [
        first,
        second,
        first.slice(-4),
        second.slice(-4),
        'backend detail',
        'cause',
      ]) {
        expect(publicText).not.toContain(forbidden);
      }
    }
  });

  it('uses the actual host remedy without suggesting unavailable Home commands in standalone chat', () => {
    const resolver = createProviderResolver({ OPENAI_API_KEY: first }, undefined, {
      standardEnvPolicy: createStandardEnvKeyPolicy(),
    });
    const state = providerKeyAvailability(resolver, 'openai');
    expect(providerKeyAvailabilityMessage('openai', state, 'home')).toContain('/providers');
    expect(providerKeyAvailabilityMessage('openai', state, 'standalone-chat')).toContain(
      'restart `relavium chat`',
    );
    expect(providerKeyAvailabilityMessage('openai', state, 'standalone-chat')).not.toContain(
      '/providers',
    );
    expect(
      providerKeyAvailabilityMessage(
        'openai',
        { status: 'missing', keychainHealth: 'available' },
        'shell',
      ),
    ).toContain('relavium provider set-key openai');
  });

  it('keeps legacy injected stubs safe without inventing backend failure or reading key values into state', () => {
    const keyed = { keyFor: () => first };
    const keyless = {
      keyFor: () => {
        throw new Error(`stub ${first}`);
      },
    };
    expect(providerKeyAvailability(keyed, 'openai')).toEqual({
      status: 'usable',
      source: { kind: 'injected', label: 'Injected resolver' },
      keychainHealth: 'unknown',
    });
    expect(providerKeyAvailability(keyless, 'openai')).toEqual({
      status: 'missing',
      keychainHealth: 'unknown',
    });
    const fault = new Error('unexpected hasKey fault');
    expect(() =>
      providerKeyAvailability(
        {
          ...keyed,
          hasKey: () => {
            throw fault;
          },
        },
        'openai',
      ),
    ).toThrow(fault);
  });
});
