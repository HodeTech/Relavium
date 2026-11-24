import type { PaletteLayout } from './palette-reducer.js';
import { windowBody } from './sheet-frame.js';

/**
 * The window of the `/` command palette when its entries do not all fit the rows the terminal leaves for it. The palette had no row cap, so
 * the bare Home's palette (fourteen entries, once `/import` and `/pricing` joined) was 25 lines on an empty Home at 80×24, a terminal of 24
 * rows. The window is the one every list of the Home uses: `windowBody` ({@link ./sheet-frame.ts}), the highlighted entry kept inside it and
 * off the rows that stand for hidden entries, and a `▲`/`▼` marker on the first or last drawn line for the entries it hides (the entry under
 * the marker included, as the native select's markers count them).
 *
 * **Group gaps are the first thing to give way** (ADR-0145 §7.1, [ADR-0146](../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §3). A blank row separates the groups when the rows allow: all of them when every entry and every gap fits, the ones nearest the prompt
 * when only some do, and none once the entries themselves must be windowed, so a gap never costs an entry its row and never windows the
 * last entry (`/exit`) away. The Home's 15 entries and three gaps need 21 rows besides the prompt's own, and an 80×24 terminal leaves 23: two
 * of the three gaps fit.
 *
 * **Direction.** `down` draws the first entry at the top (the Home: the list opens under the prompt). `up` draws the first entry at the
 * BOTTOM, next to the query line (a chat: the list opens above the prompt), so the lines come back reversed and the markers point the way the
 * hidden entries lie on the screen.
 *
 * Framework-free and pure. A palette whose entries all fit is the list it always was: no marker, the same lines.
 */

/** The rows the palette draws besides its entries: the gap above it, the query line and the legend under (or over) the list. */
export const PALETTE_CHROME_ROWS = 3;

/** The least window that can hold a marker, the highlighted entry and the other marker; a smaller one shows the highlighted entry alone. */
const MARKED_WINDOW = 3;

/** The fewest rows the palette is ever given on the landing: its chrome and a window that can hold both markers. */
export const PALETTE_MIN_ROWS = PALETTE_CHROME_ROWS + MARKED_WINDOW;

export type PaletteLine =
  | { readonly kind: 'entry'; readonly index: number }
  /** A blank row between two groups. */
  | { readonly kind: 'gap' }
  /** `position` is where the marker sits on the SCREEN, whichever way the list runs. */
  | {
      readonly kind: 'marker';
      readonly position: 'above' | 'below';
      readonly text: string;
    };

/** The indexes of the entries a blank row goes before: every group start but the first row of the list. */
function gapPositions(groupStarts: readonly boolean[], total: number): readonly number[] {
  const positions: number[] = [];
  for (let index = 1; index < total; index += 1)
    if (groupStarts[index] === true) positions.push(index);
  return positions;
}

/**
 * How many blank rows the groups ask for: one before each group but the first. A host that sizes the rows it keeps for the palette adds
 * them to the entries ({@link paletteRowBudget}).
 */
export function paletteGapCount(
  groupStarts: readonly boolean[],
  total = groupStarts.length,
): number {
  return gapPositions(groupStarts, total).length;
}

type ListLine =
  | { readonly kind: 'entry'; readonly index: number }
  | { readonly kind: 'gap' }
  | { readonly kind: 'marker'; readonly side: 'before' | 'after'; readonly hidden: number };

/** The lines in LIST order: the first entry first. */
function listLines(
  total: number,
  selected: number,
  maxRows: number | undefined,
  groupStarts: readonly boolean[],
): readonly ListLine[] {
  const gaps = gapPositions(groupStarts, total);
  const withGaps = (kept: ReadonlySet<number>): ListLine[] => {
    const lines: ListLine[] = [];
    for (let index = 0; index < total; index += 1) {
      if (kept.has(index)) lines.push({ kind: 'gap' });
      lines.push({ kind: 'entry', index });
    }
    return lines;
  };
  if (maxRows === undefined) return withGaps(new Set(gaps));
  const spare = Math.trunc(maxRows) - PALETTE_CHROME_ROWS - total;
  // Every entry fits: the gaps take the spare rows, the ones nearest the prompt first.
  if (spare >= 0) return withGaps(new Set(gaps.slice(0, spare)));
  const room = Math.max(1, Math.trunc(maxRows) - PALETTE_CHROME_ROWS);
  const cursor = Math.max(0, Math.min(selected, total - 1));
  const { start, end } = windowBody(total, cursor, room);
  const marked = end - start >= MARKED_WINDOW;
  const lines: ListLine[] = [];
  for (let index = start; index < end; index += 1) {
    if (marked && index === start && start > 0)
      lines.push({ kind: 'marker', side: 'before', hidden: start + 1 });
    else if (marked && index === end - 1 && end < total)
      lines.push({ kind: 'marker', side: 'after', hidden: total - end + 1 });
    else lines.push({ kind: 'entry', index });
  }
  return lines;
}

/**
 * The lines between the query and the legend, top to bottom, one terminal row each. `total` entries match the query and `selected` is the
 * highlighted one; `maxRows` is the most the whole palette may draw (chrome included), absent when it is not bounded; `groupStarts[i]` says
 * entry `i` starts a group, and a blank row is drawn before it when the rows allow. Every entry is drawn, with no marker, when they all fit.
 */
export function paletteLines(
  total: number,
  selected: number,
  maxRows: number | undefined,
  groupStarts: readonly boolean[] = [],
  layout: PaletteLayout = 'down',
): readonly PaletteLine[] {
  const lines = listLines(total, selected, maxRows, groupStarts);
  const shown = layout === 'down' ? lines : [...lines].reverse();
  return shown.map((line): PaletteLine => {
    if (line.kind !== 'marker') return line;
    // Hidden entries before the window are on the first-entry side: above the list when it runs down, below it when it runs up.
    const above = (line.side === 'before') === (layout === 'down');
    return {
      kind: 'marker',
      position: above ? 'above' : 'below',
      text: `${above ? '▲' : '▼'} ${String(line.hidden)} more`,
    };
  });
}

/**
 * The rows the landing keeps for its palette while it is open: every row the palette asks for (its entries, its group gaps and its chrome)
 * when that is at most half the terminal, and otherwise half of it, never fewer than {@link PALETTE_MIN_ROWS} and never the whole terminal.
 * The strip and the notice leave it that many rows (and one more that no frame uses), so the landing and the palette together are never
 * taller than the terminal.
 */
export function paletteRowBudget(terminalRows: number, entries: number, gaps = 0): number {
  const rows = Math.trunc(terminalRows);
  return Math.min(
    entries + gaps + PALETTE_CHROME_ROWS,
    Math.max(PALETTE_MIN_ROWS, Math.floor(rows / 2)),
    Math.max(PALETTE_MIN_ROWS, rows - 1),
  );
}
