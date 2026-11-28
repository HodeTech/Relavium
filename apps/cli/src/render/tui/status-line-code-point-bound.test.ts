/**
 * A free value of the status line (the model id above all: a project's agent file chooses it) is bounded to 256 CODE POINTS, counted by
 * `headCodePoints` as one for every character and as two UTF-16 units only for a character beyond the Basic Multilingual Plane (a surrogate pair).
 * The edge of the two is U+FFFF, the last character of the plane, which is ONE unit: counted as two, the value's window and its bound step over the
 * character that follows it, and a value full of them is drawn longer than the bound says (MVP-11 unit 7, round 1: the mutation sweep's sl081 and
 * sl083, where `> 0xffff` loosened to `>= 0xffff` and to `> 0xfffe` both survived). The character is built with `String.fromCharCode`: a file
 * that writes the escape for it holds the escape's text once a tool has handled it.
 */
import { describe, expect, it } from 'vitest';

import { FREE_VALUE_BOUND, statusLine } from './status-line.js';

const ELLIPSIS = String.fromCodePoint(0x2026);
/** U+FFFF: the last character of the Basic Multilingual Plane, a single UTF-16 unit. */
const LAST_BMP = String.fromCharCode(0xffff);
/** U+10000 and above, the characters that take a surrogate pair: the first of them, and an emoji well inside the range. */
const FIRST_ASTRAL = String.fromCodePoint(0x10000);
const ASTRAL = String.fromCodePoint(0x1f600);
const WIDE = 4000;

/** The line of a Home status whose model id is `model`, in a terminal wide enough that nothing but the bound cuts it. */
const lineOf = (model: string): string =>
  statusLine(
    { surface: 'home', provider: 'anthropic', model, mode: 'ask', directory: '~/work/app' },
    WIDE,
  ).text;

/** Whether `text` holds half of a surrogate pair (a code point that arrives as one lone UTF-16 unit in the range of the halves). */
const hasLoneSurrogate = (text: string): boolean =>
  [...text].some((character) => {
    const unit = character.charCodeAt(0);
    return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
  });

/** How many code points of `text` are one of `characters`. */
const countOf = (text: string, ...characters: string[]): number =>
  [...text].filter((character) => characters.includes(character)).length;

describe('a free value is bounded to 256 code points, the edge of the plane included', () => {
  it('a model id of U+FFFF characters between ordinary ones keeps its first 255 code points and the ellipsis', () => {
    const model = `${LAST_BMP.repeat(3)}Z`.repeat(1200);
    const text = lineOf(model);
    // 255 = 63 whole groups of four (three of them U+FFFF, one `Z`) and three more U+FFFF
    expect(countOf(text, LAST_BMP), 'each U+FFFF is one code point of the bound').toBe(63 * 3 + 3);
    expect(countOf(text, 'Z')).toBe(63);
    expect(text).toContain(ELLIPSIS);
  });

  it('a model id of nothing but U+FFFF characters keeps 255 of them', () => {
    const text = lineOf(LAST_BMP.repeat(2000));
    expect(countOf(text, LAST_BMP)).toBe(FREE_VALUE_BOUND - 1);
  });

  it.each([
    ['the first character beyond the plane (U+10000)', FIRST_ASTRAL],
    ['an emoji well inside the range', ASTRAL],
  ])('a model id of %s keeps 255 of them, each whole', (_name, character) => {
    const text = lineOf(character.repeat(2000));
    expect(countOf(text, character), 'a pair is one code point and is never split').toBe(
      FREE_VALUE_BOUND - 1,
    );
    expect(hasLoneSurrogate(text), 'no half of a pair is left').toBe(false);
  });

  it('a value under the bound is drawn exactly as it is', () => {
    const model = `${LAST_BMP}Z`.repeat(50);
    expect(lineOf(model)).toContain(model);
  });
});
