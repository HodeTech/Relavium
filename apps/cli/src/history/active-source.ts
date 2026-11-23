import type { RunHistoryReader, RunLeaseSummary, RunSummaryRecord } from '@relavium/db';
import type { RunStatus } from '@relavium/shared';

import { gatesOfRun, type RunGatesReader } from '../home/run-gates.js';
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
 * - **Gates and media jobs through `gatesOfRun`, per run, kept per run.** A paused run of THIS project is read for its pending human and
 *   budget gates and its media jobs in flight, one isolated read each: a run whose log cannot be read is NOT counted (it would read as zero gates, and a run with no gate reads as "waiting
 *   for a media job", which is a false thing to say about a damaged log). It is left out of the counts, so the model labels it `gate state
 *   not read` and offers it no card. The count is kept per run id under a key of the run's own row (its status and `updated_at`, which every
 *   gate event moves), so a poll tick re-reads only the runs whose row moved, never every paused run's whole log; an entry older than one
 *   lease TTL is read again (two events in one millisecond leave the row as it was), and an entry for a run no longer listed is dropped.
 * - **A held terminal is read by the caller.** The outbox is a file read, so it is asynchronous and lives in {@link createActiveReader};
 *   {@link readActive} takes the ids it found. The reader keeps the held ids under the outbox file's stamp (size and mtime), so an unchanged
 *   file is not parsed again at every tick.
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

/**
 * What was read of one paused run's park, and under which key of its row. `count` (its open gates) and `media` (its media jobs in
 * flight) are `undefined` for a log that could not be read.
 */
interface GateCountEntry {
  readonly key: string;
  readonly count: number | undefined;
  readonly media: number | undefined;
  /** Epoch milliseconds of the read: an entry is trusted for at most one lease TTL. */
  readonly at: number;
}

/** The gate counts kept by run id between reads of one reader. */
export type GateCountCache = Map<string, GateCountEntry>;

export interface ActiveSourceInput {
  readonly reader: ActiveSourceReader;
  /** The gate counts kept between reads; a caller that reads once passes none. */
  readonly gateCache?: GateCountCache | undefined;
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

/** The key a run's row gives its gate count: a gate event moves `updated_at` and the status, and nothing else makes the log change. */
const gateKeyOf = (run: RunSummaryRecord): string => `${run.status}|${run.updatedAt}`;

/** What the Active tab knows of the paused runs of this project: each readable run's open gates and its media jobs in flight. */
export interface ActiveParkCounts {
  readonly gates: Map<string, number>;
  readonly media: Map<string, number>;
}

/**
 * The pending gate count and the in-flight media job count of each paused run of this project whose log could be read. A run whose log
 * could not be read is absent from both, which the model reads as "gate state not read": counting it as zero would call a damaged log
 * "waiting for a media job". With a `cache`, a run whose key has not moved (and whose entry is younger than `maxAgeMs`) is not read again.
 */
export function readActiveParkCounts(
  reader: ActiveSourceReader,
  projectRoot: string,
  paused: readonly RunSummaryRecord[],
  options: {
    readonly cache?: GateCountCache | undefined;
    readonly nowMs?: number;
    readonly maxAgeMs?: number;
  } = {},
): ActiveParkCounts | undefined {
  const here = paused
    .filter((run) => run.projectRoot === projectRoot)
    .slice(0, ACTIVE_STATUS_LIMIT);
  const { cache } = options;
  if (here.length === 0) {
    cache?.clear();
    return undefined;
  }
  const nowMs = options.nowMs ?? 0;
  const maxAgeMs = options.maxAgeMs ?? 0;
  const counts: ActiveParkCounts = {
    gates: new Map<string, number>(),
    media: new Map<string, number>(),
  };
  for (const run of here) {
    const key = gateKeyOf(run);
    const kept = cache?.get(run.id);
    let count: number | undefined;
    let media: number | undefined;
    if (kept !== undefined && kept.key === key && nowMs - kept.at < maxAgeMs) {
      ({ count, media } = kept);
    } else {
      const read = gatesOfRun(reader, run);
      count = read.degraded ? undefined : read.gates.length + read.budgetGates.length;
      media = read.degraded ? undefined : (read.pendingMediaJobNodeIds?.length ?? 0);
      cache?.set(run.id, { key, count, media, at: nowMs });
    }
    if (count !== undefined) counts.gates.set(run.id, count);
    if (media !== undefined) counts.media.set(run.id, media);
  }
  if (cache !== undefined) {
    const listed = new Set(here.map((run) => run.id));
    for (const runId of [...cache.keys()]) if (!listed.has(runId)) cache.delete(runId);
  }
  return counts;
}

/** The pending gate count of each paused run of this project whose log could be read: {@link readActiveParkCounts}'s gate half. */
export function readActiveGateCounts(
  reader: ActiveSourceReader,
  projectRoot: string,
  paused: readonly RunSummaryRecord[],
  options: Parameters<typeof readActiveParkCounts>[3] = {},
): Map<string, number> | undefined {
  return readActiveParkCounts(reader, projectRoot, paused, options)?.gates;
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
  const parkCounts = readActiveParkCounts(reader, input.projectRoot, paused, {
    cache: input.gateCache,
    nowMs: input.nowMs,
    maxAgeMs: input.leaseTtlMs,
  });
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
    ...(parkCounts === undefined
      ? {}
      : { pendingGateCounts: parkCounts.gates, pendingMediaJobCounts: parkCounts.media }),
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
  /**
   * The outbox file's stamp (its size and mtime, `terminalOutboxStamp`), or `undefined` when it cannot be taken. A stamp equal to the one the
   * held ids were read under means the file did not change, and the file is not parsed again. Without it every read lists the file.
   */
  readonly outboxStamp?: (() => string | undefined) | undefined;
  /** The database is closed: asked once more after the outbox is read, so a read that was started open does not touch a closed database. */
  readonly isClosed?: (() => boolean) | undefined;
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
  const gateCache: GateCountCache = new Map();
  let kept: { readonly stamp: string; readonly ids: ReadonlySet<string> } | undefined;
  const stampNow = (): string | undefined => {
    try {
      return deps.outboxStamp?.();
    } catch {
      return undefined;
    }
  };
  return async () => {
    let heldRunIds: ReadonlySet<string> = new Set();
    let heldUnread = false;
    // The stamp is taken BEFORE the file is read: a file that changes in between is read again at the next tick, never trusted stale.
    const stamp = stampNow();
    if (stamp !== undefined && kept?.stamp === stamp) {
      heldRunIds = kept.ids;
    } else {
      kept = undefined;
      try {
        const events = await deps.listHeld();
        heldRunIds = new Set(
          events.map((event) => event.runId).filter((id): id is string => id !== undefined),
        );
        if (stamp !== undefined) kept = { stamp, ids: heldRunIds };
      } catch {
        heldUnread = true;
      }
    }
    // The poll asked `isClosed` before it started this read, and the outbox was awaited since: a database closed meanwhile is not read.
    if (deps.isClosed?.() === true) throw new Error('the history database is closed');
    return readActive({
      reader: deps.reader,
      projectRoot: deps.projectRoot,
      hostedRunId: deps.hostedRunId(),
      heldRunIds,
      heldUnread,
      nowMs: deps.now(),
      leaseTtlMs: deps.leaseTtlMs,
      gateCache,
    });
  };
}
