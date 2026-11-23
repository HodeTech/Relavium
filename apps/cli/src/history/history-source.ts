import type { RunHistoryReader, RunSummaryRecord } from '@relavium/db';
import { MAX_RUN_SUMMARY_IDS } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { formatCostShort } from '../render/tui/format.js';
import { buildHistoryRows, type HistoryRow } from './history-model.js';
import { readPerRunOrDegrade } from './per-run-read.js';
import { isFinishedRun, scrubbedBounded } from './run-detail-model.js';
import { readRunUsageCoverage } from './usage-coverage.js';

/**
 * The read behind the Home's History tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): finished runs, newest first, a page at a time. It reads and builds; it writes nothing. Every list read is a summary
 * read (no frozen snapshot, no JSON document) and bounded:
 *
 * - **A view of twenty rows, a fetch of at most 200.** A fetch is ONE `listRunSummaries` call: 21 rows when a status is chosen (the store
 *   filters by one status, so twenty are shown and the twenty-first only says there is more), 200 rows when none is (the store cannot say
 *   "every finished status", so the page is filtered here, and an active run in the raw page is dropped, not counted).
 * - **The cursor is the store's keyset cursor** `(created_at, id)`: the key of the last row the page showed, or of the last raw row when
 *   the whole raw page was consumed. Two runs on one millisecond straddle a page boundary exactly once.
 * - **At most three pages in memory, and a stack of cursors.** The cursor of every page walked is kept (a cursor is two scalars), so a
 *   page that was evicted is read again with the same cursor and returns the same rows. The pages kept are those nearest the one in view.
 * - **A scope and a status filter.** `project` is the Home's own directory, `all` every project (the one store filter, `projectRoot`).
 *   Changing either starts a new walk: the cursors and the pages are dropped.
 * - **A pinned section.** The run pins (`listPins({ kind: 'run' })`) are read by id in one bounded call and listed above the page. A
 *   pinned run is shown inside the current scope (a run of another project is not shown while the scope is this project); a pin whose run
 *   is gone is shown as a `missing` entry, so it can be removed. Pins are read every time: a cached page never holds a stale pin.
 * - **The cost is lazy and kept.** A row carries no cost. {@link HistorySource.cost} folds the run's log for it (the coverage read, the
 *   expensive part) the first time it is asked for a terminal run and keeps the answer per run id, so a page read again, an evicted page
 *   and a row that scrolls back into view never fold a run twice. A run that is not finished is never folded or kept: it can still change.
 * - **A damaged run is shown, not hidden.** A run whose log cannot be read has its cost marked `unreadable` and keeps its row.
 */

/** Rows the tab shows from one page. */
export const HISTORY_VIEW_ROWS = 20;
/** The most raw rows one fetch reads (the store's own page limit). */
export const HISTORY_FETCH_ROWS = 200;
/** The most pages kept in memory. */
export const HISTORY_PAGES_MAX = 3;
/** The most run costs kept; the oldest is dropped past it. */
export const HISTORY_COST_CACHE_MAX = 500;

export type HistoryScope = 'project' | 'all';

/** What the tab asks for. `fresh` drops what was kept first (the tab was entered). */
export interface HistoryQuery {
  readonly scope: HistoryScope;
  /** One status, or `undefined` for every finished run. */
  readonly status: RunStatus | undefined;
  /** The page, from `0`; a page past the walk is read as the last one reached. */
  readonly page: number;
  readonly fresh?: boolean;
}

/** One line of the pinned section or of the page. */
export type HistoryEntry =
  | {
      readonly kind: 'run';
      readonly row: HistoryRow;
      /** The pin's row id, present exactly when the run is pinned: the handle that removes a pin by its row. */
      readonly pinRowid?: number;
    }
  | {
      readonly kind: 'missing';
      /** The pinned reference as a label (sanitized and bounded; never a key). */
      readonly label: string;
      readonly pinRowid: number;
    };

/** One read of the browser: the page in view and the pinned section above it. */
export interface HistoryRead {
  /** The query as it was answered: the page clamped to the walk. */
  readonly query: {
    readonly scope: HistoryScope;
    readonly status: RunStatus | undefined;
    readonly page: number;
  };
  readonly pinned: readonly HistoryEntry[];
  readonly rows: readonly HistoryEntry[];
  readonly hasPrev: boolean;
  readonly hasNext: boolean;
}

/** What a run's cost says. */
export type HistoryCost =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'not-final' };

export interface HistorySource {
  readonly read: (query: HistoryQuery) => HistoryRead;
  readonly cost: (row: HistoryRow) => HistoryCost;
}

/** The reads the source needs. */
export type HistorySourceReader = Pick<
  RunHistoryReader,
  'listRunSummaries' | 'loadRunSummariesByIds' | 'loadWorkflowSlugs' | 'visitRunEventsForReplay'
>;

/** What the source reads of a run pin. A `PinRecord` satisfies it. */
export interface HistoryRunPin {
  readonly ref: string;
  readonly rowid: number;
  /** The reference is a preview, not the run id: it is listed as missing and removed by its row. */
  readonly oversized: boolean;
}

export interface HistorySourceDeps {
  readonly reader: HistorySourceReader;
  /** The run pins, newest first (`listPins({ kind: 'run' })`). May throw. */
  readonly listRunPins: () => readonly HistoryRunPin[];
  /** The directory the Home is in: the `project` scope, and what a pinned run is compared with. */
  readonly projectRoot: string;
  /** Epoch milliseconds: the ages are taken against it. */
  readonly now: () => number;
  /** The coverage read of one run. Defaults to `readRunUsageCoverage` over the reader; a test counts its calls. */
  readonly readCoverage?: ((runId: string) => ReturnType<typeof readRunUsageCoverage>) | undefined;
}

interface Cursor {
  readonly createdAt: number;
  readonly id: string;
}

/** What one fetch kept: the raw records of the page and where the next one starts. */
interface PageSlot {
  readonly records: readonly RunSummaryRecord[];
  readonly labels: ReadonlyMap<string, string>;
  /** The cursor of the next page; `undefined` when the list ended here. */
  readonly next: Cursor | undefined;
}

const sameCursor = (a: Cursor | undefined, b: Cursor | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.createdAt === b.createdAt && a.id === b.id);

/** The keyset cursor of a record, or `undefined` when its time cannot be one (an unusable cursor ends the list rather than guess). */
function cursorOf(record: RunSummaryRecord | undefined): Cursor | undefined {
  if (record === undefined) return undefined;
  const createdAt = Date.parse(record.createdAt);
  return Number.isSafeInteger(createdAt) ? { createdAt, id: record.id } : undefined;
}

export function createHistorySource(deps: HistorySourceDeps): HistorySource {
  const { reader } = deps;
  const readCoverage = deps.readCoverage ?? ((runId) => readRunUsageCoverage(reader, runId));
  let key = '';
  /** `cursors[p]` is the `before` of page `p`; page 0 has none. */
  let cursors: (Cursor | undefined)[] = [undefined];
  let pages = new Map<number, PageSlot>();
  const costs = new Map<string, HistoryCost>();

  const reset = (next: string): void => {
    key = next;
    cursors = [undefined];
    pages = new Map();
  };

  /** One fetch of page `page`: one `listRunSummaries` call, at most {@link HISTORY_FETCH_ROWS} rows. */
  function fetchPage(page: number, scope: HistoryScope, status: RunStatus | undefined): PageSlot {
    const before = cursors[page];
    const limit = status === undefined ? HISTORY_FETCH_ROWS : HISTORY_VIEW_ROWS + 1;
    const raw = reader.listRunSummaries({
      limit,
      ...(before === undefined ? {} : { before }),
      ...(status === undefined ? {} : { status }),
      ...(scope === 'project' ? { projectRoot: deps.projectRoot } : {}),
    });
    // History lists finished runs only: an active run in an unfiltered page belongs to the Active tab. A chosen status is already exact.
    const finished = status === undefined ? raw.filter((run) => isFinishedRun(run.status)) : raw;
    const records = finished.slice(0, HISTORY_VIEW_ROWS);
    let next: Cursor | undefined;
    if (finished.length > HISTORY_VIEW_ROWS) next = cursorOf(records.at(-1));
    // The raw page was full and everything in it was consumed: more may lie past it, even if this page is short.
    else if (raw.length >= limit) next = cursorOf(raw.at(-1));
    return {
      records,
      labels: reader.loadWorkflowSlugs([...new Set(records.map((run) => run.workflowId))]),
      next,
    };
  }

  /** Remember where page `page + 1` starts, and drop the cursors past it when the walk changed. */
  function recordNext(page: number, next: Cursor | undefined): void {
    if (next === undefined) {
      cursors.length = page + 1;
      return;
    }
    if (!sameCursor(cursors[page + 1], next)) cursors = [...cursors.slice(0, page + 1), next];
  }

  /** Keep the three pages nearest `current`; the farthest goes first, the later one on a tie. */
  function evict(current: number): void {
    while (pages.size > HISTORY_PAGES_MAX) {
      let farthest: number | undefined;
      for (const index of pages.keys()) {
        if (
          farthest === undefined ||
          Math.abs(index - current) > Math.abs(farthest - current) ||
          (Math.abs(index - current) === Math.abs(farthest - current) && index > farthest)
        )
          farthest = index;
      }
      if (farthest === undefined) return;
      pages.delete(farthest);
    }
  }

  function pinnedSection(
    scope: HistoryScope,
    pins: readonly HistoryRunPin[],
    now: number,
  ): readonly HistoryEntry[] {
    const readable = pins.filter((pin) => !pin.oversized).slice(0, MAX_RUN_SUMMARY_IDS);
    const found = reader.loadRunSummariesByIds(readable.map((pin) => pin.ref));
    const summaries = [...found.values()];
    const rows = new Map(
      buildHistoryRows({
        runs: summaries,
        nowMs: now,
        pinnedRunIds: new Set(summaries.map((run) => run.id)),
        workflowLabels: reader.loadWorkflowSlugs([
          ...new Set(summaries.map((run) => run.workflowId)),
        ]),
      }).map((row) => [row.id, row]),
    );
    const entries: HistoryEntry[] = [];
    for (const pin of pins) {
      const row = pin.oversized ? undefined : rows.get(pin.ref);
      const record = pin.oversized ? undefined : found.get(pin.ref);
      if (row === undefined || record === undefined) {
        entries.push({
          kind: 'missing',
          label: `${scrubbedBounded(pin.ref)}${pin.oversized ? '…' : ''}`,
          pinRowid: pin.rowid,
        });
      } else if (scope === 'all' || record.projectRoot === deps.projectRoot) {
        entries.push({ kind: 'run', row, pinRowid: pin.rowid });
      }
    }
    return entries;
  }

  return {
    read: (query) => {
      const nextKey = `${query.scope}|${query.status ?? '*'}`;
      if (query.fresh === true || nextKey !== key) reset(nextKey);
      const page = Math.max(0, Math.min(Math.trunc(query.page), cursors.length - 1));
      let slot = pages.get(page);
      if (slot === undefined) {
        slot = fetchPage(page, query.scope, query.status);
        pages.set(page, slot);
        recordNext(page, slot.next);
      }
      evict(page);
      const now = deps.now();
      const pins = deps.listRunPins();
      const pinRowids = new Map(
        pins.filter((pin) => !pin.oversized).map((pin) => [pin.ref, pin.rowid]),
      );
      // Rows are built on every read, so the ages and the pin marks are those of now, not of the fetch.
      const rows = buildHistoryRows({
        runs: slot.records,
        nowMs: now,
        pinnedRunIds: new Set(pinRowids.keys()),
        workflowLabels: slot.labels,
      }).map((row): HistoryEntry => {
        const pinRowid = pinRowids.get(row.id);
        return pinRowid === undefined ? { kind: 'run', row } : { kind: 'run', row, pinRowid };
      });
      return {
        query: { scope: query.scope, status: query.status, page },
        pinned: pinnedSection(query.scope, pins, now),
        rows,
        hasPrev: page > 0,
        hasNext: slot.next !== undefined,
      };
    },

    cost: (row) => {
      // A run that is not finished can still change, and a held end has no durable total: nothing is folded or kept for it.
      if (!isFinishedRun(row.status)) return { kind: 'not-final' };
      const kept = costs.get(row.id);
      if (kept !== undefined) return kept;
      const read = readPerRunOrDegrade(undefined, () => readCoverage(row.id));
      const cost: HistoryCost =
        read.degraded || read.value === undefined
          ? { kind: 'unreadable' }
          : {
              kind: 'text',
              text: formatCostShort(
                read.value.totalCostMicrocents,
                read.value.usageCoverage,
                read.value.unpricedCalls,
              ),
            };
      costs.set(row.id, cost);
      if (costs.size > HISTORY_COST_CACHE_MAX) {
        const oldest = costs.keys().next();
        if (oldest.done !== true) costs.delete(oldest.value);
      }
      return cost;
    },
  };
}
