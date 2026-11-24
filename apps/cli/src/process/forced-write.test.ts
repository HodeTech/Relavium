/**
 * The forced-write sequence on its own (`forced-write.ts`): what a replacement keeps of the file it replaces (the security sitting on
 * PR #102, L2), and the guard it runs on both sides of its work. The cases that go through the commands and the in-chat export are in
 * `authoring/write-authored-file.test.ts`, `authoring/write-pinned-directory.test.ts` and `chat/export-force.test.ts`.
 *
 * L2: a replacement is a NEW file, so it starts in the process's or the directory's group. A `0660` file of group `_developer` came
 * back `0660` of group `staff`, widening who can read an authored file that may hold pasted secrets. The group is carried over; when it
 * cannot be, only the owner's bits stay.
 */
import {
  chmodSync,
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

import { WRITTEN_ELSEWHERE, writeForced } from './forced-write.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fchownSync: vi.fn(actual.fchownSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

let dir = '';
beforeEach(() => {
  // A reset puts back the real implementation each spy wraps.
  vi.mocked(fs.fchownSync).mockReset();
  vi.mocked(fs.lstatSync).mockReset();
  dir = mkdtempSync(join(tmpdir(), 'relavium-forced-write-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const target = (): string => join(dir, 'a.agent.yaml');
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const eperm = (): Error =>
  Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

/** The next look at a file reports it as belonging to `gid`, a group the new file will not be created in. */
function claimGroup(gid: number): void {
  vi.mocked(fs.lstatSync).mockImplementationOnce((path, options) =>
    Object.assign(realFs.lstatSync(path, options as never), { gid }),
  );
}
const otherGroup = (): number => (statSync(dir).gid + 4242) % 60000;

describe.skipIf(process.platform === 'win32')(
  'what a replacement keeps of the file it replaces',
  () => {
    it('asks for the old group, on the new file, by its descriptor, and keeps every permission bit when that works', () => {
      writeFileSync(target(), 'old\n');
      chmodSync(target(), 0o660);
      const foreign = otherGroup();
      claimGroup(foreign);
      vi.mocked(fs.fchownSync).mockImplementation(() => undefined);
      writeForced(target(), 'new\n');
      expect(vi.mocked(fs.fchownSync)).toHaveBeenCalledTimes(1);
      const [fd, uid, gid] = vi.mocked(fs.fchownSync).mock.calls[0] ?? [];
      expect(typeof fd).toBe('number');
      expect([uid, gid], 'the owner is left alone, the group is the old file’s').toEqual([
        -1,
        foreign,
      ]);
      expect(readFileSync(target(), 'utf8')).toBe('new\n');
      expect(modeOf(target()), 'the bits are kept whole').toBe(0o660);
    });

    it('when the group cannot be carried over, keeps ONLY the owner’s bits, and never throws for it', () => {
      writeFileSync(target(), 'old\n');
      chmodSync(target(), 0o664);
      claimGroup(otherGroup());
      vi.mocked(fs.fchownSync).mockImplementation(() => {
        throw eperm();
      });
      expect(() => writeForced(target(), 'new\n')).not.toThrow();
      expect(vi.mocked(fs.fchownSync)).toHaveBeenCalledTimes(1);
      expect(readFileSync(target(), 'utf8'), 'the write itself went through').toBe('new\n');
      expect(modeOf(target()), 'group and world bits are gone: 0664 -> 0600').toBe(0o600);
      expect(readdirSync(dir)).toEqual(['a.agent.yaml']);
    });

    it('leaves the group alone and narrows nothing when the new file already has the old one’s group', () => {
      // A file system that refuses `chown` outright (some network and FUSE mounts) must not turn every rewrite into a 0600 file.
      writeFileSync(target(), 'old\n');
      chmodSync(target(), 0o664);
      vi.mocked(fs.fchownSync).mockImplementation(() => {
        throw eperm();
      });
      writeForced(target(), 'new\n');
      expect(vi.mocked(fs.fchownSync)).not.toHaveBeenCalled();
      expect(modeOf(target())).toBe(0o664);
    });

    it('really keeps a group the process belongs to (skipped when there is no second one)', () => {
      const directoryGroup = statSync(dir).gid;
      const other = process.getgroups?.().find((gid) => gid !== directoryGroup);
      if (other === undefined) return;
      writeFileSync(target(), 'old\n');
      fs.chownSync(target(), -1, other);
      chmodSync(target(), 0o660);
      writeForced(target(), 'new\n');
      expect(statSync(target()).gid, 'the group of the file that was replaced').toBe(other);
      expect(modeOf(target())).toBe(0o660);
    });
  },
);

describe('the guard runs on both sides of the work, and a refusal takes the temporary away', () => {
  it('before the look, before the temporary, right before the rename and after it', () => {
    writeFileSync(target(), 'old\n');
    const seen: string[][] = [];
    writeForced(target(), 'new\n', () => {
      seen.push(readdirSync(dir).sort());
    });
    expect(seen).toHaveLength(4);
    expect(seen[0], 'before the look: only the old file').toEqual(['a.agent.yaml']);
    expect(seen[1], 'before the temporary: still only the old file').toEqual(['a.agent.yaml']);
    expect(seen[2]?.length, 'right before the rename: the temporary is there').toBe(2);
    expect(seen[3], 'after the rename: the new file alone').toEqual(['a.agent.yaml']);
    expect(readFileSync(target(), 'utf8')).toBe('new\n');
  });

  it('a guard that refuses before the rename leaves the old file whole and no temporary behind', () => {
    writeFileSync(target(), 'old\n');
    let calls = 0;
    expect(() =>
      writeForced(target(), 'new\n', () => {
        calls += 1;
        if (calls === 3) throw new Error('the directory changed');
      }),
    ).toThrow('the directory changed');
    expect(readFileSync(target(), 'utf8')).toBe('old\n');
    expect(readdirSync(dir)).toEqual(['a.agent.yaml']);
  });

  it('a guard that refuses AFTER the rename is reported as a write that may have gone elsewhere, never as "nothing was written"', () => {
    writeFileSync(target(), 'old\n');
    let calls = 0;
    let message: string | undefined;
    try {
      writeForced(target(), 'new\n', () => {
        calls += 1;
        if (calls === 4) throw new Error('the directory changed');
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toBe(WRITTEN_ELSEWHERE);
    expect(readFileSync(target(), 'utf8'), 'the rename had happened').toBe('new\n');
    expect(readdirSync(dir)).toEqual(['a.agent.yaml']);
  });

  it('a guard that refuses before an exclusive create creates nothing', () => {
    expect(() =>
      writeForced(target(), 'new\n', () => {
        throw new Error('the directory changed');
      }),
    ).toThrow('the directory changed');
    expect(readdirSync(dir)).toEqual([]);
  });
});
