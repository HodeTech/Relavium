/**
 * The work page's ALLOCATION (MVP-11 unit 7; the maintainer's ruling of 2026-11-26: "max 4 under Attention required, then an overflow marker
 * and N more; Sessions max 3; Runs max 3; the numbers may grow or shrink with the page; show these numbers TRUE"): which rows of each section
 * the list draws in the rows it has, and the `▲ N more` / `▼ N more` markers. PURE and data only: integers in, windows out (it imports nothing
 * at all, ADR-0145 §10), so the page's arithmetic is tested apart from the view.
 *
 * **The layout it counts** (the view draws exactly this, `home-work-page.tsx`): "Attention required" (one heading row) and its rows; then,
 * when any of the other sections is drawn, a blank row (only after Attention, and only when it costs no row: see "Whitespace"), the dim
 * "Continue" heading, and each section's title row and rows (Sessions, Runs, Agents). {@link workListChrome} is that count.
 *
 * **A section's window.** A section shows at most its CAP of rows ({@link WORK_ITEM_CAPS}); one with more than it shows ends with a dim
 * `▼ N more` and, scrolled down to the focus, starts with `▲ N more`. N is the section's TRUE total (the snapshot's `totals`) less what is
 * shown, so the rows shown and the markers' Ns are always the total. A marker counts inside the section's rows and is never dropped to make
 * room for a row: it REPLACES the last row (its N then counts that row too). A marker that would hide exactly ONE row draws the row in its
 * place instead (`▼ 1 more` takes the line the row would take: strictly more information, and still true), so a section whose total is one
 * more than its cap shows all its rows. The `▼` says only `N more` where `↓` reaches every row it counts (they are loaded: the keys walk the
 * loaded rows and the window follows), and `belowLoaded` is false where some are not, so the view adds where to find them.
 *
 * **Whitespace gives way before words, words before rows.** The blank row between Attention and "Continue" is drawn only when the base layout
 * (every section at its cap with its marker) fits WITH it ({@link WorkAllocation.gap}); the blank under the way back is the page's own, gone
 * below 26 terminal rows (`workHeadRows`). At 80×24 both are gone and the page shows Attention 4, Sessions 3 and Runs 3 with their three
 * markers in the 17 rows it has (the ruling's numbers); at 26 rows and above the blank rows return.
 *
 * **Priority when rows run short**, in this order, and a step that does not fit STOPS the ladder (a lower step is never served with the rows a
 * higher one could not use): (1) the FOCUSED row; (2) every section that has items, Attention first, then the sessions, then the runs, as
 * its marker alone (`▼ N more`) or its only row; (3) the first row of each beside its marker, same order ({@link workListFloor} is the rows
 * that takes: 10 with all three sections); (4) the focused section's window (its row, the `▲` and `▼` around it and a neighbour row: four
 * rows, {@link comfortRows}); (5) Attention up to its cap, then the sessions and the runs one row each in turn up to theirs; (6) only when
 * every section has its rows at its cap and rows are left over, the caps open: Attention up to {@link ATTENTION_ROWS_MAX}, then the
 * sessions and the runs alike up to what is loaded (a taller page, or a page where the other sections are short); (7) the agents last, up to
 * their cap. Below the floor (an open palette, a very long draft with a notice) the lowest steps are the ones that go, and a section that
 * has items always shows at least its marker as long as the ladder reaches it.
 *
 * **No re-flow under the cursor.** The rows each section takes are a function of the rows, the demands and WHICH SECTION holds the focus,
 * never of the focused row's index: walking `↓` inside one section changes what its window shows, not how many rows any section takes, so the
 * sections below the cursor do not breathe. They change only when the focus crosses into another section (or onto the prompt). When the
 * focused section is a later one, the earlier sections give back their growth (step 5 comes after step 4) before the focused window drops to
 * one row.
 *
 * **A list shorter than the focused row and its two markers** (a notice that took nearly every row, ADR-0146 §1's room for the focused row
 * is the notice's to keep, `home-notice.ts`): the focused row is kept and the `▲` gives way first, then the `▼`.
 */

/** What a section asks for: the rows it LOADED (the keys reach these), its TRUE total, and the focused row's index when the focus is in it. */
export interface SectionDemand {
  readonly loaded: number;
  readonly total: number;
  readonly focus?: number | undefined;
}

export interface WorkBudgetInput {
  /** The rows of the list region (`workListBudget`). */
  readonly rows: number;
  readonly attention: SectionDemand;
  readonly sessions: SectionDemand;
  readonly runs: SectionDemand;
  readonly agents: SectionDemand;
}

/**
 * The rows of one section that are drawn: the loaded rows `[start, start + count)`, and the Ns of the markers (`0`: no marker). `belowLoaded`
 * says whether every row the `▼` counts is loaded (`↓` reaches it); when it is false the view names where the rest are.
 */
export interface SectionWindow {
  readonly start: number;
  readonly count: number;
  readonly above: number;
  readonly below: number;
  readonly belowLoaded: boolean;
}

export interface WorkAllocation {
  readonly attention: SectionWindow;
  readonly sessions: SectionWindow;
  readonly runs: SectionWindow;
  readonly agents: SectionWindow;
  /** Whether the blank row under Attention (above "Continue") is drawn: it is the first row to go when the list is short. */
  readonly gap: boolean;
  /** The rows the list takes, its headings and titles included: never more than it was given. */
  readonly rows: number;
}

type SectionName = 'attention' | 'sessions' | 'runs' | 'agents';

/** The base caps, in rows of items (the maintainer's 4 / 3 / 3; the agents, lowest priority, 3). */
export const WORK_ITEM_CAPS: Readonly<Record<SectionName, number>> = {
  attention: 4,
  sessions: 3,
  runs: 3,
  agents: 3,
};

/** The most Attention rows a page shows when the caps open (the parked rows the controller keeps are eight too). */
export const ATTENTION_ROWS_MAX = 8;

const EMPTY: SectionWindow = { start: 0, count: 0, above: 0, below: 0, belowLoaded: true };

/**
 * The rows of the headings and titles for sections drawn with these many rows each (`0`: not drawn); `gap` (default: drawn) is the blank row
 * under Attention, which only exists when a Continue section is drawn under it.
 */
export function workListChrome(drawn: Readonly<Record<SectionName, number>>, gap = true): number {
  const attention = drawn.attention > 0 ? 1 : 0;
  const titles = (['sessions', 'runs', 'agents'] as const).filter((name) => drawn[name] > 0).length;
  if (titles === 0) return attention;
  // the blank row under Attention (only when it is drawn), the "Continue" heading, and a title per section
  return attention + (gap ? attention : 0) + 1 + titles;
}

/**
 * The fewest rows the list needs to keep every section it has at its first row beside its marker (rung 3 of the ladder): Attention's heading,
 * row and marker; "Continue" and, per section, its title, row and marker. No blank row (it is the first to go), no agents (the last). The
 * notice and the draft leave the list this much (`home-notice.ts`, `workEditorRows`).
 */
export function workListFloor(has: {
  readonly attention: boolean;
  readonly sessions: boolean;
  readonly runs: boolean;
}): number {
  const attention = has.attention ? 3 : 0;
  const titles = (has.sessions ? 1 : 0) + (has.runs ? 1 : 0);
  return attention + (titles === 0 ? 0 : 1 + titles * 3);
}

/** A demand as whole, sane numbers: the total is never below what was loaded, and a focus is on a loaded row or none. */
function normalized(demand: SectionDemand): {
  readonly loaded: number;
  readonly total: number;
  readonly focus: number | undefined;
} {
  const whole = (value: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const loaded = whole(demand.loaded);
  const total = Math.max(loaded, whole(demand.total));
  const focus =
    demand.focus !== undefined &&
    Number.isInteger(demand.focus) &&
    demand.focus >= 0 &&
    demand.focus < loaded
      ? demand.focus
      : undefined;
  return { loaded, total, focus };
}

/**
 * A marker that would hide exactly ONE row draws that row in its place: the line is the same, the information is more, and the numbers stay
 * true (`above + count + below` is still the total). A row that was not loaded cannot be drawn: that marker stays, and says where it is.
 */
function absorbSingles(window: SectionWindow, loaded: number): SectionWindow {
  const above = window.above === 1;
  const below = window.below === 1 && window.start + window.count < loaded;
  if (!above && !below) return window;
  return {
    ...window,
    start: above ? window.start - 1 : window.start,
    count: window.count + (above ? 1 : 0) + (below ? 1 : 0),
    above: above ? 0 : window.above,
    below: below ? 0 : window.below,
  };
}

/** The window before a single hidden row is drawn in place of its marker ({@link absorbSingles}). */
function rawWindow(rows: number, demand: SectionDemand, cap: number): SectionWindow {
  const { loaded, total, focus } = normalized(demand);
  const room = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
  if (room === 0 || total === 0) return EMPTY;
  const belowLoaded = total <= loaded;
  if (total <= Math.min(room, cap) && belowLoaded) return { ...EMPTY, count: total };
  // Something is hidden. The focus (when there is one) fits in the first window: the rows from the top and the `▼`.
  if (focus === undefined || focus <= Math.min(room - 1, cap) - 1) {
    const count = Math.min(room - 1, loaded, cap);
    return { start: 0, count, above: 0, below: total - count, belowLoaded };
  }
  // Deeper: a window that ends at the last row needs only the `▲`.
  const toEnd = Math.min(room - 1, cap);
  if (belowLoaded && toEnd >= 1 && focus >= total - toEnd)
    return { start: total - toEnd, count: toEnd, above: total - toEnd, below: 0, belowLoaded };
  const count = Math.min(room - 2, cap);
  if (count >= 1) {
    const start = focus - count + 1;
    return { start, count, above: start, below: total - start - count, belowLoaded };
  }
  // Too short for the focused row and both markers: the focused row, then the `▼`.
  return {
    start: focus,
    count: 1,
    above: 0,
    below: room >= 2 ? total - focus - 1 : 0,
    belowLoaded,
  };
}

/**
 * The window of one section drawn in `rows` rows (its markers included) showing at most `cap` items. The rows shown and the markers' Ns are
 * the total, except in a list too short for the focused row and its two markers (the `▲` gives way first, then the `▼`). A marker that would
 * hide exactly one row is that row instead, so a window may show one row more than `cap`.
 */
export function sectionWindow(
  rows: number,
  demand: SectionDemand,
  cap = Number.POSITIVE_INFINITY,
): SectionWindow {
  return absorbSingles(rawWindow(rows, demand, cap), normalized(demand).loaded);
}

/** The rows a section needs to be there: its marker alone (`▼ N more`), or its only row. */
function presenceRows(demand: SectionDemand): number {
  return normalized(demand).total === 0 ? 0 : 1;
}

/** The rows a section needs to show its first row (or its only rows) beside its marker. */
function minimumRows(demand: SectionDemand): number {
  const { loaded, total } = normalized(demand);
  if (total === 0) return 0;
  if (loaded === 0) return 1; // the marker alone: counted rows that were not loaded
  return total === 1 ? 1 : 2;
}

/** The rows a section needs to show its items up to `cap` and, when it has more, the marker. */
function targetRows(demand: SectionDemand, cap: number): number {
  const { loaded, total } = normalized(demand);
  if (total === 0) return 0;
  if (total <= cap && total <= loaded) return total;
  return Math.min(cap, loaded) + 1;
}

/**
 * The rows the focused section is given beside its first row, whatever row the focus is on (so the allocation never depends on the index): the
 * window a focus in the middle needs, the `▲`, two rows and the `▼`; fewer when the whole section is fewer.
 */
function comfortRows(demand: SectionDemand): number {
  const { loaded, total } = normalized(demand);
  if (total === 0) return 0;
  if (loaded === 0) return 1;
  return Math.min(targetRows(demand, Number.POSITIVE_INFINITY), 4);
}

const SECTIONS: readonly SectionName[] = ['attention', 'sessions', 'runs', 'agents'];
const STARTS = ['attention', 'sessions', 'runs'] as const;

/** The section rows and caps the allocation is building, and whether the blank row under Attention is drawn. */
interface Slots {
  readonly rows: Record<SectionName, number>;
  readonly caps: Record<SectionName, number>;
  readonly gap: boolean;
}

function usedRows(rows: Readonly<Record<SectionName, number>>, gap: boolean): number {
  return workListChrome(rows, gap) + SECTIONS.reduce((sum, name) => sum + rows[name], 0);
}

/** `name` raised to `rows` rows when the list still fits (never lowered): whether it fits. */
function raise(slots: Slots, budget: number, name: SectionName, rows: number): boolean {
  const before = slots.rows[name];
  if (rows <= before) return true;
  slots.rows[name] = rows;
  if (usedRows(slots.rows, slots.gap) <= budget) return true;
  slots.rows[name] = before;
  return false;
}

/** `name` raised towards `rows`, one row at a time, as far as the list fits. */
function raiseAsFar(slots: Slots, budget: number, name: SectionName, rows: number): void {
  for (let next = slots.rows[name] + 1; next <= rows; next += 1)
    if (!raise(slots, budget, name, next)) return;
}

/** Grow the drawn sections of `names` one row each in turn, up to their targets at their caps, while the list fits. */
function growInTurn(
  slots: Slots,
  input: WorkBudgetInput,
  budget: number,
  names: readonly SectionName[],
): void {
  const open = new Set(names.filter((name) => slots.rows[name] > 0));
  while (open.size > 0) {
    for (const name of [...open]) {
      const target = targetRows(input[name], slots.caps[name]);
      if (slots.rows[name] >= target || !raise(slots, budget, name, slots.rows[name] + 1))
        open.delete(name);
    }
  }
}

/** Whether every section that has rows has them all at its base cap: only then do the caps open. */
function baseReached(slots: Slots, input: WorkBudgetInput): boolean {
  return STARTS.every((name) => slots.rows[name] >= targetRows(input[name], WORK_ITEM_CAPS[name]));
}

/** The rows of the base layout (every section at its base cap, its marker included, no agents) with or without the blank row. */
function baseLayoutRows(input: WorkBudgetInput, gap: boolean): number {
  const rows = {
    attention: targetRows(input.attention, WORK_ITEM_CAPS.attention),
    sessions: targetRows(input.sessions, WORK_ITEM_CAPS.sessions),
    runs: targetRows(input.runs, WORK_ITEM_CAPS.runs),
    agents: 0,
  };
  return usedRows(rows, gap);
}

/**
 * The first three rungs of the ladder: the focused row, every section there, the first row of each. A section that does not fit stops the
 * ladder (`false`): a lower section is never given the rows a higher one could not use, and nothing grows after it. The sections above it
 * that did start still take their first rows from what is left (a higher section's first row is worth more than a lower one's marker); a
 * first row costs one row once its section is there, so the rung that fails there leaves nothing for a later one.
 */
function startSections(
  slots: Slots,
  input: WorkBudgetInput,
  budget: number,
  focused: SectionName | undefined,
): boolean {
  if (focused !== undefined && !raise(slots, budget, focused, 1)) return false;
  for (const name of STARTS) if (!raise(slots, budget, name, presenceRows(input[name]))) break;
  // the section that did not fit is still at no rows, so its first row does not fit either: this loop ends the ladder there
  for (const name of STARTS)
    if (!raise(slots, budget, name, minimumRows(input[name]))) return false;
  return true;
}

/** The base caps, then, when rows are left over, the opened caps; then the agents. Every step costs a row at a time. */
function growSections(slots: Slots, input: WorkBudgetInput, budget: number): void {
  growInTurn(slots, input, budget, ['attention']);
  growInTurn(slots, input, budget, ['sessions', 'runs']);
  if (baseReached(slots, input)) {
    slots.caps.attention = ATTENTION_ROWS_MAX;
    growInTurn(slots, input, budget, ['attention']);
    slots.caps.sessions = Number.POSITIVE_INFINITY;
    slots.caps.runs = Number.POSITIVE_INFINITY;
    growInTurn(slots, input, budget, ['sessions', 'runs']);
  }
  if (raise(slots, budget, 'agents', minimumRows(input.agents)))
    growInTurn(slots, input, budget, ['agents']);
}

/**
 * Each section's window in `input.rows` rows, by the ladder of the module notes: the focused row, every section there, the first row of each,
 * the focused window, the base caps (Attention first, then the sessions and the runs in turn), the opened caps when rows are left over, and the
 * agents last.
 */
export function allocateWorkList(input: WorkBudgetInput): WorkAllocation {
  const budget = Number.isFinite(input.rows) ? Math.max(0, Math.floor(input.rows)) : 0;
  const focused = SECTIONS.find((name) => normalized(input[name]).focus !== undefined);
  const slots: Slots = {
    rows: { attention: 0, sessions: 0, runs: 0, agents: 0 },
    caps: { ...WORK_ITEM_CAPS },
    // whitespace first: the blank row is drawn only when the base layout fits with it
    gap: baseLayoutRows(input, true) <= budget,
  };
  const started = startSections(slots, input, budget, focused);
  if (focused !== undefined) raiseAsFar(slots, budget, focused, comfortRows(input[focused]));
  if (started) growSections(slots, input, budget);
  const window = (name: SectionName): SectionWindow =>
    sectionWindow(slots.rows[name], input[name], slots.caps[name]);
  const windows = {
    attention: window('attention'),
    sessions: window('sessions'),
    runs: window('runs'),
    agents: window('agents'),
  };
  const drawn = (shown: SectionWindow): number =>
    shown.count + (shown.above > 0 ? 1 : 0) + (shown.below > 0 ? 1 : 0);
  const drawnRows = {
    attention: drawn(windows.attention),
    sessions: drawn(windows.sessions),
    runs: drawn(windows.runs),
    agents: drawn(windows.agents),
  };
  return { ...windows, gap: slots.gap, rows: usedRows(drawnRows, slots.gap) };
}
