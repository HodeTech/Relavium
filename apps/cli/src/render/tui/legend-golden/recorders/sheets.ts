import '../frames.js';

import type { PermissionsSnapshot } from '../../../../permissions/chat-permissions.js';
import { emptyEditor } from '../../chat-input.js';
import { layoutHomeNotice } from '../../home-notice.js';
import type { SheetGeometry, SheetLine } from '../../sheet-frame.js';
import { isHintShaped } from '../hint-shape.js';
import { label, type Producer, type Recorder, type StateRows } from '../golden.js';
import {
  emptyProjectText,
  EMPTY_SESSION_TEXT,
  grantNote,
  permissionsContent,
  permissionsControls,
  permissionsSpec,
  PERMISSIONS_STEP,
  PERMISSIONS_UNREADABLE_CONTENT,
  withdrawHint,
  withdrawLineContent,
  withdrawRefusedText,
} from '../../../../popups/permissions-popup.js';
import type { ChordRefusal } from '../../../../popups/popup-host.js';
import { openFrame, withContent, type PopupFrame } from '../../../../popups/popup-reducer.js';
import { frameRows } from './popups.js';

/**
 * The sheets' hint producers: the chat's `/permissions` popup (its legends, its lists' effect lines and empty sentences, what each refusal of
 * its line says) and the Home's notice footer, and the helpers the tab host's recorders share (`bySize`, `footRows`, `rolesOf`, `lineOfKind`).
 * Every string is recorded through the function that builds it, at the sizes a legend's clipping can differ at. (The permissions sheet, its
 * port and its view were deleted in review round 1 of MVP-11 unit 8, D-3: the popup is the one implementation, so its producers went with them.)
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
  // The sentences the lists say through their own builders: what withdrawing a row does (the highlighted row's effect, by the row's kind),
  // what an empty list says (by the chat's mode, and on the Home, which names a card), and the note on what a grant is worth in each mode.
  const remembered = { id: 'a', label: 'npm, 1 argument', remembered: '2026-11-20 09:12Z' };
  out[label({ effect: 'withdraw', row: 'project' })] = withdrawHint({
    kind: 'project',
    row: remembered,
  });
  out[label({ effect: 'withdraw', row: 'session' })] = withdrawHint({
    kind: 'session',
    row: { argv: ['git', 'status'], text: 'git status', alsoRemembered: false },
  });
  out[label({ effect: 'withdraw', row: 'session also-remembered' })] = withdrawHint({
    kind: 'session',
    row: { argv: ['npm', 'test'], text: 'npm test', alsoRemembered: true },
  });
  out[label({ empty: 'project', mode: 'ask' })] = emptyProjectText('ask');
  out[label({ empty: 'project', mode: 'plan' })] = emptyProjectText('plan');
  out[label({ empty: 'project', mode: 'none (the Home)' })] = emptyProjectText(undefined);
  out['empty=session'] = EMPTY_SESSION_TEXT;
  for (const mode of ['ask', 'accept-edits', 'auto', 'plan'] as const)
    out[label({ note: 'grant', mode })] = grantNote(mode);
  out[label({ note: 'grant', mode: 'none (the Home)' })] = grantNote(undefined);
  return out;
};

export const SHEETS_PRODUCERS: readonly Producer[] = [
  {
    id: 'permissions-popup',
    file: 'popups/permissions-popup.ts',
    describe:
      'The /permissions popup: the legend of its lists (`[d] / Del withdraw (then Enter)`), of a withdrawal’s line answered by Enter (`Enter withdraw · Esc keep`), of nothing to withdraw and of lists that could not be read, colour off and on; what each refusal of the line says; the effect of withdrawing each kind of row, the empty-list sentences (by mode, and the Home’s) and the note on what a grant is worth in each mode.',
  },
  {
    id: 'home-notice',
    file: 'render/tui/home-notice.ts',
    describe:
      'The footer of a Home notice that overflows its rows (`Notice N–M of K · PgUp/PgDn read`), by page and width, and the absence of one for a notice that fits.',
  },
];

export const SHEETS_RECORDERS = {
  'permissions-popup': permissionsPopup,
  'home-notice': homeNotice,
} as const satisfies Readonly<Record<string, Recorder>>;
