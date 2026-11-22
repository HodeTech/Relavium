import type { RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { sanitizeInline } from '../render/sanitize.js';
import { formatDuration } from '../render/tui/format.js';
import { isFinishedRun, shortRunId, spanMs } from './run-detail-model.js';

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

/** The glyph of each run status; the word is the status itself. */
export const RUN_STATUS_GLYPH: Readonly<Record<RunStatus, string>> = {
  pending: '○',
  running: '◐',
  paused: '⏸',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A coarse relative age of an ISO timestamp: `now` (under a minute, and a small future skew), `5m ago`, `3h ago`,
 * `2d ago`. Each unit starts exactly at its boundary (60 s, 60 min, 24 h) and rounds down. An unparseable
 * timestamp yields `''`: the row renders nothing rather than `NaN`.
 */
export function ageText(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return '';
  const delta = nowMs - thenMs;
  if (delta < MINUTE_MS) return 'now';
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)}m ago`;
  if (delta < DAY_MS) return `${Math.floor(delta / HOUR_MS)}h ago`;
  return `${Math.floor(delta / DAY_MS)}d ago`;
}

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
      label: sanitizeInline(input.workflowLabels?.get(run.workflowId) ?? run.workflowId),
      ageText: ageText(run.createdAt, input.nowMs),
      ...(durationMs === undefined ? {} : { durationMs, durationText: formatDuration(durationMs) }),
      pinned: input.pinnedRunIds.has(run.id),
      ...(Number.isNaN(createdAtMs) ? {} : { createdAtMs }),
      createdAt: run.createdAt,
      totalCostMicrocents: run.totalCostMicrocents,
      ...(run.projectRoot === undefined ? {} : { projectRoot: sanitizeInline(run.projectRoot) }),
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
  if (last === undefined || last.createdAtMs === undefined) return undefined;
  if (!Number.isSafeInteger(last.createdAtMs)) return undefined;
  return { createdAt: last.createdAtMs, id: last.id };
}
