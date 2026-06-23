import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkflowDefinition } from '@relavium/core';
import {
  createClient,
  createRunHistoryStore,
  runMigrations,
  type RunHistoryStore,
} from '@relavium/db';

import { ensureGlobalConfigDir, globalConfigDir } from '../config/paths.js';

/** An opened history store plus the handle to close its SQLite connection at run end. */
export interface OpenedHistory {
  readonly store: RunHistoryStore;
  readonly close: () => void;
}

/**
 * Open `~/.relavium/history.db` for one CLI run (workstream **2.H**): lazy-create + `0700` the home dir,
 * open it via `better-sqlite3`, apply migrations, then `0600` the db + its `-wal`/`-shm` sidecars — the
 * unencrypted-at-rest CLI posture guarded by OS permissions
 * ([ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)).
 *
 * The store records THIS workflow: its frozen snapshot feeds `runs.workflow_definition_snapshot` (the
 * events the engine emits don't carry the graph). Production (`commands/specs.ts`) wires this; the unit
 * tests and the 2.K harness omit it and keep the in-memory store, so they never touch the user's home.
 */
export function openHistoryStore(workflow: WorkflowDefinition, homeDir: string): OpenedHistory {
  ensureGlobalConfigDir(homeDir); // creates ~/.relavium/ at 0700 (ADR-0050)
  const path = join(globalConfigDir(homeDir), 'history.db');
  const client = createClient(path);
  runMigrations(client.db);
  // The db file is guaranteed to exist here (better-sqlite3 created it; runMigrations wrote it), so a chmod
  // failure on IT must be LOUD — ADR-0050's whole at-rest guarantee is this 0600. Its WAL/SHM sidecars may
  // not exist yet (no checkpoint), so those alone are best-effort.
  chmodSync(path, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    try {
      chmodSync(`${path}${suffix}`, 0o600);
    } catch (err) {
      // Tolerate ONLY the sidecar's absence (no WAL checkpoint has happened yet). A real chmod failure
      // (EPERM, EIO) on an existing sidecar must surface — it holds the same run data as the db, so the
      // same 0600 guarantee applies; swallowing it would leave it world-readable (ADR-0050).
      if (errnoCode(err) !== 'ENOENT') {
        throw err;
      }
    }
  }
  const store = createRunHistoryStore(client.db, {
    uuid: () => randomUUID(),
    now: () => Date.now(),
    workflow: {
      slug: workflow.workflow.id,
      name: workflow.workflow.name ?? workflow.workflow.id, // `name` is optional in the schema; fall back to the slug
      definitionJson: JSON.stringify(workflow),
    },
  });
  return {
    store,
    close: () => {
      client.sqlite.close();
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
