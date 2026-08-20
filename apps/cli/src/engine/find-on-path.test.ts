/**
 * The shared `PATH` walk
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3).
 *
 * It backs two things now — `run_command`'s executable resolution and the consent fingerprint — and its one
 * genuine subtlety, the Windows `PATHEXT` ordering, ran on no CI leg at all: every unit-suite runner is
 * Linux, and the function read `process.platform` directly, so the branch was unreachable from a test on any
 * machine that could execute one. The lookup environment is injected now, which is what makes these
 * assertions possible rather than aspirational.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { candidateExtensions, findOnPath, type PathLookupEnv } from './find-on-path.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relavium-path-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const posix = (path: string): PathLookupEnv => ({ path, platform: 'linux', pathExt: '' });
const windows = (path: string, pathExt = '.EXE;.CMD;.BAT;.COM'): PathLookupEnv => ({
  path,
  platform: 'win32',
  pathExt,
});

describe('candidateExtensions', () => {
  it('tries exactly one empty suffix on POSIX', () => {
    expect(candidateExtensions('node', posix(''))).toEqual(['']);
  });

  it('tries each PATHEXT on Windows', () => {
    expect(candidateExtensions('node', windows('', '.EXE;.CMD'))).toEqual(['.EXE', '.CMD']);
  });

  it('tries the BARE name FIRST when the command already carries a recognized extension', () => {
    // Otherwise every candidate would be `node.exe.EXE` and the real binary would never be found. The
    // comparison is case-insensitive because Windows path extensions are.
    expect(candidateExtensions('node.exe', windows('', '.EXE;.CMD'))).toEqual(['', '.EXE', '.CMD']);
    expect(candidateExtensions('NODE.EXE', windows('', '.exe'))).toEqual(['', '.exe']);
  });

  it('ignores an empty PATHEXT entry rather than trying a bare name twice', () => {
    expect(candidateExtensions('node', windows('', '.EXE;;.CMD'))).toEqual(['.EXE', '.CMD']);
  });
});

describe('findOnPath', () => {
  it('finds an executable file and returns its absolute path', async () => {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(findOnPath('tool', posix(dir))).resolves.toBe(join(dir, 'tool'));
  });

  it('skips a DIRECTORY that shares the command name and keeps searching', async () => {
    // A directory carries the traversal bit on POSIX, so `access(X_OK)` alone answered "found" for one —
    // and on Windows `X_OK` is a documented no-op, so it answered "found" for anything that exists. This
    // result backs a consent fingerprint now, where "found" must mean a file.
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(join(first, 'tool')); // a directory named like the command
    writeFileSync(join(second, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(findOnPath('tool', posix([first, second].join(delimiter)))).resolves.toBe(
      join(second, 'tool'),
    );
  });

  it('skips a file with no execute bit', async () => {
    writeFileSync(join(dir, 'tool'), 'not executable', { mode: 0o644 });
    const found = await findOnPath('tool', posix(dir));
    // Root ignores the permission bits, so the assertion is only meaningful for an ordinary user.
    if (process.getuid?.() !== 0) expect(found).toBeUndefined();
  });

  it('returns undefined when nothing matches, rather than throwing', async () => {
    await expect(findOnPath('definitely-not-here-xyz', posix(dir))).resolves.toBeUndefined();
  });

  it('ignores an empty PATH segment', async () => {
    writeFileSync(join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(findOnPath('tool', posix(`${delimiter}${dir}${delimiter}`))).resolves.toBe(
      join(dir, 'tool'),
    );
  });

  it('honours PATH ORDER — the first directory wins', async () => {
    const first = join(dir, 'a');
    const second = join(dir, 'b');
    mkdirSync(first);
    mkdirSync(second);
    for (const at of [first, second])
      writeFileSync(join(at, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(findOnPath('tool', posix([first, second].join(delimiter)))).resolves.toBe(
      join(first, 'tool'),
    );
  });

  it('applies PATHEXT on the Windows branch, on any host', async () => {
    // The branch that ran on no CI leg. The file is real; only the platform signal is injected, so this
    // exercises the actual candidate construction rather than a stub of it.
    writeFileSync(join(dir, 'tool.CMD'), 'echo hi\n', { mode: 0o755 });
    await expect(findOnPath('tool', windows(dir, '.EXE;.CMD'))).resolves.toBe(
      join(dir, 'tool.CMD'),
    );
  });

  it('finds a Windows command already carrying its extension, via the bare-name-first rule', async () => {
    writeFileSync(join(dir, 'tool.exe'), 'binary\n', { mode: 0o755 });
    await expect(findOnPath('tool.exe', windows(dir, '.EXE;.CMD'))).resolves.toBe(
      join(dir, 'tool.exe'),
    );
  });
});
