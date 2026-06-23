import { Entry } from '@napi-rs/keyring';

import { KeychainUnavailableError, type KeychainStore } from './keychain.js';

/**
 * The concrete OS-keychain accessor over `@napi-rs/keyring` (a maintained N-API credential lib — **not** the
 * archived `keytar`, [ADR-0019](../../../../docs/decisions/0019-cli-node-keychain-library.md)). This is the
 * **only** module that loads the native binding; the `provider` commands and the key resolver depend on the
 * platform-free {@link KeychainStore} interface (`./keychain.ts`), so they unit-test against an in-memory
 * fake. Production (`commands/specs.ts`) injects this one.
 */

const SERVICE = 'relavium';

/** Wire a {@link KeychainStore} over the OS keychain via `@napi-rs/keyring` (service `relavium`). */
export function createOsKeychainStore(service: string = SERVICE): KeychainStore {
  const entry = (account: string): Entry => new Entry(service, account);
  return {
    get: (account) => {
      try {
        return entry(account).getPassword(); // `null` for an absent entry — not an error in @napi-rs/keyring
      } catch (err) {
        throw new KeychainUnavailableError(`OS keychain is unavailable: ${errMessage(err)}`, {
          cause: err,
        });
      }
    },
    set: (account, secret) => {
      try {
        entry(account).setPassword(secret);
      } catch (err) {
        throw new KeychainUnavailableError(
          `could not write to the OS keychain: ${errMessage(err)}`,
          {
            cause: err,
          },
        );
      }
    },
    delete: (account) => {
      try {
        return entry(account).deletePassword();
      } catch (err) {
        throw new KeychainUnavailableError(`could not access the OS keychain: ${errMessage(err)}`, {
          cause: err,
        });
      }
    },
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
