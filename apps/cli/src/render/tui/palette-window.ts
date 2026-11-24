import { windowBody } from './sheet-frame.js';

/**
 * The window of the `/` command palette when its entries do not all fit the rows the terminal leaves for it. The palette had no row cap, so
 * the bare Home's palette (fourteen entries, once `/import` and `/pricing` joined) was 25 lines on an empty Home at 80×24, a terminal of 24
 * rows. The window is the one every list of the Home uses: `windowBody` ({@link ./sheet-frame.ts}), the highlighted entry kept inside it and
 * off the rows that stand for hidden entries, and a `▲`/`▼` marker on the first or last drawn line for the entries it hides (the entry under
 * the marker included, as the native select's markers count them).
 *
 * Framework-free and pure. A palette whose entries all fit is the list it always was: no marker, the same lines.
 */

/** The rows the palette draws besides its entries: the gap above it, the query line and the legend under the list. */
export const PALETTE_CHROME_ROWS = 3;

/** The least window that can hold a marker, the highlighted entry and the other marker; a smaller one shows the highlighted entry alone. */
const MARKED_WINDOW = 3;

/** The fewest rows the palette is ever given on the landing: its chrome and a window that can hold both markers. */
export const PALETTE_MIN_ROWS = PALETTE_CHROME_ROWS + MARKED_WINDOW;

export type PaletteLine =
  | { readonly kind: 'entry'; readonly index: number }
  | { readonly kind: 'marker'; readonly position: 'above' | 'below'; readonly text: string };

/**
 * The lines between the query and the legend, top to bottom, one terminal row each. `total` entries match the query and `selected` is the
 * highlighted one; `maxRows` is the most the whole palette may draw (chrome included), absent when it is not bounded. Every entry is drawn,
 * with no marker, when they all fit.
 */
export function paletteLines(
  total: number,
  selected: number,
  maxRows: number | undefined,
): readonly PaletteLine[] {
  const all = Array.from({ length: total }, (_, index): PaletteLine => ({ kind: 'entry', index }));
  if (maxRows === undefined || total + PALETTE_CHROME_ROWS <= maxRows) return all;
  const room = Math.max(1, Math.trunc(maxRows) - PALETTE_CHROME_ROWS);
  const cursor = Math.max(0, Math.min(selected, total - 1));
  const { start, end } = windowBody(total, cursor, room);
  const marked = end - start >= MARKED_WINDOW;
  const lines: PaletteLine[] = [];
  for (let index = start; index < end; index += 1) {
    if (marked && index === start && start > 0)
      lines.push({ kind: 'marker', position: 'above', text: `▲ ${String(start + 1)} more` });
    else if (marked && index === end - 1 && end < total)
      lines.push({ kind: 'marker', position: 'below', text: `▼ ${String(total - end + 1)} more` });
    else lines.push({ kind: 'entry', index });
  }
  return lines;
}

/**
 * The rows the landing keeps for its palette while it is open: every row the palette asks for (its entries and its chrome) when that is at
 * most half the terminal, and otherwise half of it, never fewer than {@link PALETTE_MIN_ROWS} and never the whole terminal. The strip and the
 * notice leave it that many rows (and one more that no frame uses), so the landing and the palette together are never taller than the terminal.
 */
export function paletteRowBudget(terminalRows: number, entries: number): number {
  const rows = Math.trunc(terminalRows);
  return Math.min(
    entries + PALETTE_CHROME_ROWS,
    Math.max(PALETTE_MIN_ROWS, Math.floor(rows / 2)),
    Math.max(PALETTE_MIN_ROWS, rows - 1),
  );
}
