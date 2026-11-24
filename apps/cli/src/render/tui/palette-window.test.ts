/**
 * The window of the `/` palette ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3, MVP-8 step 5): which of the matching entries are drawn when they do not all fit the rows the terminal leaves for the palette. The pure
 * model; `palette-view.test.tsx` draws it and `home-palette-fit.test.tsx` holds the whole landing to the terminal.
 */
import { describe, expect, it } from 'vitest';

import {
  PALETTE_CHROME_ROWS,
  PALETTE_MIN_ROWS,
  paletteGapCount,
  paletteLines,
  paletteRowBudget,
  type PaletteLine,
} from './palette-window.js';

const entries = (lines: readonly PaletteLine[]): number[] =>
  lines.flatMap((line) => (line.kind === 'entry' ? [line.index] : []));
const markers = (lines: readonly PaletteLine[]): string[] =>
  lines.flatMap((line) => (line.kind === 'marker' ? [line.text] : []));
/** The entries with a blank row drawn BEFORE them (in the order the lines come): where the gaps are. */
const gapsBefore = (lines: readonly PaletteLine[]): number[] =>
  lines.flatMap((line, at) => {
    const next = lines[at + 1];
    return line.kind === 'gap' && next?.kind === 'entry' ? [next.index] : [];
  });

/** The Home's own groups: Work (4) · Set up (7) · Check (2) · End (2), 15 entries, three gaps between four groups. */
const HOME_GROUP_STARTS: readonly boolean[] = Array.from({ length: 15 }, (_, index) =>
  [0, 4, 11, 13].includes(index),
);

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

describe('the blank rows between the groups are the first thing to give way, all or none (ADR-0145 §7.1, MVP-11 Step 2 review C9c)', () => {
  const lines = (maxRows: number | undefined, selected = 0) =>
    paletteLines(15, selected, maxRows, HOME_GROUP_STARTS);

  it('counts one gap before each group but the first', () => {
    expect(paletteGapCount(HOME_GROUP_STARTS)).toBe(3);
    expect(paletteGapCount([true, false, false])).toBe(0);
    expect(paletteGapCount([])).toBe(0);
    // A start on entry 0 is the list's own first row: it has nothing above it to separate from.
    expect(paletteGapCount([true, true, true])).toBe(2);
  });

  it('draws every gap when every entry and every gap fits, and with no bound', () => {
    for (const maxRows of [undefined, 3 + 15 + 3, 40]) {
      const drawn = lines(maxRows);
      expect(entries(drawn), String(maxRows)).toEqual(
        Array.from({ length: 15 }, (_, index) => index),
      );
      expect(gapsBefore(drawn), String(maxRows)).toEqual([4, 11, 13]);
      expect(markers(drawn)).toEqual([]);
      expect(drawn).toHaveLength(15 + 3);
    }
  });

  it('draws NO gap, not some of them, when the spare rows do not hold all three: two spare, one spare and none', () => {
    // Two of three used to be drawn at 80×28 and 80×29: a list with one group set apart and the others run together.
    for (const spare of [2, 1, 0]) {
      const drawn = lines(3 + 15 + spare);
      expect(entries(drawn), `${String(spare)} spare`).toEqual(
        Array.from({ length: 15 }, (_, index) => index),
      );
      expect(gapsBefore(drawn), `${String(spare)} spare`).toEqual([]);
      expect(markers(drawn)).toEqual([]);
      expect(drawn.length + PALETTE_CHROME_ROWS).toBe(3 + 15);
    }
  });

  it('draws all three the moment three rows are spare', () => {
    const drawn = lines(3 + 15 + 3);
    expect(gapsBefore(drawn)).toEqual([4, 11, 13]);
    expect(drawn.length + PALETTE_CHROME_ROWS).toBe(3 + 15 + 3);
  });

  it('draws no gap once the entries themselves must be windowed, and a gap never costs an entry its row', () => {
    for (let maxRows = PALETTE_CHROME_ROWS + 1; maxRows < 3 + 15; maxRows += 1)
      for (let selected = 0; selected < 15; selected += 1) {
        const drawn = lines(maxRows, selected);
        expect(gapsBefore(drawn), `${String(maxRows)} rows`).toEqual([]);
        expect(drawn.some((line) => line.kind === 'gap')).toBe(false);
        expect(entries(drawn)).toContain(selected);
        expect(drawn.length + PALETTE_CHROME_ROWS).toBeLessThanOrEqual(maxRows);
      }
  });

  it('never windows the last entry (/exit) away with the gaps: highlighted, it is drawn at every height that fits it', () => {
    for (let maxRows = PALETTE_MIN_ROWS; maxRows <= 3 + 15 + 3; maxRows += 1)
      expect(entries(lines(maxRows, 14)), `${String(maxRows)} rows`).toContain(14);
  });

  it('is the list it always was when there are no groups', () => {
    expect(paletteLines(14, 0, 17, [])).toEqual(paletteLines(14, 0, 17));
    expect(paletteLines(14, 0, 17).some((line) => line.kind === 'gap')).toBe(false);
  });
});

describe('a list that runs up (a chat): the lines come back bottom-up, and the markers point the way the hidden entries lie', () => {
  it('reverses the entries: the last entry is the first line and the first entry the last', () => {
    expect(entries(paletteLines(5, 0, undefined, [], 'up'))).toEqual([4, 3, 2, 1, 0]);
    expect(entries(paletteLines(5, 0, undefined, [], 'down'))).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts the gap between the same two groups, seen from the other side', () => {
    const groups = [true, false, true, false, true];
    const down = paletteLines(5, 0, undefined, groups, 'down');
    const up = paletteLines(5, 0, undefined, groups, 'up');
    expect(up).toEqual([...down].reverse());
    expect(down.filter((line) => line.kind === 'gap')).toHaveLength(2);
  });

  it('marks the entries beyond the top with ▲ and the entries toward the prompt with ▼', () => {
    // 15 rows, entry 0 highlighted: the hidden entries are the last three, which lie ABOVE the window on the screen.
    const top = paletteLines(14, 0, 15, [], 'up');
    expect(markers(top)).toEqual(['▲ 3 more']);
    expect(top[0]).toMatchObject({ kind: 'marker', position: 'above' });
    expect(entries(top)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    // Entry 13 highlighted: the hidden entries are the first three, toward the prompt: BELOW the window.
    const bottom = paletteLines(14, 13, 15, [], 'up');
    expect(markers(bottom)).toEqual(['▼ 3 more']);
    expect(bottom.at(-1)).toMatchObject({ kind: 'marker', position: 'below' });
    expect(entries(bottom)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    // Both ends hidden: one marker each, the same counts as when the list runs down.
    const middle = paletteLines(14, 7, 10, [], 'up');
    expect(markers(middle)).toEqual(['▲ 4 more', '▼ 5 more']);
    expect(entries(middle)).toEqual([9, 8, 7, 6, 5]);
  });

  it('never hides the highlighted entry and never draws more than the rows it was given, whichever way it runs', () => {
    for (const layout of ['down', 'up'] as const)
      for (let maxRows = PALETTE_CHROME_ROWS + 1; maxRows < 14 + PALETTE_CHROME_ROWS; maxRows += 1)
        for (let selected = 0; selected < 14; selected += 1) {
          const drawn = paletteLines(14, selected, maxRows, [], layout);
          expect(
            entries(drawn),
            `${layout} ${String(maxRows)} rows, entry ${String(selected)}`,
          ).toContain(selected);
          expect(drawn.length + PALETTE_CHROME_ROWS).toBeLessThanOrEqual(maxRows);
        }
  });
});

describe('the rows the landing keeps for a palette with group gaps', () => {
  it('asks for its entries, its gaps and its chrome: the Home’s 15 entries and 3 gaps are 21 rows', () => {
    expect(paletteRowBudget(60, 15, 3)).toBe(15 + 3 + PALETTE_CHROME_ROWS);
    expect(paletteRowBudget(60, 15, 3)).toBe(21);
    expect(paletteRowBudget(60, 15)).toBe(18);
  });

  it('is capped by half the terminal as before, gaps or not: the strip and the notice are not asked for more', () => {
    expect(paletteRowBudget(24, 15, 3)).toBe(12);
    expect(paletteRowBudget(30, 15, 3)).toBe(15);
    expect(paletteRowBudget(8, 15, 3)).toBe(PALETTE_MIN_ROWS);
  });
});
