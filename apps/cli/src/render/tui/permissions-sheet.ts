import type { ChatMode } from '../../chat/chat-mode.js';
import type {
  PermissionEntry,
  PermissionsSnapshot,
  WithdrawAnswer,
} from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { legend, legendSpans, type LegendItem } from './legend.js';
import {
  clampSpans,
  clipLine,
  flushRow,
  usableColumns,
  windowBody,
  type SheetGeometry,
  type SheetLine,
  type SheetLineKind,
  type SheetSpan,
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
 * What a person sees. The action is on the thing it acts on: the selected row carries its own `[d] withdraw`, the row under the list says
 * what withdrawing it will do before it is done, the legend names the key in brackets and in danger (a key that changes something is
 * bracketed, as the card's answers are), and the answer comes back with a glyph and a tone (`✓` done, `✗` failed, a yellow note).
 *
 * Two steps, and no typing. Withdrawing only ever makes the chat ask more, but a person who types `/permissions`, `Enter` and goes on typing
 * must not withdraw a grant by accident, and a typed line that ends in `d` followed by `Enter` is two steps. A gap between keys does not
 * tell typing from choosing (the card learned that at 350 ms a key, PR #99), so the rule is about WHAT was typed: once any key that is not
 * navigation has arrived since the sheet opened (or since the last arrow key), `d` arms nothing until an arrow key says the person is
 * choosing a row. On top of that `d` waits for the sheet to settle, and `Enter` withdraws only after the question has been up as long as
 * the card's `Enter` waits, and not long after.
 */

/**
 * The keys the sheet's legend names. The legend is built from these; the test presses every one of them and checks it does what its verb
 * says, which is what keeps a hint and its handler from drifting (the handler matches the keys themselves, not these labels). A key that
 * changes something is bracketed and coloured (`[d / Del]`, `[Enter]`), as the card's answers are; a key that only moves or leaves is not.
 */
export const SHEET_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  withdraw: { keys: '[d / Del]', verb: 'withdraw', role: 'danger' },
  confirm: { keys: '[Enter]', verb: 'withdraw', role: 'warn' },
  keep: { keys: 'Esc', verb: 'keep' },
  close: { keys: 'Esc', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** The legend while no withdrawal is asked: navigation, the action, the leaving key last. */
export const SHEET_LEGEND_IDLE_ITEMS: readonly LegendItem[] = [
  SHEET_KEYS.select,
  SHEET_KEYS.withdraw,
  SHEET_KEYS.close,
];
export const SHEET_LEGEND_IDLE = legend(SHEET_LEGEND_IDLE_ITEMS);
/** The legend of a sheet with nothing to select: only the way out. */
export const SHEET_LEGEND_EMPTY_ITEMS: readonly LegendItem[] = [SHEET_KEYS.close];
export const SHEET_LEGEND_EMPTY = legend(SHEET_LEGEND_EMPTY_ITEMS);
/** The legend while a withdrawal waits for its `Enter`. */
export const SHEET_LEGEND_ARMED_ITEMS: readonly LegendItem[] = [
  SHEET_KEYS.confirm,
  SHEET_KEYS.keep,
];
export const SHEET_LEGEND_ARMED = legend(SHEET_LEGEND_ARMED_ITEMS);

/** What the selected row carries at its right edge, and what it carries while its question is up. */
export const SHEET_CHIP_IDLE = '[d] withdraw';
export const SHEET_CHIP_ARMED = '[Enter] withdraw';

/** The sheet must have been open this long before `d` arms a row: a person has had time to read the list. */
export const SHEET_SETTLE_MS = 400;
/** The question must have been up this long before `Enter` withdraws: a key typed ahead is not an answer. The card's own minimum. */
export const SHEET_CONFIRM_DWELL_MS = 800;
/** ...and no longer than this: a question left up (the terminal was suspended, the person walked away) is not answered by a stray Enter. */
export const SHEET_CONFIRM_WINDOW_MS = 10_000;
/** What an `Enter` outside that window says; the question is dropped and nothing is withdrawn. */
export const SHEET_ENTER_NOTE =
  'Too early or too late for Enter — nothing was withdrawn. Press d again.';
/** What a `d` refused because the sheet has just opened says. */
export const SHEET_WAIT_NOTE = 'Wait a moment, then press d.';
/** What a `d` refused because keys were typed since the sheet opened says. */
export const SHEET_TYPED_NOTE = 'Typed keys are ignored here. Select a row with ↑/↓, then press d.';

/** The most body lines (headings, rows and markers) the sheet shows at once, the bound the model picker uses for its rows. */
export const SHEET_WINDOW = 8;
/** Below this the sheet does not promise a readable frame: ADR-0122 §7.3's floor. */
export const SHEET_MIN_COLUMNS = 80;
export const SHEET_MIN_ROWS = 24;
/** The rows the sheet always draws: the rule that carries the title, the message row and the legend; and the note under the body. */
const FIXED_ROWS = 3;
const NOTE_ROWS = 1;
/** The column the row's marker takes, and the gap between a row's value and its action. */
const MARKER = '› ';
const NO_MARKER = '  ';
const CHIP_GAP = '   ';

/** Whether the sheet shows a chat's two lists or only the project's (the bare Home, a bare `relavium permissions`). */
export type SheetSurface = 'chat' | 'project';

/** One selectable row: a remembered command or a session approval. */
export type SheetEntry = PermissionEntry;

/** What the message row says after a key or a withdrawal: a result, a failure, or a note on what the sheet did not do. */
export type SheetMessage = WithdrawAnswer;

const notice = (text: string): SheetMessage => ({ tone: 'note', text });

export interface PermissionsSheetState {
  readonly surface: SheetSurface;
  /** The chat's mode, for the title and the note; `undefined` where there is no chat. */
  readonly mode: ChatMode | undefined;
  readonly snapshot: PermissionsSnapshot;
  /** The selected entry's index into {@link sheetEntries}. */
  readonly cursor: number;
  /** A withdrawal of the selected entry waits for its `Enter`. */
  readonly armed: boolean;
  /** The result of the last withdrawal or the note on the last refused key; `undefined` when there is none. */
  readonly message: SheetMessage | undefined;
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
    message: undefined,
    openedAt: now,
    armedAt: Number.NEGATIVE_INFINITY,
    typed: false,
  };
}

/** The sheet after a withdrawal (or a refused one): the data read again, the cursor kept near where it was, nothing armed. */
export function reloadPermissionsSheet(
  state: PermissionsSheetState,
  snapshot: PermissionsSnapshot,
  message: SheetMessage | undefined,
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
  return { ...state, armed: false, typed: true, ...(state.armed ? { message: undefined } : {}) };
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

/** The keys that say a person is choosing a row, not typing: the arrows, the page keys, `Home` and `End`. */
function isNavigationKey(key: ChatKey): boolean {
  return (
    key.upArrow === true ||
    key.downArrow === true ||
    key.pageUp === true ||
    key.pageDown === true ||
    key.home === true ||
    key.end === true
  );
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
 * once the sheet has settled and only if nothing has been typed since the sheet opened or since the last arrow key. An `Enter` that
 * reaches the question always follows a deliberate arming `d`, so neither it nor the withdrawal it makes counts as typing.
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
    // `Esc` and a navigation key keep the row and are not typing (ADR-0137 §2: only a key that is not navigation is); every other key
    // keeps it too and is. A navigation key does not move the row either: it drops the question, as every key but `Enter` does.
    const kept: PermissionsSheetStep = {
      kind: 'state',
      state: {
        ...state,
        armed: false,
        message: undefined,
        typed: key.escape === true || isNavigationKey(key) ? state.typed : true,
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
          state: { ...state, armed: false, message: undefined },
        };
      return {
        kind: 'state',
        state: { ...state, armed: false, message: notice(SHEET_ENTER_NOTE) },
      };
    }
    return kept;
  }
  if (key.escape === true) return { kind: 'close' };
  const count = entries.length;
  // An arrow key (or a page key) is a person choosing a row, not typing: it says the keys that follow are deliberate.
  const move = (cursor: number): PermissionsSheetStep => ({
    kind: 'state',
    state: {
      ...state,
      cursor: clampCursor(cursor, count),
      message: undefined,
      typed: false,
    },
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
    if (state.typed)
      return { kind: 'state', state: { ...state, message: notice(SHEET_TYPED_NOTE) } };
    // Too soon is not typing: a person who pressed `d` early and presses it again after a moment is choosing.
    if (now - state.openedAt < SHEET_SETTLE_MS)
      return { kind: 'state', state: { ...state, message: notice(SHEET_WAIT_NOTE) } };
    return {
      kind: 'state',
      state: { ...state, armed: true, armedAt: now, message: undefined },
    };
  }
  return { kind: 'state', state: { ...state, typed: true, message: undefined } };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

export type {
  SheetGeometry,
  SheetLine,
  SheetLineKind,
  SheetRole,
  SheetSpan,
} from './sheet-frame.js';

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
      return 'Auto runs approved commands; remembered ones ask again after a file write.';
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
  readonly spans?: readonly SheetSpan[];
  /** The entry this line is, for a row; the window keeps the selected one in view and the markers count these. */
  readonly entry?: number;
}

/**
 * One row: the marker and the label on the left; on the right the value (a date, or `(also remembered)`) flush to the edge, so the dates stay
 * in one column however the selection moves, and, on the selected row only, its action just before the value (`[d] withdraw`, or
 * `[Enter] withdraw` while its question is up) with the key in its role. A row too narrow for the right-hand side keeps the label alone.
 */
function rowLine(
  label: string,
  tail: string,
  entry: number,
  state: PermissionsSheetState,
  width: number,
): BodyLine {
  const selected = entry === state.cursor;
  const armed = selected && state.armed;
  const chip = !selected ? '' : armed ? SHEET_CHIP_ARMED : SHEET_CHIP_IDLE;
  const right = chip === '' ? tail : tail === '' ? chip : `${chip}${CHIP_GAP}${tail}`;
  const text = flushRow(`${selected ? MARKER : NO_MARKER}${label}`, right, width);
  const spans: SheetSpan[] = [];
  if (right !== '' && text.endsWith(right)) {
    const at = text.length - right.length;
    if (chip !== '')
      spans.push({ from: at, to: at + chip.indexOf(']') + 1, role: armed ? 'warn' : 'danger' });
    if (tail !== '') {
      const tailAt = at + (chip === '' ? 0 : chip.length + CHIP_GAP.length);
      spans.push({ from: tailAt, to: tailAt + tail.length, role: 'dim' });
    }
  }
  return { kind: armed ? 'armed' : selected ? 'selected' : 'row', text, spans, entry };
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
    for (const item of project.rows) {
      lines.push(rowLine(escaped(item.label), escaped(item.remembered), entryIndex, state, width));
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
    for (const item of session) {
      lines.push(
        rowLine(
          escaped(item.text),
          item.alsoRemembered ? '(also remembered)' : '',
          entryIndex,
          state,
          width,
        ),
      );
      entryIndex += 1;
    }
  }
  return lines;
}

/** The rule that opens the sheet and carries its title, as the card's rule carries `Approval needed`: it also separates the sheet from the conversation above. */
function ruleLine(state: PermissionsSheetState, width: number): SheetLine {
  const title = clipLine(sheetTitle(state), Math.max(1, width - 4));
  const lead = `─ ${title} `;
  const text = `${lead}${'─'.repeat(Math.max(2, width - displayWidth(lead)))}`;
  return {
    kind: 'rule',
    text,
    spans: [
      { from: 0, to: 2, role: 'dim' },
      { from: 2, to: 2 + title.length, role: 'strong' },
      { from: 2 + title.length, to: text.length, role: 'dim' },
    ],
  };
}

/** The lines of the sheet when the terminal is below the floor: the title, why, and the way out. */
function tooSmallLines(state: PermissionsSheetState): readonly SheetLine[] {
  return [
    ruleLine(state, 52),
    { kind: 'text', text: 'Enlarge the terminal to use this screen — Esc closes.' },
    {
      kind: 'legend',
      text: legend(SHEET_LEGEND_EMPTY_ITEMS),
      spans: legendSpans(SHEET_LEGEND_EMPTY_ITEMS),
    },
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
 * §2): at most three fifths of the terminal, and never so many that fewer than eight transcript rows remain. The rule that carries the
 * title, the note, the message row and the legend are always drawn (the floor of 80×24 leaves room for all of them and at least eight body
 * lines) and the selected row is always visible; the body gets the rest, up to {@link SHEET_WINDOW} lines. Every line is clipped to the width.
 *
 * When body lines are hidden, the first or last body line is a marker that counts the ROWS it stands in for, the one under the marker
 * included, and only where a row is hidden; a heading is never left alone at the bottom of the window above a marker, and a window never
 * starts in the middle of a sentence.
 */
export function permissionsSheetLines(
  state: PermissionsSheetState,
  geometry: SheetGeometry,
): readonly SheetLine[] {
  if (!sheetCanArm(geometry)) return tooSmallLines(state);
  const width = usableColumns(geometry.columns);
  const room = cardRowBudget(geometry.terminalRows);
  const all = bodyLines(state, width);
  const height = Math.min(SHEET_WINDOW, room - FIXED_ROWS - NOTE_ROWS);
  const cursorLine = Math.max(
    0,
    all.findIndex((line) => line.entry === state.cursor),
  );
  // A marker is drawn only where a ROW is hidden, and stands in for the rows above or below it, the line it covers included. So a window is good
  // when the cursor is off a drawn marker, no heading is left alone above a `▼` marker or at the very bottom of a window that hides lines, and a
  // window that hides only headings and sentences above it starts on a heading or on a whole sentence: it moves to the nearest start that is.
  const rowsBefore = [0];
  for (const line of all)
    rowsBefore.push((rowsBefore.at(-1) ?? 0) + (line.entry === undefined ? 0 : 1));
  const rowsTotal = rowsBefore.at(-1) ?? 0;
  const good = (from: number, to: number): boolean => {
    const topMarker = (rowsBefore[from] ?? 0) > 0;
    const bottomMarker = rowsTotal - (rowsBefore[to] ?? rowsTotal) > 0;
    if (cursorLine < from + (topMarker ? 1 : 0) || cursorLine >= to - (bottomMarker ? 1 : 0))
      return false;
    if (!topMarker && from > 0) {
      const first = all[from];
      const clean =
        first?.kind === 'heading' || (first?.kind === 'text' && all[from - 1]?.kind === 'heading');
      if (!clean) return false;
    }
    if (
      bottomMarker
        ? all[to - 2]?.kind === 'heading'
        : to < all.length && all[to - 1]?.kind === 'heading'
    )
      return false;
    return true;
  };
  // The full window when a good one exists; else one line shorter, and so on (a shape whose only full windows strand a heading has a good
  // shorter one). The sheet keeps its height either way: a short window is padded with blank lines, so the rule does not move as the cursor does.
  let { start, end } = windowBody(all.length, cursorLine, height, good);
  for (
    let shorter = height - 1;
    shorter >= 3 && all.length > height && !good(start, end);
    shorter -= 1
  )
    ({ start, end } = windowBody(all.length, cursorLine, shorter, good));
  const topMarker = rowsIn(all.slice(0, start)) > 0;
  const bottomMarker = rowsIn(all.slice(end)) > 0;
  const body: SheetLine[] = all.slice(start, end).map((line) => {
    const text = clipLine(line.text, width);
    return {
      kind: line.kind,
      text,
      ...(line.spans === undefined ? {} : { spans: clampSpans(line.spans, text.length) }),
    };
  });
  if (topMarker && body.length > 0)
    body[0] = { kind: 'marker', text: `▲ ${String(rowsIn(all.slice(0, start + 1)))} more` };
  if (bottomMarker && body.length > 0)
    body[body.length - 1] = {
      kind: 'marker',
      text: `▼ ${String(rowsIn(all.slice(end - 1)))} more`,
    };
  // A windowed list keeps one height: a window that had to be shorter is padded below, so the sheet does not change size under the cursor.
  while (all.length > height && body.length < height) body.push({ kind: 'text', text: '' });
  const items = state.armed
    ? SHEET_LEGEND_ARMED_ITEMS
    : sheetEntries(state.snapshot).length > 0
      ? SHEET_LEGEND_IDLE_ITEMS
      : SHEET_LEGEND_EMPTY_ITEMS;
  const legendText = clipLine(legend(items), width);
  return [
    ruleLine(state, width),
    ...body,
    { kind: 'note', text: clipLine(sheetNote(state), width) },
    messageLine(state, width),
    {
      kind: 'legend',
      text: legendText,
      spans: clampSpans(legendSpans(items), legendText.length),
    },
  ];
}

/** What withdrawing the selected row will do, said before it is done: the row under the list while nothing else needs saying. */
function hintLine(entry: SheetEntry, width: number): SheetLine {
  const text =
    entry.kind === 'project'
      ? 'Press d to withdraw it: auto mode will ask about this command again.'
      : entry.row.alsoRemembered
        ? 'Press d to withdraw the session approval; the project still remembers it.'
        : 'Press d to withdraw it: this command will need approval again.';
  const shown = clipLine(text, width);
  // The key is the one thing on the line that is not dimmed: it is what the line is about.
  return {
    kind: 'hint',
    text: shown,
    spans: clampSpans(
      [
        { from: 0, to: 6, role: 'dim' },
        { from: 6, to: 7, role: 'danger' },
        { from: 7, to: shown.length, role: 'dim' },
      ],
      shown.length,
    ),
  };
}

/** The glyph a result carries, so a done and a failed answer differ without colour. */
const TONE_GLYPH = { done: '✓ ', failed: '✗ ', note: '' } as const;
const TONE_KIND = { done: 'done', failed: 'failed', note: 'notice' } as const;

/**
 * The message row: the question while a withdrawal waits, else the last result or note, else what withdrawing the selected row will do, else
 * blank. Always one row, so a state change moves nothing.
 */
function messageLine(state: PermissionsSheetState, width: number): SheetLine {
  const entry = sheetEntries(state.snapshot)[state.cursor];
  if (state.armed && entry !== undefined) {
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
  const message = state.message;
  if (message !== undefined)
    return {
      kind: TONE_KIND[message.tone],
      text: clipLine(`${TONE_GLYPH[message.tone]}${escaped(message.text)}`, width),
    };
  return entry === undefined ? { kind: 'message', text: '' } : hintLine(entry, width);
}
