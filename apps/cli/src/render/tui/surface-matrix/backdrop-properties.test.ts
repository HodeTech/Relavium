import '../force-color.js';

import { describe, expect, it } from 'vitest';

import { runCell } from './cells.js';
import { checkBackdropDim, type PopupBox } from './properties.js';
import { problemsOf } from './run-cell.js';
import { HOME_SURFACES } from './surfaces-home.js';
import { PLAIN_CELL_STYLE, type CellStyle, type ScreenCell } from './terminal.js';
import type { Variant } from './variants.js';

/**
 * The `backdrop-dim` property of the surface matrix ([ADR-0148](../../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §4), shown to fail on a screen made to break each clause of it, and then through the real pipeline (a mounted Home whose dim codes are
 * stripped on the way to the terminal), so a green matrix means the backdrop is dim and not that the check cannot see.
 */

const ESC = String.fromCharCode(0x1b);

const ALT_COLOUR: Variant = { renderer: 'alt', color: true, size: { cols: 20, rows: 8 } };
const ALT_PLAIN: Variant = { ...ALT_COLOUR, color: false };
const INLINE_COLOUR: Variant = { ...ALT_COLOUR, renderer: 'inline' };

const style = (patch: Partial<CellStyle> = {}): CellStyle => ({ ...PLAIN_CELL_STYLE, ...patch });

/** A row of cells: the text, every cell with `patch` (and `per` for the cells it names by column). */
function row(
  text: string,
  patch: Partial<CellStyle> = {},
  per: Readonly<Record<number, Partial<CellStyle>>> = {},
): ScreenCell[] {
  return Array.from({ length: text.length }, (_unit, column) => ({
    char: text.charAt(column),
    style: style({ ...patch, ...per[column] }),
  }));
}

/** The popup occupies rows 2-3, columns 4-9 of a 20-column screen. */
const BOX: PopupBox = {
  placement: 'overlay',
  top: 2,
  left: 4,
  width: 6,
  height: 2,
  rows: ['', ''],
};

/**
 * A body that holds a bold cell, an inverse cell and a coloured cell, every cell dim, and a popup box over it whose own cells are NOT dim
 * (its selected row is inverse and bold, as the test popup's is).
 */
function dimBody(): { before: ScreenCell[][]; now: ScreenCell[][] } {
  const dim = { dim: true };
  const before = [
    row('bold word and more   ', {}, { 0: { bold: true } }),
    row('an inverse cursor    ', {}, { 3: { inverse: true } }),
    row('a coloured word here ', {}, { 2: { fg: '36' } }),
    row('plain text under     '),
  ];
  const now = [
    row('bold word and more   ', dim),
    row('an inverse cursor    ', dim),
    row('a coloured word here ', { ...dim }),
    row('plain text under     ', dim),
  ];
  // The popup's cells: not dim, one inverse and bold (the selected row).
  for (let rowIndex = BOX.top; rowIndex < BOX.top + BOX.height; rowIndex += 1)
    for (let column = BOX.left; column < BOX.left + BOX.width; column += 1)
      now[rowIndex]![column] = {
        char: 'p',
        style: style(rowIndex === BOX.top ? { inverse: true, bold: true } : {}),
      };
  return { before, now };
}

const check = (
  variant: Variant,
  before: readonly (readonly ScreenCell[])[],
  now: readonly (readonly ScreenCell[])[],
  box: PopupBox = BOX,
): string[] =>
  checkBackdropDim({ variant, before, now, box }).map((violation) => violation.message);

describe('the backdrop-dim property, on cells made to break each clause', () => {
  it('holds when every cell outside the popup that shows something is dim, and the body held bold, inverse and colour', () => {
    const { before, now } = dimBody();
    expect(check(ALT_COLOUR, before, now)).toEqual([]);
  });

  it('fails for ONE body cell that is not dim, and names it', () => {
    const { before, now } = dimBody();
    now[0]![5] = { char: 'x', style: style() };
    const found = check(ALT_COLOUR, before, now);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('1 cell(s) of the body outside the popup are not dim');
    expect(found[0]).toContain('1:6 "x"');
  });

  it('fails for a cell right at each edge of the popup (the box is exact: one column or one row off is a bright cell)', () => {
    for (const [rowIndex, column] of [
      [2, 3],
      [2, 10],
      [1, 4],
      [4, 4],
    ] as const) {
      const { before, now } = dimBody();
      const cells = (now[rowIndex] ??= row('                    ', { dim: true }));
      cells[column] = { char: 'e', style: style() };
      expect(check(ALT_COLOUR, before, now), `${String(rowIndex)}:${String(column)}`).toHaveLength(
        1,
      );
    }
  });

  it('fails for an inverse space that is not dim (a cursor, a selected row’s tail), and not for a plain space', () => {
    const { before, now } = dimBody();
    now[1]![17] = { char: ' ', style: style({ inverse: true }) };
    expect(check(ALT_COLOUR, before, now)).toHaveLength(1);
    const plain = dimBody();
    plain.now[1]![17] = { char: ' ', style: style() };
    expect(check(ALT_COLOUR, plain.before, plain.now)).toEqual([]);
  });

  it('fails for a cell with a background that is not dim', () => {
    const { before, now } = dimBody();
    now[0]![18] = { char: ' ', style: style({ bg: '44' }) };
    expect(check(ALT_COLOUR, before, now)).toHaveLength(1);
  });

  it.each([
    ['bold', 'no bold cell'],
    ['inverse', 'no inverse cell'],
    ['colour', 'no coloured cell'],
  ])(
    'fails for a body that held no %s cell before the popup opened: it would pass on a plain body',
    (kind, words) => {
      const { before, now } = dimBody();
      const plain = before.map((cells) =>
        cells.map((cell) => ({
          char: cell.char,
          style: style({
            bold: kind === 'bold' ? false : cell.style.bold,
            inverse: kind === 'inverse' ? false : cell.style.inverse,
            fg: kind === 'colour' ? undefined : cell.style.fg,
          }),
        })),
      );
      const found = check(ALT_COLOUR, plain, now);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain(words);
      expect(found[0]).toContain('would pass on a plain body');
    },
  );

  it('counts a bold SPACE as nothing: only a character can show that the body had bold', () => {
    const { before, now } = dimBody();
    const onlySpaces = before.map((cells) =>
      cells.map((cell) => ({
        char: cell.char,
        style: style({ ...cell.style, bold: cell.char === ' ' }),
      })),
    );
    expect(check(ALT_COLOUR, onlySpaces, now)).toHaveLength(1);
  });

  it('fails when the popup’s own inverse cells are dim: the popup was drawn inside the dimmed subtree', () => {
    const { before, now } = dimBody();
    for (let column = BOX.left; column < BOX.left + BOX.width; column += 1)
      now[BOX.top]![column] = { char: 'p', style: style({ inverse: true, dim: true }) };
    const found = check(ALT_COLOUR, before, now);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('6 inverse cell(s) of the popup itself are dim');
  });

  it('fails for any row the popup crosses that holds an ideograph (its columns cannot be read), and not for one it does not cross', () => {
    for (const crossedRow of [2, 3]) {
      const { before, now } = dimBody();
      now[crossedRow]![0] = { char: '日', style: style({ dim: true }) };
      const crossed = check(ALT_COLOUR, before, now);
      expect(crossed, `row ${String(crossedRow)}`).toHaveLength(1);
      expect(crossed[0]).toContain('columns cannot be read');
    }
    const outside = dimBody();
    outside.now[0]![0] = { char: '日', style: style({ dim: true }) };
    expect(check(ALT_COLOUR, outside.before, outside.now)).toEqual([]);
  });

  it('with colour off: holds when nothing is dimmer than it was, and fails for a cell outside the box that was dimmed', () => {
    const { before, now } = dimBody();
    const undimmed = now.map((cells, rowIndex) =>
      cells.map((cell, column) => ({
        char: cell.char,
        style: { ...cell.style, dim: before[rowIndex]?.[column]?.style.dim ?? false },
      })),
    );
    expect(check(ALT_PLAIN, before, undimmed)).toEqual([]);
    const found = check(ALT_PLAIN, before, now);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('were dimmed with colour off');
  });

  it('with colour off a cell that was dim before the popup and still is, is not a cell we dimmed', () => {
    const { before, now } = dimBody();
    before[0]![0] = { char: 'b', style: style({ dim: true }) };
    const undimmed = now.map((cells, rowIndex) =>
      cells.map((cell, column) => ({
        char: cell.char,
        style: { ...cell.style, dim: before[rowIndex]?.[column]?.style.dim ?? false },
      })),
    );
    expect(check(ALT_PLAIN, before, undimmed)).toEqual([]);
  });

  it('checks nothing inline (the popup replaces the body: there is no backdrop) or for a popup in the flow', () => {
    const { before, now } = dimBody();
    now[0]![5] = { char: 'x', style: style() };
    expect(
      check(ALT_COLOUR, before, now),
      'control: the same cells fail in the overlay',
    ).toHaveLength(1);
    expect(check(INLINE_COLOUR, before, now)).toEqual([]);
    expect(check(ALT_COLOUR, before, now, { ...BOX, placement: 'replace' })).toEqual([]);
  });
});

describe('the backdrop-dim property through the real pipeline', () => {
  const entry = HOME_SURFACES.find((surface) => surface.id === 'home.popup-populated');
  if (entry === undefined) throw new Error('home.popup-populated is not registered');
  const alt: Variant = { renderer: 'alt', color: true, size: { cols: 80, rows: 24 } };
  const stripDim = (chunk: string): string => chunk.replaceAll(`${ESC}[2m`, '');

  it('control: the populated Home under a popup, untouched, has no problem', async () => {
    expect(problemsOf(entry, await runCell(entry, alt))).toEqual([]);
  });

  it('a terminal that never received the dim codes leaves the backdrop bright, and the property names it', async () => {
    const problems = problemsOf(entry, await runCell(entry, alt, { tamper: stripDim }));
    expect(problems.some((problem) => problem.startsWith('backdrop-dim:'))).toBe(true);
    expect(problems.join('\n')).toContain('are not dim');
  });

  it('a terminal that closes the dim after a bold cell and never opens it again (the encoder’s drop) is named too', async () => {
    // Every close of bold-and-dim (`ESC[22m`) not followed by the dim again: what ink's own re-encoding does to the cell after a bold one.
    const dropAfterClose = (chunk: string): string =>
      chunk.replaceAll(`${ESC}[22m${ESC}[2m`, `${ESC}[22m`);
    const problems = problemsOf(entry, await runCell(entry, alt, { tamper: dropAfterClose }));
    expect(problems.some((problem) => problem.startsWith('backdrop-dim:'))).toBe(true);
  });

  it('with colour off nothing is dimmed, and a terminal that dims the backdrop anyway is named', async () => {
    const plain: Variant = { ...alt, color: false };
    expect(problemsOf(entry, await runCell(entry, plain))).toEqual([]);
    // Only the frames that carry the popup are dimmed: the body's own first frame (the baseline) is as the product drew it.
    const dimEverything = (chunk: string): string =>
      chunk.includes('Test report') ? `${ESC}[2m${chunk}` : chunk;
    const problems = problemsOf(entry, await runCell(entry, plain, { tamper: dimEverything }));
    expect(problems.some((problem) => problem.startsWith('backdrop-dim:'))).toBe(true);
    expect(problems.join('\n')).toContain('were dimmed with colour off');
  });
});
