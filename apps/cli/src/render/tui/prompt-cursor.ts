/**
 * The pure row-splitter for the multi-line prompt render (2.5.D step 2), extracted from the ink view so the
 * cursor-placement logic is unit-tested without a render. Splits a (possibly multi-line) buffer into display
 * rows and locates the cursor on exactly ONE row. Kept framework-free — {@link PromptEditor} is the thin ink
 * wrapper that sanitizes + draws these rows.
 */

/**
 * One render row of the prompt: the text before the cursor, the cursor cell, and the text after. `at` is
 * `undefined` when the cursor is not on this row; otherwise it is the single code point under the cursor, or a
 * space when the cursor sits at the row's end (a trailing block). The strings are RAW here (not yet sanitized) —
 * the renderer sanitizes each segment at the display boundary.
 */
export interface PromptRow {
  readonly before: string;
  readonly at: string | undefined;
  readonly after: string;
}

/**
 * Split `text` into render rows (on `\n`) and place the cursor on exactly one of them. `cursor` is a UTF-16
 * code-unit offset in `0..text.length`; at a `\n` boundary the cursor sits at the END of the PRECEDING row. The
 * cursor is assumed valid and non-splitting (the step-2 motions guarantee it — see chat-input.ts). An empty
 * buffer yields a single row with a trailing-block cursor.
 */
export function promptRows(text: string, cursor: number): PromptRow[] {
  const rows = text.split('\n');
  const cells: PromptRow[] = [];
  let start = 0;
  let placed = false;
  for (const row of rows) {
    const end = start + row.length; // exclusive of the row's trailing '\n'
    if (!placed && cursor >= start && cursor <= end) {
      placed = true;
      const col = cursor - start;
      if (col >= row.length) {
        cells.push({ before: row, at: ' ', after: '' }); // cursor at the row end ⇒ a trailing block
      } else {
        const width = (row.codePointAt(col) ?? 0) > 0xffff ? 2 : 1; // an astral char is 2 code units
        cells.push({
          before: row.slice(0, col),
          at: row.slice(col, col + width),
          after: row.slice(col + width),
        });
      }
    } else {
      cells.push({ before: row, at: undefined, after: '' });
    }
    start = end + 1; // skip the '\n'
  }
  return cells;
}
