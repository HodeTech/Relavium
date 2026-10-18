import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DrizzleError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentSessionRecord } from '@relavium/shared';

import { createClient, DbOpenError, runMigrations, type DbClient } from './client.js';
import { isOwnedStorageFailure } from './index.js';
import { FilesystemMediaStore } from './media-store.js';
import { MediaStoreFilesystemError, MediaStorePaths } from './media-store-paths.js';
import { migrateWithOwnedStorageFacts } from './migration-storage-origin.js';
import * as schema from './schema.js';
import { createSessionStore } from './session-store.js';
import {
  checkpointSessionEffectPrivacy,
  SessionEffectPrivacyError,
} from './session-effect-privacy.js';

let root: string;
const clients: DbClient[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-storage-origin-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) if (client.sqlite.open) client.sqlite.close();
  rmSync(root, { recursive: true, force: true });
});
function client(): DbClient {
  const value = createClient();
  clients.push(value);
  return value;
}
function caught(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('expected a failure');
}
function migrations(sqlText?: string): string {
  const folder = join(root, 'migrations');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: [{ idx: 0, version: '6', when: 1, tag: '0000_fixture', breakpoints: true }],
    }),
  );
  if (sqlText !== undefined) writeFileSync(join(folder, '0000_fixture.sql'), sqlText);
  return folder;
}

function sessionRecord(): AgentSessionRecord {
  return {
    id: 'storage-origin-session',
    agentSlug: 'synthetic',
    context: { workingDir: root, fsScopeTier: 'sandboxed' },
    status: 'active',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    totalConservativeMicrocents: 0,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
}

describe('owned storage origin (ADR-0110)', () => {
  it('marks a real readonly session update and permits recovery on the same native client', () => {
    const value = client();
    runMigrations(value.db);
    const store = createSessionStore(value.db);
    const record = sessionRecord();
    store.createSession(record);
    value.sqlite.pragma('query_only = ON');
    const failure = caught(() => store.updateSession({ ...record, status: 'exported' }));
    expect(failure).toBeInstanceOf(Database.SqliteError);
    expect(failure).toMatchObject({ code: 'SQLITE_READONLY' });
    expect(isOwnedStorageFailure(failure), 'DB_ORIGIN_SESSION_UPDATE_READONLY').toBe(true);
    expect(store.loadSession(record.id)?.status).toBe('active');
    value.sqlite.pragma('query_only = OFF');
    store.updateSession({ ...record, status: 'exported' });
    expect(store.loadSession(record.id)?.status).toBe('exported');
  });

  it('does not grant session-update storage origin to a foreign native client', () => {
    const sqlite = new Database(':memory:');
    try {
      const db = drizzle(sqlite, { schema });
      runMigrations(db);
      const store = createSessionStore(db);
      const record = sessionRecord();
      store.createSession(record);
      sqlite.pragma('query_only = ON');
      const failure = caught(() => store.updateSession({ ...record, status: 'exported' }));
      expect(failure).toBeInstanceOf(Database.SqliteError);
      expect(failure).toMatchObject({ code: 'SQLITE_READONLY' });
      expect(isOwnedStorageFailure(failure), 'DB_ORIGIN_FOREIGN_SESSION_UPDATE').toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('does not grant storage origin to a native-shaped error thrown by record validation', () => {
    const value = client();
    runMigrations(value.db);
    const store = createSessionStore(value.db);
    const record = sessionRecord();
    store.createSession(record);
    const primary = new Database.SqliteError('PRIVATE_RECORD_ACCESSOR', 'SQLITE_READONLY');
    Object.defineProperty(record, 'title', {
      get: () => {
        throw primary;
      },
    });
    expect(caught(() => store.updateSession(record))).toBe(primary);
    expect(isOwnedStorageFailure(primary), 'DB_ORIGIN_RECORD_VALIDATION_REFUSAL').toBe(false);
    expect(store.loadSession(record.id)?.status).toBe('active');
  });

  it('marks an actual corrupt database open while retaining family, cause and path-free message', () => {
    const path = join(root, 'corrupt.db');
    writeFileSync(path, 'not a SQLite file');
    const error = caught(() => createClient(path));
    expect(error).toBeInstanceOf(DbOpenError);
    expect(isOwnedStorageFailure(error), 'DB_ORIGIN_OPEN_WRAPPER').toBe(true);
    if (!(error instanceof DbOpenError)) throw new Error('wrong failure family');
    expect(error.code).toBe('open_failed');
    expect(error.path).toBe(path);
    expect(error.message).toBe('could not open the SQLite database');
    expect(error.cause).toBeInstanceOf(Database.SqliteError);
    expect(isOwnedStorageFailure({ ...error })).toBe(false);
  });

  it('marks the real installed migrator READONLY wrapper without replacing any native operation', () => {
    const value = client();
    const names = ['prepare', 'pragma', 'transaction'];
    const methods = names.map((name) => Object.getOwnPropertyDescriptor(Database.prototype, name));
    const ownMethods = names.map((name) => Object.getOwnPropertyDescriptor(value.sqlite, name));
    value.sqlite.pragma('query_only = ON');
    const error = caught(() => runMigrations(value.db));
    expect(error).toBeInstanceOf(DrizzleError);
    expect(isOwnedStorageFailure(error), 'DB_ORIGIN_MIGRATION_WRAPPER').toBe(true);
    if (!(error instanceof DrizzleError)) throw new Error('wrong driver wrapper');
    const native: unknown = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
    expect(native).toBeInstanceOf(Database.SqliteError);
    if (!(native instanceof Database.SqliteError)) throw new Error('wrong native failure');
    expect(native.code).toBe('SQLITE_READONLY');
    expect(names.map((name) => Object.getOwnPropertyDescriptor(Database.prototype, name))).toEqual(
      methods,
    );
    expect(names.map((name) => Object.getOwnPropertyDescriptor(value.sqlite, name))).toEqual(
      ownMethods,
    );
    value.sqlite.pragma('query_only = OFF');
    expect(runMigrations(value.db)).toBe('complete'); // No sticky failure poisons a recovered invocation.
    expect(runMigrations(value.db)).toBe('complete');
  });

  it.each(['missing-file', 'malformed-journal', 'invalid-sql'] as const)(
    'does not grant storage to actual migration %s failure',
    (kind) => {
      const value = client();
      const folder = migrations(kind === 'invalid-sql' ? 'THIS IS NOT SQL;' : undefined);
      if (kind === 'malformed-journal') writeFileSync(join(folder, 'meta', '_journal.json'), '{');
      const error = caught(() => migrateWithOwnedStorageFacts(value.db, folder));
      expect(isOwnedStorageFailure(error)).toBe(false);
      if (kind === 'invalid-sql') {
        expect(error).toBeInstanceOf(DrizzleError);
        const cause: unknown = Object.getOwnPropertyDescriptor(error, 'cause')?.value;
        expect(cause).toBeInstanceOf(Database.SqliteError);
        if (!(cause instanceof Database.SqliteError)) throw new Error('missing native error');
        expect(cause.code).toBe('SQLITE_ERROR');
      }
    },
  );

  it('does not grant provenance to a real foreign Drizzle database', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('query_only = ON');
      const db = drizzle(sqlite, { schema });
      const error = caught(() => runMigrations(db));
      expect(error).toBeInstanceOf(DrizzleError);
      expect(isOwnedStorageFailure(error), 'DB_ORIGIN_FOREIGN_CLIENT_REFUSAL').toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('public constructors, copies, lookalikes and hostile accessors grant no facts', () => {
    const native = new Database.SqliteError('PRIVATE', 'SQLITE_READONLY');
    const wrapper = new DrizzleError({ cause: native });
    const getter = vi.fn(() => native);
    const accessor = Object.defineProperty(new DrizzleError({}), 'cause', { get: getter });
    const hostile = new Proxy({}, { get: getter, getPrototypeOf: getter });
    for (const error of [
      native,
      wrapper,
      accessor,
      hostile,
      { ...wrapper },
      { code: 'EACCES' },
      new DbOpenError('open_failed', 'PRIVATE', '/PRIVATE', { cause: native }),
      new SessionEffectPrivacyError('checkpoint_failed'),
      new MediaStoreFilesystemError('io'),
      new Error('PRIVATE', { cause: wrapper }),
    ])
      expect(isOwnedStorageFailure(error), 'DB_ORIGIN_PUBLIC_CONSTRUCTOR_REFUSAL').toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const uri = caught(() => createClient('file:private'));
    expect(uri).toBeInstanceOf(DbOpenError);
    expect(isOwnedStorageFailure(uri)).toBe(false);
  });

  it('marks checkpoint storage at its actual pragma catch, keeping unknown/result errors unmarked', () => {
    const value = client();
    runMigrations(value.db);
    const pragma = vi.spyOn(value.sqlite, 'pragma');
    // Synthetic native fault at the actual owned operation, not a physical disk-failure claim.
    pragma.mockImplementation(() => {
      throw new Database.SqliteError('PRIVATE', 'SQLITE_IOERR_FSYNC');
    });
    const failure = caught(() => checkpointSessionEffectPrivacy(value.db));
    expect(failure).toBeInstanceOf(SessionEffectPrivacyError);
    if (!(failure instanceof SessionEffectPrivacyError)) throw new Error('wrong checkpoint family');
    expect(isOwnedStorageFailure(failure), 'DB_ORIGIN_CHECKPOINT_WRAPPER').toBe(true);
    expect(failure).toMatchObject({
      code: 'checkpoint_failed',
      message: 'session effect WAL checkpoint failed',
    });
    expect(Object.hasOwn(failure, 'cause')).toBe(false);
    pragma.mockImplementation(() => {
      throw new Error('PRIVATE');
    });
    expect(isOwnedStorageFailure(caught(() => checkpointSessionEffectPrivacy(value.db)))).toBe(
      false,
    );
    pragma.mockReturnValue([]);
    expect(isOwnedStorageFailure(caught(() => checkpointSessionEffectPrivacy(value.db)))).toBe(
      false,
    );
    pragma.mockImplementation(() => {
      throw new Database.SqliteError('PRIVATE', 'SQLITE_BUSY');
    });
    expect(checkpointSessionEffectPrivacy(value.db)).toBe('deferred');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'carries actual native permission failures through DB mkdir and media root conversion',
    async () => {
      const denied = join(root, 'denied');
      mkdirSync(denied);
      chmodSync(denied, 0);
      try {
        const failure = caught(() => createClient(join(denied, 'new', 'history.db')));
        expect(failure).toBeInstanceOf(DbOpenError);
        expect(isOwnedStorageFailure(failure), 'DB_ORIGIN_DB_FS_BOUNDARY').toBe(true);
        const media = new FilesystemMediaStore(join(denied, 'media'));
        const error: unknown = await media
          .pruneLegacyTemporaries({ legacyOffline: true, force: true })
          .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(MediaStoreFilesystemError);
        expect(isOwnedStorageFailure(error), 'DB_ORIGIN_MEDIA_FS_BOUNDARY').toBe(true);
      } finally {
        chmodSync(denied, 0o700);
      }
    },
  );

  it('the public media conversion cannot infer origin from arbitrary errno or internal io', () => {
    const paths = new MediaStorePaths(join(root, 'media'));
    expect(
      isOwnedStorageFailure(paths.error(Object.assign(new Error('PRIVATE'), { code: 'EACCES' }))),
    ).toBe(false);
    expect(isOwnedStorageFailure(paths.error(new MediaStoreFilesystemError('io')))).toBe(false);
  });
});
