import '../frames.js';

import type {
  PermissionsSnapshot,
  ProjectGrantRow,
  SessionApprovalRow,
} from '../../../../permissions/chat-permissions.js';
import { emptyEditor } from '../../chat-input.js';
import { helpSheetLines, HELP_TOO_SMALL } from '../../help-sheet.js';
import { layoutHomeNotice } from '../../home-notice.js';
import { keyLabel, legend, legendSpans, type LegendItem } from '../../legend.js';
import {
  foldPermissionsSheetKey,
  initialPermissionsSheetState,
  permissionsSheetLines,
  SHEET_CHIP_ARMED,
  SHEET_CHIP_IDLE,
  SHEET_ENTER_NOTE,
  SHEET_KEYS,
  SHEET_LEGEND_ARMED,
  SHEET_LEGEND_ARMED_ITEMS,
  SHEET_LEGEND_EMPTY,
  SHEET_LEGEND_EMPTY_ITEMS,
  SHEET_LEGEND_IDLE,
  SHEET_LEGEND_IDLE_ITEMS,
  SHEET_SETTLE_MS,
  SHEET_TOO_SMALL_TEXT,
  SHEET_TYPED_NOTE,
  SHEET_WAIT_NOTE,
  tooSmallSheetLines,
  type PermissionsSheetState,
  type PermissionsSheetStep,
} from '../../permissions-sheet.js';
import type { SheetGeometry, SheetLine } from '../../sheet-frame.js';
import { isHintShaped } from '../hint-shape.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';
import {
  permissionsContent,
  permissionsControls,
  permissionsSpec,
  PERMISSIONS_STEP,
  PERMISSIONS_UNREADABLE_CONTENT,
  withdrawLineContent,
  withdrawRefusedText,
} from '../../../../popups/permissions-popup.js';
import type { ChordRefusal } from '../../../../popups/popup-host.js';
import { openFrame, withContent, type PopupFrame } from '../../../../popups/popup-reducer.js';
import { frameRows } from './popups.js';

/**
 * The sheets' hint producers: the permissions sheet (its legend, its row chip, the sentences under the list) and the
 * help sheet's legends and the help sheet's key listing, and the Home's notice footer. Every string is recorded through the function that
 * builds it, at the sizes a legend's clipping can differ at.
 */

/** The two sizes a sheet is recorded at: the floor of 80×24, and a wider one (a line is never drawn wider than 100 columns). */
export const GEOMETRIES = [
  { name: 'cols=80', geometry: { columns: 80, terminalRows: 24 } },
  { name: 'cols=100', geometry: { columns: 100, terminalRows: 30 } },
] as const satisfies readonly NamedSize[];

/** A size a recorder draws at: a label of the form `key=value` and the geometry. */
export interface NamedSize {
  readonly name: string;
  readonly geometry: SheetGeometry;
}

/**
 * What `rows` draws at each of `sizes` (both of {@link GEOMETRIES} by default), as one state `<name> cols=80,100` when the sizes say the
 * same and as one state per size (`cols=80`, `cols=100`) when they do not, so a golden says where a size matters and does not repeat a
 * line where it does not.
 */
export function bySize(
  name: string,
  rows: (geometry: SheetGeometry) => readonly string[],
  sizes: readonly NamedSize[] = GEOMETRIES,
): StateRows {
  const drawn = sizes.map((size) => ({ size, rows: rows(size.geometry) }));
  const [first] = drawn;
  if (first === undefined) return {};
  const same = drawn.every(
    (candidate) =>
      candidate.rows.length === first.rows.length &&
      candidate.rows.every((row, index) => row === first.rows[index]),
  );
  if (same) {
    const [key] = first.size.name.split('=');
    const values = sizes.map((size) => size.name.split('=')[1] ?? '').join(',');
    return { [`${name} ${key ?? ''}=${values}`]: first.rows };
  }
  return Object.fromEntries(drawn.map((entry) => [`${name} ${entry.size.name}`, entry.rows]));
}

/** A size below the floor of 80×24 (the sheets draw their "enlarge" frame there). */
export const BELOW_FLOOR: SheetGeometry = { columns: 60, terminalRows: 20 };

/**
 * The kinds of line whose text is a hint, a footer or a message row whatever it says. Other kinds (a body row, a heading, a note, a text
 * line) are recorded only when they are hint-shaped, or where a recorder asks for the text lines.
 */
const FOOTER_KINDS: ReadonlySet<SheetLine['kind']> = new Set([
  'legend',
  'hint',
  'notice',
  'question',
]);

export interface FootOptions {
  /** Record the `text` lines of the foot as well: the sentence under a list that names a key. */
  readonly text?: boolean;
  /** How many of the last lines are the foot (the selected row's own sentence, the message row, the legend). */
  readonly last?: number;
  /** Only the lines of these kinds (a hint-shaped line of another kind is left out too): for a state that wants one sentence and the legend. */
  readonly kinds?: readonly SheetLine['kind'][];
}

/** The foot of a screen as drawn: the last lines that are a legend, a hint, a message or a sentence that names a key. */
export function footRows(lines: readonly SheetLine[], options: FootOptions = {}): string[] {
  const wanted = (line: SheetLine): boolean => {
    if (options.kinds !== undefined) return options.kinds.includes(line.kind);
    return (
      FOOTER_KINDS.has(line.kind) ||
      (options.text === true && line.kind === 'text') ||
      isHintShaped(line.text)
    );
  };
  return lines
    .slice(-(options.last ?? 3))
    .filter((line) => line.text !== '' && wanted(line))
    .map((line) => line.text);
}

/** Where a line's keys are and what role each takes: `[d / Del]=danger  Esc=strong`. A dimmed stretch (a verb, a separator) is left out. */
export function rolesOf(line: SheetLine | undefined): string {
  if (line === undefined) return '(no line)';
  return (line.spans ?? [])
    .filter((span) => span.role !== 'dim')
    .map((span) => `${line.text.slice(span.from, span.to)}=${span.role}`)
    .join('  ');
}

/** The first line of a kind, or `undefined`. */
export function lineOfKind(
  lines: readonly SheetLine[],
  kind: SheetLine['kind'],
): SheetLine | undefined {
  return lines.find((line) => line.kind === kind);
}

// ---- The permissions sheet ----------------------------------------------------------------------------------------------------

const T0 = 50_000;
const SETTLED = T0 + SHEET_SETTLE_MS + 600;
const ENTER = { return: true } as const;

const project = (
  id: string,
  text = 'npm, 1 argument',
  at = '2026-11-19 12:00Z',
): ProjectGrantRow => ({
  id,
  label: text,
  remembered: at,
});
const session = (text: string, alsoRemembered = false): SessionApprovalRow => ({
  argv: text.split(' '),
  text,
  alsoRemembered,
});

const snapshotOf = (
  projectRows: readonly ProjectGrantRow[],
  sessionRows: readonly SessionApprovalRow[] | undefined,
): PermissionsSnapshot => ({ project: { ok: true, rows: projectRows }, session: sessionRows });

/** Two remembered commands, then three session approvals: one plain, one a Remember also made, one plain. */
const FULL = snapshotOf(
  [project('a'), project('b', 'node, 1 argument')],
  [session('git status'), session('npm test', true)],
);

/** The Home's own sheet: the project's rows and no session section. */
const PROJECT_ONLY = snapshotOf([project('a'), project('b', 'node, 1 argument')], undefined);

const open = (
  snapshot: PermissionsSnapshot,
  surface: 'chat' | 'project',
  mode: PermissionsSheetState['mode'],
  cursor = 0,
): PermissionsSheetState => ({
  ...initialPermissionsSheetState(snapshot, surface, mode, T0),
  cursor,
});

const stateOf = (step: PermissionsSheetStep): PermissionsSheetState => {
  if (step.kind === 'close') throw new Error('expected a state, got close');
  return step.state;
};

/** The sheet with its question up on the selected row. */
const armed = (from: PermissionsSheetState): PermissionsSheetState =>
  stateOf(foldPermissionsSheetKey('d', {}, from, true, SETTLED));

/** The row (a selected row or an armed one) a sheet draws its action chip on. */
function chipRow(lines: readonly SheetLine[]): SheetLine | undefined {
  return lines.find((line) => line.kind === 'selected' || line.kind === 'armed');
}

/** One state of the sheet at both sizes: the chip row and the foot (the message row and the legend). */
function sheetStates(
  name: string,
  state: PermissionsSheetState,
  options: FootOptions = {},
): StateRows {
  return bySize(name, (geometry) => {
    const lines = permissionsSheetLines(state, geometry);
    const chip = chipRow(lines);
    return [...(chip === undefined ? [] : [chip.text]), ...footRows(lines, options)];
  });
}

/** The `text` lines of `lines` as the sentences they were wrapped from: consecutive text rows joined by a space, a heading or a rule ending one. */
export function paragraphs(lines: readonly SheetLine[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push(current.join(' '));
    current = [];
  };
  for (const line of lines) {
    if (line.kind === 'text' && line.text !== '') current.push(line.text.trim());
    else flush();
  }
  flush();
  return out;
}

/** An empty sheet at both sizes: the sentences of its body, and its legend. */
function emptyStates(name: string, state: PermissionsSheetState): StateRows {
  return bySize(name, (geometry) => {
    const lines = permissionsSheetLines(state, geometry);
    return [...paragraphs(lines), ...footRows(lines, { kinds: ['legend'], last: 1 })];
  });
}

/** One item as the legend writes it (`keys verb`): a key table's entry recorded by itself. */
const itemText = (item: LegendItem): string =>
  'keys' in item ? `${keyLabel(item.keys)} ${item.verb}` : item.text;

/** The legend constants, the row chips and the sentences the sheet's keys answer with, recorded through what builds them. */
const permissionsSheet: Recorder = () => {
  const out: Record<string, string | readonly string[]> = {
    'constant=SHEET_LEGEND_IDLE': SHEET_LEGEND_IDLE,
    'constant=SHEET_LEGEND_EMPTY': SHEET_LEGEND_EMPTY,
    'constant=SHEET_LEGEND_ARMED': SHEET_LEGEND_ARMED,
    'constant=SHEET_CHIP_IDLE': SHEET_CHIP_IDLE,
    'constant=SHEET_CHIP_ARMED': SHEET_CHIP_ARMED,
    'constant=SHEET_ENTER_NOTE': SHEET_ENTER_NOTE,
    'constant=SHEET_WAIT_NOTE': SHEET_WAIT_NOTE,
    'constant=SHEET_TYPED_NOTE': SHEET_TYPED_NOTE,
    'constant=SHEET_TOO_SMALL_TEXT': SHEET_TOO_SMALL_TEXT,
    'keys=withdraw confirm keep close alone': [
      itemText(SHEET_KEYS.withdraw),
      itemText(SHEET_KEYS.confirm),
      itemText(SHEET_KEYS.keep),
      itemText(SHEET_KEYS.close),
    ],
  };
  // The idle sheet: the hint under the list says what withdrawing the selected row does, by the row it is on.
  const idle = (surface: 'chat' | 'project', cursor: number): PermissionsSheetState =>
    open(surface === 'chat' ? FULL : PROJECT_ONLY, surface, 'ask', cursor);
  Object.assign(
    out,
    sheetStates(label({ state: 'idle', row: 'project', surface: 'chat' }), idle('chat', 0)),
    sheetStates(label({ state: 'idle', row: 'session', surface: 'chat' }), idle('chat', 2)),
    sheetStates(
      label({ state: 'idle', row: 'session also-remembered', surface: 'chat' }),
      idle('chat', 3),
    ),
    sheetStates(label({ state: 'idle', row: 'project', surface: 'project' }), idle('project', 0)),
    // The question: a withdrawal waits for its `Enter`; the legend names its two answers.
    sheetStates(label({ state: 'armed', row: 'project' }), armed(idle('chat', 0))),
    sheetStates(label({ state: 'armed', row: 'session' }), armed(idle('chat', 2))),
    // Nothing to select: the legend is only the way out, and the sentences in the body say how a row is made (each one as a sentence, not
    // as the rows the width wrapped it to).
    emptyStates(
      label({ state: 'empty', surface: 'chat', mode: 'ask' }),
      open(snapshotOf([], []), 'chat', 'ask'),
    ),
    emptyStates(
      label({ state: 'empty', surface: 'chat', mode: 'plan' }),
      open(snapshotOf([], []), 'chat', 'plan'),
    ),
    emptyStates(
      label({ state: 'empty', surface: 'project', mode: 'none' }),
      open(snapshotOf([], undefined), 'project', undefined),
    ),
  );
  // The notes a refused key leaves on the message row.
  const idleSheet = idle('chat', 0);
  const tooEarly = stateOf(foldPermissionsSheetKey('d', {}, idleSheet, true, T0 + 1));
  const typed = stateOf(foldPermissionsSheetKey('x', {}, idleSheet, true, SETTLED));
  const typedThenD = stateOf(foldPermissionsSheetKey('d', {}, typed, true, SETTLED));
  const askedAt = armed(idleSheet);
  const early = stateOf(foldPermissionsSheetKey('', ENTER, askedAt, true, SETTLED + 1));
  Object.assign(
    out,
    sheetStates(label({ state: 'note', key: 'd too early' }), tooEarly),
    sheetStates(label({ state: 'note', key: 'd after typing' }), typedThenD),
    sheetStates(label({ state: 'note', key: 'Enter too early' }), early),
  );
  // The frame below the floor: why, and the way out.
  for (const [name, state] of [
    ['chat ask', idleSheet],
    ['project', idle('project', 0)],
  ] as const) {
    out[label({ state: 'too-small', sheet: name })] = permissionsSheetLines(state, BELOW_FLOOR).map(
      (line) => line.text,
    );
  }
  out[label({ state: 'too-small', sheet: 'another sheet via tooSmallSheetLines' })] =
    tooSmallSheetLines('Agent · reviewer').map((line) => line.text);
  return out;
};

/** The roles the legend's keys take (the `[d / Del]` danger, the `[Enter]` warn), and the chip and hint keys on the rows. */
const permissionsSheetRoles: Recorder = () => {
  const out: Record<string, string> = {
    'legend=SHEET_LEGEND_IDLE_ITEMS': rolesOf({
      kind: 'legend',
      text: legend(SHEET_LEGEND_IDLE_ITEMS, SHEET_KEYS.close),
      spans: legendSpans(SHEET_LEGEND_IDLE_ITEMS, SHEET_KEYS.close),
    }),
    'legend=SHEET_LEGEND_EMPTY_ITEMS': rolesOf({
      kind: 'legend',
      text: legend(SHEET_LEGEND_EMPTY_ITEMS, SHEET_KEYS.close),
      spans: legendSpans(SHEET_LEGEND_EMPTY_ITEMS, SHEET_KEYS.close),
    }),
    'legend=SHEET_LEGEND_ARMED_ITEMS': rolesOf({
      kind: 'legend',
      text: legend(SHEET_LEGEND_ARMED_ITEMS, SHEET_KEYS.keep),
      spans: legendSpans(SHEET_LEGEND_ARMED_ITEMS, SHEET_KEYS.keep),
    }),
  };
  const geometry = GEOMETRIES[0].geometry;
  const idleLines = permissionsSheetLines(open(FULL, 'chat', 'ask'), geometry);
  const armedLines = permissionsSheetLines(armed(open(FULL, 'chat', 'ask')), geometry);
  out['state=idle chip row'] = rolesOf(chipRow(idleLines));
  out['state=idle hint row'] = rolesOf(lineOfKind(idleLines, 'hint'));
  out['state=idle legend'] = rolesOf(lineOfKind(idleLines, 'legend'));
  out['state=armed chip row'] = rolesOf(chipRow(armedLines));
  out['state=armed legend'] = rolesOf(lineOfKind(armedLines, 'legend'));
  out['state=empty legend'] = rolesOf(
    lineOfKind(permissionsSheetLines(open(snapshotOf([], []), 'chat', 'ask'), geometry), 'legend'),
  );
  return out;
};

// ---- The help sheet ----------------------------------------------------------------------------------------------------------

/** The rows of the `Keys of the Home` section: a key listing, one row to a key, down to the legend. */
function keyListing(lines: readonly SheetLine[]): string[] {
  const from = lines.findIndex(
    (line) => line.kind === 'heading' && line.text === 'Keys of the Home',
  );
  const to = lines.findIndex((line) => line.kind === 'legend');
  return from < 0 ? [] : lines.slice(from, to < 0 ? undefined : to).map((line) => line.text);
}

const helpSheet: Recorder = () => ({
  'constant=HELP_TOO_SMALL': HELP_TOO_SMALL,
  ...bySize('keys section', (geometry) => keyListing(helpSheetLines(geometry))),
  ...bySize('legend', (geometry) => footRows(helpSheetLines(geometry), { last: 1 })),
  'below the floor': helpSheetLines(BELOW_FLOOR).map((line) => line.text),
  'below the floor legend roles': rolesOf(lineOfKind(helpSheetLines(BELOW_FLOOR), 'legend')),
  'legend roles': rolesOf(lineOfKind(helpSheetLines(GEOMETRIES[0].geometry), 'legend')),
});

// ---- The Home's notice -------------------------------------------------------------------------------------------------------

const LONG_NOTICE = Array.from(
  { length: 60 },
  (_, index) =>
    `Diagnostic line ${String(index + 1)}: nothing is wrong, this only fills the notice.`,
).join('\n');

/** The paging footer under a notice that does not fit, on its first, a middle and its last page; and no footer for a notice that fits. */
const homeNotice: Recorder = () => {
  const base = {
    editor: emptyEditor(),
    cols: 80,
    rows: 24,
    showBanner: false,
    onLanding: false,
    hasSessions: false,
  } as const;
  const out: Record<string, string> = {};
  const fits = layoutHomeNotice({ ...base, notice: 'Config saved.' });
  out['notice=fits'] = fits?.footer ?? '(no footer)';
  for (const [name, page] of [
    ['first', 0],
    ['second', 1],
    ['last', Number.MAX_SAFE_INTEGER],
  ] as const) {
    const layout = layoutHomeNotice({ ...base, notice: LONG_NOTICE, page });
    out[label({ notice: 'overflows', page: name, cols: 80 })] = layout?.footer ?? '(no footer)';
  }
  const wide = layoutHomeNotice({ ...base, cols: 100, rows: 30, notice: LONG_NOTICE });
  out['notice=overflows page=first cols=100'] = wide?.footer ?? '(no footer)';
  const none = layoutHomeNotice({ ...base, notice: undefined });
  out['notice=none'] = none?.footer ?? '(no notice)';
  return out;
};

/**
 * The chat's `/permissions` popup (ADR-0137 §2 as a popup, MVP-11 step 5c): the legend row of its lists, of the withdrawal's line (a remembered
 * command and a long session approval), of nothing to withdraw and of lists that could not be read, drawn by the frame model at 80×24 with
 * colour off and on; and the sentence each refusal of the line says (`[d] asks again`, or after typing `↑/↓, then [d]`).
 */
const permissionsPopup: Recorder = () => {
  const full: PermissionsSnapshot = {
    project: {
      ok: true,
      rows: [
        { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
        { id: 'b', label: 'pnpm, 2 arguments', remembered: '2026-11-21 16:40Z' },
      ],
    },
    session: [
      {
        argv: ['pnpm'],
        text: `pnpm test ${'--filter @acme/billing '.repeat(12)}`,
        alsoRemembered: false,
      },
    ],
  };
  const empty: PermissionsSnapshot = { project: { ok: true, rows: [] }, session: [] };
  const lists = (snapshot: PermissionsSnapshot): PopupFrame =>
    openFrame(
      permissionsSpec('chat', permissionsContent(snapshot, 'ask'), permissionsControls(snapshot)),
      1,
    );
  const armed = (entry: Parameters<typeof withdrawLineContent>[0]): PopupFrame =>
    withContent(
      { ...lists(full), stepIndex: PERMISSIONS_STEP.withdraw },
      PERMISSIONS_STEP.withdraw,
      withdrawLineContent(entry),
    );
  const frames: readonly (readonly [string, PopupFrame])[] = [
    ['lists', lists(full)],
    [
      'armed-remembered',
      armed({
        kind: 'project',
        row: { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' },
      }),
    ],
    [
      'armed-session-long',
      armed({
        kind: 'session',
        row: full.session?.[0] ?? { argv: [], text: '', alsoRemembered: false },
      }),
    ],
    ['empty', lists(empty)],
    ['unreadable', openFrame(permissionsSpec('chat', PERMISSIONS_UNREADABLE_CONTENT, []), 1)],
  ];
  const out: Record<string, readonly string[] | string> = {};
  for (const [state, frame] of frames)
    for (const color of [false, true])
      out[label({ state, colour: color ? 'on' : 'off' })] = frameRows(frame, color)
        .map((line) => line.text.trim())
        .filter((text) => isHintShaped(text));
  for (const reason of ['unseen', 'early', 'expired', 'typed', 'cut'] satisfies ChordRefusal[])
    out[label({ refusal: reason })] = withdrawRefusedText(reason);
  return out;
};

export const SHEETS_PRODUCERS: readonly Producer[] = [
  {
    id: 'permissions-sheet',
    file: 'render/tui/permissions-sheet.ts',
    describe:
      'The /permissions sheet: its legend constants, the row chip `[d] withdraw` / `[Enter] withdraw`, the hint under the selected row, the question, the notes a refused `d` or `Enter` leaves, the empty-list sentences naming Ctrl+O, and the frame below the floor; by surface, row kind, armed and size.',
  },
  {
    id: 'permissions-sheet-roles',
    file: 'render/tui/permissions-sheet.ts',
    describe:
      'The roles the permissions sheet gives its keys: `[d / Del]` danger and `[Enter]` warn in the legend, the chip and the hint key on the rows, idle versus armed.',
  },
  {
    id: 'permissions-popup',
    file: 'popups/permissions-popup.ts',
    describe:
      'The chat’s /permissions popup: the legend of its lists (`[d] / Del withdraw (then Enter)`), of a withdrawal’s line answered by Enter (`Enter withdraw · Esc keep`), of nothing to withdraw and of lists that could not be read, colour off and on; and what each refusal of the line says.',
  },
  {
    id: 'help-sheet',
    file: 'render/tui/help-sheet.ts',
    describe:
      'The landing’s /help sheet: its legend, the hint below the floor and the whole `Keys of the Home` listing, at both sizes.',
  },
  {
    id: 'home-notice',
    file: 'render/tui/home-notice.ts',
    describe:
      'The footer of a Home notice that overflows its rows (`Notice N–M of K · PgUp/PgDn read`), by page and width, and the absence of one for a notice that fits.',
  },
];

export const SHEETS_RECORDERS = {
  'permissions-sheet': permissionsSheet,
  'permissions-sheet-roles': permissionsSheetRoles,
  'permissions-popup': permissionsPopup,
  'help-sheet': helpSheet,
  'home-notice': homeNotice,
} as const satisfies Readonly<Record<string, Recorder>>;
