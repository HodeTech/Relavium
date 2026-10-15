import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { FilesystemMediaStore } from './media-store.js';

const snapshot = vi.hoisted(() => ({ path: '', temporary: false, hits: 0 }));
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    lstatSync: (...args: Parameters<typeof native.lstatSync>) => {
      const info = native.lstatSync(...args);
      if (
        info !== undefined &&
        (String(args[0]) === snapshot.path ||
          (snapshot.temporary && String(args[0]).endsWith('.tmp')))
      ) {
        // Linux can resolve the old dentry before a concurrent rename detaches it,
        // then return nlink=0 from getattr. Preserve the actual native file identity.
        Object.defineProperty(info, 'nlink', { value: 0 });
        snapshot.hits++;
      }
      return info;
    },
  };
});
const io = vi.hoisted(() => ({ rename: vi.fn(), rm: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    rename: (...args: Parameters<typeof native.rename>) => {
      io.rename();
      return native.rename(...args);
    },
    rm: (...args: Parameters<typeof native.rm>) => {
      io.rm();
      return native.rm(...args);
    },
  };
});

const bytes = Buffer.from('native file content behind a detached pathname snapshot ');
let root: string;
let store: FilesystemMediaStore;
let handle: string;
beforeEach(async () => {
  snapshot.path = '';
  snapshot.temporary = false;
  snapshot.hits = 0;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-cas-entry-snapshot-')));
  store = new FilesystemMediaStore(root);
  handle = await store.put(bytes, 'audio/L16');
  const digest = handle.slice('media://sha256-'.length);
  snapshot.path = join(root, digest.slice(0, 2), digest.slice(2));
  io.rename.mockClear();
  io.rm.mockClear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each(['get', 'readRange', 'resolveForEgress', 'put', 'putStream'] as const)(
  'admits a detached final-entry snapshot through %s without weakening descriptor integrity',
  async (operation) => {
    const result =
      operation === 'put'
        ? store.put(bytes, 'audio/L16')
        : operation === 'putStream'
          ? store.putStream(
              (async function* () {
                yield await Promise.resolve(bytes);
              })(),
              'audio/L16',
            )
          : operation === 'readRange'
            ? store.readRange(handle, { start: 0, end: 2 })
            : store[operation](handle);
    const expected =
      operation === 'put' || operation === 'putStream'
        ? handle
        : operation === 'resolveForEgress'
          ? { kind: 'base64', data: bytes.toString('base64') }
          : new Uint8Array(operation === 'readRange' ? bytes.subarray(0, 3) : bytes);
    const [settled] = await Promise.allSettled([result]);
    expect(settled, 'FS_CAUSAL_CAS_DETACHED_ENTRY').toEqual({
      status: 'fulfilled',
      value: expected,
    });
    expect(snapshot.hits).toBeGreaterThanOrEqual(
      operation === 'put' || operation === 'putStream' ? 2 : 3,
    );
    expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  },
);

it.each(['delete', 'listHandles'] as const)(
  '%s does not use a detached snapshot as destructive or GC authority',
  async (operation) => {
    await expect(
      operation === 'delete' ? store.delete(handle) : store.listHandles(),
    ).rejects.toMatchObject({ reason: 'unsafe_path' });
    expect(io.rm).not.toHaveBeenCalled();
    snapshot.path = '';
    expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
  },
);

it('a detached temporary snapshot cannot prove ownership for publication or cleanup', async () => {
  snapshot.path = '';
  snapshot.temporary = true;
  await expect(store.put(bytes, 'audio/L16')).rejects.toMatchObject({ reason: 'unsafe_path' });
  expect(io.rename).not.toHaveBeenCalled();
  expect(io.rm).not.toHaveBeenCalled();
  expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
});
