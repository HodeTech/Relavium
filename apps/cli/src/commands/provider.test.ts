import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import type { LlmProvider } from '@relavium/llm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProviderResolver,
  keyHint,
  providerKeyEnvVar,
  type ProviderResolver,
} from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { KeychainUnavailableError, type KeychainStore } from '../secrets/keychain.js';
import { readSecretFromStdin } from '../secrets/read-secret.js';
import { captureIo, parseNdjson } from '../test-support.js';
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
    // `provider test` only calls `generate`; `supports` is never read here. A real CapabilityFlags fixture
    // would have to satisfy the schema's `vision === media.input.image` refine (+ the nested media shape) and
    // would couple this test to that evolving seam schema for zero assertion value — hence a bare stub cast.
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
      global: { json: false, color: false, cwd: process.cwd(), configPath: undefined, verbosity: 'normal' },
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

  it('list --verify reports "verified" when a provider live probe succeeds (2.5.G S11)', async () => {
    const d = deps({}); // the default stub resolver resolves generate ⇒ probe ok
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    io.out();
    await runProviderCommand({ action: 'list', verify: true }, d);
    expect(io.out()).toContain('[verified]');
  });

  it('list --verify reports "failed — <redacted>" on a probe failure, NEVER echoing the key', async () => {
    const d = deps({ resolver: stubResolver(() => Promise.reject(new Error(`boom ${RAW_KEY}`))) });
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    io.out();
    await runProviderCommand({ action: 'list', verify: true }, d);
    const text = io.out();
    expect(text).toContain('failed');
    expect(text).not.toContain(RAW_KEY); // validateProviderKey redacts the key in the detail
  });

  it('list --verify reports "no key" for a provider with no resolvable key — and never probes it (no hang)', async () => {
    const stub = stubResolver(() => Promise.resolve({} as Awaited<ReturnType<LlmProvider['generate']>>));
    const noKeyResolver: ProviderResolver = {
      resolveProvider: stub.resolveProvider,
      keyFor: () => {
        throw new CliError('invalid_invocation', 'no API key'); // matches real keyFor's absence throw
      },
    };
    const d = deps({ resolver: noKeyResolver });
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    io.out();
    await runProviderCommand({ action: 'list', verify: true }, d);
    expect(io.out()).toContain('[no key]'); // reported without a probe (keyFor threw before generate)
  });

  it('list --json emits one key-free NDJSON record per provider with the verify state (2.5.G S11)', async () => {
    const jsonGlobal = {
      json: true,
      color: false,
      cwd: process.cwd(),
      configPath: undefined,
      verbosity: 'normal' as const,
    };
    // Register two providers WITH keys via a non-json setup (their confirmations don't pollute the json capture).
    const setup = deps({});
    await runProviderCommand({ action: 'set-key', name: 'anthropic' }, setup);
    await runProviderCommand({ action: 'set-key', name: 'openai' }, setup);
    const listIo = captureIo();
    await runProviderCommand(
      { action: 'list', verify: true },
      deps({ io: listIo.io, global: jsonGlobal }),
    );
    const records = parseNdjson(listIo.out());
    expect(records).toHaveLength(2);
    const anthropic = records.find((r) => r['name'] === 'anthropic');
    expect(anthropic).toMatchObject({ keySet: true, verified: true, verifyDetail: null });
    expect(listIo.out()).not.toContain(RAW_KEY); // no key ever in the machine output
  });

  it('list --json without --verify leaves verified/verifyDetail null (no probe)', async () => {
    const jsonGlobal = {
      json: true,
      color: false,
      cwd: process.cwd(),
      configPath: undefined,
      verbosity: 'normal' as const,
    };
    await runProviderCommand({ action: 'add', name: 'openai' }, deps({}));
    const listIo = captureIo();
    await runProviderCommand({ action: 'list' }, deps({ io: listIo.io, global: jsonGlobal }));
    const [rec] = parseNdjson(listIo.out());
    expect(rec).toMatchObject({ name: 'openai', keySet: false, verified: null, verifyDetail: null });
  });

  const jsonGlobal = {
    json: true,
    color: false,
    cwd: process.cwd(),
    configPath: undefined,
    verbosity: 'normal' as const,
  };

  it('list --json --verify records a probe FAILURE as { verified: false, verifyDetail: <redacted> } (no key)', async () => {
    await runProviderCommand({ action: 'add', name: 'openai' }, deps({}));
    const listIo = captureIo();
    await runProviderCommand(
      { action: 'list', verify: true },
      deps({
        io: listIo.io,
        global: jsonGlobal,
        resolver: stubResolver(() => Promise.reject(new Error(`boom ${RAW_KEY}`))),
      }),
    );
    const [rec] = parseNdjson(listIo.out());
    expect(rec).toMatchObject({ name: 'openai', verified: false });
    expect(typeof rec?.['verifyDetail']).toBe('string'); // a redacted reason is present
    expect(listIo.out()).not.toContain(RAW_KEY);
  });

  it('list --json --verify distinguishes keyless (verified:null, verifyDetail:"no key") from not-probed', async () => {
    const stub = stubResolver(() => Promise.resolve({} as Awaited<ReturnType<LlmProvider['generate']>>));
    const noKeyResolver: ProviderResolver = {
      resolveProvider: stub.resolveProvider,
      keyFor: () => {
        throw new CliError('invalid_invocation', 'no API key');
      },
    };
    await runProviderCommand({ action: 'add', name: 'openai' }, deps({}));
    const listIo = captureIo();
    await runProviderCommand(
      { action: 'list', verify: true },
      deps({ io: listIo.io, global: jsonGlobal, resolver: noKeyResolver }),
    );
    const [rec] = parseNdjson(listIo.out());
    // Distinct from the no-`--verify` record (which is verified:null, verifyDetail:null).
    expect(rec).toMatchObject({ verified: null, verifyDetail: 'no key' });
  });

  it('list --verify strips terminal-control bytes from a crafted provider error on the human line', async () => {
    const d = deps({
      // A rogue provider error carrying an ANSI screen-clear (ESC) + a bare CR line-overwrite.
      resolver: stubResolver(() => Promise.reject(new Error('bad \x1b[2J\r end'))),
    });
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    io.out();
    await runProviderCommand({ action: 'list', verify: true }, d);
    const text = io.out();
    expect(text).not.toContain('\x1b'); // the ESC byte is stripped
    expect(text).not.toContain('\r'); // the CR is collapsed (one row stays one line)
    expect(text).toContain('failed'); // the row still renders the failure state
  });

  it('list --verify PROPAGATES an unexpected keyFor fault (not "no key") — a locked/faulted keychain is loud', async () => {
    // A non-`invalid_invocation` error (e.g. a native keychain-binding fault) must NOT be mislabeled "no key" for
    // every provider; it propagates as the command's fault. verifyProvider re-throws it → Promise.all rejects.
    const stub = stubResolver(() => Promise.resolve({} as Awaited<ReturnType<LlmProvider['generate']>>));
    const faulted: ProviderResolver = {
      resolveProvider: stub.resolveProvider,
      keyFor: () => {
        throw new Error('native keychain binding crashed');
      },
    };
    const d = deps({ resolver: faulted });
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    await expect(runProviderCommand({ action: 'list', verify: true }, d)).rejects.toThrow(
      'native keychain binding crashed',
    );
  });

  it('list --verify probes providers CONCURRENTLY, not serially (a barrier deadlocks a sequential loop)', async () => {
    // Two providers; each probe blocks until BOTH have started. A concurrent Promise.all releases the barrier; a
    // sequential `await` loop would block forever on the first (the 2nd never starts) — so this test only passes
    // when the probes run concurrently. A generous timeout keeps a genuine deadlock from hanging CI.
    let started = 0;
    let releaseBarrier: () => void = () => undefined;
    const barrier = new Promise<void>((res) => {
      releaseBarrier = res;
    });
    const concurrentGen: LlmProvider['generate'] = async () => {
      started += 1;
      if (started === 2) releaseBarrier();
      await barrier;
      return {} as Awaited<ReturnType<LlmProvider['generate']>>;
    };
    const d = deps({ resolver: stubResolver(concurrentGen) });
    await runProviderCommand({ action: 'set-key', name: 'anthropic' }, d);
    await runProviderCommand({ action: 'set-key', name: 'openai' }, d);
    io.out();
    await runProviderCommand({ action: 'list', verify: true }, d);
    expect(started).toBe(2); // both probes ran (the barrier could only release if they overlapped)
    expect(io.out()).toContain('[verified]');
  }, 2000);

  it('add --base-url REJECTS a control/bidi-bearing URL at the door (never stored or echoed)', async () => {
    for (const evil of [
      'https://x.example.com/\x1b[2Jpath', // ANSI screen-clear in the path
      'https://x.example.com/\u202eevil', // a bidi RIGHT-TO-LEFT OVERRIDE (U+202E)
      'https://x.example.com/a\r b', // a bare CR
    ]) {
      await expect(
        runProviderCommand({ action: 'add', name: 'openai', baseUrl: evil }, deps({})),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
    }
    // Nothing was stored for openai (every attempt was rejected before the upsert).
    expect(deps({}).store.get('openai')).toBeUndefined();
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

  it('test fails cleanly (exit 2) and redacts the key even if the provider error contains it', async () => {
    // The provider error embeds the raw key — the CLI must redact it (the key is in scope at the catch).
    const d = deps({
      resolver: stubResolver(() =>
        Promise.reject(new Error(`401 unauthorized: ${RAW_KEY} rejected`)),
      ),
    });
    let caught: unknown;
    try {
      await runProviderCommand({ action: 'test', name: 'anthropic' }, d);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ exitCode: 2 });
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(RAW_KEY); // redacted...
    expect(message).toContain('••••9999'); // ...to the hint
  });

  it('rejects a non-HTTPS or malformed --base-url (exit 2)', async () => {
    // HTTPS-only at store time — a plaintext `http:` endpoint must never be persisted, and a
    // non-`http(s)` scheme is rejected outright (matches the routing-time `assertHttpsBaseUrl` gate).
    for (const baseUrl of ['http://proxy.example/v1', 'file:///etc/passwd', 'not-a-url']) {
      await expect(
        runProviderCommand({ action: 'add', name: 'openai', baseUrl }, deps({})),
      ).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('rejects a private/loopback or credential-bearing --base-url (fail-fast SSRF, exit 2) (2.5.G S9)', async () => {
    for (const baseUrl of [
      'https://localhost/v1',
      'https://127.0.0.1/v1',
      'https://192.168.1.10/v1',
      'https://169.254.169.254/latest', // link-local metadata
      'https://user:pass@proxy.example/v1', // embedded credentials
    ]) {
      await expect(
        runProviderCommand({ action: 'add', name: 'openai', baseUrl }, deps({})),
      ).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('refuses a custom --base-url on a NON-OpenAI-compatible provider (anthropic/gemini, exit 2) (ADR-0065 §3)', async () => {
    for (const name of ['anthropic', 'gemini']) {
      await expect(
        runProviderCommand({ action: 'add', name, baseUrl: 'https://proxy.example/v1' }, deps({})),
      ).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('stores a custom openai-compatible --base-url + the provider kind (ADR-0065 §3/§5)', async () => {
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'deepseek', baseUrl: 'https://my-proxy.example/v1' },
      d,
    );
    const row = d.store.get('deepseek');
    expect(row?.baseUrl).toBe('https://my-proxy.example/v1');
    expect(row?.kind).toBe('openai-compatible'); // the protocol kind is populated (§5)
  });

  it('populates the provider kind on a plain add (no --base-url) too — for uniformity (§5)', async () => {
    const d = deps({});
    await runProviderCommand({ action: 'add', name: 'anthropic' }, d);
    expect(d.store.get('anthropic')?.kind).toBe('anthropic');
  });

  it('a second `add` with NO --base-url preserves a prior custom base_url (never silently resets it) (2.5.G S9)', async () => {
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'openai', baseUrl: 'https://my-proxy.example/v1' },
      d,
    );
    await runProviderCommand({ action: 'add', name: 'openai' }, d); // re-run, no --base-url
    expect(d.store.get('openai')?.baseUrl).toBe('https://my-proxy.example/v1'); // preserved, not reset to the SDK default
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

  it('seeds the default pricing_reference_url on a plain add + set-key (2.5.G S10)', async () => {
    const d = deps({});
    await runProviderCommand({ action: 'add', name: 'openai' }, d);
    expect(d.store.get('openai')?.pricingReferenceUrl).toBe(
      'https://platform.openai.com/docs/pricing',
    );
    // set-key alone (no prior add) also seeds it — so a provider registered by set-key carries the pointer.
    await runProviderCommand({ action: 'set-key', name: 'anthropic' }, d);
    expect(d.store.get('anthropic')?.pricingReferenceUrl).toBe(
      'https://platform.claude.com/docs/en/about-claude/pricing',
    );
  });

  it('stores a validated custom --pricing-url (normalized href), overriding the default (S10)', async () => {
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'openai', pricingUrl: 'https://wiki.internal/prices' },
      d,
    );
    // Normalized via `new URL().href` (a trailing slash is added for a bare-host URL) — terminal-safe.
    expect(d.store.get('openai')?.pricingReferenceUrl).toBe('https://wiki.internal/prices');
  });

  it('rejects a non-HTTPS / credential-bearing --pricing-url (exit 2), unlike base_url it allows any host', async () => {
    for (const pricingUrl of ['http://x.example/p', 'https://u:p@x.example/p', 'not-a-url']) {
      await expect(
        runProviderCommand({ action: 'add', name: 'openai', pricingUrl }, deps({})),
      ).rejects.toMatchObject({ code: 'invalid_invocation' });
    }
    // A private/loopback host IS allowed for a pricing pointer (display-only, never fetched → no SSRF concern).
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'openai', pricingUrl: 'https://localhost/prices' },
      d,
    );
    expect(d.store.get('openai')?.pricingReferenceUrl).toBe('https://localhost/prices');
  });

  it('a second `add` with NO --pricing-url preserves a prior custom pricing pointer (never resets it)', async () => {
    const d = deps({});
    await runProviderCommand(
      { action: 'add', name: 'openai', pricingUrl: 'https://wiki.internal/prices' },
      d,
    );
    await runProviderCommand({ action: 'add', name: 'openai' }, d); // re-run, no --pricing-url
    expect(d.store.get('openai')?.pricingReferenceUrl).toBe('https://wiki.internal/prices');
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
    // Capture the FULL original descriptor so the restore reinstates it exactly (a value-only restore would
    // leave a synthetic data property where there may have been an accessor / a different configurability).
    const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    // A typed secret on an echoing terminal is the failure mode the stdin guard prevents — even if stdout
    // is redirected (the guard keys on stdin, not stdout).
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(readSecretFromStdin()).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      if (original === undefined) {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdin, 'isTTY', original);
      }
    }
  });
});
