import { describe, expect, it } from 'vitest';

import { displayPathHere, displayRoots } from './display-roots.js';

describe('displayRoots: the one place the platform is read', () => {
  it('reads the paths as Windows paths only on a win32 platform', () => {
    expect(displayRoots('C:\\work', 'C:\\Users\\ada', 'win32').win32).toBe(true);
    for (const platform of ['linux', 'darwin', 'freebsd', 'aix', 'android'] as const) {
      expect(displayRoots('/work', '/home/ada', platform).win32, platform).toBe(false);
    }
  });

  it('carries the project and the home as they are, and defaults to the machine it runs on', () => {
    expect(displayRoots('/work', '/home/ada', 'linux')).toEqual({
      cwd: '/work',
      home: '/home/ada',
      win32: false,
    });
    expect(displayRoots(undefined, undefined, 'win32')).toEqual({
      cwd: undefined,
      home: undefined,
      win32: true,
    });
    expect(displayRoots('/work', '/home/ada').win32).toBe(process.platform === 'win32');
  });
});

describe('displayPathHere: a path against this machine’s roots', () => {
  it('shortens as a POSIX path on a POSIX platform, and as a Windows path (any case, either separator) on win32', () => {
    expect(displayPathHere('/work/app/src/a.ts', '/work/app', '/home/ada', 'linux')).toBe(
      'src/a.ts',
    );
    expect(displayPathHere('/home/ada/notes', '/work/app', '/home/ada', 'darwin')).toBe('~/notes');
    // the same two paths mean something else on a platform that compares names ignoring case
    expect(displayPathHere('/WORK/APP/src/a.ts', '/work/app', '/home/ada', 'linux')).toBe(
      '/WORK/APP/src/a.ts',
    );
    expect(
      displayPathHere('C:\\WORK\\app\\src\\a.ts', 'c:\\work\\app', 'C:\\Users\\ada', 'win32'),
    ).toBe('src\\a.ts');
    // a backslash is a name on POSIX, and a separator on win32
    expect(displayPathHere('/work/app/a\\b', '/work/app', undefined, 'linux')).toBe('a\\b');
    expect(displayPathHere('C:\\work\\app\\a\\b', 'C:\\work\\app', undefined, 'win32')).toBe(
      'a\\b',
    );
  });
});
