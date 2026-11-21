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
  | 'rule'
  | 'heading'
  | 'row'
  | 'selected'
  | 'armed'
  | 'text'
  | 'marker'
  | 'note'
  | 'hint'
  | 'message'
  | 'done'
  | 'failed'
  | 'notice'
  | 'question'
  | 'legend';

/** A role a stretch of a line can take over the style of its kind: a dimmed value, an emphasised key, a danger, a success, an attention. */
export type SheetRole = 'dim' | 'strong' | 'danger' | 'ok' | 'warn';

/** A stretch of a line's text, by JS string index (`from` inclusive, `to` exclusive), that takes a role. */
export interface SheetSpan {
  readonly from: number;
  readonly to: number;
  readonly role: SheetRole;
}

export interface SheetLine {
  readonly kind: SheetLineKind;
  readonly text: string;
  /** Stretches of {@link SheetLine.text} that override the line's own style; absent ⇒ the whole line takes its kind's style. */
  readonly spans?: readonly SheetSpan[];
}

/** The spans that still lie inside `text` once it has been cut to `length` characters; a span that straddles the cut is shortened. */
export function clampSpans(spans: readonly SheetSpan[], length: number): readonly SheetSpan[] {
  return spans
    .filter((span) => span.from < length)
    .map((span) => (span.to <= length ? span : { ...span, to: length }));
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
 * The window of `height` lines of `total` around `cursorLine`. It starts centred on the cursor and, if the caller's `accept` check refuses it,
 * moves outward one line at a time to the nearest start it accepts; a caller that accepts nothing gets the centred window.
 *
 * `accept(start, end)` says whether the window `[start, end)` is a good one for this content: the caller knows what its lines are, so only it
 * can say that a marker would stand in for no row, that a heading would be left alone above one, or that the cursor would sit on one. The
 * default accepts any window that keeps the cursor off the first and last lines when lines are hidden on that side (every hidden line
 * counted as a row), which a window of fewer than three lines cannot do. Pure so the arithmetic is unit-checkable.
 */
export function windowBody(
  total: number,
  cursorLine: number,
  height: number,
  accept?: (start: number, end: number) => boolean,
): { readonly start: number; readonly end: number } {
  if (total <= height) return { start: 0, end: total };
  const last = total - height;
  const centred = Math.max(0, Math.min(cursorLine - Math.floor((height - 1) / 2), last));
  const ok =
    accept ??
    ((start: number, end: number): boolean =>
      cursorLine >= start + (start > 0 ? 1 : 0) && cursorLine < end - (end < total ? 1 : 0));
  for (let offset = 0; offset <= last; offset += 1) {
    for (const start of offset === 0 ? [centred] : [centred - offset, centred + offset]) {
      if (start < 0 || start > last) continue;
      if (ok(start, start + height)) return { start, end: start + height };
    }
  }
  return { start: centred, end: centred + height };
}
