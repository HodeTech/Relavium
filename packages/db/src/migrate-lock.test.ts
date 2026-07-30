import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withMigrationLock } from './migrate-lock.js';

/**
 * The ADR-0073 lock protocol, deterministically — injected clock, nonce and sleep, so the wait, the stale
 * takeover and the reconcile fallback are each exercised without real time or a second process.
 *
 * The REAL two-process race (#99's acceptance clause) lives in `migrate-lock.e2e.test.ts`, which needs the
 * built package; these are the white-box clause-guards, mirroring how `retry.test.ts` guards `withBusyRetry`
 * while `concurrency.e2e.test.ts` covers the cross-process smoke.
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

/** A lock file as a live/dead holder would have left it. */
const holderAt = (startedAt: number, nonce = 'other'): void => {
  writeFileSync(lockPath, JSON.stringify({ pid: 4242, startedAt, nonce }));
};

describe('withMigrationLock — the protocol (ADR-0073)', () => {
  it('holds the lock while the body runs and releases it afterwards', () => {
    let heldDuring = false;
    const result = withMigrationLock(dbPath, () => {
      heldDuring = existsSync(lockPath);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(heldDuring).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock even when the body throws — a failed migration must not wedge the install', () => {
    expect(() =>
      withMigrationLock(dbPath, () => {
        throw new Error('disk full');
      }),
    ).toThrow('disk full');
    expect(existsSync(lockPath)).toBe(false);
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

  it('WAITS for a live holder rather than barging in, then proceeds once it releases', () => {
    holderAt(1_000);
    let clock = 1_000; // the holder is 0 ms old ⇒ live, well inside the 30 s threshold
    let polls = 0;
    const result = withMigrationLock(dbPath, () => 'ran', {
      now: () => clock,
      nonce: () => 'mine',
      sleep: () => {
        polls += 1;
        if (polls === 3) rmSync(lockPath); // the holder finishes on the third poll
        clock += 50;
      },
    });
    expect(result).toBe('ran');
    expect(polls).toBe(3);
  });

  it('TAKES OVER a stale lock, and the takeover is nonce-verified rather than delete-then-create', () => {
    // A holder that started 31 s ago has crashed past the threshold — `finally` does not survive SIGKILL.
    holderAt(0, 'dead');
    let nonceInside: string | undefined;
    const result = withMigrationLock(
      dbPath,
      () => {
        nonceInside = (JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string }).nonce;
        return 'ran';
      },
      { now: () => 31_000, nonce: () => 'mine', sleep: () => undefined },
    );
    expect(result).toBe('ran');
    // The body ran holding OUR claim. This is the assertion that distinguishes an atomic swap from
    // "unlink someone else's lock and hope" — under which two concurrent takers both proceed.
    expect(nonceInside).toBe('mine');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does NOT take over a lock that is merely OLD but still inside the threshold', () => {
    holderAt(0);
    let polls = 0;
    withMigrationLock(dbPath, () => 'ran', {
      now: () => 29_999, // one millisecond short of stale
      nonce: () => 'mine',
      sleep: () => {
        polls += 1;
        rmSync(lockPath); // let it finish so the test terminates
      },
    });
    expect(polls).toBe(1); // it waited instead of stealing
  });

  it('treats an unreadable lock file as stale rather than letting garbage wedge every future run', () => {
    writeFileSync(lockPath, 'not json at all');
    const result = withMigrationLock(dbPath, () => 'ran', {
      now: () => 1_000,
      nonce: () => 'mine',
      sleep: () => undefined,
    });
    expect(result).toBe('ran');
  });

  it('reconciles a LOST RACE once the wait is exhausted — the second pass sees the winner', () => {
    holderAt(1_000); // alive, never released, never stale
    let clock = 1_000;
    let attempts = 0;
    const result = withMigrationLock(
      dbPath,
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error('table `runs` already exists');
        return 'reconciled';
      },
      {
        now: () => clock,
        nonce: () => 'mine',
        sleep: () => {
          clock += 5_000; // blow past MAX_WAIT_MS without ever crossing STALE_MS
        },
      },
    );
    expect(result).toBe('reconciled');
    expect(attempts).toBe(2);
  });

  it('still FAILS LOUD through the fallback, rethrowing the FIRST error, not the second', () => {
    holderAt(1_000);
    let clock = 1_000;
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
            now: () => clock,
            nonce: () => 'mine',
            sleep: () => {
              clock += 5_000;
            },
          },
        ),
      // Reconcile must not launder a genuine migration failure into a different message.
    ).toThrow('the real cause');
    expect(attempts).toBe(2); // exactly one retry — bounded, never a loop
  });
});
