import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { screenText } from './screen-text.js';
import { physicalRows, terminalColumns } from './terminal-wrap.test-support.js';
import { displayWidth } from './viewport.js';

/**
 * The simulated terminal of the margin's witness is BUILT FROM MEASUREMENTS (MVP-11 unit 9, review round 2, S2-1 and M2-4): review round 2
 * measured tmux 3.7b, the reference terminal, code point by code point (each string written to a pane after an `A`, the cursor read back with
 * `ESC[6n`; the recipe is the reviewer's `measure.py`, run in two locales). This table is those measurements, verbatim: the name of the probe,
 * its code points, and the columns tmux drew for them. The test holds `terminal-wrap.test-support.ts` to every one: the simulation draws each
 * string as wide as tmux did, no more and no less, so a witness that passes through it passes on tmux, and the classes `string-width` measures
 * narrower than tmux draws (the ones the screen's filter drops or the layout measures wider) are present in it, not guessed.
 */
export const TMUX_MEASUREMENTS: readonly (readonly [string, readonly number[], number])[] = [
  ['A', [0x41], 1],
  ['PCM 0600 then B', [0x600, 0x42], 1],
  ['PCM 0601 then B', [0x601, 0x42], 1],
  ['PCM 0602 then B', [0x602, 0x42], 1],
  ['PCM 0603 then B', [0x603, 0x42], 1],
  ['PCM 0604 then B', [0x604, 0x42], 1],
  ['PCM 0605 then B', [0x605, 0x42], 1],
  ['PCM 06dd then B', [0x6dd, 0x42], 1],
  ['PCM 070f then B', [0x70f, 0x42], 1],
  ['PCM 0890 then B', [0x890, 0x42], 1],
  ['PCM 0891 then B', [0x891, 0x42], 1],
  ['PCM 08e2 then B', [0x8e2, 0x42], 1],
  ['PCM 110bd then B', [0x110bd, 0x42], 1],
  ['PCM 110cd then B', [0x110cd, 0x42], 1],
  ['PCMx5 0600 then B', [0x600, 0x600, 0x600, 0x600, 0x600, 0x42], 1],
  ['Cf fff9', [0xfff9], 0],
  ['Cf fffa', [0xfffa], 0],
  ['Cf fffb', [0xfffb], 0],
  ['Cf 13430', [0x13430], 0],
  ['Cf 13438', [0x13438], 0],
  ['Cf 1343f', [0x1343f], 0],
  ['Cf 13440', [0x13440], 0],
  ['Cf 1bca0', [0x1bca0], 0],
  ['Cf 1d173', [0x1d173], 0],
  ['ka+aa (Mc 093e)', [0x915, 0x93e], 1],
  ['ka+aa x5', [0x915, 0x93e, 0x93e, 0x93e, 0x93e, 0x93e], 1],
  ['ka+visarga 0903', [0x915, 0x903], 1],
  ['tamil 0b95+0bbe', [0xb95, 0xbbe], 1],
  ['myanmar 1000+102b', [0x1000, 0x102b], 1],
  ['musical 1d165', [0x1d165], 0],
  ['a+1d165', [0x61, 0x1d165], 1],
  ['a + 0301 x10', [0x61, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301], 1],
  [
    'a + 0301 x40',
    [
      0x61, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301,
      0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301,
      0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x301,
      0x301, 0x301,
    ],
    1,
  ],
  ['lone 0301', [0x301], 0],
  ['2028', [0x2028], 0],
  ['2029', [0x2029], 0],
  ['fffd', [0xfffd], 1],
  ['family zwj', [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466], 2],
  ['thumb+tone', [0x1f44d, 0x1f3fd], 2],
  ['flag US', [0x1f1fa, 0x1f1f8], 2],
  ['lone RI', [0x1f1e6], 1],
  ['3 RI', [0x1f1e6, 0x1f1e7, 0x1f1e8], 3],
  ['heart vs16', [0x2764, 0xfe0f], 2],
  ['heart', [0x2764], 1],
  ['keycap 1', [0x31, 0xfe0f, 0x20e3], 2],
  ['black flag', [0x1f3f4], 2],
  [
    'black flag+7 tags (scotland)',
    [0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f],
    2,
  ],
  [
    'black flag+40 tags',
    [
      0x1f3f4, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061,
      0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061,
      0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061,
      0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061, 0xe0061,
      0xe0061,
    ],
    2,
  ],
  ['lone tag e0041', [0xe0041], 0],
  ['a+zwj', [0x61, 0x200d], 1],
  ['a+zwnj', [0x61, 0x200c], 1],
  ['a+vs16', [0x61, 0xfe0f], 2],
  ['a+vs15', [0x61, 0xfe0e], 1],
  ['zwj x10', [0x200d, 0x200d, 0x200d, 0x200d, 0x200d, 0x200d, 0x200d, 0x200d, 0x200d, 0x200d], 0],
  ['1161 jamo V', [0x1161], 0],
  ['11a8 jamo T', [0x11a8], 0],
  ['1100 L', [0x1100], 2],
  ['1100+1161', [0x1100, 0x1161], 2],
  ['d7b0', [0xd7b0], 0],
  ['ambig 00b7', [0xb7], 1],
  ['ambig 2026', [0x2026], 1],
  ['ambig 2500', [0x2500], 1],
  ['ambig 203a', [0x203a], 1],
  ['ambig 25b8', [0x25b8], 1],
  ['ambig 21c4', [0x21c4], 1],
  ['0e33 thai', [0xe33], 1],
  ['0e01+0e33', [0xe01, 0xe33], 2],
  ['1f3fb alone', [0x1f3fb], 2],
  ['e0001 lang tag', [0xe0001], 0],
  ['115f', [0x115f], 2],
  ['1160', [0x1160], 0],
  ['3164', [0x3164], 0],
  ['ffa0', [0xffa0], 1],
  ['ad', [0xad], 1],
  ['2061', [0x2061], 0],
  ['17b4', [0x17b4], 0],
  ['180e', [0x180e], 0],
  ['180f', [0x180f], 0],
  ['fe00', [0xfe00], 0],
  ['e0100', [0xe0100], 0],
  ['feff', [0xfeff], 0],
  ['200b', [0x200b], 0],
  ['a+20dd', [0x61, 0x20dd], 1],
  ['0488 Me', [0x61, 0x488], 1],
  ['a+0903 Mc', [0x61, 0x903], 1],
  ['a+093e Mc', [0x61, 0x93e], 1],
  ['a+093e x8', [0x61, 0x93e, 0x93e, 0x93e, 0x93e, 0x93e, 0x93e, 0x93e, 0x93e], 1],
  ['a+0e31 Mn thai', [0x61, 0xe31], 1],
  ['2e3b', [0x2e3b], 1],
  ['fdfd', [0xfdfd], 1],
  ['12219 cuneiform', [0x12219], 1],
  ['a9ff', [0xa9e], 1],
  [
    '(a vs16)x10',
    [
      0x61, 0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f, 0x61,
      0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f, 0x61, 0xfe0f,
    ],
    20,
  ],
  ['(space vs16)x5', [0x20, 0xfe0f, 0x20, 0xfe0f, 0x20, 0xfe0f, 0x20, 0xfe0f, 0x20, 0xfe0f], 10],
  ['(> vs16)x5', [0x3e, 0xfe0f, 0x3e, 0xfe0f, 0x3e, 0xfe0f, 0x3e, 0xfe0f, 0x3e, 0xfe0f], 10],
  ['a vs16 vs16 vs16', [0x61, 0xfe0f, 0xfe0f, 0xfe0f], 2],
  ['(digit vs16)x5', [0x31, 0xfe0f, 0x31, 0xfe0f, 0x31, 0xfe0f, 0x31, 0xfe0f, 0x31, 0xfe0f], 10],
  [
    '(cjk 4e00 vs16)x5',
    [0x4e00, 0xfe0f, 0x4e00, 0xfe0f, 0x4e00, 0xfe0f, 0x4e00, 0xfe0f, 0x4e00, 0xfe0f],
    10,
  ],
  [
    '(kaam)x10 thai',
    [
      0xe01, 0xe33, 0xe01, 0xe33, 0xe01, 0xe33, 0xe01, 0xe33, 0xe01, 0xe33, 0xe01, 0xe33, 0xe01,
      0xe33, 0xe01, 0xe33, 0xe01, 0xe33, 0xe01, 0xe33,
    ],
    20,
  ],
  ['thai word kamlang', [0xe01, 0xe33, 0xe25, 0xe31, 0xe07], 4],
  ['(lao 0e81 0eb3)x5', [0xe81, 0xeb3, 0xe81, 0xeb3, 0xe81, 0xeb3, 0xe81, 0xeb3, 0xe81, 0xeb3], 10],
  [
    '(RI AB)x5',
    [0x1f1e6, 0x1f1e7, 0x1f1e6, 0x1f1e7, 0x1f1e6, 0x1f1e7, 0x1f1e6, 0x1f1e7, 0x1f1e6, 0x1f1e7],
    10,
  ],
  [
    '(RI US)x5',
    [0x1f1fa, 0x1f1f8, 0x1f1fa, 0x1f1f8, 0x1f1fa, 0x1f1f8, 0x1f1fa, 0x1f1f8, 0x1f1fa, 0x1f1f8],
    10,
  ],
  ['a+1f3fd', [0x61, 0x1f3fd], 3],
  ['a+1f3fd x5', [0x61, 0x1f3fd, 0x1f3fd, 0x1f3fd, 0x1f3fd, 0x1f3fd], 11],
  ['(a 1f3fd)x5', [0x61, 0x1f3fd, 0x61, 0x1f3fd, 0x61, 0x1f3fd, 0x61, 0x1f3fd, 0x61, 0x1f3fd], 15],
  ['1100 1100 1161', [0x1100, 0x1100, 0x1161], 4],
  ['khmer 1780+17b6', [0x1780, 0x17b6], 1],
  ['ac00+11a8', [0xac00, 0x11a8], 2],
  ['a+fe0f+20e3', [0x61, 0xfe0f, 0x20e3], 2],
  ['2764 fe0e', [0x2764, 0xfe0e], 1],
  ['1f600 fe0e', [0x1f600, 0xfe0e], 2],
  ['2122 tm vs16', [0x2122, 0xfe0f], 2],
  ['00a9 vs16', [0xa9, 0xfe0f], 2],
  ['203c vs16', [0x203c, 0xfe0f], 2],
  ['family no-zwj-support? 1f468 200d 1f9b0', [0x1f468, 0x200d, 0x1f9b0], 2],
  ['a zwj b', [0x61, 0x200d, 0x62], 2],
  ['1f468 200d a', [0x1f468, 0x200d, 0x61], 3],
  [
    'emoji zwj x5 non-rgi',
    [0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600],
    2,
  ],
  ['1f1e6 alone then a', [0x1f1e6, 0x61], 2],
  ['0e33 alone after space', [0x20, 0xe33], 2],
  ['a + 0e33', [0x61, 0xe33], 2],
  ['a+0e33 x5', [0x61, 0xe33, 0xe33, 0xe33, 0xe33, 0xe33], 6],
  ['vs16 alone', [0xfe0f], 1],
  ['a vs15', [0x61, 0xfe0e], 1],
  ['1f3f4 + e0061', [0x1f3f4, 0xe0061], 2],
  ['a + e0061 (tag after a)', [0x61, 0xe0061], 1],
];

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

describe('the layout never measures a row narrower than tmux draws it, after the screen’s filter (S2-1)', () => {
  it.each(TMUX_MEASUREMENTS.map(([name, codes]) => [name, codes] as const))(
    '%s',
    (_name, codes) => {
      const text = screenText(`A${String.fromCodePoint(...codes)}x`);
      expect(displayWidth(text)).toBeGreaterThanOrEqual(terminalColumns(text));
    },
  );

  it('a hostile run of each class: the layout counts at least what the terminal draws', () => {
    const c = (code: number): string => String.fromCodePoint(code);
    for (const run of [
      `ok x${c(0x1f3fd).repeat(35)}`,
      `${'a'.repeat(3)}${c(0xfe0f)}`.repeat(20),
      `${c(0x0e01)}${c(0x0e33)}`.repeat(30),
      `${c(0x1f1e6)}${c(0x1f1e7)}`.repeat(30),
      String.fromCharCode(0xd800).repeat(30),
      `1${c(0xfe0f)}`.repeat(30),
    ]) {
      const text = screenText(run);
      expect(displayWidth(text), JSON.stringify(run.slice(0, 12))).toBeGreaterThanOrEqual(
        terminalColumns(text),
      );
    }
  });
});
