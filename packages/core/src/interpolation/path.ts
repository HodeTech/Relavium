/**
 * Safe property/index access for an interpolation reference's trailing `path` (1.L2).
 *
 * A reference's head resolves to a run-scope value; its `path` (e.g. `.score`, `.issues[0].line`,
 * `["a-b"]`) then navigates into that value. The navigation is a tiny char scanner — **never `eval`
 * or `new Function`** — that supports dotted property access, numeric array indices, and quoted
 * bracket keys, the shapes the lexer (`references.ts`) emits. A missing hop yields `undefined` (the
 * resolver decides whether that is an error or a `| default(…)` case); a *malformed* path throws a
 * typed {@link InterpolationError} (`invalid_path`).
 */

import { InterpolationError } from '../errors.js';

/** One navigation step: an object property/quoted key (string) or an array index (number). */
type PathStep = { readonly key: string } | { readonly index: number };

const IDENT_CHAR = /[A-Za-z0-9_-]/;
const WHITESPACE = /\s/;
const INTEGER = /^-?\d+$/;

/**
 * Navigate `value` by `path` (verbatim from the lexer, incl. its leading `.`). An empty path returns
 * `value` unchanged; a hop off `undefined`/`null` or a missing property returns `undefined`.
 * @throws {InterpolationError} `invalid_path` when `path` is syntactically malformed.
 */
export function getByPath(value: unknown, path: string, location?: string): unknown {
  let current = value;
  for (const step of parsePath(path, location)) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = stepInto(current, step);
  }
  return current;
}

function stepInto(current: unknown, step: PathStep): unknown {
  if ('index' in step) {
    return Array.isArray(current) ? (current as readonly unknown[])[step.index] : undefined;
  }
  // A plain object's OWN property only — arrays expose just numeric indices here, and an own-property
  // guard keeps a missing key returning `undefined` instead of reaching an inherited prototype member
  // (`.toString`, `.constructor`, `.__proto__`), which would both break the contract and be unsafe.
  if (typeof current === 'object' && !Array.isArray(current)) {
    return Object.prototype.hasOwnProperty.call(current, step.key)
      ? (current as Record<string, unknown>)[step.key]
      : undefined;
  }
  return undefined;
}

function parsePath(path: string, location: string | undefined): PathStep[] {
  const steps: PathStep[] = [];
  let i = 0;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i = readDotProp(path, i + 1, steps, location);
    } else if (ch === '[') {
      i = readBracket(path, i, steps, location);
    } else {
      throw invalidPath(path, location);
    }
  }
  return steps;
}

/** Read a `.name` property starting just past the dot; returns the next index. */
function readDotProp(
  path: string,
  from: number,
  steps: PathStep[],
  location: string | undefined,
): number {
  let i = from;
  let name = '';
  while (i < path.length && IDENT_CHAR.test(path[i] as string)) {
    name += path[i];
    i += 1;
  }
  if (name === '') {
    throw invalidPath(path, location);
  }
  steps.push({ key: name });
  return i;
}

/** Read a `[…]` access (numeric index or quoted key) starting at the `[`; returns the next index. */
function readBracket(
  path: string,
  from: number,
  steps: PathStep[],
  location: string | undefined,
): number {
  let i = from + 1;
  while (i < path.length && WHITESPACE.test(path[i] as string)) {
    i += 1;
  }
  const opener = path[i];
  // A quoted key: scan to the matching closing quote so a `]` *inside* the key (e.g. `["weird]key"]`)
  // does not prematurely end the bracket — `indexOf(']')` cannot do that.
  if (opener === '"' || opener === "'") {
    i += 1;
    let key = '';
    while (i < path.length && path[i] !== opener) {
      key += path[i];
      i += 1;
    }
    if (path[i] !== opener) {
      throw invalidPath(path, location); // unterminated quote
    }
    i += 1; // past the closing quote
    while (i < path.length && WHITESPACE.test(path[i] as string)) {
      i += 1;
    }
    if (path[i] !== ']') {
      throw invalidPath(path, location);
    }
    steps.push({ key });
    return i + 1;
  }
  // A numeric index: the first `]` closes it (a number has no quotes/brackets inside).
  const close = path.indexOf(']', from);
  if (close === -1) {
    throw invalidPath(path, location);
  }
  const inner = path.slice(from + 1, close).trim();
  if (INTEGER.test(inner)) {
    steps.push({ index: Number(inner) });
    return close + 1;
  }
  throw invalidPath(path, location);
}

function invalidPath(path: string, location: string | undefined): InterpolationError {
  return new InterpolationError('invalid_path', `invalid property access \`${path}\``, {
    ...(location === undefined ? {} : { location }),
  });
}
