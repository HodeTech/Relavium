import { describe, expect, it } from 'vitest';

import {
  keepEnd,
  namedProjectRoot,
  placeForDisplay,
  placeLabel,
  PROJECT_ROOT_WORDS,
} from './place-label.js';
import { displayWidth } from './viewport.js';

/**
 * How a screen names a directory ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8): project-relative, from
 * `~`, the project itself in words, and whole where it is outside both. The command card's `Runs in:` and the Home strip's session row call it.
 */
const ROOTS = { cwd: '/work/project', home: '/home/me' } as const;

describe('placeLabel', () => {
  it('names the project itself in words, never as a bare dot', () => {
    expect(placeLabel('/work/project', ROOTS)).toBe(PROJECT_ROOT_WORDS);
    expect(PROJECT_ROOT_WORDS).toBe('. (project root)');
    expect(placeLabel('/work/project/', ROOTS)).toBe(PROJECT_ROOT_WORDS);
  });

  it('names a directory inside the project from the project, with no leading ./', () => {
    expect(placeLabel('/work/project/packages/app', ROOTS)).toBe('packages/app');
  });

  it('names a directory inside the home (and outside the project) from ~', () => {
    expect(placeLabel('/home/me/other', ROOTS)).toBe('~/other');
    expect(placeLabel('/home/me', ROOTS)).toBe('~');
  });

  it('keeps a directory outside both whole and absolute: it cannot be shortened without hiding where it is', () => {
    expect(placeLabel('/opt/shared/tools', ROOTS)).toBe('/opt/shared/tools');
    // a sibling that only shares a prefix with the project is not inside it
    expect(placeLabel('/work/project-two/app', ROOTS)).toBe('/work/project-two/app');
  });

  it('prefers the project over the home when the project is inside the home', () => {
    const nested = { cwd: '/home/me/code/relavium', home: '/home/me' };
    expect(placeLabel('/home/me/code/relavium/apps/cli', nested)).toBe('apps/cli');
    expect(placeLabel('/home/me/code/other', nested)).toBe('~/code/other');
  });

  it('draws the path as it was given when no roots are known', () => {
    expect(placeLabel('/work/project/packages/app', undefined)).toBe('/work/project/packages/app');
    expect(placeLabel('', undefined)).toBe('');
    // Not even a leading `./` is taken off: with no roots nothing is known about where the path is.
    expect(placeLabel('./x', undefined)).toBe('./x');
  });

  it('reads a Windows path as one, keeping the separator it used', () => {
    const win = { cwd: 'C:\\work\\project', home: 'C:\\Users\\me', win32: true };
    expect(placeLabel('c:\\WORK\\project\\src', win)).toBe('src');
    expect(placeLabel('C:\\Users\\me\\notes', win)).toBe('~\\notes');
    expect(placeLabel('D:\\data', win)).toBe('D:\\data');
    expect(placeLabel('C:\\work\\project', win)).toBe(PROJECT_ROOT_WORDS);
  });

  it('does not take a folder named ~ inside the project for the home', () => {
    expect(placeLabel('/work/project/~/x', ROOTS)).toBe('./~/x');
  });
});

describe('placeForDisplay', () => {
  it('shortens first, then makes the text safe: the order that does not forge a place', () => {
    // Cleaned first, `/work/pro<BEL>ject/x` would be shortened to `x` and read as a place inside the project.
    expect(placeForDisplay('/work/pro\u0007ject/x', ROOTS, 80)).toBe('/work/project/x');
    expect(placeForDisplay('/work/project/a\u001b[31mb', ROOTS, 80)).toBe('ab');
  });

  it.each([
    ['BEL', '\u0007'],
    ['an SGR reset', '\u001b[0m'],
    ['NUL', '\u0000'],
    ['a right-to-left override', '\u202e'],
    ['a left-to-right mark', '\u200e'],
  ])('keeps a `./` in front of a `~` that only appeared when %s was taken out', (_name, junk) => {
    expect(placeForDisplay(`/work/project/${junk}~/x`, ROOTS, 80)).toBe('./~/x');
    // The same with no roots: the text as given, cleaned, is not the home either.
    expect(placeForDisplay(`${junk}~/x`, undefined, 80)).toBe('./~/x');
  });

  it('leaves the home form alone when placeLabel itself returned it', () => {
    expect(placeForDisplay('/home/me/other', ROOTS, 80)).toBe('~/other');
    expect(placeForDisplay('/home/me', ROOTS, 80)).toBe('~');
    expect(placeForDisplay('/work/project/~/x', ROOTS, 80)).toBe('./~/x');
    // A path given as `~…` was already written from the home; with no roots it stays as it was.
    expect(placeForDisplay('~/notes', undefined, 80)).toBe('~/notes');
  });

  it('cuts at the front to the bound, after the guard, and uses the sanitiser it is given', () => {
    const cut = placeForDisplay(`/opt/${'long-directory/'.repeat(8)}end`, ROOTS, 20);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('end')).toBe(true);
    expect(displayWidth(cut)).toBeLessThanOrEqual(20);
    // The guard's two characters count toward the bound: `~/x` fits 4 columns, `./~/x` does not, and the row is never wider than its bound.
    expect(displayWidth(placeForDisplay('/work/project/\u0007~/x', ROOTS, 4))).toBeLessThanOrEqual(
      4,
    );
    expect(placeForDisplay('/work/project/\u0007~/x', ROOTS, 5)).toBe('./~/x');
    expect(placeForDisplay('/work/project/a/b', ROOTS, 80, (text) => text.toUpperCase())).toBe(
      'A/B',
    );
  });
});

describe('namedProjectRoot', () => {
  it('names the folder of the project root inside the words', () => {
    expect(namedProjectRoot(ROOTS, 60)).toBe('. (project root: project)');
    expect(namedProjectRoot({ cwd: '/work/project/', home: '/home/me' }, 60)).toBe(
      '. (project root: project)',
    );
    expect(namedProjectRoot({ cwd: 'C:\\work\\app', home: undefined, win32: true }, 60)).toBe(
      '. (project root: app)',
    );
  });

  it('makes the name safe for the terminal and cuts it at the front to fit the bound', () => {
    expect(namedProjectRoot({ cwd: '/work/pro\u0007je\u001b[31mct', home: undefined }, 60)).toBe(
      '. (project root: project)',
    );
    const phrase = namedProjectRoot(
      { cwd: '/work/abcdefghijklmnopqrstuvwxyz', home: undefined },
      28,
    );
    expect(phrase).toBe('. (project root: …rstuvwxyz)');
    expect(displayWidth(phrase)).toBeLessThanOrEqual(28);
  });

  it('is the plain words with no roots, no name, or no room for a name', () => {
    expect(namedProjectRoot(undefined, 60)).toBe(PROJECT_ROOT_WORDS);
    expect(namedProjectRoot({ cwd: undefined, home: '/home/me' }, 60)).toBe(PROJECT_ROOT_WORDS);
    expect(namedProjectRoot({ cwd: '/', home: '/home/me' }, 60)).toBe(PROJECT_ROOT_WORDS);
    expect(namedProjectRoot(ROOTS, 19)).toBe(PROJECT_ROOT_WORDS);
    expect(namedProjectRoot(ROOTS, 20)).toBe('. (project root: …t)');
  });
});

describe('keepEnd', () => {
  it('returns a text that fits as it is', () => {
    expect(keepEnd('packages/app', 20)).toBe('packages/app');
    expect(keepEnd('packages/app', 12)).toBe('packages/app');
  });

  it('cuts at the FRONT with an ellipsis, so the end that tells one directory from another stays, and never exceeds the width', () => {
    const long = '/very/long/path/that/goes/on/and/on/to/the/directory/that/matters';
    for (const width of [8, 20, 40]) {
      const cut = keepEnd(long, width);
      expect(cut.startsWith('…')).toBe(true);
      expect(cut.endsWith('matters'), cut).toBe(true);
      if (width >= 30) expect(cut.endsWith('directory/that/matters'), cut).toBe(true);
      expect(displayWidth(cut)).toBeLessThanOrEqual(width);
    }
  });

  it('counts a wide character as two columns', () => {
    const cut = keepEnd('/dir/日本語日本語日本語', 9);
    expect(displayWidth(cut)).toBeLessThanOrEqual(9);
    expect(cut.startsWith('…')).toBe(true);
  });
});
