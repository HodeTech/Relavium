import Database from 'better-sqlite3';
import { DrizzleError, DrizzleQueryError } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, expect, it, vi } from 'vitest';

import { createClient, type DbClient } from './client.js';
import { migrateWithOwnedStorageFacts } from './migration-storage-origin.js';
import { isOwnedStorageFailure } from './storage-failure-facts.js';

vi.mock('drizzle-orm/better-sqlite3/migrator', async (original) => {
  const native = await original<typeof import('drizzle-orm/better-sqlite3/migrator')>();
  return { ...native, migrate: vi.fn(native.migrate) };
});
const clients: DbClient[] = [];
afterEach(() => {
  vi.mocked(migrate).mockReset();
  for (const client of clients.splice(0)) if (client.sqlite.open) client.sqlite.close();
});

function failureAtMigration(error: unknown): unknown {
  const client = createClient();
  clients.push(client);
  vi.mocked(migrate).mockImplementationOnce(() => {
    throw error;
  });
  try {
    migrateWithOwnedStorageFacts(client.db, 'unused-fixed-fixture');
  } catch (actual) {
    return actual;
  }
  throw new Error('missing fixture failure');
}

it('only the exact escaping driver wrapper receives its own native storage fact', () => {
  const error = new DrizzleError({ cause: new Database.SqliteError('PRIVATE', 'SQLITE_FULL') });
  expect(isOwnedStorageFailure(error)).toBe(false);
  expect(failureAtMigration(error)).toBe(error);
  expect(isOwnedStorageFailure(error)).toBe(true);
  const later = new Error('PRIVATE', { cause: error });
  expect(failureAtMigration(later)).toBe(later);
  expect(isOwnedStorageFailure(later)).toBe(false);
});

it('does not traverse nested causes, foreign wrappers, names or copied code shapes', () => {
  const native = new Database.SqliteError('PRIVATE', 'SQLITE_READONLY');
  class ForeignDrizzleError extends DrizzleError {}
  class ForeignSqliteError extends Database.SqliteError {}
  // The driver's constructor deliberately returns a base instance even for new.target subclasses.
  const foreignNative = new Database.SqliteError('PRIVATE', 'SQLITE_READONLY');
  Object.setPrototypeOf(foreignNative, ForeignSqliteError.prototype);
  for (const error of [
    new Error('PRIVATE', { cause: new DrizzleError({ cause: native }) }),
    new DrizzleError({ cause: new Error('PRIVATE', { cause: native }) }),
    new DrizzleQueryError('PRIVATE', [], native),
    new ForeignDrizzleError({ cause: native }),
    new DrizzleError({ cause: foreignNative }),
    { name: 'DrizzleError', cause: native },
    new DrizzleError({ cause: { name: 'SqliteError', code: 'SQLITE_READONLY' } }),
    new DrizzleError({ cause: new Database.SqliteError('PRIVATE', 'SQLITE_IOERR_UNREVIEWED') }),
  ]) {
    expect(failureAtMigration(error)).toBe(error);
    expect(isOwnedStorageFailure(error)).toBe(false);
  }
});

it('never invokes accessor-backed causes/codes or hostile proxy traps as diagnostic data', () => {
  const getter = vi.fn(() => {
    throw new Error('PRIVATE');
  });
  const accessorCause = Object.defineProperty(new DrizzleError({}), 'cause', { get: getter });
  const native = Object.defineProperty(new Database.SqliteError('PRIVATE', 'SQLITE_FULL'), 'code', {
    get: getter,
  });
  const inheritedCause = new DrizzleError({});
  Reflect.deleteProperty(inheritedCause, 'cause');
  const proxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error('PRIVATE');
      },
      get: getter,
    },
  );
  for (const error of [accessorCause, new DrizzleError({ cause: native }), inheritedCause, proxy]) {
    expect(failureAtMigration(error)).toBe(error);
    expect(isOwnedStorageFailure(error)).toBe(false);
  }
  expect(getter).not.toHaveBeenCalled();
});
