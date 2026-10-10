import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@relavium/db';

import { globalConfigDir } from '../config/paths.js';
import { CHECKPOINT_DEFERRED } from './privacy-notice.js';

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
  vi.doUnmock('../process/io.js');
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

  it.skipIf(!POSIX)(
    'applies 0600 even when the MIGRATIONS throw — the guarantee is unconditional',
    async () => {
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
    },
  );

  it.skipIf(!POSIX)(
    're-asserts 0600 on a SUBSEQUENT open of a file left world-readable',
    async () => {
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
    },
  );
});

for (const checkpoint of ['complete', 'deferred'] as const)
  it(`reports only a deferred opening checkpoint (${checkpoint})`, async () => {
    const actual = await import('@relavium/db');
    const migrate = vi.fn(() => checkpoint);
    vi.doMock('@relavium/db', () => ({ ...actual, runMigrations: migrate }));
    vi.resetModules();
    const { openLocalDb } = await import('./open.js');
    const notice = vi.fn();
    const opened = openLocalDb(home, notice);
    try {
      expect(migrate).toHaveBeenCalledOnce();
      expect(notice.mock.calls).toEqual(
        checkpoint === 'deferred' ? [[`${CHECKPOINT_DEFERRED}\n`]] : [],
      );
      expect(opened.db.$client.open).toBe(true);
    } finally {
      opened.close();
    }
  });

for (const failure of ['throw', 'reject'] as const)
  it(`keeps successful database ownership when its opening notice fails (${failure})`, async () => {
    const actual = await import('@relavium/db');
    const migrate = vi.fn(() => 'deferred');
    vi.doMock('@relavium/db', () => ({ ...actual, runMigrations: migrate }));
    vi.resetModules();
    const { openLocalDb } = await import('./open.js');
    const notice = vi.fn(() => {
      const error = new Error('PRIVATE-DIAGNOSTIC-FAULT');
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    const opened = openLocalDb(home, notice);
    try {
      await Promise.resolve();
      expect(migrate).toHaveBeenCalledOnce();
      expect(notice).toHaveBeenCalledOnce();
      expect(opened.db.$client.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
    } finally {
      opened.close();
    }
    expect(opened.db.$client.open).toBe(false);
    expect(() => opened.close()).not.toThrow();
  });

it('notifies for a real held-reader checkpoint and retries erasure on the next empty open', async () => {
  const actual = await import('@relavium/db');
  const { openLocalDb: firstOpen } = await import('./open.js');
  const notes: string[] = [];
  const first = firstOpen(home, (text) => {
    notes.push(text);
  });
  const path = join(globalConfigDir(home), 'history.db');
  const reader = actual.createClient(path);
  let second: ReturnType<typeof firstOpen> | undefined;
  let third: ReturnType<typeof firstOpen> | undefined;
  const token = 'SYNTHETIC_OPENING_WAL_RESULT_0098';
  try {
    const store = actual.createEffectJournalStore(first.db, {
      uuid: () => 'synthetic-effect',
      now: () => 1,
    });
    const correlation = { kind: 'session', sessionId: 'synthetic', turn: 1 } as const;
    const identity = { scope: 'session:synthetic:1', slot: 0, toolId: 'run_command' };
    store.prepare(
      identity,
      correlation,
      { providerAttempt: 1, toolCallId: 'session-tool:1:0' },
      3,
      'digest',
    );
    store.settle(identity, 'committed');
    first.db.$client
      .prepare('UPDATE run_effects SET result_json = ? WHERE scope = ?')
      .run(token.repeat(256), identity.scope);
    reader.sqlite.exec('BEGIN');
    expect(reader.sqlite.prepare('SELECT result_json FROM run_effects').get()).toEqual({
      result_json: token.repeat(256),
    });
    vi.doMock('@relavium/db', () => ({
      ...actual,
      runMigrations: (db: Db, options: Parameters<typeof actual.runMigrations>[1]) => {
        db.$client.pragma('busy_timeout = 0');
        return actual.runMigrations(db, options);
      },
    }));
    vi.resetModules();
    const { openLocalDb } = await import('./open.js');
    second = openLocalDb(home, (text) => {
      notes.push(text);
    });
    expect(notes).toEqual([`${CHECKPOINT_DEFERRED}\n`]);
    expect(second.db.$client.prepare('SELECT result_json FROM run_effects').get()).toEqual({
      result_json: null,
    });
    expect(readFileSync(`${path}-wal`).includes(Buffer.from(token))).toBe(true);
    reader.sqlite.exec('ROLLBACK');
    third = openLocalDb(home, (text) => {
      notes.push(text);
    });
    expect(notes).toEqual([`${CHECKPOINT_DEFERRED}\n`]);
    for (const file of [path, `${path}-wal`])
      if (existsSync(file)) expect(readFileSync(file).includes(Buffer.from(token))).toBe(false);
  } finally {
    if (reader.sqlite.inTransaction) reader.sqlite.exec('ROLLBACK');
    third?.close();
    second?.close();
    reader.sqlite.close();
    first.close();
  }
});

it('forwards a deferred opening notice to acknowledged process stderr by default', async () => {
  const actual = await import('@relavium/db');
  vi.doMock('@relavium/db', () => ({ ...actual, runMigrations: () => 'deferred' }));
  const writeErrAcknowledged = vi.fn(() => Promise.resolve());
  vi.doMock('../process/io.js', () => ({ processIo: () => ({ writeErrAcknowledged }) }));
  vi.resetModules();
  const { openLocalDb } = await import('./open.js');
  const opened = openLocalDb(home);
  try {
    expect(writeErrAcknowledged.mock.calls).toEqual([[`${CHECKPOINT_DEFERRED}\n`]]);
    expect(opened.db.$client.open).toBe(true);
  } finally {
    opened.close();
  }
});
