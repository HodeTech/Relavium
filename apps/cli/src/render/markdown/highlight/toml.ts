import type { SyntaxToken } from '../types.js';
import { isBlank, isDigit, isIdentPart, words } from './chars.js';
import { scanQuoted, type StringRule } from './lexemes.js';
import type { Scanner, Segments } from './segments.js';

const STRINGS: readonly StringRule[] = [
  { open: '"""', multiline: true, escapes: true },
  { open: "'''", multiline: true, escapes: false },
  { open: '"', multiline: false, escapes: true },
  { open: "'", multiline: false, escapes: false },
];

const HASH = 35;
const SEMICOLON = 59;
const EQUALS = 61;
const COLON = 58;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const TOML_CONSTANTS = words('true false');
const INI_CONSTANTS = words('true false yes no on off');
const SPECIAL_NUMBERS = words('inf nan +inf -inf +nan -nan');

/** What one scan carries from line to line. */
interface State {
  readonly ini: boolean;
  /** Open `[` of an array that goes on over the next lines: those lines hold values only. */
  depth: number;
}

/** A key: bare characters, dots and dashes, with quoted parts allowed (`a."b c".d`). */
function keyEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const code = source.charCodeAt(at);
    if (code === 34 || code === 39) {
      const rule = STRINGS.find((candidate) => candidate.open === source[at]);
      if (!rule) break;
      at = scanQuoted(source, at, rule);
    } else if (isIdentPart(code) || code === 46 || code === 45) at += 1;
    else break;
  }
  return at;
}

function isValueEnd(code: number): boolean {
  return (
    isBlank(code) ||
    code === 44 ||
    code === CLOSE_BRACKET ||
    code === CLOSE_BRACE ||
    code === HASH ||
    code === 34 ||
    code === 39 ||
    code === OPEN_BRACKET ||
    code === OPEN_BRACE ||
    code === EQUALS
  );
}

function classifyScalar(text: string, ini: boolean): SyntaxToken {
  const lower = text.toLowerCase();
  if ((ini ? INI_CONSTANTS : TOML_CONSTANTS).has(lower)) return 'constant';
  if (!ini && SPECIAL_NUMBERS.has(lower)) return 'number';
  const first = text.charCodeAt(0);
  const digit =
    isDigit(first) ||
    ((first === 43 || first === 45 || first === 46) && isDigit(text.charCodeAt(1)));
  return digit ? 'number' : 'text';
}

/**
 * Is the next non-blank character before `end` an `=`: is the word or string before `from` a key? The blanks it looks past
 * are read again afterwards, so they are charged (ADR-0144).
 */
function equalsFollows(out: Segments, source: string, from: number, end: number): boolean {
  let at = from;
  while (at < end && isBlank(source.charCodeAt(at))) at += 1;
  out.charge(at - from + 1);
  return source.charCodeAt(at) === EQUALS;
}

/** A comment starts at `#` (and, in INI, `;`); in INI only after a blank: `COLOR=#ff0000` holds a value. */
function startsComment(source: string, at: number, ini: boolean): boolean {
  const code = source.charCodeAt(at);
  if (code !== HASH && !(ini && code === SEMICOLON)) return false;
  return !ini || isBlank(source.charCodeAt(at - 1));
}

/** Where a value scan stands: the cursor, the end of the logical line (a multiline string moves it), and the inline-table depth. */
interface ValueCursor {
  at: number;
  end: number;
  braces: number;
}

/** A string literal at the cursor: a key (`property`) inside an inline table when an `=` follows it. A multiline one moves the line's end. */
function scanString(source: string, out: Segments, cursor: ValueCursor, rule: StringRule): void {
  const close = scanQuoted(source, cursor.at, rule);
  const key = cursor.braces > 0 && equalsFollows(out, source, close, cursor.end);
  out.mark(cursor.at, close, key ? 'property' : 'string');
  cursor.at = close;
  if (close > cursor.end) cursor.end = out.lineEnd(close);
}

/** One token of a value that is neither a blank nor a comment: a string, a bracket, a brace or a bare word. */
function scanToken(
  source: string,
  out: Segments,
  state: State,
  cursor: ValueCursor,
  code: number,
): void {
  const rule = STRINGS.find((candidate) => source.startsWith(candidate.open, cursor.at));
  if (rule) scanString(source, out, cursor, rule);
  else if (code === OPEN_BRACKET || code === CLOSE_BRACKET) {
    if (!state.ini) state.depth = Math.max(0, state.depth + (code === OPEN_BRACKET ? 1 : -1));
    cursor.at += 1;
  } else if (code === OPEN_BRACE || code === CLOSE_BRACE) {
    cursor.braces = Math.max(0, cursor.braces + (code === OPEN_BRACE ? 1 : -1));
    cursor.at += 1;
  } else cursor.at = scanWord(source, cursor.at, cursor.end, out, state, cursor.braces > 0);
}

/** The value part of a line, up to the end of the logical line; a multiline string may carry it past its first line. */
function scanValue(source: string, from: number, out: Segments, state: State): number {
  const cursor: ValueCursor = { at: from, end: out.lineEnd(from), braces: 0 };
  while (cursor.at < cursor.end) {
    out.tick();
    const code = source.charCodeAt(cursor.at);
    if (isBlank(code)) cursor.at += 1;
    else if (startsComment(source, cursor.at, state.ini)) {
      out.mark(cursor.at, cursor.end, 'comment');
      return cursor.end;
    } else scanToken(source, out, state, cursor, code);
  }
  return cursor.end;
}

/** One bare word of a value; in an inline table a word followed by `=` is a key. Always advances. */
function scanWord(
  source: string,
  at: number,
  end: number,
  out: Segments,
  state: State,
  inTable: boolean,
): number {
  let wordEnd = at;
  while (wordEnd < end && !isValueEnd(source.charCodeAt(wordEnd))) wordEnd += 1;
  if (wordEnd === at) return at + 1;
  const key = inTable && equalsFollows(out, source, wordEnd, end);
  const token = key ? 'property' : classifyScalar(source.slice(at, wordEnd), state.ini);
  if (token !== 'text') out.mark(at, wordEnd, token);
  return wordEnd;
}

/** `[table]` or `[[array of tables]]`; undefined when the line has no closing bracket (an array's continuation). */
function sectionEnd(source: string, at: number, end: number, out: Segments): number | undefined {
  const close = out.find(']', at + 1);
  if (close < 0 || close >= end) return undefined;
  return source.charCodeAt(close + 1) === CLOSE_BRACKET && close + 1 < end ? close + 2 : close + 1;
}

/** `export` before a key, as an `.env` file has it. */
function exportEnd(source: string, at: number, end: number): number | undefined {
  const word =
    source.startsWith('export', at) && isBlank(source.charCodeAt(at + 6)) ? at + 6 : undefined;
  if (word === undefined) return undefined;
  let next = word;
  while (next < end && isBlank(source.charCodeAt(next))) next += 1;
  return next < end ? word : undefined;
}

/** The first index in `[from, end)` that is not a blank, or `end`. */
function skipBlanks(source: string, from: number, end: number): number {
  let at = from;
  while (at < end && isBlank(source.charCodeAt(at))) at += 1;
  return at;
}

/** A line that is not blank, a comment or a section: an optional `export`, a key and its separator, then the value. */
function scanKeyLine(
  source: string,
  from: number,
  end: number,
  out: Segments,
  state: State,
): number {
  const { ini } = state;
  let at = from;
  const exported = ini ? exportEnd(source, at, end) : undefined;
  if (exported !== undefined) {
    out.mark(at, exported, 'keyword');
    at = skipBlanks(source, exported, end);
  }
  const key = keyEnd(source, at);
  const after = skipBlanks(source, key, end);
  // The key and the blanks after it are read before it is known to be a key, and the value is read again from `at` when it is
  // not: a lookahead, so what it read is charged (ADR-0144).
  out.charge(after - at + 1);
  const separator = source.charCodeAt(after);
  if (key > at && (separator === EQUALS || (ini && separator === COLON))) {
    out.mark(at, key, 'property');
    return scanValue(source, after + 1, out, state);
  }
  return scanValue(source, at, out, state);
}

function scanLine(source: string, start: number, out: Segments, state: State): number {
  const end = out.lineEnd(start);
  const at = skipBlanks(source, start, end);
  if (at >= end) return end;
  if (state.depth > 0) return scanValue(source, at, out, state); // the next line of a multi-line array
  const code = source.charCodeAt(at);
  if (code === HASH || (state.ini && code === SEMICOLON)) {
    out.mark(at, end, 'comment');
    return end;
  }
  if (code === OPEN_BRACKET) {
    const close = sectionEnd(source, at, end, out);
    if (close !== undefined) {
      out.mark(at, close, 'type');
      return scanValue(source, close, out, state);
    }
  }
  return scanKeyLine(source, at, end, out, state);
}

function lines(ini: boolean): Scanner {
  return (source, out) => {
    const state: State = { ini, depth: 0 };
    let at = 0;
    while (at < source.length) {
      out.tick();
      at = scanLine(source, at, out, state) + 1;
    }
  };
}

/** TOML: tables, keys, inline tables, strings, numbers, dates and comments. */
export const scanToml: Scanner = lines(false);

/** INI and `.env`-like `key = value` files: sections, keys, values and `#` or `;` comments. */
export const scanIni: Scanner = lines(true);
