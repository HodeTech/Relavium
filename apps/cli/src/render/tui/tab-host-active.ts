import { STALLED_REASON, type ActiveRow } from '../../history/active-model.js';
import type { ActiveRead } from '../../history/active-source.js';
import { RUN_STATUS_ROLE } from '../../history/history-model.js';
import type { ChatKey } from './chat-input.js';
import { glyph, statusCell } from './glyphs.js';
import { keyToken, type LegendItem, type LegendKey } from './legend.js';
import {
  clampSpans,
  clipLine,
  flushRow,
  windowBody,
  type SheetLine,
  type SheetSpan,
  moreAboveText,
  moreBelowText,
} from './sheet-frame.js';

/**
 * The Active tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the runs that are not finished, grouped by what they are doing. PURE, like `tab-host.ts` it is drawn into: it holds no
 * read, no timer and no React. The Home's poll (`history/active-poll.ts`) reads the runs and hands each result in ({@link applyActiveRead});
 * this module says what a key does and which lines to draw.
 *
 * - **Four groups, in this order: running, paused, stalled, held.** A group is a word on every row as well as an order, so the list reads
 *   without colour: `◐ running`, `○ pending`, `‖ paused`, `⚠ stalled`, `◇ held`. The leg this Home runs is in `running` and says so; a
 *   paused run says what it waits for (a gate here, a media job, another project, or `gate state not read`, which a damaged log gets and
 *   never "media job").
 * - **Three kinds of row act.** `Enter` on the leg this Home hosts asks the host to reopen its view; `Enter` on a run paused at a gate in THIS
 *   project asks it to open the gate card; `Enter` on a run paused only on media jobs in THIS project asks it to ask whether to continue
 *   the run here. Every other row is read-only: `Enter` says why, and nothing here cancels, retries or edits a run.
 *   A step carries the run id of the row the model classified; the host re-reads the run before it opens anything, so a stale or crafted id
 *   opens no card.
 * - **The cursor follows the run, not the row number.** The list is read again while the tab is in front, so the focused run is kept by
 *   its id: a run that moves up or down the list keeps the cursor. A run that LEFT the list does not hand the cursor to whichever row now
 *   stands at its number: the focus is cleared and the tab says so ({@link ACTIVE_FOCUS_LEFT}), no row is marked, and `Enter` does nothing
 *   until `↑` or `↓` picks a row, because an `Enter` aimed at a run that is gone must never open the card of its neighbour.
 * - **Bounded.** At most 200 rows a status (the source's limit) and a marker line for what lies past them: `… N more running not listed`.
 * - **The freshness is stated.** The list is as of each node boundary: streamed output is never stored, and the last row says so until a
 *   message or a warning takes its place.
 */

/** The groups, in the order they are listed. */
export type ActiveGroup = 'running' | 'paused' | 'stalled' | 'held';

const GROUP_ORDER: Readonly<Record<ActiveGroup, number>> = {
  running: 0,
  paused: 1,
  stalled: 2,
  held: 3,
};

/** The group a row is listed under. A held terminal outranks the rest; the hosted leg is always `running`. */
export function activeGroupOf(row: ActiveRow): ActiveGroup {
  if (row.class === 'held') return 'held';
  if (row.class === 'hosted') return 'running';
  if (row.stalled) return 'stalled';
  switch (row.class) {
    case 'other-paused-here':
    case 'other-paused-media':
    case 'paused-gate-unknown':
    case 'other-paused-elsewhere':
      return 'paused';
    default:
      return 'running';
  }
}

/** The rows in display order: by group, and within a group as the model ordered them (newest first). */
export function activeDisplayOrder(rows: readonly ActiveRow[]): readonly ActiveRow[] {
  return [...rows].sort((a, b) => GROUP_ORDER[activeGroupOf(a)] - GROUP_ORDER[activeGroupOf(b)]);
}

/** The Active tab as it stands. */
export interface ActiveTabState {
  /** `loading`: nothing was read yet. `ready`: `rows` is a read. `unreadable`: the first read failed, or nothing feeds the tab. */
  readonly phase: 'loading' | 'ready' | 'unreadable';
  /** The newest read, for what lies beyond the rows and for the outbox warning. */
  readonly read: ActiveRead | undefined;
  /** The rows in display order. */
  readonly rows: readonly ActiveRow[];
  /** The selected row, as an index into {@link rows}; `0` when the list is empty. */
  readonly cursor: number;
  /**
   * The run the cursor is on: it survives a re-read that moves the run. `undefined` with rows listed means the run it was on left the list
   * and nothing is selected yet; with no rows it means there is nothing to select.
   */
  readonly focus: string | undefined;
  /** One sentence the last key (or a refused open) left; the next key drops it. */
  readonly message?: string | undefined;
}

/** What a key does on the tab: become another state, or ask the host to reopen a hosted run's view, or to open a paused run's gate card. */
export type ActiveStep =
  | { readonly kind: 'state'; readonly state: ActiveTabState }
  | { readonly kind: 'open-view'; readonly runId: string; readonly state: ActiveTabState }
  | { readonly kind: 'open-gate'; readonly runId: string; readonly state: ActiveTabState };

/** The keys the Active tab's legend names that are its own. The test presses every one of them. */
export const ACTIVE_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  open: { keys: 'Enter', verb: 'open' },
} as const satisfies Readonly<Record<string, LegendKey>>;

export const ACTIVE_LOADING = 'Reading the active runs…';
export const ACTIVE_UNREADABLE = 'The active runs could not be read.';
export const ACTIVE_EMPTY = `No run is active. Start one from the Defined tab with ${keyToken('r')}.`;
export const ACTIVE_FRESHNESS = 'Shown as of each node boundary: streamed output is not stored.';
export const ACTIVE_HELD_UNREAD = 'Outbox unreadable: a run whose end is held may show as running.';
export const ACTIVE_STALE_READ = 'The runs could not be read again: this is the last list read.';
export const ACTIVE_FOCUS_LEFT = `The run you had selected left the list. ${keyToken('↑/↓')} select another.`;
export const ACTIVE_SELECT_FIRST = `No run is selected. ${keyToken('↑/↓')} select one.`;

const clamp = (value: number, last: number): number => Math.max(0, Math.min(value, last));

function withCursor(state: ActiveTabState, cursor: number): ActiveTabState {
  const at = clamp(cursor, state.rows.length - 1);
  return { ...state, cursor: at, focus: state.rows[at]?.runId };
}

/**
 * The tab entered, from the last read this screen made (shown at once, replaced by the next read) or from none (it says it is reading).
 * `cursor` and `focus` are where the tab was left; the focus wins when the run is still listed.
 */
export function openActiveTab(
  last: ActiveRead | undefined,
  cursor: number,
  focus?: string,
): ActiveTabState {
  const empty: ActiveTabState = {
    phase: 'loading',
    read: undefined,
    rows: [],
    cursor: Math.max(0, cursor),
    focus,
  };
  return last === undefined ? empty : applyActiveRead(empty, last);
}

/** The tab for a Home that has nothing to read it from. */
export function unreadableActiveTab(): ActiveTabState {
  return { phase: 'unreadable', read: undefined, rows: [], cursor: 0, focus: undefined };
}

/**
 * `state` with a newer read: the rows in display order and the cursor on the run it was on. A run that left the list is NOT replaced by
 * the row that now stands at its number: the cursor stays inside the rows, the focus is cleared and a sentence says so, so a following
 * `Enter` cannot open the card of a run the person never selected. A cleared focus stays cleared across reads until a key selects a row;
 * the first read of a tab, and a list that was empty, focus the row under the cursor as before. A message the person has not dismissed
 * stays.
 */
export function applyActiveRead(state: ActiveTabState, read: ActiveRead): ActiveTabState {
  const rows = activeDisplayOrder(read.rows);
  const found = state.focus === undefined ? -1 : rows.findIndex((row) => row.runId === state.focus);
  const unlisted = rows.length > 0 && found < 0;
  // The focus was set and its run is gone now, or an earlier read already cleared it and nothing was selected since.
  const newlyLeft = unlisted && state.focus !== undefined;
  const stillLeft =
    unlisted && state.focus === undefined && state.phase === 'ready' && state.rows.length > 0;
  const left = newlyLeft || stillLeft;
  const cursor = found >= 0 ? found : clamp(state.cursor, rows.length - 1);
  // A read that worked ends "this is the last list read"; a sentence a key left stays until the next key. What just happened to the
  // selection is newer than any of them.
  const kept = state.message === ACTIVE_STALE_READ ? undefined : state.message;
  const message = newlyLeft ? ACTIVE_FOCUS_LEFT : kept;
  return {
    phase: 'ready',
    read,
    rows,
    cursor,
    focus: left ? undefined : rows[cursor]?.runId,
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * `state` after a read failed: with no list yet the tab is unreadable; with one, the list stays and says it is the last one read. The same
 * object when it already says so, so a failing poll does not repaint on every tick.
 */
export function failActiveRead(state: ActiveTabState): ActiveTabState {
  if (state.read === undefined) return state.phase === 'unreadable' ? state : unreadableActiveTab();
  return state.message === ACTIVE_STALE_READ ? state : { ...state, message: ACTIVE_STALE_READ };
}

/** `state` with a sentence the next key drops. */
export function withActiveMessage(state: ActiveTabState, message: string): ActiveTabState {
  return { ...state, message };
}

/** What a row is, and what `Enter` does on it (or why it does nothing), in one sentence that fits a line. */
function explain(row: ActiveRow): string {
  switch (row.class) {
    case 'hosted':
      return `This Home runs it. ${keyToken('Enter')} reopens its view.`;
    case 'other-paused-here':
      return `Waiting at a gate in this project. ${keyToken('Enter')} opens the gate card.`;
    case 'other-running':
      return row.stalled
        ? `No live owner: ${STALLED_REASON}. Read-only.`
        : 'Running in another process: read-only. There is no cross-process cancel.';
    case 'other-paused-media':
      return row.actionable
        ? `Waiting for a media job. ${keyToken('Enter')} asks whether to continue it here.`
        : 'Waiting for a media job: there is nothing to decide here.';
    case 'paused-gate-unknown':
      return 'Its gate state could not be read. relavium status shows what it waits for.';
    case 'other-paused-elsewhere':
      return row.projectRoot === undefined
        ? 'Paused, and its project was not recorded: it cannot be answered here.'
        : // What to do comes first and the root last, so a long project path is the part a narrow terminal cuts.
          `Paused in another project: answer it from there (${row.projectRoot}).`;
    case 'held':
      return 'Its end is held in the outbox. relavium status shows what to do.';
  }
}

/** What `Enter` says on a row it cannot act on: the model's own reason, short, so the sentence under the list is not repeated. */
function readOnlyMessage(row: ActiveRow): string {
  if (row.stalled) return `Read-only: no live owner (${STALLED_REASON}).`;
  return `Read-only: ${row.reason ?? 'this run cannot be answered here'}.`;
}

/** `↑`/`↓`: the cursor one row, or (with nothing selected) a selection even at an end where the cursor cannot move. */
function moveCursor(state: ActiveTabState, cleared: ActiveTabState, key: ChatKey): ActiveStep {
  const to = clamp(state.cursor + (key.upArrow === true ? -1 : 1), state.rows.length - 1);
  const nothingSelected = state.focus === undefined && state.rows.length > 0;
  if (to === state.cursor && !nothingSelected) return { kind: 'state', state: cleared };
  return { kind: 'state', state: withCursor(cleared, to) };
}

/** `Enter` on a row: ask the host to reopen the hosted view or open the gate card, or say why the row is read-only. */
function enterRow(cleared: ActiveTabState, row: ActiveRow): ActiveStep {
  if (row.enter === 'reopen-view') return { kind: 'open-view', runId: row.runId, state: cleared };
  // A media park that can be continued is opened by the same request as a gate park: the host re-reads the run when it opens, and it
  // is the host that tells a gate card from the question a media park gets (it asks, and nothing is continued without a Yes).
  if (row.enter === 'open-gate-card' || row.enter === 'continue-media')
    return { kind: 'open-gate', runId: row.runId, state: cleared };
  return { kind: 'state', state: { ...cleared, message: readOnlyMessage(row) } };
}

/** Fold one key (already past the tab host's own tab keys and `Esc`) into the tab. */
export function foldActiveKey(state: ActiveTabState, key: ChatKey): ActiveStep {
  const cleared: ActiveTabState =
    state.message === undefined ? state : { ...state, message: undefined };
  const stay: ActiveStep = { kind: 'state', state: cleared };
  // A chord (`Ctrl+X`, a meta key) is never one of these keys.
  if (key.ctrl === true || key.meta === true) return stay;
  if (key.upArrow === true || key.downArrow === true) return moveCursor(state, cleared, key);
  if (key.return !== true) return stay;
  if (state.focus === undefined && state.rows.length > 0)
    return { kind: 'state', state: { ...cleared, message: ACTIVE_SELECT_FIRST } };
  const row = state.rows[state.cursor];
  return row === undefined ? stay : enterRow(cleared, row);
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The selection marker and its space, in the form in force ({@link glyph}); an unselected row keeps the same two columns. */
const pointer = (): string => `${glyph('selection')} `;
const INDENT = '  ';
const WORD_WIDTH = 9;

/** The glyph of a row, in the column the list gives a status: a stalled run is a warning and a held terminal is the held diamond. */
function rowGlyph(row: ActiveRow, group: ActiveGroup): string {
  if (group === 'stalled') return statusCell('warning');
  if (group === 'held') return statusCell('held');
  return statusCell(RUN_STATUS_ROLE[row.status]);
}

/** The word of a row: the status for a run that is running or pending, else its group. A glyph never stands alone. */
function wordOf(row: ActiveRow, group: ActiveGroup): string {
  return group === 'running' ? row.status : group;
}

/** What the row says at its right edge: who has it, or what it waits for. */
function qualifierOf(row: ActiveRow): string {
  if (row.stalled) return STALLED_REASON;
  return row.reason ?? (row.class === 'hosted' ? 'this Home' : 'gate waiting here');
}

function rowLine(row: ActiveRow, selected: boolean, width: number): SheetLine {
  const group = activeGroupOf(row);
  const word = wordOf(row, group).padEnd(WORD_WIDTH);
  const lead = `${selected ? pointer() : INDENT}${rowGlyph(row, group)} `;
  const left = `${lead}${word}${row.shortId}  ${row.label}`;
  const tail = qualifierOf(row);
  const text = flushRow(left, tail, width);
  const spans: SheetSpan[] = [];
  if (!selected) {
    if (group === 'stalled' || group === 'held')
      spans.push({ from: lead.length, to: lead.length + word.trimEnd().length, role: 'warn' });
    if (text.endsWith(tail))
      spans.push({ from: text.length - tail.length, to: text.length, role: 'dim' });
  }
  return { kind: selected ? 'selected' : 'row', text, spans: clampSpans(spans, text.length) };
}

/** `… 37 more running not listed`, or `… 200+ more paused not listed`: the runs past the rows the tab keeps. */
function moreLines(read: ActiveRead | undefined, width: number): readonly SheetLine[] {
  return (read?.more ?? []).map(
    (more): SheetLine => ({
      kind: 'marker',
      text: clipLine(
        `… ${String(more.count)}${more.atLeast ? '+' : ''} more ${more.status} not listed`,
        width,
      ),
    }),
  );
}

/** The row under the list: a sentence a key left, else the warning that the outbox could not be read, else what the list is as of. */
function footerLine(state: ActiveTabState, width: number): SheetLine {
  if (state.message !== undefined) return { kind: 'notice', text: clipLine(state.message, width) };
  if (state.read?.heldUnread === true)
    return { kind: 'notice', text: clipLine(ACTIVE_HELD_UNREAD, width) };
  return { kind: 'hint', text: clipLine(ACTIVE_FRESHNESS, width) };
}

/**
 * The tab's lines between the strip and the legend, at most `room` of them: the list windowed around the cursor (a `▲`/`▼` marker standing
 * for the rows it hides), a marker per status that has runs past the limit, the selected row's sentence, and the message row. The sentence
 * and the message row keep their lines whether or not they have anything to say, so the list does not move as a message comes and goes.
 */
export function activeBody(
  state: ActiveTabState,
  width: number,
  room: number,
): readonly SheetLine[] {
  if (state.phase === 'loading') return [{ kind: 'text', text: ACTIVE_LOADING }];
  if (state.phase === 'unreadable') return [{ kind: 'failed', text: ACTIVE_UNREADABLE }];
  const footer = footerLine(state, width);
  const beyond = moreLines(state.read, width);
  if (state.rows.length === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(ACTIVE_EMPTY, width) };
    return [empty, ...beyond, footer].slice(0, room);
  }
  const height = Math.max(3, room - 2 - beyond.length);
  const { start, end } = windowBody(state.rows.length, state.cursor, height);
  const list: SheetLine[] = state.rows
    .slice(start, end)
    .map((row, at) =>
      rowLine(row, start + at === state.cursor && state.focus !== undefined, width),
    );
  if (start > 0 && list.length > 0) list[0] = { kind: 'marker', text: moreAboveText(start + 1) };
  if (end < state.rows.length && list.length > 0)
    list[list.length - 1] = {
      kind: 'marker',
      text: moreBelowText(state.rows.length - end + 1),
    };
  const selected = state.focus === undefined ? undefined : state.rows[state.cursor];
  const detail: SheetLine =
    selected === undefined
      ? { kind: 'text', text: '' }
      : { kind: 'text', text: clipLine(explain(selected), width) };
  return [...list, ...beyond, detail, footer];
}

/** The legend's items for the tab: the tab host's own, then the keys that act on a row (only when there is a row to act on). The key that leaves is the host's. */
export function activeLegendItems(
  state: ActiveTabState,
  tabItems: readonly LegendItem[],
): readonly LegendItem[] {
  if (state.phase !== 'ready' || state.rows.length === 0) return tabItems;
  return [...tabItems, ACTIVE_KEYS.select, ACTIVE_KEYS.open];
}
