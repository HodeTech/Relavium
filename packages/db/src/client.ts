import { RelaviumError } from '@relavium/shared';

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrateWithOwnedStorageFacts } from './migration-storage-origin.js';
import {
  hasOwnedClient,
  rememberOwnedClient,
  transferStorageFailure,
  withOwnedFilesystem,
  withOwnedSqlite,
} from './storage-failure-facts.js';

import { withMigrationLock } from './migrate-lock.js';
import * as schema from './schema.js';
import { withBusyRetry } from './retry.js';
import { initializeSessionEffectTurnKeys } from './session-effect-turns.js';
import {
  clearLegacySessionEffectResults,
  requireSessionEffectTransactionOwnership,
  type SessionEffectCheckpoint,
} from './session-effect-privacy.js';

/**
 * The local SQLite client for `@relavium/db`, wired over `better-sqlite3`
 * ([ADR-0021](../../../docs/decisions/0021-node-sqlite-driver-better-sqlite3.md)) and
 * Drizzle. This is the **Node-side** path (CLI, tests); the desktop reaches SQLite
 * through the Rust `tauri-plugin-sql` and does not load this driver.
 *
 * Scope is schema/migrations only (Phase 0 workstream 0.I) — no engine wiring. SQLCipher
 * encryption-at-rest (ADR-0005) is applied by the desktop's Rust setup hook, not here.
 */

/** A schema-bound Drizzle handle, including its public native-client transaction-state port. */
export type Db = BetterSQLite3Database<typeof schema> & {
  readonly $client: Database.Database;
};

/**
 * The handle a `db.transaction(...)` callback receives — the one a transaction body must issue its statements
 * through (#W15-23).
 *
 * Under `better-sqlite3` the outer {@link Db} and this handle share a connection, so using the outer one
 * inside a transaction body is invisible. It is not invisible on the other half of ADR-0005's promise: with a
 * pooled Postgres driver `tx` is a distinct client, and a statement issued through the outer handle runs
 * OUTSIDE the transaction — committed even when the transaction rolls back. Derived by the driver type rather
 * than written out, so it cannot drift from whatever `Db` is.
 */
export type TxDb = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A connected client: the Drizzle handle plus the raw driver for lifecycle control. */
export interface DbClient {
  readonly db: Db;
  /** The underlying better-sqlite3 connection (call `.close()` when done). */
  readonly sqlite: Database.Database;
  /**
   * The path this client was opened on (`':memory:'` for the default). Carried so a caller can pass it to
   * {@link runMigrations} for the ADR-0073 cross-process migration lock without having to remember it
   * separately from the handle.
   */
  readonly path: string;
}

/** Why {@link createClient} refused or failed to open a database — narrow on this, never on the message. */
export type DbOpenErrorCode =
  /** A `file:…` SQLite URI filename, which this factory deliberately does not support. */
  | 'uri_unsupported'
  /** The driver or the parent-directory `mkdir` failed (locked, corrupt, permission, missing dir). */
  | 'open_failed';

/**
 * A typed `history.db` open failure — the package convention (`SafeEgressError`, `MediaWriteError`), so a
 * caller narrows on `.code` rather than matching a message (`docs/standards/error-handling.md`).
 *
 * The `message` names a **reason only**: the database path rides as the structured {@link DbOpenError.path}
 * field instead of being interpolated into it. That is the same rule the sibling errors follow, and it matters
 * here because this message is surfaced verbatim to the user by the CLI's history openers — an absolute path
 * carries the OS username, which a user-facing error is not supposed to leak. A caller that wants to show it
 * still can, redacted, from the field.
 */
export class DbOpenError extends RelaviumError {
  readonly code: DbOpenErrorCode;
  /** The database path that was requested. A diagnostic field — deliberately NOT part of `message`. */
  readonly path: string;
  constructor(code: DbOpenErrorCode, message: string, path: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbOpenError';
    this.code = code;
    this.path = path;
  }
}

/**
 * Open a SQLite database and return a schema-bound Drizzle client. `path` defaults to a
 * private in-memory database; pass a filesystem path for a persistent local store.
 * Throws a typed {@link DbOpenError} on a rejected or failed open.
 *
 * Applies the project PRAGMAs — the canonical home for what they are for is
 * [database-schema.md §Concurrency & transaction behavior](../../../docs/reference/shared-core/database-schema.md#concurrency--transaction-behavior):
 *
 * - `journal_mode = WAL` — readers never block the single writer, and vice-versa (a no-op for in-memory).
 * - `foreign_keys = ON` — SQLite does not enforce FKs per connection by default, and the schema's CASCADE
 *   rules depend on it.
 * - `busy_timeout = 5000` — SQLite's built-in busy handler waits up to 5 s for a contended lock before
 *   returning `SQLITE_BUSY`. Load-bearing for the concurrent-process write path, and the term that dominates
 *   `withBusyRetry`'s worst case ([retry.ts](./retry.ts)).
 * - `synchronous = NORMAL` — the recommended durability/throughput trade-off under WAL.
 * - `secure_delete = ON` — overwrite deleted session-effect payload bytes; WAL erasure also needs a checkpoint.
 */
export function createClient(
  path = ':memory:',
  captureClose?: (close: () => void) => void,
): DbClient {
  // SQLite URI filenames (`file:…`) are NOT supported: better-sqlite3 needs `{ uri: true }` to
  // interpret them and otherwise silently creates a literal file of that name. Reject up front
  // rather than open the wrong database — pass ':memory:' or a plain filesystem path.
  if (path.startsWith('file:')) {
    throw new DbOpenError(
      'uri_unsupported',
      "SQLite URI paths are not supported by createClient — pass ':memory:' or a filesystem path",
      path,
    );
  }
  let close: (() => void) | undefined;
  try {
    // Create the parent directory for a real file path so a first-run open doesn't fail on a
    // missing folder (inside the try so a filesystem error is classified the same way).
    if (path !== ':memory:') {
      withOwnedFilesystem(() => mkdirSync(dirname(path), { recursive: true }));
    }
    const opened = withOwnedSqlite(() => new Database(path));
    close = () => {
      if (opened.open) opened.close();
    };
    // The original invocation owns this exact native capability before PRAGMAs or Drizzle can fail.
    // Returning a DbClient is too late to transfer a partially constructed connection.
    captureClose?.(close);
    // The PRAGMAs and the Drizzle bind are INSIDE the try: any of them can fail (a corrupt header surfaces on
    // the first `journal_mode` write, not on open), and outside it a failure would leak the just-opened
    // connection for the process lifetime AND escape as an untyped driver error — past both this factory's
    // typed-error contract and `openLocalDb`'s cleanup/at-rest handling.
    //
    // **The WAL switch is RETRIED, because `busy_timeout` does not cover this one.** Converting a database
    // to WAL takes an EXCLUSIVE lock, and SQLite returns `SQLITE_BUSY` for it WITHOUT invoking the busy
    // handler — waiting there could deadlock, so it refuses instead. Two Relavium processes opening one
    // fresh `history.db` at the same moment therefore raced and the loser's OPEN failed outright: measured
    // at 18 failures in 30 paired spawns, and 0 in 30 with this retry. What a user saw was `relavium run`
    // refusing to start because another Relavium happened to be starting.
    //
    // The two-process migration test had been reporting this intermittently and it was read as test flake.
    // It was not: `createClient` is the shipping open path. (Setting `busy_timeout` first was measured too,
    // and does NOT help — 15/25 with it first against 17/25 with it second — so the pragma order is left as
    // it was rather than changed on a plausible-sounding theory.)
    withBusyRetry(() => withOwnedSqlite(() => opened.pragma('journal_mode = WAL')));
    withOwnedSqlite(() => opened.pragma('foreign_keys = ON'));
    withOwnedSqlite(() => opened.pragma('busy_timeout = 5000'));
    withOwnedSqlite(() => opened.pragma('synchronous = NORMAL'));
    withOwnedSqlite(() => opened.pragma('secure_delete = ON'));
    const db = drizzle(opened, { schema });
    rememberOwnedClient(db, opened);
    return { db, sqlite: opened, path };
  } catch (err) {
    // Close what we opened before propagating, or the connection leaks on every failed setup.
    let cleanupFailure: { readonly cause: unknown } | undefined;
    try {
      close?.();
    } catch (cause) {
      cleanupFailure = { cause };
    }
    // A STABLE, generic message: `err.message` from better-sqlite3 routinely contains the absolute file path,
    // and this message is surfaced verbatim to the user by the CLI's history openers — interpolating it would
    // put the OS username back in user-facing output, which is the very thing moving the path to `.path` was
    // for. The driver's own error is preserved in full via `cause` for diagnosis.
    const failure = new DbOpenError('open_failed', 'could not open the SQLite database', path, {
      cause:
        cleanupFailure === undefined
          ? err
          : new AggregateError([err, cleanupFailure.cause], 'SQLite startup cleanup failed.', {
              cause: err,
            }),
    });
    // Native cleanup uncertainty is infrastructure, even when the primary failure was operational.
    // Preserve both causes without laundering the failed release through storage provenance.
    if (cleanupFailure === undefined) transferStorageFailure(failure, err);
    throw failure;
  }
}

/** The packaged migration set (`./drizzle`), resolved relative to this module so it works
 * from both `src/` (tests) and the built `dist/` (consumers) — both sit one level under
 * the package root. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/** Options for {@link runMigrations}. */
export interface RunMigrationsOptions {
  /**
   * The database file, so the batch can be serialized across processes by the ADR-0073 migration lock —
   * pass {@link DbClient.path}. Omitted (or `':memory:'`) runs unlocked, which is correct for a private
   * in-memory database and is what every unit test wants.
   *
   * Optional rather than required deliberately: making it required would be a breaking change for every
   * existing caller, and the ones that matter — the real `history.db` openers — are a short, reviewable list.
   */
  readonly dbPath?: string;
  /** Adds the separate migration-lock native close to the original database acquisition. */
  readonly captureClose?: (close: () => void) => void;
}

/**
 * Apply every pending `drizzle-kit` migration to the given client. Idempotent: Drizzle
 * tracks applied migrations, so re-running is a no-op. Surfaces call this on first use.
 *
 * With `dbPath` set, the whole batch runs under the cross-process lock described in
 * [ADR-0073](../../../docs/decisions/0073-history-db-migration-lock.md) — because drizzle's migrator decides
 * what to apply in a `SELECT` OUTSIDE its own transaction, two processes racing a fresh file would otherwise
 * both apply the full set and one would die on `CREATE TABLE` (finding #99).
 */
export function runMigrations(db: Db, options: RunMigrationsOptions = {}): SessionEffectCheckpoint {
  requireSessionEffectTransactionOwnership(db);
  return withMigrationLock(
    options.dbPath,
    () => {
      migrateWithOwnedStorageFacts(db, MIGRATIONS_DIR);
      if (hasOwnedClient(db)) {
        withOwnedSqlite(() => initializeSessionEffectTurnKeys(db));
        return withOwnedSqlite(() => clearLegacySessionEffectResults(db));
      }
      initializeSessionEffectTurnKeys(db);
      return clearLegacySessionEffectResults(db);
    },
    options,
  );
}
