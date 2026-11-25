/**
 * The ONE geometry of a popup ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §4 and
 * §7): how wide and how tall a popup is drawn, where it sits, how many body rows it has, and whether the terminal can hold it at all. The frame
 * model, the frame view, the measured-frame check and every later page model that depends on the popup's size read THIS function, so a page fitted
 * to one geometry can never be drawn in another (the inspection popup's guarantee: rows the person never saw cannot be recorded as inspected).
 *
 * The numbers, from the ADR:
 * - **Standard**, alternate screen: as wide as the content column, `min(columns − 2 × margin, 76)` with a margin of 6 from 80 to 99 columns and
 *   8 from 100 (68 columns at 80×24, 76 from 88 columns up, never wider), at most 21 rows, centred.
 * - **Inspection** (the approval's full view, a later part): `rows − 1` rows by `columns − 2` columns, 78×23 at 80×24.
 * - **Replace** (the inline renderer, and a flow not yet converted): a framed block in the flow, in place of the body. It is as tall as the live
 *   region allows: the whole live region stays at most `rows − 1` lines (`otherRows` is what else the region draws), because the renderer
 *   clears the user's scrollback once the region reaches the terminal's height; a block that cannot hold its frame and one body row is refused
 *   (`no-room`) and the host draws the notice instead.
 * - **Below 80×24** a popup is not drawn: the host draws a notice with the way back (`below-floor`).
 *
 * A data module ([ADR-0145](../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §10): it imports nothing from `ink`, `react` or
 * `node:` and reads no global, so it is pinned alone and moves to a shared package mechanically.
 */

/** A standard popup, or the large inspection popup that belongs to an approval sheet (ADR-0148 §7). */
export type PopupKind = 'standard' | 'inspection';

/**
 * Where a popup is drawn: `overlay` is the absolutely positioned box in the one overlay slot of the alternate screen (the body stays drawn
 * behind it); `replace` is a framed block in the flow that takes the body's place (the inline renderer, and a flow not yet converted).
 */
export type PopupPlacement = 'overlay' | 'replace';

/** The smallest terminal a popup is drawn on (the product's floor, ADR-0122 §7). */
export const POPUP_FLOOR = { columns: 80, rows: 24 } as const;

/** The widest a standard popup is drawn, whatever the terminal (the content column's own cap). */
export const POPUP_MAX_WIDTH = 76;

/** The tallest a standard popup is drawn. */
export const POPUP_STANDARD_MAX_ROWS = 21;

/** The rows of the frame around the body: the top edge (the title and the origin), the legend and the bottom edge. */
export const POPUP_FRAME_ROWS = 3;

/** The step rail's one row, drawn only for a popup of more than one step (ADR-0148 §1). */
export const POPUP_RAIL_ROWS = 1;

/** The columns of blank margin inside the frame on each side, so a row's text never touches the body behind the popup. */
export const POPUP_SIDE_MARGIN = 1;

/** A list drawn inline (the accessible mode) is windowed to at most this many rows (ADR-0148 §4). */
export const INLINE_LIST_MAX_ROWS = 10;

/** The margin of the content column at `columns`: 6 from 80 to 99 columns, 8 from 100. */
export function popupMargin(columns: number): number {
  return columns >= 100 ? 8 : 6;
}

/** The frame's width of a popup of `kind` on a terminal of `columns` (see the module header): what every row of it is filled to. */
export function popupWidth(columns: number, kind: PopupKind): number {
  return kind === 'inspection'
    ? columns - 2
    : Math.min(columns - 2 * popupMargin(columns), POPUP_MAX_WIDTH);
}

/** The columns a row's text may use in a popup of `kind` on a terminal of `columns`: the frame's width less the margin on each side. */
export function popupInnerWidth(columns: number, kind: PopupKind): number {
  return popupWidth(columns, kind) - 2 * POPUP_SIDE_MARGIN;
}

/**
 * The most columns a notification may take and still be read whole inside a standard popup at the floor (80×24: 66): while a popup is open the
 * notification is drawn in the popup's own legend row, fitted to its inner width (`frame-model.ts`). Every text a popup or its host passes to the
 * notification channel fits this; a longer one is cut with the ellipsis there. Derived from the geometry, never typed.
 */
export const POPUP_NOTICE_MAX_COLUMNS = popupInnerWidth(POPUP_FLOOR.columns, 'standard');

/** Whether a terminal of this size can hold a popup: at least 80×24, in whole cells. */
export function popupFits(columns: number, rows: number): boolean {
  return (
    Number.isSafeInteger(columns) &&
    Number.isSafeInteger(rows) &&
    columns >= POPUP_FLOOR.columns &&
    rows >= POPUP_FLOOR.rows
  );
}

export interface PopupGeometryInput {
  readonly columns: number;
  readonly rows: number;
  readonly kind: PopupKind;
  readonly placement: PopupPlacement;
  /** The popup has more than one step, so its rail takes a row. */
  readonly rail: boolean;
  /** The rows its body would like; absent ⇒ every row it may have. Clamped to at least one and at most what it may have. */
  readonly bodyRows?: number | undefined;
  /** `replace` only: the rows of the live region the block shares it with, so the whole stays at most `rows − 1` lines. Default 0. */
  readonly otherRows?: number | undefined;
}

/** A terminal that cannot hold the popup: below the floor, or (a block in the flow) no room left for its frame and one body row. */
export interface PopupRefusedGeometry {
  readonly fits: false;
  readonly reason: 'below-floor' | 'no-room';
}

export interface PopupBoxGeometry {
  readonly fits: true;
  readonly kind: PopupKind;
  readonly placement: PopupPlacement;
  /** The frame's width in cells: every row of the popup is exactly this wide (padded with spaces: the padding is what makes it opaque). */
  readonly width: number;
  /** The frame's height in rows: exactly the rows the popup draws. */
  readonly height: number;
  /** Where the box sits on the screen (`overlay`); `0` for a block in the flow, which the flow places. */
  readonly left: number;
  readonly top: number;
  /** The columns a row's text may use: the width less the margin on each side. */
  readonly innerWidth: number;
  /** The rows the body may have at most. */
  readonly maxBodyRows: number;
  /** The rows the body has: what it asked for, clamped. */
  readonly bodyRows: number;
  /** The rows a list may use: every body row, but at most {@link INLINE_LIST_MAX_ROWS} in a block in the flow. */
  readonly listRows: number;
  /** `1` when the rail is drawn, else `0`. */
  readonly railRows: number;
}

export type PopupGeometry = PopupRefusedGeometry | PopupBoxGeometry;

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * The geometry of a popup on a terminal of `columns`×`rows` (see the module header for the rules). Pure: the same input is the same box, and a
 * test pins every number of the ADR on it (68×21 at 80×24, 76 from 88 columns, 78×23 for the inspection popup).
 */
export function popupGeometry(input: PopupGeometryInput): PopupGeometry {
  const { columns, rows, kind, placement } = input;
  if (!popupFits(columns, rows)) return { fits: false, reason: 'below-floor' };
  const railRows = input.rail ? POPUP_RAIL_ROWS : 0;
  const chrome = POPUP_FRAME_ROWS + railRows;
  const width = popupWidth(columns, kind);
  const tallest = kind === 'inspection' ? rows - 1 : POPUP_STANDARD_MAX_ROWS;
  // A block in the flow shares the live region with what else it draws, and the whole region stays at most `rows − 1` lines.
  const room =
    placement === 'replace' ? rows - 1 - Math.max(0, Math.trunc(input.otherRows ?? 0)) : tallest;
  const maxHeight = Math.min(tallest, room);
  if (maxHeight < chrome + 1) return { fits: false, reason: 'no-room' };
  const maxBodyRows = maxHeight - chrome;
  // The inspection popup always takes its whole height: its page is projected from it (ADR-0148 §7).
  const wanted = kind === 'inspection' ? maxBodyRows : Math.trunc(input.bodyRows ?? maxBodyRows);
  const bodyRows = clamp(Number.isFinite(wanted) ? wanted : maxBodyRows, 1, maxBodyRows);
  const height = chrome + bodyRows;
  const overlay = placement === 'overlay';
  return {
    fits: true,
    kind,
    placement,
    width,
    height,
    left: overlay ? Math.floor((columns - width) / 2) : 0,
    top: overlay ? Math.floor((rows - height) / 2) : 0,
    innerWidth: popupInnerWidth(columns, kind),
    maxBodyRows,
    bodyRows,
    listRows: placement === 'replace' ? Math.min(maxBodyRows, INLINE_LIST_MAX_ROWS) : maxBodyRows,
    railRows,
  };
}
