import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema.js';

/**
 * The local SQLite client for `@relavium/db`, wired over `better-sqlite3`
 * ([ADR-0021](../../../docs/decisions/0021-node-sqlite-driver-better-sqlite3.md)) and
 * Drizzle. This is the **Node-side** path (CLI, tests); the desktop reaches SQLite
 * through the Rust `tauri-plugin-sql` and does not load this driver.
 *
 * Scope is schema/migrations only (Phase 0 workstream 0.I) — no engine wiring. SQLCipher
 * encryption-at-rest (ADR-0005) is applied by the desktop's Rust setup hook, not here.
 */

/** A Drizzle handle bound to the full Relavium schema. */
export type Db = BetterSQLite3Database<typeof schema>;

/** A connected client: the Drizzle handle plus the raw driver for lifecycle control. */
export interface DbClient {
  readonly db: Db;
  /** The underlying better-sqlite3 connection (call `.close()` when done). */
  readonly sqlite: Database.Database;
}

/**
 * Open a SQLite database and return a schema-bound Drizzle client. `path` defaults to a
 * private in-memory database; pass a filesystem path for a persistent local store.
 *
 * Applies the project PRAGMAs: `journal_mode = WAL` (concurrent reads while a run writes;
 * a no-op for in-memory) and `foreign_keys = ON` (SQLite does not enforce FKs per
 * connection by default — the CASCADE rules in the schema depend on it).
 */
export function createClient(path = ':memory:'): DbClient {
  let sqlite: Database.Database;
  try {
    // Create the parent directory for a real file path so a first-run open doesn't fail on a
    // missing folder. Skip ':memory:' and `file:` URIs, whose `dirname` is not a real dir.
    // Inside the try so a filesystem error (EACCES/EPERM) gets the same path-rich message.
    if (path !== ':memory:' && !path.startsWith('file:')) {
      mkdirSync(dirname(path), { recursive: true });
    }
    sqlite = new Database(path);
  } catch (err) {
    // Rethrow with the resolved path + reason (locked/corrupt/permission/missing dir),
    // preserving the original via `cause` — a bare fs/driver error has no path context.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to open SQLite database at '${path}': ${reason}`, { cause: err });
  }
  sqlite.pragma('journal_mode = WAL'); // concurrent reads while a run writes (no-op in memory)
  sqlite.pragma('foreign_keys = ON'); // SQLite does not enforce FKs per connection by default
  sqlite.pragma('busy_timeout = 5000'); // wait up to 5s for a writer lock instead of erroring
  sqlite.pragma('synchronous = NORMAL'); // the recommended durability/throughput trade-off with WAL
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** The packaged migration set (`./drizzle`), resolved relative to this module so it works
 * from both `src/` (tests) and the built `dist/` (consumers) — both sit one level under
 * the package root. */
const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Apply every pending `drizzle-kit` migration to the given client. Idempotent: Drizzle
 * tracks applied migrations, so re-running is a no-op. Surfaces call this on first use.
 */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
