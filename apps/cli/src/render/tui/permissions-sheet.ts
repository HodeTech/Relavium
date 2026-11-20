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
 * Two steps, and time. Withdrawing only ever makes the chat ask more, but a person who types `/permissions`, `Enter` and goes on typing
 * must not withdraw a grant by accident, and a typed line that ends in `d` followed by `Enter` is two steps: so the keys are timed like the
 * card's. `d` arms only once the sheet has been open a moment and the keyboard has been quiet a moment, and `Enter` withdraws only after the
 * question has been up a moment.
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
/** The keyboard must have been quiet this long before `d` arms a row: a typed line is not a command. */
export const SHEET_QUIET_MS = 300;
/** The question must have been up this long before `Enter` withdraws: a key typed ahead is not an answer. */
export const SHEET_CONFIRM_DWELL_MS = 300;
/** What an `Enter` that came before its dwell says; the question is dropped and nothing is withdrawn. */
export const SHEET_ENTER_NOTE = 'Too early for Enter — nothing was withdrawn. Press d again.';

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
  /** The monotonic clock (ms) when the sheet opened, when the last key of any kind arrived, and when the question was asked. */
  readonly openedAt: number;
  readonly lastKeyAt: number;
  readonly armedAt: number;
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
    lastKeyAt: now,
    armedAt: Number.NEGATIVE_INFINITY,
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

/** A paste is a key too, and not one the sheet answers to: it drops a waiting question and withdraws nothing. */
export function disarmPermissionsSheet(
  state: PermissionsSheetState,
  now: number,
): PermissionsSheetState {
  return { ...state, armed: false, lastKeyAt: now, ...(state.armed ? { message: '' } : {}) };
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
 * level at a time; neither ever confirms. `Enter` withdraws only an armed row, only unmodified, and only once the question has been up for
 * {@link SHEET_CONFIRM_DWELL_MS}; any other key drops the question. `d` arms only once the sheet has settled and the keyboard has been quiet.
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
  // Every key, whatever it does, is evidence of a person typing: it restarts the quiet the next `d` needs.
  const touched: PermissionsSheetState = { ...state, lastKeyAt: now };
  if (state.armed) {
    const kept: PermissionsSheetStep = {
      kind: 'state',
      state: { ...touched, armed: false, message: '' },
    };
    // The question is not on screen: the frame says how to leave, and `Esc` does.
    if (!canArm) return key.escape === true ? { kind: 'close' } : kept;
    const entry = entries[state.cursor];
    if (isPlainEnter(key) && entry !== undefined) {
      if (now - state.armedAt >= SHEET_CONFIRM_DWELL_MS)
        return {
          kind: 'withdraw',
          entry,
          state: { ...touched, armed: false, message: '' },
        };
      return { kind: 'state', state: { ...touched, armed: false, message: SHEET_ENTER_NOTE } };
    }
    // `Esc` keeps the row; so does every other key, a modified `Enter` included. The key does nothing else.
    return kept;
  }
  if (key.escape === true) return { kind: 'close' };
  const count = entries.length;
  const move = (cursor: number): PermissionsSheetStep => ({
    kind: 'state',
    state: { ...touched, cursor: clampCursor(cursor, count), message: '' },
  });
  if (key.upArrow === true) return move(state.cursor - 1);
  if (key.downArrow === true) return move(state.cursor + 1);
  if (key.pageUp === true) return move(state.cursor - PAGE);
  if (key.pageDown === true) return move(state.cursor + PAGE);
  if (key.home === true) return move(0);
  if (key.end === true) return move(count - 1);
  if (
    isWithdrawKey(input, key) &&
    canArm &&
    entries[state.cursor] !== undefined &&
    now - state.openedAt >= SHEET_SETTLE_MS &&
    now - state.lastKeyAt >= SHEET_QUIET_MS
  )
    return { kind: 'state', state: { ...touched, armed: true, armedAt: now, message: '' } };
  return { kind: 'state', state: touched };
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
      return 'Auto mode runs a remembered command unasked, and asks once after a file write.';
    case 'plan':
      return 'Plan mode refuses every command; nothing here runs.';
    case 'ask':
    case 'accept-edits':
      return 'Remembered commands still ask here; only auto mode runs one unasked.';
  }
}

/** What an empty project list says, by surface. */
function emptyProjectText(state: PermissionsSheetState): string {
  return state.surface === 'chat'
    ? 'Nothing is remembered for this project. Press Ctrl+O on a command card to remember one.'
    : 'Nothing is remembered for this project. A command is remembered from its card in a chat (Ctrl+O).';
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
  let { start, end } = windowBody(all.length, cursorLine, height);
  // A heading as the last real line above a `▼` marker would head nothing: slide the window down one line, which the centred cursor allows.
  if (end < all.length && all[end - 2]?.kind === 'heading' && cursorLine >= start + 2) {
    start += 1;
    end += 1;
  }
  const body: SheetLine[] = all.slice(start, end).map((line) => ({
    kind: line.kind,
    text: clipLine(line.text, width),
  }));
  if (start > 0 && body.length > 0)
    body[0] = { kind: 'marker', text: `▲ ${String(rowsIn(all.slice(0, start + 1)))} more` };
  if (end < all.length && body.length > 0)
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
