import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { screenText } from './screen-text.js';
import { physicalRows, terminalColumns } from './terminal-wrap.test-support.js';
import {
  TMUX_FILTERED,
  TMUX_MEASUREMENTS,
  TMUX_SEQUENCE_FINDINGS,
  TMUX_SEQUENCES,
  TMUX_WIDER_CODE_POINTS,
} from './tmux-measurements.test-support.js';
import { displayWidth, inkSafe } from './viewport.js';

/**
 * The widths the screen's filter is held to (MVP-11 unit 9, review rounds 2 and 3): what tmux 3.7b, the reference terminal, drew, from the
 * measurement tables (`tmux-measurements.test-support.ts`). Three holds: the simulated terminal draws every simulated measurement exactly as tmux
 * did (so a witness that passes through it passes on tmux); the layout never counts the filter's output narrower than the simulated terminal
 * draws it; and, the ground truth, the filter's output of EVERY measured string and of every code point the sweep found drawn wider was itself
 * measured on tmux, and the layout never counts it narrower (review round 3, R3S-2 and R3S-5: round 2 claimed the second for every hostile run
 * from the simulation alone, and consecutive flags proved it false).
 */

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
      // the safe direction: the layout may count a row wider than tmux draws it (it then leaves a column), never narrower; and ink, given the
      // text in its ink-safe form where it fits text itself, counts it so too
      const text = String.fromCodePoint(...codes);
      expect(displayWidth(text)).toBeGreaterThanOrEqual(width);
      expect(stringWidth(inkSafe(text))).toBeGreaterThanOrEqual(width);
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
    0x11f02,
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
      // the layout never counts a row narrower than tmux draws it; ink given the ink-safe form neither; the simulated terminal draws no less
      expect(displayWidth(text)).toBeGreaterThanOrEqual(width);
      expect(stringWidth(inkSafe(text))).toBeGreaterThanOrEqual(width);
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
