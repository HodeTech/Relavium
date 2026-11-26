import type { HomeSnapshot } from '../../home/home-store.js';
import type { EditorState } from './chat-input.js';
import type { ParkedRunKind } from './home-attention.js';
import {
  exitKey,
  keyHint,
  legend,
  LEGEND_SEPARATOR,
  type LegendExit,
  type LegendItem,
  type LegendKey,
} from './legend.js';

/**
 * The Home as TWO PAGES (MVP-11 unit 7; the maintainer's choice of 2026-11-26 from the "always-calm landing + ↓ flow" study), as DATA: which
 * page is in front, where the focus is, what a key does to them, how far the slide between them has travelled, and what the two hint rows and
 * the landing's indicator say. Page 1 (`start`) is ALWAYS the calm landing (ADR-0146 §1); page 2 (`work`) is the work page: the strip's
 * sections with a docked prompt in its last five rows. `↓` goes down to it, `↑` from its first row and `Esc` anywhere on it come back.
 *
 * - **Focus has three places** ({@link HomeFocus}): the landing's prompt, a row of the work page (the strip's focus, by the row's identity:
 *   `strip-focus.ts`), and the work page's docked prompt. There is ONE draft: both prompts draw the same editor, so a message typed on one page
 *   is on the other when the person goes back.
 * - **The key reducer** ({@link reducePageKey}) decides only the moves between the pages and the places; every key it does not take is the
 *   prompt's, the palette's or a row's as it always was (`pass`).
 * - **The slide** ({@link slideOffsets}): in the alternate screen the two pages are one document two screens tall and the screen is a window
 *   onto it; the window travels `rows − 1` rows in four equal steps (three frames between, then the arrival). Inline the pages swap.
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), only the legend builder and types. Every count it words
 * is a number the caller computed from the rows it draws, never text from a store, so nothing here needs sanitising.
 */

/** The Home's two pages: the landing, and the work page under it. */
export type HomePage = 'start' | 'work';

/** Where the keys go: the landing's prompt, a row of the work page, or the work page's docked prompt. */
export type HomeFocus = 'start-prompt' | 'rows' | 'docked-prompt';

/** The focus a page and a focused row make: on the landing its prompt; on the work page the row when one is focused, else the docked prompt. */
export function homeFocusOf(page: HomePage, rowFocused: boolean): HomeFocus {
  if (page === 'start') return 'start-prompt';
  return rowFocused ? 'rows' : 'docked-prompt';
}

// ---- The slide ----------------------------------------------------------------------------------------------------------------

/** The steps of one slide: three frames between the pages, then the arrival. */
export const SLIDE_STEPS = 4;

/** The time between two frames of the slide: the three frames between are shown for 40 ms each and the arrival comes 120 ms after the key. */
export const SLIDE_FRAME_MS = 40;

/**
 * The longest the keys that arrived during a slide wait for its arrival to be on screen: a host that never says so (a frame that cannot be
 * measured, a terminal taken away) must not hold the keyboard. Past it they are applied as live keys are, each with the host's own checks.
 */
export const SLIDE_SETTLE_BOUND_MS = 250;

/** How far the window travels between the pages: one page, `rows − 1` rows (a page is never taller than that). Nothing for a size that is not a number. */
export function slideTravel(rows: number): number {
  return Number.isFinite(rows) ? Math.max(0, Math.floor(rows) - 1) : 0;
}

/**
 * The offsets of the window, in whole rows from the top of the landing, for a slide DOWN to the work page: the three frames between and then the
 * target, `rows − 1`. Each frame is a quarter of the travel further, rounded up (6, 12, 18 and 23 at 24 rows; 8, 15, 22 and 29 at 30). Strictly
 * increasing and ending at the target; a travel too short for three distinct frames between keeps the ones it has.
 */
export function slideOffsets(rows: number): readonly number[] {
  const travel = slideTravel(rows);
  const between: number[] = [];
  for (let step = 1; step < SLIDE_STEPS; step += 1) {
    const offset = Math.ceil((travel * step) / SLIDE_STEPS);
    if (offset > (between.at(-1) ?? 0) && offset < travel) between.push(offset);
  }
  return [...between, travel];
}

/** The offsets of a slide toward `to`: down to the work page as {@link slideOffsets}; up to the landing the same frames in reverse, then 0. */
export function slideFrames(rows: number, to: HomePage): readonly number[] {
  const down = slideOffsets(rows);
  if (to === 'work') return down;
  return [...down.slice(0, -1).reverse(), 0];
}

/**
 * A slide in progress: the page it goes to (the controller's page is already that page: the keys, the focus and the hints are the target's) and
 * the frame of {@link slideFrames} on screen now. The last frame is the arrival, after which there is no slide.
 */
export interface HomeSlide {
  readonly to: HomePage;
  readonly frame: number;
}

/** The window's offset for a slide at a terminal of `rows` rows, or `undefined` at rest. A frame past the last is the last (the arrival). */
export function slideOffsetAt(rows: number, slide: HomeSlide | undefined): number | undefined {
  if (slide === undefined) return undefined;
  const frames = slideFrames(rows, slide.to);
  return frames[Math.max(0, Math.min(frames.length - 1, Math.floor(slide.frame)))];
}

// ---- The draft's lines --------------------------------------------------------------------------------------------------------

/** Whether the cursor is on the draft's first line (nothing above it to move to). */
export function cursorOnFirstLine(editor: EditorState): boolean {
  return !editor.text.slice(0, Math.max(0, editor.cursor)).includes('\n');
}

/** Whether the cursor is on the draft's last line (nothing below it to move to). */
export function cursorOnLastLine(editor: EditorState): boolean {
  return !editor.text.slice(Math.max(0, editor.cursor)).includes('\n');
}

// ---- The key reducer ----------------------------------------------------------------------------------------------------------

/** What one key is, for the pages: the two arrows, `Esc`, `Enter`, a key that types (a printable character, a paste) and any other key. */
export type PageKey = 'down' | 'up' | 'escape' | 'return' | 'types' | 'other';

/** What the reducer reads: the page, whether a row is focused (and which), the draft, the palette and what the work page lists. */
export interface PageKeyState {
  readonly page: HomePage;
  /** The index of the focused row among the work page's focusable rows; `undefined` when none is. */
  readonly rowIndex: number | undefined;
  /** How many rows of the work page can be focused (a session, a run: `stripRows`). */
  readonly rowCount: number;
  readonly draft: EditorState;
  /** The `/` palette is open: it owns every key, `Esc` included (it closes first). */
  readonly paletteOpen: boolean;
  /** There is something to continue, so the work page has something to show (`homeIsEmpty` is false). */
  readonly canContinue: boolean;
}

/** What a key does to the pages, or `pass`: the key is the prompt's, the palette's or the row's as it always was. */
export type PageKeyOutcome =
  | { readonly kind: 'pass' }
  /** Down to the work page: the focus on its first row, or on the docked prompt when it has no row that can be focused. */
  | { readonly kind: 'to-work'; readonly focus: 'rows' | 'docked-prompt' }
  /** Up to the landing: its prompt has the focus, and the draft is what it was. */
  | { readonly kind: 'to-start' }
  /** One row up or down the work page's list. */
  | { readonly kind: 'step-row'; readonly delta: 1 | -1 }
  /** From the docked prompt up onto the last row. */
  | { readonly kind: 'to-last-row' }
  /** From a row down onto the docked prompt (`↓` past the last row: the key is spent), or a key that types there (it is kept: `then: 'type'`). */
  | { readonly kind: 'to-docked'; readonly then: 'none' | 'type' }
  /** `Enter` on a row: what the row's kind opens. */
  | { readonly kind: 'open-row' };

const PASS: PageKeyOutcome = { kind: 'pass' };

/** The landing: `↓` goes down when there is something to continue and the cursor has no line below it to move to; anything else is the prompt's. */
function startKey(key: PageKey, state: PageKeyState): PageKeyOutcome {
  if (key !== 'down' || !state.canContinue || !cursorOnLastLine(state.draft)) return PASS;
  return { kind: 'to-work', focus: state.rowCount > 0 ? 'rows' : 'docked-prompt' };
}

/** A focused row: the arrows move along the list (past the first row up to the landing, past the last down to the prompt); a key that types goes to the prompt. */
function rowKey(key: PageKey, index: number, state: PageKeyState): PageKeyOutcome {
  switch (key) {
    case 'escape':
      return { kind: 'to-start' };
    case 'return':
      return { kind: 'open-row' };
    case 'up':
      return index <= 0 ? { kind: 'to-start' } : { kind: 'step-row', delta: -1 };
    case 'down':
      return index >= state.rowCount - 1
        ? { kind: 'to-docked', then: 'none' }
        : { kind: 'step-row', delta: 1 };
    case 'types':
    case 'other':
      return { kind: 'to-docked', then: 'type' };
  }
}

/** The docked prompt: `Esc` goes up to the landing, `↑` from the draft's first line onto the last row; everything else is the prompt's. */
function dockedKey(key: PageKey, state: PageKeyState): PageKeyOutcome {
  if (key === 'escape') return { kind: 'to-start' };
  if (key === 'up' && state.rowCount > 0 && cursorOnFirstLine(state.draft))
    return { kind: 'to-last-row' };
  return PASS;
}

/**
 * What `key` does to the pages and the focus (MVP-11 unit 7). PURE: the controller applies the outcome. An open palette takes every key (its
 * `Esc` closes it and leaves the page as it is). On the landing `↓` goes down when there is something to continue and the cursor is on the
 * draft's last line (a multi-line draft moves its cursor first), to the FIRST row even with a draft. On the work page `Esc` goes back up with
 * the draft kept, the arrows walk the rows and step off both ends (up to the landing, down to the docked prompt), `Enter` opens the row, a key
 * that types moves to the docked prompt and is typed there, and `↑` from the docked prompt's first line returns to the last row.
 */
export function reducePageKey(key: PageKey, state: PageKeyState): PageKeyOutcome {
  if (state.paletteOpen) return PASS;
  if (state.page === 'start') return startKey(key, state);
  if (state.rowIndex !== undefined && state.rowIndex < state.rowCount)
    return rowKey(key, state.rowIndex, state);
  return dockedKey(key, state);
}

// ---- The indicator and the hints ----------------------------------------------------------------------------------------------

/**
 * What the work page lists, counted as it lists it: the rows under "Attention required" (the parked runs of this project, the runs whose log
 * cannot be read, the gates of runs not parked here, the failed runs), the recent sessions, and the recent runs that are not parked here.
 */
export interface WorkCounts {
  readonly attention: number;
  readonly sessions: number;
  readonly runs: number;
}

/** The most runs whose log cannot be read the Attention section lists (each says which run it is; more would push the rest off the page). */
export const UNREADABLE_ROWS_SHOWN = 3;

/**
 * {@link WorkCounts} of a snapshot and the parked runs of this project, counted exactly as the work page lists them: a run with a parked row is
 * not counted again among the gates or the recent runs, and at most {@link UNREADABLE_ROWS_SHOWN} unreadable runs are listed. The agents are not
 * counted: an agent is listed because a session ran it, so a Home with agents always has sessions to count.
 */
export function workCounts(
  snapshot: Pick<HomeSnapshot, 'attention' | 'recentSessions' | 'recentRuns' | 'unreadableRunIds'>,
  parked: readonly { readonly runId: string }[],
): WorkCounts {
  const parkedIds = new Set(parked.map((row) => row.runId));
  const gates = snapshot.attention.gates.filter((gate) => !parkedIds.has(gate.runId)).length;
  return {
    attention:
      parked.length +
      Math.min(UNREADABLE_ROWS_SHOWN, snapshot.unreadableRunIds.length) +
      gates +
      snapshot.attention.failedRuns.length,
    sessions: snapshot.recentSessions.length,
    runs: snapshot.recentRuns.filter((run) => !parkedIds.has(run.runId)).length,
  };
}

/** `n` with its noun, in the singular for one (`1 session`, `2 sessions`). */
function counted(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The words of the attention count: `1 needs you`, `2 need you`. */
export function needsYouWords(attention: number): string {
  return `${String(attention)} ${attention === 1 ? 'needs' : 'need'} you`;
}

/**
 * The indicator's parts, in the order the hint draws them: the head carries the `↓` (the attention count when there is one, in the warning role,
 * else the sessions, else the runs), and the counts after it are words. A zero count is not drawn. Nothing when there is nothing to count.
 */
export function indicatorParts(counts: WorkCounts):
  | {
      readonly head: LegendKey;
      readonly sessions: LegendItem | undefined;
      readonly runs: LegendItem | undefined;
    }
  | undefined {
  const sessions =
    counts.sessions > 0 ? counted(counts.sessions, 'session', 'sessions') : undefined;
  const runs = counts.runs > 0 ? counted(counts.runs, 'run', 'runs') : undefined;
  if (counts.attention > 0)
    return {
      head: { keys: '↓', verb: needsYouWords(counts.attention), role: 'warn' },
      sessions: sessions === undefined ? undefined : { text: sessions },
      runs: runs === undefined ? undefined : { text: runs },
    };
  if (sessions !== undefined)
    return {
      head: { keys: '↓', verb: sessions },
      sessions: undefined,
      runs: runs === undefined ? undefined : { text: runs },
    };
  if (runs !== undefined)
    return { head: { keys: '↓', verb: runs }, sessions: undefined, runs: undefined };
  return undefined;
}

/** One item of a hint and whether it may be dropped: `required` never is; otherwise the lowest `priority` goes first (the last among equals). */
interface HintPart {
  readonly item: LegendItem;
  readonly priority: number | 'required';
}

/**
 * The hint with as many of its droppable items as fit `columns`, IN THE ORDER GIVEN (unlike `fitLegend`, which puts the required ones first):
 * the lowest priority is dropped first, and among equals the one that comes last. The required items and the exit always stay; when even they
 * do not fit, the row's own cut applies.
 */
function fitInOrder(
  parts: readonly HintPart[],
  exit: LegendExit,
  columns: number,
  width: (text: string) => number,
): readonly LegendItem[] {
  const kept = new Set(parts.map((_, index) => index));
  const build = (): readonly LegendItem[] =>
    parts.filter((_, index) => kept.has(index)).map((part) => part.item);
  const order = parts
    .map((part, index) => ({ index, priority: part.priority }))
    .filter((entry): entry is { index: number; priority: number } => entry.priority !== 'required')
    .sort((a, b) => a.priority - b.priority || b.index - a.index);
  for (const drop of order) {
    if (width(legend(build(), exit)) <= columns) break;
    kept.delete(drop.index);
  }
  return build();
}

/** A hint row: its text and, when part of it is drawn in the warning role (the attention count), where that part is. */
export interface HintRow {
  readonly text: string;
  readonly warn?: { readonly from: number; readonly to: number } | undefined;
}

/** The hint row for `items` and `exit`, with the span of `warnItem` (when it is one of the items) for the view to draw in the warning role. */
function hintRow(
  items: readonly LegendItem[],
  exit: LegendExit,
  warnItem: LegendItem | undefined,
): HintRow {
  const text = legend(items, exit);
  const at = warnItem === undefined ? -1 : items.indexOf(warnItem);
  if (warnItem === undefined || at < 0) return { text };
  const from = at === 0 ? 0 : keyHint(items.slice(0, at)).length + LEGEND_SEPARATOR.length;
  return { text, warn: { from, to: from + keyHint([warnItem]).length } };
}

/** `Ctrl+C` twice leaves the Home (ADR-0115): the key that leaves the landing, last in every state of its hint. */
export const EXIT_TWICE = exitKey.leave('exit (twice)', 'Ctrl+C');
/** The same key once it is armed: the second press leaves. */
export const EXIT_AGAIN = exitKey.leave('exit (again)', 'Ctrl+C');
/** `Esc` on the work page goes back up to the landing: one step back, nothing changes (the draft stays). */
export const BACK_TO_START = exitKey.step('Esc', 'start page');

/** The palette's own key, written first wherever the prompt is empty. */
export const SLASH_COMMANDS: LegendKey = { keys: '/', verb: 'commands' };
/** The way to start a chat that is always there on a landing with nothing to continue. */
export const TYPE_A_MESSAGE: LegendItem = { text: 'type a message to chat' };
/** `Tab` fills the landing prompt's example in (ADR-0146 §1): named only where the example is on screen, an empty prompt on the landing. */
export const TAB_FILLS_EXAMPLE: LegendKey = { keys: 'Tab', verb: 'fill the example' };
/** What `Enter` does with no key, the draft kept (ADR-0146 §5). */
export const CONNECT_A_PROVIDER: LegendKey = { keys: 'Enter', verb: 'connect a provider' };
/** `↑` from the docked prompt's first line goes back onto the list's last row. */
const BACK_TO_LIST: LegendKey = { keys: '↑', verb: 'back to the list' };
/** The work page's way back, as its first row draws it (dim). */
export const WAY_BACK_LINE = keyHint([{ keys: '↑', verb: 'start page' }]);
/** What the docked prompt invites while it is empty: never part of the draft, never sent. */
export const DOCKED_PLACEHOLDER = 'type a message, or / for commands';

/** `Ctrl+J` breaks the line: the one on-screen cue for a multi-line message (ADR-0146 §4). */
const NEWLINE: LegendKey = { keys: 'Ctrl+J', verb: 'newline' };

/**
 * What the draft's own hint says: a slash line is a command, which `Enter` RUNS with or without a key (a registry word answers, an unknown one
 * says so), so neither "start the chat" nor the keyless sentence would be true of it; a message starts the chat, or (no key) `Enter` connects a
 * provider and the message is kept. `newline` is the priority of `[Ctrl+J] newline` (not offered with no key: `Enter` connects first).
 */
function draftItems(
  state: { readonly draft: string; readonly keyless: boolean },
  newline: number | 'required',
): readonly HintPart[] {
  if (state.draft.trimStart().startsWith('/'))
    return [
      { item: { keys: 'Enter', verb: 'run' }, priority: 'required' },
      { item: NEWLINE, priority: newline },
    ];
  if (state.keyless)
    return [
      { item: CONNECT_A_PROVIDER, priority: 'required' },
      { item: { text: 'your message is kept' }, priority: 'required' },
    ];
  return [
    { item: { keys: 'Enter', verb: 'start the chat' }, priority: 'required' },
    { item: NEWLINE, priority: newline },
  ];
}

/** What the landing's hint row reads (page 1). */
export interface LandingHintState {
  readonly interruptArmed: boolean;
  readonly draft: EditorState;
  readonly keyless: boolean;
  /** A hosted run is executing and has a run `Enter` shows: the run's own row says so, and `Enter` does not connect a provider first. */
  readonly runCanBeShown: boolean;
  /** What the work page lists; all zero when there is nothing to continue (no `↓` at all). */
  readonly counts: WorkCounts;
  /** The row's columns: the terminal less the margin. */
  readonly columns: number;
}

/**
 * The parts of the landing's hint with nothing typed (see {@link landingHint}), around the very `indicator` the caller marks for the warning
 * colour (the span is found by the item's identity).
 */
function emptyLandingParts(
  state: LandingHintState,
  indicator: ReturnType<typeof indicatorParts>,
): readonly HintPart[] {
  // No key and no run to show: `Enter` connects one. With an indicator beside it the call gives way before the counts do (the status line
  // above says it too).
  const connects = state.keyless && !state.runCanBeShown;
  const parts: HintPart[] = [];
  if (connects)
    parts.push({ item: CONNECT_A_PROVIDER, priority: indicator === undefined ? 'required' : 1 });
  parts.push({ item: SLASH_COMMANDS, priority: 'required' });
  if (indicator !== undefined) {
    parts.push({ item: indicator.head, priority: 'required' });
    if (indicator.sessions !== undefined) parts.push({ item: indicator.sessions, priority: 3 });
    if (indicator.runs !== undefined) parts.push({ item: indicator.runs, priority: 2 });
  } else if (!connects) parts.push({ item: TYPE_A_MESSAGE, priority: 1 });
  parts.push({ item: TAB_FILLS_EXAMPLE, priority: indicator === undefined ? 2 : 0 });
  return parts;
}

/**
 * The landing's hint (page 1). Armed, only the second `Ctrl+C`. With a draft, the draft's own keys and then the indicator's head when it fits.
 * With an empty prompt: (no key) `Enter connect a provider`, `[/] commands`, then the INDICATOR when there is something to continue
 * (`↓ 1 needs you` in the warning role, then the session and run counts; with no attention row the `↓` stands on the first count), else `type a
 * message to chat`, then `Tab fill the example`; `[Ctrl+C] exit (twice)` last. What does not fit the row is dropped: the example first, then the
 * call to connect (the status line says it), then the runs, then the sessions; never `[/] commands`, never the `↓`, never the exit. With
 * nothing to continue it is the empty Home's hint as it was.
 */
export function landingHint(state: LandingHintState, width: (text: string) => number): HintRow {
  if (state.interruptArmed) return { text: legend([], EXIT_AGAIN) };
  const indicator = indicatorParts(state.counts);
  const warnHead = indicator?.head.role === 'warn' ? indicator.head : undefined;
  const parts: readonly HintPart[] =
    state.draft.text.length > 0
      ? [
          ...draftItems({ draft: state.draft.text, keyless: state.keyless }, 'required'),
          ...(indicator === undefined ? [] : [{ item: indicator.head, priority: 1 }]),
        ]
      : emptyLandingParts(state, indicator);
  return hintRow(fitInOrder(parts, EXIT_TWICE, state.columns, width), EXIT_TWICE, warnHead);
}

/** What a focused row is, for what `Enter` says on it (`strip-focus.ts` roles; a parked row says what it waits on). */
export type WorkRowCue =
  | { readonly role: 'session' }
  | { readonly role: 'failed' | 'recent' }
  | { readonly role: 'parked'; readonly waits: ParkedRunKind | undefined };

/** What `Enter` does on a focused row, in the same words as the row's own cue: the hint must not promise a gate where there is none. */
export function rowEnterItem(cue: WorkRowCue): LegendKey {
  if (cue.role === 'session') return { keys: 'Enter', verb: 'resume' };
  if (cue.role !== 'parked') return { keys: 'Enter', verb: 'open the run' };
  if (cue.waits === 'none') return { keys: 'Enter', verb: 'say why' };
  if (cue.waits === 'media') return { keys: 'Enter', verb: 'continue it' };
  // An input gate's card takes no typed value: it shows how to answer in a shell, and offers a rejection.
  if (cue.waits === 'input') return { keys: 'Enter', verb: 'show how' };
  return { keys: 'Enter', verb: 'open the gate' };
}

/** What the work page's hint row reads (page 2). */
export interface WorkHintState {
  readonly interruptArmed: boolean;
  /** The focused row's cue, or `undefined` when the docked prompt has the focus. */
  readonly row: WorkRowCue | undefined;
  readonly draft: EditorState;
  readonly keyless: boolean;
  readonly runCanBeShown: boolean;
  /** The list has a row `↑` can go back to. */
  readonly hasRows: boolean;
  readonly columns: number;
}

/** `Enter` on the empty docked prompt: the run this Home hosts when it can be shown, else (no key) the provider setup, else the palette's key. */
function emptyDockedItem(state: WorkHintState, runShowItem: LegendKey): LegendItem {
  if (state.runCanBeShown) return runShowItem;
  return state.keyless ? CONNECT_A_PROVIDER : SLASH_COMMANDS;
}

/**
 * The work page's hint (page 2), its way back last (`Esc start page`). On a row: `↑/↓ select`, what `Enter` does on that row, and that typing
 * starts a chat. On the docked prompt: what `Enter` does with what is typed (the draft's own words, or with nothing typed the run view, the
 * provider setup or the palette's key), `↑ back to the list` when there is a list, and `[Ctrl+J] newline` with a draft when it fits.
 */
export function workHint(
  state: WorkHintState,
  runShowItem: LegendKey,
  width: (text: string) => number,
): HintRow {
  if (state.interruptArmed) return { text: legend([], EXIT_AGAIN) };
  const parts: HintPart[] = [];
  if (state.row !== undefined) {
    parts.push(
      {
        item: { keys: '↑/↓', verb: state.row.role === 'session' ? 'select session' : 'select' },
        priority: 'required',
      },
      { item: rowEnterItem(state.row), priority: 'required' },
      { item: { text: 'type to chat' }, priority: 1 },
    );
    return { text: legend(fitInOrder(parts, BACK_TO_START, state.columns, width), BACK_TO_START) };
  }
  const draft = state.draft.text;
  if (draft.length > 0) {
    // The draft's own words first; `↑ back to the list` before `[Ctrl+J] newline`, which is the first to give way.
    const own = draftItems({ draft, keyless: state.keyless }, 1);
    parts.push(...own.filter((part) => part.priority === 'required'));
    if (state.hasRows) parts.push({ item: BACK_TO_LIST, priority: 2 });
    parts.push(...own.filter((part) => part.priority !== 'required'));
  } else {
    parts.push({ item: emptyDockedItem(state, runShowItem), priority: 'required' });
    if (state.hasRows) parts.push({ item: BACK_TO_LIST, priority: 2 });
  }
  return { text: legend(fitInOrder(parts, BACK_TO_START, state.columns, width), BACK_TO_START) };
}

// ---- The work page's rows ------------------------------------------------------------------------------------------------------

/** The rows above the work page's list: the way back (`↑ start page`) and a blank row. */
export const WORK_HEAD_ROWS = 2;

/** The docked prompt block's rows besides the prompt's own: a blank lead row, the rule, the status line and the hint. */
export const DOCKED_CHROME_ROWS = 4;

/**
 * The rows the work page's list may take: `rows − 1` (no frame is taller) less the way back and its blank row, the block at the bottom (the
 * docked prompt, the palette or the exit-guard card) and the notice with its blank row. Never negative. At 80×24 with the resting block: 16.
 */
export function workListRows(rows: number, bottomRows: number, noticeRows = 0): number {
  if (!Number.isFinite(rows)) return 0;
  const notice = noticeRows > 0 ? noticeRows + 1 : 0;
  return Math.max(0, Math.floor(rows) - 1 - WORK_HEAD_ROWS - bottomRows - notice);
}
