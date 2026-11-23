/** Character classes the scanners share. They read code units: a code point above U+007F counts as an identifier part. */

export const BACKSLASH = 92;

export function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

export function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13);
}

/** A space or tab: the whitespace that stays on one line. */
export function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

export function isIdentStart(code: number): boolean {
  return isAsciiLetter(code) || code === 95 || code === 36 || code >= 128;
}

export function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

export function isUpperAscii(code: number): boolean {
  return code >= 65 && code <= 90;
}

export function isLowerAscii(code: number): boolean {
  return code >= 97 && code <= 122;
}

/** Where the escape that starts at the backslash at `at` ends: it takes the next character, a whole code point. */
export function escapeEnd(source: string, at: number): number {
  const next = source.charCodeAt(at + 1);
  const low = source.charCodeAt(at + 2);
  return next >= 0xd800 && next <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? at + 3 : at + 2;
}

/** Build a set from a space-separated word list. */
export function words(list: string): ReadonlySet<string> {
  return new Set(list.split(' ').filter((word) => word !== ''));
}
