import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KeychainUnavailableError, type KeychainStore } from './keychain.js';
import { createOsKeychainStore } from './os-keychain.js';

// A constructable replacement installed before the bridge import: never load the native binding.
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

const ACCOUNT = 'opaque-account-Q72';
const SECRET = '  opaque-value-P91\r\n';

interface Operation {
  readonly name: 'get' | 'set' | 'delete';
  readonly message: string;
  readonly marker: string;
  readonly invoke: (store: KeychainStore) => unknown;
  readonly failMethod: (failure: unknown) => void;
  readonly methodCalls: () => number;
}

const operations: readonly Operation[] = [
  {
    name: 'get',
    message: 'OS keychain is unavailable.',
    marker: 'SECRETS_CAUSAL_KEYCHAIN_GET',
    invoke: (store) => store.get(ACCOUNT),
    failMethod: (failure) =>
      native.get.mockImplementation(() => {
        throw failure;
      }),
    methodCalls: () => native.get.mock.calls.length,
  },
  {
    name: 'set',
    message: 'could not write to the OS keychain.',
    marker: 'SECRETS_CAUSAL_KEYCHAIN_SET',
    invoke: (store) => store.set(ACCOUNT, SECRET),
    failMethod: (failure) =>
      native.set.mockImplementation(() => {
        throw failure;
      }),
    methodCalls: () => native.set.mock.calls.length,
  },
  {
    name: 'delete',
    message: 'could not access the OS keychain.',
    marker: 'SECRETS_CAUSAL_KEYCHAIN_DELETE',
    invoke: (store) => store.delete(ACCOUNT),
    failMethod: (failure) =>
      native.remove.mockImplementation(() => {
        throw failure;
      }),
    methodCalls: () => native.remove.mock.calls.length,
  },
];

function hostileFailure(error: boolean): { readonly value: unknown; readonly reads: () => number } {
  let reads = 0;
  const value = error ? new Error('opaque-native-D42') : {};
  for (const name of ['message', 'toString', Symbol.toPrimitive]) {
    Object.defineProperty(value, name, {
      get: () => {
        reads += 1;
        throw new Error('foreign error properties must remain unread');
      },
      configurable: true,
    });
  }
  return { value, reads: () => reads };
}

const failures: readonly {
  readonly name: string;
  readonly make: () => { readonly value: unknown; readonly reads: () => number };
}[] = [
  {
    name: 'Error with opaque content',
    make: () => ({ value: new Error('opaque-native-D42'), reads: () => 0 }),
  },
  { name: 'string', make: () => ({ value: 'opaque-native-D42', reads: () => 0 }) },
  { name: 'number', make: () => ({ value: 73, reads: () => 0 }) },
  { name: 'null', make: () => ({ value: null, reads: () => 0 }) },
  { name: 'undefined', make: () => ({ value: undefined, reads: () => 0 }) },
  { name: 'symbol', make: () => ({ value: Symbol('opaque-native-D42'), reads: () => 0 }) },
  { name: 'hostile object', make: () => hostileFailure(false) },
  { name: 'hostile Error', make: () => hostileFailure(true) },
];

function catchKeychainFailure(invoke: () => unknown): KeychainUnavailableError {
  let caught: unknown;
  try {
    invoke();
  } catch (error) {
    caught = error;
  }
  // Do not ask the matcher to inspect/stringify the foreign cause, even when a regression occurs.
  expect(caught instanceof KeychainUnavailableError).toBe(true);
  if (!(caught instanceof KeychainUnavailableError))
    throw new Error('expected typed keychain failure');
  return caught;
}

describe('OS keychain bridge (ADR-0019, Wave 2 Step 3)', () => {
  beforeEach(() => {
    native.construct.mockReset();
    native.get.mockReset().mockReturnValue(null);
    native.set.mockReset();
    native.remove.mockReset().mockReturnValue(false);
  });

  it('constructs entries lazily per operation and forwards default service, account and verbatim secret', () => {
    const store = createOsKeychainStore();
    expect(native.construct).not.toHaveBeenCalled();
    native.get.mockReturnValueOnce(SECRET);
    expect(store.get(ACCOUNT)).toBe(SECRET);
    expect(store.get(ACCOUNT)).toBeNull();
    expect(store.set(ACCOUNT, SECRET)).toBeUndefined();
    native.remove.mockReturnValueOnce(true);
    expect(store.delete(ACCOUNT)).toBe(true);
    expect(store.delete(ACCOUNT)).toBe(false);
    expect(native.construct.mock.calls).toEqual(
      Array.from({ length: 5 }, () => ['relavium', ACCOUNT]),
    );
    expect(native.get).toHaveBeenCalledTimes(2);
    expect(native.set).toHaveBeenCalledExactlyOnceWith(SECRET);
    expect(native.remove).toHaveBeenCalledTimes(2);
  });

  it('forwards a custom service and each distinct account through the actual mocked Entry constructor', () => {
    const store = createOsKeychainStore('synthetic-service');
    expect(native.construct).not.toHaveBeenCalled();
    store.get('first-account');
    store.set('second-account', SECRET);
    store.delete('third-account');
    expect(native.construct.mock.calls).toEqual([
      ['synthetic-service', 'first-account'],
      ['synthetic-service', 'second-account'],
      ['synthetic-service', 'third-account'],
    ]);
  });

  for (const operation of operations) {
    for (const site of ['constructor', 'method']) {
      for (const fixture of failures) {
        it(`${operation.marker} ${operation.name} wraps ${site} ${fixture.name} without inspecting it`, () => {
          const failure = fixture.make();
          if (site === 'constructor')
            native.construct.mockImplementation(() => {
              throw failure.value;
            });
          else operation.failMethod(failure.value);
          const caught = catchKeychainFailure(() => operation.invoke(createOsKeychainStore()));
          expect(caught.message, operation.marker).toBe(operation.message);
          expect(caught.cause === failure.value).toBe(true);
          expect(failure.reads()).toBe(0);
          expect(native.construct).toHaveBeenCalledExactlyOnceWith('relavium', ACCOUNT);
          expect(operation.methodCalls()).toBe(site === 'constructor' ? 0 : 1);
        });
      }
    }
  }
});
