import { createClient, createProviderStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { CliError } from '../process/errors.js';
import { renderError } from '../process/render-error.js';
import { KeychainUnavailableError } from '../secrets/keychain.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { captureIo } from '../test-support.js';
import { runProviderCommand, type ProviderCommandDeps } from './provider.js';

// Exercise the real bridge and command; this constructable module mock never imports a native binding.
const native = vi.hoisted(() => {
  const construct = vi.fn<(service: string, account: string) => void>();
  const get = vi.fn<() => string | null>();
  const set = vi.fn<(secret: string) => void>();
  const remove = vi.fn<() => boolean>();
  class Entry {
    constructor(service: string, account: string) {
      construct(service, account);
    }
    getPassword(): string | null {
      return get();
    }
    setPassword(secret: string): void {
      set(secret);
    }
    deletePassword(): boolean {
      return remove();
    }
  }
  return { Entry, construct, get, set, remove };
});
vi.mock('@napi-rs/keyring', () => ({ Entry: native.Entry }));

// Opaque synthetic values have no recognisable credential prefix: regex scrubbing cannot save a leak.
const SECRET = 'opaque-payload-M43';
const NATIVE_DETAIL = 'opaque-native-detail-W82';
const SERVICE = 'opaque-service-N69';
const ACCOUNT = 'anthropic:default';
const MODES = [
  { json: false, verbose: false },
  { json: false, verbose: true },
  { json: true, verbose: false },
  { json: true, verbose: true },
];

async function catchCommandFailure(run: () => Promise<unknown>): Promise<CliError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught instanceof CliError).toBe(true);
  if (!(caught instanceof CliError)) throw new Error('expected typed CLI refusal');
  return caught;
}

describe('actual OS bridge → provider command → diagnostic rendering (Wave 2 Step 3)', () => {
  let client: DbClient;
  let store: ProviderCommandDeps['store'];

  beforeEach(() => {
    native.construct.mockReset();
    native.get.mockReset().mockReturnValue(null);
    native.set.mockReset();
    native.remove.mockReset().mockReturnValue(false);
    client = createClient(':memory:');
    runMigrations(client.db);
    let next = 0;
    store = createProviderStore(client.db, {
      uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`,
      now: () => 1782230400000,
    });
  });

  afterEach(() => {
    client.sqlite.close();
  });

  function dependencies(mode: { readonly json: boolean; readonly verbose: boolean }): {
    readonly deps: ProviderCommandDeps;
    readonly io: ReturnType<typeof captureIo>;
    readonly keyFor: ReturnType<typeof vi.fn<ProviderResolver['keyFor']>>;
    readonly resolveProvider: ReturnType<typeof vi.fn<ProviderResolver['resolveProvider']>>;
  } {
    const io = captureIo();
    const keyFor = vi.fn<ProviderResolver['keyFor']>().mockReturnValue(SECRET);
    const resolveProvider = vi.fn<ProviderResolver['resolveProvider']>().mockReturnValue(undefined);
    return {
      io,
      keyFor,
      resolveProvider,
      deps: {
        store,
        io: io.io,
        keychain: createOsKeychainStore(SERVICE),
        resolver: { keyFor, resolveProvider },
        readSecret: () => Promise.resolve(`  ${SECRET}\r\n`),
        global: {
          json: mode.json,
          color: false,
          cwd: process.cwd(),
          configPath: undefined,
          verbosity: mode.verbose ? 'verbose' : 'normal',
        },
      },
    };
  }

  for (const action of ['set-key', 'remove-key'] as const) {
    for (const site of ['constructor', 'method']) {
      for (const registered of [false, true]) {
        for (const mode of MODES) {
          it(`${action} ${site} refusal, registered=${registered}, json=${mode.json}, verbose=${mode.verbose} preserves DB refs and renders only the fixed error`, async () => {
            store.upsert({
              name: 'openai',
              displayName: 'Other synthetic provider',
              baseUrl: 'https://fixture.invalid/v1',
            });
            store.setKeychainRef('openai', 'existing-other-ref');
            if (registered) {
              store.upsert({
                name: 'anthropic',
                displayName: 'Synthetic provider',
                baseUrl: 'https://fixture.invalid/v2',
              });
              store.setKeychainRef('anthropic', 'existing-target-ref');
            }
            const before = store.list();
            const failure = new Error(`${NATIVE_DETAIL} ${SERVICE} ${ACCOUNT} ${SECRET}`);
            const fail = (): never => {
              throw failure;
            };
            if (site === 'constructor') native.construct.mockImplementation(fail);
            else if (action === 'set-key') native.set.mockImplementation(fail);
            else native.remove.mockImplementation(fail);
            const { deps, io, keyFor, resolveProvider } = dependencies(mode);
            expect(native.construct).not.toHaveBeenCalled();

            const caught = await catchCommandFailure(() =>
              runProviderCommand({ action, name: 'anthropic' }, deps),
            );
            const message =
              action === 'set-key'
                ? 'could not write to the OS keychain.'
                : 'could not access the OS keychain.';
            expect(caught.code).toBe('invalid_invocation');
            expect(caught.exitCode).toBe(2);
            expect(caught.message).toBe(message);
            const bridgeError = caught.cause;
            expect(bridgeError instanceof KeychainUnavailableError).toBe(true);
            if (!(bridgeError instanceof KeychainUnavailableError))
              throw new Error('expected private bridge cause');
            expect(bridgeError.cause === failure).toBe(true);
            expect(native.construct).toHaveBeenCalledExactlyOnceWith(SERVICE, ACCOUNT);
            expect(native.set).toHaveBeenCalledTimes(
              site === 'method' && action === 'set-key' ? 1 : 0,
            );
            expect(native.remove).toHaveBeenCalledTimes(
              site === 'method' && action === 'remove-key' ? 1 : 0,
            );
            if (site === 'method' && action === 'set-key')
              expect(native.set).toHaveBeenCalledWith(SECRET);
            expect(native.get).not.toHaveBeenCalled();
            expect(keyFor).not.toHaveBeenCalled();
            expect(resolveProvider).not.toHaveBeenCalled();
            expect(store.list()).toEqual(before);

            renderError(caught, mode, io.io);
            expect(io.out()).toBe('');
            for (const forbidden of [SECRET, NATIVE_DETAIL, SERVICE, ACCOUNT])
              expect(io.err()).not.toContain(forbidden);
            if (mode.json) {
              const envelope: unknown = JSON.parse(io.err());
              expect(envelope).toEqual({ type: 'error', code: 'invalid_invocation', message });
              expect(io.err().trimEnd().split('\n')).toHaveLength(1);
            } else {
              const ownStack: unknown = Object.getOwnPropertyDescriptor(
                bridgeError,
                'stack',
              )?.value;
              // V8 versions represent native stacks as data or lazy accessors. Only data is eligible.
              if (mode.verbose && typeof ownStack === 'string') {
                expect(io.err()).toContain(`relavium: ${message}\n`);
                expect(io.err()).toContain(`CliError: ${message}`);
              } else expect(io.err()).toBe(`relavium: ${message}\n`);
            }
          });
        }
      }
    }
  }

  it('successful mocked-native set/remove retain the established command and DB behavior', async () => {
    const { deps, io } = dependencies({ json: false, verbose: false });
    expect(await runProviderCommand({ action: 'set-key', name: 'anthropic' }, deps)).toBe(0);
    expect(native.set).toHaveBeenCalledExactlyOnceWith(SECRET);
    expect(store.get('anthropic')?.apiKeyKeychainRef).toBe(ACCOUNT);
    native.remove.mockReturnValueOnce(true);
    expect(await runProviderCommand({ action: 'remove-key', name: 'anthropic' }, deps)).toBe(0);
    expect(store.get('anthropic')?.apiKeyKeychainRef).toBeUndefined();
    expect(native.construct.mock.calls).toEqual([
      [SERVICE, ACCOUNT],
      [SERVICE, ACCOUNT],
    ]);
    expect(io.out()).toContain('Stored anthropic key');
    expect(io.out()).toContain('Removed anthropic key');
    expect(io.out()).not.toContain(SECRET);
    expect(io.err()).toBe('');
  });

  it('the real resolver retains environment fallback after an actual bridge get failure', () => {
    const failure = new Error(NATIVE_DETAIL);
    native.get.mockImplementation(() => {
      throw failure;
    });
    const resolver = createProviderResolver(
      { RELAVIUM_GEMINI_API_KEY: SECRET },
      createOsKeychainStore(),
    );
    expect(resolver.keyFor('gemini')).toBe(SECRET);
    expect(native.construct).toHaveBeenCalledExactlyOnceWith('relavium', 'gemini:default');
    expect(native.get).toHaveBeenCalledTimes(1);
    expect(native.set).not.toHaveBeenCalled();
    expect(native.remove).not.toHaveBeenCalled();
  });
});
