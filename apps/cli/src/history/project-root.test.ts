/**
 * The ONE directory identity of a workflow run (MVP-11 unit 7, round 2): the canonical root a run records, and the only match a reader
 * makes against it. A Home opened with `--cwd .` in another directory listed, offered `r` for and ANSWERED the gates of every run recorded
 * as `.` anywhere, because the root was the typed cwd compared as text; a trailing slash or a case variant hid a person's own runs. These
 * claims pin the boundary: the canonical root is the very pin a filesystem policy takes as its workspace (one canonicaliser, not two), a
 * relative or empty stored root is unrecorded, and exact equality of two absolute texts is the only "here".
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFsPathPolicy, fsPolicyWorkspace } from '../engine/tool-host/fs-policy.js';
import { isProjectRootHere, projectRootOf, recordedProjectRoot } from './project-root.js';

let base: string;
let work: string;
let link: string;
let deepLink: string;
let file: string;

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'relavium-project-root-')));
  work = join(base, 'work');
  mkdirSync(work);
  const deep = join(base, 'deep', 'target');
  mkdirSync(deep, { recursive: true });
  link = join(base, 'link');
  symlinkSync(work, link, 'junction');
  deepLink = join(base, 'deep-link');
  symlinkSync(deep, deepLink, 'junction');
  file = join(base, 'a-file');
  writeFileSync(file, 'not a directory');
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** What a filesystem policy over `path` pins as its workspace: the value a chat records and the Home lists sessions by. */
const pinned = (path: string): string =>
  fsPolicyWorkspace(createFsPathPolicy({ workspaceDir: path }));

describe('the root a run records is the canonical spelling of its directory', () => {
  it('is the very pin a filesystem policy takes as its workspace, for every spelling of one directory', () => {
    const spellings = [
      work,
      `${work}${sep}`,
      link,
      `${link}${sep}`,
      join(work, 'missing-child', '..'),
      relative(process.cwd(), work),
      relative(process.cwd(), link),
    ];
    for (const spelling of spellings) {
      expect(projectRootOf(spelling), spelling).toBe(work);
      expect(projectRootOf(spelling), `${spelling}: one canonicaliser, not two`).toBe(
        pinned(spelling),
      );
    }
  });

  it('reads `.` as the process’s own directory, canonical', () => {
    expect(projectRootOf('.')).toBe(realpathSync.native(process.cwd()));
  });

  it('folds `..` as text before the realpath, exactly as the policy’s pin does (not the link target’s parent)', () => {
    const spelling = join(deepLink, '..');
    expect(projectRootOf(spelling)).toBe(base);
    expect(projectRootOf(spelling)).toBe(pinned(spelling));
  });

  it('is the on-disk case of a case variant, on a case-insensitive volume', (ctx) => {
    const variant = join(base, 'WORK');
    if (!existsSync(variant)) ctx.skip();
    expect(projectRootOf(variant)).toBe(work);
    expect(projectRootOf(variant)).toBe(pinned(variant));
  });

  it('is the resolved absolute path of a directory that cannot be pinned, never a relative spelling', () => {
    const gone = join(base, 'gone');
    expect(projectRootOf(gone)).toBe(gone);
    expect(projectRootOf(relative(process.cwd(), gone))).toBe(gone);
    expect(projectRootOf(`${gone}${sep}`)).toBe(gone);
    expect(projectRootOf(file), 'a file is not a directory: it is not pinned').toBe(file);
    expect(() => pinned(gone), 'the policy refuses the same path').toThrow();
  });

  it('reads the empty text as the process’s directory, as `resolve` does (argv refuses an empty `--cwd` before this)', () => {
    expect(projectRootOf('')).toBe(realpathSync.native(process.cwd()));
    expect(isAbsolute(projectRootOf(''))).toBe(true);
  });
});

describe('a stored root that is not an absolute path is unrecorded', () => {
  it.each([
    ['.', '.'],
    ['a relative directory', 'work'],
    ['a relative directory with a slash', 'work/'],
    ['a parent spelling', '..'],
    ['a dotted relative path', './work'],
    ['the empty text', ''],
  ])('%s is unrecorded', (_name, stored) => {
    expect(recordedProjectRoot(stored)).toBeUndefined();
  });

  it('none (null, absent) is unrecorded, and an absolute root is itself, as stored', () => {
    expect(recordedProjectRoot(null)).toBeUndefined();
    expect(recordedProjectRoot(undefined)).toBeUndefined();
    expect(recordedProjectRoot(work)).toBe(work);
    expect(recordedProjectRoot(`${work}${sep}`), 'kept as stored: not "fixed"').toBe(
      `${work}${sep}`,
    );
  });
});

describe('the only match is an absolute recorded root equal, as text, to an absolute directory of the reader', () => {
  it('matches the canonical root and nothing else of the same directory', () => {
    expect(isProjectRootHere(work, work)).toBe(true);
    expect(isProjectRootHere(`${work}${sep}`, work), 'a trailing slash is another spelling').toBe(
      false,
    );
    expect(isProjectRootHere(link, work), 'a symlink is another spelling').toBe(false);
    expect(isProjectRootHere(join(base, 'WORK'), work), 'a case variant is another spelling').toBe(
      false,
    );
  });

  it('never matches a relative or empty text, on either side, even against itself', () => {
    expect(isProjectRootHere('.', '.')).toBe(false);
    expect(isProjectRootHere('work', 'work')).toBe(false);
    expect(isProjectRootHere('', '')).toBe(false);
    expect(isProjectRootHere(null, work)).toBe(false);
    expect(isProjectRootHere(undefined, work)).toBe(false);
    expect(isProjectRootHere(work, undefined), 'a reader that knows no directory').toBe(false);
    expect(isProjectRootHere(work, '.'), 'a reader handed a relative directory').toBe(false);
  });

  it('is exactly `absolute(stored) && stored === here` over every pair of a pool of spellings', () => {
    const pool: readonly (string | null | undefined)[] = [
      work,
      `${work}${sep}`,
      link,
      base,
      join(base, 'WORK'),
      `${work}${sep}x${sep}..`,
      '.',
      './',
      'work',
      '',
      null,
      undefined,
    ];
    let matches = 0;
    for (const stored of pool)
      for (const here of pool) {
        const expected =
          typeof stored === 'string' && stored !== '' && isAbsolute(stored) && stored === here;
        if (expected) matches += 1;
        expect(isProjectRootHere(stored, here ?? undefined), `${stored} vs ${here}`).toBe(expected);
      }
    // Six absolute spellings (an unnormalised one among them), each matching itself only.
    expect(matches).toBe(6);
  });

  it('matches across any two spellings once both sides are the canonical root (what is recorded, what the Home holds)', () => {
    const recorded = projectRootOf(`${link}${sep}`);
    for (const homeSpelling of [work, `${work}${sep}`, link, relative(process.cwd(), work)])
      expect(isProjectRootHere(recorded, pinned(homeSpelling)), homeSpelling).toBe(true);
    expect(isProjectRootHere(projectRootOf(join(base, 'deep', 'target')), pinned(work))).toBe(
      false,
    );
    expect(resolve(recorded)).toBe(recorded);
  });
});
