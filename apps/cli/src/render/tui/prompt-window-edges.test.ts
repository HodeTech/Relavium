/**
 * The edges of the prompt's window (MVP-11 unit 7, round 2; `promptWindow` in `prompt-window.ts`), each pinned by the exact lines it draws:
 * it never has fewer than three lines (a marker, the row of the cursor and the other marker), however few rows it is asked for; a size that is
 * a fraction of a row is floored and one that is not a number is the least; a column count that is not a number is 80 and one below one is a
 * column; a cursor that is not drawn is not followed, so the window shows the end of the draft; and a marker counts the rows it stands for.
 */
import { describe, expect, it } from 'vitest';

import { promptWindow, PROMPT_WINDOW_MIN_ROWS } from './prompt-window.js';

const same = (text: string): string => text;
/** The lines a window draws as `^N` (rows above, the marker included), the row's text, and `vN` (rows below). */
function linesOf(window: ReturnType<typeof promptWindow>): string {
  if (window === undefined) return 'whole';
  return window
    .map((line) =>
      line.kind === 'row'
        ? `${line.row.before}${line.row.at ?? ''}${line.row.after}`
        : `${line.side === 'above' ? '^' : 'v'}${String(line.count)}`,
    )
    .join(' / ');
}
const NINE = Array.from({ length: 9 }, (_, n) => `L${String(n)}`).join('\n');
/** The offset of the start of row `row` of {@link NINE}. */
const startOf = (row: number): number =>
  row === 0 ? 0 : NINE.split('\n').slice(0, row).join('\n').length + 1;

describe('a window never has fewer than three lines', () => {
  it('the least is three', () => {
    expect(PROMPT_WINDOW_MIN_ROWS).toBe(3);
  });

  it.each([0, 1, 2, 3])(
    'asked for %i rows it draws three: a marker, the cursor’s row and the other marker',
    (maxRows) => {
      expect(linesOf(promptWindow(NINE, startOf(0), 20, maxRows, same))).toBe('L0 / L1 / v7');
      expect(linesOf(promptWindow(NINE, startOf(2), 20, maxRows, same))).toBe('^2 / L2 / v6');
      expect(linesOf(promptWindow(NINE, startOf(8), 20, maxRows, same))).toBe('^7 / L7 / L8');
    },
  );

  it('a marker stands for the rows it hides and the row it replaces: from the second row of the draft on, there is one above', () => {
    expect(linesOf(promptWindow(NINE, startOf(1), 20, 3, same))).toBe('L0 / L1 / v7');
    expect(linesOf(promptWindow(NINE, startOf(2), 20, 3, same))).toBe('^2 / L2 / v6');
    expect(linesOf(promptWindow(NINE, startOf(4), 20, 3, same))).toBe('^4 / L4 / v4');
  });
});

describe('a size that is not whole rows', () => {
  it.each([
    [3.9, '^4 / L4 / v4'],
    [4.9, '^4 / L4 / L5 / v3'],
    [Number.NaN, '^4 / L4 / v4'],
    [Number.POSITIVE_INFINITY, '^4 / L4 / v4'],
  ] as const)('%s rows: %s', (maxRows, expected) => {
    expect(linesOf(promptWindow(NINE, startOf(4), 20, maxRows, same))).toBe(expected);
  });
});

describe('a cursor that is not drawn is not followed', () => {
  it('the window shows the end of the draft, where a person is typing', () => {
    expect(linesOf(promptWindow(NINE, -1, 20, 3, same))).toBe('^7 / L7 / L8');
    expect(linesOf(promptWindow(NINE, -1, 20, 5, same))).toBe('^5 / L5 / L6 / L7 / L8');
  });
});

describe('the columns of the rows', () => {
  it('a width that is not a number is 80 columns: 240 characters are three rows, 241 are four', () => {
    expect(linesOf(promptWindow('x'.repeat(240), -1, Number.NaN, 3, same))).toBe('whole');
    expect(linesOf(promptWindow('x'.repeat(241), -1, Number.NaN, 3, same))).not.toBe('whole');
    expect(linesOf(promptWindow('x'.repeat(240), -1, Number.POSITIVE_INFINITY, 3, same))).toBe(
      'whole',
    );
  });

  it('a width below one is one column, and a fraction is floored: 33 characters at 10.9 columns are four rows, not three', () => {
    expect(linesOf(promptWindow('abcdefghij'.repeat(3), -1, 0, 3, same))).toBe('^28 / i / j');
    expect(linesOf(promptWindow('abcdefghij'.repeat(3), -1, -3, 3, same))).toBe('^28 / i / j');
    expect(linesOf(promptWindow('x'.repeat(30), -1, 10.9, 3, same))).toBe('whole');
    expect(linesOf(promptWindow('x'.repeat(33), -1, 10.9, 3, same))).not.toBe('whole');
    expect(linesOf(promptWindow('x'.repeat(33), -1, 11, 3, same))).toBe('whole');
  });
});
