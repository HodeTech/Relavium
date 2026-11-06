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
import {
  replaceFileForStorage,
  StorageTargetChangedError,
  storageFileIdentity,
  type StorageFileIdentity,
} from './owned-storage.js';

/**
 * The atomic rewrite `/export` uses for a session's own earlier export (MVP-A3), on the real filesystem —
 * owned-storage.test.ts mocks `node:fs` for its errno boundary and cannot show what lands on disk.
 */
describe('replaceFileForStorage', () => {
  let dir: string;
  const temps = (): string[] => readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const identityOf = (path: string): StorageFileIdentity =>
    storageFileIdentity(lstatSync(path, { bigint: true }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-replace-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temp beside it', () => {
    const path = join(dir, 'w.relavium.yaml');
    writeFileSync(path, 'old');
    replaceFileForStorage(path, 'new', 0o644, identityOf(path));
    expect(readFileSync(path, 'utf8')).toBe('new');
    expect(temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a path that became a link after the check, and never writes through it',
    () => {
      const outside = join(dir, 'outside.yaml');
      writeFileSync(outside, 'not ours');
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      const checked = identityOf(path);
      rmSync(path);
      symlinkSync(outside, path);
      expect(() => {
        replaceFileForStorage(path, 'new', 0o644, checked);
      }).toThrow(StorageTargetChangedError);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, 'utf8')).toBe('not ours');
      expect(temps()).toEqual([]);
    },
  );

  it('refuses a directory at the path, removes its temp, and leaves what was there', () => {
    const path = join(dir, 'w.relavium.yaml');
    mkdirSync(path);
    expect(() => {
      replaceFileForStorage(path, 'new', 0o644, identityOf(path));
    }).toThrow();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(temps()).toEqual([]);
  });

  for (const [change, apply] of [
    [
      'replaced by another file',
      (path: string) => {
        rmSync(path);
        writeFileSync(path, 'another workflow, put here meanwhile');
      },
    ],
    [
      'rewritten in place',
      (path: string) => {
        writeFileSync(path, 'rewritten in place, meanwhile');
      },
    ],
    [
      'rewritten in place to the same length',
      (path: string) => {
        writeFileSync(path, 'new'); // as long as 'old': only its ctime tells
      },
    ],
    [
      'removed',
      (path: string) => {
        rmSync(path);
      },
    ],
  ] as const) {
    it(`refuses a file ${change} after the check, and writes nothing`, () => {
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      const checked = identityOf(path);
      apply(path);
      const before = (() => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return undefined;
        }
      })();
      expect(() => {
        replaceFileForStorage(path, 'new', 0o644, checked);
      }).toThrow(StorageTargetChangedError);
      expect(
        (() => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return undefined;
          }
        })(),
      ).toBe(before);
      expect(temps()).toEqual([]);
    });
  }

  it.skipIf(process.platform === 'win32')(
    'gives the new file exactly the old permission bits, whatever the umask would make of them',
    () => {
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      for (const mode of [0o600, 0o666]) {
        chmodSync(path, mode);
        replaceFileForStorage(path, 'new', mode, identityOf(path));
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
      replaceFileForStorage(path, 'new', 0o444, identityOf(path));
    } catch (error) {
      caught = error;
    }
    expect(isCliError(caught) && caught.code).toBe('storage_unavailable');
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(temps()).toEqual([]);
  });
});
