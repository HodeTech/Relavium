import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { screenText } from './screen-text.js';
import { layoutMarkdown } from '../markdown/layout.js';
import { parseMarkdown } from '../markdown/parser.js';
import { hardWrap } from './question-card.js';
import { physicalRows, terminalColumns } from './terminal-wrap.test-support.js';
import {
  TMUX_FILTERED,
  TMUX_MEASUREMENTS,
  TMUX_SEQUENCE_FINDINGS,
  TMUX_SEQUENCES,
  TMUX_WIDER_CODE_POINTS,
} from './tmux-measurements.test-support.js';
import {
  inContextStrings,
  TMUX_IN_CONTEXT_EVIDENCE,
  TMUX_JOINING_WIDER,
  TMUX_WHITELIST_EVIDENCE,
  TMUX_ZERO_AFTER_A_LETTER,
  whitelistStrings,
} from './tmux-whitelist.test-support.js';
import { displayWidth, fitColumns, measuredClusters, wrapWords } from './viewport.js';
import { yieldBetweenTests, yieldToRunner } from '../event-loop.test-support.js';

/**
 * The widths the screen's filter is held to (MVP-11 unit 9, review rounds 2 and 3): what tmux 3.7b, the reference terminal, drew, from the
 * measurement tables (`tmux-measurements.test-support.ts`). Three holds: the simulated terminal draws every simulated measurement exactly as tmux
 * did (so a witness that passes through it passes on tmux); the layout never counts the filter's output narrower than the simulated terminal
 * draws it; and, the ground truth, the filter's output of EVERY measured string and of every code point the sweep found drawn wider was itself
 * measured on tmux, and the layout never counts it narrower (review round 3, R3S-2 and R3S-5: round 2 claimed the second for every hostile run
 * from the simulation alone, and consecutive flags proved it false).
 */

// the file's tests run for tens of seconds: the event loop turns between them, and in the long loops, so the runner's worker stays answered
yieldBetweenTests();

describe('the simulated terminal draws what tmux 3.7b drew', () => {
  it.each(TMUX_MEASUREMENTS.map(([name, codes, width]) => [name, codes, width] as const))(
    '%s',
    (_name, codes, width) => {
      // measured after an `A`: the probe's own columns are the total less the `A`'s one
      const text = String.fromCodePoint(...codes);
      expect(terminalColumns(`A${text}`) - 1).toBe(width);
    },
  );

  it('differs from `string-width` exactly on the classes round 2 found (so the witness has teeth there)', () => {
    const wider = TMUX_MEASUREMENTS.filter(
      ([, codes, width]) => width > stringWidth(`A${String.fromCodePoint(...codes)}`) - 1,
    ).map(([name]) => name);
    expect(wider).toEqual(
      expect.arrayContaining([
        '(a vs16)x10',
        '(digit vs16)x5',
        'a+1f3fd',
        '0e01+0e33',
        '(RI AB)x5',
        '115f',
        'ffa0',
        'ad',
      ]),
    );
  });
});

describe('the simulated terminal’s TAB (S2-1: the layout counts it as nothing)', () => {
  it('moves to the next multiple of eight', () => {
    expect(terminalColumns('\t')).toBe(8);
    expect(terminalColumns('abc\t')).toBe(8);
    expect(terminalColumns('\t', 5)).toBe(3);
  });

  it('stops at the last column and never wraps by itself; what follows it does', () => {
    // twelve tabs reach the last column (79): `a` takes it, `b` no longer fits and starts the next physical row
    expect(physicalRows([`${'\t'.repeat(12)}ab`], 80)).toEqual([`${'\t'.repeat(12)}a`, 'b']);
    expect(physicalRows(['\t'.repeat(12)], 80)).toEqual(['\t'.repeat(12)]);
  });
});

describe('the layout never measures a row narrower than tmux draws it, after the screen’s filter (the simulation: S2-1)', () => {
  it.each(TMUX_MEASUREMENTS.map(([name, codes]) => [name, codes] as const))(
    '%s',
    (_name, codes) => {
      const text = screenText(`A${String.fromCodePoint(...codes)}x`);
      expect(displayWidth(text)).toBeGreaterThanOrEqual(terminalColumns(text));
    },
  );

  it('a hostile run of each class: the layout counts at least what the simulated terminal draws', () => {
    const c = (code: number): string => String.fromCodePoint(code);
    const US = `${c(0x1f1fa)}${c(0x1f1f8)}`;
    for (const run of [
      `ok x${c(0x1f3fd).repeat(35)}`,
      `${'a'.repeat(3)}${c(0xfe0f)}`.repeat(20),
      `${c(0x0e01)}${c(0x0e33)}`.repeat(30),
      `${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(30),
      String.fromCharCode(0xd800).repeat(30),
      `1${c(0xfe0f)}`.repeat(30),
      // review round 3: consecutive flags, a joiner after a flag, the narrow bases, a tone on a base tmux does not join it to, the wide marks
      US.repeat(30),
      `${US}${c(0x200c)}`.repeat(30),
      `${c(0x2764)}${c(0xfe0f)}${c(0x200c)}`.repeat(30),
      c(0x261d).repeat(30),
      `${c(0x261d)}${c(0x1f3fd)}`.repeat(30),
      `${c(0x1f3c3)}${c(0x1f3fd)}`.repeat(30),
      `a${c(0x302e)}`.repeat(30),
    ]) {
      const text = screenText(run);
      expect(displayWidth(text), JSON.stringify(run.slice(0, 12))).toBeGreaterThanOrEqual(
        terminalColumns(text),
      );
    }
  });
});

/** The code points of a string, as the tables hold them. */
const codesOf = (text: string): readonly number[] => [...text].map((ch) => ch.codePointAt(0) ?? 0);
const filteredWidth = new Map(
  TMUX_FILTERED.map(([, codes, width]) => [codes.join(','), width] as const),
);

describe('the filter’s output, measured on tmux itself: the layout never counts it narrower (review round 3, R3S-2)', () => {
  it.each(TMUX_FILTERED.map(([name, codes, width]) => [name, codes, width] as const))(
    '%s',
    (_name, codes, width) => {
      // the safe direction: the layout may count a row wider than tmux draws it (it then leaves a column), never narrower (where ink would
      // count it narrower, the layout fits the row before ink sees it: `inkRows`, review round 5)
      const text = String.fromCodePoint(...codes);
      expect(displayWidth(text)).toBeGreaterThanOrEqual(width);
    },
  );

  it('covers the filter’s output of every measured string, the sequences tmux draws by its own rules included', () => {
    // a string the filter leaves as it is was measured as it is (the raw tables); every other one's output was measured on its own
    const measured = new Map(filteredWidth);
    for (const [, codes, width] of [
      ...TMUX_MEASUREMENTS,
      ...TMUX_SEQUENCE_FINDINGS,
      ...TMUX_SEQUENCES,
    ])
      if (!measured.has(codes.join(','))) measured.set(codes.join(','), width);
    const missing = [...TMUX_MEASUREMENTS, ...TMUX_SEQUENCE_FINDINGS]
      .map(([name, codes]) => [name, codesOf(screenText(String.fromCodePoint(...codes)))] as const)
      .filter(([, filtered]) => !measured.has(filtered.join(',')))
      .map(([name]) => name);
    expect(missing).toEqual([]);
    for (const [name, codes] of [...TMUX_MEASUREMENTS, ...TMUX_SEQUENCE_FINDINGS]) {
      const filtered = screenText(String.fromCodePoint(...codes));
      expect(displayWidth(filtered), name).toBeGreaterThanOrEqual(
        measured.get(codesOf(filtered).join(',')) ?? Infinity,
      );
    }
  });

  it('every code point the sweep found drawn wider than the layout counts it is dropped, or drawn in a measured form', () => {
    for (const [first, last, drawn] of TMUX_WIDER_CODE_POINTS)
      for (let code = first; code <= last; code += 1) {
        const filtered = screenText(String.fromCodePoint(code));
        expect(stringWidth(String.fromCodePoint(code)), code.toString(16)).toBeLessThan(drawn);
        if (filtered === '') continue;
        const width = filteredWidth.get(codesOf(filtered).join(','));
        expect(width, `${code.toString(16)}: its filtered form was measured`).toBeDefined();
        expect(stringWidth(filtered), code.toString(16)).toBeGreaterThanOrEqual(width ?? Infinity);
      }
  });
});

/** A string with an Indic linker or a Prepend letter in it (what the simulated terminal models as a sequence). */
const JOINS_SPACING = new RegExp(
  `[${[
    0x094d, 0x09cd, 0x0acd, 0x0b4d, 0x0c4d, 0x0d4d, 0x1039, 0x17d2, 0x1a60, 0x1b44, 0x1bab, 0xa9c0,
    0xaaf6, 0x10a3f, 0x11133, 0x113d0, 0x1193e, 0x11a47, 0x11a99, 0x11f42, 0x0d4e, 0x111c2, 0x111c3,
    0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86, 0x11a87, 0x11a88, 0x11a89, 0x11d46,
    0x11f02, 0x16d63, 0x16d67, 0x16d68, 0x16d69, 0x16d6a,
  ]
    .map((code) => String.fromCodePoint(code))
    .join('')}]`,
  'u',
);

describe('the SEQUENCE differential against tmux (review round 4, R4-S-1, item A)', () => {
  it.each(TMUX_SEQUENCES.map(([name, codes, width]) => [name, codes, width] as const))(
    '%s',
    (_name, codes, width) => {
      const text = String.fromCodePoint(...codes);
      // the layout never counts a row narrower than tmux draws it; the simulated terminal draws no less
      expect(displayWidth(text)).toBeGreaterThanOrEqual(width);
      // the simulated terminal models a conjunct and a Prepend cluster (not tmux's own rules for a run of Hangul vowel jamo, which the layout
      // counts wider anyway)
      if (JOINS_SPACING.test(text))
        expect(terminalColumns(`A${text}`) - 1).toBeGreaterThanOrEqual(width);
    },
  );

  it('the sample holds the undercounts it was taken for: string-width alone counts hundreds of them narrower than tmux drew', () => {
    const under = TMUX_SEQUENCES.filter(
      ([, codes, width]) => stringWidth(String.fromCodePoint(...codes)) < width,
    );
    expect(under.length).toBeGreaterThan(300);
  });

  it('the linkers and Prepend letters the measure knows are the ones this runtime’s segmenter joins (re-derived)', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const clusters = (text: string): number => [...segmenter.segment(text)].length;
    const derivedPrepend: number[] = [];
    for (let code = 0x80; code < 0x110000; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCodePoint(code);
      if (/\p{Cc}/u.test(character)) continue;
      if (clusters(`${character}a`) === 1) derivedPrepend.push(code);
    }
    // each joins what follows it into one cluster, and the measure counts the spacing characters of that cluster
    expect(derivedPrepend).toHaveLength(27);
    for (const code of derivedPrepend)
      expect(displayWidth(`${String.fromCodePoint(code)}y`), code.toString(16)).toBe(
        stringWidth(String.fromCodePoint(code)) + 1,
      );
    const derivedLinkers: number[] = [];
    for (let code = 0x80; code < 0x110000; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const mark = String.fromCodePoint(code);
      if (!/\p{M}/u.test(mark)) continue;
      const block = code & ~0x7f;
      for (
        let letter = Math.max(0, block - 0x80);
        letter < Math.min(0x110000, block + 0x100);
        letter += 1
      ) {
        if (letter >= 0xd800 && letter <= 0xdfff) continue;
        const l = String.fromCodePoint(letter);
        if (!/\p{L}/u.test(l) || clusters(`a${l}`) !== 2 || clusters(`${l}a`) !== 2) continue;
        if (clusters(`${l}${mark}${l}`) === 1) {
          derivedLinkers.push(code);
          expect(displayWidth(`${l}${mark}${l}`), code.toString(16)).toBe(2 * stringWidth(l));
          break;
        }
      }
    }
    expect(derivedLinkers.map((code) => code.toString(16))).toEqual([
      '94d',
      '9cd',
      'acd',
      'b4d',
      'c4d',
      'd4d',
      '1039',
      '17d2',
      '1a60',
      '1b44',
      '1bab',
      'a9c0',
      'aaf6',
      '10a3f',
      '11133',
      '113d0',
      '1193e',
      '11a47',
      '11a99',
      '11f42',
    ]);
  }, 120_000);
});

describe('the joins the measure keeps at `string-width`’s count are the ones measured on tmux (review round 5, R5-S-4)', () => {
  it('this runtime’s recommended sequences and Hangul blocks are the measured ones, and the measure keeps `string-width`’s count for each', async () => {
    const strings = await whitelistStrings();
    for (const kind of ['presentation', 'keycap', 'flag', 'tagFlag', 'zwj'] as const) {
      expect(strings[kind], kind).toHaveLength(TMUX_WHITELIST_EVIDENCE[kind].strings);
      // tmux drew every one of them exactly as `string-width` counts it (the evidence's `exact`), and that is what the measure says
      expect(TMUX_WHITELIST_EVIDENCE[kind].exact).toBe(TMUX_WHITELIST_EVIDENCE[kind].strings);
      for (const text of strings[kind]) {
        await yieldToRunner();
        expect(displayWidth(text), `${kind} ${text}`).toBe(stringWidth(text));
        expect(displayWidth(text), `${kind} ${text}`).toBe(2);
      }
    }
    // a toned sequence is not kept: tmux drew 315 of them wider than `string-width`, so it counts the sum, never less than `string-width`
    expect(strings.modifier).toHaveLength(TMUX_WHITELIST_EVIDENCE.modifier.strings);
    for (const text of strings.modifier) {
      await yieldToRunner();
      expect(displayWidth(text), text).toBeGreaterThan(stringWidth(text));
    }
    expect(strings.hangul).toHaveLength(TMUX_WHITELIST_EVIDENCE.hangul.strings);
    expect(TMUX_WHITELIST_EVIDENCE.hangul.wider).toBe(0);
    for (const text of strings.hangul) {
      await yieldToRunner();
      expect(displayWidth(text), text).toBe(stringWidth(text));
    }
  }, 120_000);

  it('every code point that joins a letter was measured after one: drawn in no column, or one of the fourteen that add columns', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const zero = (code: number): boolean =>
      TMUX_ZERO_AFTER_A_LETTER.some(([first, last]) => code >= first && code <= last);
    const wider = new Map(TMUX_JOINING_WIDER);
    let joining = 0;
    for (let code = 0x80; code < 0x110000; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const text = `a${String.fromCodePoint(code)}`;
      if ([...segmenter.segment(text)].length !== 1) continue;
      joining += 1;
      const added = wider.get(code);
      if (added === undefined) {
        expect(zero(code), code.toString(16)).toBe(true);
        expect(displayWidth(text), code.toString(16)).toBe(1);
      } else {
        // the sum counts what tmux added, or the screen's filter drops the code point (a tone, a wide tone mark)
        expect(displayWidth(screenText(text)), code.toString(16)).toBeGreaterThanOrEqual(
          screenText(text) === text ? 1 + added : 1,
        );
      }
    }
    expect(joining).toBe(2619);
    expect(TMUX_ZERO_AFTER_A_LETTER.reduce((sum, [first, last]) => sum + last - first + 1, 0)).toBe(
      2605,
    );
  }, 120_000);

  it('a string the measure counts whole (no code point that can join another) is counted as its clusters are, against every kind of neighbour', async () => {
    // the fast path: `displayWidth` counts a string with no joining code point as `string-width` does; a combining mark and a line feed before
    // it force the cluster path (a line feed ends every cluster, and both count nothing), and the two must agree for every code point of the planes text uses beside a letter, a consonant, a Hangul
    // leading jamo and syllable, a regional indicator, a Prepend letter and an emoji with a joiner, on either side (every code point of the other
    // planes is an ideograph, private use or unassigned, which joins nothing)
    const c = (code: number): string => String.fromCodePoint(code);
    const NEIGHBOURS = [
      'a',
      'क',
      c(0x1100),
      c(0xac00),
      c(0x1f1fa),
      c(0x0d4e),
      `${c(0x2764)}${c(0xfe0f)}${c(0x200d)}`,
    ];
    for (let code = 0x20; code < 0x110000; code += 1) {
      if (code % 256 === 0) await yieldToRunner();
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = c(code);
      if (code >= 0x20000 && (code < 0xe0000 || code > 0xe0fff)) {
        expect(/^[\p{Lo}\p{Co}\p{Cn}]$/u.test(character), code.toString(16)).toBe(true);
        continue;
      }
      for (const neighbour of NEIGHBOURS)
        for (const text of [`${neighbour}${character}`, `${character}${neighbour}`])
          expect(displayWidth(text), `${code.toString(16)} ${JSON.stringify(text)}`).toBe(
            displayWidth(`${c(0x0301)}\n${text}`),
          );
    }
  }, 300_000);
});

describe('the round-5 sitting’s reproductions, measured on tmux (review round 5, R5-S-1, R5-S-2, R5-S-4, R5-S-5)', () => {
  const c = (...codes: readonly number[]): string => String.fromCodePoint(...codes);
  const TAG_FLAG = c(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
  const KIRAT_RAI = [0x16d63, 0x16d67, 0x16d68, 0x16d69, 0x16d6a];
  const PREPENDS = [
    0x0d4e, 0x111c2, 0x111c3, 0x113d1, 0x1193f, 0x11941, 0x11a84, 0x11a85, 0x11a86, 0x11a87,
    0x11a88, 0x11a89, 0x11d46, 0x11f02,
  ];
  it.each([
    ['❤️ and a halfwidth voiced mark', c(0x2764, 0xfe0f, 0xff9e), 3],
    ['☝️ and a halfwidth voiced mark', c(0x261d, 0xfe0f, 0xff9e), 3],
    ['a flag and a halfwidth voiced mark', c(0x1f1fa, 0x1f1f8, 0xff9e), 3],
    ['a keycap and a halfwidth voiced mark', c(0x23, 0xfe0f, 0x20e3, 0xff9e), 3],
    [
      'a family and 42 halfwidth voiced marks',
      `${c(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}${c(0xff9e).repeat(42)}`,
      44,
    ],
    ['ൎ❤️ ten times', c(0x0d4e, 0x2764, 0xfe0f).repeat(10), 30],
    ...PREPENDS.flatMap((code) => [
      [`Prepend ${code.toString(16)} before ❤️`, c(code, 0x2764, 0xfe0f), 3] as const,
      [
        `Prepend ${code.toString(16)} before ☝ (the filter adds U+FE0F)`,
        c(code, 0x261d),
        3,
      ] as const,
    ]),
    ['four Kirat Rai vowel signs', c(0x16d63, 0x16d67, 0x16d68, 0x16d69), 4],
    [
      '74 Kirat Rai vowel signs',
      c(...Array.from({ length: 74 }, (_, at) => KIRAT_RAI[at % 5] ?? 0x16d63)),
      74,
    ],
    ['a Hangul syllable and a Kirat Rai vowel sign', c(0xac00, 0x16d63), 3],
    ['Kirat Rai consonant, vowel, vowel, ten times', c(0x16d43, 0x16d63, 0x16d67).repeat(10), 30],
    [
      'thirteen tag flags joined by zero width joiners',
      Array.from({ length: 13 }, () => TAG_FLAG).join(c(0x200d)),
      26,
    ],
    ['a tag flag, a joiner and a planet', `${TAG_FLAG}${c(0x200d, 0x1fa90)}`, 4],
    // the one the sum cannot fix: tmux glues the couple into the letter's cell, and with five to seven marks draws one column more (the filter
    // drops the joiner; what is left was measured at 3)
    [
      'a letter, five marks, a joiner and a couple',
      c(
        0x61,
        0x301,
        0x301,
        0x301,
        0x301,
        0x301,
        0x200d,
        0x1f469,
        0x200d,
        0x2764,
        0xfe0f,
        0x200d,
        0x1f469,
      ),
      3,
    ],
  ] as const)('%s', (_name, text, drawn) => {
    expect(displayWidth(screenText(text))).toBeGreaterThanOrEqual(drawn);
  });

  it('the filter drops a joiner before a pictograph that does not follow an emoji, and keeps one before a letter or after an emoji', () => {
    const couple = c(0x1f469, 0x200d, 0x2764, 0xfe0f, 0x200d, 0x1f469);
    expect(screenText(`a${c(0x301).repeat(5)}${c(0x200d)}${couple}`)).toBe(
      `a${c(0x301).repeat(5)}${couple}`,
    );
    expect(screenText(`क${c(0x200d)}${c(0x2764, 0xfe0f)}`)).toBe(`क${c(0x2764, 0xfe0f)}`);
    // an Indic joiner before a letter stays (`क्‍ष`), and so does a recommended sequence's own joiner
    expect(screenText(c(0x915, 0x94d, 0x200d, 0x937))).toBe(c(0x915, 0x94d, 0x200d, 0x937));
    expect(screenText(couple)).toBe(couple);
    // and after a tag flag (an emoji sequence), the joiner stays: the measure counts the chain as the sum of its pictographs
    expect(screenText(`${TAG_FLAG}${c(0x200d, 0x1fa90)}`)).toBe(`${TAG_FLAG}${c(0x200d, 0x1fa90)}`);
  });
});

describe('a recommended sequence after a joiner that ends a cluster (review round 6, R6-S-1)', () => {
  const c = (...codes: readonly number[]): string => String.fromCodePoint(...codes);
  const RAINBOW = c(0x1f3f3, 0xfe0f, 0x200d, 0x1f308);
  const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  /**
   * Whether `text` holds a cluster ending in U+200D right before a recommended sequence holding U+FE0F (what tmux glues and widens); with
   * `pictograph`, only a sequence that starts with a pictograph (what the filter's rule drops the joiner before; a keycap is the measure's).
   */
  const keptJoinerBeforeSelectorSequence = (text: string, pictograph = false): boolean => {
    const parts = Array.from(segmenter.segment(text), ({ segment }) => segment);
    return parts.some((part, at) => {
      const next = parts[at + 1] ?? '';
      return (
        part.endsWith(c(0x200d)) &&
        [...next].length > 1 &&
        next.includes(c(0xfe0f)) &&
        RGI.test(next) &&
        (!pictograph || /^\p{Extended_Pictographic}/u.test(next))
      );
    });
  };

  it('every recommended sequence in each of the 44 measured contexts: the count measured, and after the filter no joiner is left to glue a pictograph', async () => {
    const strings = await inContextStrings();
    expect(strings).toHaveLength(TMUX_IN_CONTEXT_EVIDENCE.strings);
    expect(new Set(strings.map(([name]) => name)).size).toBe(TMUX_IN_CONTEXT_EVIDENCE.contexts);
    expect(TMUX_IN_CONTEXT_EVIDENCE.exact + TMUX_IN_CONTEXT_EVIDENCE.over).toBe(
      TMUX_IN_CONTEXT_EVIDENCE.strings,
    );
    expect(TMUX_IN_CONTEXT_EVIDENCE.under).toBe(0);
    for (const [name, text] of strings) {
      await yieldToRunner();
      const filtered = screenText(text);
      // the filter leaves no joiner to glue a pictograph's sequence; one before a keycap is the measure's (its column more, below)
      expect(
        keptJoinerBeforeSelectorSequence(filtered, true),
        `${name} ${JSON.stringify(filtered)}`,
      ).toBe(false);
      expect(displayWidth(filtered), `${name} ${JSON.stringify(filtered)}`).toBeGreaterThanOrEqual(
        terminalColumns(filtered),
      );
    }
  }, 120_000);

  it.each([
    // measured on tmux with the joiner kept (the filter before this round): two, then four once the letter's cell overflows, then three
    [0, 2],
    [5, 2],
    [7, 4],
    [13, 3],
  ] as const)(
    'the measure alone (no filter): a letter, %i marks, U+FE0E or U+20E3, a joiner and `🏳️‍🌈` count at least what tmux drew (%i)',
    (marks, drawn) => {
      for (const selector of [0xfe0e, 0x20e3]) {
        const text = `a${c(0x301).repeat(marks)}${c(selector, 0x200d)}${RAINBOW}`;
        expect(keptJoinerBeforeSelectorSequence(text, true)).toBe(true);
        expect(displayWidth(text)).toBeGreaterThanOrEqual(drawn);
        expect(displayWidth(text)).toBe(4);
        // the walks the cutters and the wraps use count it as the measure does: one row of three columns cannot hold it
        expect([...measuredClusters(text)].reduce((sum, cluster) => sum + cluster.width, 0)).toBe(
          4,
        );
        expect(wrapWords(text, 3).length).toBeGreaterThan(1);
        expect(displayWidth(fitColumns(text, 3))).toBeLessThanOrEqual(3);
      }
    },
  );

  it('every wrap that measures a row by its clusters counts the sequence after the joiner as the measure does: the markdown layout, the question card', () => {
    const text = `${`a${c(0x301).repeat(7)}${c(0xfe0e, 0x200d)}${RAINBOW}`.repeat(5)}`;
    expect(displayWidth(text)).toBe(20);
    for (const width of [6, 7, 9, 11]) {
      for (const row of layoutMarkdown(parseMarkdown(text), width))
        expect(displayWidth(row.text), `${String(width)}: ${row.text}`).toBeLessThanOrEqual(width);
      for (const row of hardWrap(text, width))
        expect(displayWidth(row), `${String(width)}: ${row}`).toBeLessThanOrEqual(width);
    }
  });

  it('the filter drops the joiner after a text selector or a keycap mark that follows a letter, and keeps the Indic and Arabic ones', () => {
    for (const selector of [0xfe0e, 0x20e3]) {
      const raw = `a${c(0x301).repeat(7)}${c(selector, 0x200d)}${RAINBOW}`;
      expect(screenText(raw)).toBe(`a${c(0x301).repeat(7)}${c(selector)}${RAINBOW}`);
    }
    for (const kept of [
      c(0x915, 0x94d, 0x200d, 0x937),
      c(0x628, 0x200d, 0x628),
      c(0xd28, 0xd4d, 0x200d),
    ])
      expect(screenText(kept)).toBe(kept);
  });

  it('the Mongolian vowel separator is kept: tmux draws it in no column, and the layout counts none (review round 6, I-2)', () => {
    const word = c(0x1820, 0x180e, 0x1820);
    expect(screenText(word)).toBe(word);
    expect(displayWidth(word)).toBe(2); // measured on tmux: 2
  });
});
