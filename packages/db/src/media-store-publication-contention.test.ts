import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';
import { MediaStoreFilesystemError } from './media-store-paths.js';

const fault = vi.hoisted(() => ({
  code: undefined as string | undefined,
  beforeFailure: undefined as ((source: string, target: string) => void) | undefined,
  rename: vi.fn(),
  rm: vi.fn(),
  cleanupFails: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    rename: async (...args: Parameters<typeof native.rename>) => {
      fault.rename();
      if (fault.code !== undefined) {
        fault.beforeFailure?.(String(args[0]), String(args[1]));
        throw Object.assign(new Error('private native rename sentinel'), {
          code: fault.code,
          syscall: 'rename',
        });
      }
      return native.rename(...args);
    },
    rm: (...args: Parameters<typeof native.rm>) => {
      fault.rm();
      if (fault.cleanupFails) return Promise.reject(new Error('private cleanup sentinel'));
      return native.rm(...args);
    },
  };
});

const actualPlatform = process.platform;
const bytes = Buffer.from('same content address from an independent publisher');
const digest = createHash('sha256').update(bytes).digest('hex');
const handle = 'media://sha256-' + digest;
let base: string;
let root: string;
let store: FilesystemMediaStore;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-cas-publish-contention-')));
  root = join(base, 'cas');
  mkdirSync(root);
  store = new FilesystemMediaStore(root);
  fault.code = undefined;
  fault.beforeFailure = undefined;
  fault.cleanupFails = false;
  fault.rename.mockClear();
  fault.rm.mockClear();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: actualPlatform });
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

function asWindows(): void {
  // Exercise the Windows decision on every CI OS; all underlying files and reads remain native.
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

function publish(method: 'put' | 'putStream'): Promise<string> {
  return method === 'put'
    ? store.put(bytes)
    : store.putStream(
        (async function* () {
          yield await Promise.resolve(bytes);
        })(),
      );
}

describe.each(['put', 'putStream'] as const)('Windows CAS %s rename contention', (method) => {
  it.each(['EPERM', 'EBUSY'])(
    'verifies a concurrent winner after %s and cleans its own unpublished temp without retrying',
    async (code) => {
      asWindows();
      fault.code = code;
      fault.beforeFailure = (_source, target) => writeFileSync(target, bytes);
      const read = vi.spyOn(store, 'get');
      // Assert the settled observation directly: Vitest's `.resolves` rejection path omits
      // custom assertion messages, so it cannot serve as the named causal witness.
      const [settled] = await Promise.allSettled([publish(method)]);
      expect(settled, 'FS_CAUSAL_CAS_WINDOWS_WINNER').toMatchObject({
        status: 'fulfilled',
        value: handle,
      });
      expect(read).toHaveBeenCalledExactlyOnceWith(handle);
      expect(fault.rename).toHaveBeenCalledOnce();
      expect(fault.rm).toHaveBeenCalledOnce();
      expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
    },
  );
});

it.each(['missing', 'corrupt', 'symlink', 'hardlink', 'directory', 'replaced-root'] as const)(
  'never accepts an unverified %s winner after Windows rename contention',
  async (shape) => {
    asWindows();
    fault.code = 'EPERM';
    fault.beforeFailure = (_source, target) => {
      const sibling = join(base, 'sibling');
      writeFileSync(sibling, bytes);
      if (shape === 'corrupt') writeFileSync(target, 'corrupt');
      else if (shape === 'symlink') symlinkSync(sibling, target);
      else if (shape === 'hardlink') linkSync(sibling, target);
      else if (shape === 'directory') mkdirSync(target);
      else if (shape === 'replaced-root') {
        renameSync(root, root + '-old');
        mkdirSync(root);
      }
    };
    await expect(store.put(bytes)).rejects.toEqual(new MediaStoreFilesystemError('io'));
    expect(fault.rename).toHaveBeenCalledOnce();
    expect(readFileSync(join(base, 'sibling'))).toEqual(bytes);
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // A revoked root cannot authorize even cleanup of its old temp.
    expect(fault.rm).toHaveBeenCalledTimes(shape === 'replaced-root' ? 0 : 1);
  },
);

it.each([
  ['win32', 'EIO'],
  ['win32', 'EACCES'],
  ['linux', 'EPERM'],
  ['linux', 'EBUSY'],
] as const)(
  'does not reconcile %s %s as Windows replacement contention',
  async (platform, code) => {
    Object.defineProperty(process, 'platform', { value: platform });
    fault.code = code;
    fault.beforeFailure = (_source, target) => writeFileSync(target, bytes);
    const read = vi.spyOn(store, 'get');
    await expect(store.put(bytes)).rejects.toEqual(new MediaStoreFilesystemError('io'));
    expect(read).not.toHaveBeenCalled();
    expect(fault.rename).toHaveBeenCalledOnce();
    expect(fault.rm).toHaveBeenCalledOnce();
  },
);

it('reports owned-temp cleanup failure even after a winner passed verification', async () => {
  asWindows();
  fault.code = 'EPERM';
  fault.cleanupFails = true;
  fault.beforeFailure = (_source, target) => writeFileSync(target, bytes);
  await expect(store.put(bytes)).rejects.toEqual(new MediaStoreFilesystemError('io'));
  expect(fault.rm).toHaveBeenCalledOnce();
  expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
});

it('does not remove a replacement of its temp even when the winning blob verifies', async () => {
  asWindows();
  fault.code = 'EPERM';
  let replacedTemp: string | undefined;
  fault.beforeFailure = (source, target) => {
    renameSync(source, join(root, 'retained-owned-temp'));
    writeFileSync(source, 'unowned occupant');
    replacedTemp = source;
    writeFileSync(target, bytes);
  };
  await expect(store.put(bytes)).rejects.toEqual(new MediaStoreFilesystemError('unsafe_path'));
  expect(fault.rm).not.toHaveBeenCalled();
  expect(replacedTemp).toBeDefined();
  if (replacedTemp !== undefined)
    expect(readFileSync(replacedTemp, 'utf8')).toBe('unowned occupant');
});
