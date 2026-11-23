import type { RunStatus } from '@relavium/shared';

import {
  RUN_STATUS_GLYPH,
  nextStatusFilter,
  type HistoryRow,
} from '../../history/history-model.js';
import type {
  HistoryCost,
  HistoryEntry,
  HistoryQuery,
  HistoryRead,
  HistoryScope,
  HistorySource,
} from '../../history/history-source.js';
import { formatDuration } from './format.js';
import { SKIPPED } from '../absence.js';
import { scrubbedBounded, shortRunId, type NodeRow } from '../../history/run-detail-model.js';
import type { NodeDetailLoad } from '../../history/node-detail-source.js';
import type { DetailEvent, RunDetailLoad, RunDetailRead } from '../../history/run-detail-source.js';
import type { ChatKey } from './chat-input.js';
import type { LegendItem } from './legend.js';
import {
  clampSpans,
  clipLine,
  flushRow,
  windowBody,
  type SheetLine,
  type SheetLineKind,
  type SheetSpan,
} from './sheet-frame.js';
import { HELD_GLYPH } from './tab-host-active.js';
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
  toggleRunPin,
  type PinPort,
  type PinToggle,
} from './tab-host-pin.js';
import { displayWidth } from './viewport.js';

/**
 * The History tab of the Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): finished runs as a paged list, and one run's detail as a read-only list of its steps and events. PURE, like
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
 *   is not finished, and a run whose log cannot be read is shown as `unreadable`, never hidden.
 * - **The detail.** `Enter` asks the host to load the run (the terminal outbox is a file, so the load is asynchronous; the tab says
 *   `Reading the run…` until the host hands the result in, {@link withHistoryDetail}). The detail is a list of lines: the header, the
 *   node table, then the events. `↑`/`↓` move, `Esc` and `Backspace` go back to the list on the row it came from. A run whose end is
 *   held in the outbox says `held`, never `in progress`. The table lists the nodes that ran in the order they ran, then the nodes of the run's
 *   frozen workflow that have no record (`history/run-detail-source.ts`). `Enter` on a node row opens the node page (`tab-host-node.ts`, read
 *   now through {@link HistoryPort.loadNode}); `n` puts the cursor on the first node whose LAST attempt failed; `p` pins or unpins the run by
 *   the list's own toggle and reads the list again behind the detail; a sentence a key leaves is dropped by the next.
 * - **Every state has a glyph and a word.** `✓ completed`, `✗ failed`, `⊘ cancelled`, `◐ running`, `◇ held`, `? unreadable`,
 *   `? missing`, `★ pinned`; colour only repeats what the words say.
 * - **Every string from the history file is sanitized** (labels, ids, project roots, node ids, error text) before it is drawn.
 */

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
  /** The cost of each run read so far, by run id (the source keeps the folds; this is what the tab has shown). */
  readonly costs: ReadonlyMap<string, HistoryCost>;
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
  select: { keys: '↑/↓', verb: 'move' },
  open: { keys: 'Enter', verb: 'open' },
  pin: PIN_KEY,
  /** Shown while the scope is this project; the toggle back says `here`. */
  widen: { keys: '[a]', verb: 'all' },
  narrow: { keys: '[a]', verb: 'here' },
  filter: { keys: '[f]', verb: 'filter' },
  scroll: { keys: '↑/↓', verb: 'scroll' },
  /** On a run's detail: the first node whose last attempt failed. The node page's own `n` is {@link NODE_KEYS}. */
  firstFailed: NODE_KEYS.firstFailed,
  back: { keys: 'Esc', verb: 'back' },
} as const satisfies Readonly<Record<string, LegendItem>>;

export const HISTORY_UNREADABLE = 'The run history could not be read.';
export const HISTORY_HINT = 'Finished runs, newest first. Enter opens a run.';
export const HISTORY_LOADING = 'Reading the run…';
export const HISTORY_DETAIL_MISSING = 'That run is not in the history any more. Esc goes back.';
export const HISTORY_DETAIL_UNREADABLE =
  'The event log of this run could not be read. relavium logs shows what is wrong with it.';
export const HISTORY_DETAIL_FAULT = 'The run could not be loaded just now. Enter tries again.';
export const HISTORY_REREAD_FAILED = 'The history could not be read again.';
export const HISTORY_NO_FAILED_NODE = 'No node of this run ended failed.';
export const HISTORY_MISSING_RUN =
  'That pinned run is not in the history any more. p removes the pin.';
export const HISTORY_HELD_NOTE =
  'Its end is held in the outbox: the run is over, but its record has no end. relavium status shows what to do.';
export const HISTORY_HELD_UNREAD =
  'Outbox unreadable: this run’s end may be held, and it may not be running.';

/** How many rows either side of the cursor have their cost read: more than any screen draws, so a drawn row always has one. */
export const HISTORY_COST_REACH = 10;
/** How far `PgUp` and `PgDn` move. */
export const HISTORY_PAGE_STEP = 8;
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

function costOf(state: HistoryTabState, row: HistoryRow): HistoryCost | undefined {
  return state.costs.get(row.id);
}

// ---- Opening, reading again -------------------------------------------------------------------------------------------------

/** The tab for a Home that has nothing to read it from, or whose first read failed. */
export function unreadableHistoryTab(): HistoryTabState {
  return { phase: 'unreadable', read: undefined, cursor: 0, focus: undefined, costs: new Map() };
}

/**
 * The costs of the rows within {@link HISTORY_COST_REACH} of `cursor`, added to `known` (through the source, which keeps each fold). The
 * same map when every one of them is already known, so a key that scrolls over rows already read costs nothing.
 */
function costsAround(
  known: ReadonlyMap<string, HistoryCost>,
  read: HistoryRead,
  port: HistorySource,
  cursor: number,
): ReadonlyMap<string, HistoryCost> {
  const entries = entriesOf(read);
  const from = Math.max(0, cursor - HISTORY_COST_REACH);
  const to = Math.min(entries.length, cursor + HISTORY_COST_REACH + 1);
  let costs: Map<string, HistoryCost> | undefined;
  for (let index = from; index < to; index += 1) {
    const entry = entries[index];
    if (entry?.kind !== 'run' || known.has(entry.row.id) || costs?.has(entry.row.id) === true)
      continue;
    costs ??= new Map(known);
    costs.set(entry.row.id, port.cost(entry.row));
  }
  return costs ?? known;
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
  const next: HistoryDetailState =
    load.kind === 'ready'
      ? { runId, phase: 'ready', read: load.detail, cursor: 0 }
      : { runId, phase: load.kind, cursor: 0 };
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

/** The run is pinned, as the list the detail was opened from says (the list is read again after every pin). */
function isRunPinned(read: HistoryRead | undefined, runId: string): boolean {
  return entriesOf(read).some(
    (entry) => entry.kind === 'run' && entry.row.id === runId && entry.row.pinned,
  );
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
  if (input === 'p') return { kind: 'state', state: pinDetail(held, cleared, context) };
  if (input === 'n') return { kind: 'state', state: jumpToFirstFailed(held, cleared, read) };
  if (key.return === true) return { kind: 'state', state: openNode(held, cleared, read, context) };
  const last = detailLineCount(read) - 1;
  let to = detail.cursor;
  if (key.upArrow === true) to -= 1;
  else if (key.downArrow === true) to += 1;
  else if (key.pageUp === true) to -= HISTORY_PAGE_STEP;
  else if (key.pageDown === true) to += HISTORY_PAGE_STEP;
  else if (key.home === true) to = 0;
  else if (key.end === true) to = last;
  else return { kind: 'state', state: held };
  to = clamp(to, last);
  return to === cleared.cursor
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
  // The cap changed nothing, so there is nothing to read again.
  if (toggled.outcome === 'full') return withHistoryMessage(state, toggled.message);
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

/**
 * `p` on a run's detail: the same pin toggle as on its row, under the run's canonical key. The list the detail was opened from is read again, so
 * its pinned section and its row's mark are the store's, and the cursor stays on the run.
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
    pinned: isRunPinned(list, detail.runId),
    rowid: undefined,
  });
  // The cap changed nothing, so there is nothing to read again.
  if (toggled.outcome === 'full' || list === undefined)
    return withDetailMessage(state, detail, toggled.message);
  const again = reread(
    state,
    context.history,
    { ...list.query },
    [`row:${detail.runId}`, `pin:${detail.runId}`],
    state.cursor,
  );
  return withDetailMessage(
    again ?? state,
    detail,
    again === undefined ? `${toggled.message} ${HISTORY_REREAD_FAILED}` : toggled.message,
  );
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
  const stay: HistoryStep = { kind: 'state', state: cleared };
  if (read === undefined || key.ctrl === true || key.meta === true) return stay;
  const count = read.pinned.length + read.rows.length;
  const move = (to: number): HistoryStep =>
    to === state.cursor
      ? stay
      : {
          kind: 'state',
          state: {
            ...cleared,
            cursor: to,
            focus: keyOf(read, to),
            // The rows that scroll into view are read now; the source keeps each fold, and a row already read is not read again.
            costs: costsAround(cleared.costs, read, context.history, to),
          },
        };
  // On the next page the cursor starts on its first row (past the pinned section, which stays above every page); on the previous page it
  // starts at the very end, so the walk back reads as the walk forward in reverse.
  const changePage = (page: number, onRows: 'first' | 'last'): HistoryStep => {
    const again = reread(cleared, context.history, { ...read.query, page }, [], (next) => {
      const entries = next.pinned.length + next.rows.length;
      return onRows === 'first' ? Math.min(next.pinned.length, entries - 1) : entries - 1;
    });
    return {
      kind: 'state',
      state: again ?? withHistoryMessage(cleared, HISTORY_REREAD_FAILED),
    };
  };
  if (key.downArrow === true) {
    if (state.cursor >= count - 1 && read.hasNext) return changePage(read.query.page + 1, 'first');
    return move(clamp(state.cursor + 1, count - 1));
  }
  if (key.upArrow === true) {
    if (state.cursor <= 0 && read.hasPrev) return changePage(read.query.page - 1, 'last');
    return move(clamp(state.cursor - 1, count - 1));
  }
  if (key.pageDown === true) return move(clamp(state.cursor + HISTORY_PAGE_STEP, count - 1));
  if (key.pageUp === true) return move(clamp(state.cursor - HISTORY_PAGE_STEP, count - 1));
  if (key.home === true) return move(0);
  if (key.end === true) return move(clamp(count - 1, count - 1));
  if (key.return === true) {
    const entry = entriesOf(read)[state.cursor];
    if (entry === undefined) return stay;
    if (entry.kind === 'missing')
      return { kind: 'state', state: withHistoryMessage(cleared, HISTORY_MISSING_RUN) };
    const detail: HistoryDetailState = { runId: entry.row.id, phase: 'loading', cursor: 0 };
    return {
      kind: 'open-detail',
      runId: entry.row.id,
      state: { ...cleared, detail },
    };
  }
  if (input === 'p') return { kind: 'state', state: pinSelected(cleared, read, context) };
  if (input === 'a' || input === 'f') {
    const query: HistoryQuery =
      input === 'a'
        ? {
            scope: read.query.scope === 'project' ? 'all' : 'project',
            status: read.query.status,
            page: 0,
          }
        : { scope: read.query.scope, status: nextStatusFilter(read.query.status), page: 0 };
    const again = reread(cleared, context.history, query, [], 0);
    return {
      kind: 'state',
      state: again ?? withHistoryMessage(cleared, HISTORY_REREAD_FAILED),
    };
  }
  return stay;
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

const POINTER = '› ';
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

function costWords(cost: HistoryCost | undefined): string {
  if (cost === undefined) return '…';
  if (cost.kind === 'text') return clipLine(cost.text, COST_COLUMN);
  return cost.kind === 'not-final' ? 'not final' : '—';
}

/** The glyph and the word of a run row: its status, or `unreadable` when its log could not be read. */
function stateOf(row: HistoryRow, cost: HistoryCost | undefined): { glyph: string; word: string } {
  if (cost?.kind === 'unreadable') return { glyph: '?', word: 'unreadable' };
  return { glyph: row.glyph, word: row.word };
}

function entryLine(
  entry: HistoryEntry,
  selected: boolean,
  state: HistoryTabState,
  width: number,
): SheetLine {
  const lead = selected ? POINTER : INDENT;
  if (entry.kind === 'missing') {
    const left = `${lead}? ${'missing'.padEnd(WORD_WIDTH)} ${entry.label}`;
    const tail = '★ pinned';
    const text = flushRow(left, tail, width);
    return { kind: selected ? 'selected' : 'row', text, spans: tailSpan(text, tail, selected) };
  }
  const { row } = entry;
  const cost = costOf(state, row);
  const { glyph, word } = stateOf(row, cost);
  const left = `${lead}${glyph} ${word.padEnd(WORD_WIDTH)} ${row.shortId}  ${row.label}`;
  const tail = [row.ageText, costWords(cost), row.pinned ? '★ pinned' : '']
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
      text: clipLine('No run has this id any more; p removes the pin.', width),
    };
  const { row } = entry;
  const cost = costOf(state, row);
  const money =
    cost?.kind === 'text'
      ? `cost ${cost.text}`
      : cost?.kind === 'unreadable'
        ? `its event log could not be read (it was ${row.word})`
        : cost?.kind === 'not-final'
          ? 'not finished: its cost is not final'
          : '';
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
  if (status !== undefined) return `No ${status} run here. f changes the filter.`;
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
      ? { kind: 'hint', text: clipLine(HISTORY_HINT, width) }
      : { kind: 'notice', text: clipLine(state.message, width) };
  const count = read.pinned.length + read.rows.length;
  if (count === 0) {
    const empty: SheetLine = { kind: 'text', text: clipLine(emptyText(read), width) };
    return [status, empty, footer].slice(0, room);
  }
  const lines = listLines(state, read, width);
  const height = Math.max(3, room - 3);
  const cursorLine = lines.findIndex((line) => line.entry === state.cursor);
  const { start, end } = windowBody(lines.length, Math.max(0, cursorLine), height);
  const shown: SheetLine[] = lines.slice(start, end).map((line) => line.line);
  if (start > 0 && shown.length > 0)
    shown[0] = { kind: 'marker', text: `▲ ${String(entriesIn(lines, 0, start + 1))} more` };
  if (end < lines.length && shown.length > 0)
    shown[shown.length - 1] = {
      kind: 'marker',
      text: `▼ ${String(entriesIn(lines, end - 1, lines.length))} more`,
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
  const left = `  ${row.glyph} ${row.status.padEnd(WORD_WIDTH)} ${row.label}`;
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
function headerState(read: RunDetailRead): { glyph: string; word: string } {
  return read.terminalHeld
    ? { glyph: HELD_GLYPH, word: 'held' }
    : { glyph: RUN_STATUS_GLYPH[read.status], word: read.status };
}

/**
 * The detail's lines before the events: the header, its notes, the node table. Width-independent; the draw clips. `pinned` only adds the
 * `★ pinned` mark to the header, so the lines a key counts are the same whether or not the run is pinned.
 */
function detailHead(read: RunDetailRead, pinned: boolean): readonly DetailLine[] {
  const { header, rows, unattributedRow } = read.model;
  const { glyph, word } = headerState(read);
  const lines: DetailLine[] = [
    {
      kind: 'heading',
      left: `${glyph} ${word}  ${header.workflow}  ${header.shortId}${pinned ? '  ★ pinned' : ''}`,
    },
  ];
  const duration =
    header.durationMs !== undefined
      ? formatDuration(header.durationMs)
      : read.terminalHeld
        ? 'end held'
        : 'not finished';
  lines.push({
    kind: 'text',
    left: `Started ${header.startedAt ?? 'not recorded'}  ·  took ${duration}`,
  });
  lines.push({ kind: 'text', left: `Tokens ${header.tokensText}  ·  cost ${header.costText}` });
  if (header.error !== undefined) {
    const { code, message, nodeId } = header.error;
    const where = nodeId === undefined ? '' : ` (node ${nodeId})`;
    lines.push({
      kind: 'failed',
      left: `${code === undefined ? 'Error' : `Error ${code}`}: ${message ?? 'no message recorded'}${where}`,
    });
  }
  if (read.terminalHeld) lines.push({ kind: 'notice', left: HISTORY_HELD_NOTE });
  if (read.heldUnread) lines.push({ kind: 'notice', left: HISTORY_HELD_UNREAD });
  if (!read.eventsComplete)
    lines.push({
      kind: 'notice',
      left: `Only the first ${String(read.events.length)} events were read: the figures may be partial. relavium logs shows the rest.`,
    });
  if (read.skippedRows > 0)
    lines.push({
      kind: 'notice',
      left: `${String(read.skippedRows)} ${read.skippedRows === 1 ? 'row was' : 'rows were'} written by a newer version and skipped.`,
    });
  lines.push({ kind: 'heading', left: `Nodes (${String(rows.length)})` });
  if (rows.length === 0) lines.push({ kind: 'text', left: '  no node was recorded' });
  for (const row of rows) lines.push(nodeLine(row));
  if (unattributedRow !== undefined)
    lines.push({ kind: 'row', left: `    ${unattributedRow.label}`, right: unattributedRow.text });
  return lines;
}

function eventLine(event: DetailEvent): DetailLine {
  const node = event.nodeId === undefined ? '' : ` ${scrubbedBounded(event.nodeId)}`;
  return { kind: 'row', left: `  #${String(event.seq)}  ${event.type}${node}` };
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
  const head = detailHead(read, isRunPinned(state.read, detail.runId));
  const total = detailLineCount(read);
  const lineAt = (index: number): DetailLine => {
    const inHead = head[index];
    if (inHead !== undefined) return inHead;
    if (index === head.length)
      return {
        kind: 'heading',
        left: `Events (${String(read.events.length)}${read.eventsComplete ? '' : '+'})`,
      };
    const event = read.events[index - head.length - 1];
    return event === undefined ? { kind: 'text', left: '' } : eventLine(event);
  };
  const height = Math.max(3, room - 1);
  const { start, end } = windowBody(total, detail.cursor, height);
  const lines: SheetLine[] = [];
  for (let index = start; index < end; index += 1) {
    const line = lineAt(index);
    const selected = index === detail.cursor;
    const lead = selected ? POINTER : INDENT;
    const left = `${lead}${line.left}`;
    const right = line.parts === undefined ? (line.right ?? '') : fitParts(left, line.parts, width);
    lines.push({ kind: selected ? 'selected' : line.kind, text: flushRow(left, right, width) });
  }
  if (start > 0 && lines.length > 0)
    lines[0] = { kind: 'marker', text: `▲ ${String(start + 1)} more` };
  if (end < total && lines.length > 0)
    lines[lines.length - 1] = { kind: 'marker', text: `▼ ${String(total - end + 1)} more` };
  const footer: SheetLine =
    detail.message === undefined
      ? { kind: 'hint', text: clipLine('Read-only: a run is never changed from here.', width) }
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

/**
 * The legend's items: the detail's, or the list's (the tab host's tab item first, the way out last). A tab that could not be read names
 * the tab keys the other tabs without a list name.
 */
export function historyLegendItems(
  state: HistoryTabState,
  tabItems: readonly LegendItem[],
  closeItem: LegendItem,
): readonly LegendItem[] {
  const [tabItem] = tabItems;
  if (state.phase !== 'ready' || tabItem === undefined) return [...tabItems, closeItem];
  if (state.detail?.node !== undefined) return nodeLegendItems(state.detail.node, tabItem);
  // A detail that is still loading, missing or unreadable answers only to scrolling and the way back.
  if (state.detail !== undefined && state.detail.phase !== 'ready')
    return [tabItem, HISTORY_KEYS.scroll, HISTORY_KEYS.back];
  if (state.detail !== undefined)
    return [
      tabItem,
      HISTORY_KEYS.scroll,
      HISTORY_KEYS.open,
      HISTORY_KEYS.firstFailed,
      HISTORY_KEYS.pin,
      HISTORY_KEYS.back,
    ];
  const scope = state.read?.query.scope === 'all' ? HISTORY_KEYS.narrow : HISTORY_KEYS.widen;
  if (state.read === undefined || state.read.pinned.length + state.read.rows.length === 0)
    return [tabItem, scope, HISTORY_KEYS.filter, closeItem];
  return [
    tabItem,
    HISTORY_KEYS.select,
    HISTORY_KEYS.open,
    HISTORY_KEYS.pin,
    scope,
    HISTORY_KEYS.filter,
    closeItem,
  ];
}
