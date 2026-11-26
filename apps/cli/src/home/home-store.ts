import {
  isCorruptRunEventError,
  isUnreadableRunEventLogError,
  MAX_RUN_SUMMARY_PAGE,
  RunHistoryReadError,
  SessionDiscoveryBoundaryError,
  type RunHistoryReader,
  type RunRecord,
  type RunSummaryRecord,
  type SessionStore,
} from '@relavium/db';
import type { AgentSessionRecord, RunStatus, UsageCoverage } from '@relavium/shared';

import { pendingParkDisplays } from '../gate/pending.js';
import { readPerRunOrDegrade } from '../history/per-run-read.js';
import { readRunUsageCoverage, UNVERIFIED_USAGE } from '../history/usage-coverage.js';

/**
 * The data aggregator behind the bare-invocation **Home** (2.5.B, [ADR-0054](../../../../docs/decisions/0054-cli-bare-invocation-interactive-home.md)).
 * It composes the durable `history.db` into one read-only {@link HomeSnapshot}: the failed runs and the unreadable runs of
 * **"Attention required"** (the parked runs are the controller's own read, `readParkedRuns`), the **sessions**, **runs** and agents, and
 * the **true totals** of each section. Pure aggregation over the injected read seams — it owns no db handle and no mutable state, and its
 * one clock is injected — so the sectioning, the ordering and the counting are unit-tested without a UI.
 *
 * - **This directory only** (MVP-11 unit 7; the maintainer: what belongs to the directory the Home was opened in is shown, the unrelated
 *   is not). A session is this directory's when its `working_dir` is {@link HomeStoreDeps.workingDir} (what `/resume` calls "this
 *   directory"); a run is when its `project_root` is {@link HomeStoreDeps.projectRoot} (what `relavium run` records). A run that recorded no
 *   project is not "here": unknown is not this directory. Every other directory stays reachable in `/resume` (Tab) and `/history`.
 * - **Each run is counted ONCE.** A paused run is Attention (the parked row the controller shows, or an unreadable row here). A failed run
 *   created inside {@link ATTENTION_FAILED_WINDOW_MS} is Attention (a failed row, or an unreadable row). Every other run of this directory
 *   is a Runs row, until its log turns out unreadable while this snapshot reads it: it is then an Attention item and no longer a run.
 *   An unreadable run is one unreadable row, never also a parked, failed or Runs row.
 * - **True totals** ({@link HomeTotals}): read-only `count(*)` seams over the same filters the lists use, never the loaded rows, so a
 *   section that shows four rows of 32 says `28 more`.
 * - **Bounded + indexed.** Every list is an indexed top-N of this directory (`listRunSummaries` / `listSessions` off
 *   `idx_runs_project_created` / `idx_agent_sessions_working_dir_updated`, plans pinned in `harness/perf-budget.e2e.test.ts`); run rows are
 *   labeled through ONE batched primary-key `loadWorkflowSlugs`; the per-run log reads are one per loaded paused run and one per run a
 *   list shows (or finds unreadable); "recent agents" is derived from the already-read sessions.
 * - **Text stays raw here.** A slug, a title and an id are returned as stored and scrubbed by the view where it draws them; a reason why a
 *   run cannot be read is a closed word ({@link UnreadableRunReason}), never an error's message (which may carry a path or stored text).
 */

/** Default top-N per Home list: the newest eight of each (the parked rows the controller keeps are eight too, `PARKED_RUNS_MAX`). */
export const DEFAULT_HOME_LIMIT = 8;

/**
 * The most rows one Home list loads. A list of runs reads a page of twice its limit (room for the rows found unreadable on the way), and
 * a summary page holds at most {@link MAX_RUN_SUMMARY_PAGE} rows.
 */
export const HOME_LIMIT_MAX = Math.floor(MAX_RUN_SUMMARY_PAGE / 2);

/**
 * How long a failed run stays under "Attention required": seven days from when it was CREATED (the maintainer's ruling, 2026-11-26).
 * After that it is history: it is listed as the run it is in the Runs section (and in `/history`), not dropped. The bound is on
 * `created_at` because that is what `idx_runs_project_created` / `idx_runs_status` order by; a run lasts minutes to hours, so its creation
 * and its failure are hours apart at most against a window of days.
 */
export const ATTENTION_FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A recent chat session row (the agent-first primary entity of the Home). */
export interface HomeSessionRow {
  readonly sessionId: string;
  readonly workingDir: string;
  readonly title: string | undefined;
  readonly agentSlug: string;
  readonly modelId: string | undefined;
  readonly status: AgentSessionRecord['status'];
  readonly updatedAt: string;
  /** Cumulative session cost — the agent-first primary row glances with cost too (parity with `HomeRunRow`). */
  readonly totalCostMicrocents: number;
  readonly usageCoverage?: UsageCoverage;
  readonly unpricedCalls?: number;
}

/** A run row (recent or failed), labeled by its workflow slug. */
export interface HomeRunRow {
  readonly runId: string;
  /** `undefined` ⇒ the workflow is soft-deleted / unknown (the row still renders, by short run id). */
  readonly workflowSlug: string | undefined;
  readonly status: RunRecord['status'];
  readonly createdAt: string;
  /** When the run actually began (`undefined` until `run:started`) — the renderer's anchor for a running row. */
  readonly startedAt: string | undefined;
  /** When the run reached a terminal (`undefined` while non-terminal) — the anchor + duration source for a
   *  completed/failed/cancelled row, which `createdAt` alone cannot give. */
  readonly completedAt: string | undefined;
  readonly totalCostMicrocents: number;
  readonly usageCoverage?: UsageCoverage;
  readonly unpricedCalls?: number;
}

/** A recently-used agent, derived from the recent sessions. */
export interface HomeAgentRow {
  readonly agentSlug: string;
  /** The most-recent session's `updatedAt` for this agent. */
  readonly lastUsedAt: string;
}

/**
 * Why a run's log cannot be read: a CLOSED vocabulary, from what the per-run read can tell apart ({@link unreadableReasonOf}). Never an
 * error's message: a message can carry a path, an event type a hand-edited row holds, or other stored text.
 *
 * - `corrupt-row`: a stored row is damaged (`CorruptRunEventError`); upgrading does not help, and the run is not changed by reading it.
 * - `newer-version`: a row was written by a newer version of Relavium (`UnreadableRunEventLogError`); updating makes it readable.
 * - `could-not-read`: the read degraded for a reason neither of those names.
 */
export type UnreadableRunReason = 'corrupt-row' | 'newer-version' | 'could-not-read';

/**
 * A run of this directory whose event log could not be read while building this snapshot (#W15-15): its gate detail or its usage is
 * MISSING, not absent. Its identity is what the run's own listing row said (its status and creation time, and its workflow's slug when the
 * slug lookup named it); each is optional in the type, and absent when it is not known.
 */
export interface HomeUnreadableRun {
  readonly runId: string;
  readonly workflowSlug?: string;
  readonly status?: RunStatus;
  readonly createdAt?: string;
  readonly reason: UnreadableRunReason;
}

/**
 * This directory's TRUE totals, each run counted once (see the module notes), independent of how many rows a list loaded:
 *
 * - `attention` = every paused run + every failed run created inside {@link ATTENTION_FAILED_WINDOW_MS} + the runs of the Runs section
 *   whose log this snapshot found unreadable. Its rows are the controller's parked rows, {@link HomeSnapshot.unreadableRuns} and
 *   {@link HomeSnapshot.attention}'s failed runs.
 * - `runs` = every other run of this directory (not paused, not failed inside the window) less those found unreadable.
 * - `sessions` = this directory's live sessions.
 *
 * The invariant every section keeps: the rows it shows + its `N more` = its total. `attention + runs` and `sessions` do not depend on the
 * loaded limit at all; the split between `attention` and `runs` moves only by the unreadable runs a snapshot found, which it shows as
 * Attention rows. The counts and the lists are separate statements on one connection: while another process writes between them, one
 * snapshot can be off by the runs that moved, and the next read (the change token moved) corrects it; a view clamps `N more` at zero.
 */
export interface HomeTotals {
  readonly attention: number;
  readonly sessions: number;
  readonly runs: number;
}

export interface HomeSnapshot {
  /** "Attention required": the failed runs of this directory created inside the window and readable, newest first. */
  readonly attention: {
    readonly failedRuns: readonly HomeRunRow[];
  };
  /** This directory's sessions, most recently updated first. */
  readonly recentSessions: readonly HomeSessionRow[];
  /** This directory's Runs section, newest first: no paused run, no failed run inside the window, no unreadable run. */
  readonly recentRuns: readonly HomeRunRow[];
  readonly recentAgents: readonly HomeAgentRow[];
  /**
   * The runs whose event log could not be read while building this snapshot (#W15-15), newest first, each once: a paused run among the
   * newest {@link DEFAULT_HOME_LIMIT} (the parked rows the controller reads), a failed run of the window, or a run of the Runs section the
   * snapshot read. Empty on the healthy path.
   */
  readonly unreadableRuns: readonly HomeUnreadableRun[];
  /** This directory's true totals ({@link HomeTotals}). */
  readonly totals: HomeTotals;
  /** True when this directory has NOTHING to show (every total is zero) — the Home has no work page, and its landing says so (no `↓`). */
  readonly isEmpty: boolean;
}

/** The read seams the Home aggregates over — narrowed so a test can stub exactly these reads. */
export interface HomeStoreDeps {
  readonly sessions: Pick<
    SessionStore,
    'listSessions' | 'countSessions' | 'loadSessionCostBreakdown'
  >;
  readonly runs: Pick<
    RunHistoryReader,
    | 'listRunSummaries'
    | 'countRunSummaries'
    | 'loadRunStateEvents'
    | 'loadWorkflowSlugs'
    | 'visitRunEventsForReplay'
  >;
  /**
   * The directory this Home was opened in as a RUN records it (`driveHome` passes its cwd, the root `relavium run`, the run host, the
   * parked rows and the History tab use): a run is this directory's when its `project_root` is this. REQUIRED: there is no unscoped Home;
   * a value that is not a non-empty string is refused before any read (`RunHistoryReadError`, `invalid_filter`).
   */
  readonly projectRoot: string;
  /**
   * The same directory as a SESSION records it: the canonical workspace a chat started here keeps as its `working_dir`, the very value
   * the `/resume` picker and the `/agents` tab call "this directory" (`driveHome` passes `fsPolicyWorkspace(fsPolicy)`; it can differ from
   * the cwd's spelling, e.g. a symlinked temp directory). REQUIRED; a value that is not a non-empty string is refused before any read
   * (`SessionDiscoveryBoundaryError`).
   */
  readonly workingDir: string;
  /** The clock (epoch ms) the failed-run window is measured against, read once per snapshot. */
  readonly now: () => number;
  /**
   * Top-N per list (default {@link DEFAULT_HOME_LIMIT}). A positive integer; a non-positive value is clamped to `1` (unlike the DB-layer
   * `≤0 ⇒ unbounded` convention, `0` is not a meaningful Home request), one above {@link HOME_LIMIT_MAX} to that, and a non-integer
   * falls back to the default.
   */
  readonly limit?: number;
}

/** A Home data handle: `read()` re-aggregates a fresh snapshot (so returning from a chat reflects the new state). */
export interface HomeStore {
  read: () => HomeSnapshot;
}

/** Wire a {@link HomeStore} over the durable read seams. Each `read()` is a fresh, bounded aggregation. */
export function createHomeStore(deps: HomeStoreDeps): HomeStore {
  return { read: () => buildHomeSnapshot(deps) };
}

/** `deps.limit` as a safe list size: the default for a non-integer, `1` for `≤0`, {@link HOME_LIMIT_MAX} at most. */
function homeLimit(requested: number | undefined): number {
  const value = requested ?? DEFAULT_HOME_LIMIT;
  if (!Number.isInteger(value)) return DEFAULT_HOME_LIMIT;
  return Math.min(Math.max(value, 1), HOME_LIMIT_MAX);
}

/**
 * The closed word for why a per-run read degraded: a log row a newer version wrote, a damaged row, or (anything else) it could not be
 * read. Reads only the error's TYPE (by its code, bundling-safe), never its message.
 */
export function unreadableReasonOf(error: unknown): UnreadableRunReason {
  if (isUnreadableRunEventLogError(error)) return 'newer-version';
  if (isCorruptRunEventError(error)) return 'corrupt-row';
  return 'could-not-read';
}

/**
 * One per-run read, isolated by `readPerRunOrDegrade` (which alone decides what is a per-run condition: any other fault still
 * propagates), with the reason it degraded when it did. The error itself is kept only long enough to name its type.
 */
function readOrReason<T>(
  fallback: T,
  read: () => T,
): { readonly value: T; readonly reason?: UnreadableRunReason } {
  let caught: unknown;
  const result = readPerRunOrDegrade(fallback, () => {
    try {
      return read();
    } catch (error) {
      caught = error;
      throw error;
    }
  });
  return result.degraded
    ? { value: result.value, reason: unreadableReasonOf(caught) }
    : { value: result.value };
}

/** A run the snapshot read and found unreadable, with the listing row that names it. */
interface FoundUnreadable {
  readonly run: RunSummaryRecord;
  readonly reason: UnreadableRunReason;
}

type RunUsage = Pick<HomeRunRow, 'totalCostMicrocents' | 'usageCoverage' | 'unpricedCalls'>;

/** The runs of one list that a section shows, and the ones it found unreadable on the way. */
interface ListRead {
  readonly rows: readonly { readonly run: RunSummaryRecord; readonly usage: RunUsage }[];
  readonly unreadable: readonly FoundUnreadable[];
}

/**
 * The first `limit` READABLE runs of `records` (newest first), each with its usage read from its own log; a run whose log cannot be read
 * is set aside as unreadable and the next one is read instead. A run already placed by an earlier list (`seen`) is skipped, so a run that
 * changed status between two statements is still placed once. Reads stop once `limit` rows are kept.
 */
function readRows(
  deps: HomeStoreDeps,
  records: readonly RunSummaryRecord[],
  limit: number,
  seen: Set<string>,
): ListRead {
  const rows: { run: RunSummaryRecord; usage: RunUsage }[] = [];
  const unreadable: FoundUnreadable[] = [];
  for (const run of records) {
    if (rows.length >= limit) break;
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const read = readOrReason<RunUsage>(
      {
        totalCostMicrocents: run.totalCostMicrocents,
        usageCoverage: UNVERIFIED_USAGE,
        unpricedCalls: 0,
      },
      () => {
        const usage = readRunUsageCoverage(deps.runs, run.id);
        return {
          totalCostMicrocents: usage.totalCostMicrocents,
          usageCoverage: usage.usageCoverage,
          unpricedCalls: usage.unpricedCalls,
        };
      },
    );
    if (read.reason === undefined) rows.push({ run, usage: read.value });
    else unreadable.push({ run, reason: read.reason });
  }
  return { rows, unreadable };
}

/**
 * The newest `limit` paused runs of this directory whose log cannot be read. The same runs, in the same order, as the parked rows the
 * controller reads (`readProjectRunGates` pages the project's paused runs newest first), and the same fold of the log
 * (`pendingParkDisplays` over `loadRunStateEvents`), so a run the controller drops as degraded is the one named here.
 */
function unreadablePaused(
  deps: HomeStoreDeps,
  limit: number,
  seen: Set<string>,
): readonly FoundUnreadable[] {
  const found: FoundUnreadable[] = [];
  for (const run of deps.runs.listRunSummaries({
    projectRoot: deps.projectRoot,
    status: 'paused',
    limit,
  })) {
    seen.add(run.id);
    const read = readOrReason(undefined, () => {
      pendingParkDisplays(deps.runs.loadRunStateEvents(run.id));
      return undefined;
    });
    if (read.reason !== undefined) found.push({ run, reason: read.reason });
  }
  return found;
}

/** Newest first by `(createdAt, id)`, the order every list of runs is read in. */
function newestFirst(a: FoundUnreadable, b: FoundUnreadable): number {
  const at = Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt);
  if (at !== 0 && !Number.isNaN(at)) return at;
  if (a.run.id === b.run.id) return 0;
  return a.run.id < b.run.id ? 1 : -1;
}

/**
 * Aggregate one {@link HomeSnapshot} of this directory from the read seams. See the module notes for what is read, where each run is
 * placed, and how each total is counted.
 */
export function buildHomeSnapshot(deps: HomeStoreDeps): HomeSnapshot {
  const projectRoot = deps.projectRoot;
  // There is no unscoped Home: a directory that is not a non-empty string is refused before any read, with the reader's own typed
  // error (the reads refuse it too; this says it once, first, for every list and count alike).
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new RunHistoryReadError(
      'invalid_filter',
      'the Home reads the directory it was opened in',
    );
  }
  const workingDir = deps.workingDir;
  if (typeof workingDir !== 'string' || workingDir.length === 0)
    throw new SessionDiscoveryBoundaryError();
  const limit = homeLimit(deps.limit);
  // The window's lower bound, from ONE reading of the clock, so the lists and the counts draw the same line.
  const since = deps.now() - ATTENTION_FAILED_WINDOW_MS;
  // A page of twice the limit: the rows a section shows, and room for the unreadable runs found on the way.
  const page = Math.min(MAX_RUN_SUMMARY_PAGE, limit * 2);
  const seen = new Set<string>();

  const pausedUnreadable = unreadablePaused(deps, limit, seen);
  const failed = readRows(
    deps,
    deps.runs.listRunSummaries({ projectRoot, status: 'failed', since, limit: page }),
    limit,
    seen,
  );
  const recent = readRows(
    deps,
    deps.runs.listRunSummaries({
      projectRoot,
      exceptStatus: 'paused',
      failedOnlyBefore: since,
      limit: page,
    }),
    limit,
    seen,
  );
  const unreadable = [...pausedUnreadable, ...failed.unreadable, ...recent.unreadable].sort(
    newestFirst,
  );

  // ONE batched, primary-key slug lookup for every run the snapshot names.
  const slugById = deps.runs.loadWorkflowSlugs([
    ...new Set(
      [...failed.rows.map((row) => row.run), ...recent.rows.map((row) => row.run)]
        .concat(unreadable.map((found) => found.run))
        .map((run) => run.workflowId),
    ),
  ]);
  const runRow = ({ run, usage }: ListRead['rows'][number]): HomeRunRow => ({
    ...toRunRow(run, slugById.get(run.workflowId)),
    ...usage,
  });

  const recentSessionRecords = deps.sessions.listSessions({ limit, workingDir });
  const recentSessions = recentSessionRecords.map((session) => {
    const costs = deps.sessions.loadSessionCostBreakdown(session.id);
    return {
      ...toSessionRow(session),
      totalCostMicrocents: costs.totalCostMicrocents,
      usageCoverage: costs.coverage,
      unpricedCalls: costs.rows.reduce((sum, row) => sum + row.unpricedCalls, 0),
    };
  });

  // The totals: the same filters as the lists, counted. The runs of the Runs section found unreadable move to Attention.
  const moved = recent.unreadable.length;
  const totals: HomeTotals = {
    attention:
      deps.runs.countRunSummaries({ projectRoot, status: 'paused' }) +
      deps.runs.countRunSummaries({ projectRoot, status: 'failed', since }) +
      moved,
    sessions: deps.sessions.countSessions({ workingDir }),
    runs:
      deps.runs.countRunSummaries({
        projectRoot,
        exceptStatus: 'paused',
        failedOnlyBefore: since,
      }) - moved,
  };

  const failedRuns = failed.rows.map(runRow);
  const recentRuns = recent.rows.map(runRow);
  return {
    attention: { failedRuns },
    recentSessions,
    recentRuns,
    recentAgents: deriveRecentAgents(recentSessionRecords),
    unreadableRuns: unreadable.map(({ run, reason }) => toUnreadableRun(run, slugById, reason)),
    totals,
    // Nothing counted AND nothing listed: a Home whose only content is a damaged run is not a fresh install (#W15-15), and a row read in a
    // race with a count never leaves a Home that holds it reading as empty.
    isEmpty:
      totals.attention + totals.sessions + totals.runs === 0 &&
      recentSessions.length + failedRuns.length + recentRuns.length + unreadable.length === 0,
  };
}

function toUnreadableRun(
  run: RunSummaryRecord,
  slugById: ReadonlyMap<string, string>,
  reason: UnreadableRunReason,
): HomeUnreadableRun {
  const workflowSlug = slugById.get(run.workflowId);
  return {
    runId: run.id,
    ...(workflowSlug === undefined ? {} : { workflowSlug }),
    status: run.status,
    createdAt: run.createdAt,
    reason,
  };
}

function toRunRow(run: RunRecord, workflowSlug: string | undefined): HomeRunRow {
  return {
    runId: run.id,
    workflowSlug,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalCostMicrocents: run.totalCostMicrocents,
  };
}

function toSessionRow(session: AgentSessionRecord): HomeSessionRow {
  return {
    sessionId: session.id,
    workingDir: session.context.workingDir,
    title: session.title,
    agentSlug: session.agentSlug,
    modelId: session.modelId,
    status: session.status,
    updatedAt: session.updatedAt,
    totalCostMicrocents: session.totalCostMicrocents,
  };
}

/**
 * The distinct agents used across the recent sessions, most-recent first — the session-derived "recent agents"
 * (the maintainer-chosen source; there is no DB agent read seam). The FIRST occurrence of each slug is its
 * most-recent use because `recentSessions` is already ordered `updated_at DESC`, and `Map` preserves that
 * insertion order.
 */
function deriveRecentAgents(recentSessions: readonly AgentSessionRecord[]): HomeAgentRow[] {
  const lastUsedBySlug = new Map<string, string>();
  for (const session of recentSessions) {
    if (!lastUsedBySlug.has(session.agentSlug)) {
      lastUsedBySlug.set(session.agentSlug, session.updatedAt);
    }
  }
  return [...lastUsedBySlug].map(([agentSlug, lastUsedAt]) => ({ agentSlug, lastUsedAt }));
}
