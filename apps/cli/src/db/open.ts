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
  runMigrations(client.db);
  // The db file is guaranteed to exist here — a chmod failure on IT must be LOUD (ADR-0050's at-rest
  // guarantee rests on this 0600). Its WAL/SHM sidecars may not exist yet (no checkpoint) — best-effort.
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

/** The `errno` code of a Node fs error (`ENOENT`, `EPERM`, …), or `undefined` if it is not one. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
