import { RelaviumError, PROVIDER_KINDS, type ProviderKind } from '@relavium/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { Db } from './client.js';
import { withBusyRetry } from './retry.js';
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

/** A trusted provider row with ISO timestamps. API keys are refs only; legacy headers remain sensitive. */
export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** The OS-keychain `account` holding this provider's key, or `undefined` when no key is set. NEVER the key. */
  readonly apiKeyKeychainRef?: string;
  /** Sensitive legacy data for trusted readers only; never consumed as HTTP headers or publicly projected. */
  readonly defaultHeaders: Record<string, string>;
  /** The provider's protocol `kind` (ADR-0065 §5) — a custom OpenAI-compatible `base_url` reuses it. `undefined`
   *  when unset (the host derives it from the closed provider id) or a foreign stored value (fail-closed to unset). */
  readonly kind?: ProviderKind;
  /** A pricing-page URL (ADR-0065 §5, a UX pointer for user-supplied pricing — S10). `undefined` when unset. */
  readonly pricingReferenceUrl?: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields a caller supplies to register/update a provider (the store mints id + timestamps). */
export interface ProviderUpsert {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Omission preserves legacy bytes; an explicitly empty map clears them. Nonempty maps are refused. */
  readonly defaultHeaders?: Record<string, string>;
  readonly kind?: ProviderKind;
  readonly pricingReferenceUrl?: string;
}

export interface ProviderStoreDeps {
  readonly uuid: () => string;
  readonly now: () => number;
}

export interface ProviderStore {
  /** All registered (not soft-deleted) providers, by name. */
  list: () => ProviderRecord[];
  /** One provider by its unique `name`, or `undefined`. */
  get: (name: string) => ProviderRecord | undefined;
  /** Create/update by name. New nonempty headers are refused; trusted returned legacy headers remain sensitive. */
  upsert: (input: ProviderUpsert) => ProviderRecord;
  /** Record that a key is stored (the keychain `account` ref) — never the key value. */
  setKeychainRef: (name: string, ref: string) => void;
  /** Clear the keychain ref (the key was removed); the provider row stays registered. */
  clearKeychainRef: (name: string) => void;
}

const HEADER_POLICY_MESSAGE =
  'Provider headers are disabled until keychain custody is implemented.';
const INVALID_STORED_HEADERS = 'Stored provider headers are invalid.';

/** Content-free interim admission refusal (ADR-0108); never retain the supplied map or a foreign cause. */
export class ProviderHeaderPolicyError extends RelaviumError {
  readonly code = 'provider_header_policy';

  constructor() {
    super(HEADER_POLICY_MESSAGE);
    this.name = 'ProviderHeaderPolicyError';
  }
}

/** Own data discriminants, rather than bundled class identity; accessors/reflection faults never qualify. */
export function isProviderHeaderPolicyError(value: unknown): value is ProviderHeaderPolicyError {
  try {
    if (!(value instanceof Error)) return false;
    return (
      Object.getOwnPropertyDescriptor(value, 'code')?.value === 'provider_header_policy' &&
      Object.getOwnPropertyDescriptor(value, 'name')?.value === 'ProviderHeaderPolicyError' &&
      Object.getOwnPropertyDescriptor(value, 'message')?.value === HEADER_POLICY_MESSAGE
    );
  } catch {
    // A predicate over foreign values refuses uninspectable objects without evaluating their fields.
    return false;
  }
}

/** Capture only the admitted field branch before clock callbacks, retries or SQL can run. */
function captureHeaderWrite(input: ProviderUpsert): 'preserve' | 'clear' {
  try {
    const field = Object.getOwnPropertyDescriptor(input, 'defaultHeaders');
    if (field === undefined) {
      if (Reflect.has(input, 'defaultHeaders')) throw new ProviderHeaderPolicyError();
      return 'preserve';
    }
    if (!('value' in field)) throw new ProviderHeaderPolicyError();
    const headers: unknown = field.value;
    if (headers === undefined) return 'preserve';
    if (headers === null || typeof headers !== 'object') throw new ProviderHeaderPolicyError();
    const prototype: unknown = Object.getPrototypeOf(headers);
    if (prototype !== null && prototype !== Object.prototype) throw new ProviderHeaderPolicyError();
    if (Reflect.ownKeys(headers).length !== 0) throw new ProviderHeaderPolicyError();
    return 'clear';
  } catch {
    // Normalize foreign reflection faults without retaining the map, key/value or payload-bearing cause.
    throw new ProviderHeaderPolicyError();
  }
}

/**
 * Parse a stored `default_headers` JSON-text column into a validated `Record<string, string>` — `unknown`
 * + a runtime shape check at the DB read boundary (code-style-typescript.md §Boundaries; no unsafe `as`).
 * A corrupt/foreign-shaped value (malformed JSON, a non-object, or a non-string member) aborts the read
 * loudly rather than propagating a wrongly-typed value, mirroring the sibling stores' `JSON.parse` posture.
 */
function parseStringRecord(json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Native SyntaxError diagnostics may include the stored payload. Keep corruption loud and content-free.
    throw new TypeError(INVALID_STORED_HEADERS);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(INVALID_STORED_HEADERS);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new TypeError(INVALID_STORED_HEADERS);
    }
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Validate the stored `kind` against the closed {@link PROVIDER_KINDS} set at the DB read boundary — no DB CHECK
 * exists (a SQLite `ALTER ADD` limitation), so a tampered/foreign value must not be trusted. A `null` (unset) or a
 * non-member value degrades to `undefined` (treated as "no explicit kind"; the host derives the kind from the
 * closed provider id) — a foreign protocol string is never mistaken for a real `kind`. Mirrors `coerceModelCatalogSource`.
 */
function coerceProviderKind(value: string | null): ProviderKind | undefined {
  if (value === null) return undefined;
  return PROVIDER_KINDS.find((kind) => kind === value);
}

function fromRow(row: LlmProviderRow): ProviderRecord {
  const kind = coerceProviderKind(row.kind);
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    ...(row.apiKeyKeychainRef === null ? {} : { apiKeyKeychainRef: row.apiKeyKeychainRef }),
    defaultHeaders: parseStringRecord(row.defaultHeaders),
    ...(kind === undefined ? {} : { kind }),
    ...(row.pricingReferenceUrl === null ? {} : { pricingReferenceUrl: row.pricingReferenceUrl }),
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
      const headerWrite = captureHeaderWrite(input);
      const t = deps.now();
      // Read-then-write upsert under ONE IMMEDIATE transaction: two concurrent `provider add` (or a refresh)
      // writers must not both read `existing === undefined` and double-insert, nor race a DEFERRED read→write
      // lock upgrade. `BEGIN IMMEDIATE` serializes them; `withBusyRetry` waits out residual cross-process
      // contention, fail-loud (ADR-0064 amendment note — DB write-path concurrency).
      return withBusyRetry(() =>
        db.transaction(
          () => {
            const existing = activeRow(input.name);
            if (existing === undefined) {
              const row: NewLlmProviderRow = {
                id: deps.uuid(),
                name: input.name,
                displayName: input.displayName,
                baseUrl: input.baseUrl,
                defaultHeaders: '{}',
                ...(input.kind === undefined ? {} : { kind: input.kind }),
                ...(input.pricingReferenceUrl === undefined
                  ? {}
                  : { pricingReferenceUrl: input.pricingReferenceUrl }),
                createdAt: t,
                updatedAt: t,
              };
              db.insert(llmProviders).values(row).run();
            } else {
              db.update(llmProviders)
                .set({
                  displayName: input.displayName,
                  baseUrl: input.baseUrl,
                  // Preserve exact legacy JSON on omission; the sole explicit write is canonical empty JSON.
                  // Never serialize or reread the caller's map after admission.
                  defaultHeaders: headerWrite === 'preserve' ? existing.defaultHeaders : '{}',
                  // Preserve an existing kind / pricing URL when the caller omits it (like defaultHeaders).
                  ...(input.kind === undefined ? {} : { kind: input.kind }),
                  ...(input.pricingReferenceUrl === undefined
                    ? {}
                    : { pricingReferenceUrl: input.pricingReferenceUrl }),
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
          { behavior: 'immediate' },
        ),
      );
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
