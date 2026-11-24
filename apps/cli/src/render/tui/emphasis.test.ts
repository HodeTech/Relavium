import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';

import {
  emphasisClose,
  emphasisDescription,
  emphasisKinds,
  emphasisOpen,
  emphasize,
  mergeEmphasis,
  SELECTED_ROW,
  withoutEmphasis,
  type Emphasis,
} from './emphasis.js';
import { displayWidth } from './viewport.js';

/**
 * The one rule for bold, inverse and underline ([ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5): the
 * SGR pair is written into the text, the same bytes whatever the colour setting, closed again, and never a colour.
 */
const ESC = String.fromCharCode(0x1b);
const sgr = (params: string): string => `${ESC}[${params}m`;
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, 'gu');
const stripSgr = (text: string): string => text.replace(SGR, '');

const ALL: readonly Emphasis[] = ['bold', 'inverse', 'underline'];
const PAIR: Readonly<Record<Emphasis, readonly [string, string]>> = {
  bold: [sgr('1'), sgr('22')],
  inverse: [sgr('7'), sgr('27')],
  underline: [sgr('4'), sgr('24')],
};

/** Every non-empty subset of the three styles. */
const SUBSETS: readonly (readonly Emphasis[])[] = [
  ['bold'],
  ['inverse'],
  ['underline'],
  ['bold', 'inverse'],
  ['bold', 'underline'],
  ['inverse', 'underline'],
  ['bold', 'inverse', 'underline'],
];

describe('emphasize: the pairs', () => {
  it.each(ALL)('%s is its opening sequence, the text, its closing one', (kind) => {
    const [open, close] = PAIR[kind];
    expect(emphasize('text', kind)).toBe(`${open}text${close}`);
    expect(emphasize('text', [kind])).toBe(`${open}text${close}`);
  });

  it('writes the exact bytes the chalk-drawn style used: bold 1/22, inverse 7/27, underline 4/24', () => {
    expect(emphasize('x', 'bold')).toBe('\u001b[1mx\u001b[22m');
    expect(emphasize('x', 'inverse')).toBe('\u001b[7mx\u001b[27m');
    expect(emphasize('x', 'underline')).toBe('\u001b[4mx\u001b[24m');
  });

  it('opens the styles in a fixed order and closes them in the reverse, whatever order they were asked for', () => {
    expect(emphasize('x', ['bold', 'inverse'])).toBe(
      `${sgr('1')}${sgr('7')}x${sgr('27')}${sgr('22')}`,
    );
    expect(emphasize('x', ['inverse', 'bold'])).toBe(emphasize('x', ['bold', 'inverse']));
    expect(emphasize('x', ['underline', 'inverse', 'bold'])).toBe(
      `${sgr('1')}${sgr('7')}${sgr('4')}x${sgr('24')}${sgr('27')}${sgr('22')}`,
    );
  });

  it('writes a style once however often it is asked for', () => {
    expect(emphasize('x', ['bold', 'bold'])).toBe(emphasize('x', 'bold'));
    expect(emphasisKinds(['inverse', 'bold', 'inverse'])).toEqual(['bold', 'inverse']);
  });

  it('closes every style it opened: each open has its own close after the text, in the reverse order', () => {
    for (const subset of SUBSETS) {
      const drawn = emphasize('text', subset);
      const opens = emphasisKinds(subset).map((kind) => PAIR[kind][0]);
      const closes = [...emphasisKinds(subset)].reverse().map((kind) => PAIR[kind][1]);
      expect(drawn, subset.join('+')).toBe(`${opens.join('')}text${closes.join('')}`);
      expect(emphasisOpen(subset)).toBe(opens.join(''));
      expect(emphasisClose(subset)).toBe(closes.join(''));
    }
  });
});

describe('emphasize: what it never does', () => {
  it('writes no colour code, whatever the styles and the text: every parameter is a weight, an inverse or an underline or their close', () => {
    const allowed = new Set(['1', '22', '7', '27', '4', '24']);
    for (const subset of SUBSETS) {
      for (const text of ['text', 'a b', '界', '']) {
        const codes = [...emphasize(text, subset).matchAll(SGR)].flatMap((match) =>
          (match[1] ?? '').split(';'),
        );
        expect(
          codes.filter((code) => !allowed.has(code)),
          `${subset.join('+')} on ${JSON.stringify(text)}`,
        ).toEqual([]);
      }
    }
  });

  it('is the text itself for an empty text, for no style and for an empty set: an empty pair would write bytes for nothing', () => {
    expect(emphasize('', 'bold')).toBe('');
    expect(emphasize('', SELECTED_ROW)).toBe('');
    expect(emphasize('text', [])).toBe('text');
    expect(emphasize('text', undefined)).toBe('text');
    expect(emphasize(emphasize('', 'inverse'), 'inverse')).toBe('');
    expect(emphasisOpen([])).toBe('');
    expect(emphasisClose(undefined)).toBe('');
  });

  it('leaves the text byte for byte: it is the caller’s to sanitise, and an ESC it carries is the caller’s problem, not rewritten here', () => {
    const hostile = `a${ESC}[31mb${ESC}[0m`;
    // The helper does not sanitise: the VIEWS pass text that `sanitizeInline` has already cleaned (the guard test spot-checks the sites).
    expect(emphasize(hostile, 'bold')).toBe(`${sgr('1')}${hostile}${sgr('22')}`);
    expect(stripSgr(emphasize('plain text', ['bold', 'inverse']))).toBe('plain text');
  });
});

describe('the sets', () => {
  it('SELECTED_ROW is bold and inverse: the selected row of every list (ADR-0145 §5)', () => {
    expect([...SELECTED_ROW]).toEqual(['bold', 'inverse']);
  });

  it('merges the styles of a row and of a stretch of it, each once, in the fixed order', () => {
    expect(mergeEmphasis('bold', 'inverse')).toEqual(['bold', 'inverse']);
    expect(mergeEmphasis(SELECTED_ROW, 'bold')).toEqual(['bold', 'inverse']);
    expect(mergeEmphasis(undefined, undefined)).toEqual([]);
    expect(mergeEmphasis(['underline'], ['bold'])).toEqual(['bold', 'underline']);
  });

  it('leaves a style off a set: a dimmed stretch of a selected row is inverse but not bold', () => {
    expect(withoutEmphasis(SELECTED_ROW, 'bold')).toEqual(['inverse']);
    expect(withoutEmphasis('bold', 'bold')).toEqual([]);
    expect(withoutEmphasis(undefined, 'bold')).toEqual([]);
  });

  it('describes a set as the entries a tone is named by, and an empty one as none', () => {
    expect(emphasisDescription('bold')).toEqual({ bold: true });
    expect(emphasisDescription(SELECTED_ROW)).toEqual({ bold: true, inverse: true });
    expect(emphasisDescription(undefined)).toEqual({});
  });
});

describe('widths', () => {
  const samples = ['abc', 'a b c', '界界界', 'é', '👩‍💻 ok', '› /help  show the keys'];

  it('a style is zero columns to the measurement ink draws with (string-width strips the sequence)', () => {
    for (const sample of samples)
      for (const subset of SUBSETS)
        expect(stringWidth(emphasize(sample, subset)), `${sample} ${subset.join('+')}`).toBe(
          stringWidth(sample),
        );
  });

  it('is the text alone to the CLI’s own width once the styling is taken off', () => {
    for (const sample of samples)
      expect(displayWidth(stripSgr(emphasize(sample, SELECTED_ROW)))).toBe(displayWidth(sample));
  });

  it('is NOT zero columns to displayWidth, which counts the escape bytes of a string it is given: a style is applied last, to a row already laid out and clipped', () => {
    // `displayWidth` measures with `countAnsiEscapeCodes: true` because the text it is given is already free of escapes (viewport.ts). That is
    // why this module's rule is "apply the style at the very end": a string that is measured, wrapped or clipped by displayWidth after
    // emphasize() would be measured wider than it is drawn. If displayWidth ever learns to skip SGR, this pin and that sentence go together.
    expect(displayWidth(emphasize('abc', 'bold'))).toBeGreaterThan(displayWidth('abc'));
  });
});
