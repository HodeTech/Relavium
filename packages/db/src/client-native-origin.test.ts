import { afterEach, expect, it, vi } from 'vitest';
import type NativeDatabase from 'better-sqlite3';

const faults: { failure: Error | undefined } = vi.hoisted(() => ({ failure: undefined }));
vi.mock('better-sqlite3', async (original) => {
  const native = await original<{ readonly default: typeof NativeDatabase }>();
  class NativeConstructorFixture extends native.default {
    constructor(...args: ConstructorParameters<typeof native.default>) {
      if (faults.failure !== undefined) throw faults.failure;
      super(...args);
    }
  }
  return { ...native, default: NativeConstructorFixture };
});
import { createClient, DbOpenError } from './client.js';
import { isOwnedStorageFailure } from './storage-failure-facts.js';
afterEach(() => {
  faults.failure = undefined;
});

it.each(['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND', 'ENOENT', 'EACCES'])(
  'constructor-time %s is not storage merely because open_failed wraps it',
  (code) => {
    // Synthetic import/ABI/foreign constructor fault; the actual native constructor loads its addon here.
    const cause = Object.assign(new Error('PRIVATE native loader payload'), { code });
    faults.failure = cause;
    try {
      createClient();
    } catch (error) {
      expect(error).toBeInstanceOf(DbOpenError);
      if (!(error instanceof DbOpenError)) throw new Error('wrong wrapper');
      expect(error.code).toBe('open_failed');
      expect(error.cause).toBe(cause);
      expect(error.message).toBe('could not open the SQLite database');
      expect(isOwnedStorageFailure(error)).toBe(false);
      return;
    }
    throw new Error('fixture did not fail');
  },
);
