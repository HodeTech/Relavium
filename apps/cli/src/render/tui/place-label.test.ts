import { describe, expect, it } from 'vitest';

import { keepEnd, placeLabel, PROJECT_ROOT_WORDS } from './place-label.js';
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
