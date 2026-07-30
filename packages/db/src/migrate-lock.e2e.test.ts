import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createClient, runMigrations } from './client.js';

/**
 * ADR-0073 / finding #99 — the REAL two-process migration race the acceptance clause names: *"two processes
 * racing `runMigrations` against a fresh `history.db` no longer crash either one, proven by a two-process
 * regression test."*
 *
 * A single Node process cannot reproduce it. `better-sqlite3` is synchronous, so two in-process
 * `runMigrations` calls can only ever run one after the other — the interleaving that makes drizzle's
 * decide-outside-the-transaction migrator unsafe requires two OS processes with their own SQLite instances and
 * real OS file locks. So: two children spawned together against one brand-new file.
 *
 * It needs the BUILT `@relavium/db` (the child cannot use vitest's source resolution) and is visibly SKIPPED —
 * never silently passed — when the dist is absent, mirroring `apps/cli/src/harness/concurrency.e2e.test.ts`.
 * A `pnpm turbo run build` produces it; CI builds upstream packages first.
 *
 * **What this proves, precisely.** With the lock it passes every run. WITHOUT the lock it fails roughly one
 * run in three — measured, not assumed — because the collision depends on how closely the two `spawn`s land.
 * That is the same flakiness that let #99 ship, so this is a coexistence SMOKE, not the clause-guard: the
 * deterministic guards for every branch of the protocol (wait, stale takeover, garbage lock, reconcile,
 * fail-loud) are the injected-clock unit tests in `migrate-lock.test.ts`. Exactly the division of labour
 * `concurrency.e2e.test.ts` documents for `withBusyRetry`. A READY-handshake barrier would make the collision
 * deterministic, as it does there; it is a worthwhile follow-up, not a blocker for the fix itself.
 */

// The child receives the built db as a file:// URL (its `import()` needs a URL — a bare Windows path like
// `C:\…` is not a valid import specifier); the path form is only for the existence gate.
const DB_DIST_URL = new URL('../dist/index.js', import.meta.url);
const DB_DIST_PATH = fileURLToPath(DB_DIST_URL);
const CHILD_SCRIPT = fileURLToPath(new URL('./fixtures/migrate-racer.mjs', import.meta.url));

/** Run the racer child, resolving its stdout and exit code. Never rejects — the parent asserts on both. */
function race(dbPath: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD_SCRIPT, DB_DIST_URL.href, dbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('runMigrations — the two-process race (#99)', () => {
  it.skipIf(!existsSync(DB_DIST_PATH))(
    'two concurrent processes BOTH succeed against one fresh history.db',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'relavium-migrate-race-'));
      const dbPath = join(dir, 'history.db');
      try {
        // Started together, before either has awaited — as close to simultaneous as spawn allows. Without the
        // lock, the loser dies with a DrizzleError on a duplicate CREATE TABLE.
        const [first, second] = await Promise.all([race(dbPath), race(dbPath)]);

        for (const [label, result] of [
          ['first', first],
          ['second', second],
        ] as const) {
          // Assert on stdout too, not just the exit code: a child that silently did nothing would also exit 0.
          expect(result.out, `${label} child stderr: ${result.err}`).toBe('OK');
          expect(result.code, `${label} child stderr: ${result.err}`).toBe(0);
        }

        // The schema really landed, exactly once, and a third pass is still a clean no-op.
        const client = createClient(dbPath);
        try {
          expect(() => runMigrations(client.db, { dbPath: client.path })).not.toThrow();
          const tables = client.db
            .all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`)
            .map((row) => row.name);
          expect(tables).toContain('runs');
          expect(tables).toContain('agent_sessions');
          // One row per migration, no duplicates — the loser must have applied NOTHING, not re-applied.
          const applied = client.db.all<{ n: number }>(
            sql`select count(*) as n from __drizzle_migrations`,
          );
          expect(applied[0]?.n).toBeGreaterThan(0);
        } finally {
          client.sqlite.close();
        }
        // No lock file survives a clean pair of runs.
        expect(existsSync(`${dbPath}.migrate.lock`)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    },
    60_000,
  );
});
