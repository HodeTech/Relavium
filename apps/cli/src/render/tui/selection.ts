import { partitionDisplayColumns, sliceDisplayColumns } from './viewport.js';

/**
 * The pure text-selection state machine for the full-screen transcript viewport (2.6.F Step 6, ADR-0068 §e amendment)
 * — the counterpart of `scroll.ts`. Mouse reporting takes the emulator's own click-drag selection away from the user
 * (that is the price of a scrolling wheel), so the app gives it back: drag to select, release to copy.
 *
 * COORDINATES. A {@link Cell} is `{ line, column }` where `line` indexes the WRAPPED transcript (the same
 * `DisplayLine[]` the viewport windows) and `column` is a DISPLAY COLUMN, not a character index — a CJK glyph or an
 * emoji occupies two, a combining mark none. Both are 0-based. The surface converts a terminal's 1-based mouse row
 * into a line index; that mapping lives at the render boundary, not here.
 *
 * PURE + geometry-free: no ink, no terminal, no scroll offset. The reducer never clamps to the viewport, because a
 * selection legitimately extends past it — the user drags, scrolls, and drags again.
 */

/** A position in the wrapped transcript: a display-line index and a display column, both 0-based. */
export interface Cell {
  readonly line: number;
  readonly column: number;
}

/** A live selection: where the drag began, and where the pointer is now. Both endpoints are real, ordered by the
 *  user's gesture — {@link normalizeSelection} puts them in document order. */
export interface SelectionState {
  readonly anchor: Cell;
  readonly focus: Cell;
}

/** A selection in document order, INCLUSIVE of both endpoint cells (as every terminal's own selection is). */
export interface SelectionRange {
  readonly start: Cell;
  readonly end: Cell;
}

/** Order two cells: earlier line first, then earlier column. */
function before(a: Cell, b: Cell): boolean {
  return a.line !== b.line ? a.line < b.line : a.column < b.column;
}

/** `true` when anchor and focus are the same cell — a plain CLICK, which selects nothing and copies nothing. It still
 *  CLEARS any prior selection, which is why a click is not simply ignored. */
export function isCollapsed(state: SelectionState): boolean {
  return state.anchor.line === state.focus.line && state.anchor.column === state.focus.column;
}

/** Put the gesture into document order. A drag upward or leftward is as valid as one downward. */
export function normalizeSelection(state: SelectionState): SelectionRange {
  return before(state.focus, state.anchor)
    ? { start: state.focus, end: state.anchor }
    : { start: state.anchor, end: state.focus };
}

/**
 * The half-open display-column span `[from, to)` selected on one wrapped line, or `undefined` when the line is outside
 * the selection. `to === undefined` means "to the end of the line" — the row is fully selected from `from` onward,
 * whatever its width, so a caller never needs to know how long the row is.
 *
 * The `end` cell is INCLUSIVE, so the last (or only) line extends one column past it.
 */
export function lineSpan(
  line: number,
  range: SelectionRange,
): { readonly from: number; readonly to: number | undefined } | undefined {
  if (line < range.start.line || line > range.end.line) return undefined;
  const from = line === range.start.line ? range.start.column : 0;
  const to = line === range.end.line ? range.end.column + 1 : undefined;
  return { from, to };
}

/** The maximum display column any real transcript row can reach — a stand-in for "to the end of the line" when a span
 *  is open-ended. Any value at least as large as the widest row works; `sliceDisplayColumns` truncates. */
const OPEN_END = Number.MAX_SAFE_INTEGER;

/**
 * Extract the selected text from the wrapped transcript, `\n`-joined.
 *
 * It copies the VISUAL rows the user actually selected, so a paragraph that the viewport wrapped comes back with those
 * wraps as newlines — precisely what the terminal's own selection would have given, and what the highlight showed.
 * (`/edit` and `/copy` hand over the UNWRAPPED document when fidelity matters more than the visual.)
 */
export function selectionText(lines: readonly string[], range: SelectionRange): string {
  const out: string[] = [];
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const row = lines[line];
    if (row === undefined) continue; // a selection anchored before a transcript rebuild — copy what still exists
    const span = lineSpan(line, range);
    if (span === undefined) continue;
    out.push(sliceDisplayColumns(row, span.from, span.to ?? OPEN_END));
  }
  return out.join('\n');
}

/** One wrapped row, split by the selection into the three pieces the viewport renders: unselected head, highlighted
 *  middle, unselected tail. Kept PURE (and exhaustively tested) so the component stays a three-`<Text>` arrangement —
 *  an ANSI inverse attribute is invisible to a frame snapshot, so the splitting is where correctness must be pinned. */
export interface RowSegments {
  readonly before: string;
  readonly selected: string;
  readonly after: string;
}

/**
 * Split `text` at the display-column span the selection covers on this row. An open-ended span (`to === undefined`)
 * highlights to the end of the row, whatever its width — that is what a multi-line selection does to its inner rows.
 * A span that starts past the row's width selects nothing and leaves the row whole, which is what a drag over a short
 * line does.
 */
export function splitRow(
  text: string,
  span: { readonly from: number; readonly to: number | undefined },
): RowSegments {
  return partitionDisplayColumns(text, span.from, span.to ?? OPEN_END);
}
