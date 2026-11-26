/**
 * The work page's ALLOCATION (MVP-11 unit 7; the maintainer's ruling of 2026-11-26: "max 4 under Attention required, then an overflow marker
 * and N more; Sessions max 3; Runs max 3; the numbers may grow or shrink with the page; show these numbers TRUE"): which rows of each section
 * the list draws in the rows it has, and the `▲ N more` / `▼ N more` markers. PURE and data only: integers in, windows out (it imports nothing
 * at all, ADR-0145 §10), so the page's arithmetic is tested apart from the view.
 *
 * **The layout it counts** (the view draws exactly this, `home-work-page.tsx`): "Attention required" (one heading row) and its rows; then,
 * when any of the other sections is drawn, a blank row (only after Attention), the dim "Continue" heading, and each section's title row and
 * rows (Sessions, Runs, Agents). {@link workListChrome} is that count.
 *
 * **A section's window.** A section shows at most its CAP of rows ({@link WORK_ITEM_CAPS}); one with more than it shows ends with a dim
 * `▼ N more` and, scrolled down to the focus, starts with `▲ N more`. N is the section's TRUE total (the snapshot's `totals`) less what is
 * shown, so the rows shown and the markers' Ns are always the total. A marker counts inside the section's rows and is never dropped to make
 * room for a row: it REPLACES the last row (its N then counts that row too). The `▼` says only `N more` where `↓` reaches every row it counts
 * (they are loaded: the keys walk the loaded rows and the window follows), and `belowLoaded` is false where some are not, so the view adds
 * where to find them.
 *
 * **Priority when rows run short**, in this order: (1) the FOCUSED row, with the markers around it; (2) the first row of every section that
 * has one, Attention first, then the sessions, then the runs; (3) Attention up to its cap, then the sessions and the runs one row each in
 * turn up to theirs; (4) only when every section has its rows at its cap and rows are left over, the caps open: Attention up to
 * {@link ATTENTION_ROWS_MAX}, then the sessions and the runs alike up to what is loaded (a taller page, or a page where the other sections are
 * short); (5) the agents last, up to their cap. At 80×24 with five items in each section this keeps Attention's four and its marker and the
 * sessions' and the runs' first two and their markers: their four rows each and the chrome need 18 of the 16 rows.
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

/** The rows of the headings and titles for sections drawn with these many rows each (`0`: not drawn). */
export function workListChrome(drawn: Readonly<Record<SectionName, number>>): number {
  const attention = drawn.attention > 0 ? 1 : 0;
  const titles = (['sessions', 'runs', 'agents'] as const).filter((name) => drawn[name] > 0).length;
  if (titles === 0) return attention;
  // the blank row under Attention (only when it is drawn), the "Continue" heading, and a title per section
  return attention + attention + 1 + titles;
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
 * The window of one section drawn in `rows` rows (its markers included) showing at most `cap` items. The rows shown and the markers' Ns are
 * the total, except in a list too short for the focused row and its two markers (the `▲` gives way first, then the `▼`).
 */
export function sectionWindow(
  rows: number,
  demand: SectionDemand,
  cap = Number.POSITIVE_INFINITY,
): SectionWindow {
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

/** The rows a section needs to show its first row (or, with the focus in it, the focused row) and the markers around it. */
function minimumRows(demand: SectionDemand): number {
  const { loaded, total, focus } = normalized(demand);
  if (total === 0) return 0;
  if (loaded === 0) return 1; // the marker alone: counted rows that were not loaded
  if (focus !== undefined)
    return Math.min(total, 1 + (focus > 0 ? 1 : 0) + (focus < total - 1 ? 1 : 0));
  return total === 1 ? 1 : 2;
}

/** The rows a section needs to show its items up to `cap` and, when it has more, the marker. */
function targetRows(demand: SectionDemand, cap: number): number {
  const { loaded, total } = normalized(demand);
  if (total === 0) return 0;
  if (total <= cap && total <= loaded) return total;
  return Math.min(cap, loaded) + 1;
}

const SECTIONS: readonly SectionName[] = ['attention', 'sessions', 'runs', 'agents'];

/** The section rows and caps the allocation is building, and the step that tries one more row. */
interface Slots {
  readonly rows: Record<SectionName, number>;
  readonly caps: Record<SectionName, number>;
}

function usedRows(rows: Readonly<Record<SectionName, number>>): number {
  return workListChrome(rows) + SECTIONS.reduce((sum, name) => sum + rows[name], 0);
}

/** `name` set to `rows` rows when the list still fits: whether it did. */
function trySet(slots: Slots, budget: number, name: SectionName, rows: number): boolean {
  const before = slots.rows[name];
  slots.rows[name] = rows;
  if (usedRows(slots.rows) <= budget) return true;
  slots.rows[name] = before;
  return false;
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
      if (slots.rows[name] >= target || !trySet(slots, budget, name, slots.rows[name] + 1))
        open.delete(name);
    }
  }
}

/** The focused section first: its focused row and the markers around it, in what the list has when that is less (the `▲` gives way). */
function grantFocus(slots: Slots, input: WorkBudgetInput, budget: number): void {
  const focused = SECTIONS.find((name) => normalized(input[name]).focus !== undefined);
  if (focused === undefined) return;
  const wanted = minimumRows(input[focused]);
  if (trySet(slots, budget, focused, wanted)) return;
  const alone = { ...slots.rows, [focused]: 1 };
  slots.rows[focused] = Math.max(0, Math.min(wanted, budget - (usedRows(alone) - 1)));
}

/** Whether every section that has rows has them all at its base cap: only then do the caps open. */
function baseReached(slots: Slots, input: WorkBudgetInput): boolean {
  return (['attention', 'sessions', 'runs'] as const).every(
    (name) => slots.rows[name] >= targetRows(input[name], WORK_ITEM_CAPS[name]),
  );
}

/**
 * Each section's window in `input.rows` rows, by the priority of the module notes: the focused row, the first row of each section, the base
 * caps (Attention first, then the sessions and the runs in turn), the opened caps when rows are left over, and the agents last.
 */
export function allocateWorkList(input: WorkBudgetInput): WorkAllocation {
  const budget = Number.isFinite(input.rows) ? Math.max(0, Math.floor(input.rows)) : 0;
  const slots: Slots = {
    rows: { attention: 0, sessions: 0, runs: 0, agents: 0 },
    caps: { ...WORK_ITEM_CAPS },
  };
  grantFocus(slots, input, budget);
  for (const name of ['attention', 'sessions', 'runs'] as const)
    if (slots.rows[name] === 0) trySet(slots, budget, name, minimumRows(input[name]));
  growInTurn(slots, input, budget, ['attention']);
  growInTurn(slots, input, budget, ['sessions', 'runs']);
  if (baseReached(slots, input)) {
    slots.caps.attention = ATTENTION_ROWS_MAX;
    growInTurn(slots, input, budget, ['attention']);
    slots.caps.sessions = Number.POSITIVE_INFINITY;
    slots.caps.runs = Number.POSITIVE_INFINITY;
    growInTurn(slots, input, budget, ['sessions', 'runs']);
  }
  if (trySet(slots, budget, 'agents', minimumRows(input.agents)))
    growInTurn(slots, input, budget, ['agents']);
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
  return { ...windows, rows: usedRows(drawnRows) };
}
