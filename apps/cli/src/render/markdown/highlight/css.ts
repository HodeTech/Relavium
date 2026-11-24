import { isBlank, isDigit, isIdentPart, isIdentStart, isSpace } from './chars.js';
import { commentEnd, scanNumber, scanQuoted, type StringRule } from './lexemes.js';
import type { Scanner, Segments } from './segments.js';

const STRING: StringRule = { open: '"', multiline: false, escapes: true };
const APOSTROPHE: StringRule = { open: "'", multiline: false, escapes: true };
const DASH = 45;
const HASH = 35;
const PERCENT = 37;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const SEMICOLON = 59;
/** How far past a colon a declaration is looked for before the text is taken for a selector. */
const DECLARATION_REACH = 512;

/** A CSS identifier, which may hold dashes: `margin-top`, `--accent`, `-webkit-box`. */
function identEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length) {
    const code = source.charCodeAt(at);
    if (!isIdentPart(code) && code !== DASH) break;
    at += 1;
  }
  return at;
}

/**
 * After a colon, does a `;` or `}` come before any `{`? Then it is a declaration; otherwise a selector (`a:hover {`).
 * It reads up to {@link DECLARATION_REACH} characters ahead without consuming them, so what it reads is charged
 * (ADR-0144): a run of property-like names that each look that far ahead costs what it reads, not a step apiece.
 */
function isDeclaration(out: Segments, source: string, colon: number): boolean {
  if (colon < 0) return false;
  const limit = Math.min(source.length, colon + DECLARATION_REACH);
  let at = colon + 1;
  let declaration = true;
  for (; at < limit; at++) {
    const code = source.charCodeAt(at);
    if (code === OPEN_BRACE) declaration = false;
    if (code === OPEN_BRACE || code === SEMICOLON || code === CLOSE_BRACE) break;
  }
  out.charge(at - colon);
  return declaration;
}

/** The index of the colon that follows the blanks after `from`, or -1 when another character comes first. The blanks are charged. */
function colonAfter(out: Segments, source: string, from: number): number {
  let at = from;
  while (isBlank(source.charCodeAt(at))) at += 1;
  out.charge(at - from + 1);
  return source.charCodeAt(at) === 58 ? at : -1;
}

function startsNumber(source: string, at: number): boolean {
  const code = source.charCodeAt(at);
  const next = source.charCodeAt(at + 1);
  if (isDigit(code)) return true;
  if (code === 46) return isDigit(next);
  return (
    (code === DASH || code === 43) &&
    (isDigit(next) || (next === 46 && isDigit(source.charCodeAt(at + 2))))
  );
}

/** What the scan carries from one token to the next. */
interface CssState {
  at: number;
  depth: number;
  /** The last significant character: a property name can only follow `{`, `;`, `}` or the start. */
  previous: number;
}

/** A step tries one kind of token at `state.at`; it returns whether it classed (and consumed) one. */
type CssStep = (source: string, out: Segments, state: CssState, code: number) => boolean;

const comment: CssStep = (source, out, state) => {
  if (!source.startsWith('/*', state.at)) return false;
  const end = commentEnd(out, source, state.at, '/*', '*/');
  out.mark(state.at, end, 'comment');
  state.at = end;
  state.previous = 0;
  return true;
};

const quoted: CssStep = (source, out, state, code) => {
  if (code !== 34 && code !== 39) return false;
  const end = scanQuoted(source, state.at, code === 34 ? STRING : APOSTROPHE);
  out.mark(state.at, end, 'string');
  state.at = end;
  state.previous = code;
  return true;
};

const atRule: CssStep = (source, out, state, code) => {
  if (code !== 64 || !isIdentStart(source.charCodeAt(state.at + 1))) return false;
  const end = identEnd(source, state.at + 1);
  out.mark(state.at, end, 'keyword');
  state.at = end;
  state.previous = 0;
  return true;
};

const colour: CssStep = (source, out, state, code) => {
  if (code !== HASH || state.depth === 0) return false;
  const end = identEnd(source, state.at + 1);
  out.mark(state.at, end, 'number');
  state.at = Math.max(end, state.at + 1);
  state.previous = HASH;
  return true;
};

const numeric: CssStep = (source, out, state, code) => {
  if (state.depth === 0 || !startsNumber(source, state.at)) return false;
  let end = scanNumber(source, state.at + (isDigit(code) ? 0 : 1));
  if (source.charCodeAt(end) === PERCENT) end += 1;
  out.mark(state.at, end, 'number');
  state.at = end;
  state.previous = PERCENT;
  return true;
};

/** Can a property name start here: inside a block, right after `{`, `;`, `}` or a comment, or at the very start? */
function canStartProperty(state: CssState): boolean {
  return (
    state.depth > 0 &&
    (state.previous === OPEN_BRACE ||
      state.previous === SEMICOLON ||
      state.previous === CLOSE_BRACE ||
      state.previous === 0)
  );
}

const identifier: CssStep = (source, out, state, code) => {
  if (!isIdentStart(code) && code !== DASH) return false;
  const { at, previous } = state;
  const end = Math.max(identEnd(source, at), at + 1);
  const property =
    canStartProperty(state) && isDeclaration(out, source, colonAfter(out, source, end));
  const call = source.charCodeAt(end) === 40;
  if (property) out.mark(at, end, 'property');
  else if (call) out.mark(at, end, 'function');
  else if (previous === 33 && source.slice(at, end) === 'important') out.mark(at, end, 'keyword');
  state.at = end;
  state.previous = source.charCodeAt(end - 1);
  return true;
};

const STEPS: readonly CssStep[] = [comment, quoted, atRule, colour, numeric, identifier];

/** CSS: at-rules, property names inside blocks, values, colours, strings and comments. */
export const scanCss: Scanner = (source, out) => {
  const state: CssState = { at: 0, depth: 0, previous: 0 };
  while (state.at < source.length) {
    out.tick();
    const code = source.charCodeAt(state.at);
    if (isSpace(code)) {
      state.at += 1;
      continue;
    }
    if (STEPS.some((step) => step(source, out, state, code))) continue;
    if (code === OPEN_BRACE) state.depth += 1;
    else if (code === CLOSE_BRACE) state.depth = Math.max(0, state.depth - 1);
    state.previous = code;
    state.at += 1;
  }
};
