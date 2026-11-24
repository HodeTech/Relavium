import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppendTargetRefusedError, appendToOwnerOnlyFile } from './owner-only-append.js';

// The file operations are wrapped (calling through to the real ones) so a test can see which of them were used, and can act between two
// of them the way another process would.
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    openSync: vi.fn(native.openSync),
    writeSync: vi.fn(native.writeSync),
    fchmodSync: vi.fn(native.fchmodSync),
    fstatSync: vi.fn(native.fstatSync),
    lstatSync: vi.fn(native.lstatSync),
    appendFileSync: vi.fn(native.appendFileSync),
    chmodSync: vi.fn(native.chmodSync),
  };
});

const POSIX = process.platform !== 'win32';

describe('appendToOwnerOnlyFile (review P2: the outbox and consent lstat-then-append window)', () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.clearAllMocks();
    vi.mocked(openSync).mockImplementation(native.openSync);
    vi.mocked(writeSync).mockImplementation(native.writeSync);
    dir = mkdtempSync(join(tmpdir(), 'relavium-append-'));
    path = join(dir, 'store.ndjson');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens, checks, writes and sets the mode through ONE descriptor, never by path again', () => {
    appendToOwnerOnlyFile(path, 'one\n', 0o600);
    expect(readFileSync(path, 'utf8')).toBe('one\n');

    const opens = vi.mocked(openSync).mock.calls.filter(([target]) => target === path);
    expect(opens).toHaveLength(1);
    const flags = Number(opens[0]?.[1]);
    for (const wanted of [constants.O_WRONLY, constants.O_APPEND, constants.O_CREAT]) {
      expect(flags & wanted).toBe(wanted);
    }
    // Where the platform has them: a link is refused at the open, and the open never waits on a FIFO.
    for (const flag of [constants.O_NOFOLLOW, constants.O_NONBLOCK]) {
      if (flag !== undefined) expect(flags & flag).toBe(flag);
    }
    const opened = vi.mocked(openSync).mock.results[0];
    const fd = opened?.type === 'return' ? opened.value : undefined;
    expect(typeof fd).toBe('number');
    expect(vi.mocked(fstatSync).mock.calls.map(([target]) => target)).toEqual([fd]);
    expect(vi.mocked(writeSync).mock.calls.map(([target]) => target)).toEqual([fd]);
    expect(vi.mocked(fchmodSync).mock.calls.map(([target]) => target)).toEqual([fd]);
    // None of the by-path operations the old guard used between its check and its use.
    expect(vi.mocked(appendFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(chmodSync)).not.toHaveBeenCalled();
    if (POSIX) expect(vi.mocked(lstatSync)).not.toHaveBeenCalled();
  });

  it.skipIf(!POSIX)(
    'writes into the file it opened when a link is put at the path right after the open',
    async () => {
      const native = await vi.importActual<typeof import('node:fs')>('node:fs');
      writeFileSync(path, 'before\n');
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'untouched');
      let swapped = false;
      vi.mocked(openSync).mockImplementation((target, flags, mode) => {
        const fd = native.openSync(target, flags, mode);
        if (target === path && !swapped) {
          swapped = true;
          // The window the old `lstat` then `appendFileSync(path)` left: the checked file is moved away and a link takes its name.
          renameSync(path, join(dir, 'moved.ndjson'));
          symlinkSync(victim, path);
        }
        return fd;
      });
      appendToOwnerOnlyFile(path, 'after\n', 0o600);
      expect(swapped).toBe(true);
      expect(readFileSync(victim, 'utf8')).toBe('untouched');
      expect(readFileSync(join(dir, 'moved.ndjson'), 'utf8')).toBe('before\nafter\n');
    },
  );

  it.skipIf(!POSIX)('refuses a link at the path unfollowed, and writes nothing through it', () => {
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'untouched');
    chmodSync(victim, 0o644);
    symlinkSync(victim, path);
    let refused: unknown;
    try {
      appendToOwnerOnlyFile(path, 'x\n', 0o600);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppendTargetRefusedError);
    expect(refused instanceof AppendTargetRefusedError && refused.reason).toBe('symlink');
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(statSync(victim).mode & 0o777).toBe(0o644); // the link's target was not even chmod'ed
  });

  it.skipIf(!POSIX)('refuses a FIFO without waiting, and a directory, as not regular', () => {
    execFileSync('mkfifo', [path]);
    // A reader is held so that an open that forgot O_NONBLOCK could not hang the test worker (a blocked open cannot be timed out).
    const reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect(() => {
        appendToOwnerOnlyFile(path, 'x\n', 0o600);
      }).toThrow(AppendTargetRefusedError);
    } finally {
      closeSync(reader);
    }
    rmSync(path);
    mkdirSync(path);
    expect(() => {
      appendToOwnerOnlyFile(path, 'x\n', 0o600);
    }).toThrow(); // a directory cannot be opened for writing at all
  });

  it.skipIf(!POSIX)(
    'creates the file with the mode from the first byte, and repairs a wider one',
    () => {
      appendToOwnerOnlyFile(path, 'a\n', 0o600);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      chmodSync(path, 0o644);
      appendToOwnerOnlyFile(path, 'b\n', 0o600);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('a\nb\n');
    },
  );

  it('writes every byte when the system takes them a few at a time', async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeSync).mockImplementation(
      (fd: number, data: NodeJS.ArrayBufferView | string, offset?: number | null) => {
        if (typeof data === 'string') throw new Error('the helper writes bytes');
        const from = offset ?? 0;
        return native.writeSync(fd, data, from, Math.min(3, data.byteLength - from));
      },
    );
    appendToOwnerOnlyFile(path, '0123456789\n', 0o600);
    expect(readFileSync(path, 'utf8')).toBe('0123456789\n');
    expect(vi.mocked(writeSync).mock.calls.length).toBeGreaterThan(1);
  });

  it('lets any other failure through as it is, for the caller to decide', () => {
    let thrown: unknown;
    try {
      appendToOwnerOnlyFile(join(dir, 'no-such-directory', 'store.ndjson'), 'x\n', 0o600);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeInstanceOf(AppendTargetRefusedError);
    expect(thrown).toMatchObject({ code: 'ENOENT' });
  });
});
