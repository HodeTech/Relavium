import { displayWidth, sliceDisplayColumns } from './viewport.js';

/**
 * The small, pure frame a sheet is drawn on ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §5): the roles of its lines, the width a line may use, how a line is cut to it, how a label and a value share one row, and the window of a
 * long list that keeps the cursor on a real line. Nothing here knows what a sheet is about; `permissions-sheet.ts` is the first screen built
 * on it, and `legend.ts` is its other half. The older overlays (`/models`, `/effort`, the palette, the session picker) keep their own
 * footers and windows until the common-language increment moves them.
 */

/** The role of one drawn line, so a view colours by role and never by guessing from the text. */
export type SheetLineKind =
  | 'title'
  | 'heading'
  | 'row'
  | 'selected'
  | 'text'
  | 'marker'
  | 'note'
  | 'message'
  | 'question'
  | 'legend';

export interface SheetLine {
  readonly kind: SheetLineKind;
  readonly text: string;
}

export interface SheetGeometry {
  readonly columns: number;
  readonly terminalRows: number;
}

/** The widest a sheet's lines are drawn: on a wide terminal a row's value would otherwise sit a hundred columns from its label. */
export const SHEET_MAX_COLUMNS = 100;

/** The columns a line may use: a margin on each side, and no wider than {@link SHEET_MAX_COLUMNS}. */
export function usableColumns(columns: number): number {
  return Math.max(1, Math.min(columns - 2, SHEET_MAX_COLUMNS));
}

/**
 * `text` cut to at most `width` display columns, the cut shown by `…`; whole when it fits. A wide character (CJK, an emoji sequence) that
 * straddles the cut is left out, never counted over the width.
 */
export function clipLine(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return sliceDisplayColumns(text, 0, Math.max(0, width));
  let cut = sliceDisplayColumns(text, 0, width - 1);
  if (displayWidth(cut) > width - 1) cut = sliceDisplayColumns(text, 0, width - 2);
  return `${cut}…`;
}

/** The gap kept between a row's label and what flushes right. */
const GAP = 2;
/** The least room the label keeps before the right-hand value is dropped instead of squeezing it. */
const MIN_LABEL = 12;

/** `left` and `right` on one row, `right` flush to the edge; `left` is clipped first, and `right` is dropped when it would leave no room. */
export function flushRow(left: string, right: string, width: number): string {
  if (right.length === 0) return clipLine(left, width);
  const room = width - displayWidth(right) - GAP;
  if (room < MIN_LABEL) return clipLine(left, width);
  const clipped = clipLine(left, room);
  return `${clipped}${' '.repeat(Math.max(GAP, width - displayWidth(clipped) - displayWidth(right)))}${right}`;
}

/**
 * The window of `height` lines of `total` that keeps `cursorLine` on a real line: when lines are hidden above or below, the first or last
 * window line is a marker, and the cursor is never on one. The cursor is centred, which leaves it at least one line from each end of a
 * window of three or more lines (a window of fewer lines cannot hold a cursor between two markers; the floor of 80×24 gives a sheet at
 * least seven). Pure so the arithmetic is unit-checkable.
 */
export function windowBody(
  total: number,
  cursorLine: number,
  height: number,
): { readonly start: number; readonly end: number } {
  if (total <= height) return { start: 0, end: total };
  const start = Math.max(0, Math.min(cursorLine - Math.floor((height - 1) / 2), total - height));
  return { start, end: start + height };
}
