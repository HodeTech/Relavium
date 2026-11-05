import {
  chmodSync,
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from './errors.js';
import { replaceFileForStorage } from './owned-storage.js';

/**
 * The atomic rewrite `/export` uses for a session's own earlier export (MVP-A3), on the real filesystem —
 * owned-storage.test.ts mocks `node:fs` for its errno boundary and cannot show what lands on disk.
 */
describe('replaceFileForStorage', () => {
  let dir: string;
  const temps = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-replace-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temp beside it', () => {
    const path = join(dir, 'w.relavium.yaml');
    writeFileSync(path, 'old');
    replaceFileForStorage(path, 'new', 0o644);
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a link at the path instead of writing through it',
    () => {
      const outside = join(dir, 'outside.yaml');
      writeFileSync(outside, 'not ours');
      const path = join(dir, 'w.relavium.yaml');
      symlinkSync(outside, path);
      replaceFileForStorage(path, 'new', 0o644);
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe('new');
      expect(readFileSync(outside, 'utf8')).toBe('not ours');
      expect(temps()).toEqual([]);
    },
  );

  it('removes its temp when the rename fails, and leaves what was there', () => {
    const path = join(dir, 'w.relavium.yaml');
    mkdirSync(path); // a directory: the rename onto it fails
    expect(() => {
      replaceFileForStorage(path, 'new', 0o644);
    }).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'gives the new file exactly the old permission bits, whatever the umask would make of them',
    () => {
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      for (const mode of [0o600, 0o666]) {
        chmodSync(path, mode);
        replaceFileForStorage(path, 'new', mode);
        expect(statSync(path).mode & 0o777).toBe(mode);
      }
    },
  );

  it.skipIf(isRoot)('refuses a file made read-only rather than replacing it', () => {
    const path = join(dir, 'w.relavium.yaml');
    writeFileSync(path, 'old');
    chmodSync(path, 0o444);
    let caught: unknown;
    try {
      replaceFileForStorage(path, 'new', 0o444);
    } catch (error) {
      caught = error;
    }
    expect(isCliError(caught) && caught.code).toBe('storage_unavailable');
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(temps()).toEqual([]);
  });
});
