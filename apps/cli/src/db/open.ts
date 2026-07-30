import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, runMigrations, type Db } from '@relavium/db';

import { ensureGlobalConfigDir, globalConfigDir } from '../config/paths.js';

/** An opened local database plus the handle to close its SQLite connection. */
export interface OpenedDb {
  readonly db: Db;
  readonly close: () => void;
}

/**
 * Open `~/.relavium/history.db` for the CLI (workstreams **2.H** run history, **2.C** the `llm_providers`
 * registry — both tables live in this one file): lazy-create + `0700` the home dir, open via
 * `better-sqlite3`, apply migrations, then `0600` the db + its `-wal`/`-shm` sidecars — the unencrypted
 * at-rest CLI posture guarded by OS permissions ([ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)).
 */
export function openLocalDb(homeDir: string): OpenedDb {
  ensureGlobalConfigDir(homeDir); // creates ~/.relavium/ at 0700 (ADR-0050)
  const path = join(globalConfigDir(homeDir), 'history.db');
  const client = createClient(path);
  // If setup (migrations / the at-rest chmod) throws, close the just-opened handle before propagating —
  // otherwise the SQLite connection leaks for the lifetime of the failing process.
  try {
    // #28: the 0600 runs BEFORE the migrations, and again after. Before, because `createClient` has already
    // CREATED the file at the process umask — typically 644 — and a migration that throws (disk full, an
    // interrupted first run) used to leave it there, world-readable, for the lifetime of the install. The
    // ADR-0050 at-rest guarantee cannot be conditional on the migration succeeding. After, because the WAL
    // and SHM sidecars only come into existence once SQLite actually writes.
    hardenAtRest(path);
    // The batch is serialized across processes (ADR-0073): two `relavium` invocations racing a fresh
    // `history.db` wait for each other instead of one dying on a duplicate `CREATE TABLE` (#99).
    runMigrations(client.db, { dbPath: client.path });
    hardenAtRest(path);
  } catch (err) {
    client.sqlite.close();
    throw err;
  }
  return {
    db: client.db,
    // Idempotent: better-sqlite3's close() throws on an already-closed handle, so guard on `.open`
    // — a double close (e.g. an error-recovery path that also closes in a finally) is then a no-op.
    close: () => {
      if (client.sqlite.open) {
        client.sqlite.close();
      }
    },
  };
}

/**
 * Apply the ADR-0050 at-rest mode to `history.db` and its sidecars. The db file itself is guaranteed to exist
 * (`createClient` opened it), so a chmod failure on IT is LOUD — the whole at-rest guarantee rests on this
 * `0600`. The `-wal`/`-shm` sidecars may legitimately not exist yet (no checkpoint), so `ENOENT` on them is
 * expected and ignored; any other error still propagates.
 *
 * Idempotent, so it is safe to call on both sides of the migration batch.
 */
function hardenAtRest(path: string): void {
  chmodSync(path, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${path}${suffix}`, 0o600);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') {
        throw err;
      }
    }
  }
}

/** The `errno` code of a Node fs error (`ENOENT`, `EPERM`, …), or `undefined` if it is not one. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
