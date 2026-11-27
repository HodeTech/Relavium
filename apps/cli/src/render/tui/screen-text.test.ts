import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import {
  dropOrphanMarks,
  dropScreenFillers,
  escapeScreenText,
  isNarrowEmojiBase,
  screenPieces,
  ScreenStream,
  screenText,
} from './screen-text.js';
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

  it('a skin tone is dropped wherever it stands (round 3: tmux joins a tone to only some of the bases that take one)', () => {
    expect(screenText(`x${TONE.repeat(5)}`)).toBe('x');
    expect(screenText(`ok ${TONE}`)).toBe('ok ');
    expect(screenText(`${THUMB}${TONE}`)).toBe(THUMB);
    expect(screenText(`${THUMB}${TONE}${TONE}`)).toBe(THUMB);
    // a narrow base keeps its selector: `☝🏽` is four columns on tmux, two to the layout; `☝️` two to both
    expect(screenText(`${c(0x261d)}${TONE}`)).toBe(`${c(0x261d)}${VS16}`);
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

  it('an indicator that is not half of a flag is followed by a joiner; a flag stays as it is, with no joiner after it (round 3, R3S-2)', () => {
    expect(screenText(`${RI_A}${RI_B}`)).toBe(`${RI_A}${ZWNJ}${RI_B}${ZWNJ}`);
    expect(screenText(US)).toBe(US);
    expect(screenText(`${RI_A}${RI_B}${c(0x1f1e8)}`)).toBe(
      `${RI_A}${ZWNJ}${RI_B}${ZWNJ}${c(0x1f1e8)}${ZWNJ}`,
    );
    // consecutive flags: no joiner between them (a joiner after a flag is one column to the layout and two on tmux)
    expect(screenText(`${US}${US}`)).toBe(`${US}${US}`);
    expect(screenText(`${US}${RI_A}`)).toBe(`${US}${RI_A}${ZWNJ}`);
    // a joiner a model wrote after a flag goes, as everything that would join onto it
    expect(screenText(`${US}${ZWNJ}x`)).toBe(`${US}x`);
    expect(stringWidth(screenText(`${RI_A}${RI_B}`.repeat(5)))).toBe(10);
    expect(stringWidth(screenText(`${US}${ZWNJ}`.repeat(20)))).toBe(40);
  });
});

describe('the classes round 3 measured (review round 3: R3S-2 and the sweep of every code point a terminal draws wider)', () => {
  const US = `${c(0x1f1fa)}${c(0x1f1f8)}`;
  const HEART = `${c(0x2764)}${VS16}`;
  const SMILE = c(0x1f600);
  const TONE = c(0x1f3fd);

  it('the nine text-default emoji bases are drawn with their presentation selector (tmux two columns, the layout one without it)', () => {
    const bases = [0x261d, 0x26f9, 0x270c, 0x270d, 0x1f3cb, 0x1f3cc, 0x1f574, 0x1f575, 0x1f590].map(
      c,
    );
    for (const base of bases) {
      expect(isNarrowEmojiBase(base)).toBe(true);
      expect(screenText(base)).toBe(`${base}${VS16}`);
      expect(screenText(`${base}${VS15}`)).toBe(`${base}${VS16}`);
      expect(screenText(`${base}${VS16}`)).toBe(`${base}${VS16}`);
      expect(stringWidth(screenText(base))).toBe(2);
    }
    expect(isNarrowEmojiBase(c(0x1f44d))).toBe(false); // an emoji-presentation base is wide to both already
  });

  it('what would join onto an emoji the layout draws wide only as a whole is dropped (a joiner, a mark, a selector after it)', () => {
    for (const [unit, after] of [
      [US, ZWNJ],
      [US, ZWJ],
      [US, COMBINING_ACUTE],
      [US, VS15],
      [HEART, ZWNJ],
      [HEART, COMBINING_ACUTE],
      [`1${VS16}${KEYCAP}`, ZWNJ],
      [`${c(0x261d)}${VS16}`, ZWNJ],
    ] as const)
      expect(screenText(`${unit}${after}x`), JSON.stringify(unit + after)).toBe(`${unit}x`);
    // a joiner that starts a recommended sequence stays: the heart on fire
    expect(screenText(`${HEART}${ZWJ}${c(0x1f525)}`)).toBe(`${HEART}${ZWJ}${c(0x1f525)}`);
  });

  it('an emoji zero-width-joiner sequence: a recommended one kept (without its tones), any other written as its members', () => {
    expect(screenText(FAMILY)).toBe(FAMILY);
    expect(screenText(`${c(0x1f469)}${TONE}${ZWJ}${c(0x1f4bb)}`)).toBe(
      `${c(0x1f469)}${ZWJ}${c(0x1f4bb)}`,
    );
    // a narrow base in a sequence gets its selector (the fully-qualified form)
    expect(screenText(`${c(0x1f3cb)}${ZWJ}${c(0x2640)}${VS16}`)).toBe(
      `${c(0x1f3cb)}${VS16}${ZWJ}${c(0x2640)}${VS16}`,
    );
    // a chain of ten (tmux draws it as two clusters, four columns; the layout two): its members, each two columns to both
    const chain = Array.from({ length: 10 }, () => SMILE).join(ZWJ);
    expect(screenText(chain)).toBe(SMILE.repeat(10));
    expect(stringWidth(screenText(chain))).toBe(20);
  });

  it('the spacing tone marks the layout counts as nothing and tmux draws two columns are dropped', () => {
    for (const code of [0x302e, 0x302f, 0x16ff0, 0x16ff1])
      expect(screenText(`a${c(code)}b`), code.toString(16)).toBe('ab');
  });

  it('a Thai or Lao AM after an emoji the layout draws wide only as a whole keeps its vowel; its mark, which would join the emoji, goes', () => {
    expect(screenText(`${c(0x261d)}${c(0x0e33)}`)).toBe(`${c(0x261d)}${VS16}${c(0x0e32)}`);
    expect(screenText(`${US}${c(0x0eb3)}`)).toBe(`${US}${c(0x0eb2)}`);
  });

  it('is idempotent on the cases a first single pass missed (a removal put a joiner and an emoji side by side)', () => {
    for (const codes of [
      [
        0x1f469, 0x115f, 0x2764, 0x200d, 0x1f3fd, 0x1f600, 0x301, 0x31, 0x200c, 0x20, 0xfe0f,
        0x200d, 0xfe0e, 0xe0041,
      ],
      [
        0x302e, 0x2a, 0x1f1fa, 0x2122, 0x1f469, 0x200d, 0xfe0f, 0x2640, 0x1f1e6, 0x1f1e6, 0x261d,
        0x115f,
      ],
      [0x23, 0x200d, 0x200d, 0xe0041, 0xfe0e, 0xe007f, 0x1f3f4],
      [0x1f469, 0x1f3fd, 0xfe0f, 0x200d, 0xfe0f, 0xe0041, 0x302e, 0x1f600, 0x115f, 0x1f4bb],
      [0x115f, 0xfe0e, 0x261d, 0x115f, 0x0e33],
    ]) {
      const once = screenText(String.fromCodePoint(...codes));
      expect(screenText(once), codes.map((code) => code.toString(16)).join(' ')).toBe(once);
    }
  });

  it('is idempotent: run again over its own output (a laid-out row), it changes nothing', () => {
    const ALPHABET = [
      'a',
      ' ',
      '\n',
      '1',
      '#',
      US,
      c(0x1f1e6),
      c(0x1f1e7),
      ZWNJ,
      ZWJ,
      VS15,
      VS16,
      KEYCAP,
      TONE,
      c(0x261d),
      SMILE,
      c(0x2764),
      c(0x1f469),
      c(0x1f4bb),
      COMBINING_ACUTE,
      c(0x0e01),
      c(0x0e33),
      c(0x115f),
      c(0xe0041),
      BLACK_FLAG,
      c(0x302e),
    ];
    let state = 0x5eed1234;
    const next = (): number => {
      state = (state * 1103515245 + 12345) >>> 0;
      return state / 4294967296;
    };
    for (let n = 0; n < 20_000; n += 1) {
      let text = '';
      for (let k = 1 + Math.floor(next() * 14); k > 0; k -= 1)
        text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
      const once = screenText(text);
      expect(screenText(once), JSON.stringify(text)).toBe(once);
    }
  });
});

describe('the decision surfaces: written one-to-one (review rounds 3 and 4, R3S-4, R4-S-3)', () => {
  const TONE = c(0x1f3fd);
  const US = `${c(0x1f1fa)}${c(0x1f1f8)}`;

  it('a letter, a digit, printable ASCII and a flag as themselves; every other code point as its token, `<` included', () => {
    expect(escapeScreenText(`Ok${TONE}`)).toBe('Ok<U+1F3FD>');
    expect(escapeScreenText(`a${VS16}`)).toBe('a<U+FE0F>');
    expect(escapeScreenText(`x${c(0x302e)}`)).toBe('x<U+302E>');
    expect(escapeScreenText(`${c(0x0e17)}${c(0x0e33)}`)).toBe(`${c(0x0e17)}<U+0E33>`);
    expect(escapeScreenText(`${c(0x0e17)}${c(0x0e4d)}${c(0x0e32)}`)).toBe(
      `${c(0x0e17)}<U+0E4D>${c(0x0e32)}`,
    );
    expect(escapeScreenText(`${COMBINING_ACUTE}a`)).toBe('<U+0301>a');
    expect(escapeScreenText('a<b')).toBe('a<U+003C>b');
    expect(escapeScreenText(c(0x261d))).toBe('<U+261D>');
    expect(escapeScreenText(`${c(0x261d)}${VS16}`)).toBe('<U+261D><U+FE0F>');
    // a flag stays readable, a lone indicator is a token, and nothing the pass would insert appears (R4-S-3 item 4)
    expect(escapeScreenText(`${US}x`)).toBe(`${US}x`);
    expect(escapeScreenText(`${c(0x1f1e6)}${c(0x1f1e7)}`)).toBe('<U+1F1E6><U+1F1E7>');
    expect(escapeScreenText(`${US}${c(0x1f1e6)}`)).toBe(`${US}<U+1F1E6>`);
    expect(escapeScreenText('क्ष')).toBe('क<U+094D>ष');
    expect(escapeScreenText('a(b)', (ch) => ch === '(' || ch === ')')).toBe('a<U+0028>b<U+0029>');
  });

  it('one-to-one: strings the core admits as different never write alike, a literal token included', () => {
    const labels = [
      'Ok',
      `Ok${TONE}`,
      'Ok<U+1F3FD>',
      `Ok${TONE}${TONE}`,
      `Ok${VS16}`,
      US,
      `${c(0x1f1fa)}<U+1F1F8>`,
    ];
    const drawn = labels.map((label) => escapeScreenText(label));
    expect(new Set(drawn).size).toBe(labels.length);
    expect(drawn[2]).toBe('Ok<U+003C>U+1F3FD>');
  });
});

describe('the stream filter: the same text, whatever its chunks (review round 3, R3S-1)', () => {
  const ALPHABET = [
    'a',
    'b',
    ' ',
    '\n',
    '1',
    '#',
    c(0x1f1fa),
    c(0x1f1f8),
    c(0x1f1e6),
    ZWNJ,
    ZWJ,
    VS15,
    VS16,
    KEYCAP,
    c(0x1f3fd),
    c(0x261d),
    c(0x1f600),
    c(0x2764),
    c(0x1f469),
    COMBINING_ACUTE,
    c(0x0e01),
    c(0x0e33),
    c(0x115f),
    c(0xe0041),
    BLACK_FLAG,
  ];

  it('random texts in random chunks: the stream gives the filter of the whole text', () => {
    let state = 0x31337;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let n = 0; n < 5_000; n += 1) {
      let text = '';
      for (let k = 1 + Math.floor(next() * 30); k > 0; k -= 1)
        text += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
      text += ' END'; // a neutral ending: the stream lets everything through
      const stream = new ScreenStream();
      const units = [...text];
      let out = '';
      for (let at = 0; at < units.length; ) {
        const size = 1 + Math.floor(next() * 4);
        out += stream.append(units.slice(at, at + size).join(''));
        at += size;
      }
      expect(out, JSON.stringify(text)).toBe(screenText(text));
    }
  });

  it('holds back what a later chunk could change, and lets ordinary text through at once', () => {
    const stream = new ScreenStream();
    expect(stream.append('Sure, ')).toBe('Sure, ');
    expect(stream.append(c(0x1f1fa))).toBe(''); // half of a flag, or a lone indicator: not decided yet
    expect(stream.append(`${c(0x1f1f8)} ok`)).toBe(`${c(0x1f1fa)}${c(0x1f1f8)} ok`);
    expect(stream.append(c(0x261d))).toBe('');
    expect(stream.append(`${c(0x1f3fd)}!`)).toBe(`${c(0x261d)}${VS16}!`);
    stream.reset();
    expect(stream.append(`${COMBINING_ACUTE}x`)).toBe('x'); // a new stream starts a line: an orphan mark goes
  });

  it('a run with no neutral character is let through past the hold limit, width-safe at the cut', () => {
    const stream = new ScreenStream();
    let out = '';
    for (let k = 0; k < 3000; k += 1) out += stream.append(c(0x1f1e6));
    expect(out.length).toBeGreaterThan(0);
    expect(stringWidth(out)).toBe([...out].filter((ch) => ch === c(0x1f1e6)).length);
  });
});
