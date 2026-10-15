import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore, InMemoryMediaStore } from './media-store.js';

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

const bytes = new Uint8Array([1, 2]);
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'relavium-read-cancellation-'));
  hooks.afterOpen.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function legacyHandle(): string {
  const digest = createHash('sha256').update(bytes).digest('hex');
  const shard = join(root, digest.slice(0, 2));
  mkdirSync(shard);
  writeFileSync(join(shard, digest.slice(2)), bytes);
  return 'media://sha256-' + digest;
}
function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {
    throw new Error('fixture latch was not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function cancellation(result: PromiseSettledResult<unknown> | undefined): void {
  expect(result).toMatchObject({
    status: 'rejected',
    reason: {
      name: 'AbortError',
      code: 'media_read_cancelled',
      message: 'media read was cancelled',
    },
  });
  if (result?.status !== 'rejected') throw new Error('fixture expected cancellation');
  const failure: unknown = result.reason;
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('fixture expected typed error');
  expect(failure.message).not.toContain('private');
  expect(Reflect.get(failure, 'cause')).toBeUndefined();
}

it.each(['filesystem', 'memory'])(
  '%s pre-abort uses a stable content-free code before I/O or listener registration',
  async (kind) => {
    const store = kind === 'filesystem' ? new FilesystemMediaStore(root) : new InMemoryMediaStore();
    const handle = kind === 'filesystem' ? legacyHandle() : await store.put(bytes, 'audio/L16');
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    controller.abort(new Error('private abort reason'));
    const [result] = await Promise.allSettled([
      store.readRange(handle, { start: 0, end: 0 }, controller.signal),
    ]);
    cancellation(result);
    expect(hooks.afterOpen, 'DB_READ_TYPED_PREABORT').not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  },
);

it('typed cancellation during native read still joins that read, fd close and listener removal', async () => {
  const handle = legacyHandle();
  const entered = latch();
  const release = latch();
  const controller = new AbortController();
  const add = vi.spyOn(controller.signal, 'addEventListener');
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  let nativeSettled = false;
  let closed = false;
  let settled = false;
  hooks.afterOpen.mockImplementation((file) => {
    const read = file.read.bind(file);
    const close = file.close.bind(file);
    vi.spyOn(file, 'read').mockImplementation(async (options) => {
      const pending = read(options);
      void pending.then(
        () => {
          nativeSettled = true;
        },
        () => {
          nativeSettled = true;
        },
      );
      entered.release();
      await release.promise;
      return pending;
    });
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      expect(file.fd).toBe(-1);
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
    expect(nativeSettled).toBe(false);
    controller.abort(new Error('private abort reason'));
    await Promise.resolve();
    expect({ settled, closed }, 'DB_READ_TYPED_PENDING_NATIVE_JOIN').toEqual({
      settled: false,
      closed: false,
    });
  } finally {
    release.release();
    await pending;
  }
  const [result] = await pending;
  cancellation(result);
  expect({ nativeSettled, closed }).toEqual({ nativeSettled: true, closed: true });
  expect(add).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', add.mock.calls[0]?.[1]);
});

it('abort at owned native close keeps typed refusal pending until close acknowledgement', async () => {
  const handle = legacyHandle();
  const entered = latch();
  const release = latch();
  const controller = new AbortController();
  let closed = false;
  let settled = false;
  hooks.afterOpen.mockImplementation((file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      const pending = close();
      entered.release();
      await release.promise;
      await pending;
      expect(file.fd).toBe(-1);
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
    controller.abort(new Error('private abort reason'));
    await Promise.resolve();
    expect({ settled, closed }, 'DB_READ_TYPED_CLOSE_JOIN').toEqual({
      settled: false,
      closed: false,
    });
  } finally {
    release.release();
    await pending;
  }
  const [result] = await pending;
  cancellation(result);
  expect(closed).toBe(true);
});
