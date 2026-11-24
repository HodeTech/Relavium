/**
 * The window of the `/` palette ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): which of the matching entries are drawn when they do not all fit the rows the terminal leaves for the palette. The pure
 * model; `palette-view.test.tsx` draws it and `home-palette-fit.test.tsx` holds the whole landing to the terminal.
 */
import { describe, expect, it } from 'vitest';

import {
  PALETTE_CHROME_ROWS,
  PALETTE_MIN_ROWS,
  paletteLines,
  paletteRowBudget,
  type PaletteLine,
} from './palette-window.js';

const entries = (lines: readonly PaletteLine[]): number[] =>
  lines.flatMap((line) => (line.kind === 'entry' ? [line.index] : []));
const markers = (lines: readonly PaletteLine[]): string[] =>
  lines.flatMap((line) => (line.kind === 'marker' ? [line.text] : []));

describe('a palette whose entries all fit is the list it always was', () => {
  it.each([
    [14, undefined],
    [14, 17],
    [14, 40],
    [0, 3],
    [1, 4],
  ])('%i entries in %s rows: every entry, in order, and no marker', (total, maxRows) => {
    const lines = paletteLines(total, 0, maxRows);
    expect(entries(lines)).toEqual(Array.from({ length: total }, (_, index) => index));
    expect(markers(lines)).toEqual([]);
    expect(lines).toHaveLength(total);
  });

  it('does not depend on the highlighted entry when they all fit', () => {
    for (const selected of [0, 5, 13, 99])
      expect(entries(paletteLines(14, selected, 17))).toEqual(entries(paletteLines(14, 0, 17)));
  });
});

describe('a palette that does not fit draws a window of it', () => {
  it('takes at most the rows it was given, the gap, the query and the legend included', () => {
    for (let maxRows = PALETTE_CHROME_ROWS + 1; maxRows < 14 + PALETTE_CHROME_ROWS; maxRows += 1)
      for (let selected = 0; selected < 14; selected += 1)
        expect(
          paletteLines(14, selected, maxRows).length + PALETTE_CHROME_ROWS,
          `${String(maxRows)} rows, entry ${String(selected)}`,
        ).toBeLessThanOrEqual(maxRows);
  });

  it('never hides the highlighted entry, whichever entry it is and however few rows there are', () => {
    for (let maxRows = PALETTE_CHROME_ROWS + 1; maxRows < 14 + PALETTE_CHROME_ROWS; maxRows += 1)
      for (let selected = 0; selected < 14; selected += 1)
        expect(
          entries(paletteLines(14, selected, maxRows)),
          `${String(maxRows)} rows, entry ${String(selected)}`,
        ).toContain(selected);
  });

  it('marks the entries it hides, counting the entry a marker stands on, and puts each marker at an end of the window', () => {
    // 15 rows: three of chrome, twelve lines for 14 entries. At the top only the lower marker; in the middle both; at the bottom only the upper.
    const top = paletteLines(14, 0, 15);
    expect(markers(top)).toEqual(['▼ 3 more']);
    expect(top.at(-1)).toMatchObject({ kind: 'marker', position: 'below' });
    expect(entries(top)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    const bottom = paletteLines(14, 13, 15);
    expect(markers(bottom)).toEqual(['▲ 3 more']);
    expect(bottom[0]).toMatchObject({ kind: 'marker', position: 'above' });
    expect(entries(bottom)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    // Fewer rows, so that both ends are hidden: a marker on each, and the highlighted entry between them.
    const middle = paletteLines(14, 7, 10);
    expect(markers(middle)).toEqual(['▲ 5 more', '▼ 4 more']);
    expect(middle[0]).toMatchObject({ kind: 'marker', position: 'above' });
    expect(middle.at(-1)).toMatchObject({ kind: 'marker', position: 'below' });
    expect(entries(middle)).toEqual([5, 6, 7, 8, 9]);
  });

  it('every entry is reachable: the windows of the entries in turn, together, name every entry', () => {
    const seen = new Set<number>();
    for (let selected = 0; selected < 14; selected += 1)
      for (const index of entries(paletteLines(14, selected, 9))) seen.add(index);
    expect([...seen].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 14 }, (_, index) => index),
    );
  });

  it('a window too small for both markers and an entry between them shows the highlighted entry alone, without a marker', () => {
    for (const maxRows of [PALETTE_CHROME_ROWS + 1, PALETTE_CHROME_ROWS + 2]) {
      const lines = paletteLines(14, 6, maxRows);
      expect(markers(lines)).toEqual([]);
      expect(entries(lines)).toContain(6);
      expect(lines.length).toBeLessThanOrEqual(maxRows - PALETTE_CHROME_ROWS);
    }
  });

  it('never draws less than one line, and clamps a highlighted entry that is past the end', () => {
    expect(paletteLines(14, 6, 0)).toHaveLength(1);
    expect(entries(paletteLines(14, 99, 15))).toContain(13);
    expect(entries(paletteLines(14, -3, 15))).toContain(0);
  });
});

describe('the rows the landing keeps for its palette', () => {
  it('is every row the palette asks for when that is at most half the terminal', () => {
    expect(paletteRowBudget(40, 14)).toBe(17);
    expect(paletteRowBudget(34, 14)).toBe(17);
    expect(paletteRowBudget(30, 4)).toBe(7);
  });

  it('is half the terminal otherwise, never fewer than the least a palette can be drawn in and never the whole terminal', () => {
    expect(paletteRowBudget(24, 14)).toBe(12);
    expect(paletteRowBudget(30, 14)).toBe(15);
    expect(paletteRowBudget(8, 14)).toBe(PALETTE_MIN_ROWS);
    expect(paletteRowBudget(7, 14)).toBe(PALETTE_MIN_ROWS);
    for (let rows = 24; rows < 200; rows += 1)
      expect(paletteRowBudget(rows, 100), `${String(rows)} rows`).toBeLessThan(rows);
  });
});
