import { scrubSecrets } from '@relavium/llm/scrub-secrets';

import type { ActiveRead } from '../../history/active-source.js';
import type { HomeAgentRequest } from '../../home/agent-start.js';
import type { AgentsPort } from '../../home/agents-port.js';
import type { RunDetailLoad } from '../../history/run-detail-source.js';
import type { PermissionsPort, RepoAllowlist } from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import { glyph } from './glyphs.js';
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
  disarmPermissionsSheet,
  permissionsSheetBody,
  permissionsSheetChrome,
  sheetCanArm,
  sheetEntries,
  SHEET_KEYS,
  SHEET_LEGEND_ARMED_ITEMS,
  type PermissionsSheetState,
} from './permissions-sheet.js';
import {
  foldPermissionsSheetThroughPort,
  openPermissionsSheetThroughPort,
  PERMISSIONS_UNREADABLE,
} from './permissions-sheet-port.js';
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
  AGENTS_KEYS,
  AGENTS_UNREADABLE,
  agentsBody,
  agentsLegendItems,
  foldAgentsKey,
  openAgentsTab,
  type AgentsTabState,
} from './tab-host-agents.js';
import {
  activeBody,
  activeLegendItems,
  applyActiveRead,
  failActiveRead,
  foldActiveKey,
  openActiveTab,
  unreadableActiveTab,
  withActiveMessage,
  type ActiveTabState,
} from './tab-host-active.js';
import {
  DEFINED_UNREADABLE,
  definedBody,
  definedLegendItems,
  foldDefinedKey,
  openDefinedTab,
  pinOnDefined,
  withDefinedMessage,
  type DefinedPort,
  type DefinedTabState,
} from './tab-host-workflows.js';
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
import {
  SESSIONS_UNREADABLE,
  foldSessionsKey,
  openSessionsTab,
  sessionsBody,
  sessionsLegendItems,
  withSessionsMessage,
  type SessionsPort,
  type SessionsTabState,
} from './tab-host-sessions.js';
import { escapeReviewCharacter } from './tool-review-projection.js';
import { displayWidth } from './viewport.js';

/**
 * The Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3): the screen of the management browsers, as a PURE model. It holds the tab strip, the keys, what each tab remembers and the lines
 * to draw; it owns no `useInput`, no React and no clock (the host passes the time in), so the key ladder and every sentence are testable
 * without a terminal, as the sheet's are. `tab-host-view.tsx` paints it and `home-controller.ts` owns the slot it sits in.
 *
 * Two strips share the screen, each with its own tab set ({@link tabSetOf}; ADR-0140's 2026-11-23 note): the workflows strip has Defined,
 * Active, History and Permissions, and the `/agents` strip has Defined and Sessions, as `agents` and `sessions` (`tab-host-agents.ts` and
 * `tab-host-sessions.ts`). A tab's id says which strip it is on, so the screen slot needs no field for it. On the agents strip `Enter` on a
 * Sessions row ASKS the host to resume that conversation in place ({@link TabHostStep} `resume`), and `c` on an agent's detail ASKS it to start
 * a chat bound to that agent ({@link TabHostStep} `chat`, carrying the catalog's own path of the file the detail showed).
 *
 * Four tabs on the workflows strip: History lists the finished runs a page at a time and opens one run's detail (`tab-host-history.ts`), where `Enter` ASKS the host
 * to load the detail; Permissions is the ADR-0137 sheet composed under the tab strip (its body, its keys and its `Esc` ladder are the sheet's,
 * and the repository's `[chat]` allowlist is added under the list as read-only rows); Defined lists the project's workflows with their pins
 * (`tab-host-workflows.ts`), where `r` and `x` ASK the host to run or export a row; and Active lists the runs that are not finished
 * (`tab-host-active.ts`), where `Enter` ASKS the host to reopen the hosted run's view or to open a paused run's gate card. `p` on a Defined
 * row or a History row toggles a pin through the {@link PinPort} the host holds (`tab-host-pin.ts`): a pin is a mark, so it is carried out
 * here and answered with a state, and the rows are read again. Nothing else here writes: a withdrawal is carried out through the port the
 * host holds, and a run, an export, a detail or a card is a {@link TabHostStep} the host carries out with its own flow. The Active tab is
 * fed from outside: entering it shows the last read the host kept, and the host's poll hands each newer read in ({@link withActiveRead}).
 *
 * - **Keys.** `←` and `→` move between tabs (and stop at the ends), `Tab` and `Shift+Tab` cycle around them, and `Esc` closes the screen
 *   (on Permissions, once a withdrawal's question is dropped). `Ctrl+C` closes the screen from any tab and never withdraws. Everything
 *   else on Permissions is the sheet's, `Backspace` included: there it is a withdraw key and not a way back (the maintainer's ruling for
 *   this increment), so the ADR's "Backspace goes back" is not applied on that tab.
 * - **Entering a tab reads it again.** Permissions and Defined are read from their ports every time the tab is entered, never from what
 *   was shown the last time, and a tab entered again starts as a new sheet does: the settle time counts again and nothing typed before counts.
 *   Active is the one tab whose read is asynchronous: it is entered on the last read the host kept, and the host reads again at once.
 * - **Each tab remembers its position** while the screen lives ({@link TabMemory}): the cursor of every tab, the History tab's scope, status
 *   filter and the run its cursor was on, and the run the Active tab's cursor was on. What one tab remembered is carried by the state of the
 *   tab that is in front ({@link TabHostState.kept}), so that moving to another tab and back finds each tab as it was left; the host drops
 *   all of it with the screen.
 * - **Drawn in at most {@link TAB_HOST_ROWS} rows** at any terminal height, and below 80×24 as one line that says to enlarge.
 */

/** The tabs, in the order the strip draws them. */
export type TabId = 'defined' | 'active' | 'history' | 'permissions' | 'agents' | 'sessions';

export interface TabDef {
  readonly id: TabId;
  readonly title: string;
}

export const TABS: readonly TabDef[] = [
  { id: 'defined', title: 'Defined' },
  { id: 'active', title: 'Active' },
  { id: 'history', title: 'History' },
  { id: 'permissions', title: 'Permissions' },
];

/**
 * The tabs of the `/agents` strip, in the order it draws them. The ids differ from the workflows strip's (`agents` is the strip's Defined,
 * `sessions` its Sessions), so that a tab id alone says which strip the screen is on, and a key never moves between strips.
 */
export const AGENT_TABS: readonly TabDef[] = [
  { id: 'agents', title: 'Defined' },
  { id: 'sessions', title: 'Sessions' },
];

/** The strip `tab` is on: its tabs in the order they are drawn, and the order `←`/`→` and `Tab` move through. */
export function tabSetOf(tab: TabId): readonly TabDef[] {
  return tab === 'agents' || tab === 'sessions' ? AGENT_TABS : TABS;
}

/** The rows the tab host may use: what the Home's frame allows at 80×24, less the prompt's line. */
export const TAB_HOST_ROWS = 23;

/** The most rows the allowlist section takes: its heading, its note and four entries (the last of them a count when more are listed). */
const ALLOWLIST_ENTRY_ROWS = 4;

/**
 * The keys the tab host's legend names that are its own; the sheet's keys come from `SHEET_KEYS`, a detail's `Esc` from its tab's own table
 * ({@link tabExit} says which leaves where). The test presses every one of them. `Esc` from a tab's list closes the screen and changes
 * nothing: the Close class of ADR-0145 §2.
 */
export const TAB_HOST_KEYS = {
  tab: { keys: '←/→', verb: 'tab' },
  cycle: { keys: 'Tab', verb: 'cycle' },
  close: exitKey.close(),
  /**
   * The chord that closes the screen from any depth. From a tab's list it does what `Esc` does, so the two are ONE item there
   * ({@link TAB_HOST_CLOSE_EITHER}); from a detail `Esc` steps back and this chord is a second item that closes, named only where the keys
   * of the screen leave it room.
   */
  interrupt: { keys: 'Ctrl+C', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendKey>>;

/** The way out of a tab's list when both of its keys close the screen and change nothing: one item with the key list, `Esc / [Ctrl+C] close`. */
export const TAB_HOST_CLOSE_EITHER: LegendExit = exitKey.close(['Esc', 'Ctrl+C']);

/** The legend of a tab with nothing to select; its way out is {@link TAB_HOST_KEYS.close}. */
export const TAB_HOST_LEGEND_PLAIN_ITEMS: readonly LegendItem[] = [
  TAB_HOST_KEYS.tab,
  TAB_HOST_KEYS.cycle,
];
/** The legend of the Permissions tab with a row to select: the tab keys, and the sheet's select and withdraw; its way out is {@link TAB_HOST_KEYS.close}. */
export const TAB_HOST_LEGEND_ROWS_ITEMS: readonly LegendItem[] = [
  TAB_HOST_KEYS.tab,
  TAB_HOST_KEYS.cycle,
  SHEET_KEYS.select,
  SHEET_KEYS.withdraw,
];

/** What a tab remembers: where the cursor was, by tab. */
export type TabPositions = Readonly<Record<TabId, number>>;

/** What the host keeps of a tab host while a screen that came from it is in front: the tab it was on and each tab's position. */
export interface TabMemory {
  readonly tab: TabId;
  readonly positions: TabPositions;
  /** The run the Active tab's cursor was on, so the tab comes back to the run and not only to the row number. */
  readonly activeFocus?: string | undefined;
  /** The History tab's scope, filter and the run its cursor was on, so the tab comes back to the run and not only to the row number. */
  readonly history?: HistoryMemory | undefined;
}

/**
 * What the tab that is in front carries of the tabs that are not: the part of the memory that is not a cursor position (a cursor is in
 * {@link TabHostState.positions}, which every tab's state carries whole). Without it the memory built from the tab in front would hold only
 * that tab's own scope, filter and focus, and every move to another tab would forget the History tab's.
 */
export type TabKept = Pick<TabMemory, 'activeFocus' | 'history'>;

const TOP: TabPositions = Object.freeze({
  defined: 0,
  active: 0,
  history: 0,
  permissions: 0,
  agents: 0,
  sessions: 0,
});

/** Nothing remembered: every tab at its top, on `tab`. */
export function freshTabMemory(tab: TabId = 'permissions'): TabMemory {
  return { tab, positions: TOP };
}

export interface TabHostState {
  readonly tab: TabId;
  readonly positions: TabPositions;
  /** The Permissions tab's sheet, read when the tab was entered; `undefined` on any other tab and when Permissions could not be read. */
  readonly sheet: PermissionsSheetState | undefined;
  /** The Defined tab's list, read when the tab was entered; absent on any other tab and when Defined could not be read. */
  readonly defined?: DefinedTabState | undefined;
  /** The Active tab's list: the last read the host kept when the tab was entered, then every newer read; absent on any other tab. */
  readonly active?: ActiveTabState | undefined;
  /** The History tab: its page, its pinned section and, once opened, a run's detail; absent on any other tab. */
  readonly history?: HistoryTabState | undefined;
  /** The Defined agents tab: its list and, once opened, an agent's detail; absent on any other tab and when it could not be read. */
  readonly agents?: AgentsTabState | undefined;
  /** The Sessions tab: this project's saved conversations; absent on any other tab and when it could not be read. */
  readonly sessions?: SessionsTabState | undefined;
  /** Permissions, Defined, agents or sessions was entered and its port could not be read: the tab says so instead of listing anything. */
  readonly unreadable: boolean;
  /**
   * What the tabs that were in front before this one remembered beyond their cursors (the History tab's scope, filter and focus, the
   * Active tab's focus), carried so that the memory of this state is every tab's and not only the front one's ({@link tabHostMemory}).
   */
  readonly kept?: TabKept | undefined;
}

/**
 * What entering a tab needs: the port to read Permissions from and the one to read Defined from (none ⇒ that tab says it is unreadable),
 * and the monotonic clock.
 */
export interface TabEntry {
  readonly port: PermissionsPort | undefined;
  readonly defined?: DefinedPort | undefined;
  /** What the Active tab starts from, or `undefined` when nothing feeds it (the tab then says it cannot be read): the host's last read. */
  readonly active?: ActiveEntry | undefined;
  /** What the History tab reads (none ⇒ the tab says it cannot be read). */
  readonly history?: HistoryPort | undefined;
  /** What `p` pins and unpins through (none ⇒ `p` says pinning is unavailable). */
  readonly pins?: PinPort | undefined;
  /** What the Defined agents tab reads (none ⇒ that tab says it cannot list). */
  readonly agents?: AgentsPort | undefined;
  /** What the Sessions tab reads (none ⇒ that tab says it cannot list). */
  readonly sessions?: SessionsPort | undefined;
  readonly now: number;
}

/** What entering the Active tab starts from: the last read the host kept, shown at once and replaced by the next one; `undefined` before any. */
export interface ActiveEntry {
  readonly last: ActiveRead | undefined;
}

/** What a key needs, on top of what entering a tab needs: whether the frame can show a withdrawal's question. */
export interface TabHostContext extends TabEntry {
  readonly canArm: boolean;
}

/** Where a cursor stands now: the sheet's or the list's while it is open, else what was remembered. */
function positionOf(state: TabHostState): number {
  return (
    state.sheet?.cursor ??
    state.defined?.cursor ??
    state.active?.cursor ??
    state.history?.cursor ??
    state.agents?.cursor ??
    state.sessions?.cursor ??
    state.positions[state.tab]
  );
}

/** `host` with a sentence on the Sessions tab, which the next key drops; the same object when that tab is not the one in front. */
export function withSessionsNote(host: TabHostState, text: string): TabHostState {
  return host.sessions === undefined
    ? host
    : { ...host, sessions: withSessionsMessage(host.sessions, text) };
}

/** `host` with a sentence on the Defined tab, which the next key drops; the same object when that tab is not the one in front. */
export function withDefinedNote(host: TabHostState, text: string): TabHostState {
  return host.defined === undefined
    ? host
    : { ...host, defined: withDefinedMessage(host.defined, text) };
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
 * that run (a result that arrives after the person left the detail changes nothing).
 */
export function withHistoryLoad(
  host: TabHostState,
  runId: string,
  load: RunDetailLoad,
): TabHostState {
  if (host.history === undefined) return host;
  const history = withHistoryDetail(host.history, runId, load);
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
 * The state of the tab host as the memory of it: the tab it is on, every tab's position (the current one's included), and what the tabs
 * remember beyond a position. The tab in front is the freshest word on itself; a tab that is not in front, or whose own state holds nothing
 * to remember (a History tab that could not be read, an Active tab with no row), keeps what it remembered before ({@link TabHostState.kept}).
 */
export function tabHostMemory(state: TabHostState): TabMemory {
  const memory: TabMemory = {
    tab: state.tab,
    positions: { ...state.positions, [state.tab]: positionOf(state) },
  };
  const focus = state.active?.focus ?? state.kept?.activeFocus;
  const history =
    (state.history === undefined ? undefined : historyMemoryOf(state.history)) ??
    state.kept?.history;
  return {
    ...memory,
    ...(focus === undefined ? {} : { activeFocus: focus }),
    ...(history === undefined ? {} : { history }),
  };
}

/**
 * The tab host entered on `tab` with what `memory` holds. Entering Permissions reads its port NOW, and puts the cursor where it was last
 * (clamped to the rows there are now); a port that cannot be read leaves `unreadable` set and no sheet.
 */
export function enterTab(memory: TabMemory, tab: TabId, entry: TabEntry): TabHostState {
  return keeping(enterOn(memory, tab, entry), memory);
}

/** `host` carrying what `memory` holds beyond a cursor, for the tabs that are not in front; the same object when it holds none. */
function keeping(host: TabHostState, memory: TabMemory): TabHostState {
  const { activeFocus, history } = memory;
  if (activeFocus === undefined && history === undefined) return host;
  return { ...host, kept: { activeFocus, history } };
}

function enterOn(memory: TabMemory, tab: TabId, entry: TabEntry): TabHostState {
  if (tab === 'defined') return enterDefined(memory, entry);
  if (tab === 'active') return enterActive(memory, entry);
  if (tab === 'history') return enterHistory(memory, entry);
  if (tab === 'agents') return enterAgents(memory, entry);
  if (tab === 'sessions') return enterSessions(memory, entry);
  const opened =
    entry.port === undefined
      ? undefined
      : openPermissionsSheetThroughPort(entry.port, undefined, entry.now).sheet;
  if (opened === undefined)
    return { tab, positions: memory.positions, sheet: undefined, unreadable: true };
  const last = sheetEntries(opened.snapshot).length - 1;
  const cursor = Math.max(0, Math.min(memory.positions.permissions, last));
  return { tab, positions: memory.positions, sheet: { ...opened, cursor }, unreadable: false };
}

/** The Defined agents tab entered: its port read now, the cursor where it was last. A port that is missing or cannot be read leaves `unreadable` set. */
function enterAgents(memory: TabMemory, entry: TabEntry): TabHostState {
  const unreadable: TabHostState = {
    tab: 'agents',
    positions: memory.positions,
    sheet: undefined,
    unreadable: true,
  };
  if (entry.agents === undefined) return unreadable;
  try {
    return {
      tab: 'agents',
      positions: memory.positions,
      sheet: undefined,
      agents: openAgentsTab(entry.agents.read(), memory.positions.agents),
      unreadable: false,
    };
  } catch {
    return unreadable;
  }
}

/** The Sessions tab entered: its port read now, the cursor where it was last. A port that is missing or cannot be read leaves `unreadable` set. */
function enterSessions(memory: TabMemory, entry: TabEntry): TabHostState {
  const unreadable: TabHostState = {
    tab: 'sessions',
    positions: memory.positions,
    sheet: undefined,
    unreadable: true,
  };
  if (entry.sessions === undefined) return unreadable;
  try {
    return {
      tab: 'sessions',
      positions: memory.positions,
      sheet: undefined,
      sessions: openSessionsTab(entry.sessions.read(), memory.positions.sessions),
      unreadable: false,
    };
  } catch {
    return unreadable;
  }
}

/** The Defined tab entered: its port read now, the cursor where it was last. A port that is missing or cannot be read leaves `unreadable` set. */
function enterDefined(memory: TabMemory, entry: TabEntry): TabHostState {
  const unreadable: TabHostState = {
    tab: 'defined',
    positions: memory.positions,
    sheet: undefined,
    unreadable: true,
  };
  if (entry.defined === undefined) return unreadable;
  try {
    return {
      tab: 'defined',
      positions: memory.positions,
      sheet: undefined,
      defined: openDefinedTab(entry.defined.read(), memory.positions.defined),
      unreadable: false,
    };
  } catch {
    return unreadable;
  }
}

/**
 * The History tab entered: its first page read now (nothing kept from a visit before), in the scope and filter it was left in. A port that
 * is missing or cannot be read leaves the tab saying so.
 */
function enterHistory(memory: TabMemory, entry: TabEntry): TabHostState {
  const unreadable: TabHostState = {
    tab: 'history',
    positions: memory.positions,
    sheet: undefined,
    history: unreadableHistoryTab(),
    unreadable: false,
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
 * The History tab entered with the detail of `runId` already asked for (the strip's `Enter` on a failed or recent run, ADR-0140 §6): the
 * list behind it is read as `enterHistory` reads it, with the cursor on that run when the page lists it, and the host loads the detail. A
 * Home with nothing to read the history from has no detail to ask for, and the tab says it cannot be read.
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
    sheet: undefined,
    active:
      entry.active === undefined
        ? unreadableActiveTab()
        : openActiveTab(entry.active.last, memory.positions.active, memory.activeFocus),
    unreadable: false,
  };
}

/**
 * What a keystroke does to the open tab host: close the screen (with a sentence for the host when it closed on a fault), become another
 * state, ask the host to run or export one workflow of the Defined tab (a `run` is also what `r` on a History detail asks: the same request
 * for the catalog's entry of the run's workflow), ask it to reopen the view of the run it hosts or to open the gate
 * card of a paused run of the Active tab, ask it to load a run's detail on the History tab, ask it to resume a conversation of the Sessions
 * tab in place, or ask it to start a chat bound to the agent of an open detail, each carrying the state the tab is left in.
 * The slug is a catalog entry's own, never a row's label, and a run id is the one the read classified (the host reads the run again before
 * it opens anything). The path of a `chat` is the catalog's own path of the agent's file, never a row's label, and it carries the definition the detail was drawn from.
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
  | { readonly kind: 'export'; readonly slug: string; readonly state: TabHostState }
  | { readonly kind: 'open-view'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'open-gate'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'open-detail'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'resume'; readonly sessionId: string; readonly state: TabHostState }
  | { readonly kind: 'chat'; readonly agent: HomeAgentRequest; readonly state: TabHostState };

/**
 * The tab a key moves to, or `undefined` for a key that moves none, within the strip `current` is on (never to another strip's tab).
 * `←`/`→` stop at the ends; `Tab` and `Shift+Tab` go around.
 */
function movedTab(current: TabId, key: ChatKey): TabId | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  const set = tabSetOf(current);
  const at = set.findIndex((tab) => tab.id === current);
  const last = set.length - 1;
  if (key.leftArrow === true) return set[Math.max(0, at - 1)]?.id;
  if (key.rightArrow === true) return set[Math.min(last, at + 1)]?.id;
  if (key.tab === true) return set[(at + (key.shift === true ? last : 1)) % set.length]?.id;
  return undefined;
}

/** One key into the Permissions tab's sheet, through the port: the sheet's own ladder, its withdrawal, and its close. */
function foldSheet(
  state: TabHostState,
  sheet: PermissionsSheetState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  // The sheet is open only on a screen that was given its port; a host that lost it closes the screen rather than freeze the keyboard.
  if (context.port === undefined) return { kind: 'close' };
  const result = foldPermissionsSheetThroughPort(
    context.port,
    sheet,
    input,
    key,
    context.canArm,
    context.now,
  );
  if (result.sheet === undefined)
    return result.note === undefined ? { kind: 'close' } : { kind: 'close', note: result.note };
  return { kind: 'state', state: { ...state, sheet: result.sheet } };
}

/** One key on the Defined tab. `p` is carried out here, through the pin port, and answered with a state: a pin is a mark and never a request to the host. */
function foldDefinedTab(
  state: TabHostState,
  defined: DefinedTabState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  const step = foldDefinedKey(defined, input, key);
  if (step.kind === 'pin')
    return {
      kind: 'state',
      state: {
        ...state,
        defined: pinOnDefined(step.state, step.row, context.pins, context.defined),
      },
    };
  const next = step.state === defined ? state : { ...state, defined: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

function foldActiveTab(state: TabHostState, active: ActiveTabState, key: ChatKey): TabHostStep {
  const step = foldActiveKey(active, key);
  const next = step.state === active ? state : { ...state, active: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

function foldAgentsTab(
  state: TabHostState,
  agents: AgentsTabState,
  input: string,
  key: ChatKey,
): TabHostStep {
  const step = foldAgentsKey(agents, input, key);
  const next = step.state === agents ? state : { ...state, agents: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

function foldSessionsTab(
  state: TabHostState,
  sessions: SessionsTabState,
  key: ChatKey,
): TabHostStep {
  const step = foldSessionsKey(sessions, key);
  const next = step.state === sessions ? state : { ...state, sessions: step.state };
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
    // `r` on a run's detail looks the run's workflow up in the very catalog the Defined tab lists.
    defined: context.defined,
  });
  const next = step.state === history ? state : { ...state, history: step.state };
  return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
}

/** One key into whichever tab is open: the list's of Defined, Active, Defined agents, Sessions and History, else the Permissions sheet's. */
function foldTabKey(
  state: TabHostState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  if (state.defined !== undefined) return foldDefinedTab(state, state.defined, input, key, context);
  if (state.active !== undefined) return foldActiveTab(state, state.active, key);
  if (state.agents !== undefined) return foldAgentsTab(state, state.agents, input, key);
  if (state.sessions !== undefined) return foldSessionsTab(state, state.sessions, key);
  if (state.history !== undefined) return foldHistoryTab(state, state.history, input, key, context);
  if (state.sheet === undefined) return { kind: 'state', state };
  return foldSheet(state, state.sheet, input, key, context);
}

/**
 * Fold one keystroke into the open tab host. `Ctrl+C` closes from any state and never withdraws. A withdrawal's question owns the keyboard
 * until it is answered or dropped: every key goes to the sheet's ladder, a tab key included, so a key typed ahead moves nothing. Past that,
 * a tab key moves (and reads the tab it lands on again), `Esc` closes a tab that has no question to drop and no detail to go back from
 * (a History detail takes its own `Esc`), on Permissions every other key is the sheet's, and on Defined, Active and History it is the
 * list's (which may ask for a run, an export, a view, a card or a detail, or toggle a pin).
 */
export function foldTabHostKey(
  state: TabHostState,
  input: string,
  key: ChatKey,
  context: TabHostContext,
): TabHostStep {
  if (isInterruptKey(input, key)) return { kind: 'close' };
  const sheet = state.sheet;
  if (sheet?.armed === true) return foldSheet(state, sheet, input, key, context);
  const to = movedTab(state.tab, key);
  if (to !== undefined) {
    if (to === state.tab) return { kind: 'state', state };
    return { kind: 'state', state: enterTab(tabHostMemory(state), to, context) };
  }
  // `Esc` closes a tab that has no detail to go back from; a detail (a run's, an agent's) takes its own `Esc`.
  const inDetail = state.history?.detail !== undefined || state.agents?.detail !== undefined;
  if (key.escape === true && sheet === undefined && !inDetail) return { kind: 'close' };
  return foldTabKey(state, input, key, context);
}

/** A paste is typing, and nothing the tab host answers to: it drops a waiting question and withdraws nothing. The same object when nothing was waiting. */
export function disarmTabHost(state: TabHostState): TabHostState {
  return state.sheet === undefined
    ? state
    : { ...state, sheet: disarmPermissionsSheet(state.sheet) };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The terminal width the legend must fit: the Home's 80-column floor. */
const LEGEND_FLOOR_COLUMNS = 80;

/** Whether a legend of `width` columns fits the floor: a legend exactly as wide as the usable columns fits (`<=`, never `<`). */
export function legendFitsTheFloor(width: number): boolean {
  return width <= usableColumns(LEGEND_FLOOR_COLUMNS);
}

/**
 * `items` with `Ctrl+C close` just before the way out, when the whole legend still fits the 80-column floor. `Ctrl+C` closes the screen from
 * any tab and any depth (ADR-0140 §1) and every state answers to it, so a person who has gone down a level reads that there is a way
 * out of all of them; where the keys of a screen already fill the floor (the History list's), it is left out for room, as `Shift+Tab`
 * and `PgUp` are, and the way out stays last and whole ({@link fitLegend}: the one fit rule of ADR-0145 §3).
 */
function withInterruptItem(items: readonly LegendItem[], exit: LegendExit): readonly LegendItem[] {
  return fitLegend(
    items,
    [{ item: TAB_HOST_KEYS.interrupt, priority: 1 }],
    exit,
    usableColumns(LEGEND_FLOOR_COLUMNS),
    displayWidth,
  );
}

/**
 * The key that leaves, by where the screen is: the class belongs to the (surface, state) pair (ADR-0145 §2). While a withdrawal's question is
 * up `Esc` drops it and keeps the permission, a step back; on a run's detail, a node page or an agent's detail it goes back one level; on a
 * tab's list it closes the screen and changes nothing.
 */
function tabExit(state: TabHostState): LegendExit {
  if (state.sheet?.armed === true) return SHEET_KEYS.keep;
  if (state.agents?.detail !== undefined) return AGENTS_KEYS.back;
  const detail = state.history?.detail;
  if (detail === undefined) return TAB_HOST_KEYS.close;
  return detail.node === undefined ? HISTORY_KEYS.back : NODE_KEYS.back;
}

/** What the tab host's legend draws: the keys it names and, last, the key that leaves with its effect. */
export interface TabHostLegend {
  readonly items: readonly LegendItem[];
  readonly exit: LegendExit;
}

/**
 * The legend: the withdrawal question's while one is up, else the tab's with the chord named where it fits. On a tab's list `Esc` and
 * `Ctrl+C` do the same (they close the screen and change nothing), so they are one item, `Esc / [Ctrl+C] close`, where the legend still fits
 * the floor, and `Esc close` alone where it does not (the way out is never cut). On a detail the effects differ (`Esc` steps back, `Ctrl+C`
 * closes), so the chord is a second item, as before.
 */
export function tabHostLegend(state: TabHostState): TabHostLegend {
  const exit = tabExit(state);
  const items = tabLegendItems(state, exit);
  // A withdrawal's question names its own two answers, and any other key drops it: the chord is not offered as a third.
  if (state.sheet?.armed === true) return { items, exit };
  if (exit === TAB_HOST_KEYS.close) {
    const both = legendFitsTheFloor(displayWidth(legend(items, TAB_HOST_CLOSE_EITHER)));
    return { items, exit: both ? TAB_HOST_CLOSE_EITHER : exit };
  }
  return { items: withInterruptItem(items, exit), exit };
}

/** The legend as text, as the screen draws it before it is clipped. */
export function tabHostLegendText(state: TabHostState): string {
  const { items, exit } = tabHostLegend(state);
  return legend(items, exit);
}

function tabLegendItems(state: TabHostState, exit: LegendExit): readonly LegendItem[] {
  const sheet = state.sheet;
  const tabItems: readonly LegendItem[] = [TAB_HOST_KEYS.tab, TAB_HOST_KEYS.cycle];
  if (state.defined !== undefined) return definedLegendItems(state.defined, tabItems);
  if (state.active !== undefined) return activeLegendItems(state.active, tabItems);
  if (state.history !== undefined) return historyLegendItems(state.history, tabItems, exit);
  if (state.agents !== undefined) return agentsLegendItems(state.agents, tabItems);
  if (state.sessions !== undefined) return sessionsLegendItems(state.sessions, tabItems);
  if (sheet === undefined) return TAB_HOST_LEGEND_PLAIN_ITEMS;
  if (sheet.armed) return SHEET_LEGEND_ARMED_ITEMS;
  return sheetEntries(sheet.snapshot).length > 0
    ? TAB_HOST_LEGEND_ROWS_ITEMS
    : TAB_HOST_LEGEND_PLAIN_ITEMS;
}

/** Whether the frame can show a withdrawal's question: the sheet's floor of 80×24, which is the Home's. */
export function tabHostCanArm(geometry: SheetGeometry): boolean {
  return sheetCanArm(geometry);
}

const STRIP_SEPARATOR = '  │  ';
/** The current tab's marker and its space: the one selection marker of the glyph table, in the form in force. */
const currentMark = (): string => `${glyph('selection')} `;

/** The strip of tabs: the current one carries the selection marker and is emphasised, so it is told apart by a glyph as well as by style. */
function tabStrip(current: TabId, width: number): SheetLine {
  let text = '';
  const spans: SheetSpan[] = [];
  tabSetOf(current).forEach((tab, index) => {
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

/**
 * What an entry of the allowlist is drawn as: its secret shapes masked by the shared scrubber, then every control, invisible and `<`
 * character shown as the card shows it. The snapshot's reader already masked each entry whole before it cut it to its bound (a token across
 * the cut would otherwise be a fragment no pattern matches), so this mask is the second, and changes nothing in an entry already masked;
 * it is the one a snapshot that reached the tab by another way still gets.
 */
function escapedEntry(text: string): string {
  return [...scrubSecrets(text)].map((char) => escapeReviewCharacter(char, false)).join('');
}

/** `count` and its noun: `1 command`, `2 commands`. */
const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The repository's allowlist, under the list: a heading, one note, and at most {@link ALLOWLIST_ENTRY_ROWS} entries (the last being a count
 * of the rest when there are more). The entries are the repository's words, so each is drawn escaped and clipped, never trusted.
 */
function allowlistLines(list: RepoAllowlist | undefined, width: number): readonly SheetLine[] {
  if (list === undefined) return [];
  const heading = (text: string): SheetLine => ({ kind: 'heading', text: clipLine(text, width) });
  if (!list.ok)
    return [
      heading('This repository · allowlist, read-only'),
      { kind: 'text', text: clipLine(list.text, width) },
    ];
  const entries = [
    ...list.commands.map((text) => ({ label: 'command', text })),
    ...list.globs.map((text) => ({ label: 'pattern', text })),
  ];
  const counts = `${plural(list.commands.length, 'command')}, ${plural(list.globs.length, 'pattern')}`;
  const title = heading(`This repository · allowlist, read-only (${counts})`);
  if (entries.length === 0)
    return [
      title,
      {
        kind: 'text',
        text: clipLine('Nothing is listed in the repository’s [chat] config.', width),
      },
    ];
  const total = entries.length + list.omitted;
  const shown =
    total <= ALLOWLIST_ENTRY_ROWS ? entries : entries.slice(0, ALLOWLIST_ENTRY_ROWS - 1);
  const rows: SheetLine[] = shown.map((entry) => {
    const lead = `  ${entry.label.padEnd(8)}`;
    const text = clipLine(`${lead}${escapedEntry(entry.text)}`, width);
    return {
      kind: 'row',
      text,
      spans: clampSpans([{ from: 0, to: lead.length, role: 'dim' }], text.length),
    };
  });
  if (total > shown.length)
    rows.push({
      kind: 'marker',
      text: clipLine(`… ${String(total - shown.length)} more in the config`, width),
    });
  return [
    title,
    {
      kind: 'text',
      text: clipLine('A listed command still asks in a chat; its card only says so.', width),
    },
    ...rows,
  ];
}

/** What a tab says when its data could not be read; the Permissions tab's sentence is the fallback (Active has its own phase and is never drawn plain). */
const TAB_UNREADABLE: Readonly<Partial<Record<TabId, string>>> = {
  defined: DEFINED_UNREADABLE,
  history: HISTORY_UNREADABLE,
  agents: AGENTS_UNREADABLE,
  sessions: SESSIONS_UNREADABLE,
};

/** The lines of a tab whose data could not be read. */
function plainBody(state: TabHostState): readonly SheetLine[] {
  const text = TAB_UNREADABLE[state.tab] ?? PERMISSIONS_UNREADABLE;
  return [{ kind: 'failed', text }];
}

/**
 * What the screen says below the floor: why. `Esc` there is the screen's own key (the Home delivers only `Esc` and `Ctrl+C` below 80×24):
 * it steps back one level on a run's detail and on a node page, and closes the screen only from a tab's list, and the legend under this
 * line says which of the two it is at the level the person is on.
 */
export const TAB_HOST_TOO_SMALL = 'Enlarge the terminal.';

/** What `Esc` does on a run's detail and on a node page: it steps back one level, and the legend says which. */
const TOO_SMALL_BACK_TO_LIST = exitKey.step('Esc', 'back to the list');
const TOO_SMALL_BACK_TO_RUN = exitKey.step('Esc', 'back to the run');

/** The `Esc` the legend below the floor names: the level it steps back to, or `close` from a tab's list (the tab host's own rule). */
function tooSmallEscape(state: TabHostState): LegendExit {
  if (state.agents?.detail !== undefined) return TOO_SMALL_BACK_TO_LIST;
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
 * The tab host's lines, top to bottom, for a terminal of this size: the strip and a rule, the tab's body, and the foot (on Permissions the
 * note, the message row and the legend; on the others, the legend). At most {@link TAB_HOST_ROWS} lines, one row spare in a terminal of
 * exactly 24, so the inline renderer never reaches the bottom edge. Below the floor it is two lines: the hint that says to enlarge, and the legend with the way out.
 */
export function tabHostLines(state: TabHostState, geometry: SheetGeometry): readonly SheetLine[] {
  if (!tabHostCanArm(geometry)) return tooSmallLines(state);
  const width = usableColumns(geometry.columns);
  const budget = Math.min(TAB_HOST_ROWS, geometry.terminalRows - 1);
  const head = [tabStrip(state.tab, width), rule(width)];
  const { items, exit } = tabHostLegend(state);
  const foot = legendLine(items, exit, width);
  const sheet = state.sheet;
  if (state.defined !== undefined)
    return [...head, ...definedBody(state.defined, width, budget - head.length - 1), foot];
  if (state.active !== undefined)
    return [...head, ...activeBody(state.active, width, budget - head.length - 1), foot];
  if (state.history !== undefined)
    return [...head, ...historyBody(state.history, width, budget - head.length - 1), foot];
  if (state.agents !== undefined)
    return [...head, ...agentsBody(state.agents, width, budget - head.length - 1), foot];
  if (state.sessions !== undefined)
    return [...head, ...sessionsBody(state.sessions, width, budget - head.length - 1), foot];
  if (sheet === undefined) return [...head, ...plainBody(state), foot];
  // The sheet's own note and message row sit under its list; its legend is replaced by the tab host's, which names the tab keys too.
  const sheetFoot = permissionsSheetChrome(sheet, geometry).foot.slice(0, 2);
  const allowlist = allowlistLines(sheet.snapshot.allowlist, width);
  const room = Math.max(3, budget - head.length - sheetFoot.length - 1 - allowlist.length);
  return [...head, ...permissionsSheetBody(sheet, width, room), ...allowlist, ...sheetFoot, foot];
}
