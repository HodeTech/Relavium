import type { ActiveRead } from '../../history/active-source.js';
import type { PermissionsPort, RepoAllowlist } from '../../permissions/chat-permissions.js';
import type { ChatKey } from './chat-input.js';
import { isInterruptKey } from './interrupt-keymap.js';
import { legend, legendSpans, type LegendItem } from './legend.js';
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
  type ActiveTabState,
} from './tab-host-active.js';
import {
  DEFINED_UNREADABLE,
  definedBody,
  definedLegendItems,
  foldDefinedKey,
  openDefinedTab,
  withDefinedMessage,
  type DefinedPort,
  type DefinedTabState,
} from './tab-host-workflows.js';
import { escapeReviewCharacter } from './tool-review-projection.js';

/**
 * The Home's tab host ([ADR-0140](../../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §1, §3): the screen of the management browsers, as a PURE model. It holds the tab strip, the keys, what each tab remembers and the lines
 * to draw; it owns no `useInput`, no React and no clock (the host passes the time in), so the key ladder and every sentence are testable
 * without a terminal, as the sheet's are. `tab-host-view.tsx` paints it and `home-controller.ts` owns the slot it sits in.
 *
 * Four tabs: History is a placeholder in this increment (it draws one line that says so); Permissions is the ADR-0137 sheet composed under
 * the tab strip (its body, its keys and its `Esc` ladder are the sheet's, and the repository's `[chat]` allowlist is added under the list as
 * read-only rows); Defined lists the project's workflows with their pins (`tab-host-workflows.ts`), where `r` and `x` ASK the host to run or
 * export a row; and Active lists the runs that are not finished (`tab-host-active.ts`), where `Enter` ASKS the host to reopen the hosted
 * run's view or to open a paused run's gate card. Nothing here writes: a withdrawal is carried out through the port the host holds, and a
 * run, an export or a card is a {@link TabHostStep} the host carries out with its own flow. The Active tab is fed from outside: entering it
 * shows the last read the host kept, and the host's poll hands each newer read in ({@link withActiveRead}).
 *
 * - **Keys.** `←` and `→` move between tabs (and stop at the ends), `Tab` and `Shift+Tab` cycle around them, and `Esc` closes the screen
 *   (on Permissions, once a withdrawal's question is dropped). `Ctrl+C` closes the screen from any tab and never withdraws. Everything
 *   else on Permissions is the sheet's, `Backspace` included: there it is a withdraw key and not a way back (the maintainer's ruling for
 *   this increment), so the ADR's "Backspace goes back" is not applied on that tab.
 * - **Entering a tab reads it again.** Permissions and Defined are read from their ports every time the tab is entered, never from what
 *   was shown the last time, and a tab entered again starts as a new sheet does: the settle time counts again and nothing typed before counts.
 *   Active is the one tab whose read is asynchronous: it is entered on the last read the host kept, and the host reads again at once.
 * - **Each tab remembers its position** while the screen lives ({@link TabMemory}); the host drops it with the screen.
 * - **Drawn in at most {@link TAB_HOST_ROWS} rows** at any terminal height, and below 80×24 as one line that says to enlarge.
 */

/** The tabs, in the order the strip draws them. */
export type TabId = 'defined' | 'active' | 'history' | 'permissions';

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

/** What a tab that is not built yet says, after its own name. */
export const PLACEHOLDER_NOTE = 'available in the next increment';

/** The rows the tab host may use: what the Home's frame allows at 80×24, less the prompt's line. */
export const TAB_HOST_ROWS = 23;

/** The most rows the allowlist section takes: its heading, its note and four entries (the last of them a count when more are listed). */
const ALLOWLIST_ENTRY_ROWS = 4;

/** The keys the tab host's legend names that are its own; the sheet's keys come from `SHEET_KEYS`. The test presses every one of them. */
export const TAB_HOST_KEYS = {
  tab: { keys: '←/→', verb: 'tab' },
  cycle: { keys: 'Tab', verb: 'cycle' },
  close: { keys: 'Esc', verb: 'close' },
} as const satisfies Readonly<Record<string, LegendItem>>;

/** The legend of a tab with nothing to select. */
export const TAB_HOST_LEGEND_PLAIN_ITEMS: readonly LegendItem[] = [
  TAB_HOST_KEYS.tab,
  TAB_HOST_KEYS.cycle,
  TAB_HOST_KEYS.close,
];
/** The legend of the Permissions tab with a row to select: the tab keys, the sheet's select and withdraw, and the way out last. */
export const TAB_HOST_LEGEND_ROWS_ITEMS: readonly LegendItem[] = [
  TAB_HOST_KEYS.tab,
  TAB_HOST_KEYS.cycle,
  SHEET_KEYS.select,
  SHEET_KEYS.withdraw,
  TAB_HOST_KEYS.close,
];

/** What a tab remembers: where the cursor was, by tab. Permissions, Defined and Active have a cursor; History stays at the top. */
export type TabPositions = Readonly<Record<TabId, number>>;

/** What the host keeps of a tab host while a screen that came from it is in front: the tab it was on and each tab's position. */
export interface TabMemory {
  readonly tab: TabId;
  readonly positions: TabPositions;
  /** The run the Active tab's cursor was on, so the tab comes back to the run and not only to the row number. */
  readonly activeFocus?: string | undefined;
}

const TOP: TabPositions = Object.freeze({ defined: 0, active: 0, history: 0, permissions: 0 });

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
  /** Permissions or Defined was entered and its port could not be read: the tab says so instead of listing anything. */
  readonly unreadable: boolean;
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
    state.positions[state.tab]
  );
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

/** The state of the tab host as the memory of it: the tab it is on, and every tab's position, the current one's included. */
export function tabHostMemory(state: TabHostState): TabMemory {
  const memory: TabMemory = {
    tab: state.tab,
    positions: { ...state.positions, [state.tab]: positionOf(state) },
  };
  const focus = state.active?.focus;
  return focus === undefined ? memory : { ...memory, activeFocus: focus };
}

/**
 * The tab host entered on `tab` with what `memory` holds. Entering Permissions reads its port NOW, and puts the cursor where it was last
 * (clamped to the rows there are now); a port that cannot be read leaves `unreadable` set and no sheet.
 */
export function enterTab(memory: TabMemory, tab: TabId, entry: TabEntry): TabHostState {
  if (tab === 'defined') return enterDefined(memory, entry);
  if (tab === 'active') return enterActive(memory, entry);
  if (tab !== 'permissions')
    return { tab, positions: memory.positions, sheet: undefined, unreadable: false };
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
 * state, ask the host to run or export one workflow of the Defined tab, or ask it to reopen the view of the run it hosts or to open the gate
 * card of a paused run of the Active tab, each carrying the state the tab is left in. The slug is a catalog entry's own, never a row's
 * label, and a run id is the one the read classified (the host reads the run again before it opens anything).
 */
export type TabHostStep =
  | { readonly kind: 'close'; readonly note?: string }
  | { readonly kind: 'state'; readonly state: TabHostState }
  | { readonly kind: 'run'; readonly slug: string; readonly state: TabHostState }
  | { readonly kind: 'export'; readonly slug: string; readonly state: TabHostState }
  | { readonly kind: 'open-view'; readonly runId: string; readonly state: TabHostState }
  | { readonly kind: 'open-gate'; readonly runId: string; readonly state: TabHostState };

/** The tab a key moves to, or `undefined` for a key that moves none. `←`/`→` stop at the ends; `Tab` and `Shift+Tab` go around. */
function movedTab(current: TabId, key: ChatKey): TabId | undefined {
  if (key.ctrl === true || key.meta === true) return undefined;
  const at = TABS.findIndex((tab) => tab.id === current);
  const last = TABS.length - 1;
  if (key.leftArrow === true) return TABS[Math.max(0, at - 1)]?.id;
  if (key.rightArrow === true) return TABS[Math.min(last, at + 1)]?.id;
  if (key.tab === true) return TABS[(at + (key.shift === true ? last : 1)) % TABS.length]?.id;
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

/**
 * Fold one keystroke into the open tab host. `Ctrl+C` closes from any state and never withdraws. A withdrawal's question owns the keyboard
 * until it is answered or dropped: every key goes to the sheet's ladder, a tab key included, so a key typed ahead moves nothing. Past that,
 * a tab key moves (and reads the tab it lands on again), `Esc` closes a tab that has no question to drop, on Permissions every other
 * key is the sheet's, and on Defined and Active it is the list's (which may ask for a run, an export, a view or a card).
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
  if (key.escape === true && sheet === undefined) return { kind: 'close' };
  if (state.defined !== undefined) {
    const step = foldDefinedKey(state.defined, input, key);
    const next = step.state === state.defined ? state : { ...state, defined: step.state };
    return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
  }
  if (state.active !== undefined) {
    const step = foldActiveKey(state.active, key);
    const next = step.state === state.active ? state : { ...state, active: step.state };
    return step.kind === 'state' ? { kind: 'state', state: next } : { ...step, state: next };
  }
  if (sheet === undefined) return { kind: 'state', state };
  return foldSheet(state, sheet, input, key, context);
}

/** A paste is typing, and nothing the tab host answers to: it drops a waiting question and withdraws nothing. The same object when nothing was waiting. */
export function disarmTabHost(state: TabHostState): TabHostState {
  return state.sheet === undefined
    ? state
    : { ...state, sheet: disarmPermissionsSheet(state.sheet) };
}

// ---- What is drawn --------------------------------------------------------------------------------------------------------

/** The legend's items: the withdrawal question's while one is up, else the tab's. */
export function tabHostLegendItems(state: TabHostState): readonly LegendItem[] {
  const sheet = state.sheet;
  if (state.defined !== undefined)
    return definedLegendItems(
      state.defined,
      [TAB_HOST_KEYS.tab, TAB_HOST_KEYS.cycle],
      TAB_HOST_KEYS.close,
    );
  if (state.active !== undefined)
    return activeLegendItems(
      state.active,
      [TAB_HOST_KEYS.tab, TAB_HOST_KEYS.cycle],
      TAB_HOST_KEYS.close,
    );
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
const CURRENT_MARK = '▸ ';

/** The strip of tabs: the current one carries `▸` and is emphasised, so it is told apart by a glyph as well as by style. */
function tabStrip(current: TabId, width: number): SheetLine {
  let text = '';
  const spans: SheetSpan[] = [];
  TABS.forEach((tab, index) => {
    if (index > 0) {
      spans.push({ from: text.length, to: text.length + STRIP_SEPARATOR.length, role: 'dim' });
      text += STRIP_SEPARATOR;
    }
    const label = tab.id === current ? `${CURRENT_MARK}${tab.title}` : tab.title;
    spans.push({
      from: text.length,
      to: text.length + label.length,
      role: tab.id === current ? 'strong' : 'dim',
    });
    text += label;
  });
  const shown = clipLine(text, width);
  return { kind: 'row', text: shown, spans: clampSpans(spans, shown.length) };
}

function rule(width: number): SheetLine {
  const text = '─'.repeat(width);
  return { kind: 'rule', text, spans: [{ from: 0, to: text.length, role: 'dim' }] };
}

/** The legend as a line: the keys apart from the words, clipped to the width. */
function legendLine(items: readonly LegendItem[], width: number): SheetLine {
  const text = clipLine(legend(items), width);
  return { kind: 'legend', text, spans: clampSpans(legendSpans(items), text.length) };
}

/** What an entry of the allowlist is drawn as: every control, invisible and `<` character shown as the card shows it. */
function escapedEntry(text: string): string {
  return [...text].map((char) => escapeReviewCharacter(char, false)).join('');
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

/** The lines of a tab that is not built yet or whose data could not be read. */
function plainBody(state: TabHostState): readonly SheetLine[] {
  if (state.unreadable)
    return [
      {
        kind: 'failed',
        text: state.tab === 'defined' ? DEFINED_UNREADABLE : PERMISSIONS_UNREADABLE,
      },
    ];
  const title = TABS.find((tab) => tab.id === state.tab)?.title ?? '';
  return [{ kind: 'text', text: `${title} — ${PLACEHOLDER_NOTE}.` }];
}

/** The lines when the terminal is below the floor: why, and the way out. */
function tooSmallLines(): readonly SheetLine[] {
  const items: readonly LegendItem[] = [TAB_HOST_KEYS.close];
  return [
    { kind: 'text', text: 'Enlarge the terminal to use this screen — Esc closes.' },
    { kind: 'legend', text: legend(items), spans: legendSpans(items) },
  ];
}

/**
 * The tab host's lines, top to bottom, for a terminal of this size: the strip and a rule, the tab's body, and the foot (on Permissions the
 * note, the message row and the legend; on the others, the legend). At most {@link TAB_HOST_ROWS} lines, one row spare in a terminal of
 * exactly 24, so the inline renderer never reaches the bottom edge. Below the floor it is the one line that says to enlarge, and the way out.
 */
export function tabHostLines(state: TabHostState, geometry: SheetGeometry): readonly SheetLine[] {
  if (!tabHostCanArm(geometry)) return tooSmallLines();
  const width = usableColumns(geometry.columns);
  const budget = Math.min(TAB_HOST_ROWS, geometry.terminalRows - 1);
  const head = [tabStrip(state.tab, width), rule(width)];
  const foot = legendLine(tabHostLegendItems(state), width);
  const sheet = state.sheet;
  if (state.defined !== undefined)
    return [...head, ...definedBody(state.defined, width, budget - head.length - 1), foot];
  if (state.active !== undefined)
    return [...head, ...activeBody(state.active, width, budget - head.length - 1), foot];
  if (sheet === undefined) return [...head, ...plainBody(state), foot];
  // The sheet's own note and message row sit under its list; its legend is replaced by the tab host's, which names the tab keys too.
  const sheetFoot = permissionsSheetChrome(sheet, geometry).foot.slice(0, 2);
  const allowlist = allowlistLines(sheet.snapshot.allowlist, width);
  const room = Math.max(3, budget - head.length - sheetFoot.length - 1 - allowlist.length);
  return [...head, ...permissionsSheetBody(sheet, width, room), ...allowlist, ...sheetFoot, foot];
}
