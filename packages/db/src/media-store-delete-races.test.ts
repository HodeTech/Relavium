import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MediaStoreFilesystemError } from './media-store-paths.js';
import { FilesystemMediaStore } from './media-store.js';

const boundary = vi.hoisted(() => ({
  beforeRm: vi.fn<() => Promise<void>>(),
  afterRm: vi.fn<() => void>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    rm: async (...args: Parameters<typeof native.rm>) => {
      await boundary.beforeRm();
      try {
        await native.rm(...args);
      } finally {
        boundary.afterRm();
      }
    },
  };
});

const bytes = Buffer.from('cooperating native deletion fixture ');
let root: string;
let store: FilesystemMediaStore;
let handle: string;
let target: string;
beforeEach(async () => {
  boundary.beforeRm.mockReset();
  boundary.beforeRm.mockResolvedValue(undefined);
  boundary.afterRm.mockReset();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-cas-delete-races-')));
  store = new FilesystemMediaStore(root);
  handle = await store.put(bytes, 'audio/L16');
  const digest = handle.slice('media://sha256-'.length);
  target = join(root, digest.slice(0, 2), digest.slice(2));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(root + '-old', { recursive: true, force: true });
});

it('keeps two admitted cooperating deletes idempotent when the second native rm wins', async () => {
  let release = (): void => undefined;
  const completed = new Promise<void>((resolve) => {
    release = resolve;
  });
  boundary.beforeRm.mockImplementationOnce(() => completed);
  boundary.afterRm.mockImplementationOnce(release);
  const other = new FilesystemMediaStore(root);
  // Both stores admit the same native regular file before either rm proceeds. Only the
  // first rm is delayed; the second removes the file and releases it without any sleeps.
  const results = await Promise.allSettled([store.delete(handle), other.delete(handle)]);
  expect(results, 'FS_CAUSAL_CAS_DELETE_IDEMPOTENT').toEqual([
    { status: 'fulfilled', value: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
  expect(boundary.beforeRm).toHaveBeenCalledTimes(2);
  expect(existsSync(target)).toBe(false);
});

it.each(['EACCES', 'EPERM', 'EBUSY', 'EIO'])(
  'preserves a nonmissing %s deletion failure without exposing native details',
  async (code) => {
    boundary.beforeRm.mockRejectedValueOnce(
      Object.assign(new Error('private deletion path sentinel'), { code }),
    );
    await expect(store.delete(handle)).rejects.toEqual(new MediaStoreFilesystemError('io'));
    expect(readFileSync(target)).toEqual(bytes);
    expect(boundary.beforeRm).toHaveBeenCalledOnce();
  },
);

it.each(['root-replaced', 'root-removed', 'shard-link', 'final-link', 'final-hardlink'] as const)(
  'a missing rm outcome cannot bypass the %s floor',
  async (shape) => {
    boundary.beforeRm.mockImplementationOnce(() => {
      if (shape === 'root-replaced' || shape === 'root-removed') {
        renameSync(root, root + '-old');
        if (shape === 'root-replaced') mkdirSync(root);
      } else {
        const digest = handle.slice('media://sha256-'.length);
        const shard = join(root, digest.slice(0, 2));
        const sibling = join(root, 'sibling');
        if (shape === 'shard-link') {
          renameSync(shard, sibling);
          symlinkSync(sibling, shard, 'junction');
        } else {
          renameSync(target, sibling);
          if (shape === 'final-link') symlinkSync(sibling, target);
          else linkSync(sibling, target);
        }
      }
      return Promise.reject(
        Object.assign(new Error('private missing path sentinel'), { code: 'ENOENT' }),
      );
    });
    await expect(store.delete(handle)).rejects.toBeInstanceOf(MediaStoreFilesystemError);
    expect(boundary.beforeRm).toHaveBeenCalledOnce();
    expect(boundary.afterRm).not.toHaveBeenCalled();
    if (shape !== 'root-replaced' && shape !== 'root-removed') {
      expect(existsSync(join(root, 'sibling'))).toBe(true);
    }
  },
);

it('refuses a replacement regular entry after a missing rm outcome', async () => {
  boundary.beforeRm.mockImplementationOnce(() => {
    renameSync(target, join(root, 'retained-original'));
    writeFileSync(target, 'replacement occupant');
    return Promise.reject(
      Object.assign(new Error('private missing path sentinel'), { code: 'ENOENT' }),
    );
  });
  await expect(store.delete(handle)).rejects.toEqual(new MediaStoreFilesystemError('missing'));
  expect(readFileSync(target, 'utf8')).toBe('replacement occupant');
});
