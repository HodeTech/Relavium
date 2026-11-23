import type { RunHistoryReader, RunLeaseSummary, RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { readProjectRunGates, type RunGatesReader } from '../home/run-gates.js';
import { classifyActiveRuns, type ActiveRow } from './active-model.js';

/**
 * The read behind the Home's Active tab ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2, MVP-8 step 4): which runs are not finished, which of them wait on a gate this Home can answer, and which are stalled or held. It
 * reads and classifies; it writes nothing and reconciles nothing (reconcile writes, and it stays at Home open). The classification is
 * `active-model.ts`; this module is the I/O around it, and it keeps every read bounded:
 *
 * - **At most {@link ACTIVE_STATUS_LIMIT} runs per status.** `pending`, `running` and `paused` are three keyset pages of that size (the
 *   largest the summary read accepts). When a page is full, ONE more page is read to count what lies beyond it, so the tab can say
 *   "N more" and not just "more": the count is exact up to a page and `N+` past it.
 * - **Leases in chunks of {@link ACTIVE_LEASE_CHUNK}.** `loadRunLeases` refuses a longer id list, so the rows read are asked about in
 *   chunks, and a run with no lease is simply absent from the answer.
 * - **Gates through `readProjectRunGates`, per run.** A paused run of THIS project is read for its pending human and budget gates, one
 *   isolated read each: a run whose log cannot be read is NOT counted (it would read as zero gates, and a run with no gate reads as "waiting
 *   for a media job", which is a false thing to say about a damaged log). It is left out of the counts, so the model labels it `gate state
 *   not read` and offers it no card.
 * - **A held terminal is read by the caller.** The outbox is a file read, so it is asynchronous and lives in {@link createActiveReader};
 *   {@link readActive} takes the ids it found.
 */

/** The most runs kept for one status; the rest are counted, not listed. */
export const ACTIVE_STATUS_LIMIT = 200;
/** The most run ids one lease lookup takes (`loadRunLeases` refuses more). */
export const ACTIVE_LEASE_CHUNK = 200;

/** The statuses that are not finished, in the order their rows are read. */
const ACTIVE_READ_STATUSES = [
  'running',
  'pending',
  'paused',
] as const satisfies readonly RunStatus[];
export type ActiveReadStatus = (typeof ACTIVE_READ_STATUSES)[number];

/** What lies beyond the rows kept for one status. */
export interface ActiveMore {
  readonly status: ActiveReadStatus;
  /** The runs counted past the kept ones. */
  readonly count: number;
  /** The count stopped at one page: there are at least this many (`200+`). */
  readonly atLeast: boolean;
}

/** One read of the Active tab: the classified rows (the model's order) and what was left out. */
export interface ActiveRead {
  readonly rows: readonly ActiveRow[];
  /** Only the statuses that have rows beyond the limit. */
  readonly more: readonly ActiveMore[];
  /** The terminal outbox could not be read, so a run whose terminal is held may be shown as running. */
  readonly heldUnread: boolean;
}

/** The reads this module needs, on top of the gate read's own. */
export type ActiveSourceReader = RunGatesReader &
  Pick<RunHistoryReader, 'loadRunLeases' | 'loadWorkflowSlugs'>;

export interface ActiveSourceInput {
  readonly reader: ActiveSourceReader;
  /** The directory the Home is in: a paused run is actionable only here (ADR-0139 §7). */
  readonly projectRoot: string;
  /** The run this Home's executing leg hosts, when one executes. */
  readonly hostedRunId: string | undefined;
  /** Run ids whose terminal event sits in the outbox. */
  readonly heldRunIds: ReadonlySet<string>;
  readonly heldUnread?: boolean;
  /** Epoch milliseconds: a lease is compared with it. */
  readonly nowMs: number;
  readonly leaseTtlMs: number;
}

/** `items` in consecutive chunks of at most `size`, in order. */
export function chunksOf<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** One status: its first page, and when the page is full one count of what lies past it. */
function readStatus(
  reader: ActiveSourceReader,
  status: ActiveReadStatus,
): { readonly rows: readonly RunSummaryRecord[]; readonly more: ActiveMore | undefined } {
  const rows = reader.listRunSummaries({ limit: ACTIVE_STATUS_LIMIT, status });
  const last = rows.at(-1);
  if (rows.length < ACTIVE_STATUS_LIMIT || last === undefined) return { rows, more: undefined };
  const beyond = reader.listRunSummaries({
    limit: ACTIVE_STATUS_LIMIT,
    status,
    before: { createdAt: Date.parse(last.createdAt), id: last.id },
  });
  if (beyond.length === 0) return { rows, more: undefined };
  return {
    rows,
    more: { status, count: beyond.length, atLeast: beyond.length === ACTIVE_STATUS_LIMIT },
  };
}

/** The leases of `runIds`, asked for in chunks the lookup accepts. */
function readLeases(
  reader: ActiveSourceReader,
  runIds: readonly string[],
): Map<string, RunLeaseSummary> {
  const leases = new Map<string, RunLeaseSummary>();
  for (const chunk of chunksOf(runIds, ACTIVE_LEASE_CHUNK)) {
    for (const [runId, lease] of reader.loadRunLeases(chunk)) leases.set(runId, lease);
  }
  return leases;
}

/**
 * The pending gate count of each paused run of this project whose log could be read. A run whose log could not be read is absent, which
 * the model reads as "gate state not read": counting it as zero would call a damaged log "waiting for a media job".
 */
export function readActiveGateCounts(
  reader: ActiveSourceReader,
  projectRoot: string,
  paused: readonly RunSummaryRecord[],
): Map<string, number> | undefined {
  if (!paused.some((run) => run.projectRoot === projectRoot)) return undefined;
  const counts = new Map<string, number>();
  const read = readProjectRunGates(reader, projectRoot, { maxRuns: ACTIVE_STATUS_LIMIT });
  for (const run of read.runs) {
    if (run.degraded) continue;
    counts.set(run.runId, run.gates.length + run.budgetGates.length);
  }
  return counts;
}

/** The slug of each workflow the rows belong to, for their labels. */
function readLabels(
  reader: ActiveSourceReader,
  runs: readonly RunSummaryRecord[],
): Map<string, string> {
  return reader.loadWorkflowSlugs([...new Set(runs.map((run) => run.workflowId))]);
}

/** Read and classify the runs that are not finished. Synchronous: every read here is SQLite on the caller's own connection. */
export function readActive(input: ActiveSourceInput): ActiveRead {
  const { reader } = input;
  const byStatus = ACTIVE_READ_STATUSES.map((status) => ({
    status,
    ...readStatus(reader, status),
  }));
  const runs = byStatus.flatMap((entry) => entry.rows);
  const paused = byStatus.find((entry) => entry.status === 'paused')?.rows ?? [];
  const more = byStatus.flatMap((entry) => (entry.more === undefined ? [] : [entry.more]));
  const pendingGateCounts = readActiveGateCounts(reader, input.projectRoot, paused);
  const rows = classifyActiveRuns({
    runs,
    leases: readLeases(
      reader,
      runs.map((run) => run.id),
    ),
    ...(input.hostedRunId === undefined ? {} : { hostedRunId: input.hostedRunId }),
    currentProjectRoot: input.projectRoot,
    outboxHeldRunIds: input.heldRunIds,
    nowMs: input.nowMs,
    leaseTtlMs: input.leaseTtlMs,
    ...(pendingGateCounts === undefined ? {} : { pendingGateCounts }),
    workflowLabels: readLabels(reader, runs),
  });
  return { rows, more, heldUnread: input.heldUnread === true };
}

export interface ActiveReaderDeps {
  readonly reader: ActiveSourceReader;
  readonly projectRoot: string;
  /** The run this Home's executing leg hosts now. */
  readonly hostedRunId: () => string | undefined;
  /** The events the terminal outbox holds (`createFileTerminalOutbox(...).list`). Rejects when the file cannot be read. */
  readonly listHeld: () => Promise<readonly { readonly runId?: string | undefined }[]>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly leaseTtlMs: number;
}

/**
 * The tab's read as one asynchronous call: the outbox first (a file), then every database read in one synchronous stretch, so the rows
 * of one read were all taken at the same moment. An outbox that cannot be read leaves the held set empty and says so in the result,
 * as `status` degrades: it never fails the tab.
 */
export function createActiveReader(deps: ActiveReaderDeps): () => Promise<ActiveRead> {
  return async () => {
    let heldRunIds: ReadonlySet<string> = new Set();
    let heldUnread = false;
    try {
      const events = await deps.listHeld();
      heldRunIds = new Set(
        events.map((event) => event.runId).filter((id): id is string => id !== undefined),
      );
    } catch {
      heldUnread = true;
    }
    return readActive({
      reader: deps.reader,
      projectRoot: deps.projectRoot,
      hostedRunId: deps.hostedRunId(),
      heldRunIds,
      heldUnread,
      nowMs: deps.now(),
      leaseTtlMs: deps.leaseTtlMs,
    });
  };
}
