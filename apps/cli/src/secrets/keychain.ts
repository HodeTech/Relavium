/**
 * The CLI's OS-keychain **seam** (workstream **2.C**) — the platform-free contract every consumer (the
 * `provider` commands, the key resolver) depends on, so they are unit-tested with an in-memory fake and
 * never touch the real keychain. The concrete `@napi-rs/keyring` accessor (the only file that loads the
 * native module) lives in `./os-keychain.ts` and implements this interface ([ADR-0019](../../../../docs/decisions/0019-cli-node-keychain-library.md)).
 *
 * Naming is the cross-surface scheme from [keychain-and-secrets.md](../../../../docs/reference/desktop/keychain-and-secrets.md):
 * `service = relavium`, `account = {providerId}:{keyId}` — one entry per key so keys rotate/revoke
 * independently. The key VALUE never leaves the keychain except as the outbound request's `Authorization`
 * header at call time; the `llm_providers` row stores only the `account` ref ([ADR-0006](../../../../docs/decisions/0006-os-keychain-for-api-keys.md)).
 */

const DEFAULT_KEY_ID = 'default';

/** The keychain `account` for a provider key — `{providerId}:{keyId}` (keychain-and-secrets.md §Entry naming). */
export function keychainAccount(providerId: string, keyId: string = DEFAULT_KEY_ID): string {
  return `${providerId}:${keyId}`;
}

/**
 * A platform-keychain backend failure — the store is **present but unusable** (locked keychain, no Linux
 * Secret Service, a denied prompt). Deliberately **distinct** from a key simply being absent (`get` → `null`):
 * absence falls through to the env-var source, but an unavailable backend must surface (no silent fallback,
 * keychain-and-secrets.md §Operational notes).
 */
export class KeychainUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeychainUnavailableError';
  }
}

export interface KeychainStore {
  /** The secret for `account`, or `null` when no entry exists. Throws {@link KeychainUnavailableError} on a backend failure. */
  get: (account: string) => string | null;
  /** Store (overwrite) the secret for `account`. Throws {@link KeychainUnavailableError} on a backend failure. */
  set: (account: string, secret: string) => void;
  /** Delete the entry; returns `false` when none existed. Throws {@link KeychainUnavailableError} on a backend failure. */
  delete: (account: string) => boolean;
}
