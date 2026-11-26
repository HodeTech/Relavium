/**
 * The Home's Attention rows ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, §4, §7; MVP-11
 * unit 7): one line per run of THIS project that is paused, with the kind of gate it waits on; the ONE urgency order of "Attention required"
 * ({@link attentionOrder}: the parked runs, the failed runs and the runs whose log cannot be read); and what page 1 says of the most urgent
 * of them ({@link urgentWords}). Pure: the read is over the injected reader and the rest over rows, so what the work page draws, what the keys
 * walk and what page 1 names come from one place.
 *
 * - **This project's runs only.** The rows come from `readProjectRunGates`, which asks the reader for the project's paused runs and checks
 *   each row against the project root again, so a run of another directory never gets a row: a run is actionable only in its own workspace.
 * - **One row per run, not per gate.** A run with several open gates is one row (`3 open gates`); its card lists them.
 * - **A run whose log cannot be read gets no parked row.** Its gates are unknown, so there is no kind to name and no gate card to open; it is
 *   the snapshot's unreadable item instead, whose `Enter` says why.
 * - **Bounded.** At most {@link PARKED_RUNS_MAX} runs are read, newest first, as the other strip lists are.
 * - **What the row says is what the person needs to pick a run** ({@link parkedRunLabel}): its workflow, the kind of gate, its time (the
 *   earliest deadline of its open gates, or with none how long the run has waited), and the first eight characters of its id. The key that
 *   opens it is named on the work page's hint row, for the focused row only, never at the row's end.
 * - **Page 1 names the first item** ({@link urgentHeadOf}), and says so only when it is the most urgent of ALL: the Home reads the newest
 *   {@link PARKED_RUNS_MAX} paused runs, so with more waiting the head leads with the count of everything instead ({@link attentionIsPartial}).
 */

import type { RunHistoryReader } from '@relavium/db';

import {
  DEFAULT_HOME_LIMIT,
  type HomeRunRow,
  type HomeSnapshot,
  type HomeUnreadableRun,
} from '../../home/home-store.js';
import type { HostedRunDisposition } from '../../home/hosted-run-terminal.js';
import {
  isMediaOnlyPark,
  readProjectRunGates,
  type ProjectRunGates,
  type RunGatesReader,
} from '../../home/run-gates.js';
import { formatAgeOfIso, shortId } from '../notation.js';
import { flowLine } from './flow-text.js';
import { glyph } from './glyphs.js';
import {
  attentionLead,
  classOfRanges,
  compactExpiryLabel,
  expiryLabel,
  fitRow,
  MARKER_LOOKALIKE_RANGES,
  waitingLabel,
  workRowText,
  type CodeRange,
} from './home-projection.js';
import { clipLine } from './sheet-frame.js';

/**
 * The most parked runs the Home keeps rows for: the Home's one list limit ({@link DEFAULT_HOME_LIMIT}, owned by the store), so the parked
 * rows and the paused runs the store probes for an unreadable log are the same newest runs.
 */
export const PARKED_RUNS_MAX = DEFAULT_HOME_LIMIT;

/**
 * What a parked run waits on: one gate's type, a budget gate, several gates, media jobs and nothing else (`Enter` asks whether to continue
 * it here), or nothing a card can show or a continue can answer (`none`: the log names no gate and no job in flight).
 */
export type ParkedRunKind =
  | 'approval'
  | 'input'
  | 'review'
  | 'budget'
  | 'several'
  | 'media'
  | 'none';

export interface ParkedRunRow {
  readonly runId: string;
  readonly kind: ParkedRunKind;
  /** How many gates (human and budget) the run has open. */
  readonly gates: number;
  /** The run's workflow, by its slug: what a person knows a run by. Absent when the read could not name it. */
  readonly workflow?: string | undefined;
  /** The earliest deadline among the run's open gates (an ISO timestamp), when any gate has one. */
  readonly expiresAt?: string | undefined;
  /**
   * When the run parked, as its record says (an ISO timestamp; `RunGates.parkedSince`): what a row with no deadline says instead of one
   * (`waiting 2h`). DISPLAY ONLY: it never changes the Attention order ({@link attentionOrder}).
   */
  readonly parkedSince?: string | undefined;
}

function kindOf(run: ProjectRunGates['runs'][number]): ParkedRunKind {
  const open = run.gates.length + run.budgetGates.length;
  if (open === 0) return isMediaOnlyPark(run) ? 'media' : 'none';
  if (open > 1) return 'several';
  return run.gates[0]?.gateType ?? 'budget';
}

/** The earliest deadline among a run's open gates, as it was recorded; a deadline that does not parse is no deadline. */
function earliestDeadline(run: ProjectRunGates['runs'][number]): string | undefined {
  let earliest: { readonly at: number; readonly iso: string } | undefined;
  for (const gate of [...run.gates, ...run.budgetGates]) {
    if (gate.expiresAt === undefined) continue;
    const at = Date.parse(gate.expiresAt);
    if (Number.isFinite(at) && (earliest === undefined || at < earliest.at))
      earliest = { at, iso: gate.expiresAt };
  }
  return earliest?.iso;
}

/**
 * One row per readable parked run of `project`, in the order the read returned them (newest run first), at most {@link PARKED_RUNS_MAX}.
 * `slugs` names the workflows by their ids (a run record carries only the id); a run with no slug there has no workflow word.
 */
export function parkedRunRows(
  project: ProjectRunGates,
  slugs: ReadonlyMap<string, string> = new Map(),
): readonly ParkedRunRow[] {
  return project.runs
    .filter((run) => !run.degraded)
    .slice(0, PARKED_RUNS_MAX)
    .map((run): ParkedRunRow => {
      const workflow = slugs.get(run.workflowId);
      const expiresAt = earliestDeadline(run);
      return {
        runId: run.runId,
        kind: kindOf(run),
        gates: run.gates.length + run.budgetGates.length,
        ...(workflow === undefined ? {} : { workflow }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(run.parkedSince === undefined ? {} : { parkedSince: run.parkedSince }),
      };
    });
}

/** The reads the Attention rows make: the gate read's own, and (when the reader has it) the slugs of the workflows the runs belong to. */
export type ParkedRunsReader = RunGatesReader &
  Partial<Pick<RunHistoryReader, 'loadWorkflowSlugs'>>;

/** The rows for the runs parked in `projectRoot`: the read and the projection together. */
export function readParkedRuns(
  reader: ParkedRunsReader,
  projectRoot: string,
): readonly ParkedRunRow[] {
  const project = readProjectRunGates(reader, projectRoot, { maxRuns: PARKED_RUNS_MAX });
  const ids = [...new Set(project.runs.map((run) => run.workflowId))];
  return parkedRunRows(project, reader.loadWorkflowSlugs?.(ids));
}

// ---- The Attention order (MVP-11 unit 7: Attention by urgency) -------------------------------------------------------------------

/** What an item of "Attention required" shares, whatever kind it is: the run, its workflow when it can be named, and its deadline. */
interface AttentionCommon {
  readonly runId: string;
  /** The workflow's slug as stored (NOT scrubbed: every drawn use passes `flowLine` first), when the read could name it. */
  readonly workflow: string | undefined;
  /** A parked run's earliest deadline, when one of its gates has one that parses. */
  readonly deadlineMs: number | undefined;
  /** The deadline has passed at the clock {@link attentionOrder} was given (never without one). */
  readonly overdue: boolean;
}

/** One item of "Attention required": a parked run (the controller's row), a failed run of the window, or a run whose log cannot be read. */
export type AttentionItem =
  | (AttentionCommon & { readonly kind: 'parked'; readonly row: ParkedRunRow })
  | (AttentionCommon & { readonly kind: 'failed'; readonly run: HomeRunRow })
  | (AttentionCommon & { readonly kind: 'unreadable'; readonly run: HomeUnreadableRun });

/** A time a sort can read: the instant an ISO text names, or `-Infinity` when it names none (it then sorts as the oldest). */
function instantOf(iso: string | undefined): number {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function byRunId(a: { readonly runId: string }, b: { readonly runId: string }): number {
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

/** Newest first by `at`, a tie on the run id: a total order, the same on every refresh. */
function newestFirst<T extends { readonly runId: string; readonly at: number }>(
  a: T,
  b: T,
): number {
  if (a.at === b.at) return byRunId(a, b);
  return a.at > b.at ? -1 : 1;
}

/**
 * The items of "Attention required" in the order of their urgency (the maintainer's ruling of 2026-11-26), ONE order for the work page's rows,
 * the keys that walk them (`strip-focus.ts`) and page 1's "most urgent" item:
 *
 * 1. the parked runs whose deadline has passed, the longest overdue first, then those whose deadline is still ahead, the soonest first (one
 *    ascending sort of the deadline is both: a passed deadline is an earlier one);
 * 2. the parked runs with no deadline, in the read's order, which is newest first (`readParkedRuns`; the time a row now carries,
 *    `parkedSince`, is for its words only and takes no part in the order: the maintainer's ruling names this order, and a tie-break by it
 *    would reorder runs the read already ranks);
 * 3. the failed runs of the window, newest first;
 * 4. the runs whose log cannot be read, newest first (one with no creation time last).
 *
 * A tie breaks on the run id, so the order is total and a refresh that hands the rows back in another order gives the same list. A run is ONE
 * item: a run whose log cannot be read is an unreadable item and never also a parked or failed one, and a parked run is never also a failed one.
 * `nowMs` only marks the overdue items (the order does not depend on the clock); without it no item is overdue.
 */
export function attentionOrder(
  parked: readonly ParkedRunRow[],
  snapshot: Pick<HomeSnapshot, 'attention' | 'unreadableRuns'>,
  nowMs?: number,
): readonly AttentionItem[] {
  const broken = new Set(snapshot.unreadableRuns.map((run) => run.runId));
  const seen = new Set<string>();
  const first = (runId: string): boolean => {
    if (seen.has(runId)) return false;
    seen.add(runId);
    return true;
  };
  const due: (AttentionItem & { readonly deadlineMs: number })[] = [];
  const open: AttentionItem[] = [];
  for (const row of parked) {
    if (broken.has(row.runId) || !first(row.runId)) continue;
    const at = instantOf(row.expiresAt);
    const deadlineMs = Number.isFinite(at) ? at : undefined;
    const common = { runId: row.runId, workflow: row.workflow, overdue: false };
    if (deadlineMs === undefined) open.push({ ...common, kind: 'parked', row, deadlineMs });
    else
      due.push({
        ...common,
        kind: 'parked',
        row,
        deadlineMs,
        overdue: nowMs !== undefined && deadlineMs <= nowMs,
      });
  }
  due.sort((a, b) => a.deadlineMs - b.deadlineMs || byRunId(a, b));
  const failed = snapshot.attention.failedRuns
    .filter((run) => !broken.has(run.runId) && first(run.runId))
    .map((run) => ({ runId: run.runId, at: instantOf(run.createdAt), run }))
    .sort(newestFirst)
    .map(
      ({ run }): AttentionItem => ({
        kind: 'failed',
        runId: run.runId,
        workflow: run.workflowSlug,
        deadlineMs: undefined,
        overdue: false,
        run,
      }),
    );
  const unreadable = snapshot.unreadableRuns
    .filter((run) => first(run.runId))
    .map((run) => ({ runId: run.runId, at: instantOf(run.createdAt), run }))
    .sort(newestFirst)
    .map(
      ({ run }): AttentionItem => ({
        kind: 'unreadable',
        runId: run.runId,
        workflow: run.workflowSlug,
        deadlineMs: undefined,
        overdue: false,
        run,
      }),
    );
  return [...due, ...open, ...failed, ...unreadable];
}

/**
 * The words a parked row names its kind with (MVP-11 unit 7): the gate's type alone (`approval`, `input`, `review`, `budget`), how many gates
 * a run with several has open, `waiting for media`, or `parked, no gate` (nothing a card can show or a continue can answer). What `Enter`
 * does on it is the work page's hint row's to say, for the focused row only (`home-pages.ts`), not the row's.
 */
export function parkedKindWords(row: Pick<ParkedRunRow, 'kind' | 'gates'>): string {
  switch (row.kind) {
    case 'approval':
    case 'input':
    case 'review':
    case 'budget':
      return row.kind;
    case 'several':
      return `${String(row.gates)} open gates`;
    case 'media':
      return 'waiting for media';
    case 'none':
      return 'parked, no gate';
  }
}

/** Whether the run's earliest deadline has passed at `nowMs`: the row says `expired`, and the view draws it in red, as the strip's own gate rows are. */
export function parkedRunOverdue(row: ParkedRunRow, nowMs: number): boolean {
  return expiryLabel(row.expiresAt, nowMs) === 'expired';
}

/**
 * The TIME a parked row carries (the row's `age` slot): its deadline when a gate has one (`expires in 5m`, `expired`: the more urgent fact, so
 * it wins the slot), else how long the run has waited (`waiting 2h`, {@link waitingLabel}); nothing without a clock or without either.
 */
function parkedRunTime(row: ParkedRunRow, nowMs: number | undefined): string {
  if (nowMs === undefined) return '';
  return expiryLabel(row.expiresAt, nowMs) ?? waitingLabel(row.parkedSince, nowMs) ?? '';
}

/**
 * The work page's row of a parked run: `‖ workflow · kind · time · id` (`‖ release-notes · approval · expires in 5m · 3f9a1c2e`, or with no
 * deadline `‖ review-docs · review · waiting 2h · b1cf9111`), the workflow only when the read could name it, the time only with a clock
 * ({@link parkedRunTime}), and the run's first eight characters last. No key is named on the row: the hint row names the focused row's
 * `Enter`. `maxColumns` is the room the row has; what a narrow row gives up, in order, is the workflow's tail, the time (deadline or
 * waiting), the id, then the workflow; the kind never ({@link fitRow}). The lead glyph is padded to the one column the other Attention rows
 * share ({@link attentionLead}).
 */
export function parkedRunLabel(
  row: ParkedRunRow,
  maxColumns = Number.POSITIVE_INFINITY,
  nowMs?: number,
): string {
  return fitRow(
    attentionLead('paused'),
    [
      { text: row.workflow === undefined ? '' : workRowText(row.workflow), role: 'name' },
      { text: parkedKindWords(row), role: 'keep' },
      { text: parkedRunTime(row, nowMs), role: 'age' },
      { text: shortId(workRowText(row.runId)), role: 'detail' },
    ],
    maxColumns,
  );
}

// ---- Page 1's most urgent item (MVP-11 unit 7, the maintainer's ruling 5) ---------------------------------------------------------

/**
 * Every character that draws as an arrow, an arrowhead, a triangle or the return key, so that the hint's own `↓` is the only one on its row
 * (round 2: F4). The ranges, each named; the table is data, and the test walks every code point of every range:
 *
 * - U+2190 to U+21FF the arrows block (`← ↑ → ↓ ↵ ⇩ …`);
 * - U+27F0 to U+27FF the supplemental arrows A (`⟰ ⟱ ⟶ …`), U+2900 to U+297F the supplemental arrows B (`⤓ ⤒ …`);
 * - U+2B00 to U+2BFF the miscellaneous symbols and arrows (`⬇ ⬆ ⭣ ⮟ ⯆ …`: the triangle-headed arrows and the arrowheads among them);
 * - U+1F800 to U+1F8FF the supplemental arrows C (`🡓 🠗 🢓 …`);
 * - U+2304 the down arrowhead (`⌄`; its twin `⌃` is the Mac control sign, which the scrub already turns into a chord);
 * - U+2324, U+2386 and U+23CE the keys that draw the return key (`⌤ ⎆ ⏎`);
 * - every triangle that passes for the work page's marker ({@link MARKER_LOOKALIKE_RANGES}: `▲ ▼ ⏶ ⏷ ⯅ ⯆ 🔺 🔻 …`).
 */
export const ARROW_LOOKALIKE_RANGES: readonly CodeRange[] = [
  [0x2190, 0x21ff],
  [0x27f0, 0x27ff],
  [0x2900, 0x297f],
  [0x2b00, 0x2bff],
  [0x1f800, 0x1f8ff],
  [0x2304, 0x2304],
  [0x2324, 0x2324],
  [0x2386, 0x2386],
  [0x23ce, 0x23ce],
  ...MARKER_LOOKALIKE_RANGES,
];

/** {@link ARROW_LOOKALIKE_RANGES} as a pattern, built from the code points, never an escape in the source. */
const ARROWS = new RegExp(`[${classOfRanges(ARROW_LOOKALIKE_RANGES)}]`, 'gu');

/**
 * The bracket pairs a name could write a key in, beside the ASCII `[ ]` (round 2: F4). In each range the characters alternate, the first one
 * opening and the next closing it (`【 】`, `〔 〕`, `⟦ ⟧`), so a code point's side is its offset's parity. The ranges, each named:
 *
 * - U+2045 and U+2046 the square brackets with a quill (`⁅ ⁆`), U+2308 to U+230B the ceiling and floor brackets (`⌈ ⌉ ⌊ ⌋`);
 * - U+2768 to U+2775 the ornamental brackets (`❨ ❩ … ❲ ❳ ❴ ❵`);
 * - U+27E6 to U+27EF the mathematical brackets (`⟦ ⟧ ⟨ ⟩ ⟪ ⟫ ⟬ ⟭ ⟮ ⟯`);
 * - U+2983 to U+2998 the miscellaneous mathematical symbols B brackets (`⦃ ⦄ … ⦗ ⦘`), U+29D8 to U+29DB (`⧘ ⧙ ⧚ ⧛`), U+29FC and U+29FD (`⧼ ⧽`);
 * - U+2E22 to U+2E29 the half brackets (`⸢ ⸣ ⸤ ⸥ ⸦ ⸧ ⸨ ⸩`);
 * - U+3008 to U+3011 the CJK angle, double angle, corner, white corner and black lenticular brackets (`〈 〉 《 》 「 」 『 』 【 】`);
 * - U+3014 to U+301B the CJK tortoise-shell, white lenticular, white tortoise-shell and white square brackets (`〔 〕 〖 〗 〘 〙 〚 〛`).
 *
 * The fullwidth square brackets (U+FF3B and U+FF3D, `［ ］`) are not in a range of their own: the scrub's compatibility fold makes them the ASCII
 * pair before this runs (`home-lookalike-text.test.ts` pins that, so a scrub that stopped folding them fails there).
 */
export const BRACKET_PAIR_RANGES: readonly CodeRange[] = [
  [0x2045, 0x2046],
  [0x2308, 0x230b],
  [0x2768, 0x2775],
  [0x27e6, 0x27ef],
  [0x2983, 0x2998],
  [0x29d8, 0x29db],
  [0x29fc, 0x29fd],
  [0x2e22, 0x2e29],
  [0x3008, 0x3011],
  [0x3014, 0x301b],
];

/** The characters of {@link BRACKET_PAIR_RANGES} and the ASCII pair that OPEN a pair, as characters. */
const OPENING_BRACKETS: ReadonlySet<string> = new Set([
  '[',
  ...BRACKET_PAIR_RANGES.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, offset) => offset)
      .filter((offset) => offset % 2 === 0)
      .map((offset) => String.fromCodePoint(from + offset)),
  ),
]);

/** Every bracket a name could write a key in: the ASCII pair and {@link BRACKET_PAIR_RANGES}. */
const BRACKETS = new RegExp(`[\\[\\]${classOfRanges(BRACKET_PAIR_RANGES)}]`, 'gu');

/** The most columns the most urgent item's name takes on page 1's hint before the hint's own fit cuts it further. */
export const URGENT_NAME_COLUMNS = 24;

/**
 * What page 1's hint says of the most urgent item: its name (`release-notes`, or `run 3f9a1c2e` when the workflow cannot be named; none for
 * a run whose log cannot be read, whose words say it), the words of its kind (`needs approval`, `failed 2h ago`, `a run cannot be read`, …),
 * its deadline words (`expires in 5m`, `expired`) when it has one and the same deadline in its compact form (`5m left`, `expired`) for the room
 * a cramped hint has, whether it is overdue (the view draws it red), and whether it is only the most urgent of the items that were READ
 * ({@link attentionIsPartial}).
 */
export interface UrgentWords {
  readonly name: string | undefined;
  readonly words: string;
  readonly deadline: string | undefined;
  readonly deadlineCompact: string | undefined;
  readonly overdue: boolean;
  /** More attention items exist than were read, and the ones not read may be more urgent: the hint must not call this one the most urgent. */
  readonly partial: boolean;
}

/** The words of a parked run's kind as page 1 says them: `needs approval`, `hit a budget limit`, `has 3 open gates`, `is parked`, … */
function parkedHeadWords(row: ParkedRunRow): string {
  switch (row.kind) {
    case 'approval':
    case 'input':
    case 'review':
      return `needs ${row.kind}`;
    case 'budget':
      return 'hit a budget limit';
    case 'several':
      return `has ${String(row.gates)} open gates`;
    case 'media':
      return 'is waiting for media';
    case 'none':
      return 'is parked';
  }
}

/**
 * A name already through the Home's full row scrub (`flowLine`) as page 1's hint folds it, on a sink of its own: every bracket a parenthesis
 * (the scrub makes a chord token inert, but a bracketed universal key such as `[Enter]` is not the grammar's and it leaves it, so a name could
 * still dress up as a key beside the real ones: the CJK and mathematical brackets too, {@link BRACKET_PAIR_RANGES}, and the fullwidth ones,
 * which the scrub has already folded to the ASCII pair), then every arrow, arrowhead, triangle and return key a space (the hint's own `↓` is the
 * only one on the row, {@link ARROW_LOOKALIKE_RANGES}), then every run of whitespace ONE space. Exported so that every other place that draws
 * a stored name beside real keys (the card of an unreadable run) folds it the same way.
 */
export function foldKeyLookalikes(scrubbed: string): string {
  return scrubbed
    .replace(BRACKETS, (bracket) => (OPENING_BRACKETS.has(bracket) ? '(' : ')'))
    .replace(ARROWS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * A stored name as page 1's hint draws it: the Home's full row scrub (`flowLine`) FIRST, then {@link foldKeyLookalikes}, then bounded to
 * {@link URGENT_NAME_COLUMNS} columns, by display width. The legend's separator a name brings is already inert (` - `).
 */
export function urgentName(stored: string): string {
  return clipLine(foldKeyLookalikes(flowLine(stored)), URGENT_NAME_COLUMNS);
}

/** The name of a run on page 1: its workflow, else `run` and the first eight characters of its id; empty after the scrub counts as absent. */
function urgentRunName(workflow: string | undefined, runId: string): string {
  const named = workflow === undefined ? '' : urgentName(workflow);
  return named === '' ? urgentName(`run ${shortId(runId)}`) : named;
}

/** What page 1 says of `item` at `nowMs` ({@link UrgentWords}): its name, the words of its kind, and its deadline. */
export function urgentWords(item: AttentionItem, nowMs: number): UrgentWords {
  switch (item.kind) {
    case 'parked':
      return {
        name: urgentRunName(item.workflow, item.runId),
        words: parkedHeadWords(item.row),
        deadline: expiryLabel(item.row.expiresAt, nowMs),
        deadlineCompact: compactExpiryLabel(item.row.expiresAt, nowMs),
        overdue: parkedRunOverdue(item.row, nowMs),
        partial: false,
      };
    case 'failed': {
      const age = formatAgeOfIso(
        item.run.completedAt ?? item.run.startedAt ?? item.run.createdAt,
        nowMs,
      );
      return {
        name: urgentRunName(item.workflow, item.runId),
        words: age === '' ? 'failed' : `failed ${age}`,
        deadline: undefined,
        deadlineCompact: undefined,
        overdue: false,
        partial: false,
      };
    }
    case 'unreadable':
      return {
        name: undefined,
        words: 'a run cannot be read',
        deadline: undefined,
        deadlineCompact: undefined,
        overdue: false,
        partial: false,
      };
  }
}

/**
 * Whether the Attention items that were read may leave out one that is MORE urgent than the first of them (round 2, correctness F1). The
 * Home reads the newest {@link PARKED_RUNS_MAX} paused runs and no more (a gate's deadline is in its run's log, and a log is one read each),
 * and the oldest paused runs are the likeliest to have expired. So the first item is the most urgent of the ones read, and the most urgent of
 * all only when every paused run was read. That is known without a read: the parked rows and the unreadable paused runs together are the newest
 * paused runs, and fewer than {@link PARKED_RUNS_MAX} of them means the list reached its end; and `total` (the snapshot's true count) not
 * exceeding the items read means nothing is unread at all. A failed run beyond the failed rows read, or an unreadable one, never outranks what
 * was read (both are newest first and rank after every parked run), so they raise no doubt of their own; a Home with exactly
 * {@link PARKED_RUNS_MAX} paused runs and more failed ones than it lists says "partial" without a gate it missed, the one false alarm, rare and harmless.
 */
export function attentionIsPartial(items: readonly AttentionItem[], total: number): boolean {
  const paused = items.filter(
    (item) =>
      item.kind === 'parked' ||
      (item.kind === 'unreadable' &&
        (item.run.status === undefined || item.run.status === 'paused')),
  ).length;
  return paused >= PARKED_RUNS_MAX && total > items.length;
}

/**
 * What page 1 says of the first of `items` ({@link urgentWords}), marked {@link UrgentWords.partial} when unread items may outrank it
 * ({@link attentionIsPartial}; `total` is the snapshot's true Attention count); `undefined` with no item.
 */
export function urgentHeadOf(
  items: readonly AttentionItem[],
  total: number,
  nowMs: number,
): UrgentWords | undefined {
  const first = items[0];
  if (first === undefined) return undefined;
  return { ...urgentWords(first, nowMs), partial: attentionIsPartial(items, total) };
}

/**
 * Whether a relative word is on screen, so that the clock alone changes what the Home would draw (round 2, observation F8: `expires in 13s`
 * stood byte for byte for 45 seconds, and a head reading `expires in 5m` stayed so for hours on an idle landing): a work page that lists a
 * parked run (its deadline, or how long it has waited), a failed run, a session, a run or an agent (their ages); a landing whose head names a
 * failed run (`failed 2h ago`) or a parked run with a deadline (`expires in 5m`). The page-1 head with nothing time-bound in it and the calm
 * landing say nothing relative and are never repainted for the clock. A superset by design: a row the page leaves out for want of room still
 * counts, which costs one repaint a minute and never a missed one.
 */
export function showsRelativeWords(input: {
  readonly page: 'start' | 'work';
  readonly snapshot: Pick<
    HomeSnapshot,
    'attention' | 'recentSessions' | 'recentRuns' | 'recentAgents' | 'unreadableRuns'
  >;
  readonly parked: readonly ParkedRunRow[];
}): boolean {
  const { snapshot, parked } = input;
  if (input.page === 'work')
    return (
      parked.length +
        snapshot.attention.failedRuns.length +
        snapshot.recentSessions.length +
        snapshot.recentRuns.length +
        snapshot.recentAgents.length >
      0
    );
  const first = attentionOrder(parked, snapshot)[0];
  return first?.kind === 'failed' || first?.deadlineMs !== undefined;
}

/**
 * The line a chat's transcript gets when a hosted leg ends while that chat is in front ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md)
 * §3: a run that parks, finishes or fails behind a chat would otherwise tell nobody; no card ever takes the keyboard from another screen),
 * or `undefined` for an end that needs no word here (a cancel the person asked for, a run another process settled, a record the exit line
 * reports). Each is a glyph and a word from a closed vocabulary and the run's name: its workflow's slug when `parked` is the run's own
 * Attention row and has one, else `run` and the first eight characters of its id, scrubbed like every other label. The remedy is the same
 * for all of them: the landing is where the run is shown, and a chat holds the keyboard until it is left.
 */
export function hostedEndNotice(
  end: { readonly runId: string; readonly disposition: HostedRunDisposition },
  parked: ParkedRunRow | undefined,
): string | undefined {
  const slug = parked?.workflow === undefined ? '' : flowLine(parked.workflow).trim();
  const name = slug === '' ? `run ${shortId(flowLine(end.runId))}` : slug;
  switch (end.disposition) {
    case 'paused':
      return `${glyph('paused')} ${name} ${pausedWords(parked?.kind)} on the Home.`;
    case 'completed':
      return `${glyph('completed')} ${name} completed. Leave this chat to see it on the Home.`;
    case 'failed':
      return `${glyph('failed')} ${name} failed. Leave this chat to see it on the Home.`;
    default:
      return undefined;
  }
}

/** What a parked run waits on and what to do about it, in the words of {@link hostedEndNotice}; the row may not be read yet (`undefined`). */
function pausedWords(kind: ParkedRunKind | undefined): string {
  switch (kind) {
    case 'media':
      return 'is waiting for media jobs. Leave this chat to continue it';
    case 'none':
      return 'paused. Leave this chat to see it';
    default:
      return 'is waiting at a gate. Leave this chat to answer it';
  }
}
