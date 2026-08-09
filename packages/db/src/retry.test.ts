import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createClient, runMigrations } from './client.js';
import { withBusyRetry, withBusyRetryAsync } from './retry.js';

/** A `better-sqlite3`-shaped lock error: an `Error` with the string `.code` the driver sets. */
const lockError = (
  code: 'SQLITE_BUSY' | 'SQLITE_LOCKED' | 'SQLITE_BUSY_SNAPSHOT' | 'SQLITE_BUSY_RECOVERY',
): Error => Object.assign(new Error('database is locked'), { code });

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

  it('the full default budget follows the exact linear schedule [25, 50, 75, 100] (locks base×attempt)', () => {
    const sleeps: number[] = [];
    let caught: unknown;
    try {
      // Never succeeds → spend the whole default budget (5 attempts ⇒ 4 backoffs). Pins the formula end-to-end
      // so a mutation to a constant delay, or base×(attempt−1), would fail here even though the 2-sleep case passes.
      withBusyRetry(
        () => {
          throw lockError('SQLITE_BUSY');
        },
        { baseDelayMs: 25, sleep: (ms) => sleeps.push(ms) },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(sleeps).toEqual([25, 50, 75, 100]);
  });

  // One parameterized case per retryable code rather than three near-identical blocks. Each code is in the
  // set for its own reason, so the reasons live here: `SQLITE_LOCKED` is the plain table-lock fault;
  // `SQLITE_BUSY_SNAPSHOT` is the stale-DEFERRED upgrade failure `busy_timeout` does NOT cover, which arrives
  // as its own EXTENDED code string rather than as a `SQLITE_BUSY` prefix — the whole substance of #100; and
  // `SQLITE_BUSY_RECOVERY` is a WAL-index rebuild after a crash, which the busy handler's loop exits WITH
  // rather than downgrading, so a first-run-after-crash write would otherwise fail loud on a condition that
  // clears in milliseconds.
  it.each(['SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY'] as const)(
    'retries %s',
    (code) => {
      let calls = 0;
      const result = withBusyRetry(
        () => {
          calls += 1;
          if (calls < 2) throw lockError(code);
          return 'ok';
        },
        { sleep: () => {} },
      );
      expect(result).toBe('ok');
      expect(calls).toBe(2);
    },
  );

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

  it('a stray maxAttempts of 0 is floored to one attempt (never disables the first try, never spins)', () => {
    const sleep = vi.fn();
    let calls = 0;
    expect(() =>
      withBusyRetry(
        () => {
          calls += 1;
          throw lockError('SQLITE_BUSY');
        },
        { maxAttempts: 0, sleep },
      ),
    ).toThrow();
    expect(calls).toBe(1); // Math.max(1, 0) — the fn still ran exactly once
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('withBusyRetryAsync — the async twin (#226)', () => {
  it('returns the value on first success (no retry, no sleep)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    await expect(withBusyRetryAsync(() => 42, { sleep })).resolves.toBe(42);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('awaits an async fn and resolves its value', async () => {
    await expect(
      withBusyRetryAsync(() => Promise.resolve('ok'), { sleep: () => Promise.resolve() }),
    ).resolves.toBe('ok');
  });

  it('follows the SAME deterministic linear schedule as the sync twin (no jitter)', async () => {
    const sleeps: number[] = [];
    let caught: unknown;
    try {
      await withBusyRetryAsync(
        () => {
          throw lockError('SQLITE_BUSY');
        },
        {
          baseDelayMs: 25,
          sleep: (ms) => {
            sleeps.push(ms);
            return Promise.resolve();
          },
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    // Byte-identical to the sync twin's schedule assertion above — the two must never drift apart.
    expect(sleeps).toEqual([25, 50, 75, 100]);
  });

  it('retries a REJECTED lock fault (not just a synchronous throw) and then succeeds', async () => {
    let calls = 0;
    const result = await withBusyRetryAsync(
      () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(lockError('SQLITE_BUSY_SNAPSHOT'))
          : Promise.resolve('ok');
      },
      { sleep: () => Promise.resolve() },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('rejects with the ORIGINAL non-lock error immediately (no retry, no sleep)', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const constraint = Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' });
    let calls = 0;
    await expect(
      withBusyRetryAsync(
        () => {
          calls += 1;
          throw constraint;
        },
        { sleep },
      ),
    ).rejects.toBe(constraint);
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails loud after exhausting maxAttempts, rejecting with the ORIGINAL lock error', async () => {
    const busy = lockError('SQLITE_BUSY');
    let calls = 0;
    await expect(
      withBusyRetryAsync(
        () => {
          calls += 1;
          throw busy;
        },
        { maxAttempts: 4, sleep: () => Promise.resolve() },
      ),
    ).rejects.toBe(busy); // never swallowed — a dropped write is silent data loss (ADR-0050)
    expect(calls).toBe(4);
  });

  it('a stray maxAttempts of 0 is floored to one attempt, matching the sync twin', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    let calls = 0;
    await expect(
      withBusyRetryAsync(
        () => {
          calls += 1;
          throw lockError('SQLITE_BUSY');
        },
        { maxAttempts: 0, sleep },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('actually YIELDS the event loop between attempts — the whole point of the twin', async () => {
    // With the default (real `setTimeout`) sleep, other work must be able to interleave during the backoff.
    // The sync twin's `Atomics.wait` would park the thread and make this impossible.
    // A MACROTASK, armed from inside attempt 1, is the strong form of the claim: `Atomics.wait` parks the
    // thread and drains no queue at all, so a timer armed before the backoff could not fire until the whole
    // synchronous retry returned. A 0 ms timer (clamped to 1 ms) against a 20 ms backoff leaves a 19 ms
    // ordering margin, so this is deterministic rather than a race.
    const observed: string[] = [];
    let calls = 0;
    await expect(
      withBusyRetryAsync(
        () => {
          calls += 1;
          observed.push(`attempt${calls}`);
          if (calls < 2) {
            setTimeout(() => observed.push('other-work'), 0);
            throw lockError('SQLITE_BUSY');
          }
          return 'ok';
        },
        { baseDelayMs: 20 }, // the REAL sleepAsync — no injected sleep
      ),
    ).resolves.toBe('ok');
    expect(observed).toEqual(['attempt1', 'other-work', 'attempt2']);
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
      try {
        holder.sqlite.close();
      } finally {
        try {
          writer.sqlite.close();
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
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
      try {
        holder.sqlite.close();
      } finally {
        try {
          writer.sqlite.close();
        } finally {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
      }
    }
  });
});
