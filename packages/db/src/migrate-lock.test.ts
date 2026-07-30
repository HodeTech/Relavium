import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withMigrationLock } from './migrate-lock.js';

/**
 * The ADR-0073 migration lock. It is an OS advisory lock (`BEGIN EXCLUSIVE` on a dedicated SQLite lock file),
 * so most of what the previous lock-file protocol needed tests for — staleness, takeover, pid handling — no
 * longer exists: the kernel releases the lock on process death. What remains testable in-process is the
 * mutual-exclusion contract, the release, and the two fall-through paths.
 *
 * The REAL two-process race (#99's acceptance clause) lives in `migrate-lock.e2e.test.ts`.
 */

let dir: string;
let dbPath: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relavium-migrate-lock-'));
  dbPath = join(dir, 'history.db');
  lockPath = `${dbPath}.migrate.lock`;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('withMigrationLock (ADR-0073)', () => {
  it('runs the body and releases the lock afterwards', () => {
    expect(withMigrationLock(dbPath, () => 'ok')).toBe('ok');
    // Released: a second acquisition succeeds promptly rather than waiting out the timeout.
    const started = Date.now();
    expect(withMigrationLock(dbPath, () => 'again')).toBe('again');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('releases the lock even when the body throws — a failed migration must not wedge the install', () => {
    expect(() =>
      withMigrationLock(dbPath, () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(withMigrationLock(dbPath, () => 'ok')).toBe('ok');
  });

  it('EXCLUDES a concurrent holder — the body never runs while another connection holds the lock', () => {
    // A live holder, exactly as a second process would be: a real EXCLUSIVE transaction on the lock file.
    const holder = new Database(lockPath);
    try {
      holder.exec('BEGIN EXCLUSIVE');
      let attempts = 0;
      // Reaching `runReconciling` — TWO attempts, not one — is the observable proof that acquisition was
      // refused. Under the old rename-based takeover this same shape let both parties into the body.
      const result = withMigrationLock(
        dbPath,
        () => {
          attempts += 1;
          if (attempts === 1) throw new Error('table `runs` already exists');
          return 'reconciled';
        },
        // timeoutMs 0 surfaces SQLITE_BUSY at once — what a waiter past the real 10 s timeout sees,
        // without making the suite wait 10 s for it.
        { timeoutMs: 0 },
      );
      expect(result).toBe('reconciled');
      expect(attempts).toBe(2);
    } finally {
      holder.exec('COMMIT');
      holder.close();
    }
  });

  it('is a NO-OP for an in-memory database — a `:memory:.migrate.lock` would be nonsense', () => {
    let ran = false;
    withMigrationLock(':memory:', () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(existsSync(':memory:.migrate.lock')).toBe(false);
  });

  it('is a NO-OP when no path is supplied (every unit test takes this path)', () => {
    let ran = false;
    withMigrationLock(undefined, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('reconciles when the lock file cannot be opened at all (a read-only directory)', () => {
    let attempts = 0;
    const result = withMigrationLock(
      dbPath,
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error('table `runs` already exists');
        return 'reconciled';
      },
      {
        openLock: () => {
          throw new Error('EROFS: read-only file system');
        },
      },
    );
    expect(result).toBe('reconciled');
    expect(attempts).toBe(2);
  });

  it('still FAILS LOUD through the fallback, rethrowing the FIRST error, not the second', () => {
    let attempts = 0;
    expect(
      () =>
        withMigrationLock(
          dbPath,
          () => {
            attempts += 1;
            throw new Error(attempts === 1 ? 'the real cause' : 'a vaguer second failure');
          },
          {
            openLock: () => {
              throw new Error('EROFS: read-only file system');
            },
          },
        ),
      // Reconcile must not launder a genuine migration failure into a different message.
    ).toThrow('the real cause');
    expect(attempts).toBe(2); // exactly one retry — bounded, never a loop
  });
});
