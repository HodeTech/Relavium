import { createHash } from 'node:crypto';
import {
  existsSync,
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

const tempName = vi.hoisted(() => ({ fixed: false }));
vi.mock('node:crypto', async (original) => {
  const native = await original<typeof import('node:crypto')>();
  return {
    ...native,
    randomUUID: () =>
      tempName.fixed ? '00000000-0000-4000-8000-000000000000' : native.randomUUID(),
  };
});

const io = vi.hoisted(() => ({ open: vi.fn(), readdir: vi.fn(), rename: vi.fn(), rm: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>();
  return {
    ...native,
    open: (...args: Parameters<typeof native.open>) => {
      io.open(args[0]);
      return native.open(...args);
    },
    readdir: (...args: Parameters<typeof native.readdir>) => {
      io.readdir(args[0]);
      return native.readdir(...args);
    },
    rename: (...args: Parameters<typeof native.rename>) => {
      io.rename(...args);
      return native.rename(...args);
    },
    rm: (...args: Parameters<typeof native.rm>) => {
      io.rm(args[0]);
      return native.rm(...args);
    },
  };
});

const bytes = Buffer.from('correct-hash sibling media fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
const handle = `media://sha256-${digest}`;
const operations: ReadonlyArray<
  readonly [string, (store: FilesystemMediaStore) => Promise<unknown>]
> = [
  ['get', (store) => store.get(handle)],
  ['readRange', (store) => store.readRange(handle, { start: 0, end: 2 })],
  ['put', (store) => store.put(bytes)],
  [
    'putStream',
    (store) =>
      store.putStream(
        (async function* () {
          yield await Promise.resolve(bytes);
        })(),
      ),
  ],
  ['delete', (store) => store.delete(handle)],
  ['listHandles', (store) => store.listHandles()],
];
let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-cas-paths-')));
  root = join(base, 'cas');
  outside = join(base, 'sibling');
  mkdirSync(root);
  mkdirSync(outside);
  tempName.fixed = false;
  for (const spy of Object.values(io)) spy.mockClear();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe.each(['shard-link', 'final-link', 'hard-link'] as const)(
  'CAS %s physical containment',
  (shape) => {
    it.each(operations)(
      '%s refuses before sibling reads/writes/deletes despite a valid content hash',
      async (_name, operate) => {
        const siblingFile = join(outside, digest.slice(2));
        writeFileSync(siblingFile, bytes);
        const shard = join(root, digest.slice(0, 2));
        if (shape === 'shard-link') symlinkSync(outside, shard, 'junction');
        else {
          mkdirSync(shard);
          if (shape === 'final-link') symlinkSync(siblingFile, join(shard, digest.slice(2)));
          else linkSync(siblingFile, join(shard, digest.slice(2)));
        }
        const store = new FilesystemMediaStore(root);
        await expect(operate(store)).rejects.toBeInstanceOf(MediaStoreFilesystemError);
        const final = join(shard, digest.slice(2));
        expect(io.open.mock.calls.map(([path]) => String(path))).not.toContain(final);
        expect(io.rename).not.toHaveBeenCalled();
        expect(io.rm.mock.calls.map(([path]) => String(path))).not.toContain(final);
        if (shape === 'shard-link')
          expect(io.readdir.mock.calls.map(([path]) => String(path))).not.toContain(shard);
        for (const spy of Object.values(io)) {
          expect(
            spy.mock.calls
              .flat()
              .map(String)
              .some((path) => path.startsWith(outside)),
          ).toBe(false);
        }
        expect(readFileSync(siblingFile)).toEqual(bytes);
        expect(readdirSync(outside)).toEqual([digest.slice(2)]);
        expect(readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      },
    );
  },
);

describe.each(['replace-directory', 'retarget-alias'] as const)('CAS pinned root %s', (shape) => {
  it.each(operations)(
    '%s refuses a replacement rather than re-authorising it',
    async (_name, operate) => {
      const lexical = shape === 'retarget-alias' ? join(base, 'alias') : root;
      if (shape === 'retarget-alias') symlinkSync(root, lexical, 'junction');
      const store = new FilesystemMediaStore(lexical);
      expect(await store.put(bytes)).toBe(handle);
      if (shape === 'retarget-alias') {
        rmSync(lexical);
        symlinkSync(outside, lexical, 'junction');
      } else {
        renameSync(root, `${root}-old`);
        mkdirSync(root);
      }
      await expect(operate(store)).rejects.toBeInstanceOf(MediaStoreFilesystemError);
      expect(readdirSync(outside)).toEqual([]);
      if (shape === 'replace-directory') expect(readdirSync(root)).toEqual([]);
    },
  );
});

it('does not remove an unowned temporary occupant after an exclusive-open refusal', async () => {
  tempName.fixed = true;
  const victim = join(outside, 'victim');
  writeFileSync(victim, 'unowned');
  const occupied = join(root, 'stream.00000000-0000-4000-8000-000000000000.tmp');
  symlinkSync(victim, occupied);
  await expect(new FilesystemMediaStore(root).put(bytes)).rejects.toBeInstanceOf(
    MediaStoreFilesystemError,
  );
  expect(readFileSync(victim, 'utf8')).toBe('unowned');
  expect(existsSync(occupied)).toBe(true);
});

it('owns put bytes before awaiting and preserves concurrent atomic/idempotent publication', async () => {
  const store = new FilesystemMediaStore(root);
  const mutable = Buffer.from(bytes);
  const pending = store.put(mutable);
  mutable.fill(0);
  expect(await pending).toBe(handle);
  const handles = await Promise.all([
    store.put(bytes),
    new FilesystemMediaStore(root).putStream(
      (async function* () {
        yield await Promise.resolve(bytes);
      })(),
    ),
  ]);
  expect(handles).toEqual([handle, handle]);
  expect(await store.get(handle)).toEqual(new Uint8Array(bytes));
  expect((await store.listHandles()).map((entry) => entry.handle)).toEqual([handle]);
});

it('preserves never-created read/GC semantics without provisioning a root', async () => {
  const missing = join(base, 'not-yet-created');
  const store = new FilesystemMediaStore(missing);
  expect(await store.listHandles()).toEqual([]);
  await store.delete(handle);
  await expect(store.get(handle)).rejects.toBeInstanceOf(MediaStoreFilesystemError);
  expect(existsSync(missing)).toBe(false);
});
