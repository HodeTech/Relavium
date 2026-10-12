import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaStoreFilesystemError } from './media-store-paths.js';

const boundary = vi.hoisted(() => ({
  beforeOpen: vi.fn<() => void>(),
  afterOpen: vi.fn<(file: FileHandle) => void>(),
  afterRead: vi.fn<() => void>(),
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: async (...args: Parameters<typeof native.open>) => {
      boundary.beforeOpen();
      const file = await native.open(...args);
      try {
        boundary.afterOpen(file);
      } catch (error) {
        // A native fixture mutation can itself be refused on Windows. The caller has not
        // received this fd yet, so the wrapper still owns closing it on that path.
        await file.close();
        throw error;
      }
      const read = file.readFile.bind(file);
      vi.spyOn(file, 'readFile').mockImplementation(async (...readArgs) => {
        const result = await read(...readArgs);
        boundary.afterRead();
        return result;
      });
      return file;
    },
  };
});

const bytes = Buffer.from('native descriptor content');
let base: string;
let root: string;
let target: string;
let handle: string;
let store: FilesystemMediaStore;
let replacementFailure: { code: unknown; syscall: unknown } | undefined;
beforeEach(async () => {
  replacementFailure = undefined;
  for (const hook of Object.values(boundary)) hook.mockReset();
  base = mkdtempSync(join(tmpdir(), 'relavium-cas-read-races-'));
  root = join(base, 'cas');
  store = new FilesystemMediaStore(root);
  handle = await store.put(bytes);
  const digest = handle.slice('media://sha256-'.length);
  target = join(root, digest.slice(0, 2), digest.slice(2));
  for (const hook of Object.values(boundary)) hook.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function replace(bytes: Uint8Array): void {
  const temporary = join(root, 'replacement');
  writeFileSync(temporary, bytes);
  fixtureRename(temporary, target);
}

function fixtureRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    replacementFailure = {
      code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
      syscall:
        typeof error === 'object' && error !== null && 'syscall' in error
          ? error.syscall
          : undefined,
    };
    throw error;
  }
}

/** Assert an actual native Windows rename refusal, without claiming an inode replacement occurred. */
function expectNativeRenameRefusal(error: unknown): void {
  expect(process.platform).toBe('win32');
  expect(replacementFailure?.syscall).toBe('rename');
  expect(['EPERM', 'EBUSY']).toContain(replacementFailure?.code);
  expect(error).toEqual(new MediaStoreFilesystemError('io'));
}

it.each(['beforeOpen', 'afterOpen', 'afterRead'] as const)(
  'accepts a cooperative atomic replacement at %s with the same content address',
  async (point) => {
    boundary[point].mockImplementationOnce(() => replace(bytes));
    const result = await store.get(handle).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    if (replacementFailure === undefined) expect(result.value).toEqual(new Uint8Array(bytes));
    else {
      expectNativeRenameRefusal(result.error);
      expect(result.value).toBeUndefined();
      expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
    }
    expect(boundary[point]).toHaveBeenCalledOnce();
  },
);

it.each(['afterOpen', 'afterRead'] as const)(
  'keeps opened bytes and hash verification together when another inode replaces the name at %s',
  async (point) => {
    boundary[point].mockImplementationOnce(() => replace(Buffer.from('corrupt replacement')));
    // This read linearizes at open; a subsequent read must verify the replacement independently.
    const result = await store.get(handle).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    if (replacementFailure === undefined) {
      expect(result.value).toEqual(new Uint8Array(bytes));
      await expect(store.get(handle)).rejects.toThrow(/content-address/);
    } else {
      expectNativeRenameRefusal(result.error);
      expect(result.value).toBeUndefined();
      expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
    }
  },
);

it('refuses a corrupt replacement opened after pathname admission', async () => {
  boundary.beforeOpen.mockImplementationOnce(() => replace(Buffer.from('corrupt replacement')));
  await expect(store.get(handle)).rejects.toThrow(/content-address/);
});

it('keeps no-follow admission when a final symlink appears immediately before open', async () => {
  const sibling = join(base, 'sibling');
  writeFileSync(sibling, bytes);
  boundary.beforeOpen.mockImplementationOnce(() => {
    rmSync(target);
    symlinkSync(sibling, target);
  });
  await expect(store.get(handle)).rejects.toBeInstanceOf(MediaStoreFilesystemError);
  // Windows ignores O_NOFOLLOW; its repeated final-entry floor still refuses before
  // reading bytes. POSIX additionally rejects the link in the kernel's open itself.
  if (process.platform !== 'win32') expect(boundary.afterOpen).not.toHaveBeenCalled();
  expect(boundary.afterRead).not.toHaveBeenCalled();
});

it.each(['afterOpen', 'afterRead'] as const)(
  'still refuses a planted final symlink at %s even if the opened bytes have the correct hash',
  async (point) => {
    const sibling = join(base, 'sibling');
    writeFileSync(sibling, bytes);
    boundary[point].mockImplementationOnce(() => {
      rmSync(target);
      symlinkSync(sibling, target);
    });
    await expect(store.get(handle)).rejects.toMatchObject({ reason: 'unsafe_path' });
  },
);

it.each(['beforeOpen', 'afterOpen', 'afterRead'] as const)(
  'still refuses a new hard link to the opened inode at %s',
  async (point) => {
    boundary[point].mockImplementationOnce(() => linkSync(target, join(base, 'sibling')));
    await expect(store.get(handle)).rejects.toMatchObject({ reason: 'unsafe_path' });
  },
);

it.each(['afterOpen', 'afterRead'] as const)(
  'still refuses a replacement final hard link at %s even when the opened fd is detached',
  async (point) => {
    const sibling = join(base, 'sibling');
    writeFileSync(sibling, bytes);
    boundary[point].mockImplementationOnce(() => {
      rmSync(target);
      linkSync(sibling, target);
    });
    await expect(store.get(handle)).rejects.toMatchObject({ reason: 'unsafe_path' });
  },
);

it('still refuses a root replacement after reading', async () => {
  boundary.afterRead.mockImplementationOnce(() => {
    fixtureRename(root, `${root}-old`);
    mkdirSync(root);
  });
  const error: unknown = await store.get(handle).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (replacementFailure === undefined) expect(error).toMatchObject({ reason: 'unsafe_path' });
  else {
    expectNativeRenameRefusal(error);
    expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
  }
});

it('reports a close failure after a successful read without leaking the native error', async () => {
  boundary.afterOpen.mockImplementationOnce((file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      throw new Error('private close diagnostic');
    });
  });
  await expect(store.get(handle)).rejects.toEqual(new MediaStoreFilesystemError('io'));
});

it('preserves an integrity failure when closing the descriptor also fails', async () => {
  writeFileSync(target, 'corrupt bytes');
  boundary.afterOpen.mockImplementationOnce((file) => {
    const close = file.close.bind(file);
    vi.spyOn(file, 'close').mockImplementation(async () => {
      await close();
      throw new Error('private close diagnostic');
    });
  });
  await expect(store.get(handle)).rejects.toThrow(/content-address/);
});
