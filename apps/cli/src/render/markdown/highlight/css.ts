import { isBlank, isDigit, isIdentPart, isIdentStart, isSpace } from './chars.js';
import { commentEnd, scanNumber, scanQuoted, type StringRule } from './lexemes.js';
import type { Scanner } from './segments.js';

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

/** After a colon, does a `;` or `}` come before any `{`? Then it is a declaration; otherwise a selector (`a:hover {`). */
function isDeclaration(source: string, colon: number): boolean {
  if (colon < 0) return false;
  const limit = Math.min(source.length, colon + DECLARATION_REACH);
  for (let at = colon + 1; at < limit; at++) {
    const code = source.charCodeAt(at);
    if (code === OPEN_BRACE) return false;
    if (code === SEMICOLON || code === CLOSE_BRACE) return true;
  }
  return true;
}

/** The index of the colon that follows the blanks after `from`, or -1 when another character comes first. */
function colonAfter(source: string, from: number): number {
  let at = from;
  while (isBlank(source.charCodeAt(at))) at += 1;
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

/** CSS: at-rules, property names inside blocks, values, colours, strings and comments. */
export const scanCss: Scanner = (source, out) => {
  let at = 0;
  let depth = 0;
  /** The last significant character: a property name can only follow `{`, `;`, `}` or the start. */
  let previous = 0;
  while (at < source.length) {
    out.tick();
    const code = source.charCodeAt(at);
    if (isSpace(code)) {
      at += 1;
      continue;
    }
    if (source.startsWith('/*', at)) {
      const end = commentEnd(out, source, at, '/*', '*/');
      out.mark(at, end, 'comment');
      at = end;
      previous = 0;
      continue;
    }
    if (code === 34 || code === 39) {
      const end = scanQuoted(source, at, code === 34 ? STRING : APOSTROPHE);
      out.mark(at, end, 'string');
      at = end;
      previous = code;
      continue;
    }
    if (code === 64 && isIdentStart(source.charCodeAt(at + 1))) {
      const end = identEnd(source, at + 1);
      out.mark(at, end, 'keyword');
      at = end;
      previous = 0;
      continue;
    }
    if (code === HASH && depth > 0) {
      const end = identEnd(source, at + 1);
      out.mark(at, end, 'number');
      at = Math.max(end, at + 1);
      previous = HASH;
      continue;
    }
    if (depth > 0 && startsNumber(source, at)) {
      let end = scanNumber(source, at + (isDigit(code) ? 0 : 1));
      if (source.charCodeAt(end) === PERCENT) end += 1;
      out.mark(at, end, 'number');
      at = end;
      previous = PERCENT;
      continue;
    }
    if (isIdentStart(code) || code === DASH) {
      const end = Math.max(identEnd(source, at), at + 1);
      const property =
        depth > 0 &&
        (previous === OPEN_BRACE ||
          previous === SEMICOLON ||
          previous === CLOSE_BRACE ||
          previous === 0) &&
        isDeclaration(source, colonAfter(source, end));
      const call = source.charCodeAt(end) === 40;
      if (property) out.mark(at, end, 'property');
      else if (call) out.mark(at, end, 'function');
      else if (previous === 33 && source.slice(at, end) === 'important')
        out.mark(at, end, 'keyword');
      at = end;
      previous = source.charCodeAt(end - 1);
      continue;
    }
    if (code === OPEN_BRACE) depth += 1;
    else if (code === CLOSE_BRACE) depth = Math.max(0, depth - 1);
    previous = code;
    at += 1;
  }
};
