import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { globalConfigDir } from '../config/paths.js';

/**
 * #28 — the ADR-0050 at-rest `0600` on `history.db` must NOT be conditional on the migrations succeeding.
 *
 * `createClient` creates the file at the process umask (typically 644). The chmod used to run only AFTER
 * `runMigrations`, so a migration that threw — disk full, an interrupted first run — left the file
 * world-readable for the lifetime of the install, with nothing ever revisiting it. The guarantee has to hold
 * on the failure path too, which is the whole point of an at-rest guarantee.
 *
 * POSIX-only: `chmod` is a documented no-op on Windows (ADR-0050), so the mode assertions are gated off it
 * exactly as the 2.5.I concurrency lane does.
 */
const POSIX = process.platform !== 'win32';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-open-db-'));
});

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@relavium/db');
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('openLocalDb — the at-rest 0600 (#28, ADR-0050)', () => {
  it.skipIf(!POSIX)('applies 0600 on a successful open', async () => {
    const { openLocalDb } = await import('./open.js');
    const opened = openLocalDb(home);
    try {
      expect(modeOf(join(globalConfigDir(home), 'history.db'))).toBe(0o600);
    } finally {
      opened.close();
    }
  });

  it.skipIf(!POSIX)('applies 0600 even when the MIGRATIONS throw — the guarantee is unconditional', async () => {
    // The real driver still opens (and therefore creates) the file; only the migration batch fails. That is
    // exactly the disk-full / interrupted-first-run shape, and the shape that used to leave the file at 644.
    const actual = await import('@relavium/db');
    vi.doMock('@relavium/db', () => ({
      ...actual,
      runMigrations: () => {
        throw new Error('disk full');
      },
    }));
    vi.resetModules();
    const { openLocalDb } = await import('./open.js');

    expect(() => openLocalDb(home)).toThrow('disk full');
    // The file exists (createClient made it) and is owner-only despite the failure.
    expect(modeOf(join(globalConfigDir(home), 'history.db'))).toBe(0o600);
  });

  it.skipIf(!POSIX)('re-asserts 0600 on a SUBSEQUENT open of a file left world-readable', async () => {
    const { openLocalDb } = await import('./open.js');
    const dbPath = join(globalConfigDir(home), 'history.db');
    const first = openLocalDb(home);
    first.close();
    // Simulate a file that predates the guard, or one a `cp`/restore/editor left permissive.
    chmodSync(dbPath, 0o644);
    const second = openLocalDb(home);
    try {
      expect(modeOf(dbPath)).toBe(0o600);
    } finally {
      second.close();
    }
  });
});
