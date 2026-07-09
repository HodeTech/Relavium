import { clampOffset, maxOffset } from './viewport.js';

/**
 * The pure scroll / auto-follow state machine for the full-screen alt-screen transcript viewport (2.6.F Step 4b-2,
 * [ADR-0068](../../../../docs/decisions/0068-full-screen-tui-renderer-ink7-harness.md) §c). A single `following`
 * boolean (default true): while following, the view is pinned to the TAIL and every append shows at the bottom; any
 * UPWARD scroll pauses following and freezes the offset; scrolling back down to the bottom (or `Ctrl+End`) resumes.
 *
 * PURE + geometry-parameterized: the reducer takes the current `{ totalLines, height }` on each keypress (the wrapped
 * display-line count + the viewport's measured visible rows) rather than owning them, so it is exhaustively
 * unit-testable with no ink mount, and the surface owners (`ChatApp` / the Home controller) hold the {@link
 * ScrollState} like they hold the editor / palette state and feed the live geometry.
 */
export interface ScrollState {
  /** The top display-line index shown when NOT following. Ignored while `following` (the view is pinned to the tail,
   *  whose offset is derived from the live geometry — see {@link effectiveOffset}). */
  readonly offset: number;
  /** `true` ⇒ pinned to the tail (every append pins to the bottom); any upward scroll flips it false, and reaching
   *  the bottom (a downward scroll landing at maxOffset, or `Ctrl+End`) flips it back true. */
  readonly following: boolean;
}

/** The initial scroll state — following the tail (an empty transcript is trivially at the bottom). */
export const INITIAL_SCROLL: ScrollState = { offset: 0, following: true };

/** The live geometry the reducer clamps against: the total wrapped display-line count + the viewport's visible rows. */
export interface ScrollGeometry {
  readonly totalLines: number;
  readonly height: number;
}

/** The scroll motions the keymap produces: PgUp/PgDn, line up/down, and jump to top/bottom (Ctrl+Home / Ctrl+End). */
export type ScrollMotion = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom';

/**
 * The effective top-line offset to hand the viewport: the TAIL (`maxOffset`) while following, else the frozen offset
 * clamped into range. Always a valid index — the viewport renders `lines[offset : offset + height]` from it.
 */
export function effectiveOffset(state: ScrollState, geom: ScrollGeometry): number {
  return state.following
    ? maxOffset(geom.totalLines, geom.height)
    : clampOffset(state.offset, geom.totalLines, geom.height);
}

/**
 * Reduce a scroll motion against the live geometry. Every motion computes from the CURRENT effective offset (so an
 * upward scroll while following starts at the tail and moves up, pausing follow), then re-derives `following` from
 * whether the result lands at the bottom. A page overlaps by one row (`height - 1`) so a line of context carries
 * across the jump; a 0/1-row viewport degrades to a single-line step (never a non-advancing page).
 */
export function reduceScroll(
  state: ScrollState,
  motion: ScrollMotion,
  geom: ScrollGeometry,
): ScrollState {
  const max = maxOffset(geom.totalLines, geom.height);
  const from = effectiveOffset(state, geom);
  const page = Math.max(1, geom.height - 1); // overlap one row of context; never a zero-length page

  switch (motion) {
    case 'top':
      // Jump to the very top — always pauses following (unless there is nothing to scroll, i.e. max === 0).
      return settle(0, max);
    case 'bottom':
      // Jump to the tail — always resumes following.
      return { offset: max, following: true };
    case 'line-up':
      return settle(from - 1, max);
    case 'line-down':
      return settle(from + 1, max);
    case 'page-up':
      return settle(from - page, max);
    case 'page-down':
      return settle(from + page, max);
  }
}

/** Clamp a target offset into `[0, max]` and derive `following` (true iff it lands at — or past — the bottom). */
function settle(target: number, max: number): ScrollState {
  const offset = Math.min(Math.max(0, target), max);
  return { offset, following: offset >= max };
}

/** The key fields the scroll keymap reads (a structural subset of the surfaces' `ChatKey`). */
export interface ScrollKey {
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly ctrl?: boolean;
}

/**
 * The SHARED alt-screen scroll keymap (both surfaces route through it so they can never diverge, ADR-0068 §c):
 * **PgUp/PgDn** page the viewport, **Ctrl+Home/Ctrl+End** jump to top/bottom. `undefined` ⇒ not a scroll key (the
 * caller falls through to the editor/overlay routing). Bare Home/End are LEFT to the editor (line-start/line-end),
 * so only the Ctrl-modified forms scroll — no collision with the line-editing keymap.
 */
export function scrollMotionForKey(key: ScrollKey): ScrollMotion | undefined {
  if (key.pageUp === true) return 'page-up';
  if (key.pageDown === true) return 'page-down';
  if (key.ctrl === true && key.home === true) return 'top';
  if (key.ctrl === true && key.end === true) return 'bottom';
  return undefined;
}

/** How many display lines one mouse-wheel notch scrolls (the conventional 3-line step). */
export const WHEEL_LINES = 3;

/**
 * Classify a terminal SGR-mouse (DECSET 1006) escape (2.6.F Step 5): the alt screen enables mouse reporting
 * (1000 + 1006), so a report arrives on `useInput`'s `input` as `ESC [ < b ; col ; row (M|m)`. Returns the wheel
 * scroll motion (button **64** ⇒ wheel-up `line-up`, **65** ⇒ wheel-down `line-down`), `'ignore'` for ANY OTHER mouse
 * report (a click / drag / non-wheel button), or `undefined` when the input is not a mouse report at all. The caller
 * CONSUMES any non-`undefined` result — even `'ignore'` — so a mouse report's raw bytes never reach the editor; the
 * coordinates are dropped (scroll is not position-sensitive).
 */
export type MouseScroll = ScrollMotion | 'ignore';

export function parseMouseScroll(input: string): MouseScroll | undefined {
  // The leading ESC is OPTIONAL — ink parse-keypress may hand the CSI to `input` with or without it.
  // eslint-disable-next-line no-control-regex -- the SGR mouse report is introduced by ESC (U+001B)
  const match = /^\x1b?\[<(\d+);\d+;\d+[Mm]$/.exec(input);
  if (match === null) return undefined; // not a mouse report
  const button = Number(match[1]);
  if (button === 64) return 'line-up'; // wheel up ⇒ reveal older lines
  if (button === 65) return 'line-down'; // wheel down ⇒ toward the tail
  return 'ignore'; // a mouse report but not a wheel — consume it (don't scroll, don't type)
}
