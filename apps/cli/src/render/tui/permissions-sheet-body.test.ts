import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import type {
  PermissionEntry,
  PermissionsSnapshot,
  ProjectGrantRow,
  SessionApprovalRow,
  WithdrawAnswer,
} from '../../permissions/chat-permissions.js';
import {
  permissionsSheetBody,
  permissionsSheetChrome,
  permissionsSheetLines,
  sheetBodyHeight,
  sheetCanArm as currentSheetCanArm,
  type PermissionsSheetState,
} from './permissions-sheet.js';
import {
  exitKey,
  legend,
  legendSpans,
  type LegendExit,
  type LegendItem,
  type LegendKey,
} from './legend.js';
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
 * The `/permissions` sheet split into a body and a chrome (ADR-0140 §3; MVP-8 step 4): the body is the rows and the selection with no
 * frame, the chrome is the rule, the note, the message row and the legend, and the sheet is the two composed. The split must not change a
 * byte of what the chat's docked sheet draws, so the whole rendering as it was BEFORE the split is kept below as an oracle, and every
 * seeded state, width and height is drawn through both and compared line by line, span by span.
 *
 * The oracle is a copy, not an import: it is the file's rendering at the commit before the split (`53abf28b`), with its own constants, so
 * a constant the new module changes cannot move the oracle with it. It shares only the frame helpers (`sheet-frame`, `legend`, the card's
 * row budget, the review escape and `viewport`), which the split does not touch. Its words follow the surface language (ADR-0145 §3,
 * MVP-11 Step 3: `[d] / Del withdraw`, `Enter withdraw`, a key named in a sentence by the bracket rule) so that the layout stays the one thing
 * it compares.
 */

type SheetEntry = PermissionEntry;
type SheetMessage = WithdrawAnswer;

// ---- The oracle: the sheet's rendering before the split -------------------------------------------------------------------

const SHEET_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  withdraw: { keys: ['d', 'Del'], verb: 'withdraw', role: 'danger' },
  confirm: { keys: 'Enter', verb: 'withdraw', role: 'warn' },
  keep: exitKey.step('Esc', 'keep'),
  close: exitKey.close(['Esc', 'Ctrl+C']),
} as const satisfies Readonly<Record<string, LegendKey>>;

const SHEET_LEGEND_IDLE_ITEMS: readonly LegendItem[] = [SHEET_KEYS.select, SHEET_KEYS.withdraw];
const SHEET_LEGEND_EMPTY_ITEMS: readonly LegendItem[] = [];
const SHEET_LEGEND_ARMED_ITEMS: readonly LegendItem[] = [SHEET_KEYS.confirm];

const SHEET_CHIP_IDLE = '[d] withdraw';
const SHEET_CHIP_ARMED = 'Enter withdraw';

const SHEET_WINDOW = 8;
/** Below this the sheet does not promise a readable frame: ADR-0122 §7.3's floor. */
const SHEET_MIN_COLUMNS = 80;
const SHEET_MIN_ROWS = 24;
/** The rows the sheet always draws: the rule that carries the title, the message row and the legend; and the note under the body. */
const FIXED_ROWS = 3;
const NOTE_ROWS = 1;
/** The column the row's marker takes, and the gap between a row's value and its action. */
const MARKER = '› ';
const NO_MARKER = '  ';
const CHIP_GAP = '   ';

/** The selectable rows, in the order they are drawn: the project's, then the session's. */
function sheetEntries(snapshot: PermissionsSnapshot): readonly SheetEntry[] {
  const entries: SheetEntry[] = [];
  if (snapshot.project.ok)
    for (const row of snapshot.project.rows) entries.push({ kind: 'project', row });
  for (const row of snapshot.session ?? []) entries.push({ kind: 'session', row });
  return entries;
}

function sheetTitle(state: PermissionsSheetState): string {
  return state.mode === undefined || state.surface === 'project'
    ? 'Permissions · this project'
    : `Permissions · ${state.mode} mode`;
}

/** The one-row note on what a grant is worth ([ADR-0118](../../../../../docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) §1). */
function sheetNote(state: PermissionsSheetState): string {
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
    return 'Nothing is remembered for this project. A command is remembered from its card in a chat ([Ctrl+O], then Enter).';
  return state.mode === 'plan'
    ? 'Nothing is remembered for this project.'
    : 'Nothing is remembered for this project. Press [Ctrl+O] on a command card, then Enter, to remember one.';
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
 * `Enter withdraw` while its question is up) with the key in its role. A row too narrow for the right-hand side keeps the label alone.
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
  const chip = rowChip(selected, armed);
  const right = rowRight(chip, tail);
  const text = flushRow(`${selected ? MARKER : NO_MARKER}${label}`, right, width);
  return {
    kind: rowKind(selected, armed),
    text,
    spans: rowSpans(text, right, chip, tail, armed),
    entry,
  };
}

/** The action chip a row carries: none unless it is the selected one, then `[d] withdraw` or, while its question is up, `Enter withdraw`. */
function rowChip(selected: boolean, armed: boolean): string {
  if (!selected) return '';
  return armed ? SHEET_CHIP_ARMED : SHEET_CHIP_IDLE;
}

/** The right-hand side of a row: the chip and the value, the one that exists, or both with a gap. */
function rowRight(chip: string, tail: string): string {
  if (chip === '') return tail;
  return tail === '' ? chip : `${chip}${CHIP_GAP}${tail}`;
}

/** How a row is drawn: armed (its question is up), selected, or as any other row. */
function rowKind(selected: boolean, armed: boolean): SheetLineKind {
  if (armed) return 'armed';
  return selected ? 'selected' : 'row';
}

/** The coloured spans of a row: the chip's key in its role, the value dimmed; none when the row was too narrow for the right-hand side. */
function rowSpans(
  text: string,
  right: string,
  chip: string,
  tail: string,
  armed: boolean,
): SheetSpan[] {
  const spans: SheetSpan[] = [];
  if (right === '' || !text.endsWith(right)) return spans;
  const at = text.length - right.length;
  if (chip !== '')
    spans.push({
      from: at,
      to: at + (chip.startsWith('[') ? chip.indexOf(']') + 1 : chip.indexOf(' ')),
      role: armed ? 'warn' : 'danger',
    });
  if (tail !== '') {
    const tailAt = at + (chip === '' ? 0 : chip.length + CHIP_GAP.length);
    spans.push({ from: tailAt, to: tailAt + tail.length, role: 'dim' });
  }
  return spans;
}

/** The whole body, before it is windowed: the headings, the rows, and the empty or failure text of a section. */
function bodyLines(state: PermissionsSheetState, width: number): readonly BodyLine[] {
  const { project, session } = state.snapshot;
  const lines = projectLines(state, width);
  if (session !== undefined)
    lines.push(...sessionLines(state, session, project.ok ? project.rows.length : 0, width));
  return lines;
}

/** The project section: its heading, then its rows or the empty text, or the failure text of a store that could not be read. */
function projectLines(state: PermissionsSheetState, width: number): BodyLine[] {
  const { project } = state.snapshot;
  const lines: BodyLine[] = [];
  if (!project.ok) {
    lines.push({ kind: 'heading', text: 'This project · remembered' });
    for (const text of wrapWords(project.text, width))
      lines.push({ kind: 'text', text: text.trimEnd() });
    return lines;
  }
  lines.push({
    kind: 'heading',
    text: `This project · remembered (${String(project.rows.length)})`,
  });
  if (project.rows.length === 0) {
    for (const text of wrapWords(emptyProjectText(state), width))
      lines.push({ kind: 'text', text: text.trim() });
  }
  project.rows.forEach((item, entry) => {
    lines.push(rowLine(escaped(item.label), escaped(item.remembered), entry, state, width));
  });
  return lines;
}

/** The session section: its heading, then its rows (numbered after the project's) or the empty text. */
function sessionLines(
  state: PermissionsSheetState,
  session: readonly SessionApprovalRow[],
  firstEntry: number,
  width: number,
): BodyLine[] {
  const lines: BodyLine[] = [
    { kind: 'heading', text: `This session · approved (${String(session.length)})` },
  ];
  if (session.length === 0) lines.push({ kind: 'text', text: EMPTY_SESSION_TEXT });
  session.forEach((item, at) => {
    lines.push(
      rowLine(
        escaped(item.text),
        item.alsoRemembered ? '(also remembered)' : '',
        firstEntry + at,
        state,
        width,
      ),
    );
  });
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
    { kind: 'text', text: 'Enlarge the terminal to use this screen.' },
    {
      kind: 'legend',
      text: legend(SHEET_LEGEND_EMPTY_ITEMS, SHEET_KEYS.close),
      spans: legendSpans(SHEET_LEGEND_EMPTY_ITEMS, SHEET_KEYS.close),
    },
  ];
}

/** Whether the sheet's frame can show a withdrawal's question: the terminal is at least 80×24. */
function sheetCanArm(geometry: SheetGeometry): boolean {
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
function legacyPermissionsSheetLines(
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
  const { items, exit } = legendOf(state);
  const legendText = clipLine(legend(items, exit), width);
  return [
    ruleLine(state, width),
    ...body,
    { kind: 'note', text: clipLine(sheetNote(state), width) },
    messageLine(state, width),
    {
      kind: 'legend',
      text: legendText,
      spans: clampSpans(legendSpans(items, exit), legendText.length),
    },
  ];
}

/** The legend: the armed question's (its `Esc` keeps the permission), or the idle list's, or the empty list's. */
function legendOf(state: PermissionsSheetState): {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
} {
  if (state.armed) return { items: SHEET_LEGEND_ARMED_ITEMS, exit: SHEET_KEYS.keep };
  return {
    items:
      sheetEntries(state.snapshot).length > 0 ? SHEET_LEGEND_IDLE_ITEMS : SHEET_LEGEND_EMPTY_ITEMS,
    exit: SHEET_KEYS.close,
  };
}

/** What withdrawing the entry would mean, in one sentence. */
function withdrawHint(entry: SheetEntry): string {
  if (entry.kind === 'project')
    return 'Press [d] to withdraw it: auto mode will ask about this command again.';
  return entry.row.alsoRemembered
    ? 'Press [d] to withdraw the session approval; the project still remembers it.'
    : 'Press [d] to withdraw it: this command will need approval again.';
}

/** What withdrawing the selected row will do, said before it is done: the row under the list while nothing else needs saying. */
function hintLine(entry: SheetEntry, width: number): SheetLine {
  const shown = clipLine(withdrawHint(entry), width);
  // The key is the one thing on the line that is not dimmed: it is what the line is about.
  return {
    kind: 'hint',
    text: shown,
    spans: clampSpans(
      [
        { from: 0, to: 6, role: 'dim' },
        { from: 6, to: 9, role: 'danger' },
        { from: 9, to: shown.length, role: 'dim' },
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

// ---- end of the oracle ------------------------------------------------------------------------------------------------------

// ---- The states, seeded ---------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so the same states are drawn on every run and every machine. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = () => number;
type NonEmpty<T> = readonly [T, ...T[]];
const pick = <T>(rng: Rng, items: NonEmpty<T>): T =>
  items[Math.floor(rng() * items.length)] ?? items[0];
const between = (rng: Rng, low: number, high: number): number =>
  low + Math.floor(rng() * (high - low + 1));

/** Built here because the characters themselves must not sit in a source file. */
const RLO = String.fromCharCode(0x202e);
const ESC = String.fromCharCode(0x1b);

const LABELS: NonEmpty<string> = [
  'npm, 1 argument',
  'git status',
  'node, 2 arguments',
  'pnpm turbo run lint typecheck test --filter=@relavium/cli --concurrency=4 --output-logs=errors-only --continue',
  `rm${RLO}-rf build`,
  'tab\there and a <tag> and a line\nbreak',
  `esc${ESC}[31mred`,
  '日本語のコマンド　とても長い名前のコマンドの引数が続きます',
  '🙂 emoji command with a 👩‍💻 sequence',
  'x',
  '',
];
const DATES: NonEmpty<string> = [
  '2026-11-19 12:00Z',
  '2026-01-02 03:04Z',
  '',
  'a very long remembered text',
];
const NOTES: NonEmpty<SheetMessage | undefined> = [
  undefined,
  undefined,
  { tone: 'done', text: 'Withdrawn.' },
  {
    tone: 'failed',
    text: 'Could not withdraw: the store is read-only right now, so nothing changed.',
  },
  { tone: 'note', text: `Typed keys are ignored here ${RLO}and so on` },
  { tone: 'note', text: 'n'.repeat(300) },
];
const FAILURES: NonEmpty<string> = [
  'The remembered commands could not be read.',
  'The remembered commands could not be read because the project database is locked by another process, and waiting did not help.',
];
const MODES: NonEmpty<PermissionsSheetState['mode']> = [
  undefined,
  'ask',
  'plan',
  'auto',
  'accept-edits',
];

function randomSnapshot(rng: Rng): PermissionsSnapshot {
  const rows = (count: number): ProjectGrantRow[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `id-${String(index)}`,
      label: pick(rng, LABELS),
      remembered: pick(rng, DATES),
    }));
  const sessionRows = (count: number): SessionApprovalRow[] =>
    Array.from({ length: count }, () => {
      const text = pick(rng, LABELS);
      return { argv: text.split(' '), text, alsoRemembered: rng() < 0.4 };
    });
  const failed = rng() < 0.12;
  const project: PermissionsSnapshot['project'] = failed
    ? { ok: false, text: pick(rng, FAILURES) }
    : { ok: true, rows: rows(rng() < 0.2 ? 0 : between(rng, 1, 18)) };
  const session = rng() < 0.25 ? undefined : sessionRows(rng() < 0.2 ? 0 : between(rng, 1, 12));
  return { project, session };
}

function entryCount(snapshot: PermissionsSnapshot): number {
  const own = snapshot.project.ok ? snapshot.project.rows.length : 0;
  return own + (snapshot.session?.length ?? 0);
}

function randomState(rng: Rng): PermissionsSheetState {
  const snapshot = randomSnapshot(rng);
  const count = entryCount(snapshot);
  return {
    surface: rng() < 0.3 ? 'project' : 'chat',
    mode: pick(rng, MODES),
    snapshot,
    cursor: count === 0 ? 0 : between(rng, 0, count - 1),
    armed: count > 0 && rng() < 0.3,
    message: pick(rng, NOTES),
    openedAt: 0,
    armedAt: 0,
    typed: rng() < 0.5,
  };
}

const COLUMNS = [1, 20, 60, 79, 80, 81, 100, 101, 102, 240] as const;
const TERMINAL_ROWS = [6, 10, 23, 24, 25, 30, 50, 90] as const;
const SEEDED_STATES = 160;

const everyGeometry = (): SheetGeometry[] =>
  COLUMNS.flatMap((columns) => TERMINAL_ROWS.map((terminalRows) => ({ columns, terminalRows })));

/**
 * Whether two drawn frames are the same down to the byte: equal under Node's strict deep equality (which sees an `undefined` property, a
 * missing one, a different prototype or a hole) and equal as JSON text (which sees the order of the keys). The comparison is made 12,800
 * times, so a mismatch is collected, not asserted: one `expect` per frame would cost most of the test.
 */
const sameBytes = (actual: readonly SheetLine[], expected: readonly SheetLine[]): boolean =>
  isDeepStrictEqual(actual, expected) && JSON.stringify(actual) === JSON.stringify(expected);

const isRowKind = (kind: SheetLineKind): boolean =>
  kind === 'row' || kind === 'selected' || kind === 'armed';

describe('the sheet draws exactly what it drew before the split (ADR-0140 §3)', () => {
  it('draws the same lines, spans and kinds as the oracle for every seeded state, width and height', () => {
    const rng = seeded(20_261_123);
    const seen = {
      states: 0,
      drawn: 0,
      tooSmall: 0,
      top: 0,
      bottom: 0,
      both: 0,
      padded: 0,
      armed: 0,
      failed: 0,
    };
    const differing: { state: number; geometry: string; actual: unknown; expected: unknown }[] = [];
    for (let at = 0; at < SEEDED_STATES; at += 1) {
      const state = randomState(rng);
      seen.states += 1;
      for (const geometry of everyGeometry()) {
        const expected = legacyPermissionsSheetLines(state, geometry);
        const actual = permissionsSheetLines(state, geometry);
        if (!sameBytes(actual, expected))
          differing.push({
            state: at,
            geometry: `${geometry.columns}x${geometry.terminalRows}`,
            actual,
            expected,
          });
        seen.drawn += 1;
        if (!sheetCanArm(geometry)) {
          seen.tooSmall += 1;
          continue;
        }
        const markers = expected.filter((line) => line.kind === 'marker');
        if (markers.some((line) => line.text.startsWith('▲'))) seen.top += 1;
        if (markers.some((line) => line.text.startsWith('▼'))) seen.bottom += 1;
        if (markers.length === 2) seen.both += 1;
        if (expected.some((line) => line.kind === 'text' && line.text === '')) seen.padded += 1;
        if (expected.some((line) => line.kind === 'armed')) seen.armed += 1;
        if (!state.snapshot.project.ok) seen.failed += 1;
      }
    }
    // Not one frame differs (the first that does is shown, with its state number and size).
    expect(differing.slice(0, 1)).toEqual([]);
    // The sample is not hollow: it drew the below-floor frame, windows with a marker at the top, at the bottom and at both ends, a padded
    // short window, an armed row and a failed project list; and it drew `states × 80` frames, none of them skipped.
    expect(seen.drawn).toBe(SEEDED_STATES * COLUMNS.length * TERMINAL_ROWS.length);
    expect(seen.drawn).toBe(12_800);
    for (const [name, count] of Object.entries(seen))
      expect([name, count > 0]).toEqual([name, true]);
    // 12,800 frames through two renderers; a loaded machine gets a long deadline, because the count above, not the clock, is the claim.
  }, 60_000);

  it('draws the same lines for every cursor of the shapes that window, armed and not, at three sizes', () => {
    const shapes = [
      [0, 0],
      [0, 3],
      [3, 0],
      [7, 2],
      [9, 0],
      [12, 5],
      [20, 10],
    ] as const;
    const geometries: SheetGeometry[] = [
      { columns: 80, terminalRows: 24 },
      { columns: 79, terminalRows: 24 },
      { columns: 120, terminalRows: 50 },
    ];
    let compared = 0;
    for (const [projectCount, sessionCount] of shapes) {
      const snapshot: PermissionsSnapshot = {
        project: {
          ok: true,
          rows: Array.from({ length: projectCount }, (_, index) => ({
            id: `p${String(index)}`,
            label: `program-${String(index)}, ${String(index)} arguments`,
            remembered: '2026-11-19 12:00Z',
          })),
        },
        session: Array.from({ length: sessionCount }, (_, index) => ({
          argv: ['git', String(index)],
          text: `git ${String(index)}`,
          alsoRemembered: index % 2 === 0,
        })),
      };
      for (let cursor = 0; cursor < Math.max(1, projectCount + sessionCount); cursor += 1) {
        for (const armed of [false, true]) {
          const state: PermissionsSheetState = {
            surface: 'chat',
            mode: 'auto',
            snapshot,
            cursor,
            armed: armed && projectCount + sessionCount > 0,
            message: undefined,
            openedAt: 0,
            armedAt: 0,
            typed: false,
          };
          for (const geometry of geometries) {
            expect(permissionsSheetLines(state, geometry)).toStrictEqual(
              legacyPermissionsSheetLines(state, geometry),
            );
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(
      shapes.reduce((sum, [p, s]) => sum + Math.max(1, p + s) * 2 * geometries.length, 0),
    );
    expect(compared).toBeGreaterThan(300);
  });
});

describe('the body and the chrome compose to the sheet', () => {
  it('is the chrome’s head, the body at the chrome’s width and height, then the chrome’s foot, for every state at or above the floor', () => {
    const rng = seeded(7_654_321);
    let composed = 0;
    const differing: string[] = [];
    for (let at = 0; at < 80; at += 1) {
      const state = randomState(rng);
      for (const geometry of everyGeometry()) {
        if (!currentSheetCanArm(geometry)) continue;
        const chrome = permissionsSheetChrome(state, geometry);
        const body = permissionsSheetBody(state, chrome.bodyWidth, chrome.bodyHeight);
        const old = legacyPermissionsSheetLines(state, geometry);
        if (!sameBytes([...chrome.head, ...body, ...chrome.foot], old))
          differing.push(`${at} ${geometry.columns}x${geometry.terminalRows} composed`);
        // The body is exactly what the old frame had between its rule and its note.
        if (!sameBytes(body, old.slice(chrome.head.length, old.length - chrome.foot.length)))
          differing.push(`${at} ${geometry.columns}x${geometry.terminalRows} body`);
        composed += 1;
      }
    }
    expect(differing.slice(0, 3)).toEqual([]);
    expect(composed).toBeGreaterThan(2_000);
  }, 60_000);

  it('gives the chrome the sheet’s geometry: one rule, then a note, a message row and a legend, in the card’s budget', () => {
    const state = randomState(seeded(11));
    const chrome = permissionsSheetChrome(state, { columns: 80, terminalRows: 24 });
    expect(chrome.head.map((line) => line.kind)).toEqual(['rule']);
    expect(chrome.foot.map((line) => line.kind)).toHaveLength(3);
    expect(chrome.foot[0]?.kind).toBe('note');
    expect(chrome.foot[2]?.kind).toBe('legend');
    expect(chrome.bodyWidth).toBe(usableColumns(80));
    // Eight body lines at the 80×24 floor, and never more than the card's budget leaves after the four rows the chrome takes.
    expect(chrome.bodyHeight).toBe(8);
    for (const terminalRows of [24, 25, 30, 50, 90]) {
      expect(sheetBodyHeight({ columns: 80, terminalRows })).toBe(
        Math.min(8, cardRowBudget(terminalRows) - 4),
      );
    }
  });

  it('draws no frame in the body: only headings, rows, texts and markers, never more lines than it was given', () => {
    const rng = seeded(99);
    const frame: readonly SheetLineKind[] = [
      'rule',
      'note',
      'hint',
      'message',
      'done',
      'failed',
      'notice',
      'question',
      'legend',
    ];
    for (let at = 0; at < 120; at += 1) {
      const state = randomState(rng);
      for (const [width, height] of [
        [78, 8],
        [40, 5],
        [98, 12],
        [20, 3],
      ] as const) {
        const body = permissionsSheetBody(state, width, height);
        expect(body.length).toBeLessThanOrEqual(height);
        for (const line of body) expect(frame).not.toContain(line.kind);
        for (const line of body) expect(displayWidth(line.text)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('counts the rows a window hides: the rows shown and the two markers add up to every row, at any height', () => {
    // 20 remembered and 10 approved: 30 rows. At every cursor and every height the body can be given, the rows drawn plus the rows the top
    // marker stands in for (the covered line included) plus the rows the bottom marker stands in for are exactly the rows there are.
    const snapshot: PermissionsSnapshot = {
      project: {
        ok: true,
        rows: Array.from({ length: 20 }, (_, index) => ({
          id: `p${String(index)}`,
          label: `program-${String(index)}`,
          remembered: '2026-11-19 12:00Z',
        })),
      },
      session: Array.from({ length: 10 }, (_, index) => ({
        argv: ['git', String(index)],
        text: `git ${String(index)}`,
        alsoRemembered: false,
      })),
    };
    let withTop = 0;
    let withBottom = 0;
    for (const height of [5, 6, 7, 8, 9, 12]) {
      for (let cursor = 0; cursor < 30; cursor += 1) {
        const state: PermissionsSheetState = {
          surface: 'chat',
          mode: 'ask',
          snapshot,
          cursor,
          armed: false,
          message: undefined,
          openedAt: 0,
          armedAt: 0,
          typed: false,
        };
        const body = permissionsSheetBody(state, 78, height);
        const top = /^▲ (\d+) more$/u.exec(body[0]?.text ?? '');
        const bottom = /^▼ (\d+) more$/u.exec(body.at(-1)?.text ?? '');
        const shown = body.filter((line) => isRowKind(line.kind)).length;
        expect(shown + Number(top?.[1] ?? 0) + Number(bottom?.[1] ?? 0)).toBe(30);
        if (top !== null) withTop += 1;
        if (bottom !== null) withBottom += 1;
        // The selected row is always one of the rows drawn.
        expect(body.filter((line) => line.kind === 'selected')).toHaveLength(1);
      }
    }
    expect(withTop).toBeGreaterThan(50);
    expect(withBottom).toBeGreaterThan(50);
  });
});
