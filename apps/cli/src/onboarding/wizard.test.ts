import { Readable } from 'node:stream';

import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KNOWN_PROVIDERS, providerKeyEnvVar, type ProviderResolver } from '../engine/providers.js';
import type { CliIo } from '../process/io.js';
import {
  KeychainUnavailableError,
  keychainAccount,
  type KeychainStore,
} from '../secrets/keychain.js';
import type { ProviderKeyValidation } from '../engine/providers.js';
import {
  isProviderKeyless,
  runOnboardingWizard,
  type ClackOnboardingDeps,
} from './wizard.js';

const CANCEL = Symbol('clack-cancel');

/** A prompter that drains QUEUES of `select`/`password` results (for the retry flow) — a bare no-op spinner. */
function queuedPrompter(
  selects: (string | symbol)[],
  passwords: (string | symbol)[],
): { prompter: ClackOnboardingDeps; notes: string[]; outros: string[] } {
  const notes: string[] = [];
  const outros: string[] = [];
  const prompter: ClackOnboardingDeps = {
    intro: () => undefined,
    outro: (m) => {
      outros.push(m);
    },
    note: (m, t) => {
      notes.push(`${t ?? ''}\n${m}`);
    },
    select: () => Promise.resolve(selects.shift() ?? CANCEL),
    password: () => Promise.resolve(passwords.shift() ?? CANCEL),
    isCancel: (v): v is symbol => typeof v === 'symbol',
    spinner: () => ({ start: () => undefined, stop: () => undefined }),
  };
  return { prompter, notes, outros };
}

/** A scripted live-validation port draining a queue of outcomes (defaulting to ok when exhausted). */
function validateSeq(results: ProviderKeyValidation[]): (id: string, key: string) => Promise<ProviderKeyValidation> {
  return () => Promise.resolve(results.shift() ?? { ok: true, detail: 'ok', reason: 'ok' });
}

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

  it('stores the pasted key + registers the provider row + sets the chosen provider\'s starter model (secret-free)', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes, outros } = scriptedPrompter({
      provider: 'anthropic',
      key: '  sk-ant-supersecret-1234  ', // incidental paste whitespace — must be trimmed before storing
    });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io, writeDefaultModel });

    // The TRIMMED key landed in the keychain under the provider account (no stray whitespace persisted)...
    expect(keychain.store.get(keychainAccount('anthropic'))).toBe('sk-ant-supersecret-1234');
    // ...the provider row + keychain-ref were registered...
    expect(s.get('anthropic')?.apiKeyKeychainRef).toBe(keychainAccount('anthropic'));
    // ...the chosen provider's starter model was set as the default (so the NEXT chat binds a model whose key exists)...
    expect(writeDefaultModel).toHaveBeenCalledWith(KNOWN_PROVIDERS.anthropic.testModel);
    // ...a "Connected" note shows only the key HINT (last 4), never the full key, and confirms + hands off.
    const all = [...notes, ...outros].join('\n');
    expect(all).toContain('••••1234');
    expect(all).toContain(KNOWN_PROVIDERS.anthropic.testModel); // the starter model is surfaced
    expect(all).not.toContain('sk-ant-supersecret-1234'); // the full key NEVER appears anywhere
    expect(outros.some((o) => o.includes('all set'))).toBe(true);
  });

  it('a non-anthropic pick sets THAT provider\'s starter model (the "working chat" fix)', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter } = scriptedPrompter({ provider: 'openai', key: 'sk-openai-xyz' });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io, writeDefaultModel });
    // NOT the anthropic default — the openai starter, so a first chat doesn't try (and fail) an anthropic key.
    expect(writeDefaultModel).toHaveBeenCalledWith(KNOWN_PROVIDERS.openai.testModel);
    expect(KNOWN_PROVIDERS.openai.testModel).not.toBe(KNOWN_PROVIDERS.anthropic.testModel);
  });

  it('cancelling the provider select skips setup, writes NOTHING (no key, no default model)', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, password, notes } = scriptedPrompter({ provider: CANCEL });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io, writeDefaultModel });
    expect(keychain.store.size).toBe(0); // no key captured or stored
    expect(password).not.toHaveBeenCalled(); // never even prompted for a key
    expect(writeDefaultModel).not.toHaveBeenCalled(); // no default model written on cancel
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });

  it('cancelling the key prompt skips setup, writes NOTHING to the keychain', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes } = scriptedPrompter({ provider: 'openai', key: CANCEL });
    await runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io, writeDefaultModel });
    expect(keychain.store.size).toBe(0);
    expect(s.get('openai')).toBeUndefined(); // no row registered on cancel
    expect(writeDefaultModel).not.toHaveBeenCalled();
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });

  it('on a keychain-write failure, guides to the env var — NEVER persists the key or a default model, never crashes', async () => {
    const keychain = memKeychain({ throwOnSet: true });
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes, outros } = scriptedPrompter({
      provider: 'gemini',
      key: 'sk-gem-secret-9999',
    });
    // Must resolve (not throw) — a keychain-unavailable first run degrades gracefully.
    await expect(
      runOnboardingWizard({ prompter, store: s, keychain, resolver: stubResolver, io, writeDefaultModel }),
    ).resolves.toBeUndefined();

    expect(keychain.store.size).toBe(0); // nothing persisted to the keychain...
    expect(s.get('gemini')).toBeUndefined(); // ...and NO dangling provider row (keychain.set is first, so it fails atomically)
    expect(writeDefaultModel).not.toHaveBeenCalled(); // no default model on a failed store
    const all = [...notes, ...outros].join('\n');
    expect(all).toContain(providerKeyEnvVar('gemini')); // the env-var fallback is named (RELAVIUM_GEMINI_API_KEY)
    expect(all).not.toContain('sk-gem-secret-9999'); // the key is NEVER echoed, even in the fallback
    expect(all.toLowerCase()).toContain('keychain'); // the fallback explains why
  });

  it('an UNEXPECTED store fault (not keychain) shows a generic note, never mislabels it "keychain" or leaks the error', async () => {
    // keychain.set SUCCEEDS, but a later store step throws a PLAIN Error (a db write fault). The catch must route to
    // the generic "setup failed" branch — NOT the keychain branch — and never render the thrown message. The key is
    // in the keychain (set ran first), so the "key not saved" copy would LIE; the generic copy must be used instead.
    const keychain = memKeychain();
    const realStore = store();
    const brokenStore = {
      ...realStore,
      setKeychainRef: () => {
        throw new Error('db write failed: sensitive-context-xyz');
      },
    };
    const writeDefaultModel = vi.fn();
    const { prompter, notes, outros } = scriptedPrompter({ provider: 'deepseek', key: 'sk-ds-1234' });
    await expect(
      runOnboardingWizard({ prompter, store: brokenStore, keychain, resolver: stubResolver, io, writeDefaultModel }),
    ).resolves.toBeUndefined();

    const all = [...notes, ...outros].join('\n');
    expect(all).toContain('Setup failed'); // the generic branch, not the keychain branch
    expect(all).not.toContain('Keychain unavailable'); // never mislabel a db fault as a keychain failure
    expect(all).not.toContain('db write failed'); // the raw error is NEVER rendered
    expect(all).not.toContain('sk-ds-1234'); // and certainly not the key
    expect(keychain.store.get(keychainAccount('deepseek'))).toBe('sk-ds-1234'); // the key IS stored (set ran first)
    expect(writeDefaultModel).not.toHaveBeenCalled(); // no default model on a failed store
  });

  // ── Live key validation + retry UX (2.5.G S8) ─────────────────────────────────────────────
  it('a bad key (auth) → RETRY → a good key: stores the SECOND key, note says Verified', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes } = queuedPrompter(
      ['openai', 'retry'], // provider, then the retry-decision
      ['sk-bad-first', 'sk-good-second'], // initial key, then the re-entered key
    );
    await runOnboardingWizard({
      prompter,
      store: s,
      keychain,
      resolver: stubResolver,
      io,
      writeDefaultModel,
      validate: validateSeq([
        { ok: false, detail: 'key test failed — invalid_api_key', reason: 'auth' },
        { ok: true, detail: 'key works', reason: 'ok' },
      ]),
    });
    // The SECOND (re-entered) key is what landed — a bad key never reaches the keychain.
    expect(keychain.store.get(keychainAccount('openai'))).toBe('sk-good-second');
    const all = notes.join('\n');
    expect(all).toContain('Verified and stored');
    expect(all).not.toContain('sk-bad-first');
    expect(all).not.toContain('sk-good-second');
  });

  it('a bad key (auth) → CONTINUE anyway: stores the FIRST key, note says couldn\'t be verified (secret-free)', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes } = queuedPrompter(['openai', 'continue'], ['sk-unverified-key']);
    await runOnboardingWizard({
      prompter,
      store: s,
      keychain,
      resolver: stubResolver,
      io,
      writeDefaultModel,
      validate: validateSeq([{ ok: false, detail: 'key test failed — invalid_api_key', reason: 'auth' }]),
    });
    expect(keychain.store.get(keychainAccount('openai'))).toBe('sk-unverified-key'); // consciously accepted
    const all = notes.join('\n');
    expect(all).toContain("couldn't be verified");
    expect(all).not.toContain('sk-unverified-key'); // never echoed, even on the continue path
  });

  it('a NETWORK failure → default Continue (offline first-run isn\'t blocked): stores the key', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter } = queuedPrompter(['gemini', 'continue'], ['sk-offline-key']);
    await runOnboardingWizard({
      prompter,
      store: s,
      keychain,
      resolver: stubResolver,
      io,
      writeDefaultModel,
      validate: validateSeq([{ ok: false, detail: 'key test failed — timeout (10000ms)', reason: 'network' }]),
    });
    expect(keychain.store.get(keychainAccount('gemini'))).toBe('sk-offline-key');
    expect(writeDefaultModel).toHaveBeenCalledWith(KNOWN_PROVIDERS.gemini.testModel);
  });

  it('a bad key → RETRY → Esc on the re-prompt: SKIPS, keychain empty', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes } = queuedPrompter(['openai', 'retry'], ['sk-bad', CANCEL]);
    await runOnboardingWizard({
      prompter,
      store: s,
      keychain,
      resolver: stubResolver,
      io,
      writeDefaultModel,
      validate: validateSeq([{ ok: false, detail: 'key test failed — invalid_api_key', reason: 'auth' }]),
    });
    expect(keychain.store.size).toBe(0);
    expect(writeDefaultModel).not.toHaveBeenCalled();
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });

  it('a bad key → SKIP choice: keychain empty, no default written', async () => {
    const keychain = memKeychain();
    const s = store();
    const writeDefaultModel = vi.fn();
    const { prompter, notes } = queuedPrompter(['openai', 'skip'], ['sk-bad']);
    await runOnboardingWizard({
      prompter,
      store: s,
      keychain,
      resolver: stubResolver,
      io,
      writeDefaultModel,
      validate: validateSeq([{ ok: false, detail: 'key test failed — invalid_api_key', reason: 'auth' }]),
    });
    expect(keychain.store.size).toBe(0);
    expect(writeDefaultModel).not.toHaveBeenCalled();
    expect(notes.some((n) => n.includes('Skipped'))).toBe(true);
  });
});
