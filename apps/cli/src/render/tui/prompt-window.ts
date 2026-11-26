import { promptRows, type PromptRow } from './prompt-cursor.js';
import { windowBody } from './sheet-frame.js';
import { wrapLogicalLine, wrapWords } from './viewport.js';

/**
 * The window of a long draft that the prompt editor draws when it is given a row budget (OB7-M3, the observation of unit 7's chat half): a 30-line
 * paste at 80×24 filled rows 4 to 23 with its first twenty lines, and the cursor, the rule, the status line and the hint were below the frame, so
 * typing at the end was invisible. A chat gives its editor a bound ({@link PromptEditor}'s `maxRows`), and a draft that does not fit it is drawn as a
 * window of its rows that contains the cursor, with the `▲ N more` / `▼ N more` marker of every other windowed list (ADR-0145 §7) standing for the
 * rows it hides. Pure and framework-free, so the arithmetic is unit-checked without a render.
 *
 * The rows are PHYSICAL: each logical line of the draft is broken into rows of at most `textColumns` display columns (grapheme-aware, exact, so a
 * row never wraps again), and the window is made over those rows, so a single very long line is windowed too. This hard wrap is used only when
 * the draft does not fit; a draft that fits the bound is drawn as it always was, by Ink's word wrap (the function answers `undefined`).
 *
 * **Fit means fit as Ink draws it** (OB71). Ink wraps at word boundaries, which takes more rows than the hard wrap does (a measured prose paste of
 * 90 to 130 words drew 13 rows where the hard wrap counts 12), so a draft that fits the bound by the hard wrap can still draw taller than the
 * frame was budgeted for. A caller that bounds a frame passes the width of the prompt's lead (`leadWidth`), and the draft then fits only if the
 * rows Ink's own word wrap draws ({@link wrappedRowCount}) fit too; one that does not is windowed, however few hard rows it has.
 */

/** One drawn row of a windowed draft: the text before the cursor cell, the cell, and the text after, all sanitised by the caller's `clean`. */
export interface PromptWindowRow {
  readonly before: string;
  /** The cursor cell, on exactly one row of the whole draft; `undefined` on every other row (and on all of them when the cursor is not drawn). */
  readonly at: string | undefined;
  readonly after: string;
  /** The first row of the draft, which carries the prompt's glyph; every other row hangs under it. */
  readonly first: boolean;
}

export type PromptWindowLine =
  | { readonly kind: 'row'; readonly row: PromptWindowRow }
  /** A marker standing for `count` rows hidden on `side`: the first or last line of the window, which the row that is there is replaced by. */
  | { readonly kind: 'more'; readonly side: 'above' | 'below'; readonly count: number };

/** The fewest rows a window can have: a marker, the row the cursor is on and the other marker. */
export const PROMPT_WINDOW_MIN_ROWS = 3;

/**
 * The rows Ink's word wrap draws for the draft in `columns` columns, as the UNBOUNDED editor draws it: each logical line is one `Text` of the
 * lead (`leadWidth` columns, the prompt's glyph and its space, or the same width of spaces under it), the text before the cursor, the cursor's
 * cell and the text after, wrapped at word boundaries ({@link wrapWords}, the model of Ink's wrap the transcript is measured by), and every
 * line is at least one row. A cursor at a line's end adds its trailing cell, which can wrap onto a row of its own. `cursor` is `-1` when no cursor
 * is drawn. `clean` is the display scrub: the rows are measured on what is drawn.
 */
export function wrappedRowCount(
  text: string,
  cursor: number,
  leadWidth: number,
  columns: number,
  clean: (text: string) => string,
): number {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const lead = ' '.repeat(Math.max(0, Math.floor(leadWidth)));
  let total = 0;
  for (const logical of promptRows(text, cursor)) {
    const cell = logical.at === undefined ? '' : clean(logical.at) || ' ';
    const line = `${lead}${clean(logical.before)}${cell}${clean(logical.after)}`;
    // `wrapWords` answers a row for every line at a width of at least one column (`['']` for an empty one), so a logical line is never zero rows.
    total += wrapWords(line, width).length;
  }
  return total;
}

/** One logical line of the draft as rows of at most `columns` display columns, and which of them (if any) holds the cursor cell. */
function chunkRows(
  logical: PromptRow,
  columns: number,
  clean: (text: string) => string,
): { readonly rows: readonly Omit<PromptWindowRow, 'first'>[]; readonly cursorChunk: number } {
  const before = clean(logical.before);
  // a control character under the cursor is blanked by the scrub: the block stays visible as a space (as the unbounded editor does)
  const cell = logical.at === undefined ? undefined : clean(logical.at) || ' ';
  const plain = `${before}${cell ?? ''}${clean(logical.after)}`;
  const rows: Omit<PromptWindowRow, 'first'>[] = [];
  let cursorChunk = -1;
  let offset = 0;
  for (const chunk of wrapLogicalLine(plain, columns)) {
    if (cell !== undefined && offset <= before.length && before.length < offset + chunk.length) {
      cursorChunk = rows.length;
      const local = before.length - offset;
      rows.push({
        before: chunk.slice(0, local),
        at: cell,
        after: chunk.slice(local + cell.length),
      });
    } else rows.push({ before: chunk, at: undefined, after: '' });
    offset += chunk.length;
  }
  return { rows, cursorChunk };
}

/** The physical rows of the whole draft, the cursor on one of them, and which one. */
function physicalRows(
  text: string,
  cursor: number,
  columns: number,
  clean: (text: string) => string,
): { readonly rows: readonly PromptWindowRow[]; readonly cursorRow: number } {
  const rows: PromptWindowRow[] = [];
  let cursorRow = -1;
  for (const logical of promptRows(text, cursor)) {
    const chunked = chunkRows(logical, columns, clean);
    chunked.rows.forEach((row, index) => {
      if (index === chunked.cursorChunk) cursorRow = rows.length;
      rows.push({ ...row, first: rows.length === 0 });
    });
  }
  return { rows, cursorRow };
}

/**
 * The lines to draw for `text` (the cursor at the UTF-16 offset `cursor`, or `-1` for none) in at most `maxRows` rows of `textColumns` columns,
 * or `undefined` when the draft fits and is drawn unbounded. A window never has fewer than {@link PROMPT_WINDOW_MIN_ROWS} lines. `clean` is the
 * display scrub (`sanitizeInline`): the rows are measured on what is drawn.
 */
export function promptWindow(
  text: string,
  cursor: number,
  textColumns: number,
  maxRows: number,
  clean: (text: string) => string,
  leadWidth?: number,
): readonly PromptWindowLine[] | undefined {
  const columns = Number.isFinite(textColumns) ? Math.max(1, Math.floor(textColumns)) : 80;
  const { rows, cursorRow } = physicalRows(text, cursor, columns, clean);
  const height = Math.max(
    PROMPT_WINDOW_MIN_ROWS,
    Number.isFinite(maxRows) ? Math.floor(maxRows) : 0,
  );
  // Fit as Ink draws it: the hard wrap's rows, and (when the caller says how wide the lead is) the word wrap's.
  const fits =
    rows.length <= height &&
    (leadWidth === undefined ||
      wrappedRowCount(text, cursor, leadWidth, columns + leadWidth, clean) <= height);
  if (fits) return undefined;
  // a cursor that is not drawn is not followed: the window shows the end of the draft, where a person is typing
  const { start, end } = windowBody(
    rows.length,
    cursorRow < 0 ? rows.length - 1 : cursorRow,
    height,
  );
  const lines: PromptWindowLine[] = [];
  for (let index = start; index < end; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (index === start && start > 0) lines.push({ kind: 'more', side: 'above', count: start + 1 });
    else if (index === end - 1 && end < rows.length)
      lines.push({ kind: 'more', side: 'below', count: rows.length - index });
    else lines.push({ kind: 'row', row });
  }
  return lines;
}
