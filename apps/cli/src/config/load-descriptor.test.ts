import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GlobalConfigSchema } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { faultForTranscript } from './config-error-text.js';
import { ConfigError } from './errors.js';
import { loadConfigFile } from './load.js';

// The loader's file operations are wrapped (calling through to the real ones) so a test can see which of them it used and can act
// between two of them, the way another process would.
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return {
    ...native,
    openSync: vi.fn(native.openSync),
    fstatSync: vi.fn(native.fstatSync),
    statSync: vi.fn(native.statSync),
    readFileSync: vi.fn(native.readFileSync),
    chmodSync: vi.fn(native.chmodSync),
    fchmodSync: vi.fn(native.fchmodSync),
  };
});

const POSIX = process.platform !== 'win32';

describe('loadConfigFile reads through ONE descriptor (review M-E1)', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.clearAllMocks();
    // clearAllMocks keeps the call-through implementations; make that explicit for the ones a test replaces.
    vi.mocked(openSync).mockImplementation(native.openSync);
    vi.mocked(fstatSync).mockImplementation(native.fstatSync);
    dir = mkdtempSync(join(tmpdir(), 'relavium-load-fd-'));
    file = join(dir, 'config.toml');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the path once, without blocking, and asks the descriptor everything else: no stat or read by path', () => {
    writeFileSync(file, 'update_channel = "beta"\n');
    expect(loadConfigFile(file, GlobalConfigSchema)).toEqual({ update_channel: 'beta' });

    const opens = vi.mocked(openSync).mock.calls.filter(([path]) => path === file);
    expect(opens).toHaveLength(1);
    // O_NONBLOCK is what keeps the open from waiting on a FIFO swapped in for the file (where the platform has it).
    expect(
      (Number(opens[0]?.[1]) & (constants.O_NONBLOCK ?? 0)) === (constants.O_NONBLOCK ?? 0),
    ).toBe(true);
    const [fd] = vi.mocked(fstatSync).mock.calls[0] ?? [];
    expect(typeof fd).toBe('number');
    // Not by path again: the window between a `stat` and a `read` is what this closes.
    expect(vi.mocked(statSync).mock.calls.filter(([path]) => path === file)).toEqual([]);
    expect(vi.mocked(readFileSync)).not.toHaveBeenCalledWith(file, expect.anything());
  });

  it('parses the file it opened, not one renamed over the path after the open', async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    writeFileSync(file, 'update_channel = "beta"\n');
    const other = join(dir, 'other.toml');
    writeFileSync(other, 'update_channel = "stable"\n');
    let swapped = false;
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      const fd = native.openSync(path, flags, mode);
      if (path === file && !swapped) {
        swapped = true;
        renameSync(other, file); // another process replaces the file between the open and the read
      }
      return fd;
    });
    expect(loadConfigFile(file, GlobalConfigSchema)).toEqual({ update_channel: 'beta' });
    expect(swapped).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('stable'); // the swap really happened
  });

  it('refuses a file that grew past the cap after its size was read, from the bytes it reads', async () => {
    const native = await vi.importActual<typeof import('node:fs')>('node:fs');
    writeFileSync(file, 'update_channel = "beta"\n');
    let grown = false;
    vi.mocked(fstatSync).mockImplementation((fd, options) => {
      const stats = native.fstatSync(fd, options);
      if (!grown) {
        grown = true;
        appendFileSync(file, `# ${'x'.repeat(256 * 1024)}\n`); // after the size was taken, before the read
      }
      return stats;
    });
    expect(() => loadConfigFile(file, GlobalConfigSchema)).toThrow(
      `${file}: exceeds the ${256 * 1024}-byte config size limit.`,
    );
    expect(grown).toBe(true);
  });

  it('keeps its sentences for an oversize file and a directory, and names no path in a transcript', () => {
    writeFileSync(file, `x = "${'a'.repeat(256 * 1024)}"\n`);
    const subdir = join(dir, 'a-directory');
    mkdirSync(subdir);
    for (const [target, sentence] of [
      [file, 'exceeds the 262144-byte config size limit.'],
      [subdir, 'is not a regular file.'],
    ] as const) {
      let thrown: unknown;
      try {
        loadConfigFile(target, GlobalConfigSchema);
      } catch (err) {
        thrown = err;
      }
      if (!(thrown instanceof ConfigError)) throw new Error('expected a ConfigError');
      expect(thrown.message).toBe(`${target}: ${sentence}`);
      // The surface that draws into a transcript names the file from the project or the home, never by its absolute path.
      const shown = faultForTranscript(thrown, { cwd: dir, homeDir: dir });
      if (!(shown instanceof ConfigError)) throw new Error('expected a ConfigError');
      expect(shown.message).not.toContain(dir);
      expect(shown.message.endsWith(sentence)).toBe(true);
    }
  });

  it('reads through a link (an intentional dotfiles link is supported, ADR-0063) and treats a dangling one as absent', () => {
    const target = join(dir, 'elsewhere.toml');
    writeFileSync(target, 'update_channel = "beta"\n');
    const link = join(dir, 'link.toml');
    symlinkSync(target, link);
    expect(loadConfigFile(link, GlobalConfigSchema)).toEqual({ update_channel: 'beta' });
    const dangling = join(dir, 'dangling.toml');
    symlinkSync(join(dir, 'missing.toml'), dangling);
    expect(loadConfigFile(dangling, GlobalConfigSchema)).toBeUndefined();
  });

  it.skipIf(!POSIX)('refuses a link loop with the could-not-be-read sentence', () => {
    const a = join(dir, 'a.toml');
    const b = join(dir, 'b.toml');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(() => loadConfigFile(a, GlobalConfigSchema)).toThrow(`${a}: could not be read.`);
  });

  it.skipIf(!POSIX)(
    'refuses a FIFO at the path without waiting for a writer, and reads nothing from it',
    () => {
      const fifo = join(dir, 'fifo.toml');
      execFileSync('mkfifo', [fifo]);
      // A reader and a writer are held open for the test, so that a loader which forgot O_NONBLOCK (the flag test above is what
      // catches that) could not hang the test worker on the open: a blocked synchronous open cannot be timed out.
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const writer = openSync(fifo, constants.O_WRONLY);
      try {
        expect(() => loadConfigFile(fifo, GlobalConfigSchema)).toThrow(
          `${fifo}: is not a regular file.`,
        );
      } finally {
        closeSync(writer);
        closeSync(reader);
      }
    },
  );

  describe('the 0600 self-heal acts on the descriptor', () => {
    it.skipIf(!POSIX)('sets the mode through the descriptor it holds, never by path', () => {
      writeFileSync(file, 'update_channel = "beta"\n');
      chmodSync(file, 0o644);
      vi.mocked(chmodSync).mockClear();
      expect(loadConfigFile(file, GlobalConfigSchema, { selfHealMode: true })).toEqual({
        update_channel: 'beta',
      });
      expect(vi.mocked(fchmodSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(chmodSync)).not.toHaveBeenCalled();
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it.skipIf(!POSIX)(
      'leaves the target of a link alone and does not even try to change it',
      () => {
        const target = join(dir, 'elsewhere.toml');
        writeFileSync(target, 'update_channel = "beta"\n');
        chmodSync(target, 0o644);
        symlinkSync(target, file);
        expect(loadConfigFile(file, GlobalConfigSchema, { selfHealMode: true })).toEqual({
          update_channel: 'beta',
        });
        expect(vi.mocked(fchmodSync)).not.toHaveBeenCalled();
        expect(statSync(target).mode & 0o777).toBe(0o644);
      },
    );
  });
});
