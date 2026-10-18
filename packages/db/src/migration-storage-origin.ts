import Database from 'better-sqlite3';
import { DrizzleError } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { Db } from './client.js';
import {
  hasOwnedClient,
  markNativeStorageFailure,
  transferStorageFailure,
} from './storage-failure-facts.js';

/** Fixed owned migration boundary; the installed migrator and error identity stay unchanged. */
export function migrateWithOwnedStorageFacts(db: Db, migrationsFolder: string): void {
  try {
    migrate(db, { migrationsFolder });
  } catch (error) {
    if (hasOwnedClient(db)) {
      markNativeStorageFailure(error);
      try {
        // The sync installed driver creates exactly this one public wrapper. Never walk a cause tree.
        if (
          error instanceof DrizzleError &&
          Object.getPrototypeOf(error) === DrizzleError.prototype
        ) {
          const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
          const cause: unknown =
            descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
          if (
            cause instanceof Database.SqliteError &&
            Object.getPrototypeOf(cause) === Database.SqliteError.prototype
          ) {
            markNativeStorageFailure(cause);
            transferStorageFailure(error, cause);
          }
        }
      } catch {
        // An unexpected wrapper shape supplies no authority and cannot mask the primary failure.
      }
    }
    throw error;
  }
}
