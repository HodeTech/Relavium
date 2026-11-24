import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { formatAgeOfIso, formatDuration, type DisplayPathRoots } from '../render/notation.js';
import { glyphOf, type StatusGlyphRole } from '../render/tui/glyphs.js';
import { placeForDisplay } from '../render/tui/place-label.js';
import {
  MAX_PROJECT_ROOT_CHARS,
  isFinishedRun,
  scrubbedBounded,
  shortRunId,
  spanMs,
} from './run-detail-model.js';

/**
 * A stored project root as a row of the History, Active or Defined tab may carry it: named as the rest of the CLI names a directory
 * ({@link placeForDisplay}: shortened FIRST against `paths`, so the project's own directory reads `. (project root)` and never a lone
 * `.`), then scrubbed WHOLE and cut to `max` code points ({@link scrubbedBounded}: the root is stored text that could carry a secret, so
 * the scrub is the sanitiser the helper runs and the bound is the one it applies). The three tabs call this one function, so a directory
 * reads the same on all of them.
 */
export function storedPlace(
  root: string,
  paths: DisplayPathRoots | undefined,
  max: number,
): string {
  // `scrubbedBounded` is the bound (it cuts the tail and marks the cut), so the front cut of the helper has nothing left to do.
  return placeForDisplay(root, paths, Number.POSITIVE_INFINITY, (text) =>
    scrubbedBounded(text, max),
  );
}

/**
 * The pure view model of the Home's History browser rows (ADR-0140 §2, "History"; MVP-8 step 1). One row per run
 * of a keyset page the caller read with `listRunSummaries`; the clock is an argument, nothing is read or written
 * here, and every free-form string passes the sanitize floor.
 *
 * Every state has a glyph AND a word — colour is never the only signal (ADR-0122 §7.2). A row does not carry a
 * formatted cost: the browser fetches a terminal run's cost lazily, with its usage coverage, and shows it through
 * the one formatter. {@link HistoryRow.totalCostMicrocents} is the raw column for that call and must never be
 * drawn on its own.
 */

/** The glyph-table role of each run status; the word is the status itself. A view draws the role in the form its colour setting asks for. */
export const RUN_STATUS_ROLE: Readonly<Record<RunStatus, StatusGlyphRole>> = {
  pending: 'pending',
  running: 'running',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** The Unicode glyph of each run status, from the table (the plain form is {@link RUN_STATUS_ROLE}'s, chosen by the view). */
export const RUN_STATUS_GLYPH: Readonly<Record<RunStatus, string>> = {
  pending: glyphOf(RUN_STATUS_ROLE.pending, false),
  running: glyphOf(RUN_STATUS_ROLE.running, false),
  paused: glyphOf(RUN_STATUS_ROLE.paused, false),
  completed: glyphOf(RUN_STATUS_ROLE.completed, false),
  failed: glyphOf(RUN_STATUS_ROLE.failed, false),
  cancelled: glyphOf(RUN_STATUS_ROLE.cancelled, false),
};

export interface HistoryRow {
  /** The run id — the identity a drill-down and a pin use. Draw {@link shortId}. */
  readonly id: string;
  /** The first 8 characters of the id, through the one-line floor. */
  readonly shortId: string;
  readonly status: RunStatus;
  readonly glyph: string;
  /** The status as a word, always shown beside the glyph. */
  readonly word: string;
  /** The workflow's slug when the caller resolved it, else its id; sanitized. */
  readonly label: string;
  readonly ageText: string;
  /** Present for a finished run with both timestamps. */
  readonly durationMs?: number;
  readonly durationText?: string;
  readonly pinned: boolean;
  /** `createdAt` as epoch ms — the keyset cursor's first component. Absent when the timestamp is unreadable. */
  readonly createdAtMs?: number;
  readonly createdAt: string;
  /** The raw run total. Never draw it: the browser qualifies it with the run's coverage first. */
  readonly totalCostMicrocents: number;
  /**
   * The directory the run started in, when it recorded one — what a widened list needs to say whose run it is.
   * Read back from `history.db`, so it has passed the one-line floor: it is for display, never for comparison.
   */
  readonly projectRoot?: string;
}

export interface HistoryRowsInput {
  readonly runs: readonly RunSummaryRecord[];
  readonly nowMs: number;
  readonly pinnedRunIds: ReadonlySet<string>;
  /** Workflow id → slug (`loadWorkflowSlugs`); a run whose workflow is absent from it shows the id. */
  readonly workflowLabels?: ReadonlyMap<string, string>;
  /** What a run's project root is shortened against (the Home's directory and the operator's home); absent, the root is shown as stored. */
  readonly paths?: DisplayPathRoots;
}

/** The rows of one page, in the order given (the page is already newest first). Nothing is dropped here. */
export function buildHistoryRows(input: HistoryRowsInput): HistoryRow[] {
  return input.runs.map((run): HistoryRow => {
    const durationMs = isFinishedRun(run.status)
      ? spanMs(run.startedAt, run.completedAt)
      : undefined;
    const createdAtMs = Date.parse(run.createdAt);
    return {
      id: run.id,
      shortId: shortRunId(run.id),
      status: run.status,
      glyph: RUN_STATUS_GLYPH[run.status],
      word: run.status,
      label: scrubbedBounded(input.workflowLabels?.get(run.workflowId) ?? run.workflowId),
      ageText: formatAgeOfIso(run.createdAt, input.nowMs),
      ...(durationMs === undefined ? {} : { durationMs, durationText: formatDuration(durationMs) }),
      pinned: input.pinnedRunIds.has(run.id),
      ...(Number.isNaN(createdAtMs) ? {} : { createdAtMs }),
      createdAt: run.createdAt,
      totalCostMicrocents: run.totalCostMicrocents,
      ...(run.projectRoot === undefined
        ? {}
        : {
            projectRoot: storedPlace(run.projectRoot, input.paths, MAX_PROJECT_ROOT_CHARS),
          }),
    };
  });
}

/** The statuses the History browser's filter cycles through; `undefined` is "every finished run". */
export const HISTORY_STATUS_CYCLE: readonly (RunStatus | undefined)[] = [
  undefined,
  'completed',
  'failed',
  'cancelled',
];

/** The next filter in {@link HISTORY_STATUS_CYCLE} after `current`, wrapping to "every finished run". */
export function nextStatusFilter(current: RunStatus | undefined): RunStatus | undefined {
  const index = HISTORY_STATUS_CYCLE.indexOf(current);
  return HISTORY_STATUS_CYCLE[(index + 1) % HISTORY_STATUS_CYCLE.length];
}

/**
 * The rows with the given status, or — with no status — every FINISHED row. History lists finished runs only: a
 * `pending`, `running` or `paused` run belongs to the Active tab, and the store can filter by one status at a
 * time, so a page read without a filter may hold them. Build the cursor from the rows BEFORE filtering
 * ({@link nextCursor}), or a filtered-out tail would end paging early.
 */
export function filterByStatus(rows: readonly HistoryRow[], status?: RunStatus): HistoryRow[] {
  return rows.filter((row) =>
    status === undefined ? isFinishedRun(row.status) : row.status === status,
  );
}

/**
 * The cursor of the next page — the last row's `(createdAt, id)` — or `undefined` when the page is short
 * (fewer rows than `pageLimit`, so the list has ended) or the last row's timestamp cannot be a cursor. Pass the
 * rows of the raw page, before {@link filterByStatus}.
 */
export function nextCursor(
  rows: readonly HistoryRow[],
  pageLimit: number,
): { readonly createdAt: number; readonly id: string } | undefined {
  if (pageLimit <= 0 || rows.length < pageLimit) return undefined;
  const last = rows.at(-1);
  if (last?.createdAtMs === undefined) return undefined;
  if (!Number.isSafeInteger(last.createdAtMs)) return undefined;
  return { createdAt: last.createdAtMs, id: last.id };
}
