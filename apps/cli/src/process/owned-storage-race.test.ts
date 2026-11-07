import { execFileSync } from 'node:child_process';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  replaceFileForStorage,
  StorageTargetChangedError,
  storageFileIdentity,
} from './owned-storage.js';

/**
 * A hook after `lstatSync` returns: the moment between the replace's last stat comparison and its open. The
 * replace lstats the path twice, before it starts and just before the rename; the swap lands after the second, so
 * only the checks on the opened descriptor can see it.
 */
const fsHooks = vi.hoisted(() => ({
  afterLstat: undefined as ((path: string) => void) | undefined,
  opened: [] as string[],
}));
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    lstatSync: (...args: Parameters<typeof native.lstatSync>) => {
      const result = native.lstatSync(...args);
      const [path] = args;
      if (typeof path === 'string') fsHooks.afterLstat?.(path);
      return result;
    },
    openSync: (...args: Parameters<typeof native.openSync>) => {
      const [path] = args;
      if (typeof path === 'string') fsHooks.opened.push(path);
      return native.openSync(...args);
    },
  };
});

describe('replaceFileForStorage — a swap between its last lstat and its open', () => {
  let dir: string;
  const temps = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-replace-race-'));
  });
  afterEach(() => {
    fsHooks.afterLstat = undefined;
    fsHooks.opened = [];
    rmSync(dir, { recursive: true, force: true });
  });

  // Something already at the path when the replace starts is refused on its `lstat`, before anything opens it: on
  // Windows, which has no `O_NOFOLLOW`, that is the only thing keeping a link from being followed by the open.
  for (const [what, put] of [
    ['a directory', (path: string) => mkdirSync(path)],
    ...(process.platform === 'win32'
      ? []
      : ([
          ['a link', (path: string) => symlinkSync(join(dir, 'elsewhere.yaml'), path)],
          ['a FIFO', (path: string) => execFileSync('mkfifo', [path])],
        ] as const)),
  ] as const) {
    it(`refuses ${what} already at the path without opening it`, () => {
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(join(dir, 'elsewhere.yaml'), 'old');
      writeFileSync(path, 'old');
      const checked = storageFileIdentity(lstatSync(path, { bigint: true }), readFileSync(path));
      rmSync(path);
      put(path);
      fsHooks.opened = [];
      expect(() => {
        replaceFileForStorage(path, 'new', 0o644, checked);
      }).toThrow(StorageTargetChangedError);
      expect(fsHooks.opened.filter((opened) => opened === path)).toEqual([]);
      expect(temps()).toEqual([]);
    });
  }

  /** Replace `path` after swapping `swap` in at its second lstat; return what the replace threw. */
  const replaceWithSwap = (path: string, swap: () => void): unknown => {
    writeFileSync(path, 'old');
    const checked = storageFileIdentity(lstatSync(path, { bigint: true }), readFileSync(path));
    let seen = 0;
    fsHooks.afterLstat = (target) => {
      if (target !== path) return;
      seen += 1;
      if (seen !== 2) return;
      fsHooks.afterLstat = undefined;
      swap();
    };
    try {
      replaceFileForStorage(path, 'new', 0o644, checked);
      return undefined;
    } catch (error) {
      return error;
    } finally {
      fsHooks.afterLstat = undefined;
    }
  };

  it('refuses another file with the same bytes put there, which only the descriptor check can tell', () => {
    const path = join(dir, 'w.relavium.yaml');
    const other = join(dir, 'other.yaml');
    const thrown = replaceWithSwap(path, () => {
      writeFileSync(other, 'old');
      rmSync(path);
      linkSync(other, path); // a different inode with the checked bytes
    });
    expect(thrown).toBeInstanceOf(StorageTargetChangedError);
    expect(readFileSync(other, 'utf8')).toBe('old');
    expect(temps()).toEqual([]);
  });

  it('refuses a directory put there, rather than failing on its read', () => {
    const path = join(dir, 'w.relavium.yaml');
    const thrown = replaceWithSwap(path, () => {
      rmSync(path);
      mkdirSync(path);
    });
    expect(thrown).toBeInstanceOf(StorageTargetChangedError);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a link put there, whether or not the open follows it, rather than failing on the open',
    () => {
      const path = join(dir, 'w.relavium.yaml');
      const target = join(dir, 'target.yaml');
      const thrown = replaceWithSwap(path, () => {
        writeFileSync(target, 'old');
        rmSync(path);
        symlinkSync(target, path);
      });
      expect(thrown).toBeInstanceOf(StorageTargetChangedError);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('old');
      expect(temps()).toEqual([]);
    },
  );
});
