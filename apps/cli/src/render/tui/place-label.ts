import { displayPath, type DisplayPathRoots } from '../notation.js';
import { sanitizeInline } from '../sanitize.js';
import { displayWidth } from './viewport.js';

/**
 * How a screen names a directory ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §8: a path is
 * project-relative or from `~`, never absolute unless it is outside both). One helper for the two places that draw a working directory (the
 * command card's `Runs in:` and the Home strip's session row), so they say the same words for the same place.
 *
 * Pure. {@link placeLabel} shortens and does not sanitise; {@link placeForDisplay} is the one call a surface makes, and runs the three steps
 * in the one order that is safe: shorten, then sanitise, then guard and bound. The order matters in both directions: a control character
 * cut out BEFORE the shortening would let a path that merely looks like the project (`/work/pro<BEL>ject/x`) be shown project-relative, and
 * one cut out AFTER it can leave a `~` at the front (`<BEL>~/x` becomes `~/x`), which a person reads as their home.
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
 * The directory a screen draws for `path`: {@link placeLabel} (shortened FIRST), then `sanitise` (the terminal-safe one-line floor by
 * default; a stored text that could carry a secret passes its scrubbing filter), then the `./` guard, then {@link keepEnd} to `bound`
 * columns (the end of a long path is the part that tells one directory from another).
 *
 * **The guard:** a result that starts with `~` is the home and nothing else. When {@link placeLabel} itself returned it that way (`~/other`,
 * or a path given as `~…`) it is left alone; when it only BECAME `~…` by the sanitiser dropping the characters before it, it is a folder of
 * the project or a forged label and keeps a `./` in front (`./~/x`), as {@link displayPath} writes a folder named `~`.
 */
export function placeForDisplay(
  path: string,
  roots: DisplayPathRoots | undefined,
  bound: number,
  sanitise: (text: string) => string = sanitizeInline,
): string {
  const shown = placeLabel(path, roots);
  const clean = sanitise(shown);
  return keepEnd(clean.startsWith('~') && !shown.startsWith('~') ? `./${clean}` : clean, bound);
}

/** The columns {@link namedProjectRoot} spends besides the folder's name: `. (project root: ` and the closing `)`. */
const NAMED_ROOT_FIXED = '. (project root: )'.length;

/**
 * The project itself in words WITH its folder's name (`. (project root: relavium)`), for a place where "the project root" alone does not
 * tell a person which folder it is: the command card of a resumed chat, whose project is the session's own directory, not the one the person
 * launched from. The name is the last segment of `roots.cwd`, made safe for the terminal and cut at the FRONT so the whole phrase fits `bound`
 * columns; with no usable name, or no room for one, it is {@link PROJECT_ROOT_WORDS}.
 */
export function namedProjectRoot(roots: DisplayPathRoots | undefined, bound: number): string {
  if (roots?.cwd === undefined) return PROJECT_ROOT_WORDS;
  const segments = roots.cwd.split(roots.win32 === true ? /[\\/]+/u : /\/+/u);
  const name = sanitizeInline(segments.findLast((segment) => segment !== '') ?? '').trim();
  const room = bound - NAMED_ROOT_FIXED;
  return name === '' || room < 2 ? PROJECT_ROOT_WORDS : `. (project root: ${keepEnd(name, room)})`;
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
