/**
 * `readAuthoredFile` opens a file once and asks the DESCRIPTOR every later question (security sitting on increment 6, finding A1). A
 * `stat` then a `readFileSync`, both by path, let a same-directory owner rename a FIFO over the file between them; the read then blocks
 * with no deadline and freezes the one event loop of the Home (Ctrl+C included). The refusal sentences are the command's own, and the
 * whole of `import`, `export` and `create` keeps its output byte for byte (`commands/import-characterisation.test.ts` is the proof).
 *
 * The race itself cannot be driven from a test, so it is simulated where it bites: the by-path `statSync` is made to say "a regular
 * file" about a FIFO (as it would have, a moment before the swap). Code that trusts that answer and reads by path blocks on the FIFO;
 * here a writer child bounds that wait to a second, so the old code fails the assertion (it returns instead of refusing) and never
 * hangs the run. Code that asks the descriptor refuses at once.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SOURCE_CHARS } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { readAuthoredFile } from './authoring.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    fstatSync: vi.fn(actual.fstatSync),
    readFileSync: vi.fn(actual.readFileSync),
  };
});

const CEILING = MAX_SOURCE_CHARS * 4;

/** Whether a FIFO can be made here (POSIX with `mkfifo`): the FIFO cases are skipped, with that reason, where it cannot. */
const canMakeFifo = ((): boolean => {
  const probe = fs.mkdtempSync(join(tmpdir(), 'relavium-fifo-probe-'));
  try {
    execFileSync('mkfifo', [join(probe, 'f')], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

let dir = '';
let writer: ChildProcess | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'relavium-read-authored-'));
  // A reset puts back the real implementation each spy wraps, so a lie one case told never reaches the next.
  vi.mocked(fs.statSync).mockReset();
  vi.mocked(fs.fstatSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
});
afterEach(() => {
  writer?.kill('SIGKILL');
  writer = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The refusal `readAuthoredFile` raises for `path`, or `undefined` if it returned. */
function refusal(path: string, shown = 'x.yaml'): string | undefined {
  try {
    readAuthoredFile(path, shown);
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    expect(cause.code).toBe('invalid_invocation');
    expect(cause.exitCode).toBe(2);
    return cause.message;
  }
}

describe('a file is read through the descriptor it was opened as', () => {
  it('reads a regular file with one open and no by-path stat or read', () => {
    const path = join(dir, 'a.yaml');
    fs.writeFileSync(path, 'id: a\n');
    expect(readAuthoredFile(path, 'a.yaml')).toBe('id: a\n');
    expect(vi.mocked(fs.fstatSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.statSync), 'nothing is asked of the path again').not.toHaveBeenCalled();
    expect(vi.mocked(fs.readFileSync), 'nothing is read by path').not.toHaveBeenCalled();
  });

  it('reads the bytes as UTF-8, a byte-order mark and an empty file included, as readFileSync did', () => {
    const path = join(dir, 'a.yaml');
    fs.writeFileSync(path, '﻿id: ağ日本\n');
    expect(readAuthoredFile(path, 'a.yaml')).toBe('﻿id: ağ日本\n');
    fs.writeFileSync(path, '');
    expect(readAuthoredFile(path, 'a.yaml')).toBe('');
    // A file longer than one chunk is read whole.
    const long = `# ${'x'.repeat(200_000)}\n`;
    fs.writeFileSync(path, long);
    expect(readAuthoredFile(path, 'a.yaml')).toBe(long);
  });

  it('still follows a symbolic link to a regular file, as it always did', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(join(dir, 'real.yaml'), 'id: linked\n');
    fs.symlinkSync(join(dir, 'real.yaml'), join(dir, 'link.yaml'));
    expect(readAuthoredFile(join(dir, 'link.yaml'), 'link.yaml')).toBe('id: linked\n');
  });

  it('a link to a directory, and a link to nothing, are refused in the same words as before', () => {
    if (process.platform === 'win32') return;
    fs.mkdirSync(join(dir, 'd'));
    fs.symlinkSync(join(dir, 'd'), join(dir, 'to-dir'));
    fs.symlinkSync(join(dir, 'gone'), join(dir, 'dangling'));
    expect(refusal(join(dir, 'to-dir'), 'to-dir')).toBe('to-dir is not a regular file');
    expect(refusal(join(dir, 'dangling'), 'dangling')).toBe('no file at dangling');
  });

  it('refuses a file over the byte ceiling by its size, and one that grew past it while it was read', async () => {
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const path = join(dir, 'huge.yaml');
    fs.writeFileSync(path, 'x');
    fs.truncateSync(path, CEILING + 1);
    expect(refusal(path, 'huge.yaml')).toBe('huge.yaml exceeds the size limit');
    // The descriptor says it is small; the bytes say otherwise. The read is bounded by the ceiling, not by what was said.
    vi.mocked(fs.fstatSync).mockImplementationOnce((fd) =>
      Object.assign(real.fstatSync(fd), { size: 10 }),
    );
    expect(refusal(path, 'huge.yaml')).toBe('huge.yaml exceeds the size limit');
  });

  it('a file exactly at the ceiling is read, and one byte more is not', () => {
    const path = join(dir, 'edge.yaml');
    fs.writeFileSync(path, 'x');
    fs.truncateSync(path, CEILING);
    expect(readAuthoredFile(path, 'edge.yaml').length).toBe(CEILING);
    fs.truncateSync(path, CEILING + 1);
    expect(refusal(path, 'edge.yaml')).toBe('edge.yaml exceeds the size limit');
  });
});

describe('the words of a refusal are the ones the by-path code used', () => {
  it('a missing file, a directory, a directory or a file it may not open', () => {
    expect(refusal(join(dir, 'nope.yaml'), 'nope.yaml')).toBe('no file at nope.yaml');
    fs.mkdirSync(join(dir, 'a-dir'));
    expect(refusal(join(dir, 'a-dir'), 'a-dir')).toBe('a-dir is not a regular file');
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    fs.mkdirSync(join(dir, 'locked-dir'));
    fs.chmodSync(join(dir, 'locked-dir'), 0o000);
    fs.writeFileSync(join(dir, 'locked.yaml'), 'id: a\n');
    fs.chmodSync(join(dir, 'locked.yaml'), 0o000);
    fs.writeFileSync(join(dir, 'locked-huge.yaml'), 'x');
    fs.truncateSync(join(dir, 'locked-huge.yaml'), CEILING + 1);
    fs.chmodSync(join(dir, 'locked-huge.yaml'), 0o000);
    expect(refusal(join(dir, 'locked-dir'), 'locked-dir')).toBe('locked-dir is not a regular file');
    expect(refusal(join(dir, 'locked.yaml'), 'locked.yaml')).toBe('could not read locked.yaml');
    expect(refusal(join(dir, 'locked-huge.yaml'), 'locked-huge.yaml')).toBe(
      'locked-huge.yaml exceeds the size limit',
    );
    fs.chmodSync(join(dir, 'locked-dir'), 0o700);
  });
});

describe.skipIf(!canMakeFifo)(
  'a FIFO is refused, and never waited for (POSIX only: it needs mkfifo)',
  () => {
    /** A FIFO at `name`, and a child that holds its write end for a second: a reader that opens it BLOCKING is held until it is gone. */
    function fifoWithWriter(name: string): string {
      const path = join(dir, name);
      execFileSync('mkfifo', [path]);
      writer = spawn('sh', ['-c', 'exec 3>"$1"; sleep 1', 'sh', path], { stdio: 'ignore' });
      return path;
    }

    it('a FIFO at the path is refused as not a regular file', { timeout: 4000 }, () => {
      const path = fifoWithWriter('pipe.yaml');
      expect(refusal(path, 'pipe.yaml')).toBe('pipe.yaml is not a regular file');
    });

    it(
      'a FIFO swapped in after the file was looked at by path is still refused at once, not read',
      { timeout: 4000 },
      async () => {
        const path = fifoWithWriter('swapped.yaml');
        // What a by-path `stat` said a moment before the rename: a regular file.
        const regular = join(dir, 'was-regular.yaml');
        fs.writeFileSync(regular, 'id: a\n');
        const real = await vi.importActual<typeof import('node:fs')>('node:fs');
        vi.mocked(fs.statSync).mockImplementation(() => real.statSync(regular));
        expect(refusal(path, 'swapped.yaml')).toBe('swapped.yaml is not a regular file');
        expect(
          vi.mocked(fs.readFileSync),
          'the FIFO was never read by path',
        ).not.toHaveBeenCalled();
      },
    );
  },
);
