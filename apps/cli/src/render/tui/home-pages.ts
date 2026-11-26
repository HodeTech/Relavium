import type { HomeSnapshot } from '../../home/home-store.js';
import type { EditorState } from './chat-input.js';
import type { ParkedRunKind } from './home-attention.js';
import { frameRows } from './home-layout.js';
import { workListFloor } from './home-work-budget.js';
import { PROMPT_WINDOW_MIN_ROWS } from './prompt-window.js';
import { clipLine } from './sheet-frame.js';
import {
  exitKey,
  keyHint,
  legend,
  LEGEND_SEPARATOR,
  type LegendExit,
  type LegendItem,
  type LegendKey,
  type LegendText,
} from './legend.js';

/**
 * The Home as TWO PAGES (MVP-11 unit 7; the maintainer's choice of 2026-11-26 from the "always-calm landing + ↓ flow" study), as DATA: which
 * page is in front, where the focus is, what a key does to them, how far the slide between them has travelled, and what the two hint rows and
 * the landing's indicator say. Page 1 (`start`) is ALWAYS the calm landing (ADR-0146 §1); page 2 (`work`) is the work page: the strip's
 * sections with a docked prompt in its last five rows. `↓` goes down to it, `↑` from its first row and `Esc` anywhere on it come back.
 *
 * - **Focus has three places**: the landing's prompt, a row of the work page (the strip's focus, by the row's identity: `strip-focus.ts`), and
 *   the work page's docked prompt. There is ONE draft: both prompts draw the same editor, so a message typed on one page is on the other when
 *   the person goes back.
 * - **The key reducer** ({@link reducePageKey}) decides only the moves between the pages and the places; every key it does not take is the
 *   prompt's, the palette's or a row's as it always was (`pass`).
 * - **The slide** ({@link slideOffsets}): in the alternate screen the two pages are one document two screens tall and the screen is a window
 *   onto it; the window travels `rows − 1` rows in four equal steps (three frames between, then the arrival). Inline the pages swap.
 *
 * A data module: it imports nothing from `ink`, `react` or `node:` (ADR-0145 §10), only the legend builder, the line cut and types. Every
 * count it words is a number the caller computed (the snapshot's true totals). The one stored text it draws is the most urgent item's name on
 * the landing's hint ({@link UrgentHead}), which arrives scrubbed, its brackets and arrows made inert and bounded by its builder
 * (`home-attention.ts`'s `urgentName`); here it is only cut further to fit the row.
 */

/** The Home's two pages: the landing, and the work page under it. */
export type HomePage = 'start' | 'work';

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
  return Number.isFinite(rows) ? frameRows(rows) : 0;
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
 * What the work page holds, counted TRULY (MVP-11 unit 7: the snapshot's `totals`, never the rows loaded): under "Attention required" every
 * parked run of this directory, every failed run of the window and every run whose log cannot be read, each run once; this directory's
 * sessions; and its runs that are not under Attention.
 */
export interface WorkCounts {
  readonly attention: number;
  readonly sessions: number;
  readonly runs: number;
}

/**
 * {@link WorkCounts} of a snapshot: this directory's true totals (`HomeSnapshot.totals`), each run counted once by the store (a parked run is
 * not also a run, an unreadable run is one Attention item), however many rows a list loaded or a section draws. The agents are not counted:
 * an agent is listed because a session ran it, so a Home with agents always has sessions to count.
 */
export function workCounts(snapshot: Pick<HomeSnapshot, 'totals'>): WorkCounts {
  return {
    attention: snapshot.totals.attention,
    sessions: snapshot.totals.sessions,
    runs: snapshot.totals.runs,
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
 * The indicator as the hint draws it: the head that carries the `↓`, the words that stay with it (`expires in 5m`, `+2 more need you`: drawn in
 * the head's role and never dropped by themselves), the session and run counts after it, and the head's tone (`danger` for an overdue item: red).
 */
export interface IndicatorParts {
  readonly head: LegendKey;
  readonly extras: readonly LegendItem[];
  readonly sessions: LegendItem | undefined;
  readonly runs: LegendItem | undefined;
  readonly tone?: 'warn' | 'danger' | undefined;
}

/** The session and run counts of the indicator: words, a zero count not drawn. */
function countItems(counts: WorkCounts): {
  readonly sessions: LegendText | undefined;
  readonly runs: LegendText | undefined;
} {
  return {
    sessions:
      counts.sessions > 0 ? { text: counted(counts.sessions, 'session', 'sessions') } : undefined,
    runs: counts.runs > 0 ? { text: counted(counts.runs, 'run', 'runs') } : undefined,
  };
}

/**
 * The indicator's parts by the counts alone, in the order the hint draws them: the head carries the `↓` (the attention count when there is one,
 * in the warning role, else the sessions, else the runs), and the counts after it are words. A zero count is not drawn. Nothing when there is
 * nothing to count. (Page 1 names the most urgent item instead when it has one, {@link LandingHintState.urgent}; this is its last fallback.)
 */
export function indicatorParts(counts: WorkCounts): IndicatorParts | undefined {
  const { sessions, runs } = countItems(counts);
  if (counts.attention > 0)
    return {
      head: { keys: '↓', verb: needsYouWords(counts.attention), role: 'warn' },
      extras: [],
      sessions,
      runs,
    };
  if (sessions !== undefined)
    return { head: { keys: '↓', verb: sessions.text }, extras: [], sessions: undefined, runs };
  if (runs !== undefined)
    return {
      head: { keys: '↓', verb: runs.text },
      extras: [],
      sessions: undefined,
      runs: undefined,
    };
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

/**
 * A hint row: its text and, when part of it is drawn in the warning role (the attention count, or page 1's most urgent item with the words that
 * stay with it), where that part is, and its tone: `danger` (red) for an item whose deadline has passed, else the warning colour.
 */
export interface HintRow {
  readonly text: string;
  readonly warn?:
    | { readonly from: number; readonly to: number; readonly tone?: 'warn' | 'danger' | undefined }
    | undefined;
}

/**
 * The hint row for `items` and `exit`, with the span from the first to the last of `warnItems` that are among the items (they stand together)
 * for the view to draw in the warning role, in `tone`.
 */
function hintRow(
  items: readonly LegendItem[],
  exit: LegendExit,
  warnItems: readonly LegendItem[],
  tone?: 'warn' | 'danger',
): HintRow {
  const text = legend(items, exit);
  const at = items.findIndex((item) => warnItems.includes(item));
  if (at < 0) return { text };
  let last = at;
  const warned = (index: number): boolean => {
    const item = items[index];
    return item !== undefined && warnItems.includes(item);
  };
  while (warned(last + 1)) last += 1;
  const from = at === 0 ? 0 : keyHint(items.slice(0, at)).length + LEGEND_SEPARATOR.length;
  const to = from + keyHint(items.slice(at, last + 1)).length;
  return { text, warn: tone === 'danger' ? { from, to, tone } : { from, to } };
}

/** `Ctrl+C` twice leaves the Home (ADR-0115): the key that leaves the landing, last in every state of its hint. */
export const EXIT_TWICE = exitKey.leave('exit (twice)', 'Ctrl+C');
/** The same key once it is armed: the second press leaves. */
export const EXIT_AGAIN = exitKey.leave('exit (again)', 'Ctrl+C');
/** `Esc` on the work page goes back up to the landing: one step back, nothing changes (the draft stays). */
const BACK_TO_START = exitKey.step('Esc', 'start page');

/**
 * The hint row of either page while the `@` file picker is open over its prompt (ADR-0061 on the Home; ADR-0145 §3): the arrows select, `Enter`
 * chooses (a directory opens, a file is added to the draft), `Esc` closes the picker and the `@` comes back into the draft. It takes the hint's
 * place for as long as the picker is open: no other key of the page answers then.
 */
export const MENTION_HINT = legend(
  [
    { keys: '↑/↓', verb: 'select' },
    { keys: 'Enter', verb: 'choose' },
  ],
  exitKey.close(),
);

/** The fewest rows the picker's list keeps on either page: a marker, the highlighted row and the other marker. */
export const MENTION_MIN_ROWS = 3;
/** The rows of the picker's block besides its list: the rule (or, on page 2, the blank row above it), its `@ dir/` header and the hint row. */
export const MENTION_CHROME_ROWS = 3;

/**
 * The rows the picker's list may take in a terminal of `rows` (the palette's precedent: the picker's block, the prompt row with it, is at most
 * half the terminal): never more than the chat's window of eight, never fewer than {@link MENTION_MIN_ROWS}. 8 at 80×24 and at 100×30.
 */
export function mentionListRows(rows: number, windowRows: number): number {
  if (!Number.isFinite(rows)) return MENTION_MIN_ROWS;
  const half = Math.floor(rows / 2) - MENTION_CHROME_ROWS - 1;
  return Math.max(MENTION_MIN_ROWS, Math.min(windowRows, half));
}

/** The palette's own key, written first wherever the prompt is empty. */
const SLASH_COMMANDS: LegendKey = { keys: '/', verb: 'commands' };
/** The way to start a chat that is always there on a landing with nothing to continue. */
const TYPE_A_MESSAGE: LegendItem = { text: 'type a message to chat' };
/** `Tab` fills the landing prompt's example in (ADR-0146 §1): named only where the example is on screen, an empty prompt on the landing. */
const TAB_FILLS_EXAMPLE: LegendKey = { keys: 'Tab', verb: 'fill the example' };
/** What `Enter` does with no key, the draft kept (ADR-0146 §5). */
const CONNECT_A_PROVIDER: LegendKey = { keys: 'Enter', verb: 'connect a provider' };
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
 * provider and the message is kept. `newline` is the priority of `[Ctrl+J] newline` (not offered with no key: `Enter` connects first), and
 * `kept` the priority of `your message is kept`: the landing gives it up BEFORE the `↓ N need you` cue (round 2, correctness F7: with a
 * draft and no key the call to connect and the reassurance filled the row up to 86 columns and the cue, the landing's one sign of a gate that
 * waits, was gone at 80), the docked prompt keeps it whole.
 */
function draftItems(
  state: { readonly draft: string; readonly keyless: boolean },
  newline: number | 'required',
  kept: number | 'required' = 'required',
): readonly HintPart[] {
  if (state.draft.trimStart().startsWith('/'))
    return [
      { item: { keys: 'Enter', verb: 'run' }, priority: 'required' },
      { item: NEWLINE, priority: newline },
    ];
  if (state.keyless)
    return [
      { item: CONNECT_A_PROVIDER, priority: 'required' },
      { item: { text: 'your message is kept' }, priority: kept },
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
  /**
   * The most urgent item of "Attention required", as page 1 names it (`home-attention.ts`'s `urgentWords`: its name already scrubbed and
   * bounded there), or none: the indicator then counts (`↓ 2 need you`).
   */
  readonly urgent?: UrgentHead | undefined;
  /** The row's columns: the terminal less the margin. */
  readonly columns: number;
}

/**
 * Page 1's most urgent item (MVP-11 unit 7, the maintainer's ruling 5): its name (stored text, scrubbed and bounded by its builder; none for a
 * run whose log cannot be read, whose words say so), the words of its kind, its deadline words (`expires in 5m`) and the same deadline compact
 * (`5m left`; absent reads as the deadline itself: `expired` has no shorter form), whether the deadline has passed, and whether the item is only
 * the most urgent of those READ (`partial`: more items wait than were read, and an unread one may outrank it; absent reads as no).
 */
export interface UrgentHead {
  readonly name: string | undefined;
  readonly words: string;
  readonly deadline: string | undefined;
  readonly deadlineCompact?: string | undefined;
  readonly overdue: boolean;
  readonly partial?: boolean | undefined;
}

/** The fewest columns of the urgent item's name the hint keeps before it says the count instead (`↓ 3 need you`). */
export const URGENT_NAME_FLOOR = 6;

/**
 * The parts of the landing's hint with nothing typed (see {@link landingHint}), around the very `indicator` the caller marks for the warning
 * colour (the span is found by the item's identity).
 */
function emptyLandingParts(
  state: LandingHintState,
  indicator: IndicatorParts | undefined,
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
    for (const extra of indicator.extras) parts.push({ item: extra, priority: 'required' });
    if (indicator.sessions !== undefined) parts.push({ item: indicator.sessions, priority: 3 });
    if (indicator.runs !== undefined) parts.push({ item: indicator.runs, priority: 2 });
  } else if (!connects) parts.push({ item: TYPE_A_MESSAGE, priority: 1 });
  // The example is on screen (and `Tab` fills it in) only behind a prompt with nothing in it at all, not behind a blank draft (CO77).
  if (state.draft.text.length === 0)
    parts.push({ item: TAB_FILLS_EXAMPLE, priority: indicator === undefined ? 2 : 0 });
  return parts;
}

/**
 * Whether the prompt holds a draft, for the hints: something besides whitespace (MVP-11 unit 7, round 1: CO77). `Enter` on a draft of nothing
 * but spaces sends nothing and does what it does on an empty prompt (`submit` trims it), so the hint must not promise `Enter start the chat`.
 */
function hasDraft(draft: EditorState): boolean {
  return draft.text.trim().length > 0;
}

/** `+2 more need you`, or (short) `+2 more`: the others of Attention, the count never dropped while there are any. */
function othersItem(others: number, short: boolean): readonly LegendItem[] {
  if (others <= 0) return [];
  if (short) return [{ text: `+${String(others)} more` }];
  return [{ text: `+${String(others)} more ${others === 1 ? 'needs' : 'need'} you` }];
}

/** What one step of the named head keeps: the deadline in its long or compact form or not at all, the others of Attention in their long or short form or not at all, and whether the session and run counts ride along (they are droppable parts). */
interface HeadStep {
  readonly deadline: 'long' | 'compact' | 'none';
  readonly others: 'long' | 'short' | 'none';
  readonly counts: boolean;
}

/** `+2 more need you` with the counts that follow it; the fullest step, which every ladder starts from. */
const FULL_STEP: HeadStep = { deadline: 'long', others: 'long', counts: true };

/**
 * The steps a named head gives things up in, fullest first, and what it keeps while its NAME is cut ({@link urgentIndicators}). The deadline
 * outranks the count of the others (round 2, observation F3: page 1's head lost `expired` and the deadline at ordinary widths while `need you`
 * outlived them, and under no colour nothing else says an item is overdue):
 *
 * - **A deadline that is ahead** (`expires in 5m`): the session and run counts go first (they are the droppable parts of the first step), then
 *   `+2 more need you` becomes `+2 more`, then the others are given up whole (`↓ release-notes needs approval · expires in 5m`, the maintainer's
 *   own example, whole wherever it fits), then the deadline becomes its compact form (`5m left`). The name is then cut around the compact
 *   deadline, and the count of ALL of Attention is what the head says when the name cannot keep its floor.
 * - **An overdue item** (`expired`, which has no shorter form): the same steps down to the others given up, and then it stays: the name is cut
 *   around `expired`, which is never given up.
 * - **No deadline** (a failed run, a run that cannot be read, a parked run with no deadline): the counts, `+2 more need you`, `+2 more`, which
 *   stays through the cut name as it always has; there is no deadline for the others to give way to.
 */
function headSteps(urgent: UrgentHead): {
  readonly steps: readonly HeadStep[];
  readonly kept: HeadStep;
} {
  if (urgent.deadline === undefined) {
    const cutName: HeadStep = { deadline: 'none', others: 'short', counts: false };
    return { steps: [{ ...FULL_STEP, deadline: 'none' }, cutName], kept: cutName };
  }
  const alone: HeadStep = { deadline: 'long', others: 'none', counts: false };
  const steps: HeadStep[] = [FULL_STEP, { ...FULL_STEP, others: 'short', counts: false }, alone];
  if (urgent.overdue) return { steps, kept: alone };
  const compact: HeadStep = { ...alone, deadline: 'compact' };
  return { steps: [...steps, compact], kept: compact };
}

/**
 * The indicators that name the most urgent item, from the fullest to the barest, in the order of what a narrow row gives up ({@link headSteps}),
 * then the name cut a column at a time down to {@link URGENT_NAME_FLOOR}. The `↓` is in every one, and the count of ALL of Attention in the
 * fallback the caller draws when none fits.
 *
 * With an item that is only the most urgent of those READ (`urgent.partial`, round 2: more paused runs wait than the Home reads, and an unread
 * one may be overdue) the head does not call it the most urgent: it leads with the count of everything that needs the person and names the
 * item after it as one of them: `↓ 16 need you · release-notes needs approval · expires in 5m`. The same steps apply, with no `+N more`, for
 * the count already says them all.
 */
function urgentIndicators(
  urgent: UrgentHead,
  counts: WorkCounts,
  width: (text: string) => number,
): readonly IndicatorParts[] {
  const others = Math.max(0, counts.attention - 1);
  const tone = urgent.overdue ? 'danger' : 'warn';
  const partial = urgent.partial === true;
  const deadlines = {
    long: urgent.deadline,
    compact: urgent.deadlineCompact ?? urgent.deadline,
    none: undefined,
  } as const;
  const words = (name: string | undefined): string =>
    name === undefined ? urgent.words : `${name} ${urgent.words}`;
  const partsOf = (name: string | undefined, step: HeadStep): IndicatorParts => {
    const text = deadlines[step.deadline];
    const deadline: readonly LegendItem[] = text === undefined ? [] : [{ text }];
    const rest = step.counts ? countItems(counts) : { sessions: undefined, runs: undefined };
    if (partial)
      return {
        head: { keys: '↓', verb: needsYouWords(counts.attention), role: 'warn' },
        extras: [{ text: words(name) }, ...deadline],
        ...rest,
        tone,
      };
    return {
      head: { keys: '↓', verb: words(name), role: 'warn' },
      extras: [
        ...deadline,
        ...(step.others === 'none' ? [] : othersItem(others, step.others === 'short')),
      ],
      ...rest,
      tone,
    };
  };
  const { steps, kept } = headSteps(urgent);
  const all = steps.map((step) => partsOf(urgent.name, step));
  const name = urgent.name;
  if (name !== undefined)
    for (let columns = width(name) - 1; columns >= URGENT_NAME_FLOOR; columns -= 1)
      all.push(partsOf(clipLine(name, columns), kept));
  return all;
}

/**
 * The landing's hint naming the most urgent item (MVP-11 unit 7): the first of {@link urgentIndicators} for which the whole row fits, its head
 * and the words that stay with it in the warning role (red when the deadline has passed), or `undefined` when none fits (the caller then says
 * the count, `↓ 3 need you`, which a draft may still give way to).
 */
function urgentHint(
  state: LandingHintState,
  urgent: UrgentHead,
  width: (text: string) => number,
): HintRow | undefined {
  for (const indicator of urgentIndicators(urgent, state.counts, width)) {
    const parts: readonly HintPart[] = hasDraft(state.draft)
      ? [
          ...draftItems({ draft: state.draft.text, keyless: state.keyless }, 1, 1),
          { item: indicator.head, priority: 'required' },
          ...indicator.extras.map((item): HintPart => ({ item, priority: 'required' })),
        ]
      : emptyLandingParts(state, indicator);
    const items = fitInOrder(parts, EXIT_TWICE, state.columns, width);
    if (width(legend(items, EXIT_TWICE)) <= state.columns)
      return hintRow(items, EXIT_TWICE, [indicator.head, ...indicator.extras], indicator.tone);
  }
  return undefined;
}

/**
 * The landing's hint (page 1). Armed, only the second `Ctrl+C`. With a draft, the draft's own keys and then the indicator's head; what gives
 * way first is `[Ctrl+J] newline`, then the head (OB73: the `↓ N need you` cue is the landing's one sign of a gate that waits, and it stays at 80
 * columns while the person types). With an empty prompt (or one of spaces alone, which `Enter` treats as empty): (no key) `Enter connect a
 * provider`, `[/] commands`, then the INDICATOR when there is something to continue
 * (`↓ 1 needs you` in the warning role, then the session and run counts; with no attention row the `↓` stands on the first count), else `type a
 * message to chat`, then `Tab fill the example`; `[Ctrl+C] exit (twice)` last. What does not fit the row is dropped: the example first, then the
 * call to connect (the status line says it), then the runs, then the sessions; never `[/] commands`, never the `↓`, never the exit. With
 * nothing to continue it is the empty Home's hint as it was.
 *
 * With an item under Attention (MVP-11 unit 7, the maintainer's ruling 5) the indicator's head NAMES the most urgent one instead of counting:
 * `↓ release-notes needs approval · expires in 5m · +2 more need you`, then the true session and run counts. At narrow widths it gives up, in
 * order ({@link headSteps}): the counts, `+2 more need you` as `+2 more`, the others whole, the deadline's long form for its compact one
 * (`5m left`), the deadline itself (never `expired`, which stays with an overdue item), then the name's columns (down to
 * {@link URGENT_NAME_FLOOR}), and when even that does not fit the head says the count (`↓ 3 need you`) as before. A head that is only the most
 * urgent of the items READ leads with that count instead (`↓ 16 need you · release-notes needs approval · expires in 5m`, {@link urgentIndicators}).
 * The `↓` always stays, and `+N more` is the count of the others, the named item the one more.
 *
 * With a draft and no key `your message is kept` gives way before the `↓ N need you` cue does, as `[Ctrl+J] newline` does ({@link draftItems}).
 */
export function landingHint(state: LandingHintState, width: (text: string) => number): HintRow {
  if (state.interruptArmed) return { text: legend([], EXIT_AGAIN) };
  if (state.urgent !== undefined) {
    const named = urgentHint(state, state.urgent, width);
    if (named !== undefined) return named;
  }
  const indicator = indicatorParts(state.counts);
  const warnHead = indicator?.head.role === 'warn' ? [indicator.head] : [];
  const parts: readonly HintPart[] = hasDraft(state.draft)
    ? [
        ...draftItems({ draft: state.draft.text, keyless: state.keyless }, 1, 1),
        ...(indicator === undefined ? [] : [{ item: indicator.head, priority: 2 }]),
      ]
    : emptyLandingParts(state, indicator);
  return hintRow(fitInOrder(parts, EXIT_TWICE, state.columns, width), EXIT_TWICE, warnHead);
}

/** What a focused row is, for what `Enter` says on it (`strip-focus.ts` roles; a parked row says what it waits on). */
export type WorkRowCue =
  | { readonly role: 'session' }
  | { readonly role: 'failed' | 'recent' | 'unreadable' }
  | { readonly role: 'parked'; readonly waits: ParkedRunKind | undefined };

/** What `Enter` does on a focused parked row, by what it waits on (a run whose kind is not read yet opens its card, as a gate's does). */
const PARKED_ENTER_VERB: Readonly<Record<ParkedRunKind, string>> = {
  approval: 'open',
  // The card of an input gate takes no typed value: it shows the shell command that does, and offers a rejection.
  input: 'show how to answer',
  review: 'open',
  budget: 'open',
  several: 'open',
  media: 'ask to continue',
  none: 'say why',
};

/**
 * What `Enter` does on the focused row (MVP-11 unit 7: the rows carry no key any more; the hint row names the focused row's): a parked run
 * opens its gate or budget card (`open`), or, for an input gate whose card takes no typed value, shows how to answer it; a run parked on media
 * jobs asks to continue it; a run with nothing to answer says why; a failed or recent run opens its details; a session is resumed; a run whose
 * log cannot be read says why (a read-only card). The hint must not promise a gate where there is none.
 */
function rowEnterItem(cue: WorkRowCue): LegendKey {
  switch (cue.role) {
    case 'session':
      return { keys: 'Enter', verb: 'resume' };
    case 'unreadable':
      return { keys: 'Enter', verb: 'why' };
    case 'failed':
    case 'recent':
      return { keys: 'Enter', verb: 'details' };
    case 'parked':
      return { keys: 'Enter', verb: PARKED_ENTER_VERB[cue.waits ?? 'approval'] };
  }
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
  if (hasDraft(state.draft)) {
    // The draft's own words first; `↑ back to the list` before `[Ctrl+J] newline`, which is the first to give way.
    const own = draftItems({ draft: state.draft.text, keyless: state.keyless }, 1);
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

/** The rows above the work page's list when the terminal has room: the way back (`↑ start page`) and a blank row. */
const WORK_HEAD_ROWS = 2;

/** The terminal rows from which the blank row under the way back is drawn: below it whitespace gives way before words (`home-work-budget.ts`). */
export const WORK_SPACIOUS_ROWS = 26;

/** The rows above the work page's list in a terminal of `rows`: the way back and, from {@link WORK_SPACIOUS_ROWS}, the blank row under it. */
export function workHeadRows(rows: number): number {
  return Number.isFinite(rows) && rows >= WORK_SPACIOUS_ROWS ? WORK_HEAD_ROWS : 1;
}

/** The docked prompt block's rows besides the prompt's own: a blank lead row, the rule, the status line and the hint. */
export const DOCKED_CHROME_ROWS = 4;

/**
 * The rows the work page's list may take: `rows − 1` (no frame is taller) less the way back and its blank row (none under 26 rows), the block at
 * the bottom (the docked prompt, the palette or the exit-guard card) and the notice with its blank row. Never negative. At 80×24 with the resting
 * block: 17; at 100×30: 22.
 */
export function workListRows(rows: number, bottomRows: number, noticeRows = 0): number {
  if (!Number.isFinite(rows)) return 0;
  const notice = noticeRows > 0 ? noticeRows + 1 : 0;
  return Math.max(0, frameRows(rows) - workHeadRows(rows) - bottomRows - notice);
}

/**
 * The fewest list rows the work page keeps beside a long draft (OB71): the first row and the marker of every section, Attention's heading,
 * "Continue" and the titles with them (`workListFloor`, 10 with all three sections): no section with items is ever gone, whatever the draft
 * and the notice. Below it (a notice that is more than its minimum, an open palette) the lowest sections go first.
 */
export const WORK_LIST_MIN_ROWS = workListFloor({ attention: true, sessions: true, runs: true });

/**
 * The most rows the work page's docked prompt editor may take (OB71): what `rows − 1` leaves after the way back and its blank row, the docked
 * block's other four rows and {@link WORK_LIST_MIN_ROWS} of the list, never fewer than a window can have. A longer draft is drawn as a window
 * around the cursor (`▲/▼ N more`), so the way back, the list's first rows, the rule, the status line and the hint stay on the screen and the
 * frame is never as tall as the terminal. 8 at 80×24 (a list of 10 rows beside it), 13 at 100×30.
 */
export function workEditorRows(rows: number): number {
  return Math.max(
    PROMPT_WINDOW_MIN_ROWS,
    frameRows(rows) - workHeadRows(rows) - DOCKED_CHROME_ROWS - WORK_LIST_MIN_ROWS,
  );
}
