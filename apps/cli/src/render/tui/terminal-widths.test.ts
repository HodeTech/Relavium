import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';

import { screenText } from './screen-text.js';
import { physicalRows, terminalColumns } from './terminal-wrap.test-support.js';
import {
  TMUX_FILTERED,
  TMUX_MEASUREMENTS,
  TMUX_SEQUENCE_FINDINGS,
  TMUX_WIDER_CODE_POINTS,
} from './tmux-measurements.test-support.js';
import { displayWidth } from './viewport.js';

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
      // the safe direction: the layout may count a row wider than tmux draws it (it then leaves a column), never narrower
      expect(stringWidth(String.fromCodePoint(...codes))).toBeGreaterThanOrEqual(width);
    },
  );

  it('covers the filter’s output of every measured string, the sequences tmux draws by its own rules included', () => {
    const missing = [...TMUX_MEASUREMENTS, ...TMUX_SEQUENCE_FINDINGS]
      .map(([name, codes]) => [name, codesOf(screenText(String.fromCodePoint(...codes)))] as const)
      .filter(([, filtered]) => !filteredWidth.has(filtered.join(',')))
      .map(([name]) => name);
    expect(missing).toEqual([]);
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
