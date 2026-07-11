import type { MouseEvent } from './mouse.js';
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

/**
 * What the reducer needs to know about the viewport at the instant a mouse event arrives: where it sits in ink's
 * frame, how big it is, how far the transcript is scrolled, and how long the transcript is. Everything here is
 * measured (`ViewportGeometry`) or derived (`effectiveOffset`) — the reducer computes none of it.
 */
export interface SelectionViewport {
  /** The viewport's first row, as a 0-based row in ink's frame. Frame row 0 IS terminal row 1. */
  readonly top: number;
  /** The viewport's left edge, as a 0-based column in ink's frame. */
  readonly left: number;
  /** Visible rows. */
  readonly height: number;
  /** Total wrapped display lines in the transcript. */
  readonly totalLines: number;
  /** The top display-line index currently shown (`effectiveOffset` of the scroll state). */
  readonly offset: number;
}

/**
 * Translate a terminal's 1-based `row`/`column` into a wrapped-transcript {@link Cell}.
 *
 * Clamped on BOTH axes, because a drag legitimately leaves the viewport: pulling above the top row anchors to the
 * first visible line, below the bottom row to the last, and past the left edge to column 0. Without the clamp a drag
 * off the top would index a negative line and select nothing — the single most likely way to make selection feel
 * broken.
 */
export function cellAt(row: number, column: number, viewport: SelectionViewport): Cell {
  const visibleRow = Math.min(
    Math.max(row - 1 - viewport.top, 0),
    Math.max(viewport.height - 1, 0),
  );
  const lastLine = Math.max(viewport.totalLines - 1, 0);
  return {
    line: Math.min(viewport.offset + visibleRow, lastLine),
    column: Math.max(column - 1 - viewport.left, 0),
  };
}

/**
 * Is a terminal's 1-based `row` inside the viewport?
 *
 * {@link cellAt} deliberately CLAMPS, which is what a drag needs — the pointer leaves the viewport all the time. A
 * PRESS is different: clamping one that landed on the prompt, the status strip, or the live streaming region anchors
 * the selection to the viewport's last visible line, so the user drags across text they never touched and copies it.
 * A press outside the viewport starts nothing.
 */
export function containsRow(row: number, viewport: SelectionViewport): boolean {
  const frameRow = row - 1; // frame row 0 IS terminal row 1
  return frameRow >= viewport.top && frameRow < viewport.top + viewport.height;
}

/**
 * The scroll motion a DRAG at `row` should trigger before its focus is mapped, or `undefined` when the pointer is
 * comfortably inside the viewport.
 *
 * Without this a selection can never exceed one screenful: `cellAt` clamps the focus to the last visible line, so
 * dragging further down just re-selects the same last row. Dragging to the top or bottom EDGE now scrolls a line and
 * the focus is mapped against the new offset, exactly as a text editor does.
 *
 * KNOWN LIMIT, and it is the terminal's: DECSET 1002 reports motion only when the pointer enters a NEW CELL. Holding
 * the pointer still at the edge sends nothing, so the scroll advances per movement rather than on a timer. Moving the
 * pointer even one cell resumes it.
 */
export function dragScrollMotion(
  row: number,
  viewport: SelectionViewport,
): 'line-up' | 'line-down' | undefined {
  if (viewport.height <= 0) return undefined;
  const frameRow = row - 1;
  if (frameRow <= viewport.top) return 'line-up';
  if (frameRow >= viewport.top + viewport.height - 1) return 'line-down';
  return undefined;
}

/** What the surface should do with a mouse event. `'none'` ⇒ nothing changed (the event is still CONSUMED — a mouse
 *  report's raw bytes must never reach the prompt). */
export type SelectionAction =
  | { readonly kind: 'none' }
  /** Replace the live selection (a press starts one collapsed; a drag extends it). */
  | { readonly kind: 'set'; readonly state: SelectionState }
  /** Drop the highlight — a plain click, or a release with nothing selected. */
  | { readonly kind: 'clear' }
  /** The drag ended on a real selection: copy `text`, and KEEP the highlight (as every terminal does). */
  | { readonly kind: 'copy'; readonly state: SelectionState };

/**
 * Reduce one mouse event into the next selection. PURE, and shared by both surfaces so `relavium chat` and the
 * in-Home chat can never disagree about what a drag does.
 *
 * The WHEEL is not handled here — it belongs to `reduceScroll`, and routing it through the selection would start a
 * highlight on every notch. The caller checks `event.kind === 'wheel'` first.
 */
export function reduceSelection(
  current: SelectionState | undefined,
  event: MouseEvent,
  viewport: SelectionViewport,
): SelectionAction {
  switch (event.kind) {
    case 'press': {
      // Only the LEFT button selects. Middle pastes and right opens a menu in most emulators; neither should disturb
      // a selection the user is about to copy.
      if (event.button !== 'left') return { kind: 'none' };
      // A press on the prompt, the status strip, or the live streaming region is not a selection. `cellAt` would clamp
      // it onto the viewport's last visible line and anchor there — the user would then drag across, and copy, text
      // they never pressed on.
      if (!containsRow(event.row, viewport)) return { kind: 'none' };
      const anchor = cellAt(event.row, event.column, viewport);
      return { kind: 'set', state: { anchor, focus: anchor } }; // collapsed: a click alone highlights nothing
    }
    case 'drag': {
      if (event.button !== 'left' || current === undefined) return { kind: 'none' };
      const focus = cellAt(event.row, event.column, viewport);
      return { kind: 'set', state: { anchor: current.anchor, focus } };
    }
    case 'release': {
      if (current === undefined) return { kind: 'none' };
      // Only the release that ENDS a left gesture copies. A middle/right button coming up while a selection is live
      // must leave it alone — otherwise every right-click re-emits the whole selection over OSC 52. `undefined` is a
      // terminal still reporting the X10 "no button" code 3: honour the legacy meaning and end the gesture.
      if (event.button === 'middle' || event.button === 'right') return { kind: 'none' };
      // A click that never moved: clear the previous highlight rather than copy a single cell.
      if (isCollapsed(current)) return { kind: 'clear' };
      return { kind: 'copy', state: current };
    }
    case 'wheel':
    case 'other':
      return { kind: 'none' };
  }
}

/**
 * The surface's side of one mouse gesture. Everything here is a capability the ink tree owns (React state, the scroll
 * reducer, the clipboard); `routeMouseSelection` orchestrates them and stays testable without a terminal.
 */
export interface SelectionRouterPorts {
  /** The viewport as it is RIGHT NOW. Called again after a scroll, so the focus maps against the new offset. */
  readonly geometry: () => SelectionViewport;
  /** The live selection, read from a ref — a drag burst arrives in one tick, before React re-renders. */
  readonly current: () => SelectionState | undefined;
  readonly setSelection: (state: SelectionState | undefined) => void;
  /** Write the selection to the system clipboard. */
  readonly copy: (state: SelectionState) => void;
  /** Scroll the transcript by one line (the surface applies `reduceScroll` against its live geometry). */
  readonly scrollBy: (motion: 'line-up' | 'line-down') => void;
  /** Pin the transcript where it is, so a completing turn cannot move it under the pointer. Returns whether the view
   *  WAS following, which the caller stores for {@link SelectionRouterPorts.restoreFollow}. */
  readonly pauseFollow: () => void;
  /** Undo a {@link SelectionRouterPorts.pauseFollow} that turned out to belong to a plain click, not a drag. */
  readonly restoreFollow: () => void;
  /** Whether a LEFT-button gesture is currently in flight — set by a press that lands inside the viewport, cleared on
   *  its release. Distinct from a RETAINED selection (the highlight kept after a copy). Without it a stray release —
   *  a click on the prompt after a copy — re-copies the retained highlight over OSC 52. */
  readonly gestureActive: () => boolean;
  readonly setGestureActive: (active: boolean) => void;
}

/**
 * Route one non-wheel mouse report into the selection. SHARED by `relavium chat` and the in-Home chat, which is the
 * point: the two `useInput` handlers had byte-identical copies of this and would have drifted the moment either grew
 * a behaviour (2.6.F Step 6f, Opus review).
 *
 * Beyond the pure {@link reduceSelection} it owns three things the reducer cannot, because they touch scroll state:
 *
 * 1. **Edge auto-scroll.** A drag on the viewport's first or last row scrolls a line BEFORE the focus is mapped, so a
 *    selection can grow past one screenful. Without it `cellAt` clamps and the user just re-selects the last row.
 * 2. **Freeze auto-follow on press.** While following, every completed turn re-pins the view to the tail — which would
 *    slide the transcript out from under a drag and leave the highlight on different text than the pointer.
 * 3. **Un-freeze on a plain click.** A click is a press+release with no movement. Pausing follow for it would silently
 *    stop the transcript from following the stream, with nothing on screen to explain why. The `clear` a collapsed
 *    release produces restores exactly what the press paused.
 */
export function routeMouseSelection(event: MouseEvent, ports: SelectionRouterPorts): void {
  // A DRAG or RELEASE only acts while a gesture is in flight (a press that landed inside the viewport). Without this
  // gate a retained highlight — kept on screen after a copy — is re-copied by the release of a stray click on the
  // prompt or the status strip, and a drag whose press missed the viewport would resurrect it. A PRESS always runs:
  // it is what STARTS a gesture.
  if ((event.kind === 'drag' || event.kind === 'release') && !ports.gestureActive()) return;

  // The scroll must happen first: the focus is then mapped against the offset the user can actually see.
  if (event.kind === 'drag' && event.button === 'left') {
    const motion = dragScrollMotion(event.row, ports.geometry());
    if (motion !== undefined) ports.scrollBy(motion);
  }

  const action = reduceSelection(ports.current(), event, ports.geometry());
  switch (action.kind) {
    case 'none':
      return;
    case 'clear':
      ports.setSelection(undefined);
      ports.setGestureActive(false);
      ports.restoreFollow(); // it was a click, not a drag
      return;
    case 'set':
      ports.setSelection(action.state);
      if (event.kind === 'press') {
        ports.setGestureActive(true); // a valid press inside the viewport opens the gesture
        ports.pauseFollow();
      }
      return;
    case 'copy':
      ports.setSelection(action.state); // keep the highlight, as every terminal does
      ports.setGestureActive(false);
      ports.copy(action.state);
      return;
  }
}
