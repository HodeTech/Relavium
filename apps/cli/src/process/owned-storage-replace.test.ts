import { execFileSync } from 'node:child_process';
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
  /** What `/export` captures when it recognizes its own file: the stat fields and the bytes' hash. */
  const identityOf = (path: string): StorageFileIdentity =>
    storageFileIdentity(lstatSync(path, { bigint: true }), readFileSync(path));

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

  it('refuses a directory put at the path after the check, removes its temp, and leaves what was there', () => {
    const path = join(dir, 'w.relavium.yaml');
    writeFileSync(path, 'old');
    const checked = identityOf(path);
    rmSync(path);
    mkdirSync(path);
    expect(() => {
      replaceFileForStorage(path, 'new', 0o644, checked);
    }).toThrow(StorageTargetChangedError);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(temps()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO put at the path after the check without opening it, so it never blocks',
    () => {
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      const checked = identityOf(path);
      rmSync(path);
      execFileSync('mkfifo', [path]);
      expect(() => {
        replaceFileForStorage(path, 'new', 0o644, checked);
      }).toThrow(StorageTargetChangedError);
      expect(lstatSync(path).isFIFO()).toBe(true);
      expect(temps()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32' || isRoot)(
    'refuses a file made unreadable after the check as changed, rather than failing the export',
    () => {
      // The stat fields are compared before the bytes are read, so the permission change (a new ctime) is seen as a
      // change and the export moves on, instead of an EACCES from the read failing it.
      const path = join(dir, 'w.relavium.yaml');
      writeFileSync(path, 'old');
      const checked = identityOf(path);
      chmodSync(path, 0o000);
      try {
        expect(() => {
          replaceFileForStorage(path, 'new', 0o644, checked);
        }).toThrow(StorageTargetChangedError);
        expect(temps()).toEqual([]);
      } finally {
        chmodSync(path, 0o644);
      }
      expect(readFileSync(path, 'utf8')).toBe('old');
    },
  );

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
        writeFileSync(path, 'new'); // as long as 'old': on a coarse clock only the bytes' hash tells
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

  it('refuses a file whose bytes differ from the check even when every stat field matches', () => {
    // What a same-length rewrite inside one tick of a coarse filesystem clock looks like: the same device, inode,
    // size and times, other bytes. Only the content hash can tell, so this pins it whatever the local clock.
    const path = join(dir, 'w.relavium.yaml');
    writeFileSync(path, 'old');
    // The real stat fields with other bytes' hash: the check must hash the file's own bytes to tell them apart.
    const checked = storageFileIdentity(
      lstatSync(path, { bigint: true }),
      Buffer.from('other bytes'),
    );
    expect(() => {
      replaceFileForStorage(path, 'new', 0o644, checked);
    }).toThrow(StorageTargetChangedError);
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(temps()).toEqual([]);
  });

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
