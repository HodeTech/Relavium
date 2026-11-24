import { displayPath, type DisplayPathRoots } from '../notation.js';
import { displayWidth } from './viewport.js';

/**
 * How a screen names a directory ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8: a path is
 * project-relative or from `~`, never absolute unless it is outside both). One helper for the two places that draw a working directory (the
 * command card's `Runs in:` and the Home strip's session row), so they say the same words for the same place.
 *
 * Pure. It shortens and bounds; it does not sanitise (the caller sends the result through `sanitizeInline`, AFTER the shortening and BEFORE
 * the bound it applies to the screen, as {@link displayPath} says).
 */

/** What the project directory itself is called: `.` alone would read as a stray dot. */
export const PROJECT_ROOT_WORDS = '. (project root)';

/**
 * `path` as a person reads it, or as it was given when no `roots` are known: project-relative (`packages/app`), from `~` (`~/work/other`),
 * and the project itself in words ({@link PROJECT_ROOT_WORDS}). A path outside the project and the home stays whole and absolute: it cannot
 * be shortened without hiding where it is.
 */
export function placeLabel(path: string, roots: DisplayPathRoots | undefined): string {
  if (roots === undefined) return path;
  const shown = displayPath(path, roots);
  return shown === '.' ? PROJECT_ROOT_WORDS : shown;
}

/**
 * `text` cut to `width` display columns from the FRONT, keeping its end: the part of a path that tells one directory from another (`…/app`).
 * A text that fits is returned as it is.
 */
export function keepEnd(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  const kept: string[] = [];
  let used = 1; // the ellipsis
  for (const char of [...text].reverse()) {
    const next = displayWidth(char);
    if (used + next > width) break;
    kept.unshift(char);
    used += next;
  }
  return `…${kept.join('')}`;
}
