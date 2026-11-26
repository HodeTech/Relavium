import type { EditorState } from './chat-input.js';
import { sanitizeInline } from './chat-projection.js';
import { homeMargin, landingNoticeRoom, showsLandingBlock } from './home-layout.js';
import { DOCKED_CHROME_ROWS, workListRows } from './home-pages.js';
import { keyHint } from './legend.js';
import { displayWidth, wrapWords } from './viewport.js';

/**
 * The columns the Home's notice, its prompt and its hint are laid out in: the terminal less the left margin, on both pages (the landing and the
 * work page are left-hung, so a row wrapped at the full width would wrap again). Both the view and the paging key ask here, so the pages they
 * count are the pages that are drawn.
 */
export function homeContentColumns(cols: number): number {
  return Number.isFinite(cols) ? Math.max(1, Math.floor(cols) - homeMargin(cols)) : cols;
}

export function homePromptRows(editor: EditorState, columns: number): number {
  return editor.text
    .split('\n')
    .reduce(
      (sum, line) =>
        sum + Math.max(1, Math.ceil((displayWidth(sanitizeInline(line)) + 3) / columns)),
      0,
    );
}

export interface HomeNoticeOptions {
  readonly notice: string | undefined;
  readonly editor: EditorState;
  readonly cols: number;
  readonly rows: number;
  readonly keyless: boolean;
  readonly showBanner: boolean | undefined;
  /**
   * Which page the notice is drawn on: `true` the landing (page 1: the head, the notice, the prompt block), `false` the work page (page 2: its
   * list, the notice under it, the docked prompt block).
   */
  readonly onLanding: boolean;
  readonly hasSessions: boolean;
  /**
   * The strip lists an Attention row that `↓` can focus (a run parked in this directory, or a failed run): the Attention rows come first
   * and are what `↓` reaches first, so the notice leaves them the three rows they cost at the least (their heading, the gap under it and
   * one row). Without it a long notice could leave no row drawn while `↓` still focused one, and `Enter` would open a run the person had
   * not seen listed.
   */
  readonly hasAttentionRuns?: boolean;
  /**
   * The strip lists a recent run, which `↓` can focus too. With no session above it, its section costs the margin, the two headings and
   * its row (four rows); with sessions the room is the sessions' own, which give way to the focused run.
   */
  readonly hasRecentRuns?: boolean;
  readonly page?: number;
  /** Rows the Home spends above the notice that this layout does not know about (the run row, ADR-0139 §3). Default 0. */
  readonly reservedRows?: number;
}
export interface HomeNoticeLayout {
  readonly lines: readonly string[];
  readonly footer: string | undefined;
  readonly page: number;
  readonly maxPage: number;
  readonly rowCount: number;
}

/**
 * The most characters of one notice the Home sanitizes, wraps and pages, 32,768: far past any diagnostic (the doctor's whole report is a
 * few kilobytes, and a test of 200 full rows is 22 KB), and low enough that the layout, which is rebuilt on every frame, stays cheap.
 * A notice is whatever a caller was handed (a parse fault, a config detail, a hosted-run fault) and nothing bounded it: measured, 1 MiB
 * of wide characters took 2.3 s to lay out, once per frame. What is over the bound is cut BEFORE it is wrapped and the cut is shown by
 * `…` at the end of the last page, so a longer notice reads as longer, not as complete. The cut is by code unit, not by
 * {@link clipLine}'s display columns: that helper measures the whole text first, which is the cost this bound avoids.
 */
export const MAX_HOME_NOTICE_CHARS = 32_768;

/**
 * `notice`, or its first {@link MAX_HOME_NOTICE_CHARS} characters and a `…` when it is longer; a surrogate pair is never cut in two.
 * Exported for the run view's notice rows, which sanitize and clip an unbounded line by the same cost class (PR #102 review).
 */
export function boundedNotice(notice: string): string {
  if (notice.length <= MAX_HOME_NOTICE_CHARS) return notice;
  const last = notice.charCodeAt(MAX_HOME_NOTICE_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_HOME_NOTICE_CHARS - 1 : MAX_HOME_NOTICE_CHARS;
  return `${notice.slice(0, end)}…`;
}

/**
 * The rows the work page's Continue section takes at the least: one session needs the two headings and its title and directory lines; a recent
 * run alone needs the headings and its row. (Agents are listed only beside sessions.)
 */
function continueSectionRows(
  options: Pick<HomeNoticeOptions, 'hasSessions' | 'hasRecentRuns'>,
): number {
  if (options.hasSessions) return 4;
  return options.hasRecentRuns === true ? 3 : 0;
}

/**
 * One logical line of a notice as rows. `wrapWords` keeps every character of the source (it serves the transcript, whose rows must join back
 * to the text for a selection), so a word that ends exactly at the last column leaves the space after it at the START of the next row:
 * ` opened; it is stored…`. A notice is read, not selected, so the space the wrap breaks on is dropped and the rest is wrapped again from
 * the next word (dropping it after the fact would leave a short row); the first row of a line keeps its indent. Each row is taken from a
 * window of the rest of the line, not from all of it, so the cost is the rows times a window and a long notice stays cheap per frame.
 */
function wrapNoticeLine(line: string, cols: number): string[] {
  if (line === '') return [''];
  const window = Math.trunc(cols) * 4 + 8;
  const rows: string[] = [];
  let rest = line;
  while (rest !== '') {
    const first = wrapWords(rest.slice(0, window), cols)[0];
    if (first === undefined) break; // a width nothing can be drawn at
    if (!rest.startsWith(first)) {
      // A glyph wider than the row was shown as `?`: the row is not a piece of the text, so the rest is wrapped as it is.
      rows.push(...wrapWords(rest, cols));
      break;
    }
    rows.push(first);
    rest = rest.slice(first.length).trimStart();
  }
  return rows;
}

/** The last notice wrapped, by the text it was bounded to and the columns it was wrapped at: a one-entry cache (see {@link wrappedNotice}). */
let lastWrapped:
  | { readonly text: string; readonly cols: number; readonly rows: readonly string[] }
  | undefined;

/**
 * Every row of a notice at `cols` columns. The layout is rebuilt on EVERY frame (the spinner, the clock and a blinking cursor each draw one),
 * and the wrapped rows depend on the text and the width alone, so the last result is kept and a frame that asks for the same text at the same
 * width gets it back untouched (round 2, U4): wrapping a notice at the cap by display width took about 400 ms on wide characters, once per frame.
 * One entry, not a table: a notice is on screen alone, and the entry holds at most {@link MAX_HOME_NOTICE_CHARS} characters of text and the rows
 * made of them. The key is the BOUNDED text, so a longer notice cannot make the cache hold more than the bound.
 */
function wrappedNotice(notice: string, cols: number): readonly string[] {
  const text = boundedNotice(notice);
  if (lastWrapped !== undefined && lastWrapped.cols === cols && lastWrapped.text === text)
    return lastWrapped.rows;
  const rows = text
    .split('\n')
    .map(sanitizeInline)
    .flatMap((line) => wrapNoticeLine(line, cols));
  lastWrapped = { text, cols, rows };
  return rows;
}

/**
 * Keep the source (to {@link MAX_HOME_NOTICE_CHARS}); page only its wrapped presentation after reserving Home's actionable chrome. On the landing
 * (page 1) the room is what `rows − 1` leaves after the head, the notice's two blank rows, the prompt and its four rows ({@link landingNoticeRoom});
 * on the work page (page 2) it is what the list leaves under the way back once the docked prompt block, the notice's blank row and the rows the
 * focus can reach are counted ({@link workListRows}).
 */
export function layoutHomeNotice(options: HomeNoticeOptions): HomeNoticeLayout | undefined {
  if (options.notice === undefined) return undefined;
  const width = homeContentColumns(options.cols);
  const promptRows = homePromptRows(options.editor, width);
  const reserved = options.reservedRows ?? 0;
  let available: number;
  if (options.onLanding) {
    const showBlock = showsLandingBlock(options.showBanner, true);
    available = Math.max(2, landingNoticeRoom(options.rows, showBlock, { promptRows }) - reserved);
  } else {
    const management = continueSectionRows(options) + (options.hasAttentionRuns === true ? 3 : 0);
    // the list's rows under the docked prompt block, less the notice's own blank row, less what the list must keep and what the caller holds
    const list = workListRows(options.rows, DOCKED_CHROME_ROWS + promptRows);
    available = Math.max(2, list - 1 - reserved - management);
  }
  const all = wrappedNotice(options.notice, width);
  const overflow = all.length > available;
  const pageSize = overflow ? available - 1 : available;
  const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const requested = options.page ?? 0;
  const page = Number.isSafeInteger(requested) ? Math.min(maxPage, Math.max(0, requested)) : 0;
  const start = page * pageSize;
  const lines = all.slice(start, start + pageSize);
  const footer = overflow
    ? keyHint([
        { text: `Notice ${start + 1}–${start + lines.length} of ${all.length}` },
        { keys: 'PgUp/PgDn', verb: 'read' },
      ])
    : undefined;
  return { lines, footer, page, maxPage, rowCount: lines.length + (footer === undefined ? 0 : 1) };
}
