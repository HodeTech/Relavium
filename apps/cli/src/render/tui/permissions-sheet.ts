import type { ChatMode } from '../../chat/chat-mode.js';
import type { PermissionEntry, PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { legend, type LegendItem } from './legend.js';
import {
  clipLine,
  flushRow,
  usableColumns,
  windowBody,
  type SheetGeometry,
  type SheetLine,
  type SheetLineKind,
} from './sheet-frame.js';
import { cardRowBudget } from './tool-review-card.js';
import { escapeReviewCharacter } from './tool-review-projection.js';
import { displayWidth, wrapWords } from './viewport.js';

/**
 * The `/permissions` sheet ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2): the commands remembered for this project and the ones approved for this session, and taking one back. A docked, keyboard-owning
 * overlay of the family `/models` and `/effort` belong to; this module is its PURE half, like `tool-review-card.ts` is the card's: the state,
 * the fold of one keystroke, and the lines to draw. It owns no `useInput` and imports no React, so the key ladder and every sentence are
 * testable without a terminal, and the model that budgets the rows and the view that draws them cannot disagree.
 *
 * Nothing here writes. A withdrawal is a {@link PermissionsSheetStep} of kind `withdraw` that the host carries out through the port it
 * holds (the store is read again there) and then {@link reloadPermissionsSheet}s with the answer.
 *
 * Two steps, and no typing. Withdrawing only ever makes the chat ask more, but a person who types `/permissions`, `Enter` and goes on typing
 * must not withdraw a grant by accident, and a typed line that ends in `d` followed by `Enter` is two steps. A gap between keys does not
 * tell typing from choosing (the card learned that at 350 ms a key, PR #99), so the rule is about WHAT was typed: once any key that is not
 * navigation has arrived since the sheet opened (or since the last arrow key), `d` arms nothing until an arrow key says the person is
 * choosing a row. On top of that `d` waits for the sheet to settle, and `Enter` withdraws only after the question has been up a moment and
 * not long after.
 */

/**
 * The keys the sheet's legend names. The legend is built from these; the test presses every one of them and checks it does what its verb
 * says, which is what keeps a hint and its handler from drifting (the handler matches the keys themselves, not these labels).
 */
export const SHEET_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  withdraw: { keys: 'd', verb: 'withdraw' },
  confirm: { keys: 'Enter', verb: 'withdraw' },
  keep: { keys: 'Esc', verb: 'keep' },
  close: { keys: 'Esc', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** The legend while no withdrawal is asked: navigation, the action, the leaving key last. */
export const SHEET_LEGEND_IDLE = legend([SHEET_KEYS.select, SHEET_KEYS.withdraw, SHEET_KEYS.close]);
/** The legend of a sheet with nothing to select: only the way out. */
export const SHEET_LEGEND_EMPTY = legend([SHEET_KEYS.close]);
/** The legend while a withdrawal waits for its `Enter`. */
export const SHEET_LEGEND_ARMED = legend([SHEET_KEYS.confirm, SHEET_KEYS.keep]);

/** The sheet must have been open this long before `d` arms a row: a person has had time to read the list. */
export const SHEET_SETTLE_MS = 400;
/** The question must have been up this long before `Enter` withdraws: a key typed ahead is not an answer. */
export const SHEET_CONFIRM_DWELL_MS = 300;
/** ...and no longer than this: a question left up (the terminal was suspended, the person walked away) is not answered by a stray Enter. */
export const SHEET_CONFIRM_WINDOW_MS = 10_000;
/** What an `Enter` outside that window says; the question is dropped and nothing is withdrawn. */
export const SHEET_ENTER_NOTE =
  'Too early or too late for Enter — nothing was withdrawn. Press d again.';
/** What a `d` refused because the sheet has just opened says. */
export const SHEET_WAIT_NOTE = 'Wait a moment, then press d.';
/** What a `d` refused because keys were typed since the sheet opened says. */
export const SHEET_TYPED_NOTE = 'Typed keys are ignored here. Select a row with ↑/↓, then press d.';

/** The most body lines (headings, rows, markers) the sheet shows at once, the bound the model picker uses for its rows. */
export const SHEET_WINDOW = 8;
/** Below this the sheet does not promise a readable frame: ADR-0122 §7.3's floor. */
export const SHEET_MIN_COLUMNS = 80;
export const SHEET_MIN_ROWS = 24;
/** The rows the sheet always draws: the title, the message row and the legend; and the note under the body. */
const FIXED_ROWS = 3;
const NOTE_ROWS = 1;
/** The blank row that separates the sheet from the conversation above it (the card's rule row), outside its lines. */
const MARGIN_ROWS = 1;
/** The column the row's marker takes. */
const MARKER = '› ';
const NO_MARKER = '  ';

/** Whether the sheet shows a chat's two lists or only the project's (the bare Home, a bare `relavium permissions`). */
export type SheetSurface = 'chat' | 'project';

/** One selectable row: a remembered command or a session approval. */
export type SheetEntry = PermissionEntry;

export interface PermissionsSheetState {
  readonly surface: SheetSurface;
  /** The chat's mode, for the title and the note; `undefined` where there is no chat. */
  readonly mode: ChatMode | undefined;
  readonly snapshot: PermissionsSnapshot;
  /** The selected entry's index into {@link sheetEntries}. */
  readonly cursor: number;
  /** A withdrawal of the selected entry waits for its `Enter`. */
  readonly armed: boolean;
  /** The result of the last withdrawal; empty when there is none. The question of an armed row is drawn from the row, not stored. */
  readonly message: string;
  /** The monotonic clock (ms) when the sheet opened and when the question was asked. */
  readonly openedAt: number;
  readonly armedAt: number;
  /** A key that is not navigation has arrived since the sheet opened or since the last arrow key: the person may be typing, so `d` arms nothing. */
  readonly typed: boolean;
}

/** The selectable rows, in the order they are drawn: the project's, then the session's. */
export function sheetEntries(snapshot: PermissionsSnapshot): readonly SheetEntry[] {
  const entries: SheetEntry[] = [];
  if (snapshot.project.ok)
    for (const row of snapshot.project.rows) entries.push({ kind: 'project', row });
  for (const row of snapshot.session ?? []) entries.push({ kind: 'session', row });
  return entries;
}

export function initialPermissionsSheetState(
  snapshot: PermissionsSnapshot,
  surface: SheetSurface,
  mode: ChatMode | undefined,
  now: number,
): PermissionsSheetState {
  return {
    surface,
    mode,
    snapshot,
    cursor: 0,
    armed: false,
    message: '',
    openedAt: now,
    armedAt: Number.NEGATIVE_INFINITY,
    typed: false,
  };
}

/** The sheet after a withdrawal (or a refused one): the data read again, the cursor kept near where it was, nothing armed. */
export function reloadPermissionsSheet(
  state: PermissionsSheetState,
  snapshot: PermissionsSnapshot,
  message: string,
): PermissionsSheetState {
  const count = sheetEntries(snapshot).length;
  return {
    ...state,
    snapshot,
    cursor: Math.max(0, Math.min(state.cursor, count - 1)),
    armed: false,
    message,
  };
}

/** A paste is typing, and not a key the sheet answers to: it drops a waiting question, withdraws nothing, and keeps `d` from arming until an arrow key. */
export function disarmPermissionsSheet(state: PermissionsSheetState): PermissionsSheetState {
  return { ...state, armed: false, typed: true, ...(state.armed ? { message: '' } : {}) };
}

/** What a keystroke does to the open sheet. */
export type PermissionsSheetStep =
  | { readonly kind: 'close' }
  | { readonly kind: 'state'; readonly state: PermissionsSheetState }
  /** The host withdraws `entry` through its port, then reloads the sheet with the answer. */
  | {
      readonly kind: 'withdraw';
      readonly entry: SheetEntry;
      readonly state: PermissionsSheetState;
    };

/** One page: the window size without its markers. A page key moves by this much. */
const PAGE = SHEET_WINDOW - 2;

function clampCursor(cursor: number, count: number): number {
  return Math.max(0, Math.min(cursor, count - 1));
}

/** The keys that arm a withdrawal: `d`, and the Delete key, which a terminal reports as `Delete` or as `Backspace`. */
function isWithdrawKey(input: string, key: ChatKey): boolean {
  if (key.ctrl === true || key.meta === true) return false;
  return key.backspace === true || key.delete === true || input.toLowerCase() === 'd';
}

/** An `Enter` with nothing held: `Esc` then `Enter` inside a terminal's escape window arrives as `Meta+Enter` and is not an answer. */
function isPlainEnter(key: ChatKey): boolean {
  return key.return === true && key.meta !== true && key.ctrl !== true && key.shift !== true;
}

/**
 * Fold one keystroke into the open sheet. `canArm` is false where the frame cannot show the question (below the floor): `d` then does
 * nothing, and a question already asked is dropped by the next key, because a withdrawal is never asked for in a frame that cannot say
 * what it asks. `now` is the monotonic clock in milliseconds.
 *
 * `Ctrl+C` closes from either state and never withdraws. `Esc` drops an armed question first and closes the sheet on the next press, one
 * level at a time; neither ever confirms. `Enter` withdraws only an armed row, only unmodified, and only between
 * {@link SHEET_CONFIRM_DWELL_MS} and {@link SHEET_CONFIRM_WINDOW_MS} after the question; any other key drops the question. `d` arms only
 * once the sheet has settled and only if nothing has been typed since the sheet opened or since the last arrow key.
 */
export function foldPermissionsSheetKey(
  input: string,
  key: ChatKey,
  state: PermissionsSheetState,
  canArm: boolean,
  now: number,
): PermissionsSheetStep {
  if (isInterruptKey(input, key)) return { kind: 'close' };
  const entries = sheetEntries(state.snapshot);
  if (state.armed) {
    // `Esc` keeps the row and is not typing; every other key keeps it too and is.
    const kept: PermissionsSheetStep = {
      kind: 'state',
      state: {
        ...state,
        armed: false,
        message: '',
        typed: key.escape === true ? state.typed : true,
      },
    };
    // The question is not on screen: the frame says how to leave, and `Esc` does.
    if (!canArm) return key.escape === true ? { kind: 'close' } : kept;
    const entry = entries[state.cursor];
    if (isPlainEnter(key) && entry !== undefined) {
      const held = now - state.armedAt;
      if (held >= SHEET_CONFIRM_DWELL_MS && held <= SHEET_CONFIRM_WINDOW_MS)
        return {
          kind: 'withdraw',
          entry,
          state: { ...state, armed: false, message: '', typed: true },
        };
      return {
        kind: 'state',
        state: { ...state, armed: false, message: SHEET_ENTER_NOTE, typed: true },
      };
    }
    return kept;
  }
  if (key.escape === true) return { kind: 'close' };
  const count = entries.length;
  // An arrow key (or a page key) is a person choosing a row, not typing: it says the keys that follow are deliberate.
  const move = (cursor: number): PermissionsSheetStep => ({
    kind: 'state',
    state: { ...state, cursor: clampCursor(cursor, count), message: '', typed: false },
  });
  if (key.upArrow === true) return move(state.cursor - 1);
  if (key.downArrow === true) return move(state.cursor + 1);
  if (key.pageUp === true) return move(state.cursor - PAGE);
  if (key.pageDown === true) return move(state.cursor + PAGE);
  if (key.home === true) return move(0);
  if (key.end === true) return move(count - 1);
  if (isWithdrawKey(input, key)) {
    if (!canArm || entries[state.cursor] === undefined)
      return { kind: 'state', state: { ...state, typed: true } };
    if (state.typed) return { kind: 'state', state: { ...state, message: SHEET_TYPED_NOTE } };
    // Too soon is not typing: a person who pressed `d` early and presses it again after a moment is choosing.
    if (now - state.openedAt < SHEET_SETTLE_MS)
      return { kind: 'state', state: { ...state, message: SHEET_WAIT_NOTE } };
    return { kind: 'state', state: { ...state, armed: true, armedAt: now, message: '' } };
  }
  return { kind: 'state', state: { ...state, typed: true, message: '' } };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

export type { SheetGeometry, SheetLine, SheetLineKind } from './sheet-frame.js';

export function sheetTitle(state: PermissionsSheetState): string {
  return state.mode === undefined || state.surface === 'project'
    ? 'Permissions · this project'
    : `Permissions · ${state.mode} mode`;
}

/** The one-row note on what a grant is worth ([ADR-0118](../../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1). */
export function sheetNote(state: PermissionsSheetState): string {
  if (state.surface === 'project' || state.mode === undefined)
    return 'Only auto mode runs a remembered command unasked, in a chat in this project.';
  switch (state.mode) {
    case 'auto':
      return 'Auto runs approved commands; remembered ones ask once after a file write.';
    case 'plan':
      return 'Plan mode refuses every command; nothing here runs.';
    case 'ask':
    case 'accept-edits':
      return 'Session-approved commands run unasked here; a remembered one still asks.';
  }
}

/** What an empty project list says, by surface (`plan` has no cards, so it has nothing to point at). */
function emptyProjectText(state: PermissionsSheetState): string {
  if (state.surface !== 'chat')
    return 'Nothing is remembered for this project. A command is remembered from its card in a chat (Ctrl+O, then Enter).';
  return state.mode === 'plan'
    ? 'Nothing is remembered for this project.'
    : 'Nothing is remembered for this project. Press Ctrl+O on a command card, then Enter, to remember one.';
}

const EMPTY_SESSION_TEXT = 'Nothing is approved for this session.';

/** The text of a command, with every control, invisible and `<` character shown as the card shows it (`<U+202E>`, `<TAB>`). */
function escaped(text: string): string {
  return [...text].map((char) => escapeReviewCharacter(char, false)).join('');
}

interface BodyLine {
  readonly kind: SheetLineKind;
  readonly text: string;
  /** The entry this line is, for a row; the window keeps the selected one in view and the markers count these. */
  readonly entry?: number;
}

/** The whole body, before it is windowed: the headings, the rows, and the empty or failure text of a section. */
function bodyLines(state: PermissionsSheetState, width: number): readonly BodyLine[] {
  const lines: BodyLine[] = [];
  const { project, session } = state.snapshot;
  let entryIndex = 0;
  const row = (left: string, right: string): void => {
    const selected = entryIndex === state.cursor;
    lines.push({
      kind: selected ? 'selected' : 'row',
      text: flushRow(`${selected ? MARKER : NO_MARKER}${left}`, right, width),
      entry: entryIndex,
    });
    entryIndex += 1;
  };
  if (project.ok) {
    lines.push({
      kind: 'heading',
      text: `This project · remembered (${String(project.rows.length)})`,
    });
    if (project.rows.length === 0) {
      for (const text of wrapWords(emptyProjectText(state), width))
        lines.push({ kind: 'text', text: text.trimEnd() });
    }
    for (const item of project.rows) row(escaped(item.label), escaped(item.remembered));
  } else {
    lines.push({ kind: 'heading', text: 'This project · remembered' });
    for (const text of wrapWords(project.text, width))
      lines.push({ kind: 'text', text: text.trimEnd() });
  }
  if (session !== undefined) {
    lines.push({ kind: 'heading', text: `This session · approved (${String(session.length)})` });
    if (session.length === 0) lines.push({ kind: 'text', text: EMPTY_SESSION_TEXT });
    for (const item of session)
      row(escaped(item.text), item.alsoRemembered ? '(also remembered)' : '');
  }
  return lines;
}

/** The lines of the sheet when the terminal is below the floor: the title, why, and the way out. */
function tooSmallLines(state: PermissionsSheetState): readonly SheetLine[] {
  return [
    { kind: 'title', text: sheetTitle(state) },
    { kind: 'text', text: 'Enlarge the terminal to use this screen — Esc closes.' },
    { kind: 'legend', text: legend([SHEET_KEYS.close]) },
  ];
}

/** Whether the sheet's frame can show a withdrawal's question: the terminal is at least 80×24. */
export function sheetCanArm(geometry: SheetGeometry): boolean {
  return geometry.columns >= SHEET_MIN_COLUMNS && geometry.terminalRows >= SHEET_MIN_ROWS;
}

/** How many selectable rows lie in `lines`: what a `▲`/`▼` marker counts (the headings and the empty-state text are not rows). */
function rowsIn(lines: readonly BodyLine[]): number {
  return lines.filter((line) => line.entry !== undefined).length;
}

/**
 * The sheet's lines, top to bottom, for a terminal of this size. The budget is the card's ([ADR-0129](../../../../../docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)
 * §2): at most three fifths of the terminal, and never so many that fewer than eight transcript rows remain. The title, the note, the
 * message row and the legend are always drawn (the floor of 80×24 leaves room for all of them and at least seven body lines) and the
 * selected row is always visible; the body gets the rest, up to {@link SHEET_WINDOW} lines. Every line is clipped to the width.
 *
 * When body lines are hidden, the first or last body line is a marker that counts the ROWS it stands in for, the one under the marker
 * included; a heading is never left alone at the bottom of the window above a marker.
 */
export function permissionsSheetLines(
  state: PermissionsSheetState,
  geometry: SheetGeometry,
): readonly SheetLine[] {
  if (!sheetCanArm(geometry)) return tooSmallLines(state);
  const width = usableColumns(geometry.columns);
  const room = cardRowBudget(geometry.terminalRows) - MARGIN_ROWS;
  const all = bodyLines(state, width);
  const height = Math.min(SHEET_WINDOW, room - FIXED_ROWS - NOTE_ROWS);
  const cursorLine = Math.max(
    0,
    all.findIndex((line) => line.entry === state.cursor),
  );
  // A marker is drawn only where a ROW is hidden, and stands in for the rows above or below it, the line it covers included. So a window is good
  // when the cursor is off a drawn marker, no heading is left alone above a `▼` marker or at the very bottom of a window that hides lines, and no
  // fragment of a hidden heading's text starts it: the window moves to the nearest start that is.
  const { start, end } = windowBody(all.length, cursorLine, height, (from, to) => {
    const topMarker = rowsIn(all.slice(0, from)) > 0;
    const bottomMarker = rowsIn(all.slice(to)) > 0;
    if (cursorLine < from + (topMarker ? 1 : 0) || cursorLine >= to - (bottomMarker ? 1 : 0))
      return false;
    if (!topMarker && from > 0 && all[from]?.kind === 'text') return false;
    if (
      bottomMarker
        ? all[to - 2]?.kind === 'heading'
        : to < all.length && all[to - 1]?.kind === 'heading'
    )
      return false;
    return true;
  });
  const topMarker = rowsIn(all.slice(0, start)) > 0;
  const bottomMarker = rowsIn(all.slice(end)) > 0;
  const body: SheetLine[] = all.slice(start, end).map((line) => ({
    kind: line.kind,
    text: clipLine(line.text, width),
  }));
  if (topMarker && body.length > 0)
    body[0] = { kind: 'marker', text: `▲ ${String(rowsIn(all.slice(0, start + 1)))} more` };
  if (bottomMarker && body.length > 0)
    body[body.length - 1] = {
      kind: 'marker',
      text: `▼ ${String(rowsIn(all.slice(end - 1)))} more`,
    };
  const hasEntries = sheetEntries(state.snapshot).length > 0;
  return [
    { kind: 'title', text: clipLine(sheetTitle(state), width) },
    ...body,
    { kind: 'note', text: clipLine(sheetNote(state), width) },
    messageLine(state, width),
    {
      kind: 'legend',
      text: clipLine(
        state.armed ? SHEET_LEGEND_ARMED : hasEntries ? SHEET_LEGEND_IDLE : SHEET_LEGEND_EMPTY,
        width,
      ),
    },
  ];
}

/** The message row: the question while a withdrawal waits, else the last result, else blank. Always one row, so a state change moves nothing. */
function messageLine(state: PermissionsSheetState, width: number): SheetLine {
  if (state.armed) {
    const entry = sheetEntries(state.snapshot)[state.cursor];
    if (entry !== undefined) {
      const tail = '? Any other key keeps it.';
      const head = 'Withdraw ';
      const room = Math.max(8, width - displayWidth(head) - displayWidth(tail));
      // The date is what tells two grants of one program apart, so it is kept and the label is clipped to make room for it.
      const what =
        entry.kind === 'project'
          ? (() => {
              const suffix = ` (${escaped(entry.row.remembered)})`;
              return `${clipLine(escaped(entry.row.label), Math.max(4, room - displayWidth(suffix)))}${suffix}`;
            })()
          : clipLine(escaped(entry.row.text), room);
      return { kind: 'question', text: `${head}${what}${tail}` };
    }
  }
  return { kind: 'message', text: clipLine(escaped(state.message), width) };
}
