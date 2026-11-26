import { glyph } from './glyphs.js';
import { legend, type LegendItem } from './legend.js';
import { nativeLeave, type NativePromptSnapshot } from './native-prompt-channel.js';
import { reviewTerminalFits, type TerminalFrameSize } from './measured-frame-acknowledgement.js';
import { moreAboveText, moreBelowText, windowBody } from './sheet-frame.js';
import { displayWidth, wrapWords } from './viewport.js';

/**
 * The window of a native `select` prompt whose options do not all fit the terminal (LAUNCH-4): the run picker lists every workflow the
 * project has, and a card taller than the terminal was refused outright ("Prompt does not fit") with the keys not delivered, so the person
 * could not pick. The window is the one every list of the Home uses: `windowBody` ({@link ./sheet-frame.ts}), the cursor kept on a real row,
 * and a `▲`/`▼` marker standing on the first or last drawn line for the rows it hides (the row under it included).
 *
 * Framework-free and pure. The view draws what {@link selectLayout} says, the channel pages by {@link selectPageRows}, and the Home's
 * layout never reads either: a windowed card fills the terminal, which is exactly what its own overestimate already reserves.
 */

/** The row the cursor is on (the glyph table's selection marker and its space, in the form in force), and the gutter every other row of the list keeps under it. */
const cursor = (): string => `${glyph('selection')} `;
const GUTTER = '  ';

/**
 * One row of the terminal is never used by the card: in a chat the transcript keeps at least one row above it, so a card of the whole
 * terminal's height would be refused there, and a card is only trusted when its frame is measured to fit.
 */
const RESERVED_ROWS = 1;

/** The least window that can hold a marker, a cursor row and the other marker; a smaller one shows the cursor row alone, with no marker. */
const MARKED_WINDOW = 3;

/** The legend under a select card: what it says changes only by the `PgUp/PgDn` item a windowed list adds. */
export function selectLegend(back: boolean, windowed: boolean): string {
  const { before, exit } = nativeLeave(back);
  const paging: readonly LegendItem[] = windowed ? [{ keys: 'PgUp/PgDn', verb: 'page' }] : [];
  return legend(
    [{ keys: '↑/↓', verb: 'select' }, ...paging, { keys: 'Enter', verb: 'choose' }, ...before],
    exit,
  );
}

/** What one option's row says: the cursor or its gutter, the label, and the hint after a dash. */
export function selectRowText(snapshot: NativePromptSnapshot, index: number): string {
  const option = snapshot.options[index];
  if (option === undefined) return '';
  const hint = option.hint ? ` — ${option.hint}` : '';
  return `${index === snapshot.selected ? cursor() : GUTTER}${option.label}${hint}`;
}

/**
 * One option as the rows it is drawn in at `columns`: the cursor or the gutter and then the label with its hint, and, where that does not fit
 * one row, the rows after the first starting under the label, never at the left edge of the terminal. The rows are cut at a word, a word wider
 * than a row is broken where it must be, and no row is longer than `columns`, so the card's estimate of its height and what it draws are one.
 */
export function selectRowLines(
  snapshot: NativePromptSnapshot,
  index: number,
  columns: number,
): readonly string[] {
  const text = selectRowText(snapshot, index);
  const hang = displayWidth(GUTTER);
  const prefix = text.slice(0, hang);
  const rows = wrapWords(text.slice(hang), Math.max(1, Math.trunc(columns) - hang)).map(
    (row, at) => (at === 0 ? row.trimEnd() : row.trim()),
  );
  return rows.map((row, at) => (at === 0 ? prefix : GUTTER) + row);
}

export type SelectLine =
  | { readonly kind: 'option'; readonly index: number }
  | { readonly kind: 'marker'; readonly position: 'above' | 'below'; readonly text: string };

export interface SelectLayout {
  /** The lines drawn between the question and the legend, one terminal row each, top to bottom. */
  readonly lines: readonly SelectLine[];
  /** How far `PgUp`/`PgDn` move the cursor: a window's option rows, so no row is paged over without having been drawn. */
  readonly page: number;
}

/** The rows `text` takes when it wraps at `columns`: the larger of the word wrap and the plain division, so the estimate is never short. */
function rowsOf(text: string, columns: number): number {
  return Math.max(
    1,
    wrapWords(text, columns).length,
    Math.ceil(displayWidth(text) / Math.max(1, columns)),
  );
}

/**
 * How a `select` card is laid out for `size`: `undefined` when it is drawn whole, as it always was (not a select, no options, every
 * option fits the rows the terminal leaves, or not even the question, one row and the legend fit, which the view says in its own words);
 * otherwise the window of option rows that does fit, each cut to one terminal row.
 */
export function selectLayout(
  snapshot: NativePromptSnapshot,
  size: TerminalFrameSize,
): SelectLayout | undefined {
  const total = snapshot.options.length;
  if (snapshot.kind !== 'select' || total === 0 || !reviewTerminalFits(size)) return undefined;
  const columns = Math.trunc(size.cols);
  const available = Math.trunc(size.rows) - RESERVED_ROWS;
  const aboveRows =
    (snapshot.note === '' ? 0 : rowsOf(snapshot.note, columns)) +
    (snapshot.message === '' ? 0 : rowsOf(snapshot.message, columns)) +
    (snapshot.error === '' ? 0 : rowsOf(snapshot.error, columns));
  const back = snapshot.escape === 'back';
  let whole = aboveRows + rowsOf(selectLegend(back, false), columns);
  for (let index = 0; index < total; index += 1)
    whole += selectRowLines(snapshot, index, columns).length;
  if (whole <= available) return undefined;
  const room = available - aboveRows - rowsOf(selectLegend(back, true), columns);
  if (room < 1) return undefined;
  const selected = Math.max(0, Math.min(snapshot.selected, total - 1));
  const { start, end } = windowBody(total, selected, room);
  const marked = end - start >= MARKED_WINDOW;
  const lines: SelectLine[] = [];
  for (let index = start; index < end; index += 1) {
    if (marked && index === start && start > 0)
      lines.push({ kind: 'marker', position: 'above', text: moreAboveText(start + 1) });
    else if (marked && index === end - 1 && end < total)
      lines.push({ kind: 'marker', position: 'below', text: moreBelowText(total - end + 1) });
    else lines.push({ kind: 'option', index });
  }
  // The option rows of a window that hides rows on both sides, the shortest a window gets: a page of that many leaves the rows between the old
  // and the new cursor on the new window too, and `PgDn` then `PgUp` returns to the row it left.
  return { lines, page: Math.max(1, room - 2) };
}

/** How far `PgUp`/`PgDn` move the cursor of this card, or `undefined` when it is not windowed (the keys then do nothing, as they always did). */
export function selectPageRows(
  snapshot: NativePromptSnapshot,
  size: TerminalFrameSize,
): number | undefined {
  return selectLayout(snapshot, size)?.page;
}

/** The marker rows' indent: under the cursor's column, so a marker reads as part of the list and never as an option. */
export const SELECT_MARKER_INDENT = GUTTER;
