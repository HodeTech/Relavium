import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createClient, DbOpenError } from './client.js';
import { isOwnedStorageFailure } from './storage-failure-facts.js';

describe('native SQLite custody during construction', () => {
  it.each([false, true])(
    'captures before the first failing PRAGMA; close failure=%s',
    (closeFails) => {
      const root = mkdtempSync(join(tmpdir(), 'relavium-client-acquisition-'));
      const path = join(root, 'corrupt.db');
      writeFileSync(path, 'synthetic invalid SQLite header'.repeat(8));
      const nativeClose: unknown = Object.getOwnPropertyDescriptor(
        Database.prototype,
        'close',
      )?.value;
      if (typeof nativeClose !== 'function')
        throw new Error('Native SQLite close fixture is unavailable.');
      const secondary = new Error('synthetic native close refusal');
      const native: { connection?: Database.Database } = {};
      let captured: (() => void) | undefined;
      const close = vi.spyOn(Database.prototype, 'close').mockImplementation(function (
        this: Database.Database,
      ) {
        native.connection = this;
        if (closeFails) throw secondary;
        Reflect.apply(nativeClose, this, []);
        return this;
      });
      try {
        let failure: unknown;
        try {
          createClient(path, (release) => {
            captured = release;
            expect(close).not.toHaveBeenCalled();
          });
        } catch (cause) {
          failure = cause;
        }
        expect(captured, 'SQLITE_CAPABILITY_PRECEDES_PRAGMA_FAILURE').toBeTypeOf('function');
        expect(failure).toBeInstanceOf(DbOpenError);
        expect(native.connection?.open).toBe(closeFails);
        expect(isOwnedStorageFailure(failure), 'FAILED_NATIVE_CLEANUP_IS_NOT_OPERATIONAL').toBe(
          !closeFails,
        );
        if (failure instanceof DbOpenError) {
          if (closeFails) {
            expect(failure.cause).toBeInstanceOf(AggregateError);
            if (failure.cause instanceof AggregateError) {
              expect(failure.cause.errors[0]).toBeInstanceOf(Database.SqliteError);
              expect(failure.cause.errors[1]).toBe(secondary);
              expect(failure.cause.cause).toBe(failure.cause.errors[0]);
            }
          } else {
            expect(failure.cause).toBeInstanceOf(Database.SqliteError);
            captured?.();
            expect(close).toHaveBeenCalledOnce();
          }
        }
      } finally {
        close.mockRestore();
        if (native.connection?.open) Reflect.apply(nativeClose, native.connection, []);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
