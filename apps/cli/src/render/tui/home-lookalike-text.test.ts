/**
 * The characters a stored name may not carry onto the Home (MVP-11 unit 7, round 2: F3 and F4), walked code point by code point.
 *
 * - **F3: the work page's overflow marker.** `▲ N more` and `▼ N more` stand in the marker column of a row, where a session's or a run's
 *   name starts, so a name that begins with a triangle (or one of its lookalikes) drew a row beside the real marker. Every code point of
 *   {@link MARKER_LOOKALIKE_RANGES} is blanked in the names a row draws, and the plain form's `^ N more` and `v N more` at the start of a name.
 * - **F4: page 1's hint.** The head names the most urgent item and its `↓` is the only arrow on the row; a name could carry another arrow
 *   (`⬇ ⤓ 🡓 ▼ ⟱ ⯆`) or dress up as a key beside the real ones with a bracket the scrub does not know (`【Enter】`, `〔Esc〕`, `［Ctrl+Y］`).
 *   Every code point of {@link ARROW_LOOKALIKE_RANGES} becomes a space and every one of {@link BRACKET_PAIR_RANGES} (and the fullwidth pair
 *   and the ASCII pair) a parenthesis, by the side of its pair.
 *
 * Every table is stated here by its ranges, written in this file as the review reads them, and the code's own table must equal it: a range
 * that grows or shrinks fails here first. No code point is written as an escape: each is built from its number.
 */
import { describe, expect, it } from 'vitest';

import { flowLine } from './flow-text.js';
import { glyphOf } from './glyphs.js';
import {
  ARROW_LOOKALIKE_RANGES,
  BRACKET_PAIR_RANGES,
  URGENT_NAME_COLUMNS,
  urgentName,
} from './home-attention.js';
import {
  blankMarkerLookalikes,
  classOfRanges,
  MARKER_LOOKALIKE_RANGES,
  workRowText,
  type CodeRange,
} from './home-projection.js';
import { displayWidth } from './viewport.js';

const ch = (code: number): string => String.fromCodePoint(code);
/** The fullwidth square brackets `［` and `］`: not a range of the table, the scrub folds them to the ASCII pair first. */
const FULLWIDTH_OPEN = 0xff3b;
const FULLWIDTH_CLOSE = 0xff3d;
const codePointsOf = (ranges: readonly CodeRange[]): number[] =>
  ranges.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, offset) => from + offset),
  );

/** The ranges of {@link MARKER_LOOKALIKE_RANGES}, as the maintainer's brief names them and the review adds. */
const EXPECTED_MARKER_RANGES: readonly (readonly [number, number, string])[] = [
  [0x23e9, 0x23ef, 'the media triangles'],
  [0x23f4, 0x23f7, 'the medium triangles'],
  [0x25b2, 0x25c5, 'the black and white triangles and pointers'],
  [0x25e2, 0x25e5, 'the black corner triangles'],
  [0x25ec, 0x25ee, 'the triangles with a dot or a black half'],
  [0x25f8, 0x25fa, 'the corner triangles'],
  [0x25ff, 0x25ff, 'the lower right triangle'],
  [0x2b9c, 0x2ba0, 'the equilateral arrowheads and the triangle-headed arrow after them'],
  [0x2bc5, 0x2bc8, 'the centred medium triangles'],
  [0x1f53a, 0x1f53d, 'the red triangles'],
  [0x1f780, 0x1f783, 'the black isosceles right triangles'],
];

const EXPECTED_ARROW_RANGES: readonly (readonly [number, number, string])[] = [
  [0x2190, 0x21ff, 'the arrows block'],
  [0x27f0, 0x27ff, 'the supplemental arrows A'],
  [0x2900, 0x297f, 'the supplemental arrows B'],
  [0x2b00, 0x2bff, 'the miscellaneous symbols and arrows'],
  [0x1f800, 0x1f8ff, 'the supplemental arrows C'],
  [0x2304, 0x2304, 'the down arrowhead'],
  [0x2324, 0x2324, 'the enter key sign'],
  [0x2386, 0x2386, 'the enter key'],
  [0x23ce, 0x23ce, 'the return symbol'],
  ...EXPECTED_MARKER_RANGES,
];

const EXPECTED_BRACKET_RANGES: readonly (readonly [number, number, string])[] = [
  [0x2045, 0x2046, 'the square brackets with a quill'],
  [0x2308, 0x230b, 'the ceiling and floor brackets'],
  [0x2768, 0x2775, 'the ornamental brackets'],
  [0x27e6, 0x27ef, 'the mathematical brackets'],
  [0x2983, 0x2998, 'the miscellaneous mathematical symbols B brackets'],
  [0x29d8, 0x29db, 'the wiggly fence brackets'],
  [0x29fc, 0x29fd, 'the curved angle brackets'],
  [0x2e22, 0x2e29, 'the half brackets'],
  [0x3008, 0x3011, 'the CJK angle, double angle, corner, white corner and lenticular brackets'],
  [0x3014, 0x301b, 'the CJK tortoise-shell, white lenticular and white square brackets'],
];

const withoutNames = (ranges: readonly (readonly [number, number, string])[]): CodeRange[] =>
  ranges.map(([from, to]) => [from, to]);

/** A named range as a row of a table test: its title reads `U+25B2 to U+25C5`, hexadecimal as the Unicode charts write it. */
const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
const rowsOf = (
  ranges: readonly (readonly [number, number, string])[],
): readonly { range: string; label: string; from: number; to: number }[] =>
  ranges.map(([from, to, label]) => ({
    range: from === to ? hex(from) : `${hex(from)} to ${hex(to)}`,
    label,
    from,
    to,
  }));

describe('the tables are the ranges this file names', () => {
  it('the marker lookalikes', () => {
    expect(MARKER_LOOKALIKE_RANGES).toEqual(withoutNames(EXPECTED_MARKER_RANGES));
  });
  it('the arrows', () => {
    expect(ARROW_LOOKALIKE_RANGES).toEqual(withoutNames(EXPECTED_ARROW_RANGES));
  });
  it('the bracket pairs', () => {
    expect(BRACKET_PAIR_RANGES).toEqual(withoutNames(EXPECTED_BRACKET_RANGES));
  });
  it('the fullwidth square brackets are the ASCII pair after the scrub, so the table needs no entry for them', () => {
    expect(flowLine(ch(FULLWIDTH_OPEN))).toBe('[');
    expect(flowLine(ch(FULLWIDTH_CLOSE))).toBe(']');
    expect(urgentName(`${ch(FULLWIDTH_OPEN)}Enter${ch(FULLWIDTH_CLOSE)} x`)).toBe('(Enter) x');
  });
  it('the real marker of the work page is inside the marker table, in the Unicode form', () => {
    for (const role of ['moreAbove', 'moreBelow'] as const) {
      const glyph = glyphOf(role, false);
      const code = glyph.codePointAt(0) ?? 0;
      expect(
        codePointsOf(MARKER_LOOKALIKE_RANGES),
        `the glyph of ${role} is blanked in a name`,
      ).toContain(code);
    }
  });
  it('builds a class from the code points and not from an escape', () => {
    expect(
      classOfRanges([
        [0x41, 0x43],
        [0x45, 0x45],
      ]),
    ).toBe('A-CE');
  });
});

describe.each(rowsOf(EXPECTED_MARKER_RANGES))(
  'F3: $range ($label) in a name on the work page',
  ({ from, to }) => {
    const points = codePointsOf([[from, to]]);

    it(`blanks every one of the ${String(points.length)} code points where a name starts, leaving the words`, () => {
      for (const code of points) {
        const stored = `${ch(code)} 9 more · /resume`;
        // the row builders' pass: scrubbed, then blanked, so the name starts with its first word (a triangle the scrub already blanks, as the
        // retired play sign `▶` and the marker `▸`, leaves its own space and the same words)
        const shown = workRowText(stored);
        expect(shown.trim(), `U+${code.toString(16)}`).toBe('9 more - /resume');
        expect(shown).not.toContain(ch(code));
        expect(blankMarkerLookalikes(`${ch(code)} 9 more`)).toBe('9 more');
      }
    });

    it('blanks one inside a name too, so no triangle stays in a row beside the real marker', () => {
      for (const code of points) {
        const shown = workRowText(`before ${ch(code)} after`);
        expect(shown, `U+${code.toString(16)}`).not.toContain(ch(code));
        expect(shown).toMatch(/^before\s+after$/u);
      }
    });
  },
);

describe('F3: what the marker pass leaves alone', () => {
  it.each([
    'release-notes',
    'v2 migration',
    'vet 3 more files',
    'v 5 moreover',
    '^caret',
    'review 9 more things',
    'the ratio ≥ 3 more',
    '日本語のワークフロー',
  ])('leaves %s exactly as the scrub gives it', (name) => {
    expect(blankMarkerLookalikes(name)).toBe(name);
  });

  it.each([
    ['v 5 more', '5 more'],
    ['^ 12 more', '12 more'],
    ['  v 5 more · /resume', '5 more · /resume'],
    ['V 5 MORE', '5 MORE'],
    ['v 1,204 more', '1,204 more'],
  ])('the plain form of the marker, %s, loses its letter at the start of a name', (name, shown) => {
    expect(blankMarkerLookalikes(name)).toBe(shown);
  });

  it('a name of nothing but triangles is nothing left, so the row names its other field instead', () => {
    const all = codePointsOf(MARKER_LOOKALIKE_RANGES).map(ch).join('');
    expect(blankMarkerLookalikes(all).trim()).toBe('');
  });
});

describe.each(rowsOf(EXPECTED_ARROW_RANGES))(
  'F4: $range ($label) in a name on page 1',
  ({ from, to }) => {
    it('becomes a space, so the hint’s own `↓` is the only arrow on its row', () => {
      for (const code of codePointsOf([[from, to]])) {
        expect(urgentName(`a${ch(code)}b`), `U+${code.toString(16)}`).toBe('a b');
        // at the start and the end of a name too
        expect(urgentName(`${ch(code)} x ${ch(code)}`)).toBe('x');
      }
    });
  },
);

describe('F4: the brackets', () => {
  const pairs: (readonly [string, string])[] = [
    ['[', ']'],
    [ch(FULLWIDTH_OPEN), ch(FULLWIDTH_CLOSE)],
    ...BRACKET_PAIR_RANGES.flatMap(([from, to]) =>
      Array.from({ length: (to - from + 1) / 2 }, (_, pair): readonly [string, string] => [
        ch(from + pair * 2),
        ch(from + pair * 2 + 1),
      ]),
    ),
  ];
  const WORDS = ['Enter', 'Esc', 'Ctrl+Y', 'Ctrl+N', 'Tab', '/'] as const;
  const BRACKET_CODES = new Set([
    0x5b,
    0x5d,
    FULLWIDTH_OPEN,
    FULLWIDTH_CLOSE,
    ...codePointsOf(BRACKET_PAIR_RANGES),
  ]);
  const bracketsIn = (text: string): string[] =>
    Array.from(text).filter((character) => BRACKET_CODES.has(character.codePointAt(0) ?? 0));

  it('has a pair for every code point of the ranges (an even count, the first of each pair opening)', () => {
    expect(pairs).toHaveLength(2 + codePointsOf(BRACKET_PAIR_RANGES).length / 2);
    for (const [from, to] of BRACKET_PAIR_RANGES) expect((to - from + 1) % 2).toBe(0);
  });

  /** What a bracket becomes: its side's parenthesis, or a space when the Home's scrub blanked it first (the retired `❯` is a host glyph). */
  const becomes = (bracket: string, parenthesis: string): string =>
    flowLine(bracket).trim() === '' ? ' ' : parenthesis;

  it('turns the opening one into `(` and the closing one into `)`, each by the side of its pair', () => {
    for (const [open, close] of pairs) {
      expect(urgentName(`x${open}y${close}z`), `${open}${close}`).toBe(
        `x${becomes(open, '(')}y${becomes(close, ')')}z`.replace(/\s+/gu, ' '),
      );
    }
  });

  it('the one pair the scrub blanks first is the ornamental `❮ ❯`, whose closing half is the retired host glyph', () => {
    const blanked = pairs.filter(([open, close]) => becomes(open, '(') === ' ' || becomes(close, ')') === ' ');
    expect(blanked).toEqual([[ch(0x276e), ch(0x276f)]]);
  }); // prettier-ignore

  it('leaves no bracket of any table on a key word written in it, and never a bracketed key', () => {
    for (const [open, close] of pairs) {
      for (const word of WORDS) {
        const shown = urgentName(`${open}${word}${close} open`);
        expect(bracketsIn(shown), `${open}${word}${close}`).toEqual([]);
        expect(shown).not.toMatch(/\[[^\]]*\]/u);
      }
    }
  });

  it('a key word that is not a chord comes back as a plain word in parentheses', () => {
    for (const [open, close] of pairs) {
      for (const word of ['Enter', 'Esc', 'Tab', '/']) {
        expect(urgentName(`${open}${word}${close}`)).toBe(
          `${becomes(open, '(')}${word}${becomes(close, ')')}`.trim(),
        );
      }
    }
  });

  it('a chord is made inert by the scrub first: no `Ctrl+Y` or `Ctrl+N` survives the brackets', () => {
    for (const [open, close] of pairs) {
      for (const word of ['Ctrl+Y', 'Ctrl+N']) {
        expect(urgentName(`${open}${word}${close}`), `${open}${word}${close}`).not.toContain(word);
      }
    }
  });

  it('a pair with an arrow inside is both: the brackets fold, the arrow is a space', () => {
    expect(urgentName(`${ch(0x3010)}${ch(0x2193)}Enter${ch(0x3011)}`)).toBe('( Enter)');
  });
});

describe('F4: the whole name', () => {
  it('collapses every run of whitespace to one space, whatever character it is made of', () => {
    expect(urgentName('a   b')).toBe('a b');
    expect(urgentName(`a${ch(0xa0)}${ch(0xa0)}${ch(0xa0)}b`)).toBe('a b');
    expect(urgentName(`a${ch(0x3000)}${ch(0x2003)}\tb`)).toBe('a b');
    expect(urgentName(`x ${ch(0x2b07)} ${ch(0x2913)} ${ch(0x25bc)} y`)).toBe('x y');
  });

  it('stays inside its bound however the name is made', () => {
    const hostile = `${ch(0x3010)}Enter${ch(0x3011)} ${ch(0x2b07)}`.repeat(40);
    expect(displayWidth(urgentName(hostile))).toBeLessThanOrEqual(URGENT_NAME_COLUMNS);
  });

  it.each(['release-notes', '日本語のワークフロー', 'deploy (prod)'])(
    'a plain name (%s) is not changed',
    (name) => {
      expect(urgentName(name)).toBe(name);
    },
  );
});
