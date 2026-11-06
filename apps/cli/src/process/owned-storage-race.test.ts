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
    rmSync(dir, { recursive: true, force: true });
  });

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
    'refuses a link put there without following it, rather than failing on the open',
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
