import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { providerKeyEnvVar, type ProviderResolver } from '../engine/providers.js';
import type { CliIo } from '../process/io.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import {
  isProviderKeyless,
  runOnboardingWizard,
  type ClackOnboardingDeps,
} from './wizard.js';

const CANCEL = Symbol('clack-cancel');

/** A scripted clack slice: fixed `select`/`password` results (a `symbol` = cancel), spies + captured notes/outros. */
function scriptedPrompter(script: { provider?: string | symbol; key?: string | symbol }): {
  prompter: ClackOnboardingDeps;
  select: ReturnType<typeof vi.fn>;
  password: ReturnType<typeof vi.fn>;
  notes: string[];
  outros: string[];
} {
  const notes: string[] = [];
  const outros: string[] = [];
  const select = vi.fn(() => Promise.resolve(script.provider ?? CANCEL));
  const password = vi.fn(() => Promise.resolve(script.key ?? CANCEL));
  const prompter: ClackOnboardingDeps = {
    intro: () => undefined,
    outro: (m) => {
      outros.push(m);
    },
    note: (m, t) => {
      notes.push(`${t ?? ''}\n${m}`);
    },
    select,
    password,
    isCancel: (v): v is symbol => typeof v === 'symbol',
  };
  return { prompter, select, password, notes, outros };
}

/** An in-memory keychain; `throwOnSet` makes `set` raise `KeychainUnavailableError` (the locked-keychain case). */
function memKeychain(opts: { throwOnSet?: boolean } = {}): KeychainStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (account) => store.get(account) ?? null,
    set: (account, secret) => {
      if (opts.throwOnSet === true) throw new KeychainUnavailableError('keychain is locked');
      store.set(account, secret);
    },
    delete: (account) => store.delete(account),
  };
}

/** A stub resolver — `provider set-key` never calls it, but `OnboardingDeps` requires it. */
const stubResolver: ProviderResolver = {
  resolveProvider: () => undefined,
  keyFor: () => {
    throw new Error('no key');
  },
};

const io: CliIo = {
  writeOut: () => undefined,
  writeErr: () => undefined,
  env: {},
  stdoutIsTty: true,
  stdinIsTty: true,
  stdin: Readable.from([]), // a real, already-ended stream (the wizard never reads it)
};

describe('isProviderKeyless', () => {
  it('is TRUE when every provider key resolution throws (no keychain + no env)', () => {
    expect(isProviderKeyless({ keyFor: () => { throw new Error('no key'); } })).toBe(true);
  });
  it('is FALSE as soon as one provider resolves a key (keychain or env)', () => {
    let calls = 0;
    const resolver = {
      keyFor: () => {
        calls += 1;
        if (calls === 1) throw new Error('no key'); // first provider: no key
        return 'a-key'; // a later provider resolves ⇒ not key-less
      },
    };
    expect(isProviderKeyless(resolver)).toBe(false);
  });
});

describe('runOnboardingWizard', () => {
  let client: DbClient;
  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
  });
  const store = (): ReturnType<typeof createProviderStore> =>
    createProviderStore(client.db, { uuid: () => 'id-fixed', now: () => 1 });

  it('stores the pasted key in the OS keychain + registers the provider row (secret-free)', async () => {
    const keychain = memKeychain();
    const s = store();
    const { prompter, notes, outros } = scriptedPrompter({
      provider: 'anthropic',
      key: 'sk-ant-supersecret-1234',
    });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io });

    // The key landed in the keychain under the provider account...
    expect(keychain.store.get(keychainAccount('anthropic'))).toBe('sk-ant-supersecret-1234');
    // ...the provider row + keychain-ref were registered...
    expect(s.get('anthropic')?.apiKeyKeychainRef).toBe(keychainAccount('anthropic'));
    // ...a "Connected" note shows only the key HINT (last 4), never the full key, and confirms + hands off.
    const all = [...notes, ...outros].join('\n');
    expect(all).toContain('••••1234');
    expect(all).not.toContain('sk-ant-supersecret-1234'); // the full key NEVER appears anywhere
    expect(outros.some((o) => o.includes('all set'))).toBe(true);
  });

  it('cancelling the provider select skips setup, writes NOTHING to the keychain', async () => {
    const keychain = memKeychain();
    const s = store();
    const { prompter, password, notes } = scriptedPrompter({ provider: CANCEL });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io });
    expect(keychain.store.size).toBe(0); // no key captured or stored
    expect(password).not.toHaveBeenCalled(); // never even prompted for a key
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });

  it('cancelling the key prompt skips setup, writes NOTHING to the keychain', async () => {
    const keychain = memKeychain();
    const s = store();
    const { prompter, notes } = scriptedPrompter({ provider: 'openai', key: CANCEL });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io });
    expect(keychain.store.size).toBe(0);
    expect(s.get('openai')).toBeUndefined(); // no row registered on cancel
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });

  it('on a keychain-write failure, guides to the env var — NEVER persists the key, never crashes', async () => {
    const keychain = memKeychain({ throwOnSet: true });
    const s = store();
    const { prompter, notes, outros } = scriptedPrompter({
      provider: 'gemini',
      key: 'sk-gem-secret-9999',
    });
    // Must resolve (not throw) — a keychain-unavailable first run degrades gracefully.
    await expect(
      runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io }),
    ).resolves.toBeUndefined();

    expect(keychain.store.size).toBe(0); // nothing persisted
    const all = [...notes, ...outros].join('\n');
    expect(all).toContain(providerKeyEnvVar('gemini')); // the env-var fallback is named (RELAVIUM_GEMINI_API_KEY)
    expect(all).not.toContain('sk-gem-secret-9999'); // the key is NEVER echoed, even in the fallback
    expect(all.toLowerCase()).toContain('keychain'); // the fallback explains why
  });
});
