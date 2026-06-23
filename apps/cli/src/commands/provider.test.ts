import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProviderResolver,
  keyHint,
  providerKeyEnvVar,
  type ProviderResolver,
} from '../engine/providers.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { readSecretFromStdin } from '../secrets/read-secret.js';
import { captureIo } from '../test-support.js';
import { runProviderCommand, type ProviderCommandDeps } from './provider.js';

const TS_MS = new Date('2026-06-23T12:00:00.000Z').getTime();
// A fake key built from fragments so no contiguous secret literal exists (Leakwatch convention).
const RAW_KEY = ['sk', 'ant', 'FAKEKEY', '9999'].join('-');

/** A mutable in-memory keychain — the production `@napi-rs/keyring` accessor is never loaded by these tests. */
function memKeychain(
  seed: Record<string, string> = {},
): KeychainStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: (account) => map.get(account) ?? null,
    set: (account, secret) => {
      map.set(account, secret);
    },
    delete: (account) => map.delete(account),
  };
}

/** A stub resolver for `provider test` — `generate` resolves or rejects; `keyFor` returns a fixed key. */
function stubResolver(generate: LlmProvider['generate']): ProviderResolver {
  const provider: LlmProvider = {
    id: 'anthropic',
    generate,
    stream: () => {
      throw new Error('stream not used in provider test');
    },
    supports: {} as LlmProvider['supports'],
  };
  return { resolveProvider: () => provider, keyFor: () => RAW_KEY };
}

describe('relavium provider commands (2.C)', () => {
  let client: DbClient;
  let deps: (over: Partial<ProviderCommandDeps>) => ProviderCommandDeps;
  let io: ReturnType<typeof captureIo>;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    io = captureIo();
    let next = 0;
    const store = createProviderStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
      now: () => TS_MS,
    });
    deps = (over) => ({
      io: io.io,
      store,
      keychain: memKeychain(),
      resolver: stubResolver(() =>
        Promise.resolve({} as Awaited<ReturnType<LlmProvider['generate']>>),
      ),
      readSecret: () => Promise.resolve(RAW_KEY),
      ...over,
    });
  });

  afterEach(() => {
    client.sqlite.close();
  });

  it('set-key stores the key in the keychain + only a ref in the db — never the key value', async () => {
    const keychain = memKeychain();
    const d = deps({ keychain });
    const code = await runProviderCommand({ action: 'set-key', name: 'anthropic' }, d);
    expect(code).toBe(0);
    expect(keychain.get('anthropic:default')).toBe(RAW_KEY); // raw key in the keychain only
    const rec = d.store.get('anthropic');
    expect(rec?.apiKeyKeychainRef).toBe('anthropic:default'); // db row holds the ref
    expect(JSON.stringify(rec)).not.toContain(RAW_KEY); // ...never the key
    expect(io.out()).toContain('••••9999'); // a hint, never the full key
    expect(io.out()).not.toContain(RAW_KEY);
  });

  it('list shows registered providers and whether a key is set (no key echoed)', async () => {
    const keychain = memKeychain();
    const d = deps({ keychain });
    await runProviderCommand({ action: 'set-key', name: 'anthropic' }, d);
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    io.out(); // (accumulates; assert on the final list call)
    await runProviderCommand({ action: 'list' }, d);
    const text = io.out();
    expect(text).toContain('anthropic');
    expect(text).toContain('[key set]');
    expect(text).toContain('openai');
    expect(text).toContain('[no key]');
    expect(text).not.toContain(RAW_KEY);
  });

  it('remove-key deletes the keychain entry and clears the db ref', async () => {
    const keychain = memKeychain();
    const d = deps({ keychain });
    await runProviderCommand({ action: 'set-key', name: 'anthropic' }, d);
    const code = await runProviderCommand({ action: 'remove-key', name: 'anthropic' }, d);
    expect(code).toBe(0);
    expect(keychain.get('anthropic:default')).toBeNull();
    expect(d.store.get('anthropic')?.apiKeyKeychainRef).toBeUndefined();
  });

  it('test reports success when the provider generate resolves', async () => {
    const d = deps({
      resolver: stubResolver(() =>
        Promise.resolve({} as Awaited<ReturnType<LlmProvider['generate']>>),
      ),
    });
    const code = await runProviderCommand({ action: 'test', name: 'anthropic' }, d);
    expect(code).toBe(0);
    expect(io.out()).toContain('key works');
  });

  it('test fails cleanly (exit 2) and never puts the key in the error message', async () => {
    // The provider error even mentions the key text — the CLI must not re-emit it (it builds the message
    // from the provider error, never from the resolved key).
    const d = deps({
      resolver: stubResolver(() => Promise.reject(new Error('401 invalid api key'))),
    });
    let caught: unknown;
    try {
      await runProviderCommand({ action: 'test', name: 'anthropic' }, d);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ exitCode: 2 });
    expect((caught as Error).message).not.toContain(RAW_KEY);
  });

  it('set-key preserves a base URL set by a prior `add` (never clobbers it)', async () => {
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'openai', baseUrl: 'https://proxy.example/v1' },
      d,
    );
    await runProviderCommand({ action: 'set-key', name: 'openai' }, d);
    expect(d.store.get('openai')?.baseUrl).toBe('https://proxy.example/v1'); // not the SDK default
  });

  it('rejects an unknown provider name (exit 2)', async () => {
    await expect(
      runProviderCommand({ action: 'add', name: 'bogus' }, deps({})),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('maps a keychain-unavailable backend to a clean exit-2 message', async () => {
    const keychain: KeychainStore = {
      get: () => null,
      set: () => {
        throw new KeychainUnavailableError('no Secret Service');
      },
      delete: () => false,
    };
    await expect(
      runProviderCommand({ action: 'set-key', name: 'anthropic' }, deps({ keychain })),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('createProviderResolver keyFor — keychain → env var → error (2.C)', () => {
  it('prefers the OS keychain', () => {
    const keychain = memKeychain({ 'anthropic:default': 'from-keychain' });
    const resolver = createProviderResolver(
      { [providerKeyEnvVar('anthropic')]: 'from-env' },
      keychain,
    );
    expect(resolver.keyFor('anthropic')).toBe('from-keychain');
  });

  it('falls back to the env var when the keychain has no entry', () => {
    const resolver = createProviderResolver(
      { [providerKeyEnvVar('openai')]: 'from-env' },
      memKeychain(),
    );
    expect(resolver.keyFor('openai')).toBe('from-env');
  });

  it('falls through to the env var when the keychain backend is unavailable', () => {
    const keychain: KeychainStore = {
      get: () => {
        throw new KeychainUnavailableError('locked');
      },
      set: () => undefined,
      delete: () => false,
    };
    const resolver = createProviderResolver(
      { [providerKeyEnvVar('gemini')]: 'from-env' },
      keychain,
    );
    expect(resolver.keyFor('gemini')).toBe('from-env');
  });

  it('throws a clean invocation error (exit 2) when no source has a key', () => {
    const resolver = createProviderResolver({}, memKeychain());
    expect(() => resolver.keyFor('deepseek')).toThrowError(/no API key for provider 'deepseek'/);
  });
});

describe('keyHint', () => {
  it('shows only the last 4 chars, never the full key', () => {
    expect(keyHint(RAW_KEY)).toBe('••••9999');
    expect(keyHint(RAW_KEY)).not.toContain('sk-ant');
  });
  it('fully masks a too-short value', () => {
    expect(keyHint('abc')).toBe('••••');
  });
});

describe('readSecretFromStdin', () => {
  it('refuses to read a typed key from an interactive TTY (errors with a pipe hint, exit 2)', async () => {
    const original = process.stdin.isTTY;
    // A typed secret on an echoing terminal is the failure mode the stdin guard prevents — even if stdout
    // is redirected (the guard keys on stdin, not stdout).
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(readSecretFromStdin()).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});
