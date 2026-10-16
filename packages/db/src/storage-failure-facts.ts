import Database from 'better-sqlite3';
import { getSystemErrorName } from 'node:util';

// Authority is private identity, not a public error constructor, field, cause or message.
const storageFailures = new WeakSet<object>();
const clients = new WeakMap<object, Database.Database>();

/** Read-only origin fact supplied at an owned DB/filesystem operation (ADR-0110). */
export function isOwnedStorageFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && storageFailures.has(value);
}

/** Package-internal: copy existing authority, never infer it from an arbitrary wrapped cause. */
export function transferStorageFailure(target: object, source: unknown): void {
  if (isOwnedStorageFailure(source)) storageFailures.add(target);
}

function ownValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

// Explicit native vocabulary from the installed SQLite header; unknown future extensions fail closed.
const SQLITE_STORAGE_CODES = new Set([
  'SQLITE_PERM',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_READONLY',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_CANTOPEN',
  'SQLITE_NOTADB',
  'SQLITE_BUSY_RECOVERY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED_SHAREDCACHE',
  'SQLITE_LOCKED_VTAB',
  'SQLITE_CANTOPEN_NOTEMPDIR',
  'SQLITE_CANTOPEN_ISDIR',
  'SQLITE_CANTOPEN_FULLPATH',
  'SQLITE_CANTOPEN_CONVPATH',
  'SQLITE_CANTOPEN_DIRTYWAL',
  'SQLITE_CANTOPEN_SYMLINK',
  'SQLITE_CORRUPT_VTAB',
  'SQLITE_CORRUPT_SEQUENCE',
  'SQLITE_CORRUPT_INDEX',
  'SQLITE_READONLY_RECOVERY',
  'SQLITE_READONLY_CANTLOCK',
  'SQLITE_READONLY_ROLLBACK',
  'SQLITE_READONLY_DBMOVED',
  'SQLITE_READONLY_CANTINIT',
  'SQLITE_READONLY_DIRECTORY',
  'SQLITE_IOERR_READ',
  'SQLITE_IOERR_SHORT_READ',
  'SQLITE_IOERR_WRITE',
  'SQLITE_IOERR_FSYNC',
  'SQLITE_IOERR_DIR_FSYNC',
  'SQLITE_IOERR_TRUNCATE',
  'SQLITE_IOERR_FSTAT',
  'SQLITE_IOERR_UNLOCK',
  'SQLITE_IOERR_RDLOCK',
  'SQLITE_IOERR_DELETE',
  'SQLITE_IOERR_BLOCKED',
  'SQLITE_IOERR_NOMEM',
  'SQLITE_IOERR_ACCESS',
  'SQLITE_IOERR_CHECKRESERVEDLOCK',
  'SQLITE_IOERR_LOCK',
  'SQLITE_IOERR_CLOSE',
  'SQLITE_IOERR_DIR_CLOSE',
  'SQLITE_IOERR_SHMOPEN',
  'SQLITE_IOERR_SHMSIZE',
  'SQLITE_IOERR_SHMLOCK',
  'SQLITE_IOERR_SHMMAP',
  'SQLITE_IOERR_SEEK',
  'SQLITE_IOERR_DELETE_NOENT',
  'SQLITE_IOERR_MMAP',
  'SQLITE_IOERR_GETTEMPPATH',
  'SQLITE_IOERR_CONVPATH',
  'SQLITE_IOERR_VNODE',
  'SQLITE_IOERR_AUTH',
  'SQLITE_IOERR_BEGIN_ATOMIC',
  'SQLITE_IOERR_COMMIT_ATOMIC',
  'SQLITE_IOERR_ROLLBACK_ATOMIC',
  'SQLITE_IOERR_DATA',
  'SQLITE_IOERR_CORRUPTFS',
  'SQLITE_IOERR_IN_PAGE',
  'SQLITE_IOERR_BADKEY',
  'SQLITE_IOERR_CODEC',
]);

/** Only call at the actual owned native operation, never from a generic error classifier. */
export function markNativeStorageFailure(value: unknown): void {
  try {
    if (
      value instanceof Database.SqliteError &&
      Object.getPrototypeOf(value) === Database.SqliteError.prototype
    ) {
      const code = ownValue(value, 'code');
      if (typeof code === 'string' && SQLITE_STORAGE_CODES.has(code)) storageFailures.add(value);
    }
  } catch {
    // A malformed/native-facade error is not provenance. Preserve the original escaping fault.
  }
}

/** The callback must be exactly a native SQLite operation owned by this package. */
export function withOwnedSqlite<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    markNativeStorageFailure(error);
    throw error;
  }
}

/** Node's native errno must agree with its code; a code-shaped foreign object is insufficient. */
function markFilesystemStorageFailure(value: unknown): void {
  try {
    if (!(value instanceof Error) || Object.getPrototypeOf(value) !== Error.prototype) return;
    const code = ownValue(value, 'code');
    const errno = ownValue(value, 'errno');
    if (
      (code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EROFS') &&
      typeof errno === 'number' &&
      Number.isSafeInteger(errno) &&
      errno < 0 &&
      typeof ownValue(value, 'syscall') === 'string' &&
      getSystemErrorName(errno) === code
    )
      storageFailures.add(value);
  } catch {
    // Native type/descriptor disagreement must not replace the operation's original failure.
  }
}

/** Package-internal wrappers: only actual filesystem calls may grant this authority. */
export function withOwnedFilesystem<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    markFilesystemStorageFailure(error);
    throw error;
  }
}

export async function withOwnedFilesystemAsync<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    markFilesystemStorageFailure(error);
    throw error;
  }
}

export function rememberOwnedClient(db: object, sqlite: Database.Database): void {
  clients.set(db, sqlite);
}

export function hasOwnedClient(db: object): boolean {
  try {
    const sqlite = clients.get(db);
    return sqlite !== undefined && ownValue(db, '$client') === sqlite;
  } catch {
    return false;
  }
}
