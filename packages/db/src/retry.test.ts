import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations } from './client.js';
import { withBusyRetry } from './retry.js';

/** A `better-sqlite3`-shaped lock error: an `Error` with the string `.code` the driver sets. */
const lockError = (code: 'SQLITE_BUSY' | 'SQLITE_LOCKED'): Error =>
  Object.assign(new Error('database is locked'), { code });

describe('withBusyRetry — unit (2.5.I)', () => {
  it('returns the value on first success (no retry, no sleep)', () => {
    const sleep = vi.fn();
    expect(withBusyRetry(() => 42, { sleep })).toBe(42);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries SQLITE_BUSY then succeeds, with a deterministic linear backoff (no jitter)', () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls += 1;
        if (calls < 3) throw lockError('SQLITE_BUSY');
        return 'ok';
      },
      { baseDelayMs: 25, sleep: (ms) => sleeps.push(ms) },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    // 25×1 then 25×2 — linear, deterministic, no jitter (ADR-0040 convention).
    expect(sleeps).toEqual([25, 50]);
  });

  it('retries SQLITE_LOCKED as well', () => {
    let calls = 0;
    const result = withBusyRetry(
      () => {
        calls += 1;
        if (calls < 2) throw lockError('SQLITE_LOCKED');
        return 'ok';
      },
      { sleep: () => {} },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows a NON-lock error immediately, unchanged (no retry, no sleep)', () => {
    const sleep = vi.fn();
    const constraint = Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' });
    let calls = 0;
    let caught: unknown;
    try {
      withBusyRetry(
        () => {
          calls += 1;
          throw constraint;
        },
        { sleep },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(constraint); // the ORIGINAL error object, unwrapped
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails loud after exhausting maxAttempts, rethrowing the ORIGINAL lock error', () => {
    const busy = lockError('SQLITE_BUSY');
    let calls = 0;
    let caught: unknown;
    try {
      withBusyRetry(
        () => {
          calls += 1;
          throw busy;
        },
        { maxAttempts: 4, sleep: () => {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(busy); // never swallowed — a dropped write is silent data loss (ADR-0050)
    expect(calls).toBe(4); // the full budget was spent
  });

  it('maxAttempts:1 makes a single attempt (retry disabled)', () => {
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw lockError('SQLITE_BUSY');
        },
        { maxAttempts: 1, sleep: () => {} },
      ),
    ).toThrow();
    expect(calls).toBe(1);
  });
});

/**
 * Real SQLITE_BUSY contention: two connections on one file, one holding the single WAL write lock. The
 * injected `sleep` is the interleave hook — releasing the lock during the backoff lets the retry succeed,
 * so the test is deterministic without any real waiting or threads.
 */
describe('withBusyRetry — real SQLITE_BUSY contention (2.5.I)', () => {
  it('retries a write blocked by a held write lock; succeeds once the lock is released in the backoff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-retry-'));
    const holder = createClient(join(dir, 'c.db'));
    const writer = createClient(join(dir, 'c.db'));
    try {
      runMigrations(holder.db);
      holder.sqlite.exec('CREATE TABLE contention (x INTEGER)'); // auto-committed → visible to writer
      writer.sqlite.pragma('busy_timeout = 0'); // surface BUSY immediately instead of waiting 5s
      const write = writer.sqlite.prepare('INSERT INTO contention (x) VALUES (2)');

      // holder takes the single WAL write lock and keeps it:
      holder.sqlite.exec('BEGIN IMMEDIATE');
      holder.sqlite.prepare('INSERT INTO contention (x) VALUES (1)').run();

      let attempts = 0;
      let released = false;
      withBusyRetry(
        () => {
          attempts += 1;
          write.run(); // throws SQLITE_BUSY while holder owns the lock
        },
        {
          baseDelayMs: 1,
          sleep: () => {
            if (!released) {
              holder.sqlite.exec('COMMIT'); // release the lock so the retry can take it
              released = true;
            }
          },
        },
      );

      expect(attempts).toBe(2); // first attempt BUSY, retry after release succeeds
      expect(Number(writer.sqlite.prepare('SELECT count(*) FROM contention').pluck().get())).toBe(
        2,
      );
    } finally {
      holder.sqlite.close();
      writer.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loud when the lock is never released (exhausts the budget, rethrows SQLITE_BUSY)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relavium-retry-'));
    const holder = createClient(join(dir, 'c.db'));
    const writer = createClient(join(dir, 'c.db'));
    try {
      runMigrations(holder.db);
      holder.sqlite.exec('CREATE TABLE contention (x INTEGER)');
      writer.sqlite.pragma('busy_timeout = 0');
      const write = writer.sqlite.prepare('INSERT INTO contention (x) VALUES (2)');
      holder.sqlite.exec('BEGIN IMMEDIATE');
      holder.sqlite.prepare('INSERT INTO contention (x) VALUES (1)').run();

      let attempts = 0;
      expect(() =>
        withBusyRetry(
          () => {
            attempts += 1;
            write.run();
          },
          { maxAttempts: 3, sleep: () => {} }, // the lock is never released → every attempt is BUSY
        ),
      ).toThrow(/SQLITE_BUSY|database is locked/);
      expect(attempts).toBe(3); // the whole budget was spent before failing loud
      holder.sqlite.exec('COMMIT'); // release for teardown
    } finally {
      holder.sqlite.close();
      writer.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
