import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { llmProviders, type LlmProviderRow, type NewLlmProviderRow } from './schema.js';
import { epochMsToIso } from './time.js';

/**
 * Provider registry store (workstream **2.C**) — CRUD over the `llm_providers` catalog the CLI's
 * `relavium provider` commands manage, mirroring `session-store.ts` / `run-history-store.ts` (the mappers
 * are the single domain↔row + validation boundary; ids/timestamps are store-minted via injected deps).
 *
 * **The API key value is NEVER stored here** — only `apiKeyKeychainRef`, the OS-keychain `account`
 * identifier (`{providerId}:{keyId}`), per ADR-0006 / keychain-and-secrets.md. The key itself lives in the
 * OS keychain (the CLI accessor is `apps/cli/src/secrets/keychain.ts`, `@napi-rs/keyring` per ADR-0019).
 */

/** A registered provider — the non-secret row, with ISO timestamps. `apiKeyKeychainRef` is the keychain ref, never the key. */
export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** The OS-keychain `account` holding this provider's key, or `undefined` when no key is set. NEVER the key. */
  readonly apiKeyKeychainRef?: string;
  readonly defaultHeaders: Record<string, string>;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields a caller supplies to register/update a provider (the store mints id + timestamps). */
export interface ProviderUpsert {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly defaultHeaders?: Record<string, string>;
}

export interface ProviderStoreDeps {
  readonly uuid: () => string;
  readonly now: () => number;
}

export interface ProviderStore {
  /** All registered providers (active, not soft-deleted), by name. */
  list: () => ProviderRecord[];
  /** One provider by its unique `name`, or `undefined`. */
  get: (name: string) => ProviderRecord | undefined;
  /** Create or update (by `name`) the non-secret provider row; returns the resulting record. */
  upsert: (input: ProviderUpsert) => ProviderRecord;
  /** Record that a key is stored (the keychain `account` ref) — never the key value. */
  setKeychainRef: (name: string, ref: string) => void;
  /** Clear the keychain ref (the key was removed); the provider row stays registered. */
  clearKeychainRef: (name: string) => void;
}

function fromRow(row: LlmProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    ...(row.apiKeyKeychainRef === null ? {} : { apiKeyKeychainRef: row.apiKeyKeychainRef }),
    defaultHeaders: JSON.parse(row.defaultHeaders) as Record<string, string>,
    isActive: row.isActive,
    createdAt: epochMsToIso(row.createdAt),
    updatedAt: epochMsToIso(row.updatedAt),
  };
}

/** Wire a {@link ProviderStore} over a `@relavium/db` connection. */
export function createProviderStore(db: Db, deps: ProviderStoreDeps): ProviderStore {
  const activeRow = (name: string): LlmProviderRow | undefined =>
    db
      .select()
      .from(llmProviders)
      .where(and(eq(llmProviders.name, name), isNull(llmProviders.deletedAt)))
      .get();

  return {
    list: () =>
      db
        .select()
        .from(llmProviders)
        .where(isNull(llmProviders.deletedAt))
        .orderBy(asc(llmProviders.name))
        .all()
        .map(fromRow),

    get: (name) => {
      const row = activeRow(name);
      return row === undefined ? undefined : fromRow(row);
    },

    upsert: (input) => {
      const t = deps.now();
      const existing = activeRow(input.name);
      if (existing === undefined) {
        const row: NewLlmProviderRow = {
          id: deps.uuid(),
          name: input.name,
          displayName: input.displayName,
          baseUrl: input.baseUrl,
          defaultHeaders: JSON.stringify(input.defaultHeaders ?? {}),
          createdAt: t,
          updatedAt: t,
        };
        db.insert(llmProviders).values(row).run();
      } else {
        db.update(llmProviders)
          .set({
            displayName: input.displayName,
            baseUrl: input.baseUrl,
            defaultHeaders: JSON.stringify(input.defaultHeaders ?? existing.defaultHeaders),
            updatedAt: t,
          })
          .where(eq(llmProviders.id, existing.id))
          .run();
      }
      const row = activeRow(input.name);
      if (row === undefined) {
        throw new Error(`provider '${input.name}' not found after upsert`); // unreachable — just inserted/updated
      }
      return fromRow(row);
    },

    setKeychainRef: (name, ref) => {
      db.update(llmProviders)
        .set({ apiKeyKeychainRef: ref, updatedAt: deps.now() })
        .where(and(eq(llmProviders.name, name), isNull(llmProviders.deletedAt)))
        .run();
    },

    clearKeychainRef: (name) => {
      db.update(llmProviders)
        .set({ apiKeyKeychainRef: null, updatedAt: deps.now() })
        .where(and(eq(llmProviders.name, name), isNull(llmProviders.deletedAt)))
        .run();
    },
  };
}
