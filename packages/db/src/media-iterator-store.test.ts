import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MediaAdmissionError, registerNativeMediaIterator } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

const opened = vi.hoisted(() => ({ files: [] as FileHandle[] }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      const file = await native.open(...args);
      opened.files.push(file);
      return file;
    },
  };
});

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-iterator-store-'));
  opened.files.length = 0;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const invalid = new Uint8Array(128); // Invalid PNG signature, refused during push before EOF.
const refusedHandle = 'media://sha256-' + createHash('sha256').update(invalid).digest('hex');

async function assertUnpublished(store: FilesystemMediaStore | InMemoryMediaStore): Promise<void> {
  await expect(store.get(refusedHandle)).rejects.toMatchObject({ reason: 'missing' });
  if (store instanceof FilesystemMediaStore) {
    expect(await store.listHandles()).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
    expect(opened.files).toHaveLength(1);
    await expect(opened.files[0]?.stat()).rejects.toMatchObject({ code: 'EBADF' });
  }
}

describe.each(['memory', 'filesystem'] as const)('%s iterator retirement', (kind) => {
  const create = (): InMemoryMediaStore | FilesystemMediaStore =>
    kind === 'memory' ? new InMemoryMediaStore() : new FilesystemMediaStore(root);

  it('retires owned storage despite a foreign pending return and preserves byte refusal', async () => {
    const store = create();
    const closeStarted = gate();
    const releaseClose = gate();
    let returnCalls = 0;
    const returned = releaseClose.promise.then(() => ({ done: true, value: undefined }) as const);
    const iterator: AsyncIterableIterator<Uint8Array> = {
      next: () => Promise.resolve({ done: false, value: invalid }),
      return: () => {
        returnCalls++;
        closeStarted.release();
        return returned;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const result = store.putStream(iterator, 'image/png').then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await closeStarted.promise;
      // The return gate stays held through the entire observation. Event-loop progress is a
      // checkpoint, not a timeout claimed as proof of closure; release/join happens in finally.
      const observed = await Promise.race([
        result,
        new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
      ]);
      expect(observed, 'MEDIA_STORE_FOREIGN_CLOSE_FINITE').toEqual({
        error: new MediaAdmissionError('invalid_format'),
      });
      expect(returnCalls).toBe(1);
      await assertUnpublished(store);
    } finally {
      releaseClose.release();
      await returned;
      await result;
    }
  });

  it('cleans owned storage before joining registered return and preserves primary byte failure', async () => {
    const store = create();
    const closeStarted = gate();
    const releaseClose = gate();
    let returnCalls = 0;
    let cleanupAtClose: { fileCount: number; closed: boolean; entries: string[] } | undefined;
    const returned = releaseClose.promise.then(() => {
      throw new Error('private native retirement sentinel');
    });
    // Observe the intentionally rejected fixture promise independently of the production helper.
    const returnedObserved = returned.catch(() => undefined);
    const iterator = registerNativeMediaIterator<AsyncIterableIterator<Uint8Array>>({
      next: () => Promise.resolve({ done: false, value: invalid }),
      return: () => {
        returnCalls++;
        cleanupAtClose = {
          fileCount: opened.files.length,
          closed: opened.files.every((file) => file.fd === -1),
          entries: readdirSync(root),
        };
        closeStarted.release();
        return returned;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    let settled = false;
    const result = store.putStream(iterator, 'image/png').then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await closeStarted.promise;
      if (store instanceof FilesystemMediaStore)
        expect(cleanupAtClose, 'MEDIA_STORE_LOCAL_CLEANUP_BEFORE_CLOSE').toEqual({
          fileCount: 1,
          closed: true,
          entries: [],
        });
      await assertUnpublished(store);
      expect(settled, 'MEDIA_STORE_NATIVE_CLOSE_JOIN').toBe(false);
      expect(returnCalls).toBe(1);
      releaseClose.release();
      expect(await result, 'MEDIA_STORE_PRIMARY_FAILURE_PRECEDENCE').toEqual({
        error: new MediaAdmissionError('invalid_format'),
      });
    } finally {
      releaseClose.release();
      await returnedObserved;
      await result;
    }
  });

  it('does not request redundant return after natural terminal next', async () => {
    const store = create();
    let pulled = false;
    const close = vi.fn(() => Promise.reject(new Error('unexpected close')));
    const iterator = registerNativeMediaIterator<AsyncIterableIterator<Uint8Array>>({
      next: () => {
        if (pulled) return Promise.resolve({ done: true, value: undefined });
        pulled = true;
        return Promise.resolve({ done: false, value: new Uint8Array([1, 2]) });
      },
      return: close,
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    const handle = await store.putStream(iterator, 'audio/L16');
    expect(await store.get(handle)).toEqual(new Uint8Array([1, 2]));
    expect(close).not.toHaveBeenCalled();
  });
});
