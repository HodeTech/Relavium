import type { ChatKey } from './chat-input.js';
import type { LegendItem } from './legend.js';
import {
  clampSpans,
  clipLine,
  flushRow,
  windowBody,
  type SheetLine,
  type SheetSpan,
} from './sheet-frame.js';

/**
 * The Sessions tab of the `/agents` strip of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §3 and its 2026-11-23 note, MVP-8 step 5): this project's saved conversations, newest first, the very list the `/resume` picker offers.
 * PURE, like `tab-host.ts` it is drawn into: it holds no port call, no clock and no React. The host reads the sessions (a {@link SessionsRead},
 * through `home/sessions-port.ts`) when the tab is entered; this module says what a key does and which lines to draw.
 *
 * - **Keys.** `↑`/`↓` move and stop at the ends. `Enter` ASKS the host to resume the selected session in place: it is a step the host carries
 *   out with its own flow (the screen closes and the chat opens where the Home was), so nothing here resumes anything. `Esc` closes the
 *   screen (the tab host's own rule). Every other key is nothing.
 * - **A row carries the session's id, and never draws it.** The id a request names is the store's own ({@link SessionRow.id}); the title and the
 *   agent are sanitized labels that the port bounded, so a title that looks like a command or a path is a line of text and nothing else.
 * - **One page.** The tab lists the newest {@link SessionsRead.rows} the port read and says when older ones exist; `/resume` searches them.
 */

/** One saved conversation as the tab lists it. */
export interface SessionRow {
  /** The session's id, as the store holds it. It is what a resume is asked for by, and it is never drawn. */
  readonly id: string;
  /** The session's title (or `Untitled`), sanitized and bounded. */
  readonly title: string;
  /** The agent the session ran, sanitized and bounded. */
  readonly agent: string;
  /** How long ago it was last used, as the Home's strip says it (`5m ago`); empty when the time could not be read. */
  readonly age: string;
}

/** The sessions as read: the newest page, and whether older ones exist. */
export interface SessionsRead {
  readonly rows: readonly SessionRow[];
  readonly more: boolean;
}

/** The Sessions tab's read, behind a port so the tab is testable without a database. May throw: the tab then says it cannot list. */
export interface SessionsPort {
  readonly read: () => SessionsRead;
}

/** The Sessions tab as it stands: what was read, where the cursor is, and what the last key had to say. */
export interface SessionsTabState {
  readonly read: SessionsRead;
  /** The selected row; `0` when the list is empty. */
  readonly cursor: number;
  /** One sentence the last key left; the next key drops it. */
  readonly message?: string | undefined;
}

/** What a key does on the tab: become another state, or ask the host to resume one session in place. */
export type SessionsStep =
  | { readonly kind: 'state'; readonly state: SessionsTabState }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly state: SessionsTabState };

/** The keys the tab's legend names that are its own. The test presses every one of them. */
export const SESSIONS_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  resume: { keys: 'Enter', verb: 'resume' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** What the tab says when the project has no saved conversation to list. */
export const SESSIONS_EMPTY =
  'No saved conversations in this project yet. Type a message to start one.';
/** What the tab says when its port cannot be read, or the Home has none. */
export const SESSIONS_UNREADABLE = 'The conversations of this project could not be listed.';
/** What the tab says under the list when older conversations exist than it lists. */
export const SESSIONS_MORE = '… older conversations are not listed; /resume searches them';
/** What `Enter` says when the Home cannot resume a conversation: nothing was opened. */
export const SESSIONS_RESUME_UNAVAILABLE =
  'Session resume is unavailable here. Use relavium chat resume.';

const POINTER = '› ';
const INDENT = '  ';

/** The tab opened on `read`, the cursor where it was (kept inside the rows there are now). */
export function openSessionsTab(read: SessionsRead, cursor: number): SessionsTabState {
  const last = read.rows.length - 1;
  return { read, cursor: Math.max(0, Math.min(cursor, last)) };
}

/** `state` with a sentence the next key will drop. */
export function withSessionsMessage(state: SessionsTabState, message: string): SessionsTabState {
  return { ...state, message };
}

/** Fold one key (already past the tab host's own tab keys and `Esc`) into the tab. */
export function foldSessionsKey(state: SessionsTabState, key: ChatKey): SessionsStep {
  const cleared: SessionsTabState =
    state.message === undefined ? state : { ...state, message: undefined };
  const stay: SessionsStep = { kind: 'state', state: cleared };
  // A chord (`Ctrl+X`, a meta key) is never one of these keys.
  if (key.ctrl === true || key.meta === true) return stay;
  const rows = state.read.rows;
  if (key.upArrow === true || key.downArrow === true) {
    const to = Math.max(
      0,
      Math.min(state.cursor + (key.upArrow === true ? -1 : 1), rows.length - 1),
    );
    return to === state.cursor ? stay : { kind: 'state', state: { ...cleared, cursor: to } };
  }
  if (key.return !== true) return stay;
  const row = rows[state.cursor];
  if (row === undefined) return stay;
  return { kind: 'resume', sessionId: row.id, state: cleared };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

function rowLine(row: SessionRow, selected: boolean, width: number): SheetLine {
  const left = `${selected ? POINTER : INDENT}${row.title}  ${row.agent}`;
  const text = flushRow(left, row.age, width);
  const spans: SheetSpan[] = [];
  // The age is the quieter part of the row; the selected row keeps its one colour.
  if (!selected && row.age !== '' && text.endsWith(row.age))
    spans.push({ from: text.length - row.age.length, to: text.length, role: 'dim' });
  return { kind: selected ? 'selected' : 'row', text, spans: clampSpans(spans, text.length) };
}

/**
 * The tab's lines between the strip and the legend, at most `room` of them: the list (windowed around the cursor, a `▲`/`▼` marker standing
 * for the rows it hides), a line for the conversations past the page, the selected row's whole title, and the message row. The title and
 * the message keep their lines whether or not they have anything to say, so the list does not move as a message comes and goes.
 */
export function sessionsBody(
  state: SessionsTabState,
  width: number,
  room: number,
): readonly SheetLine[] {
  const rows = state.read.rows;
  const message: SheetLine =
    state.message === undefined
      ? { kind: 'text', text: '' }
      : { kind: 'notice', text: clipLine(state.message, width) };
  if (rows.length === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(SESSIONS_EMPTY, width) };
    return [empty, message].slice(0, room);
  }
  const beyond: readonly SheetLine[] = state.read.more
    ? [{ kind: 'marker', text: clipLine(SESSIONS_MORE, width) }]
    : [];
  const height = Math.max(3, room - 2 - beyond.length);
  const { start, end } = windowBody(rows.length, state.cursor, height);
  const list: SheetLine[] = rows
    .slice(start, end)
    .map((row, at) => rowLine(row, start + at === state.cursor, width));
  if (start > 0 && list.length > 0)
    list[0] = { kind: 'marker', text: `▲ ${String(start + 1)} more` };
  if (end < rows.length && list.length > 0)
    list[list.length - 1] = { kind: 'marker', text: `▼ ${String(rows.length - end + 1)} more` };
  const selected = rows[state.cursor];
  const title: SheetLine =
    selected === undefined
      ? { kind: 'text', text: '' }
      : { kind: 'text', text: clipLine(selected.title, width) };
  return [...list, ...beyond, title, message];
}

/** The legend's items for the tab: the tab host's own, then the keys that act on a row (only when there is a row to act on). */
export function sessionsLegendItems(
  state: SessionsTabState,
  tabItems: readonly LegendItem[],
  closeItem: LegendItem,
): readonly LegendItem[] {
  if (state.read.rows.length === 0) return [...tabItems, closeItem];
  return [...tabItems, SESSIONS_KEYS.select, SESSIONS_KEYS.resume, closeItem];
}
