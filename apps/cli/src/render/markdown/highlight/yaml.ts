import type { SyntaxToken } from '../types.js';
import { isBlank, isDigit, words } from './chars.js';
import { scanQuoted, type StringRule } from './lexemes.js';
import type { Scanner, Segments } from './segments.js';

const DOUBLE: StringRule = { open: '"', multiline: false, escapes: true };
const SINGLE: StringRule = { open: "'", multiline: false, escapes: false };
const CONSTANTS = words('true false null yes no on off ~');
const HASH = 35;
const COLON = 58;
const DASH = 45;
/** Characters that start something other than a plain key. */
const NOT_A_KEY = new Set(['[', '{', '|', '>', '%', '@', '`', '#']);

function quoteRule(code: number): StringRule | undefined {
  if (code === 34) return DOUBLE;
  return code === 39 ? SINGLE : undefined;
}

/** Does a colon at `at` end a key (it is followed by a blank or the end of the line)? */
function endsKey(source: string, at: number, end: number): boolean {
  return source.charCodeAt(at) === COLON && (at + 1 >= end || isBlank(source.charCodeAt(at + 1)));
}

/** The end of the key that starts at `at` (the index of the colon), or -1 when the line has no key there. */
function findKey(source: string, at: number, end: number): number {
  const first = source[at] ?? '';
  if (NOT_A_KEY.has(first)) return -1;
  const rule = quoteRule(source.charCodeAt(at));
  if (rule) {
    let colon = scanQuoted(source, at, rule);
    while (colon < end && isBlank(source.charCodeAt(colon))) colon += 1;
    return endsKey(source, colon, end) ? colon : -1;
  }
  for (let index = at; index < end; index++) {
    if (endsKey(source, index, end)) return index;
    if (source.charCodeAt(index) === HASH && index > at && isBlank(source.charCodeAt(index - 1)))
      return -1;
  }
  return -1;
}

/** How many characters a search from `from` read: through the colon it found, or up to `limit` when it found none. */
function charsRead(colon: number, from: number, limit: number): number {
  return (colon >= 0 ? colon + 1 : limit) - from;
}

/** The index of the first colon in `[from, to)`, or -1. */
function colonWithin(source: string, from: number, to: number): number {
  for (let at = from; at < to; at++) {
    if (source.charCodeAt(at) === COLON) return at;
  }
  return -1;
}

function trimEnd(source: string, from: number, end: number): number {
  let at = end;
  while (at > from && isBlank(source.charCodeAt(at - 1))) at -= 1;
  return at;
}

function looksNumeric(text: string): boolean {
  const sign = text.charCodeAt(0) === 43 || text.charCodeAt(0) === DASH ? 1 : 0;
  const first = text.charCodeAt(sign);
  const start = isDigit(first) || (first === 46 && isDigit(text.charCodeAt(sign + 1)));
  if (!start) return false;
  for (let index = sign; index < text.length; index++) {
    const code = text.charCodeAt(index);
    const part = isDigit(code) || /[a-fA-FxXoO_.+:-]/u.test(text[index] ?? '');
    if (!part) return false;
  }
  return true;
}

function classifyScalar(text: string): SyntaxToken {
  if (CONSTANTS.has(text.toLowerCase())) return 'constant';
  return looksNumeric(text) ? 'number' : 'text';
}

/** Mutable state of one value scan: whether a block scalar was announced, and how deep the flow collections are. */
interface ValueState {
  block: boolean;
  flow: number;
}

/** A plain scalar's end: before ` #`, at the end of the line, and, in a flow collection, before `,`, `]` or `}`. */
function plainEnd(source: string, from: number, end: number, flow: number): number {
  let at = from;
  while (at < end) {
    const code = source.charCodeAt(at);
    if (code === HASH && at > from && isBlank(source.charCodeAt(at - 1))) break;
    if (flow > 0 && (code === 44 || code === 93 || code === 125)) break;
    at += 1;
  }
  return trimEnd(source, from, at);
}

/** The end of the run of non-blank characters that starts at `from` (`&anchor`, `!tag`, `|`, `>`), and, for a property, before a `,`. */
function wordEnd(source: string, from: number, end: number, stopAtComma: boolean): number {
  let close = from;
  while (
    close < end &&
    !isBlank(source.charCodeAt(close)) &&
    !(stopAtComma && source[close] === ',')
  )
    close += 1;
  return close;
}

/** One quoted scalar; inside a flow collection, one followed by a colon is a key. */
function scanQuotedValue(
  source: string,
  at: number,
  end: number,
  out: Segments,
  state: ValueState,
  rule: StringRule,
): number {
  const close = scanQuoted(source, at, rule);
  const key = state.flow > 0 && endsKey(source, close, end);
  out.mark(at, close, key ? 'property' : 'string');
  return close;
}

/** One token of a value that is neither a blank nor a comment; returns where the scan goes on, which is past `at`. */
function scanValueToken(
  source: string,
  at: number,
  end: number,
  out: Segments,
  state: ValueState,
  code: number,
): number {
  const rule = quoteRule(code);
  if (rule) return scanQuotedValue(source, at, end, out, state, rule);
  if (code === 38 || code === 42 || code === 33) {
    const close = wordEnd(source, at + 1, end, true);
    out.mark(at, close, 'meta');
    return close;
  }
  if ((code === 124 || code === 62) && state.flow === 0) {
    const close = wordEnd(source, at + 1, end, false);
    out.mark(at, close, 'meta');
    state.block = true;
    return close;
  }
  if (code === 91 || code === 123) {
    state.flow += 1;
    return at + 1;
  }
  if (code === 93 || code === 125) {
    state.flow = Math.max(0, state.flow - 1);
    return at + 1;
  }
  if (code === 44 || code === COLON) return at + 1;
  return scanPlain(source, at, end, out, state);
}

function scanValue(source: string, from: number, end: number, out: Segments): ValueState {
  const state: ValueState = { block: false, flow: 0 };
  let at = from;
  while (at < end) {
    out.tick();
    const code = source.charCodeAt(at);
    if (code === HASH && (at === from || isBlank(source.charCodeAt(at - 1)))) {
      out.mark(at, end, 'comment');
      return state;
    }
    at = isBlank(code) ? at + 1 : scanValueToken(source, at, end, out, state, code);
  }
  return state;
}

/** One plain scalar; in a flow collection a word followed by a colon is a key. Always advances. */
function scanPlain(
  source: string,
  at: number,
  end: number,
  out: Segments,
  state: ValueState,
): number {
  const stop = Math.max(plainEnd(source, at, end, state.flow), at + 1);
  if (state.flow > 0) {
    const reach = Math.min(stop + 1, end);
    const colon = colonWithin(source, at, reach);
    // The search reads the scalar again without consuming it, so what it read is charged (ADR-0144).
    out.charge(charsRead(colon, at, reach));
    if (colon > at && endsKey(source, colon, end)) {
      out.mark(at, trimEnd(source, at, colon), 'property');
      return colon + 1;
    }
  }
  const token = classifyScalar(source.slice(at, stop));
  if (token !== 'text') out.mark(at, stop, token);
  return stop;
}

interface LineState {
  /** The column a block scalar's parent starts in: lines indented deeper are its text. */
  block: number | undefined;
}

/** Skip `- ` markers; the column of the last one is where a following block scalar's parent starts. */
function skipMarkers(
  source: string,
  start: number,
  from: number,
  end: number,
): { at: number; column: number } {
  let at = from;
  let column = from - start;
  while (source.charCodeAt(at) === DASH && (at + 1 >= end || isBlank(source.charCodeAt(at + 1)))) {
    column = at - start;
    at += 1;
    while (at < end && isBlank(source.charCodeAt(at))) at += 1;
  }
  return { at, column };
}

/** `&anchor` and `!tag` words before a key or a value: where the node itself starts, or `at` when nothing follows them. */
function skipProperties(source: string, at: number, end: number): number {
  let next = at;
  while (next < end && (source.charCodeAt(next) === 38 || source.charCodeAt(next) === 33)) {
    let close = next + 1;
    while (close < end && !isBlank(source.charCodeAt(close))) close += 1;
    let after = close;
    while (after < end && isBlank(source.charCodeAt(after))) after += 1;
    if (after >= end) break;
    next = after;
  }
  return next;
}

function scanLine(source: string, start: number, out: Segments, state: LineState): number {
  const end = out.lineEnd(start);
  let at = start;
  while (at < end && isBlank(source.charCodeAt(at))) at += 1;
  if (at >= end) return end;
  const indent = at - start;
  if (state.block !== undefined) {
    if (indent > state.block) {
      out.mark(at, end, 'string');
      return end;
    }
    state.block = undefined;
  }
  if (source.charCodeAt(at) === HASH) {
    out.mark(at, end, 'comment');
    return end;
  }
  const marker = indent === 0 && (source.startsWith('---', at) || source.startsWith('...', at));
  if (marker && (at + 3 >= end || isBlank(source.charCodeAt(at + 3)))) {
    out.mark(at, at + 3, 'meta');
    at += 3;
  }
  const { at: item, column } = skipMarkers(source, start, at, end);
  const node = skipProperties(source, item, end);
  const colon = findKey(source, node, end);
  // `findKey` reads from the node to its colon, or to the end of the line when there is none, and the value is read again
  // afterwards: a lookahead, so what it read is charged (ADR-0144).
  out.charge(charsRead(colon, node, end));
  let valueFrom = item;
  let parent = column;
  if (colon >= 0) {
    if (node > item) out.mark(item, trimEnd(source, item, node), 'meta');
    out.mark(node, trimEnd(source, node, colon), 'property');
    valueFrom = colon + 1;
    parent = node - start;
  }
  const value = scanValue(source, valueFrom, end, out);
  if (value.block) state.block = parent;
  return end;
}

/** YAML: keys, scalars, anchors and tags, comments, flow collections and block scalars (`run: |`). */
export const scanYaml: Scanner = (source, out) => {
  const state: LineState = { block: undefined };
  let at = 0;
  while (at < source.length) {
    out.tick();
    at = scanLine(source, at, out, state) + 1;
  }
};
