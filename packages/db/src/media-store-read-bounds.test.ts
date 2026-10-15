import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_MEDIA_OBJECT_BYTES } from '@relavium/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaStorePaths } from './media-store-paths.js';
import { scanMediaFile } from './media-store-read.js';

const hooks = vi.hoisted(() => ({ afterOpen: vi.fn<(file: FileHandle) => void>() }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      const file = await native.open(...args);
      hooks.afterOpen(file);
      return file;
    },
  };
});
let root: string;
beforeEach(() => {
  hooks.afterOpen.mockReset();
  root = mkdtempSync(join(tmpdir(), 'relavium-media-fd-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function legacy(bytes: Uint8Array): { handle: string; path: string } {
  const digest = createHash('sha256').update(bytes).digest('hex');
  mkdirSync(join(root, digest.slice(0, 2)), { recursive: true });
  const path = join(root, digest.slice(0, 2), digest.slice(2));
  writeFileSync(path, bytes);
  return { path, handle: 'media://sha256-' + digest };
}
function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error('uninitialized latch');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it('refuses oversized opened fd before any read and joins close', async () => {
  const { handle } = legacy(new Uint8Array(MAX_MEDIA_OBJECT_BYTES + 2));
  let reads = 0;
  let closes = 0;
  hooks.afterOpen.mockImplementation((file) => {
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (options) => {
      reads++;
      return read(options);
    });
    vi.spyOn(file, 'readFile').mockImplementation(() => {
      throw new Error('whole file read forbidden');
    });
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      closes++;
    });
  });
  const [result] = await Promise.allSettled([
    new FilesystemMediaStore(root).readRange(handle, { start: 0, end: 0 }),
  ]);
  expect({ result, reads, closes }, 'MEDIA_STORE_PREALLOCATION_FD_BOUND').toMatchObject({
    result: { status: 'rejected', reason: { code: 'object_limit' } },
    reads: 0,
    closes: 1,
  });
});
it('bounds growth after initial fd stat before copying the overflow chunk', async () => {
  const { handle, path } = legacy(new Uint8Array(2));
  let reads = 0;
  hooks.afterOpen.mockImplementation((file) => {
    const read = file.read.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (options) => {
      const result = await read(options);
      if (reads++ === 0) appendFileSync(path, new Uint8Array(MAX_MEDIA_OBJECT_BYTES));
      return result;
    });
  });
  let copied = 0;
  const originalSet: unknown = Reflect.get(Uint8Array.prototype, 'set');
  if (typeof originalSet !== 'function') throw new Error('native set unavailable');
  vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(function (
    this: Uint8Array,
    input,
    offset,
  ) {
    if (input instanceof Uint8Array) copied += input.byteLength;
    Reflect.apply(originalSet, this, [input, offset]);
  });
  const [result] = await Promise.allSettled([new FilesystemMediaStore(root).get(handle)]);
  expect(result).toMatchObject({ status: 'rejected', reason: { code: 'object_limit' } });
  expect(copied, 'MEDIA_STORE_CUMULATIVE_READ_BOUND').toBeLessThanOrEqual(MAX_MEDIA_OBJECT_BYTES);
  expect(reads).toBeGreaterThan(1);
});
it('abort wins a pending native read and joins fd close/listener removal before settling', async () => {
  const { handle } = legacy(new Uint8Array(2));
  const entered = latch();
  const release = latch();
  const controller = new AbortController();
  let closed = false;
  let settled = false;
  let nativeSettled = false;
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  hooks.afterOpen.mockImplementation((file) => {
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (options) => {
      const result = read(options);
      void result.then(
        () => {
          nativeSettled = true;
        },
        () => {
          nativeSettled = true;
        },
      );
      entered.release();
      await release.promise;
      return result;
    });
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      closed = true;
    });
  });
  const pending = Promise.allSettled([
    new FilesystemMediaStore(root).readRange(handle, { start: 0, end: 0 }, controller.signal),
  ]).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered.promise;
    expect(nativeSettled).toBe(false); // Actual native read promise is outstanding at cancellation.
    controller.abort('private');
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release.release();
  }
  const [result] = await pending;
  expect({ result, closed }, 'MEDIA_STORE_PENDING_READ_ABORT').toMatchObject({
    result: { status: 'rejected', reason: { name: 'AbortError' } },
    closed: true,
  });
  expect(add).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]?.[1]);
});
it('abort at joined native close prevents successful delivery', async () => {
  const { handle } = legacy(new Uint8Array(2));
  const controller = new AbortController();
  hooks.afterOpen.mockImplementation((file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      controller.abort();
    });
  });
  const [result] = await Promise.allSettled([
    new FilesystemMediaStore(root).readRange(handle, { start: 0, end: 0 }, controller.signal),
  ]);
  expect(result, 'MEDIA_STORE_PREDELIVERY_ABORT').toMatchObject({
    status: 'rejected',
    reason: { name: 'AbortError' },
  });
});

it('scanMediaFile refuses after its own joined native close even without a range caller', async () => {
  const { handle } = legacy(new Uint8Array(2));
  const controller = new AbortController();
  let closed = false;
  hooks.afterOpen.mockImplementation((file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      closed = true;
      controller.abort();
    });
  });
  const [result] = await Promise.allSettled([
    scanMediaFile(
      new MediaStorePaths(root),
      handle.slice('media://sha256-'.length),
      false,
      undefined,
      controller.signal,
    ),
  ]);
  expect({ result, closed }, 'FS_CAUSAL_MEDIA_SCANNER_PREDELIVERY_SIGNAL').toMatchObject({
    result: { status: 'rejected', reason: { name: 'AbortError' } },
    closed: true,
  });
});
