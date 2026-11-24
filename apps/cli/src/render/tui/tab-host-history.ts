import type { RunStatus } from '@relavium/shared';

import { RUN_STATUS_ROLE, nextStatusFilter, type HistoryRow } from '../../history/history-model.js';
import {
  HISTORY_COST_CACHE_MAX,
  type HistoryCost,
  type HistoryEntry,
  type HistoryQuery,
  type HistoryRead,
  type HistoryScope,
  type HistorySource,
} from '../../history/history-source.js';
import { formatDateTime, formatDuration } from '../notation.js';
import { NOT_RECORDED, NO_MESSAGE_RECORDED, NO_NODE_RECORDED, SKIPPED } from '../absence.js';
import {
  NODE_ROW_ROLE,
  scrubbedBounded,
  shortRunId,
  type NodeRow,
} from '../../history/run-detail-model.js';
import type { NodeDetailLoad } from '../../history/node-detail-source.js';
import {
  RUN_DETAIL_MAX_STEPS,
  type DetailEvent,
  type RunDetailLoad,
  type RunDetailRead,
} from '../../history/run-detail-source.js';
import type { ChatKey } from './chat-input.js';
import {
  exitKey,
  fitLegend,
  keyToken,
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
  type SheetLine,
  type SheetLineKind,
  type SheetSpan,
  moreAboveText,
  moreBelowText,
} from './sheet-frame.js';
import { glyph, glyphWithWord, statusCell } from './glyphs.js';
import {
  NODE_FAULT,
  NODE_KEYS,
  NODE_NOT_A_NODE,
  NODE_NOT_HERE,
  foldNodeKey,
  nodeBody,
  nodeLegendItems,
  openNodeTab,
  type NodeLoader,
  type NodeTabState,
} from './tab-host-node.js';
import {
  PIN_KEY,
  PIN_UNAVAILABLE,
  runPinFullMessage,
  toggleRunPin,
  type PinPort,
  type PinToggle,
} from './tab-host-pin.js';
import { displayWidth } from './viewport.js';

/**
 * The History tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): finished runs as a paged list, and one run's detail as a list of its steps and events. PURE, like
 * `tab-host.ts` it is drawn into: it holds no clock and no React, and it reads only through the {@link HistoryPort} it is handed. The
 * source (`history/history-source.ts`) owns the paging rules (a page of twenty, a fetch of at most 200, three pages kept); this module
 * says what a key does and which lines to draw.
 *
 * - **The list.** The pinned section first (the pinned runs inside the current scope), then the page. `↑`/`↓` move over both and stop at
 *   the ends of the page; a `↓` at the very end reads the next page, and an `↑` at the very top the previous one. `PgUp`/`PgDn` move
 *   by a screen, `Home`/`End` to the ends, `a` widens the scope to every project and back, `f` cycles the status filter, `p` pins or
 *   unpins the run (a pin is a mark and changes nothing about a run), and `Enter` opens the run's detail. `Esc` closes the screen
 *   (the tab host's rule). The cursor follows the run, not the row number, across a re-read.
 * - **The cost is read for the rows near the cursor** and kept by the source, per finished run: a row that scrolls into view is folded
 *   once, and a row that was folded is never folded again. A row shows `…` for a cost that was not read yet, `not final` for a run that
 *   is not finished, a run whose log cannot be read is shown as `unreadable`, never hidden, and a cost read that failed just now says `not read` and is read again by the next key.
 * - **The detail.** `Enter` asks the host to load the run (the terminal outbox is a file, so the load is asynchronous; the tab says
 *   `Reading the run…` until the host hands the result in, {@link withHistoryDetail}). The detail is a list of lines: the header, the
 *   node table, then the events. `↑`/`↓` move, `Esc` and `Backspace` go back to the list on the row it came from. A run whose end is
 *   held in the outbox says `held`, never `in progress`. The table lists the nodes that ran in the order they ran, then the nodes of the run's
 *   frozen workflow that have no record (`history/run-detail-source.ts`). `Enter` on a node row opens the node page (`tab-host-node.ts`, read
 *   now through {@link HistoryPort.loadNode}); `n` puts the cursor on the first node whose LAST attempt failed; `p` pins or unpins the run by
 *   the list's own toggle and reads the list again behind the detail; a sentence a key leaves is dropped by the next.
 * - **Every state has a glyph and a word.** `✓ completed`, `✗ failed`, `⊘ cancelled`, `◐ running`, `◇ held`, `? missing`, `★ pinned`;
 *   colour only repeats what the words say. A run whose log cannot be read keeps its own status glyph and word, and says `unreadable` in
 *   the cost slot only.
 * - **Every string from the history file is sanitized** (labels, ids, project roots, node ids, error text) before it is drawn.
 */

/** What the tab holds of a run's cost: what the source answered, or `fault` for a read that threw (the next key reads it again). */
export type CostSlot = HistoryCost | { readonly kind: 'fault' };

/** The reads the tab needs: the source's, and the detail's asynchronous load. */
export interface HistoryPort extends HistorySource {
  /** One run's detail, with its end-held state read from the outbox. Resolves; a fault that is not about the run's rows rejects. */
  readonly loadDetail: (runId: string) => Promise<RunDetailLoad>;
  /**
   * One node of a run, for the node page: synchronous (every read is SQLite on the Home's own connection), and absent in a session that cannot
   * read one, which the page then says. A fault that is not about the node's rows throws; the page turns that into a sentence.
   */
  readonly loadNode?: NodeLoader | undefined;
}

/** What the tab needs beyond its own state to handle a key: the port, and the pin store when there is one. */
export interface HistoryContext {
  readonly history: HistoryPort;
  readonly pins: PinPort | undefined;
}

/** What the tab remembers of its position while the screen lives: the scope, the filter and the run the cursor was on. */
export interface HistoryMemory {
  readonly scope: HistoryScope;
  readonly status: RunStatus | undefined;
  readonly focus: string | undefined;
  readonly cursor: number;
}

/** The detail as it stands: loading, missing, unreadable, or ready with the run's read; `cursor` is the selected line. */
export interface HistoryDetailState {
  readonly runId: string;
  readonly phase: 'loading' | 'ready' | 'missing' | 'unreadable';
  readonly read?: RunDetailRead | undefined;
  readonly cursor: number;
  /**
   * Whether the run is pinned, as the pin store said when the detail was opened and as `p` changed it since. It is the detail's own, not
   * the list's: a run of another directory is not on this project's page, and a list that does not hold the run cannot say it is pinned.
   */
  readonly pinned: boolean;
  /** One sentence the last key left on the detail; the next key drops it. */
  readonly message?: string | undefined;
  /** The node page open over this detail (`Enter` on a node row); `Esc` returns to the detail on the line it left. */
  readonly node?: NodeTabState | undefined;
}

/** The History tab as it stands. */
export interface HistoryTabState {
  /** `unreadable`: the first read failed or nothing feeds the tab. */
  readonly phase: 'ready' | 'unreadable';
  readonly read: HistoryRead | undefined;
  /** The selected entry, over the pinned section and then the page; `0` when there is none. */
  readonly cursor: number;
  /** The key of the selected entry: it survives a re-read that moves the run. */
  readonly focus: string | undefined;
  /** The cost of each run read so far, by run id (the source keeps the folds; this is what the tab has shown). Per screen: a new screen starts empty. */
  readonly costs: ReadonlyMap<string, CostSlot>;
  /** One sentence the last key left; the next key drops it. */
  readonly message?: string | undefined;
  readonly detail?: HistoryDetailState | undefined;
}

/** What a key does on the tab: become another state, or ask the host to load one run's detail. */
export type HistoryStep =
  | { readonly kind: 'state'; readonly state: HistoryTabState }
  | { readonly kind: 'open-detail'; readonly runId: string; readonly state: HistoryTabState };

/** The keys the History tab's legend names that are its own. The test presses every one of them. */
export const HISTORY_KEYS = {
  /**
   * `move`, not `select` (the verb every other list says): the list's legend with the scope key at its longer word (`[a] here`) is 77 columns
   * with `move` and 79 with `select`, and the 80-column floor leaves 78 (`usableColumns`): a legend that does not fit is clipped and loses its
   * `Esc close`. Unifying the verb needs one column from another item of the row (`[a] here`, `[f] filter`, `Enter open`) first.
   */
  select: { keys: '↑/↓', verb: 'move' },
  open: { keys: 'Enter', verb: 'open' },
  pin: PIN_KEY,
  /** Shown while the scope is this project; the toggle back says `here`. */
  widen: { keys: 'a', verb: 'all' },
  narrow: { keys: 'a', verb: 'here' },
  filter: { keys: 'f', verb: 'filter' },
  scroll: { keys: '↑/↓', verb: 'scroll' },
  /** On a run's detail: the first node whose last attempt failed. The node page's own `n` is {@link NODE_KEYS}. */
  firstFailed: NODE_KEYS.firstFailed,
  /** On a run's detail `Esc` goes back to the list: one level (ADR-0145 §2, Step). The list's `Esc` is the host's. */
  back: exitKey.step(),
} as const satisfies Readonly<Record<string, LegendKey>>;

export const HISTORY_UNREADABLE = 'The run history could not be read.';
export const HISTORY_HINT = `Finished runs, newest first. ${keyToken('Enter')} opens a run.`;
/**
 * The hint while more lies past this page. A page can hold fewer than twenty finished runs (or none) and still not be the last: the store
 * is read 200 raw rows at a time, and the active runs among them belong to the Active tab, so the list cannot show a `▼ more` for rows it
 * has not read.
 */
export const HISTORY_HINT_MORE = `Newest first. ${keyToken('Enter')} opens a run. ${keyToken('↓')} at the end reads the next page.`;
/** What a page with no finished run says when the next page may hold some. */
export const HISTORY_EMPTY_PAGE = `No finished run on this page. ${keyToken('↓')} reads the next page.`;
export const HISTORY_LOADING = 'Reading the run…';
export const HISTORY_DETAIL_MISSING = `That run is not in the history any more. ${keyToken('Esc')} goes back.`;
export const HISTORY_DETAIL_UNREADABLE =
  'The event log of this run could not be read. relavium logs shows what is wrong with it.';
export const HISTORY_DETAIL_FAULT = `The run could not be loaded just now. ${keyToken('Enter')} tries again.`;
export const HISTORY_REREAD_FAILED = 'The history could not be read again.';
/**
 * What a cost read that threw says. The cause is unknown (the source degrades a damaged log itself, so a throw is a fault of the moment),
 * so the run's log is not blamed, and the next key reads it again.
 */
export const HISTORY_COST_FAULT = 'the cost could not be read; press a key to retry';
export const HISTORY_NO_FAILED_NODE = 'No node of this run ended failed.';
export const HISTORY_MISSING_RUN = `That pinned run is not in the history any more. ${keyToken('p')} removes the pin.`;
/** The remedy sits in the first 64 columns, so it survives the clip at the 80-column floor; the explanation is what a narrow terminal cuts. */
export const HISTORY_HELD_NOTE =
  'Its end is held in the outbox. relavium status shows what to do. The run is over, but its record has no end.';
/** The remedy of a log read in part: its own row on the run detail. */
export const HISTORY_PARTIAL_REMEDY = 'relavium logs shows the rest.';
export const HISTORY_HELD_UNREAD =
  'Outbox unreadable: this run’s end may be held, and it may not be running.';

/**
 * The most rows the tab's body is ever given: the tab host's rows less the strip, its rule and its legend. `tab-host.ts` owns the budget
 * (it imports this module, so it cannot be imported here); a test holds the two numbers together.
 */
export const HISTORY_BODY_ROOM_MAX = 20;
/** The list's own lines around its entries: the status line, the selected entry's line and the message row. */
const LIST_CHROME_ROWS = 3;
/** The most entry lines the list ever draws (the heading lines of the pinned section only take some of them away). */
export const HISTORY_LIST_ENTRIES_MAX = HISTORY_BODY_ROOM_MAX - LIST_CHROME_ROWS;
/**
 * How many rows either side of the cursor have their cost read. The list draws its window around the cursor, and the window can start at
 * the cursor (at the top) or end at it (at the bottom), so the reach is the whole of the list's height: a drawn row always has its cost,
 * and the two numbers cannot drift because one is the other.
 */
export const HISTORY_COST_REACH = HISTORY_LIST_ENTRIES_MAX;
/** How far `PgUp` and `PgDn` move. */
export const HISTORY_PAGE_STEP = 8;
/** The terminal width the legend must fit: the Home's 80-column floor. */
const LEGEND_FLOOR_COLUMNS = 80;
/** The widest the cost column is drawn inside a row; the whole text is on the line under the list. */
const COST_COLUMN = 18;

const clamp = (value: number, last: number): number => Math.max(0, Math.min(value, last));

// ---- Entries ----------------------------------------------------------------------------------------------------------------

function entryRunId(entry: HistoryEntry): string | undefined {
  return entry.kind === 'run' ? entry.row.id : undefined;
}

function entriesOf(read: HistoryRead | undefined): readonly HistoryEntry[] {
  return read === undefined ? [] : [...read.pinned, ...read.rows];
}

/** The key of an entry in its section: a run is `row:<id>` in the page and `pin:<id>` in the pinned section. */
function keyOf(read: HistoryRead, index: number): string | undefined {
  const entry = entriesOf(read)[index];
  if (entry === undefined) return undefined;
  const section = index < read.pinned.length ? 'pin' : 'row';
  return entry.kind === 'run'
    ? `${section}:${entry.row.id}`
    : `${section}:missing:${String(entry.pinRowid)}`;
}

function indexOfKey(read: HistoryRead, key: string | undefined): number {
  if (key === undefined) return -1;
  const count = read.pinned.length + read.rows.length;
  for (let index = 0; index < count; index += 1) if (keyOf(read, index) === key) return index;
  return -1;
}

function costOf(state: HistoryTabState, row: HistoryRow): CostSlot | undefined {
  return state.costs.get(row.id);
}

// ---- Opening, reading again -------------------------------------------------------------------------------------------------

/** The tab for a Home that has nothing to read it from, or whose first read failed. */
export function unreadableHistoryTab(): HistoryTabState {
  return { phase: 'unreadable', read: undefined, cursor: 0, focus: undefined, costs: new Map() };
}

/**
 * The costs of the rows within {@link HISTORY_COST_REACH} of `cursor`, added to `known` (through the source, which keeps each fold). A row
 * already known is not asked for again, so a key that scrolls over rows already read costs the source nothing. The map keeps at most
 * {@link HISTORY_COST_CACHE_MAX} runs and drops the one shown LEAST RECENTLY first: every row of the window is moved to the end of the map
 * before anything is added (a pinned run that sits above every page stays, and a row of the window is never what a new read pushes out),
 * so a long scroll does not grow it without end. A read that throws for a reason that is not about the run (the source degrades a damaged
 * log itself) is kept as a `fault` for this screen: the row says the cost could not be read, the rows after it are still read, a key never
 * throws out of the tab, and the next key asks for that cost again (a fault of the moment is not a verdict on the run, so it is not
 * remembered as one). A run listed twice (pinned, and in the page) is asked about once per key.
 */
function costsAround(
  known: ReadonlyMap<string, CostSlot>,
  read: HistoryRead,
  port: HistorySource,
  cursor: number,
): ReadonlyMap<string, CostSlot> {
  const entries = entriesOf(read);
  const from = Math.max(0, cursor - HISTORY_COST_REACH);
  const to = Math.min(entries.length, cursor + HISTORY_COST_REACH + 1);
  const costs = new Map(known);
  const missing = new Map<string, HistoryRow>();
  for (let index = from; index < to; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== 'run') continue;
    const kept = costs.get(entry.row.id);
    if (kept === undefined || kept.kind === 'fault') missing.set(entry.row.id, entry.row);
    else {
      // Shown now: the youngest in the map, so the oldest to go is a row that is not in view.
      costs.delete(entry.row.id);
      costs.set(entry.row.id, kept);
    }
  }
  for (const row of missing.values()) {
    let cost: CostSlot;
    try {
      cost = port.cost(row);
    } catch {
      cost = { kind: 'fault' };
    }
    costs.delete(row.id);
    costs.set(row.id, cost);
    while (costs.size > HISTORY_COST_CACHE_MAX) {
      const oldest = costs.keys().next();
      if (oldest.done === true) break;
      costs.delete(oldest.value);
    }
  }
  return costs;
}

/**
 * `state` over `read`: the cursor on the first of `prefer` that is still listed, else at `fallback`, kept inside the entries; and the costs
 * of the rows near it read.
 */
function settle(
  state: HistoryTabState,
  read: HistoryRead,
  port: HistorySource,
  prefer: readonly (string | undefined)[],
  fallback: number,
): HistoryTabState {
  const count = read.pinned.length + read.rows.length;
  let cursor = -1;
  for (const key of prefer) {
    cursor = indexOfKey(read, key);
    if (cursor >= 0) break;
  }
  if (cursor < 0) cursor = clamp(fallback, count - 1);
  return {
    ...state,
    phase: 'ready',
    read,
    cursor,
    focus: keyOf(read, cursor),
    costs: costsAround(state.costs, read, port, cursor),
  };
}

/**
 * The tab entered: the first page read afresh (nothing kept from a visit before), in the scope and filter it was left in, the cursor on
 * the run it was on when that run is still listed. Throws what the port throws; the tab host turns that into `unreadable`.
 */
export function openHistoryTab(port: HistorySource, memory: HistoryMemory): HistoryTabState {
  const read = port.read({ scope: memory.scope, status: memory.status, page: 0, fresh: true });
  return settle(unreadableHistoryTab(), read, port, [memory.focus], memory.cursor);
}

/** The position to remember when the screen is left. */
export function historyMemoryOf(state: HistoryTabState): HistoryMemory | undefined {
  if (state.read === undefined) return undefined;
  return {
    scope: state.read.query.scope,
    status: state.read.query.status,
    focus: state.focus,
    cursor: state.cursor,
  };
}

/**
 * `state` with a run's detail already asked for (the strip's `Enter` on a failed or recent run, ADR-0140 §6): the tab is on `Reading the
 * run…`, and the host's load lands on it as it lands on a detail opened from a row ({@link withHistoryDetail}). A list that could not be
 * read still shows the detail: the tab is then `ready` with no page, so `Esc` goes back to the line that says the history could not be read.
 */
export function withHistoryDetailLoading(
  state: HistoryTabState,
  runId: string,
  pinned: boolean,
): HistoryTabState {
  return { ...state, phase: 'ready', detail: { runId, phase: 'loading', cursor: 0, pinned } };
}

/** Whether the pin store says `runId` is pinned (`fallback` when the port has no pin store or it could not be read). */
export function runPinnedIn(
  port: Pick<HistorySource, 'isRunPinned'>,
  runId: string,
  fallback: boolean,
): boolean {
  try {
    return port.isRunPinned?.(runId) ?? fallback;
  } catch {
    return fallback;
  }
}

/** `state` with a sentence the next key drops. */
export function withHistoryMessage(state: HistoryTabState, message: string): HistoryTabState {
  return { ...state, message };
}

/**
 * The detail the host loaded, handed in. It lands only on the detail it was asked for and still waits for (a result for a run the person
 * has left, or already answered, changes nothing): the same object then.
 */
export function withHistoryDetail(
  state: HistoryTabState,
  runId: string,
  load: RunDetailLoad,
): HistoryTabState {
  const detail = state.detail;
  if (detail?.runId !== runId || detail.phase !== 'loading') return state;
  const { pinned } = detail;
  const next: HistoryDetailState =
    load.kind === 'ready'
      ? { runId, phase: 'ready', read: load.detail, cursor: 0, pinned }
      : { runId, phase: load.kind, cursor: 0, pinned };
  return { ...state, detail: next };
}

/** `state` after the load of a detail failed for a reason that is not about the run: back on the list, with a sentence. */
export function failHistoryDetail(state: HistoryTabState, runId: string): HistoryTabState {
  if (state.detail?.runId !== runId || state.detail.phase !== 'loading') return state;
  return { ...state, detail: undefined, message: HISTORY_DETAIL_FAULT };
}

// ---- Keys -------------------------------------------------------------------------------------------------------------------

/** How many lines the detail has: the head, then the events with their heading. */
function detailLineCount(read: RunDetailRead): number {
  return detailHead(read, false).length + (read.events.length > 0 ? 1 + read.events.length : 0);
}

/** `state` with a sentence on the detail, which the next key drops. */
function withDetailMessage(
  state: HistoryTabState,
  detail: HistoryDetailState,
  message: string,
): HistoryTabState {
  return { ...state, detail: { ...detail, message } };
}

/** The node row the detail's cursor is on; `undefined` on any other line. */
function nodeRowAt(read: RunDetailRead, cursor: number): NodeRow | undefined {
  const nodeId = detailHead(read, false)[cursor]?.nodeId;
  return nodeId === undefined ? undefined : read.model.rows.find((row) => row.nodeId === nodeId);
}

/** `n` on the detail: the cursor on the first node whose LAST attempt failed (the model's `firstFailedNodeId`). */
function jumpToFirstFailed(
  state: HistoryTabState,
  detail: HistoryDetailState,
  read: RunDetailRead,
): HistoryTabState {
  const nodeId = read.model.firstFailedNodeId;
  const at =
    nodeId === undefined ? -1 : detailHead(read, false).findIndex((line) => line.nodeId === nodeId);
  if (at < 0) return withDetailMessage(state, detail, HISTORY_NO_FAILED_NODE);
  return { ...state, detail: { ...detail, cursor: at } };
}

/** `Enter` on the detail: the node page over the node row the cursor is on, read now (the read is synchronous). */
function openNode(
  state: HistoryTabState,
  detail: HistoryDetailState,
  read: RunDetailRead,
  context: HistoryContext,
): HistoryTabState {
  const row = nodeRowAt(read, detail.cursor);
  if (row === undefined) return withDetailMessage(state, detail, NODE_NOT_A_NODE);
  const loadNode = context.history.loadNode;
  if (loadNode === undefined) return withDetailMessage(state, detail, NODE_NOT_HERE);
  let load: NodeDetailLoad;
  try {
    load = loadNode({ runId: detail.runId, nodeId: row.nodeId, terminalHeld: read.terminalHeld });
  } catch {
    return withDetailMessage(state, detail, NODE_FAULT);
  }
  return { ...state, detail: { ...detail, node: openNodeTab(detail.runId, row, load) } };
}

/** One key into the node page over the detail: the page's own, and `Esc` back to the detail on the line it left. */
function foldNodeStep(
  state: HistoryTabState,
  detail: HistoryDetailState,
  node: NodeTabState,
  input: string,
  key: ChatKey,
  context: HistoryContext,
): HistoryStep {
  const step = foldNodeKey(node, input, key, {
    loadNode: context.history.loadNode,
    terminalHeld: detail.read?.terminalHeld === true,
  });
  if (step.kind === 'back')
    return { kind: 'state', state: { ...state, detail: { ...detail, node: undefined } } };
  return step.state === node
    ? { kind: 'state', state }
    : { kind: 'state', state: { ...state, detail: { ...detail, node: step.state } } };
}

/** Where a scroll key puts the detail's cursor (`last` is the final line), or `undefined` for a key that scrolls nothing. */
function scrolledTo(cursor: number, last: number, key: ChatKey): number | undefined {
  if (key.upArrow === true) return clamp(cursor - 1, last);
  if (key.downArrow === true) return clamp(cursor + 1, last);
  if (key.pageUp === true) return clamp(cursor - HISTORY_PAGE_STEP, last);
  if (key.pageDown === true) return clamp(cursor + HISTORY_PAGE_STEP, last);
  if (key.home === true) return 0;
  return key.end === true ? clamp(last, last) : undefined;
}

function foldDetailKey(
  state: HistoryTabState,
  detail: HistoryDetailState,
  input: string,
  key: ChatKey,
  context: HistoryContext,
): HistoryStep {
  const stay: HistoryStep = { kind: 'state', state };
  if (key.ctrl === true || key.meta === true) return stay;
  if (detail.node !== undefined)
    return foldNodeStep(state, detail, detail.node, input, key, context);
  if (key.escape === true || key.backspace === true)
    return { kind: 'state', state: { ...state, detail: undefined } };
  const read = detail.read;
  if (detail.phase !== 'ready' || read === undefined) return stay;
  const cleared: HistoryDetailState =
    detail.message === undefined ? detail : { ...detail, message: undefined };
  const held: HistoryTabState = cleared === detail ? state : { ...state, detail: cleared };
  // A bare letter is the same key with Caps Lock on.
  const letter = input.toLowerCase();
  if (letter === 'p') return { kind: 'state', state: pinDetail(held, cleared, context) };
  if (letter === 'n') return { kind: 'state', state: jumpToFirstFailed(held, cleared, read) };
  if (key.return === true) return { kind: 'state', state: openNode(held, cleared, read, context) };
  const to = scrolledTo(detail.cursor, detailLineCount(read) - 1, key);
  return to === undefined || to === cleared.cursor
    ? { kind: 'state', state: held }
    : { kind: 'state', state: { ...state, detail: { ...cleared, cursor: to } } };
}

/**
 * Read the page again for `query`, keeping the cursor on `prefer`, else at `fallback` (a number, or where the new read says); `undefined`
 * when the read failed.
 */
function reread(
  state: HistoryTabState,
  port: HistorySource,
  query: HistoryQuery,
  prefer: readonly (string | undefined)[],
  fallback: number | ((read: HistoryRead) => number),
): HistoryTabState | undefined {
  let read: HistoryRead;
  try {
    read = port.read(query);
  } catch {
    return undefined;
  }
  return settle(
    state,
    read,
    port,
    prefer,
    typeof fallback === 'number' ? fallback : fallback(read),
  );
}

/** `p` on the selected entry: toggle the pin, read the page again (the pinned section and the marks are the store's), keep the run in view. */
function pinSelected(
  state: HistoryTabState,
  read: HistoryRead,
  context: HistoryContext,
): HistoryTabState {
  if (context.pins === undefined) return withHistoryMessage(state, PIN_UNAVAILABLE);
  const entry = entriesOf(read)[state.cursor];
  if (entry === undefined) return state;
  const pinned = entry.kind === 'missing' || entry.row.pinned;
  const toggled: PinToggle = toggleRunPin(context.pins, {
    label: entry.kind === 'run' ? entry.row.shortId : entry.label,
    runId: entryRunId(entry),
    pinned,
    rowid: entry.pinRowid,
  });
  // The cap changed nothing, so there is nothing to read again; the reason names what the store holds, which this list does not all show.
  if (toggled.outcome === 'full')
    return withHistoryMessage(
      state,
      runPinFullMessage(context.pins, entry.kind === 'run' ? entry.row.shortId : entry.label),
    );
  const runId = entryRunId(entry);
  const again = reread(
    state,
    context.history,
    { ...read.query },
    // The run stays where it was in the page; in the pinned section it may be gone, and then it is the page's row.
    [state.focus, runId === undefined ? undefined : `row:${runId}`],
    state.cursor,
  );
  return withHistoryMessage(
    again ?? state,
    again === undefined ? `${toggled.message} ${HISTORY_REREAD_FAILED}` : toggled.message,
  );
}

/** What the store holds after a toggle: a pin made or found is pinned, one removed or found missing is not, and a fault leaves what was shown. */
function pinnedAfter(toggled: PinToggle, before: boolean): boolean {
  if (toggled.outcome === 'pinned') return true;
  return toggled.outcome === 'unpinned' || toggled.outcome === 'absent' ? false : before;
}

/**
 * `p` on a run's detail: the same pin toggle as on its row, under the run's canonical key. Whether the run is pinned is asked of the pin
 * store by the run's id, never read off the list: a run of another directory is not on this project's page, so the page cannot say, and a
 * toggle that took the page's silence for "not pinned" said `Pinned` at every press and could never unpin. The list the detail was opened
 * from is read again, so its pinned section and its row's mark are the store's, and the cursor stays on the run.
 */
function pinDetail(
  state: HistoryTabState,
  detail: HistoryDetailState,
  context: HistoryContext,
): HistoryTabState {
  if (context.pins === undefined) return withDetailMessage(state, detail, PIN_UNAVAILABLE);
  const list = state.read;
  const toggled: PinToggle = toggleRunPin(context.pins, {
    label: shortRunId(detail.runId),
    runId: detail.runId,
    pinned: runPinnedIn(context.history, detail.runId, detail.pinned),
    rowid: undefined,
  });
  // The cap changed nothing, so there is nothing to read again; the reason names what the store holds, which this list does not all show.
  if (toggled.outcome === 'full')
    return withDetailMessage(
      state,
      detail,
      runPinFullMessage(context.pins, shortRunId(detail.runId)),
    );
  const marked: HistoryDetailState = { ...detail, pinned: pinnedAfter(toggled, detail.pinned) };
  if (list === undefined) return withDetailMessage(state, marked, toggled.message);
  const again = reread(
    state,
    context.history,
    { ...list.query },
    [`row:${detail.runId}`, `pin:${detail.runId}`],
    state.cursor,
  );
  return withDetailMessage(
    again ?? state,
    marked,
    again === undefined ? `${toggled.message} ${HISTORY_REREAD_FAILED}` : toggled.message,
  );
}

/** What a key on the list works over: the state as it was, the state with its message dropped, the page read and the ports. */
interface ListKeyView {
  readonly state: HistoryTabState;
  readonly cleared: HistoryTabState;
  readonly read: HistoryRead;
  readonly context: HistoryContext;
}

/** A key that moves nothing still asks again for a cost that could not be read: the fault line says "press a key to retry", and a one-row list has no move to make. A window whose costs are known reads nothing here. */
function listStay({ state, cleared, read, context }: ListKeyView): HistoryStep {
  return {
    kind: 'state',
    state: { ...cleared, costs: costsAround(cleared.costs, read, context.history, state.cursor) },
  };
}

/** The cursor to `to`; the rows that scroll into view are read now (the source keeps each fold, and a row already read is not read again). */
function listMove(view: ListKeyView, to: number): HistoryStep {
  const { state, cleared, read, context } = view;
  if (to === state.cursor) return listStay(view);
  return {
    kind: 'state',
    state: {
      ...cleared,
      cursor: to,
      focus: keyOf(read, to),
      costs: costsAround(cleared.costs, read, context.history, to),
    },
  };
}

/**
 * Another page of the same walk. On the next page the cursor starts on its first row (past the pinned section, which stays above every
 * page); on the previous page it starts at the very end, so the walk back reads as the walk forward in reverse.
 */
function listChangePage(view: ListKeyView, page: number, onRows: 'first' | 'last'): HistoryStep {
  const { cleared, read, context } = view;
  const again = reread(cleared, context.history, { ...read.query, page }, [], (next) => {
    const entries = next.pinned.length + next.rows.length;
    return onRows === 'first' ? Math.min(next.pinned.length, entries - 1) : entries - 1;
  });
  return { kind: 'state', state: again ?? withHistoryMessage(cleared, HISTORY_REREAD_FAILED) };
}

/** The keys that move over the list and across its pages: the arrows (which read the next or previous page at an end), the page keys, `Home` and `End`. */
function listNavigate(view: ListKeyView, key: ChatKey): HistoryStep | undefined {
  const { state, read } = view;
  const last = read.pinned.length + read.rows.length - 1;
  if (key.downArrow === true) {
    if (state.cursor >= last && read.hasNext)
      return listChangePage(view, read.query.page + 1, 'first');
    return listMove(view, clamp(state.cursor + 1, last));
  }
  if (key.upArrow === true) {
    if (state.cursor <= 0 && read.hasPrev) return listChangePage(view, read.query.page - 1, 'last');
    return listMove(view, clamp(state.cursor - 1, last));
  }
  if (key.pageDown === true) return listMove(view, clamp(state.cursor + HISTORY_PAGE_STEP, last));
  if (key.pageUp === true) return listMove(view, clamp(state.cursor - HISTORY_PAGE_STEP, last));
  if (key.home === true) return listMove(view, 0);
  if (key.end === true) return listMove(view, clamp(last, last));
  return undefined;
}

/** `Enter` on the list: the detail of the selected run (the host loads it), or why a pin whose run is gone has none. */
function listOpen(view: ListKeyView): HistoryStep {
  const { state, cleared, read } = view;
  const entry = entriesOf(read)[state.cursor];
  if (entry === undefined) return listStay(view);
  if (entry.kind === 'missing')
    return { kind: 'state', state: withHistoryMessage(cleared, HISTORY_MISSING_RUN) };
  const detail: HistoryDetailState = {
    runId: entry.row.id,
    phase: 'loading',
    cursor: 0,
    pinned: entry.row.pinned,
  };
  return { kind: 'open-detail', runId: entry.row.id, state: { ...cleared, detail } };
}

/** `a` (this project's runs, or every project's) and `f` (the next status filter): a new walk from the first page. */
function listRewalk(view: ListKeyView, letter: 'a' | 'f'): HistoryStep {
  const { cleared, read, context } = view;
  const { scope, status } = read.query;
  const query: HistoryQuery =
    letter === 'a'
      ? { scope: scope === 'project' ? 'all' : 'project', status, page: 0 }
      : { scope, status: nextStatusFilter(status), page: 0 };
  const again = reread(cleared, context.history, query, [], 0);
  return { kind: 'state', state: again ?? withHistoryMessage(cleared, HISTORY_REREAD_FAILED) };
}

/** One key into the list: move, page, widen, filter, pin, open. */
function foldListKey(
  state: HistoryTabState,
  input: string,
  key: ChatKey,
  context: HistoryContext,
): HistoryStep {
  const read = state.read;
  const cleared: HistoryTabState =
    state.message === undefined ? state : { ...state, message: undefined };
  if (read === undefined || key.ctrl === true || key.meta === true)
    return { kind: 'state', state: cleared };
  const view: ListKeyView = { state, cleared, read, context };
  const navigated = listNavigate(view, key);
  if (navigated !== undefined) return navigated;
  if (key.return === true) return listOpen(view);
  // A bare letter is the same key with Caps Lock on.
  const letter = input.toLowerCase();
  if (letter === 'p') return { kind: 'state', state: pinSelected(cleared, read, context) };
  if (letter === 'a' || letter === 'f') return listRewalk(view, letter);
  return listStay(view);
}

/** Fold one key (already past the tab host's own tab keys, and its `Esc` when the list is in front) into the tab. */
export function foldHistoryKey(
  state: HistoryTabState,
  input: string,
  key: ChatKey,
  context: HistoryContext,
): HistoryStep {
  if (state.detail !== undefined) return foldDetailKey(state, state.detail, input, key, context);
  return foldListKey(state, input, key, context);
}

// ---- What is drawn ----------------------------------------------------------------------------------------------------------

/** The selection marker and its space, in the form in force ({@link glyph}); an unselected row keeps the same two columns. */
const pointer = (): string => `${glyph('selection')} `;
const INDENT = '  ';
const WORD_WIDTH = 10;

const SCOPE_WORDS: Readonly<Record<HistoryScope, string>> = {
  project: 'this project',
  all: 'all projects',
};

/** What the status line says of the query: the scope, the filter and the page, all in words. */
function statusLine(read: HistoryRead): string {
  const { scope, status, page } = read.query;
  const last = read.hasNext ? '' : ' (last)';
  return `${SCOPE_WORDS[scope]} · ${status ?? 'every finished run'} · page ${String(page + 1)}${last}`;
}

/**
 * The cost slot of a row: a figure, `…` before it is read, `not final` for a run that has not ended, `unreadable` for a log that cannot be
 * read, `not read` for a read that failed just now (never a bare dash).
 */
function costWords(cost: CostSlot | undefined): string {
  if (cost === undefined) return '…';
  if (cost.kind === 'text') return clipLine(cost.text, COST_COLUMN);
  if (cost.kind === 'fault') return 'not read';
  return cost.kind === 'not-final' ? 'not final' : 'unreadable';
}

function entryLine(
  entry: HistoryEntry,
  selected: boolean,
  state: HistoryTabState,
  width: number,
): SheetLine {
  const lead = selected ? pointer() : INDENT;
  if (entry.kind === 'missing') {
    const left = `${lead}? ${'missing'.padEnd(WORD_WIDTH)} ${entry.label}`;
    const tail = glyphWithWord('pinned');
    const text = flushRow(left, tail, width);
    return { kind: selected ? 'selected' : 'row', text, spans: tailSpan(text, tail, selected) };
  }
  const { row } = entry;
  // The run's own status stays: a log that cannot be read says so in the cost slot, which is where the figure it replaces would be.
  const left = `${lead}${statusCell(RUN_STATUS_ROLE[row.status])} ${row.word.padEnd(WORD_WIDTH)} ${row.shortId}  ${row.label}`;
  const tail = [
    row.ageText,
    costWords(costOf(state, row)),
    row.pinned ? glyphWithWord('pinned') : '',
  ]
    .filter((part) => part !== '')
    .join('  ');
  const text = flushRow(left, tail, width);
  return { kind: selected ? 'selected' : 'row', text, spans: tailSpan(text, tail, selected) };
}

function tailSpan(text: string, tail: string, selected: boolean): readonly SheetSpan[] {
  if (selected || tail === '' || !text.endsWith(tail)) return [];
  return clampSpans(
    [{ from: text.length - tail.length, to: text.length, role: 'dim' }],
    text.length,
  );
}

/** What a run's cost slot says in words, for the line under the list: the whole figure, or why there is none. Empty before the cost was read. */
function costSentence(cost: CostSlot | undefined, row: HistoryRow): string {
  switch (cost?.kind) {
    case 'text':
      return `cost ${cost.text}`;
    case 'unreadable':
      return `its event log could not be read (it was ${row.word})`;
    case 'fault':
      return HISTORY_COST_FAULT;
    case 'not-final':
      return 'not finished: its cost is not final';
    default:
      return '';
  }
}

/** What the selected entry says about itself, under the list: the whole id and project, and the whole cost text. */
function detailLine(
  entry: HistoryEntry | undefined,
  state: HistoryTabState,
  width: number,
): SheetLine {
  if (entry === undefined) return { kind: 'text', text: '' };
  if (entry.kind === 'missing')
    return {
      kind: 'text',
      text: clipLine(`No run has this id any more; ${keyToken('p')} removes the pin.`, width),
    };
  const { row } = entry;
  const money = costSentence(costOf(state, row), row);
  // What the run cost (or why it has no figure) comes first, so a long id or project path is the part a narrow terminal cuts.
  const parts = [money, scrubbedBounded(row.id), row.projectRoot ?? ''].filter(
    (part) => part !== '',
  );
  return { kind: 'text', text: clipLine(parts.join(' · '), width) };
}

interface ListLine {
  /** Index into the entries when this line is one; headings have none. */
  readonly entry: number | undefined;
  readonly line: SheetLine;
}

/** The list's lines: the pinned section (with its heading) and the page (with its), or the page alone when nothing is pinned. */
function listLines(state: HistoryTabState, read: HistoryRead, width: number): readonly ListLine[] {
  const entries = entriesOf(read);
  const lines: ListLine[] = [];
  const heading = (text: string): ListLine => ({
    entry: undefined,
    line: { kind: 'heading', text: clipLine(text, width) },
  });
  entries.forEach((entry, index) => {
    if (read.pinned.length > 0 && index === 0)
      lines.push(heading(`Pinned (${String(read.pinned.length)})`));
    if (read.pinned.length > 0 && index === read.pinned.length) lines.push(heading('Runs'));
    lines.push({ entry: index, line: entryLine(entry, index === state.cursor, state, width) });
  });
  // A page with no row still has the heading when something is pinned above it.
  if (read.pinned.length > 0 && read.rows.length === 0) lines.push(heading('Runs'));
  return lines;
}

/** How many entries of `lines[from, to)` there are (headings are not entries). */
function entriesIn(lines: readonly ListLine[], from: number, to: number): number {
  return lines.slice(from, to).filter((line) => line.entry !== undefined).length;
}

function emptyText(read: HistoryRead): string {
  const { scope, status } = read.query;
  if (read.hasNext) return HISTORY_EMPTY_PAGE;
  if (status !== undefined) return `No ${status} run here. ${keyToken('f')} changes the filter.`;
  return scope === 'project'
    ? 'No finished run in this project yet. Run a workflow from the Defined tab.'
    : 'No finished run yet.';
}

/**
 * The list's lines between the strip and the legend, at most `room` of them: the status line, the list (windowed around the cursor, a
 * `▲`/`▼` marker standing for the entries it hides), the selected entry's line and the message row. The last two keep their lines
 * whether or not they have anything to say, so the list does not move as a message comes and goes.
 */
function listBody(state: HistoryTabState, width: number, room: number): readonly SheetLine[] {
  const read = state.read;
  if (read === undefined) return [{ kind: 'failed', text: HISTORY_UNREADABLE }];
  const status: SheetLine = { kind: 'hint', text: clipLine(statusLine(read), width) };
  const footer: SheetLine =
    state.message === undefined
      ? { kind: 'hint', text: clipLine(read.hasNext ? HISTORY_HINT_MORE : HISTORY_HINT, width) }
      : { kind: 'notice', text: clipLine(state.message, width) };
  const count = read.pinned.length + read.rows.length;
  if (count === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(emptyText(read), width) };
    return [status, empty, footer].slice(0, room);
  }
  const lines = listLines(state, read, width);
  const height = Math.max(3, room - LIST_CHROME_ROWS);
  const cursorLine = lines.findIndex((line) => line.entry === state.cursor);
  const { start, end } = windowBody(lines.length, Math.max(0, cursorLine), height);
  const shown: SheetLine[] = lines.slice(start, end).map((line) => line.line);
  if (start > 0 && shown.length > 0)
    shown[0] = { kind: 'marker', text: moreAboveText(entriesIn(lines, 0, start + 1)) };
  if (end < lines.length && shown.length > 0)
    shown[shown.length - 1] = {
      kind: 'marker',
      text: moreBelowText(entriesIn(lines, end - 1, lines.length)),
    };
  return [status, ...shown, detailLine(entriesOf(read)[state.cursor], state, width), footer];
}

// ---- The detail -------------------------------------------------------------------------------------------------------------

interface DetailLine {
  readonly kind: SheetLineKind;
  readonly left: string;
  readonly right?: string;
  /**
   * What a row says after its label, most important first. The draw keeps as many of them as fit beside the label, so a long figure (a
   * qualified cost) costs the row that figure and never the label it describes; a line with `right` set is drawn as it is.
   */
  readonly parts?: readonly string[];
  /** The raw id of the node a line of the table stands for: what `Enter` opens and `n` looks for. Never drawn. */
  readonly nodeId?: string;
}

const nodeAttempts = (row: NodeRow): string =>
  `${String(row.attemptCount)} ${row.attemptCount === 1 ? 'attempt' : 'attempts'}`;

function nodeLine(row: NodeRow): DetailLine {
  const left = `  ${statusCell(NODE_ROW_ROLE[row.status])} ${row.status.padEnd(WORD_WIDTH)} ${row.label}`;
  const reason = row.skippedReason === undefined ? '' : `${SKIPPED}: ${row.skippedReason}`;
  const parts = [
    nodeAttempts(row),
    row.durationMs === undefined ? '' : formatDuration(row.durationMs),
    reason,
    row.tokens.text,
    row.cost.text,
  ].filter((part) => part !== '');
  return { kind: 'row', left, parts, nodeId: row.nodeId };
}

/** The most of `parts` (in order, two spaces apart) that fits beside `left` in `width` columns; empty when not even the first does. */
function fitParts(left: string, parts: readonly string[], width: number): string {
  for (let count = parts.length; count > 0; count -= 1) {
    const right = parts.slice(0, count).join('  ');
    if (displayWidth(left) + 2 + displayWidth(right) <= width) return right;
  }
  return '';
}

/** The word and the glyph of the run in the header: `held` for a run whose end is in the outbox, else its status. */
function headerState(read: RunDetailRead): { mark: string; word: string } {
  return read.terminalHeld
    ? { mark: glyph('held'), word: 'held' }
    : { mark: glyph(RUN_STATUS_ROLE[read.status]), word: read.status };
}

/** When a run started, as a person reads it (`2026-11-22 10:00 UTC`); a stored text that is not a time is drawn as it is, and none is `not recorded`. */
function startedWords(startedAt: string | undefined): string {
  if (startedAt === undefined) return NOT_RECORDED;
  const moment = formatDateTime(startedAt);
  return moment === '' ? startedAt : moment;
}

/** The run's own lines: the heading, when it started and how long it took, its tokens and cost, and its error. */
function headerLines(read: RunDetailRead, pinned: boolean): DetailLine[] {
  const { header } = read.model;
  const { mark, word } = headerState(read);
  // The workflow's name is the part of the heading a narrow terminal cuts: the short id and the pin mark are flushed right and keep their
  // columns (`flushRow` clips the label first), so a run stays identifiable and its pin stays visible at 78 columns.
  const lines: DetailLine[] = [
    {
      kind: 'heading',
      left: `${mark} ${word}  ${header.workflow}`,
      right: `${header.shortId}${pinned ? `  ${glyphWithWord('pinned')}` : ''}`,
    },
  ];
  let duration = 'not finished';
  if (header.durationMs !== undefined) duration = formatDuration(header.durationMs);
  else if (read.terminalHeld) duration = 'end held';
  lines.push(
    { kind: 'text', left: `Started ${startedWords(header.startedAt)}  ·  took ${duration}` },
    { kind: 'text', left: `Tokens ${header.tokensText}  ·  cost ${header.costText}` },
  );
  if (header.error !== undefined) {
    const { code, message, nodeId } = header.error;
    const where = nodeId === undefined ? '' : ` (node ${nodeId})`;
    const label = code === undefined ? 'Error' : `Error ${code}`;
    lines.push({ kind: 'failed', left: `${label}: ${message ?? NO_MESSAGE_RECORDED}${where}` });
  }
  return lines;
}

/** What the read could not say whole: an end held in the outbox, an outbox that could not be read, a log read in part, rows from a newer version. */
function noteLines(read: RunDetailRead): DetailLine[] {
  const lines: DetailLine[] = [];
  if (read.terminalHeld) lines.push({ kind: 'notice', left: HISTORY_HELD_NOTE });
  if (read.heldUnread) lines.push({ kind: 'notice', left: HISTORY_HELD_UNREAD });
  // Two rows, not one: the remedy is a row of its own, so a narrow terminal cannot clip it away.
  if (!read.eventsComplete) {
    lines.push(
      {
        kind: 'notice',
        left: `Only the first ${String(read.events.length)} events were read: the figures may be partial.`,
      },
      { kind: 'notice', left: HISTORY_PARTIAL_REMEDY },
    );
  }
  // The attempt rows are cut at the store's bound, so the node table is the first of them, in execution order.
  if (!read.stepsComplete)
    lines.push({
      kind: 'notice',
      left: `Only the first ${String(RUN_DETAIL_MAX_STEPS)} steps were read: the node table may be partial.`,
    });
  if (read.skippedRows > 0)
    lines.push({
      kind: 'notice',
      left: `${String(read.skippedRows)} ${read.skippedRows === 1 ? 'row was' : 'rows were'} written by a newer version and skipped.`,
    });
  return lines;
}

/** The node table: its heading, a row per node (or the sentence that none was recorded) and the `unattributed` row when the run has one. */
function nodeTableLines(read: RunDetailRead): DetailLine[] {
  const { rows, unattributedRow } = read.model;
  const lines: DetailLine[] = [{ kind: 'heading', left: `Nodes (${String(rows.length)})` }];
  if (rows.length === 0) lines.push({ kind: 'text', left: `  ${NO_NODE_RECORDED}` });
  for (const row of rows) lines.push(nodeLine(row));
  if (unattributedRow !== undefined)
    lines.push({ kind: 'row', left: `    ${unattributedRow.label}`, right: unattributedRow.text });
  return lines;
}

/**
 * The detail's lines before the events: the header, its notes, the node table. Width-independent; the draw clips. `pinned` only adds the
 * `★ pinned` mark to the header, so the lines a key counts are the same whether or not the run is pinned.
 */
function detailHead(read: RunDetailRead, pinned: boolean): readonly DetailLine[] {
  return [...headerLines(read, pinned), ...noteLines(read), ...nodeTableLines(read)];
}

function eventLine(event: DetailEvent): DetailLine {
  const node = event.nodeId === undefined ? '' : ` ${scrubbedBounded(event.nodeId)}`;
  return { kind: 'row', left: `  #${String(event.seq)}  ${event.type}${node}` };
}

/** The line at `index` of the whole detail: the head, then the events' own heading, then the events. */
function detailLineAt(read: RunDetailRead, head: readonly DetailLine[], index: number): DetailLine {
  const inHead = head[index];
  if (inHead !== undefined) return inHead;
  if (index === head.length)
    return {
      kind: 'heading',
      left: `Events (${String(read.events.length)}${read.eventsComplete ? '' : '+'})`,
    };
  const event = read.events[index - head.length - 1];
  return event === undefined ? { kind: 'text', left: '' } : eventLine(event);
}

/** The lines `[start, end)` of the detail drawn as rows, the selected one marked, and a `▲`/`▼` marker standing for the lines each end hides. */
function detailWindow(
  lineAt: (index: number) => DetailLine,
  cursor: number,
  window: { readonly start: number; readonly end: number; readonly total: number },
  width: number,
): SheetLine[] {
  const { start, end, total } = window;
  const lines: SheetLine[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lineAt(index);
    const selected = index === cursor;
    const left = `${selected ? pointer() : INDENT}${line.left}`;
    const right = line.parts === undefined ? (line.right ?? '') : fitParts(left, line.parts, width);
    lines.push({ kind: selected ? 'selected' : line.kind, text: flushRow(left, right, width) });
  }
  if (start > 0 && lines.length > 0) lines[0] = { kind: 'marker', text: moreAboveText(start + 1) };
  if (end < total && lines.length > 0)
    lines[lines.length - 1] = { kind: 'marker', text: moreBelowText(total - end + 1) };
  return lines;
}

function detailBody(
  state: HistoryTabState,
  detail: HistoryDetailState,
  width: number,
  room: number,
): readonly SheetLine[] {
  if (detail.phase === 'loading') return [{ kind: 'text', text: HISTORY_LOADING }];
  if (detail.phase === 'missing')
    return [{ kind: 'notice', text: clipLine(HISTORY_DETAIL_MISSING, width) }];
  const read = detail.read;
  if (detail.phase === 'unreadable' || read === undefined)
    return [{ kind: 'failed', text: clipLine(HISTORY_DETAIL_UNREADABLE, width) }];
  if (detail.node !== undefined) return nodeBody(detail.node, width, room);
  const head = detailHead(read, detail.pinned);
  const total = detailLineCount(read);
  const height = Math.max(3, room - 1);
  const { start, end } = windowBody(total, detail.cursor, height);
  const lines = detailWindow(
    (index) => detailLineAt(read, head, index),
    detail.cursor,
    { start, end, total },
    width,
  );
  const footer: SheetLine =
    detail.message === undefined
      ? {
          kind: 'hint',
          text: clipLine(`No run is changed here; ${keyToken('p')} only marks one.`, width),
        }
      : { kind: 'notice', text: clipLine(detail.message, width) };
  return [...lines, footer];
}

/** The tab's lines between the strip and the legend, at most `room` of them. */
export function historyBody(
  state: HistoryTabState,
  width: number,
  room: number,
): readonly SheetLine[] {
  if (state.phase === 'unreadable') return [{ kind: 'failed', text: HISTORY_UNREADABLE }];
  if (state.detail !== undefined) return detailBody(state, state.detail, width, room);
  return listBody(state, width, room);
}

/** The legend's own items after the tab item, with the cycle item between them when the whole fits the floor (see {@link historyLegendItems}). */
type NamedLegend = (...rest: readonly LegendItem[]) => readonly LegendItem[];

/** The detail's legend: the node page's own, nothing but the way back while the detail is not ready, or the scroll, open, first-failed and pin keys. */
function detailLegendItems(
  detail: HistoryDetailState,
  named: NamedLegend,
  tabItem: LegendItem,
): readonly LegendItem[] {
  if (detail.node !== undefined) {
    const [, ...rest] = nodeLegendItems(detail.node, tabItem);
    return named(...rest);
  }
  // A detail that is still loading, missing or unreadable answers only to the way back: its scroll keys have nothing to move.
  if (detail.phase !== 'ready') return named();
  return named(HISTORY_KEYS.scroll, HISTORY_KEYS.open, HISTORY_KEYS.firstFailed, HISTORY_KEYS.pin);
}

/** The list's legend; a page with no run still names the move keys while another page lies past it or before it. */
function listLegendItems(read: HistoryRead | undefined, named: NamedLegend): readonly LegendItem[] {
  const scope = read?.query.scope === 'all' ? HISTORY_KEYS.narrow : HISTORY_KEYS.widen;
  if (read === undefined || read.pinned.length + read.rows.length === 0) {
    // A page with no run can still be walked: `↓` reads the next page and `↑` the previous one, so the legend names the keys that do it.
    return read?.hasNext === true || read?.hasPrev === true
      ? named(HISTORY_KEYS.select, scope, HISTORY_KEYS.filter)
      : named(scope, HISTORY_KEYS.filter);
  }
  return named(
    HISTORY_KEYS.select,
    HISTORY_KEYS.open,
    HISTORY_KEYS.pin,
    scope,
    HISTORY_KEYS.filter,
  );
}

/**
 * The legend's items: the detail's, or the list's (the tab host's tab item first). The key that leaves is the host's `exit`, which the
 * fit needs to measure: `Esc close` on the list, {@link HISTORY_KEYS.back} or the node page's on a detail. A tab that could not be read
 * names the tab keys the other tabs without a list name. `Tab` (cycle) is named wherever the legend still fits the 80-column floor with it
 * ({@link fitLegend}), so a long legend (the list's, the detail's) keeps its own keys instead.
 */
export function historyLegendItems(
  state: HistoryTabState,
  tabItems: readonly LegendItem[],
  exit: LegendExit,
): readonly LegendItem[] {
  const [tabItem, cycleItem] = tabItems;
  if (state.phase !== 'ready' || tabItem === undefined) return tabItems;
  const named: NamedLegend = (...rest) => {
    const plain: readonly LegendItem[] = [tabItem, ...rest];
    if (cycleItem === undefined) return plain;
    // The cycle item is the one optional item: it is kept when the whole fits, and then it goes between the tab item and the rest.
    const fitted = fitLegend(
      plain,
      [{ item: cycleItem, priority: 1 }],
      exit,
      usableColumns(LEGEND_FLOOR_COLUMNS),
      displayWidth,
    );
    return fitted.length > plain.length ? [tabItem, cycleItem, ...rest] : plain;
  };
  return state.detail === undefined
    ? listLegendItems(state.read, named)
    : detailLegendItems(state.detail, named, tabItem);
}
