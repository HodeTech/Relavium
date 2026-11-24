import { isBlank, isSpace } from './chars.js';
import type { Scanner, Segments } from './segments.js';

const LESS_THAN = 60;
const GREATER_THAN = 62;
const SLASH = 47;
const EQUALS = 61;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;

function isNameChar(code: number): boolean {
  return (
    !isSpace(code) &&
    code !== SLASH &&
    code !== GREATER_THAN &&
    code !== EQUALS &&
    code !== LESS_THAN
  );
}

function nameEnd(source: string, from: number): number {
  let at = from;
  while (at < source.length && isNameChar(source.charCodeAt(at))) at += 1;
  return at;
}

/** A quoted attribute value: through its closing quote, or the end of the text when it is never closed. */
function quotedEnd(source: string, from: number, out: Segments): number {
  const close = out.find(source[from] ?? '"', from + 1);
  return close < 0 ? source.length : close + 1;
}

/** The attributes of one tag, up to and including its `>` (or the end of the text). */
function scanAttributes(source: string, from: number, out: Segments): number {
  let at = from;
  while (at < source.length) {
    out.tick();
    const code = source.charCodeAt(at);
    if (code === GREATER_THAN) return at + 1;
    if (isSpace(code) || code === SLASH) at += 1;
    else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
      const end = quotedEnd(source, at, out);
      out.mark(at, end, 'string');
      at = end;
    } else if (code === EQUALS) {
      at += 1;
      while (isBlank(source.charCodeAt(at))) at += 1;
      const next = source.charCodeAt(at);
      if (next !== DOUBLE_QUOTE && next !== SINGLE_QUOTE && next !== GREATER_THAN) {
        const end = nameEnd(source, at);
        out.mark(at, end, 'string');
        at = Math.max(end, at + 1);
      }
    } else {
      const end = Math.max(nameEnd(source, at), at + 1);
      out.mark(at, end, 'property');
      at = end;
    }
  }
  return at;
}

/**
 * What starts at the `<` at `open`: a comment, a declaration or processing instruction, or a tag with its attributes. Returns where
 * the scan goes on, which is always past `open`.
 */
function scanTag(source: string, out: Segments, open: number): number {
  const next = source.charCodeAt(open + 1);
  if (source.startsWith('<!--', open)) {
    const close = out.find('-->', open + 4);
    const end = close < 0 ? source.length : close + 3;
    out.mark(open, end, 'comment');
    return end;
  }
  if (next === 33 || next === 63) {
    const close = out.find('>', open);
    const end = close < 0 ? source.length : close + 1;
    out.mark(open, end, 'meta');
    return end;
  }
  const nameStart = open + (next === SLASH ? 2 : 1);
  const end = nameEnd(source, nameStart);
  if (end === nameStart) return open + 1;
  out.mark(nameStart, end, 'keyword');
  return scanAttributes(source, end, out);
}

/** HTML, XML and SVG: tags, attributes, values, comments and declarations. The text between tags stays plain. */
export const scanMarkup: Scanner = (source, out) => {
  let at = 0;
  while (at < source.length) {
    out.tick();
    const open = out.find('<', at);
    if (open < 0) return;
    at = scanTag(source, out, open);
  }
};
