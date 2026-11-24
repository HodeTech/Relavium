import type { DefinedModel, DefinedRow } from '../../history/defined-model.js';
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
import {
  PIN_KEY,
  PIN_UNAVAILABLE,
  pinFullMessage,
  toggleWorkflowPin,
  type PinPort,
  type PinsStored,
} from './tab-host-pin.js';

/**
 * The Defined tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): the project's workflows and their pins as a list, with the keys that act on a row. PURE, like `tab-host.ts` it is
 * drawn into: it holds no port call, no clock and no React. The host reads the catalog and the pins (a {@link DefinedPort}) when the tab is
 * entered and carries a `run` or `export` request out; this module only says which request a key makes, or why it makes none.
 *
 * - **A pin of another project is a row.** The store caps the pins in total, so a workflow pin keyed by another project (or by one that is
 *   gone) is listed after this project's pins, marked `? other project`; it can be neither run nor exported, and `p` removes it by its row.
 *   A pin refused at the cap names how many pins the store holds and how many of them are elsewhere.
 * - **Keys.** `↑`/`↓` move and stop at the ends. `r` asks to run the row's workflow and `x` to export it (the host opens the launch flow
 *   and the export card; neither does anything by itself). `p` pins the row's workflow, or unpins it (the tab host carries the toggle out
 *   through its pin port and reads the list again, see {@link pinOnDefined}; pinned rows sort first, so the cursor follows the row to
 *   its new place). `Enter` opens no detail yet ({@link DEFINED_NO_DETAIL}): ADR-0140 §2 promises a workflow detail page (description,
 *   declared inputs, the three latest runs) that the catalog entry this tab holds does not carry, so the key SAYS so, on the row it was
 *   pressed on, instead of doing nothing and leaving it to look like a dead key. Every other key is nothing. A key that follows a
 *   message drops it.
 * - **A row names its entry by index, not by its slug.** {@link DefinedRow.slug} is a label (a pin's ref comes from `history.db`, which
 *   accepts any string); the slug a request carries is what {@link DefinedRead.slugOf} returns for the row's `entryIndex`, which only a
 *   catalog row has. A pin whose workflow left the catalog, and a file that did not parse, make no request and say why in their note,
 *   so a crafted ref such as `../../x` is a line of text and never a key, a path or a request.
 * - **Every state has a word as well as a glyph**: `✗ invalid`, `? not in catalog`, the last run's glyph and status, `★ pinned` and
 *   `· unpinned`; colour only repeats what the words say.
 */

/** What the host reads when the tab is entered: the rows, and the slug each catalog row stands for. */
export interface DefinedRead {
  readonly model: DefinedModel;
  /** The slug of the catalog entry a row's `entryIndex` names, or `undefined` when no entry sits at that index. */
  readonly slugOf: (entryIndex: number) => string | undefined;
  /**
   * The catalog path of that same entry, as the catalog read it (the raw path, not the row's sanitized label), or `undefined` when no entry
   * sits there. A `run` request carries it, so the launch can refuse when the file that holds the slug is no longer this one.
   */
  readonly pathOf: (entryIndex: number) => string | undefined;
  /**
   * What the pin store holds in total, read with the rows: the store caps pins across every project and both kinds, and the tab lists
   * only workflow pins, so a pin refused at the cap names these counts. Absent when the read does not know them.
   */
  readonly stored?: PinsStored | undefined;
}

/** The Defined tab's read, behind a port so the tab is testable without a project or a database. May throw: the tab then says it cannot list. */
export interface DefinedPort {
  readonly read: () => DefinedRead;
}

/** The Defined tab as it stands: what was read, where the cursor is, and what the last key had to say. */
export interface DefinedTabState {
  readonly read: DefinedRead;
  /** The selected row; `0` when the list is empty. */
  readonly cursor: number;
  /** One sentence the last key (or the run or export it asked for) left; the next key drops it. */
  readonly message?: string | undefined;
}

/**
 * What a key does on the tab: become another state, ask the host for a run or an export of one catalog workflow, or ask the tab host to
 * toggle the pin of a row (`pin`: it never leaves the tab host, which carries it out through its pin port and answers with a state).
 */
export type DefinedStep =
  | { readonly kind: 'state'; readonly state: DefinedTabState }
  | {
      readonly kind: 'run';
      readonly slug: string;
      /** The catalog path the row was listed from: the launch refuses a slug whose file is another one by the time `r` is pressed. */
      readonly path: string;
      readonly state: DefinedTabState;
    }
  | { readonly kind: 'export'; readonly slug: string; readonly state: DefinedTabState }
  | { readonly kind: 'pin'; readonly row: DefinedRow; readonly state: DefinedTabState };

/** The keys the Defined tab's legend names that are its own. The test presses every one of them. */
export const DEFINED_KEYS = {
  select: { keys: '↑/↓', verb: 'select' },
  run: { keys: '[r]', verb: 'run' },
  export: { keys: '[x]', verb: 'export' },
  pin: PIN_KEY,
} as const satisfies Readonly<Record<string, LegendItem>>;

/** What the tab says when the project has no workflow to list. */
export const DEFINED_EMPTY =
  'No workflows in this project. Add one under .relavium/workflows (see /init).';
/** What the tab says when its port cannot be read, or the Home has none. */
export const DEFINED_UNREADABLE = 'The workflows of this project could not be listed.';
/** What `Enter` says on a row: the workflow detail of ADR-0140 §2 is not built, and these are the keys that are. */
export const DEFINED_NO_DETAIL = 'No workflow detail yet. r runs it, x exports it, p pins it.';

/** The tab opened on `read`, the cursor where it was (kept inside the rows there are now). */
export function openDefinedTab(read: DefinedRead, cursor: number): DefinedTabState {
  const last = read.model.rows.length - 1;
  return { read, cursor: Math.max(0, Math.min(cursor, last)) };
}

/** `state` with a sentence the next key will drop. */
export function withDefinedMessage(state: DefinedTabState, message: string): DefinedTabState {
  return { ...state, message };
}

/** Why a row makes no request, in one sentence: its own note says what it is, and this says what it cannot do. */
function refusal(verb: 'run' | 'export' | 'pin', row: DefinedRow): string {
  const why =
    row.state === 'not-in-catalog'
      ? 'it is not in the catalog'
      : (row.note ?? 'its file could not be read');
  return `Cannot ${verb} ${row.slug}: ${why}.`;
}

/** The sentence for an entry that is not at its index any more. */
const goneFromCatalog = (verb: 'run' | 'export', row: DefinedRow): string =>
  `Cannot ${verb} ${row.slug}: it is not in the catalog any more.`;

/**
 * The slug (and the catalog path, which only `r` needs) a request for this row carries, or the sentence that says why there is none. Only a
 * row that parsed, and whose entry is still at its index, has one; nothing is ever derived from the row's label.
 */
function requestSlug(
  verb: 'run' | 'export',
  state: DefinedTabState,
  row: DefinedRow,
): { readonly slug: string; readonly path: string | undefined } | { readonly message: string } {
  if (row.state !== 'ready' || row.entryIndex === undefined) return { message: refusal(verb, row) };
  const slug = state.read.slugOf(row.entryIndex);
  if (slug === undefined) return { message: goneFromCatalog(verb, row) };
  return { slug, path: state.read.pathOf(row.entryIndex) };
}

/** `r` (run) and `x` (export) on a row: the request, or the sentence that says why the row makes none. */
function requestFor(
  verb: 'run' | 'export',
  state: DefinedTabState,
  cleared: DefinedTabState,
  row: DefinedRow,
): DefinedStep {
  const request = requestSlug(verb, state, row);
  if ('message' in request)
    return { kind: 'state', state: { ...cleared, message: request.message } };
  if (verb === 'export') return { kind: 'export', slug: request.slug, state: cleared };
  // A run is asked for by the file the row was listed from as well as by its slug: with no file there is nothing to compare, so no request.
  if (request.path === undefined)
    return { kind: 'state', state: { ...cleared, message: goneFromCatalog(verb, row) } };
  return { kind: 'run', slug: request.slug, path: request.path, state: cleared };
}

/** Fold one key (already past the tab host's own tab keys and `Esc`) into the tab. */
export function foldDefinedKey(state: DefinedTabState, input: string, key: ChatKey): DefinedStep {
  const rows = state.read.model.rows;
  const cleared: DefinedTabState =
    state.message === undefined ? state : { read: state.read, cursor: state.cursor };
  const stay: DefinedStep = { kind: 'state', state: cleared };
  // A chord (`Ctrl+X`, a meta key) is never one of these keys: `r` and `x` are bare letters.
  if (key.ctrl === true || key.meta === true) return stay;
  if (key.upArrow === true || key.downArrow === true) {
    const to = Math.max(
      0,
      Math.min(state.cursor + (key.upArrow === true ? -1 : 1), rows.length - 1),
    );
    return to === state.cursor ? stay : { kind: 'state', state: { ...cleared, cursor: to } };
  }
  const row = rows[state.cursor];
  if (row === undefined) return stay;
  if (key.return === true)
    return { kind: 'state', state: { ...cleared, message: DEFINED_NO_DETAIL } };
  // A bare letter is the same key with Caps Lock on.
  const letter = input.toLowerCase();
  if (letter === 'p') return { kind: 'pin', row, state: cleared };
  if (letter === 'r') return requestFor('run', state, cleared, row);
  return letter === 'x' ? requestFor('export', state, cleared, row) : stay;
}

/**
 * The row's identity across a read: the catalog entry it names (by slug), else the pin it is (by the pin's row id). A label is nobody's
 * identity: two other projects can pin a workflow of the same name, and a cursor that followed the label would land on the other one, so
 * a second `p` would remove a pin the person never looked at. A row that has neither (its pin is gone) is found nowhere, and the cursor
 * keeps its index.
 */
function sameRow(
  before: { readonly row: DefinedRow; readonly slug: string | undefined },
  after: DefinedRead,
  index: number,
): boolean {
  const candidate = after.model.rows[index];
  if (candidate === undefined) return false;
  if (before.slug !== undefined)
    return candidate.entryIndex !== undefined && after.slugOf(candidate.entryIndex) === before.slug;
  return before.row.pinRowid !== undefined && candidate.pinRowid === before.row.pinRowid;
}

/**
 * `p` on a row: pin its workflow, or unpin it, through `pins`; then read the list again through `port` so the row's pin word is the
 * store's, and keep the cursor on the row it was on (a pinned row sorts first, so its place changes). A row that is gone leaves the cursor
 * at its index, which can hold another row of the same name (another project's pin beside it): a second `p` then removes that one. The
 * register owns this residual. A row that is not a catalog
 * workflow that parsed cannot be pinned (it can be unpinned); a refused pin (the cap) changes nothing and says why in the message row.
 */
export function pinOnDefined(
  state: DefinedTabState,
  row: DefinedRow,
  pins: PinPort | undefined,
  port: DefinedPort | undefined,
): DefinedTabState {
  if (pins === undefined) return withDefinedMessage(state, PIN_UNAVAILABLE);
  const slug = row.entryIndex === undefined ? undefined : state.read.slugOf(row.entryIndex);
  if (!row.pinned && (row.state !== 'ready' || slug === undefined))
    return withDefinedMessage(state, refusal('pin', row));
  const toggled = toggleWorkflowPin(pins, {
    label: row.slug,
    slug,
    pinned: row.pinned,
    rowid: row.pinRowid,
  });
  // The cap changed nothing, so there is nothing to read again; the reason names what the store holds, which this list does not all show.
  if (toggled.outcome === 'full')
    return withDefinedMessage(state, pinFullMessage(row.slug, state.read.stored));
  if (port === undefined) return withDefinedMessage(state, toggled.message);
  let read: DefinedRead;
  try {
    read = port.read();
  } catch {
    return withDefinedMessage(state, `${toggled.message} The list could not be read again.`);
  }
  const found = read.model.rows.findIndex((_, index) => sameRow({ row, slug }, read, index));
  const last = read.model.rows.length - 1;
  const cursor = found >= 0 ? found : Math.max(0, Math.min(state.cursor, last));
  return { read, cursor, message: toggled.message };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

const POINTER = '› ';
const INDENT = '  ';

/** `1 node`, `5 nodes`. */
const nodes = (count: number): string => `${String(count)} ${count === 1 ? 'node' : 'nodes'}`;

/** The words after the name that say what the row is: a node count, or why the row is not a workflow that runs. */
function stateWords(row: DefinedRow): string {
  if (row.state === 'invalid') return '✗ invalid';
  if (row.state === 'not-in-catalog') return '? not in catalog';
  if (row.state === 'other-project') return '? other project';
  return row.nodeCount === undefined ? '' : nodes(row.nodeCount);
}

/** Both a glyph and a word for the pin and, when known, the latest run: the right-hand side of a row. */
function trailingWords(row: DefinedRow): string {
  const last =
    row.lastRunGlyph === undefined || row.lastRunStatus === undefined
      ? ''
      : `${row.lastRunGlyph} ${row.lastRunStatus}`;
  const pin = row.pinned ? '★ pinned' : '· unpinned';
  return [last, pin].filter((part) => part !== '').join('  ');
}

function rowLine(row: DefinedRow, selected: boolean, width: number): SheetLine {
  const name = row.name !== undefined && row.name !== row.slug ? row.name : '';
  const left = `${selected ? POINTER : INDENT}${[row.slug, name, stateWords(row)].filter((part) => part !== '').join('  ')}`;
  const text = flushRow(left, trailingWords(row), width);
  // The trailing words are the quieter part of the row; the selected row keeps its one colour.
  const spans: SheetSpan[] = [];
  const tail = trailingWords(row);
  if (!selected && tail !== '' && text.endsWith(tail))
    spans.push({ from: text.length - tail.length, to: text.length, role: 'dim' });
  return { kind: selected ? 'selected' : 'row', text, spans: clampSpans(spans, text.length) };
}

/** What the selected row says about itself, under the list: its file, or why it can be neither run nor exported (its note). */
function detailLine(row: DefinedRow, width: number): SheetLine {
  if (row.state === 'ready') return { kind: 'text', text: clipLine(row.path ?? '', width) };
  if (row.state === 'other-project')
    return {
      kind: 'text',
      // What `p` does comes first and the root last, so a long project path is the part a narrow terminal cuts.
      text: clipLine(
        (row.projectRoot ?? '') === ''
          ? 'Pinned in another project; p removes the pin.'
          : `Pinned in another project; p removes the pin (${row.projectRoot}).`,
        width,
      ),
    };
  const why = row.state === 'not-in-catalog' ? 'not in catalog' : (row.note ?? 'could not be read');
  // What the row cannot do comes first, so a long parse error is the part that is cut.
  return { kind: 'text', text: clipLine(`Cannot run or export: ${why}`, width) };
}

/**
 * The tab's lines between the strip and the legend, at most `room` of them: the list (windowed around the cursor, a `▲`/`▼` marker
 * standing for the rows it hides), a line for the rows past the model's own bound, the selected row's detail, and the message row. The
 * detail and the message keep their lines whether or not they have anything to say, so the list does not move as a message comes and goes.
 */
export function definedBody(
  state: DefinedTabState,
  width: number,
  room: number,
): readonly SheetLine[] {
  const { rows, moreText } = state.read.model;
  const message: SheetLine =
    state.message === undefined
      ? { kind: 'text', text: '' }
      : { kind: 'notice', text: clipLine(state.message, width) };
  if (rows.length === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(DEFINED_EMPTY, width) };
    return [empty, message].slice(0, room);
  }
  const beyond: readonly SheetLine[] =
    moreText === undefined
      ? []
      : [{ kind: 'marker', text: clipLine(`… ${moreText} not listed`, width) }];
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
  const detail: SheetLine =
    selected === undefined ? { kind: 'text', text: '' } : detailLine(selected, width);
  return [...list, ...beyond, detail, message];
}

/** The legend's items for the tab: the tab host's own, then the keys that act on a row (only when there is a row to act on). */
export function definedLegendItems(
  state: DefinedTabState,
  tabItems: readonly LegendItem[],
  closeItem: LegendItem,
): readonly LegendItem[] {
  if (state.read.model.rows.length === 0) return [...tabItems, closeItem];
  return [
    ...tabItems,
    DEFINED_KEYS.select,
    DEFINED_KEYS.run,
    DEFINED_KEYS.export,
    DEFINED_KEYS.pin,
    closeItem,
  ];
}
