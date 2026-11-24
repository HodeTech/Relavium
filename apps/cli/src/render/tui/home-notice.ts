import type { EditorState } from './chat-input.js';
import { shouldShowBanner } from './banner.js';
import { sanitizeInline } from './chat-projection.js';
import { displayWidth, wrapWords } from './viewport.js';

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
  readonly isEmpty: boolean;
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
  /** Rows the Home spends above the notice that this layout does not know about (the `▶` run row, ADR-0139 §3). Default 0. */
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
 * The rows Home's Continue section takes. One Continue row needs body margin + two headings + its title/directory lines; a recent run alone
 * needs the margin, the headings and its row.
 */
function continueSectionRows(
  options: Pick<HomeNoticeOptions, 'hasSessions' | 'hasRecentRuns' | 'isEmpty'>,
): number {
  if (options.hasSessions) return 5;
  if (options.hasRecentRuns === true) return 4;
  return options.isEmpty ? 0 : 1;
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

/** Keep the source (to {@link MAX_HOME_NOTICE_CHARS}); page only its wrapped presentation after reserving Home's actionable chrome. */
export function layoutHomeNotice(options: HomeNoticeOptions): HomeNoticeLayout | undefined {
  if (options.notice === undefined) return undefined;
  const heading = shouldShowBanner({
    configShowBanner: options.showBanner,
    isEmpty: options.isEmpty,
    rows: options.rows,
  })
    ? 4
    : 1;
  const continueRows = continueSectionRows(options);
  const management = continueRows + (options.hasAttentionRuns === true ? 3 : 0);
  const available = Math.max(
    2,
    options.rows -
      heading -
      homePromptRows(options.editor, options.cols) -
      3 -
      (options.keyless ? 1 : 0) -
      (options.reservedRows ?? 0) -
      management,
  );
  const all = boundedNotice(options.notice)
    .split('\n')
    .map(sanitizeInline)
    .flatMap((line) => wrapNoticeLine(line, options.cols));
  const overflow = all.length > available;
  const pageSize = overflow ? available - 1 : available;
  const maxPage = Math.max(0, Math.ceil(all.length / pageSize) - 1);
  const requested = options.page ?? 0;
  const page = Number.isSafeInteger(requested) ? Math.min(maxPage, Math.max(0, requested)) : 0;
  const start = page * pageSize;
  const lines = all.slice(start, start + pageSize);
  const footer = overflow
    ? `Notice ${start + 1}–${start + lines.length} of ${all.length} · PgUp/PgDn to read`
    : undefined;
  return { lines, footer, page, maxPage, rowCount: lines.length + (footer === undefined ? 0 : 1) };
}
