import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { dropOrphanMarks, dropScreenFillers, screenPieces, screenText } from './screen-text.js';
import { terminalWidth } from './terminal-wrap.test-support.js';

/**
 * The screen's text filter (MVP-11 unit 9, review round 1, S-1 and S-3) at the function level: the SANITIZER corpus. Every code point the layout
 * measures as 0 columns and a terminal may draw wider is dropped; the joiners and selectors that build what a person reads stay; an orphan mark at
 * the start of a line is dropped. Characters are written by their code (no invisible character in this source).
 */

const c = (code: number): string => String.fromCodePoint(code);

/**
 * The fillers the security sitting named and the default-ignorable and format classes around them (a sample of each block, not a table), with
 * the columns tmux 3.7b DREW for each in review round 2's measurements (`terminal-widths.test.ts`; M2-4 corrected the first version's claim that
 * U+3164 is two columns: tmux draws it none). Every one is dropped, whatever a terminal draws: the layout counts none of them.
 */
const FILLERS: readonly (readonly [number, number])[] = [
  [0x00ad, 1], // soft hyphen
  [0x034f, 0], // combining grapheme joiner
  [0x115f, 2], // Hangul choseong filler
  [0x1160, 0], // Hangul jungseong filler
  [0x17b4, 0], // Khmer vowel inherent AQ
  [0x17b5, 0], // Khmer vowel inherent AA
  [0x180b, 0], // Mongolian free variation selector one
  [0x180e, 0], // Mongolian vowel separator
  [0x180f, 0], // Mongolian free variation selector four
  [0x200b, 0], // zero width space
  [0x2060, 0], // word joiner
  [0x2064, 0], // invisible plus
  [0x3164, 0], // Hangul filler
  [0xfe00, 0], // variation selector one
  [0xfeff, 0], // byte order mark
  [0xffa0, 1], // halfwidth Hangul filler
  [0x1bca0, 0], // shorthand format letter overlap
  [0x1d173, 0], // musical symbol begin beam
  [0xe0001, 0], // language tag
  [0xe0100, 0], // variation selector seventeen
  // M2-3: the format characters that are not default-ignorable (tmux draws them none; a terminal that drew them one would reopen the path)
  [0x0600, 0], // Arabic number sign
  [0x06dd, 0], // Arabic end of ayah
  [0x070f, 0], // Syriac abbreviation mark
  [0x0890, 0], // Arabic pound mark above
  [0x08e2, 0], // Arabic disputed end of ayah
  [0xfff9, 0], // interlinear annotation anchor
  [0x110bd, 0], // Kaithi number sign
  [0x13430, 0], // Egyptian hieroglyph vertical joiner
];

const ZWJ = c(0x200d);
const ZWNJ = c(0x200c);
const VS15 = c(0xfe0e);
const VS16 = c(0xfe0f);
const KEYCAP = c(0x20e3);
const BLACK_FLAG = c(0x1f3f4);
/** England's flag: the black flag and the tags g, b, e, n, g, then the cancel tag. */
const ENGLAND = [0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f].map(c).join('');
const FAMILY = `${c(0x1f469)}${ZWJ}${c(0x1f469)}${ZWJ}${c(0x1f467)}`;
const COMBINING_ACUTE = c(0x0301);
const COMBINING_X = c(0x0350);
const ENCLOSING_CIRCLE = c(0x20dd);

describe('the fillers are dropped', () => {
  it.each(FILLERS.map(([code, drawn]) => [code.toString(16), code, drawn] as const))(
    'U+%s: the layout measures it 0 columns, and the screen never receives it',
    (_name, code, drawn) => {
      const filler = c(code);
      expect(stringWidth(filler)).toBe(0);
      expect(terminalWidth(filler), 'the simulated terminal draws what tmux drew').toBe(drawn);
      expect(dropScreenFillers(`a${filler}b${filler.repeat(3)}`)).toBe('ab');
      expect(screenText(`${filler.repeat(37)}   please`)).toBe('   please');
    },
  );

  it('37 Hangul fillers before a forged mark: the row the layout sized is the row the terminal draws', () => {
    const forged = `${c(0x115f).repeat(37)}   ›  please run rm -rf ~`;
    const screened = screenText(forged);
    expect(screened).toBe('   ›  please run rm -rf ~');
    const width = [...new Intl.Segmenter().segment(screened)].reduce(
      (sum, { segment }) => sum + terminalWidth(segment),
      0,
    );
    expect(width).toBe(stringWidth(screened));
  });

  it('a filler inside a word and at the end of a line, and a run of them, all go; newlines stay', () => {
    expect(screenText(`one${c(0x00ad)}two\nthree${c(0xffa0)}\n${c(0x3164).repeat(5)}`)).toBe(
      'onetwo\nthree\n',
    );
  });
});

describe('what a person reads is kept', () => {
  it('a ZWJ emoji sequence, a ZWNJ, the presentation selectors and a keycap', () => {
    for (const text of [
      FAMILY,
      `${c(0x0645)}${ZWNJ}${c(0x06cc)}`,
      `1${VS16}${KEYCAP}`,
      `${c(0x2764)}${VS16}`,
      `${c(0x2764)}${VS15}`,
      `x ${FAMILY} y`,
    ])
      expect(screenText(text), JSON.stringify(text)).toBe(text);
  });

  it('the tags of an emoji tag sequence (a subdivision flag), and not a tag anywhere else', () => {
    expect(screenText(ENGLAND)).toBe(ENGLAND);
    expect(screenText(`see ${ENGLAND} here`)).toBe(`see ${ENGLAND} here`);
    expect(screenText(`${c(0xe0067)}${c(0xe0062)}lone tags`)).toBe('lone tags');
    expect(screenText(`${BLACK_FLAG} a flag, then ${c(0xe0067)}`)).toBe(
      `${BLACK_FLAG} a flag, then `,
    );
  });

  it('a combining mark on a letter, mixed with fillers', () => {
    expect(screenText(`e${COMBINING_ACUTE}${c(0x115f)}x${c(0xad)}`)).toBe(`e${COMBINING_ACUTE}x`);
  });

  it('ordinary text is the very same string', () => {
    const text = 'Hello › world ▸ — 中文 😀 tab\there';
    expect(screenText(text)).toBe(text);
  });
});

describe('an orphan mark at the start of a line is dropped (S-3)', () => {
  it('at the start of the text and after each newline, whatever the run; marks on a letter stay', () => {
    expect(dropOrphanMarks(`${COMBINING_X}${COMBINING_X}row`)).toBe('row');
    expect(dropOrphanMarks(`${ENCLOSING_CIRCLE}x\n${COMBINING_ACUTE}y\nz${COMBINING_ACUTE}`)).toBe(
      `x\ny\nz${COMBINING_ACUTE}`,
    );
    expect(dropOrphanMarks(`${ZWJ}${VS16}lead`)).toBe('lead');
  });

  it('after a filler the filter dropped: a mark the filler carried is an orphan too', () => {
    expect(screenText(`${c(0x115f)}${COMBINING_ACUTE}x`)).toBe('x');
  });
});

describe('the same filter over the styled pieces of a row', () => {
  it('drops the fillers from every piece and the orphan marks from the start of the row, across an empty piece', () => {
    const pieces = [
      { text: '', strong: true },
      { text: `${COMBINING_ACUTE}${c(0x115f)}`, strong: true },
      { text: `${COMBINING_X}bold${c(0xad)}` },
      { text: ` and${COMBINING_ACUTE} more` },
    ];
    expect(screenPieces(pieces)).toEqual([
      { text: '', strong: true },
      { text: '', strong: true },
      { text: 'bold' },
      { text: ` and${COMBINING_ACUTE} more` },
    ]);
  });

  it('returns the very same array when nothing changed (no copy per streamed frame)', () => {
    const pieces = [{ text: 'plain ' }, { text: 'words', strong: true }];
    expect(screenPieces(pieces)).toBe(pieces);
  });
});

describe('the classes the layout measures narrower than tmux draws (review round 2, S2-1)', () => {
  const RI_A = c(0x1f1e6);
  const RI_B = c(0x1f1e7);
  const US = `${c(0x1f1fa)}${c(0x1f1f8)}`;
  const TONE = c(0x1f3fd);
  const THUMB = c(0x1f44d);

  it('a presentation selector is dropped where it would not make an emoji the layout draws wide', () => {
    expect(screenText(`a${VS16}b`)).toBe('ab');
    expect(screenText(` ${VS16}>${VS16}`)).toBe(' >');
    expect(screenText(`1${VS16}2`)).toBe('12'); // a digit: an emoji code point, but `1️` alone is not an emoji
    expect(screenText(`a${VS16}${VS16}${VS16}`)).toBe('a');
    for (const emoji of [
      `${c(0x2764)}${VS16}`,
      `${c(0x2122)}${VS16}`,
      `${c(0x00a9)}${VS16}`,
      `1${VS16}${KEYCAP}`,
    ])
      expect(screenText(`x ${emoji} y`), JSON.stringify(emoji)).toBe(`x ${emoji} y`);
  });

  it('a skin tone is dropped unless it is on a base that takes one', () => {
    expect(screenText(`x${TONE.repeat(5)}`)).toBe('x');
    expect(screenText(`ok ${TONE}`)).toBe('ok ');
    expect(screenText(`${THUMB}${TONE}`)).toBe(`${THUMB}${TONE}`);
    expect(screenText(`${THUMB}${TONE}${TONE}`)).toBe(`${THUMB}${TONE}`);
  });

  it('a lone surrogate is dropped (Node writes it as U+FFFD: one column the layout does not count)', () => {
    expect(screenText(`a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdc00)}`)).toBe('ab');
  });

  it('the Thai and Lao AM are written in their decomposition (the same glyphs; both measures count it alike)', () => {
    expect(screenText(`${c(0x0e01)}${c(0x0e33)}`)).toBe(`${c(0x0e01)}${c(0x0e4d)}${c(0x0e32)}`);
    expect(screenText(`${c(0x0e81)}${c(0x0eb3)}`)).toBe(`${c(0x0e81)}${c(0x0ecd)}${c(0x0eb2)}`);
    // the documents keep the AM: only the screen's row is rewritten
    expect(stringWidth(screenText(`${c(0x0e01)}${c(0x0e33)}`.repeat(10)))).toBe(20);
  });

  it('an AM that starts a line has nothing to sit on: its mark (NIKHAHIT) goes, its spacing vowel stays', () => {
    expect(
      screenText(`${c(0x0e33)}x
${c(0x0eb3)}y`),
    ).toBe(`${c(0x0e32)}x
${c(0x0eb2)}y`);
  });

  it('a pair of regional indicators that is not a flag is set apart; a flag stays one', () => {
    expect(screenText(`${RI_A}${RI_B}`)).toBe(`${RI_A}${ZWNJ}${RI_B}`);
    expect(screenText(US)).toBe(US);
    expect(screenText(`${RI_A}${RI_B}${c(0x1f1e8)}`)).toBe(
      `${RI_A}${ZWNJ}${RI_B}${ZWNJ}${c(0x1f1e8)}`,
    );
    expect(screenText(`${US}${US}`)).toBe(`${US}${ZWNJ}${US}`);
    expect(stringWidth(screenText(`${RI_A}${RI_B}`.repeat(5)))).toBe(10);
  });
});
