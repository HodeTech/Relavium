/**
 * What the atomic rewrite of a session's own earlier export (`replaceFileForStorage`) keeps of the file it replaces, and the guard it is
 * held to (the second security sitting on PR #102, finding 5 and finding 1). It kept the permission bits and nothing else: a `0660` file
 * of group X came back `0660` of the directory's or the process's group, widening who could read an exported scaffold that may hold
 * pasted secrets. The group is now carried over with the same best-effort rule `forced-write.ts` uses for every forced write
 * (`carryOwnership`): when it cannot be, only the owner's bits stay. The rewrite of a file with no group handed in is what it always was.
 */
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WRITTEN_ELSEWHERE } from './forced-write.js';
import { replaceFileForStorage, storageFileIdentity } from './owned-storage.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fchownSync: vi.fn(actual.fchownSync) };
});

let dir = '';
beforeEach(() => {
  vi.mocked(fs.fchownSync).mockReset();
  dir = mkdtempSync(join(tmpdir(), 'relavium-owned-ownership-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const target = (): string => join(dir, 'w.relavium.yaml');
const identityOf = (path: string) =>
  storageFileIdentity(lstatSync(path, { bigint: true }), readFileSync(path));
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const eperm = (): Error =>
  Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
/** A group the new file will not be created in. */
const foreignGroup = (): number => (statSync(dir).gid + 4242) % 60000;

describe.skipIf(process.platform === 'win32')(
  'the rewrite keeps the group of the file it replaces',
  () => {
    it('asks for the old group on the new file, and keeps every permission bit when that works', () => {
      writeFileSync(target(), 'old');
      chmodSync(target(), 0o660);
      const gid = foreignGroup();
      vi.mocked(fs.fchownSync).mockImplementation(() => undefined);
      replaceFileForStorage(target(), 'new', 0o660, identityOf(target()), { gid });
      expect(vi.mocked(fs.fchownSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fs.fchownSync).mock.calls[0]?.slice(1)).toEqual([-1, gid]);
      expect(readFileSync(target(), 'utf8')).toBe('new');
      expect(modeOf(target())).toBe(0o660);
    });

    it('when the group cannot be carried over, keeps ONLY the owner’s bits: a 0660 file is never left open to another group', () => {
      writeFileSync(target(), 'old');
      chmodSync(target(), 0o660);
      vi.mocked(fs.fchownSync).mockImplementation(() => {
        throw eperm();
      });
      replaceFileForStorage(target(), 'new', 0o660, identityOf(target()), { gid: foreignGroup() });
      expect(readFileSync(target(), 'utf8'), 'the rewrite itself went through').toBe('new');
      expect(modeOf(target()), '0660 -> 0600').toBe(0o600);
      expect(readdirSync(dir)).toEqual(['w.relavium.yaml']);
    });

    it('with no group handed in, it is the rewrite it always was: the mode alone, no chown', () => {
      writeFileSync(target(), 'old');
      chmodSync(target(), 0o664);
      replaceFileForStorage(target(), 'new', 0o664, identityOf(target()));
      expect(vi.mocked(fs.fchownSync)).not.toHaveBeenCalled();
      expect(modeOf(target())).toBe(0o664);
    });

    it('really keeps a group the process belongs to (skipped when there is no second one)', () => {
      const directoryGroup = statSync(dir).gid;
      const other = process.getgroups?.().find((gid) => gid !== directoryGroup);
      if (other === undefined) return;
      writeFileSync(target(), 'old');
      fs.chownSync(target(), -1, other);
      chmodSync(target(), 0o660);
      const { gid } = statSync(target());
      replaceFileForStorage(target(), 'new', 0o660, identityOf(target()), { gid });
      expect(statSync(target()).gid, 'the group of the file that was replaced').toBe(other);
      expect(modeOf(target())).toBe(0o660);
    });
  },
);

describe('the directory guard the rewrite is held to', () => {
  it('a guard that refuses before the temporary is created writes nothing and leaves the file as it was', () => {
    writeFileSync(target(), 'old');
    expect(() =>
      replaceFileForStorage(target(), 'new', 0o644, identityOf(target()), {
        guard: () => {
          throw new Error('the directory changed');
        },
      }),
    ).toThrow('the directory changed');
    expect(readFileSync(target(), 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['w.relavium.yaml']);
  });

  it('a guard that refuses right before the rename takes the temporary away; after the rename it is a report that the file may be elsewhere', () => {
    writeFileSync(target(), 'old');
    let calls = 0;
    expect(() =>
      replaceFileForStorage(target(), 'new', 0o644, identityOf(target()), {
        guard: () => {
          calls += 1;
          if (calls === 2) throw new Error('the directory changed');
        },
      }),
    ).toThrow('the directory changed');
    expect(readFileSync(target(), 'utf8'), 'before the rename: untouched').toBe('old');
    expect(readdirSync(dir), 'and no temporary').toEqual(['w.relavium.yaml']);

    calls = 0;
    let message: string | undefined;
    try {
      replaceFileForStorage(target(), 'new', 0o644, identityOf(target()), {
        guard: () => {
          calls += 1;
          if (calls === 3) throw new Error('the directory changed');
        },
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toBe(WRITTEN_ELSEWHERE);
    expect(readFileSync(target(), 'utf8'), 'the rename had happened').toBe('new');
  });
});
