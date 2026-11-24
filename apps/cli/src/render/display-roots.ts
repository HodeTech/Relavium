import { displayPath, type DisplayPathRoots } from './notation.js';

/**
 * The roots a path is shortened against on this machine: the project directory, the operator's home, and whether the paths are
 * Windows paths. `notation.ts` is a pure data module and reads no process state, so the one place that reads the platform is here;
 * a surface builds its roots once and calls {@link displayPath} with them.
 */
export function displayRoots(cwd: string | undefined, home: string | undefined): DisplayPathRoots {
  return { cwd, home, win32: process.platform === 'win32' };
}

/** `path` for a human line against this machine's roots: project-relative, from `~`, or whole (see {@link displayPath}). */
export function displayPathHere(
  path: string,
  cwd: string | undefined,
  home: string | undefined,
): string {
  return displayPath(path, displayRoots(cwd, home));
}
