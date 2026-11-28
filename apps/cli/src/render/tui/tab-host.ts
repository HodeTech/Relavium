import type { ActiveRead } from '../../history/active-source.js';
import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { DefinedPort } from '../../history/defined-model.js';
import type { ChatKey } from './chat-input.js';
import { glyph } from './glyphs.js';
import { homeFitsTerminal } from './home-floor.js';
import { isInterruptKey } from './interrupt-keymap.js';
import {
  exitKey,
  fitLegend,
  legend,
  legendSpans,
  type LegendExit,
  type LegendItem,
  type LegendKey,
} from './legend.js';
import {
  clampSpans,
  clipLine,
  thinRuleText,
  usableColumns,
  type SheetGeometry,
  type SheetLine,
  type SheetSpan,
} from './sheet-frame.js';
import {
  activeBody,
  activeLegendItems,
  applyActiveRead,
  failActiveRead,
  foldActiveKey,
  openActiveTab,
  unreadableActiveTab,
  withActiveMessage,
  type ActiveScope,
  type ActiveTabState,
} from './tab-host-active.js';
import {
  HISTORY_KEYS,
  HISTORY_UNREADABLE,
  failHistoryDetail,
  foldHistoryKey,
  historyBody,
  historyLegendItems,
  historyMemoryOf,
  openHistoryTab,
  runPinnedIn,
  unreadableHistoryTab,
  withHistoryDetail,
  withHistoryDetailLoading,
  withHistoryNotice,
  type HistoryMemory,
  type HistoryPort,
  type HistoryTabState,
} from './tab-host-history.js';
import { NODE_KEYS } from './tab-host-node.js';
import type { PinPort } from './tab-host-pin.js';
import { displayWidth } from './viewport.js';

/**
 * The Home's Runs screen ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3 and its 2026-11-27 note; [MVP-11 unit 8](../../../../docs/roadmap/phases/mvp-11/unit-8-plan.md) §5, OD-24 D2): the screen of the run browsers, as a
 * PURE model. It was the tab host of four tabs and two strips; the catalogue (`/workflows`), the agents (`/agents`) and the permissions are popups now
 * (`popups/home-*.ts`, `permissions-popup.ts`), and what is left is the one place you browse and work in for a while: **Active | History**. It holds
 * the tab strip, the keys, what each tab remembers and the lines to draw; it owns no `useInput`, no React and no clock (the host passes the time in),
 * so the key ladder and every sentence are testable without a terminal. `tab-host-view.tsx` paints it and `home-controller.ts` owns the slot it sits in.
 *
 * History lists the finished runs a page at a time and opens one run's detail (`tab-host-history.ts`), where `Enter` ASKS the host to load the detail
 * and `r` ASKS it to run that run's workflow again; Active lists the runs that are not finished (`tab-host-active.ts`), where `Enter` ASKS the host to
 * reopen the hosted run's view or to open a paused run's gate card. `p` on a History row toggles a pin through the {@link PinPort} the host holds
 * (`tab-host-pin.ts`): a pin is a mark, so it is carried out here and answered with a state, and the rows are read again. Nothing else here writes:
 * a run, a detail or a card is a {@link TabHostStep} the host carries out with its own flow. The Active tab is fed from outside: entering it shows the
 * last read the host kept, and the host's poll hands each newer read in ({@link withActiveRead}).
 *
 * - **Both tabs list THIS directory by default** (OD-24 D4): `[a] all` shows the other projects' runs, read-only, and `[a]` again narrows it.
 * - **Keys.** `←` and `→` move between the two tabs (and stop at the ends), `Tab` and `Shift+Tab` cycle, and `Esc` closes the screen (a detail takes its
 *   own `Esc`). `Ctrl+C` closes the screen from any tab and any depth. Everything else is the tab's.
 * - **Entering a tab reads it again.** History is read again every time it is entered; Active is the one tab whose read is asynchronous: it is entered
 *   on the last read the host kept, and the host reads again at once.
 * - **Each tab remembers its position** while the screen lives ({@link TabMemory}): the cursor of every tab, the History tab's scope, status filter and
 *   the run its cursor was on, and the run (and the scope) the Active tab's cursor was on. What one tab remembered is carried by the state of the tab
 *   that is in front ({@link TabHostState.kept}), so that moving to another tab and back finds each tab as it was left; the host drops all of it with
 *   the screen.
 * - **Drawn in at most {@link TAB_HOST_ROWS} rows** at any terminal height, and below 80×24 as one line that says to enlarge.
 */

/** The tabs, in the order the strip draws them. */
export type TabId = 'active' | 'history';

export interface TabDef {
  readonly id: TabId;
  readonly title: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'active', title: 'Active' },
  { id: 'history', title: 'History' },
];

/** The rows the Runs screen may use: what the Home's frame allows at 80×24, less the prompt's line. */
export const TAB_HOST_ROWS = 23;

/**
 * The keys the screen's legend names that are its own; a detail's `Esc` comes from its tab's own table ({@link tabExit} says which leaves where). The
 * test presses every one of them. `Esc` from a tab's list closes the screen and changes nothing: the Close class of ADR-0145 §2.
 */
export const TAB_HOST_KEYS = {
  tab: { keys: '←/→', verb: 'tab' },
  /** `Tab` also moves between the two tabs, which `←/→` already names: it is a key of the screen and not an item of its legend. */
  cycle: { keys: 'Tab', verb: 'cycle' },
  close: exitKey.close(['Esc'], 'back to Home'),
  /**
   * The chord that closes the screen from any depth. From a tab's list it does what `Esc` does, so the two are ONE item there
   * ({@link TAB_HOST_CLOSE_EITHER}); from a detail `Esc` steps back and this chord is a second item that closes, named only where the keys
   * of the screen leave it room.
   */
  interrupt: { keys: 'Ctrl+C', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendKey | LegendExit>>;

/** The way out of a tab's list when both of its keys close the screen and change nothing: one item with the key list, `Esc / [Ctrl+C] back to Home`. */
export const TAB_HOST_CLOSE_EITHER: LegendExit = exitKey.close(['Esc', 'Ctrl+C'], 'back to Home');

/** What a tab remembers: where the cursor was, by tab. */
export type TabPositions = Readonly<Record<TabId, number>>;

/** What the host keeps of a tab host while a screen that came from it is in front: the tab it was on and each tab's position. */
export interface TabMemory {
  readonly tab: TabId;
  readonly positions: TabPositions;
  /** The run the Active tab's cursor was on, so the tab comes back to the run and not only to the row number. */
  readonly activeFocus?: string | undefined;
  /** The scope the Active tab was in (`project` is the default and is kept as absent), so it comes back as it was left. */
  readonly activeScope?: ActiveScope | undefined;
  /** The History tab's scope, filter and the run its cursor was on, so the tab comes back to the run and not only to the row number. */
  readonly history?: HistoryMemory | undefined;
}

/**
 * What the tab that is in front carries of the tabs that are not: the part of the memory that is not a cursor position (a cursor is in
 * {@link TabHostState.positions}, which every tab's state carries whole). Without it the memory built from the tab in front would hold only
 * that tab's own scope, filter and focus, and every move to another tab would forget the History tab's.
 */
export type TabKept = Pick<TabMemory, 'activeFocus' | 'activeScope' | 'history'>;

const TOP: TabPositions = Object.freeze({
  active: 0,
  history: 0,
});

/** Nothing remembered: every tab at its top, on `tab` (the Runs screen opens on History unless a caller names Active). */
export function freshTabMemory(tab: TabId = 'history'): TabMemory {
  return { tab, positions: TOP };
}

export interface TabHostState {
  readonly tab: TabId;
  readonly positions: TabPositions;
  /** The Active tab's list: the last read the host kept when the tab was entered, then every newer read; absent on the other tab. */
  readonly active?: ActiveTabState | undefined;
  /** The History tab: its page, its pinned section and, once opened, a run's detail; absent on the other tab. */
  readonly history?: HistoryTabState | undefined;
  /**
   * What the tab that was in front before this one remembered beyond its cursor (the History tab's scope, filter and focus, the Active tab's
   * focus and scope), carried so that the memory of this state is every tab's and not only the front one's ({@link tabHostMemory}).
   */
  readonly kept?: TabKept | undefined;
}

/** What entering a tab needs: what the Active tab starts from, what History reads, what `p` pins through, the catalogue `r` looks a run's workflow up in, and the clock. */
export interface TabEntry {
  /** What the Active tab starts from, or `undefined` when nothing feeds it (the tab then says it cannot be read): the host's last read. */
  readonly active?: ActiveEntry | undefined;
  /** What the History tab reads (none ⇒ the tab says it cannot be read). */
  readonly history?: HistoryPort | undefined;
  /** What `p` pins and unpins through (none ⇒ `p` says pinning is unavailable). */
  readonly pins?: PinPort | undefined;
  /** The catalogue `r` on a run's detail looks the run's workflow up in: it decides, once, whether the detail offers `[r] run again`. */
  readonly defined?: DefinedPort | undefined;
  readonly now: number;
}

/** What entering the Active tab starts from: the last read the host kept, shown at once and replaced by the next one; `undefined` before any. */
export interface ActiveEntry {
  readonly last: ActiveRead | undefined;
}

/** What a key needs: what entering a tab needs. */
export type TabHostContext = TabEntry;

/** Where a cursor stands now: the list's while it is open, else what was remembered. */
function positionOf(state: TabHostState): number {
  return state.active?.cursor ?? state.history?.cursor ?? state.positions[state.tab];
}

/**
 * `host` with a newer read on the Active tab; the same object when that tab is not the one in front. The read comes from the host's poll,
 * which only runs while the tab is in front, so a read that arrives after the tab was left changes nothing.
 */
export function withActiveRead(host: TabHostState, read: ActiveRead): TabHostState {
  return host.active === undefined ? host : { ...host, active: applyActiveRead(host.active, read) };
}

/** `host` after a read of the Active tab failed (it says so; the list it had stays); the same object when that tab is not in front or already says so. */
export function withActiveFailure(host: TabHostState): TabHostState {
  if (host.active === undefined) return host;
  const active = failActiveRead(host.active);
  return active === host.active ? host : { ...host, active };
}

/** `host` with a sentence on the Active tab, which the next key drops; the same object when that tab is not the one in front. */
export function withActiveNote(host: TabHostState, text: string): TabHostState {
  return host.active === undefined
    ? host
    : { ...host, active: withActiveMessage(host.active, text) };
}

/**
 * `host` with a run's detail the host loaded, on the History tab; the same object when that tab is not in front or is not waiting for
 * that run (a result that arrives after the person left the detail changes nothing). `defined` is the catalog `r` will look the run's
 * workflow up in: it decides, once, whether the detail's legend offers `[r] run again` (see {@link withHistoryDetail}).
 */
export function withHistoryLoad(
  host: TabHostState,
  runId: string,
  load: RunDetailLoad,
  defined?: DefinedPort,
): TabHostState {
  if (host.history === undefined) return host;
  const history = withHistoryDetail(host.history, runId, load, defined);
  return history === host.history ? host : { ...host, history };
}

/**
 * `host` with a sentence the launch a History detail's `r` asked for left, where the person is looking: the detail's message row (the list's
 * own when no detail is open), which the next key drops; the same object when that tab is not the one in front.
 */
export function withHistoryNote(host: TabHostState, text: string): TabHostState {
  return host.history === undefined
    ? host
    : { ...host, history: withHistoryNotice(host.history, text) };
}

/** `host` after the load of a run's detail failed for a reason that is not about the run: the list again, with a sentence. */
export function withHistoryLoadFailure(host: TabHostState, runId: string): TabHostState {
  if (host.history === undefined) return host;
  const history = failHistoryDetail(host.history, runId);
  return history === host.history ? host : { ...host, history };
}

/**
 * The state of the Runs screen as the memory of it: the tab it is on, every tab's position (the current one's included), and what the tabs
 * remember beyond a position. The tab in front is the freshest word on itself; a tab that is not in front, or whose own state holds nothing
 * to remember (a History tab that could not be read, an Active tab with no row), keeps what it remembered before ({@link TabHostState.kept}).
 */
export function tabHostMemory(state: TabHostState): TabMemory {
  const memory: TabMemory = {
    tab: state.tab,
    positions: { ...state.positions, [state.tab]: positionOf(state) },
  };
  const focus = state.active?.focus ?? state.kept?.activeFocus;
  const scope =
    state.active === undefined ? state.kept?.activeScope : activeScopeKept(state.active);
  const history =
    (state.history === undefined ? undefined : historyMemoryOf(state.history)) ??
    state.kept?.history;
  return {
    ...memory,
    ...(focus === undefined ? {} : { activeFocus: focus }),
    ...(scope === undefined ? {} : { activeScope: scope }),
    ...(history === undefined ? {} : { history }),
  };
}

/** The Active tab's scope as the memory keeps it: only the one that is not the default. */
function activeScopeKept(active: ActiveTabState): ActiveScope | undefined {
  return active.scope === 'all' ? 'all' : undefined;
}

/**
 * The Runs screen entered on `tab` with what `memory` holds. Each tab is read as it is entered (History from its port now, Active from the last read the
 * host kept), the cursor where it was last (clamped to the rows there are now).
 */
export function enterTab(memory: TabMemory, tab: TabId, entry: TabEntry): TabHostState {
  return keeping(
    tab === 'active' ? enterActive(memory, entry) : enterHistory(memory, entry),
    memory,
  );
}

/** `host` carrying what `memory` holds beyond a cursor, for the tabs that are not in front; the same object when it holds none. */
function keeping(host: TabHostState, memory: TabMemory): TabHostState {
  const { activeFocus, activeScope, history } = memory;
  if (activeFocus === undefined && activeScope === undefined && history === undefined) return host;
  return { ...host, kept: { activeFocus, activeScope, history } };
}

/**
 * The History tab entered: its first page read now (nothing kept from a visit before), in the scope and filter it was left in. A port that
 * is missing or cannot be read leaves the tab saying so.
 */
function enterHistory(memory: TabMemory, entry: TabEntry): TabHostState {
  const unreadable: TabHostState = {
    tab: 'history',
    positions: memory.positions,
    history: unreadableHistoryTab(),
  };
  if (entry.history === undefined) return unreadable;
  try {
    return {
      ...unreadable,
      history: openHistoryTab(
        entry.history,
        memory.history ?? {
          scope: 'project',
          status: undefined,
          focus: undefined,
          cursor: memory.positions.history,
        },
      ),
    };
  } catch {
    return unreadable;
  }
}

/**
 * The History tab entered with the detail of `runId` already asked for (the strip's `Enter` on a failed or recent run, and `Enter` on a last run
 * of `/workflows`; ADR-0140 §6): the list behind it is read as `enterHistory` reads it, with the cursor on that run when the page lists it, and the
 * host loads the detail. A Home with nothing to read the history from has no detail to ask for, and the tab says it cannot be read.
 */
export function enterHistoryAtDetail(
  memory: TabMemory,
  entry: TabEntry,
  runId: string,
): TabHostState {
  const host = enterHistory(
    {
      ...memory,
      tab: 'history',
      history: { scope: 'project', status: undefined, focus: `row:${runId}`, cursor: 0 },
    },
    entry,
  );
  if (entry.history === undefined || host.history === undefined) return keeping(host, memory);
  // The run may be of another directory, which the project's page does not list: the pin store says whether it is pinned.
  const pinned = runPinnedIn(entry.history, runId, false);
  return keeping(
    { ...host, history: withHistoryDetailLoading(host.history, runId, pinned) },
    memory,
  );
}

/** The Active tab entered on the last read the host kept; a host with nothing to feed it leaves the tab saying it cannot be read. */
function enterActive(memory: TabMemory, entry: TabEntry): TabHostState {
  return {
    tab: 'active',
    positions: memory.positions,
    active:
      entry.active === undefined
        ? unreadableActiveTab()
        : openActiveTab(
            entry.active.last,
            memory.positions.active,
            memory.activeFocus,
            memory.activeScope,
          ),
  };
}

/**
 * What a keystroke does to the open Runs screen: close the screen, become another state, ask the host to run a run's workflow again (`r` on a History
 * detail: the catalog's slug and path of the run's workflow), ask it to reopen the view of the run it hosts or to open the gate card of a paused run
 * of the Active tab, or ask it to load a run's detail on the History tab, each carrying the state the tab is left in. The slug is a catalog entry's
 * own, never a row's label, and a run id is the one the read classified (the host reads the run again before it opens anything).
 */
export type TabHostStep =
  | { readonly kind: 'close'; readonly note?: string }
  | { readonly kind: 'state'; readonly state: TabHostState }
  | {
      readonly kind: 'run';
      readonly slug: string;
      readonly path: string;
      readonly state: TabHostState;
    }
  | { readonly kind: 'open-view'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'open-gate'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'open-detail'; readonly runId: string; readonly state: TabHostState };

/**
 * The tab a key moves to, or `undefined` for a key that moves none. `←`/`→` stop at the ends; `Tab` and `Shift+Tab` go around (with two tabs, to
 * the other one).
 */
function movedTab(current: TabId, key: ChatKey): TabId | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  const at = TABS.findIndex((tab) => tab.id === current);
  const last = TABS.length - 1;
  if (key.leftArrow === true) return TABS[Math.max(0, at - 1)]?.id;
  if (key.rightArrow === true) return TABS[Math.min(last, at + 1)]?.id;
  if (key.tab === true) return TABS[(at + (key.shift === true ? last : 1)) % TABS.length]?.id;
  return undefined;
}

function foldActiveTab(
  state: TabHostState,
  active: ActiveTabState,
  input: string,
  key: ChatKey,
): TabHostStep {
  const step = foldActiveKey(active, input, key);
  const next = step.state === active ? state : { ...state, active: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

function foldHistoryTab(
  state: TabHostState,
  history: HistoryTabState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  // A history that was read has its port: a host that lost it leaves the keys inert rather than freeze the keyboard.
  if (context.history === undefined) return { kind: 'state', state };
  const step = foldHistoryKey(history, input, key, {
    history: context.history,
    pins: context.pins,
    // `r` on a run's detail looks the run's workflow up in the catalogue `/workflows` lists.
    defined: context.defined,
  });
  const next = step.state === history ? state : { ...state, history: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

/** One key into whichever tab is open: the list's of Active or History. */
function foldTabKey(
  state: TabHostState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  if (state.active !== undefined) return foldActiveTab(state, state.active, input, key);
  if (state.history !== undefined) return foldHistoryTab(state, state.history, input, key, context);
  return { kind: 'state', state };
}

/**
 * Fold one keystroke into the open Runs screen. `Ctrl+C` closes from any state. A tab key moves (and reads the tab it lands on again), `Esc` closes a
 * tab that has no detail to go back from (a History detail takes its own `Esc`), and every other key is the list's (which may ask for a run, a view,
 * a card or a detail, or toggle a pin or the scope).
 */
export function foldTabHostKey(
  state: TabHostState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  if (isInterruptKey(input, key)) return { kind: 'close' };
  const to = movedTab(state.tab, key);
  if (to !== undefined) {
    if (to === state.tab) return { kind: 'state', state };
    return { kind: 'state', state: enterTab(tabHostMemory(state), to, context) };
  }
  // `Esc` closes a tab that has no detail to go back from; a run's detail takes its own `Esc`.
  const inDetail = state.history?.detail !== undefined;
  if (key.escape === true && !inDetail) return { kind: 'close' };
  return foldTabKey(state, input, key, context);
}

/** A paste is typing, and nothing the Runs screen answers to. The same object: nothing waits on a question here any more. */
export function disarmTabHost(state: TabHostState): TabHostState {
  return state;
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The terminal width a legend is fitted to when none is named: the Home's 80-column floor, which every legend must fit. */
const LEGEND_FLOOR_COLUMNS = 80;

/** Whether a legend of `width` columns fits a terminal of `columns`: a legend exactly as wide as the usable columns fits (`<=`, never `<`). */
export function legendFits(width: number, columns: number): boolean {
  return width <= usableColumns(columns);
}

/** Whether a legend of `width` columns fits the floor: {@link legendFits} at 80 columns. */
export function legendFitsTheFloor(width: number): boolean {
  return legendFits(width, LEGEND_FLOOR_COLUMNS);
}

/**
 * The key that leaves, by where the screen is: the class belongs to the (surface, state) pair (ADR-0145 §2). On a run's detail or a node page it
 * goes back one level; on a tab's list it closes the screen and changes nothing.
 */
function tabExit(state: TabHostState): LegendExit {
  const detail = state.history?.detail;
  if (detail === undefined) return TAB_HOST_KEYS.close;
  return detail.node === undefined ? HISTORY_KEYS.back : NODE_KEYS.back;
}

/** What the Runs screen's legend draws: the keys it names and, last, the key that leaves with its effect. */
export interface TabHostLegend {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
}

/**
 * The legend: the tab's with the chord named where it fits. On a tab's list `Esc` and `Ctrl+C` do the same (they close the screen and change nothing),
 * so they are one item, `Esc / [Ctrl+C] back to Home`, where the legend still fits the terminal, and `Esc back to Home` alone where it does not (the way
 * out is never cut, and `←/→ tab` is the last of the keys to go: {@link fitLegend}). On a detail the effects differ (`Esc` steps back, `Ctrl+C` closes),
 * so the chord is a second item, as before, where the keys leave it room. It is fitted to `columns`, the width the screen is drawn at (the screen
 * passes its own: a legend that fits 100 columns names the History list's `[f] filter` there, though at 80 it is the first key to go); without
 * one it is fitted to the 80-column floor, which is the narrowest it is ever drawn at (review round 1, D-2).
 */
export function tabHostLegend(
  state: TabHostState,
  columns: number = LEGEND_FLOOR_COLUMNS,
): TabHostLegend {
  const exit = tabExit(state);
  const items = tabLegendItems(state, exit, columns);
  if (exit === TAB_HOST_KEYS.close) {
    const both = legendFits(displayWidth(legend(items, TAB_HOST_CLOSE_EITHER)), columns);
    return { items, exit: both ? TAB_HOST_CLOSE_EITHER : exit };
  }
  return { items: withInterruptItem(items, exit, columns), exit };
}

/**
 * `items` with `Ctrl+C close` just before the way out, when the whole legend still fits `columns`. `Ctrl+C` closes the screen from any
 * depth (ADR-0140 §1), so a person who has gone down a level reads that there is a way out of all of them; where the keys of a screen already fill
 * the floor (the History list's), it is left out for room, and the way out stays last and whole ({@link fitLegend}: the one fit rule of ADR-0145 §3).
 */
function withInterruptItem(
  items: readonly LegendItem[],
  exit: LegendExit,
  columns: number,
): readonly LegendItem[] {
  return fitLegend(
    items,
    [{ item: TAB_HOST_KEYS.interrupt, priority: 1 }],
    exit,
    usableColumns(columns),
    displayWidth,
  );
}

/** The legend as text, as the screen draws it before it is clipped, at `columns` (the 80-column floor when none is named). */
export function tabHostLegendText(
  state: TabHostState,
  columns: number = LEGEND_FLOOR_COLUMNS,
): string {
  const { items, exit } = tabHostLegend(state, columns);
  return legend(items, exit);
}

function tabLegendItems(
  state: TabHostState,
  exit: LegendExit,
  columns: number,
): readonly LegendItem[] {
  // `Tab` is a key of the screen but not an item of its legend: with two tabs `←/→ tab` says it, and the room goes to the keys of the tab.
  const tabItems: readonly LegendItem[] = [TAB_HOST_KEYS.tab];
  if (state.active !== undefined) return activeLegendItems(state.active, tabItems);
  if (state.history !== undefined)
    return historyLegendItems(state.history, tabItems, exit, columns);
  return tabItems;
}

/** Whether the frame can draw the screen: the Home's floor of 80×24. */
export function tabHostCanDraw(geometry: SheetGeometry): boolean {
  return homeFitsTerminal(geometry.columns, geometry.terminalRows);
}

const STRIP_SEPARATOR = '  │  ';
/** The current tab's marker and its space: the one selection marker of the glyph table, in the form in force. */
const currentMark = (): string => `${glyph('selection')} `;

/** The strip of tabs: the current one carries the selection marker and is emphasised, so it is told apart by a glyph as well as by style. */
function tabStrip(current: TabId, width: number): SheetLine {
  let text = '';
  const spans: SheetSpan[] = [];
  TABS.forEach((tab, index) => {
    if (index > 0) {
      spans.push({ from: text.length, to: text.length + STRIP_SEPARATOR.length, role: 'dim' });
      text += STRIP_SEPARATOR;
    }
    const label = tab.id === current ? `${currentMark()}${tab.title}` : tab.title;
    spans.push({
      from: text.length,
      to: text.length + label.length,
      role: tab.id === current ? 'strong' : 'dim',
      ...(tab.id === current ? { selected: true as const } : {}),
    });
    text += label;
  });
  const shown = clipLine(text, width);
  return { kind: 'row', text: shown, spans: clampSpans(spans, shown.length) };
}

function rule(width: number): SheetLine {
  const text = thinRuleText(width);
  return { kind: 'rule', text, spans: [{ from: 0, to: text.length, role: 'dim' }] };
}

/** The legend as a line: the keys apart from the words, clipped to the width. */
function legendLine(items: readonly LegendItem[], exit: LegendExit, width: number): SheetLine {
  const text = clipLine(legend(items, exit), width);
  return { kind: 'legend', text, spans: clampSpans(legendSpans(items, exit), text.length) };
}

/** What a tab says when its data could not be read (Active has its own phase and is never drawn plain). */
const TAB_UNREADABLE: Readonly<Partial<Record<TabId, string>>> = {
  history: HISTORY_UNREADABLE,
};

/** The lines of a tab whose data could not be read. */
function plainBody(state: TabHostState): readonly SheetLine[] {
  return [{ kind: 'failed', text: TAB_UNREADABLE[state.tab] ?? HISTORY_UNREADABLE }];
}

/**
 * What the screen says below the floor: why. `Esc` there is the screen's own key (the Home delivers only `Esc` and `Ctrl+C` below 80×24): it steps
 * back one level on a run's detail and on a node page, and closes the screen only from a tab's list, and the legend under this line says which of the
 * two it is at the level the person is on.
 */
export const TAB_HOST_TOO_SMALL = 'Enlarge the terminal.';

/** What `Esc` does on a run's detail and on a node page: it steps back one level, and the legend says which. */
const TOO_SMALL_BACK_TO_LIST = exitKey.step('Esc', 'back to the list');
const TOO_SMALL_BACK_TO_RUN = exitKey.step('Esc', 'back to the run');

/** The `Esc` the legend below the floor names: the level it steps back to, or `close` from a tab's list (the screen's own rule). */
function tooSmallEscape(state: TabHostState): LegendExit {
  const detail = state.history?.detail;
  if (detail === undefined) return TAB_HOST_CLOSE_EITHER;
  return detail.node === undefined ? TOO_SMALL_BACK_TO_LIST : TOO_SMALL_BACK_TO_RUN;
}

/**
 * The lines when the terminal is below the floor: why (the hint), and the way out (the legend), two lines. The legend names the level
 * `Esc` steps back to, so a run's detail and a node page do not promise a close that the key does not make.
 */
function tooSmallLines(state: TabHostState): readonly SheetLine[] {
  const exit = tooSmallEscape(state);
  return [
    { kind: 'text', text: TAB_HOST_TOO_SMALL },
    { kind: 'legend', text: legend([], exit), spans: legendSpans([], exit) },
  ];
}

/**
 * The screen's lines, top to bottom, for a terminal of this size: the strip and a rule, the tab's body, and the legend. At most
 * {@link TAB_HOST_ROWS} lines, one row spare in a terminal of exactly 24, so the inline renderer never reaches the bottom edge. Below the floor it is
 * two lines: the hint that says to enlarge, and the legend with the way out.
 */
export function tabHostLines(state: TabHostState, geometry: SheetGeometry): readonly SheetLine[] {
  if (!tabHostCanDraw(geometry)) return tooSmallLines(state);
  const width = usableColumns(geometry.columns);
  const budget = Math.min(TAB_HOST_ROWS, geometry.terminalRows - 1);
  const head = [tabStrip(state.tab, width), rule(width)];
  const { items, exit } = tabHostLegend(state, geometry.columns);
  const foot = legendLine(items, exit, width);
  const room = budget - head.length - 1;
  if (state.active !== undefined) return [...head, ...activeBody(state.active, width, room), foot];
  if (state.history !== undefined)
    return [...head, ...historyBody(state.history, width, room), foot];
  return [...head, ...plainBody(state), foot];
}
