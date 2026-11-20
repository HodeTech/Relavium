import type { ChatMode } from '../../chat/chat-mode.js';
import type { PermissionEntry, PermissionsSnapshot } from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { legend, type LegendItem } from './legend.js';
import { escapeReviewCharacter } from './tool-review-projection.js';
import { cardRowBudget } from './tool-review-card.js';
import { displayWidth, sliceDisplayColumns, wrapWords } from './viewport.js';

/**
 * The `/permissions` sheet ([ADR-0137](../../../../../docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md)
 * §2): the commands remembered for this project and the ones approved for this session, and taking one back. A docked, keyboard-owning
 * overlay of the family `/models` and `/effort` belong to; this module is its PURE half, like `tool-review-card.ts` is the card's: the state,
 * the fold of one keystroke, and the lines to draw. It owns no `useInput` and imports no React, so the key ladder and every sentence are
 * testable without a terminal, and the model that budgets the rows and the view that draws them cannot disagree.
 *
 * Nothing here writes. A withdrawal is a {@link PermissionsSheetStep} of kind `withdraw` that the host carries out through the port it
 * holds (the store is read again there) and then {@link reloadPermissionsSheet}s with the answer.
 */

/** The keys the sheet answers to, with the words its legend uses: the one constant both the handler and the legend read. */
export const SHEET_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  withdraw: { keys: 'd', verb: 'withdraw' },
  confirm: { keys: 'Enter', verb: 'withdraw' },
  keep: { keys: 'Esc', verb: 'keep' },
  close: { keys: 'Esc', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** The legend while no withdrawal is asked: navigation, the action, the leaving key last. */
export const SHEET_LEGEND_IDLE = legend([SHEET_KEYS.select, SHEET_KEYS.withdraw, SHEET_KEYS.close]);
/** The legend while a withdrawal waits for its `Enter`. */
export const SHEET_LEGEND_ARMED = legend([SHEET_KEYS.confirm, SHEET_KEYS.keep]);

/** The most body lines (headings, rows, markers) the sheet shows at once, the bound the model picker uses for its rows. */
export const SHEET_WINDOW = 8;
/** Below this the sheet does not promise a readable frame: ADR-0122 §7.3's floor. */
export const SHEET_MIN_COLUMNS = 80;
export const SHEET_MIN_ROWS = 24;
/** The rows the sheet always draws: the title, the message row and the legend. */
const FIXED_ROWS = 3;
/** The blank row that separates the sheet from the conversation above it (the card's rule row), outside its lines. */
const MARGIN_ROWS = 1;
/** The column the row's marker takes, and the gap between a row's label and what flushes right. */
const MARKER = '› ';
const NO_MARKER = '  ';
const GAP = 2;

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
): PermissionsSheetState {
  return { surface, mode, snapshot, cursor: 0, armed: false, message: '' };
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

/** A paste (or any input that is not a key of the sheet) while a withdrawal waits: the question is dropped, nothing is withdrawn. */
export function disarmPermissionsSheet(state: PermissionsSheetState): PermissionsSheetState {
  return state.armed ? { ...state, armed: false, message: '' } : state;
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

/**
 * Fold one keystroke into the open sheet. `canArm` is false where the frame cannot show the question (below the floor): `d` then does
 * nothing, because a withdrawal is never asked for in a frame that cannot say what it asks.
 *
 * `Ctrl+C` closes from either state and never withdraws. `Esc` drops an armed question first and closes the sheet on the next press, one
 * level at a time; neither ever confirms. `Enter` withdraws only an armed row, and any other key drops the question.
 */
export function foldPermissionsSheetKey(
  input: string,
  key: ChatKey,
  state: PermissionsSheetState,
  canArm: boolean,
): PermissionsSheetStep {
  if (isInterruptKey(input, key)) return { kind: 'close' };
  const entries = sheetEntries(state.snapshot);
  if (state.armed) {
    const entry = entries[state.cursor];
    if (key.return === true && entry !== undefined)
      return { kind: 'withdraw', entry, state: { ...state, armed: false, message: '' } };
    // `Esc` keeps the row; so does every other key. The key does nothing else.
    return { kind: 'state', state: { ...state, armed: false, message: '' } };
  }
  if (key.escape === true) return { kind: 'close' };
  const count = entries.length;
  const move = (cursor: number): PermissionsSheetStep => ({
    kind: 'state',
    state: { ...state, cursor: clampCursor(cursor, count), message: '' },
  });
  if (key.upArrow === true) return move(state.cursor - 1);
  if (key.downArrow === true) return move(state.cursor + 1);
  if (key.pageUp === true) return move(state.cursor - PAGE);
  if (key.pageDown === true) return move(state.cursor + PAGE);
  if (key.home === true) return move(0);
  if (key.end === true) return move(count - 1);
  if (isWithdrawKey(input, key) && canArm && entries[state.cursor] !== undefined)
    return { kind: 'state', state: { ...state, armed: true, message: '' } };
  return { kind: 'state', state };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The role of one drawn row, so a view colours by role and never by guessing from the text. */
export type SheetLineKind =
  | 'title'
  | 'heading'
  | 'row'
  | 'selected'
  | 'text'
  | 'marker'
  | 'note'
  | 'message'
  | 'question'
  | 'legend';

export interface SheetLine {
  readonly kind: SheetLineKind;
  readonly text: string;
}

export interface SheetGeometry {
  readonly columns: number;
  readonly terminalRows: number;
}

/** The columns a line may use: a margin on each side, as the card's rows have. */
function usableColumns(columns: number): number {
  return Math.max(1, columns - 2);
}

/** `text` cut to `width` display columns, the cut shown by `…`; whole when it fits. */
export function clipLine(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 1) return sliceDisplayColumns(text, 0, Math.max(0, width));
  return `${sliceDisplayColumns(text, 0, width - 1)}…`;
}

/** `left` and `right` on one row, `right` flush to the edge; `left` is clipped first, and `right` is dropped when it would leave no room. */
function flushRow(left: string, right: string, width: number): string {
  if (right.length === 0) return clipLine(left, width);
  const room = width - displayWidth(right) - GAP;
  if (room < 12) return clipLine(left, width);
  const clipped = clipLine(left, room);
  return `${clipped}${' '.repeat(Math.max(GAP, width - displayWidth(clipped) - displayWidth(right)))}${right}`;
}

/** The text of a command, with every control, invisible and `<` character shown as the card shows it (`<U+202E>`, `<TAB>`). */
function escaped(text: string): string {
  return [...text].map((char) => escapeReviewCharacter(char, false)).join('');
}

export function sheetTitle(state: PermissionsSheetState): string {
  return state.mode === undefined || state.surface === 'project'
    ? 'Permissions · this project'
    : `Permissions · ${state.mode} mode`;
}

/** The one-row note on what a grant is worth ([ADR-0118](../../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1). */
export function sheetNote(state: PermissionsSheetState): string {
  if (state.surface === 'project' || state.mode === undefined)
    return 'A remembered command runs unasked only in auto mode, in a chat opened in this project.';
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

interface BodyLine {
  readonly kind: SheetLineKind;
  readonly text: string;
  /** The entry this line is, for a row; the window keeps the selected one in view. */
  readonly entry?: number;
}

/** The whole body, before it is windowed: the headings, the rows, and the empty or failure text of a section. */
function bodyLines(state: PermissionsSheetState, width: number): readonly BodyLine[] {
  const lines: BodyLine[] = [];
  const { project, session } = state.snapshot;
  let entryIndex = 0;
  if (project.ok) {
    lines.push({
      kind: 'heading',
      text: `This project · remembered (${String(project.rows.length)})`,
    });
    if (project.rows.length === 0) {
      for (const text of wrapWords(emptyProjectText(state), width))
        lines.push({ kind: 'text', text: text.trimEnd() });
    }
    for (const row of project.rows) {
      const selected = entryIndex === state.cursor;
      lines.push({
        kind: selected ? 'selected' : 'row',
        text: flushRow(
          `${selected ? MARKER : NO_MARKER}${escaped(row.label)}`,
          `remembered ${row.remembered}`,
          width,
        ),
        entry: entryIndex,
      });
      entryIndex += 1;
    }
  } else {
    lines.push({ kind: 'heading', text: 'This project · remembered' });
    for (const text of wrapWords(project.text, width))
      lines.push({ kind: 'text', text: text.trimEnd() });
  }
  if (session !== undefined) {
    lines.push({ kind: 'heading', text: `This session · approved (${String(session.length)})` });
    if (session.length === 0) lines.push({ kind: 'text', text: EMPTY_SESSION_TEXT });
    for (const row of session) {
      const selected = entryIndex === state.cursor;
      lines.push({
        kind: selected ? 'selected' : 'row',
        text: flushRow(
          `${selected ? MARKER : NO_MARKER}${escaped(row.text)}`,
          row.alsoRemembered ? '(also remembered)' : '',
          width,
        ),
        entry: entryIndex,
      });
      entryIndex += 1;
    }
  }
  return lines;
}

/**
 * The window of `height` lines of `total` that keeps `cursorLine` on a real line: when lines are hidden above or below, the first or
 * last window line is the `▲ n more` / `▼ n more` marker, and the cursor is never on one. The cursor is centred, which leaves it at least
 * one line from each end of a window of three or more lines, so a marker never covers it (a window of fewer lines cannot hold a cursor
 * between two markers; the floor of 80×24 gives the sheet at least seven). Pure so the arithmetic is unit-checkable.
 */
export function windowBody(
  total: number,
  cursorLine: number,
  height: number,
): { readonly start: number; readonly end: number } {
  if (total <= height) return { start: 0, end: total };
  const start = Math.max(0, Math.min(cursorLine - Math.floor((height - 1) / 2), total - height));
  return { start, end: start + height };
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

/**
 * The sheet's lines, top to bottom, for a terminal of this size. The budget is the card's ([ADR-0129](../../../../../docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md)
 * §2): at most three fifths of the terminal, and never so many that fewer than eight transcript rows remain. The title, the message row
 * and the legend are always drawn and the selected row is always visible; the note is the first to go when the budget is short, and the
 * body gets the rest, from one line to {@link SHEET_WINDOW}. Every line is clipped to the width.
 */
export function permissionsSheetLines(
  state: PermissionsSheetState,
  geometry: SheetGeometry,
): readonly SheetLine[] {
  if (!sheetCanArm(geometry)) return tooSmallLines(state);
  const width = usableColumns(geometry.columns);
  const room = cardRowBudget(geometry.terminalRows) - MARGIN_ROWS;
  const note = sheetNote(state);
  const all = bodyLines(state, width);
  const withNote = room - FIXED_ROWS - 1 >= 1;
  const height = Math.max(1, Math.min(SHEET_WINDOW, room - FIXED_ROWS - (withNote ? 1 : 0)));
  const cursorLine = Math.max(
    0,
    all.findIndex((line) => line.entry === state.cursor && line.entry !== undefined),
  );
  const { start, end } = windowBody(all.length, cursorLine, height);
  const body: SheetLine[] = all.slice(start, end).map((line) => ({
    kind: line.kind,
    text: clipLine(line.text, width),
  }));
  if (start > 0 && body.length > 0) body[0] = { kind: 'marker', text: `▲ ${String(start)} more` };
  if (end < all.length && body.length > 0)
    body[body.length - 1] = { kind: 'marker', text: `▼ ${String(all.length - end)} more` };
  return [
    { kind: 'title', text: clipLine(sheetTitle(state), width) },
    ...body,
    ...(withNote ? [{ kind: 'note' as const, text: clipLine(note, width) }] : []),
    messageLine(state, width),
    {
      kind: 'legend',
      text: clipLine(state.armed ? SHEET_LEGEND_ARMED : SHEET_LEGEND_IDLE, width),
    },
  ];
}

/** The message row: the question while a withdrawal waits, else the last result, else blank. Always one row, so a state change moves nothing. */
function messageLine(state: PermissionsSheetState, width: number): SheetLine {
  if (state.armed) {
    const entry = sheetEntries(state.snapshot)[state.cursor];
    if (entry !== undefined) {
      const tail = `? ${SHEET_KEYS.confirm.keys} withdraws · ${SHEET_KEYS.keep.keys} keeps it`;
      const head = 'Withdraw ';
      const room = Math.max(8, width - displayWidth(head) - displayWidth(tail));
      // The date is what tells two grants of one program apart, so it is kept and the label is clipped to make room for it.
      const what =
        entry.kind === 'project'
          ? (() => {
              const suffix = ` (${entry.row.remembered})`;
              return `${clipLine(escaped(entry.row.label), Math.max(4, room - displayWidth(suffix)))}${suffix}`;
            })()
          : clipLine(escaped(entry.row.text), room);
      return { kind: 'question', text: `${head}${what}${tail}` };
    }
  }
  return { kind: 'message', text: clipLine(state.message, width) };
}
