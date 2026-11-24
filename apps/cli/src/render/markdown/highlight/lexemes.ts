import { BACKSLASH, escapeEnd, isBlank, isDigit, isIdentPart } from './chars.js';
import type { Segments } from './segments.js';
import type { SyntaxToken } from '../types.js';

/** How one kind of string literal is written. */
export interface StringRule {
  readonly open: string;
  /** The closing delimiter, when it is not the opening one (`@"…"`). */
  readonly close?: string;
  /** May the literal run past a newline? A literal that may not ends, unterminated, at the line's end. */
  readonly multiline: boolean;
  /** Does a backslash take the next character with it? */
  readonly escapes: boolean;
  /** Are `${ … }` holes code, not string (a JavaScript template literal)? */
  readonly interpolation?: boolean;
  /** The class of the literal when it is not a string: a quoted identifier is a property. */
  readonly token?: SyntaxToken;
}

/**
 * The end of the literal that starts at `start`: just past its closing delimiter, or the end of the line (or of the
 * text, for a multiline literal) when it is never closed. One pass; every character is read once.
 */
export function scanQuoted(source: string, start: number, rule: StringRule): number {
  const close = rule.close ?? rule.open;
  const closeCode = close.charCodeAt(0);
  const length = source.length;
  let at = start + rule.open.length;
  while (at < length) {
    const code = source.charCodeAt(at);
    if (rule.escapes && code === BACKSLASH) at = escapeEnd(source, at);
    else if (!rule.multiline && code === 10) return at;
    else if (code === closeCode && source.startsWith(close, at)) return at + close.length;
    else at += 1;
  }
  return length;
}

/**
 * The end of the number that starts at `start`: digits, letters and `_` (hex digits, suffixes, units), one `.` between
 * digits, and the sign of an exponent. A lexical guess, not a grammar: it only decides what colour the characters get.
 */
export function scanNumber(source: string, start: number, quotes = false): number {
  const length = source.length;
  const hex =
    source.charCodeAt(start) === 48 && (source[start + 1] === 'x' || source[start + 1] === 'X');
  let at = start;
  while (at < length) {
    const code = source.charCodeAt(at);
    const next = source.charCodeAt(at + 1);
    if (isIdentPart(code)) at += 1;
    else if (code === 46 && isDigit(next)) at += 1;
    else if (quotes && code === 39 && isIdentPart(next) && isIdentPart(source.charCodeAt(at - 1)))
      at += 1; // 1'000
    else if (
      (code === 43 || code === 45) &&
      !hex &&
      isDigit(next) &&
      isExponentMark(source, at - 1)
    )
      at += 1;
    else break;
  }
  return Math.max(at, start + 1);
}

function isExponentMark(source: string, index: number): boolean {
  const mark = source[index];
  return (mark === 'e' || mark === 'E') && isDigit(source.charCodeAt(index - 1));
}

/** The end of a run of identifier characters starting at `start`. */
export function scanWord(source: string, start: number): number {
  let at = start;
  while (at < source.length && isIdentPart(source.charCodeAt(at))) at += 1;
  return at;
}

/**
 * Is the next non-blank character, within the same line and a short distance, a colon? A lookahead that does not consume
 * what it reads, so the blanks it looks past and the character it tests are charged (ADR-0144).
 */
export function colonFollows(out: Segments, source: string, from: number): boolean {
  const limit = Math.min(source.length, from + 256);
  let at = from;
  while (at < limit && isBlank(source.charCodeAt(at))) at += 1;
  out.charge(at - from + 1);
  return source.charCodeAt(at) === 58;
}

/** The end of the comment that opens with `open` at `start`; a block comment never closed runs to the end. */
export function commentEnd(
  out: Segments,
  source: string,
  start: number,
  open: string,
  close: string | undefined,
): number {
  if (close === undefined) return out.lineEnd(start);
  const at = out.find(close, start + open.length);
  return at < 0 ? source.length : at + close.length;
}
