import {
  CARD_CONTEXT_LINES,
  projectReviewPage,
  REVIEW_START,
  type ReviewCursor,
  type ReviewDocument,
} from './tool-review-projection.js';

/**
 * How the full view moves through a review document ([ADR-0134](../../../../../docs/decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md)).
 *
 * Pure and framework-free. Nothing here decides what must be inspected or what an answer needs: that stays with the
 * review state machine and the projection. This module only answers "where does the cursor go" — by a line, a page, to
 * either end, or to the next change — for the deduplicated listing the full view draws (a before copy of an unchanged line
 * that nothing masks is not listed, so it is not a stop, a row or a step).
 *
 * The cursor is a source line plus an absolute offset into that line's field (a long line pages through its rows). Every
 * motion lands on a line start, except a page that is cut inside a long line, which {@link pageDown} continues from.
 */

/** What the geometry of a page depends on: the projection of one line gives the same rows the page would. */
export interface ScrollView {
  readonly columns: number;
  readonly rowLimit: number;
  readonly reveal: boolean;
  readonly numeric: boolean;
}

/** Whether the full view lists this line. */
function listed(document: ReviewDocument, index: number): boolean {
  const line = document.lines[index];
  return line !== undefined && line.fullSkip !== true;
}

function nextListed(document: ReviewDocument, from: number): number | undefined {
  for (let index = from + 1; index < document.lines.length; index++)
    if (listed(document, index)) return index;
  return undefined;
}

function previousListed(document: ReviewDocument, from: number): number | undefined {
  for (let index = Math.min(from, document.lines.length) - 1; index >= 0; index--)
    if (listed(document, index)) return index;
  return undefined;
}

function firstListed(document: ReviewDocument): number | undefined {
  return listed(document, 0) ? 0 : nextListed(document, 0);
}

function lastListed(document: ReviewDocument): number | undefined {
  return previousListed(document, document.lines.length);
}

export function compareCursors(a: ReviewCursor, b: ReviewCursor): number {
  return a.line - b.line || a.offset - b.offset;
}

/**
 * How many rows one line takes at this width — at most the page height, which is all a position needs: a line that fills a
 * page fills it however much longer it is. A projection that gives up (a line past the work bound) counts as a full page.
 */
export function lineRows(document: ReviewDocument, index: number, view: ScrollView): number {
  const line = document.lines[index];
  if (line === undefined) return 0;
  const page = projectReviewPage(
    { ...document, lines: [line] },
    REVIEW_START,
    view.columns,
    view.rowLimit,
    view.reveal,
    view.numeric,
  );
  return page.valid ? Math.max(1, page.rows.length) : view.rowLimit;
}

/**
 * The first line of the last full page: the cursor `End` goes to, and the furthest any scroll goes, so the screen never
 * ends in blank rows. A document whose last line alone fills a page starts that page on the line.
 */
const lastPages = new WeakMap<ReviewDocument, Map<string, ReviewCursor>>();
export function lastPageStart(document: ReviewDocument, view: ScrollView): ReviewCursor {
  // A document never changes, so the last page for one geometry is computed once: every key that moves down asks for it.
  const key = `${view.columns}|${view.rowLimit}|${view.reveal ? 1 : 0}${view.numeric ? 1 : 0}`;
  const known = lastPages.get(document)?.get(key);
  if (known !== undefined) return known;
  const computed = computeLastPageStart(document, view);
  const byView = lastPages.get(document) ?? new Map<string, ReviewCursor>();
  if (byView.size >= 8) byView.clear();
  byView.set(key, computed);
  lastPages.set(document, byView);
  return computed;
}

function computeLastPageStart(document: ReviewDocument, view: ScrollView): ReviewCursor {
  const last = lastListed(document);
  if (last === undefined) return REVIEW_START;
  let start = last;
  let used = lineRows(document, last, view);
  for (
    let previous = previousListed(document, start);
    previous !== undefined;
    previous = previousListed(document, start)
  ) {
    const rows = lineRows(document, previous, view);
    if (used + rows > view.rowLimit) break;
    used += rows;
    start = previous;
  }
  return { line: start, offset: 0 };
}

/** The top of the document: its first listed line (a deduplicated listing never begins on a skipped copy). */
export function topCursor(document: ReviewDocument): ReviewCursor {
  const first = firstListed(document);
  return first === undefined || first === 0 ? REVIEW_START : { line: first, offset: 0 };
}

/** Move `delta` listed lines, never past the first line nor past the start of the last full page. */
export function scrollByLines(
  document: ReviewDocument,
  cursor: ReviewCursor,
  delta: number,
  view: ScrollView,
): ReviewCursor {
  // The last page matters only to a move DOWN; every other move would pay for it for nothing.
  const limit = delta > 0 ? lastPageStart(document, view) : REVIEW_START;
  let line = cursor.line;
  let steps = delta;
  // A cursor inside a long line is not at a line start: the first step up returns to it rather than leaving the line.
  if (steps < 0 && cursor.offset > (document.lines[line]?.start ?? 0)) steps++;
  for (; steps > 0; steps--) {
    const next = nextListed(document, line);
    if (next === undefined) break;
    line = next;
  }
  for (; steps < 0; steps++) {
    const previous = previousListed(document, line);
    if (previous === undefined) break;
    line = previous;
  }
  // Nothing below to step onto (the cursor is inside the last line): stay, rather than fall back to the line's start.
  if (delta > 0 && line === cursor.line) return cursor;
  const moved: ReviewCursor = { line, offset: 0 };
  // Scrolling DOWN stops at the last full page; scrolling up from past it (a cursor a search put there) is never held back.
  if (delta > 0 && compareCursors(moved, limit) > 0)
    return compareCursors(cursor, limit) >= 0 ? cursor : limit;
  return moved;
}

/**
 * The cursor of the next page: the page's own cut, but never past the last full page. A cut that falls INSIDE the last full
 * page's first line — a last line longer than a page — is the way to read that line's tail and is always taken: clamping it to
 * the line's start would leave the end of the document unreachable. `undefined` when the page already reaches the end.
 */
export function pageDown(
  document: ReviewDocument,
  cursor: ReviewCursor,
  next: ReviewCursor | undefined,
  view: ScrollView,
): ReviewCursor | undefined {
  if (next === undefined) return undefined;
  const limit = lastPageStart(document, view);
  if (next.line <= limit.line) return next;
  return cursor.line >= limit.line ? undefined : limit;
}

/**
 * The cursor of the page before: as many lines up as fill a page, always at least one, and the start of the current line
 * first when the cursor is inside a long one. `undefined` at the top.
 */
export function pageUp(
  document: ReviewDocument,
  cursor: ReviewCursor,
  view: ScrollView,
): ReviewCursor | undefined {
  const top = topCursor(document);
  if (compareCursors(cursor, top) <= 0) return undefined;
  if (cursor.offset > (document.lines[cursor.line]?.start ?? 0))
    return { line: cursor.line, offset: 0 };
  let line = cursor.line;
  let used = 0;
  for (
    let previous = previousListed(document, line);
    previous !== undefined;
    previous = previousListed(document, line)
  ) {
    const rows = lineRows(document, previous, view);
    if (used > 0 && used + rows > view.rowLimit) break;
    used += rows;
    line = previous;
    if (used >= view.rowLimit) break;
  }
  return line === cursor.line ? undefined : { line, offset: 0 };
}

/**
 * Where a page opens so a change has a little unchanged context above it: up to {@link CARD_CONTEXT_LINES} listed context
 * lines, stopping at anything else (a changed line, or the target and field rows that come before a diff). With a `view`
 * the context is also counted in ROWS: lines that wrap (prose, Markdown) can take a whole screen, so the context may use at
 * most a third of the page (and never less than {@link CARD_CONTEXT_LINES} rows) — the change must be on the page it opens.
 */
export function contextStartLine(
  document: ReviewDocument,
  changeIndex: number,
  view?: ScrollView,
): number {
  const budget =
    view === undefined ? undefined : Math.max(CARD_CONTEXT_LINES, Math.floor(view.rowLimit / 3));
  let start = changeIndex;
  let context = 0;
  let rows = 0;
  while (start > 0 && context < CARD_CONTEXT_LINES) {
    const line = document.lines[start - 1];
    if (line === undefined) break;
    if (line.fullSkip !== true) {
      if (line.kind !== 'context') break;
      if (view !== undefined && budget !== undefined) {
        // A line is measured only up to the rows the budget still has left (plus one, to tell it does not fit): a call never
        // projects a whole page for one context line.
        const own = lineRows(document, start - 1, { ...view, rowLimit: budget - rows + 1 });
        if (rows + own > budget) break;
        rows += own;
      }
      context++;
    }
    start--;
  }
  // The walk can stop on a copy the full view does not list (a change within the first lines): a cursor never rests on one.
  while (start < changeIndex && document.lines[start]?.fullSkip === true) start++;
  return start;
}

/**
 * Where the full view opens when it is entered from the card: on the first change with context above it, as the card does —
 * unless something else is what the person has to read first: a target the card had to shorten, or the field rows that come
 * before a diff (they are the call's identity, as on the card), which keep the top.
 */
export function fullOpeningCursor(
  document: ReviewDocument,
  options: { readonly targetShortened: boolean; readonly view?: ScrollView },
): ReviewCursor {
  const first = document.firstChangedLine;
  if (first === undefined || options.targetShortened) return topCursor(document);
  const base = document.preview.target === undefined ? 0 : 1;
  if (document.lines[base]?.kind === undefined) return topCursor(document);
  return { line: contextStartLine(document, first, options.view), offset: 0 };
}

/**
 * The cursor of the next (or previous) change: the nearest block of changed lines whose opening — the block with its context —
 * starts after (or before) the cursor's line. `undefined` when there is none, or when the only one left is already on the
 * last full page.
 */
export function changeJump(
  document: ReviewDocument,
  cursor: ReviewCursor,
  direction: 1 | -1,
  view: ScrollView,
): ReviewCursor | undefined {
  const starts = document.changeStarts;
  // The landing line (the change's opening) strictly increases with the change's index — the context walk stops at a changed
  // line, so the opening of start n lies after start n-1 — so the first or last qualifying change is found by halving, not by
  // projecting the context of every change in the document.
  const landing = (index: number): number => contextStartLine(document, starts[index] ?? 0, view);
  if (direction === 1) {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (landing(middle) > cursor.line) high = middle;
      else low = middle + 1;
    }
    if (low >= starts.length) return undefined;
    const target = landing(low);
    const limit = lastPageStart(document, view);
    const reached: ReviewCursor =
      compareCursors({ line: target, offset: 0 }, limit) > 0 ? limit : { line: target, offset: 0 };
    return reached.line > cursor.line ? reached : undefined;
  }
  let low = -1;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (landing(middle) < cursor.line) low = middle;
    else high = middle - 1;
  }
  return low < 0 ? undefined : { line: landing(low), offset: 0 };
}

/** The first changed line at or after `from`, or `undefined`: the suffix counts stay equal until that line, so halving finds it. */
function changedAtOrAfter(document: ReviewDocument, from: number): number | undefined {
  const suffix = document.changedRemainingLines;
  if (from >= document.lines.length) return undefined;
  const count = suffix[from] ?? 0;
  if (count === 0) return undefined;
  let low = from;
  let high = document.lines.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((suffix[middle] ?? 0) === count) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The last changed line before `before`, or `undefined`. */
function changedBefore(document: ReviewDocument, before: number): number | undefined {
  const suffix = document.changedRemainingLines;
  const after = suffix[Math.min(before, document.lines.length)] ?? 0;
  if (document.changedLines - after <= 0) return undefined;
  let low = 0;
  let high = Math.min(before, document.lines.length) - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((suffix[middle] ?? 0) > after) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Where a Tab lands to show the NEAREST changed line the current page does not draw — inside a change longer than a page, or
 * one the wrapped lines above it push down — or `undefined` when none is off the page in that direction. `cut` is the page's
 * own cut (`ReviewPage.next`). Going forward it lands on that line's opening, or on the page's cut when the opening is already
 * behind it (the line then starts the next page); never past the last full page. Going back it lands a page up from just below
 * the nearest changed line above the cursor's line, so that line ends the page.
 */
export function offPageChangeLanding(
  document: ReviewDocument,
  cursor: ReviewCursor,
  direction: 1 | -1,
  view: ScrollView,
  cut: ReviewCursor | undefined,
): ReviewCursor | undefined {
  if (direction === 1) {
    if (cut === undefined) return undefined;
    const undrawn = changedAtOrAfter(document, cut.line);
    if (undrawn === undefined) return undefined;
    const opening = contextStartLine(document, undrawn, view);
    const landing: ReviewCursor = opening > cursor.line ? { line: opening, offset: 0 } : cut;
    const limit = lastPageStart(document, view);
    const reached = compareCursors(landing, limit) > 0 ? limit : landing;
    return compareCursors(reached, cursor) > 0 ? reached : undefined;
  }
  const above = changedBefore(document, cursor.line);
  if (above === undefined) return undefined;
  // Mirror of going forward, which lands the next undrawn line at the TOP of the page: going back lands that line at the BOTTOM —
  // a page up from just below it — so a run of consecutive changed lines (a new file) is paged through, not crawled a line a press.
  const earlier = pageUp(document, { line: above + 1, offset: 0 }, view);
  return earlier !== undefined && earlier.line < cursor.line ? earlier : undefined;
}
