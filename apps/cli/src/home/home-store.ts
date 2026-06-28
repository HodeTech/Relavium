import type { RunHistoryReader, RunRecord, SessionStore } from '@relavium/db';
import type { AgentSessionRecord } from '@relavium/shared';

import { pendingHumanGates, type PendingGate } from '../gate/pending.js';

/**
 * The data aggregator behind the bare-invocation **Home** (2.5.B, [ADR-0054](../../../../docs/decisions/0054-cli-bare-invocation-interactive-home.md)).
 * It composes the durable `history.db` into one read-only {@link HomeSnapshot} the Home strip renders: an
 * **"Attention required"** section (pending human gates, then failed runs) above a neutral **"Continue"** list
 * (recent sessions / runs / agents). Pure aggregation over the injected read seams — it owns no db handle, clock,
 * or mutable state, so the sectioning + ordering is unit-tested without a UI.
 *
 * **Bounded + indexed (the §2.I perf discharge).** Every list is an indexed top-N (`listSessions`/`listRuns`
 * `{ limit }`, served off the `idx_agent_sessions_updated` / `idx_runs_created` partial indexes), never a full
 * materialization; run rows are labeled by workflow slug through ONE batched, primary-key `loadWorkflowSlugs`
 * lookup; and "recent agents" is derived from the already-read sessions (the maintainer-chosen source — there is
 * no DB agent read seam), so the whole snapshot is a handful of bounded queries.
 */

/** Default top-N per Home list — the read-only strip shows a glanceable handful, not the full history. */
export const DEFAULT_HOME_LIMIT = 8;

/** A recent chat session row (the agent-first primary entity of the Home). */
export interface HomeSessionRow {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly agentSlug: string;
  readonly modelId: string | undefined;
  readonly status: AgentSessionRecord['status'];
  readonly updatedAt: string;
  /** Cumulative session cost — the agent-first primary row glances with cost too (parity with `HomeRunRow`). */
  readonly totalCostMicrocents: number;
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
}

/** A pending human gate awaiting resolution — the most urgent "attention" item. */
export interface HomeGateRow {
  readonly runId: string;
  readonly workflowSlug: string | undefined;
  readonly gateId: string;
  readonly gateType: PendingGate['gateType'];
  readonly nodeId: string;
  readonly message: string;
  /**
   * The gate's deadline, or `undefined` if it never expires. **May be in the PAST in Phase 1:** the
   * gate-timeout timer is in-process, and a gate whose deadline elapsed while no engine was running stays
   * `pending` (the crash-reconciliation re-arm is deferred), so the renderer owns the overdue styling.
   */
  readonly expiresAt: string | undefined;
}

/** A recently-used agent, derived from the recent sessions. */
export interface HomeAgentRow {
  readonly agentSlug: string;
  /** The most-recent session's `updatedAt` for this agent. */
  readonly lastUsedAt: string;
}

export interface HomeSnapshot {
  /**
   * "Attention required" — pending human gates FIRST (ordered by their run's recency), then failed runs
   * (most-recent first). Gate order tracks the paused RUN's start time, not the gate's own raise time (a fine
   * proxy for a small, glanceable list; true gate-recency would need `pendingHumanGates` to carry the raise time).
   */
  readonly attention: {
    readonly gates: readonly HomeGateRow[];
    readonly failedRuns: readonly HomeRunRow[];
  };
  /** "Continue" — the neutral recency lists (failed/gated runs are lifted into `attention`, not repeated here). */
  readonly recentSessions: readonly HomeSessionRow[];
  readonly recentRuns: readonly HomeRunRow[];
  readonly recentAgents: readonly HomeAgentRow[];
  /** True when there is NOTHING to show (a fresh install) — the UI renders a first-run welcome, not empty strips. */
  readonly isEmpty: boolean;
}

/** The read seams the Home aggregates over — narrowed so a test can stub exactly these reads. */
export interface HomeStoreDeps {
  readonly sessions: Pick<SessionStore, 'listSessions'>;
  readonly runs: Pick<
    RunHistoryReader,
    'listRuns' | 'listActiveRuns' | 'loadRunEvents' | 'loadWorkflowSlugs'
  >;
  /** Top-N per list (default {@link DEFAULT_HOME_LIMIT}). */
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

/**
 * Aggregate one {@link HomeSnapshot} from the read seams. A failed or human-gated run is lifted into the
 * "attention" section and EXCLUDED from the neutral "Continue" runs, so it is never shown twice.
 */
export function buildHomeSnapshot(deps: HomeStoreDeps): HomeSnapshot {
  const limit = deps.limit ?? DEFAULT_HOME_LIMIT;

  const recentSessionRecords = deps.sessions.listSessions({ limit });
  const failedRunRecords = deps.runs.listRuns({ status: 'failed', limit });
  // The active-run set is already small (non-terminal only); a HUMAN-gated paused run is the gate source. A
  // budget-paused run carries no human gate (pendingHumanGates excludes budget gates), so it stays in "Continue".
  // Derive each paused run's gates ONCE (one loadRunEvents per run) — reused for both the rows and the lift set.
  const pausedRuns = deps.runs.listActiveRuns().filter((run) => run.status === 'paused');
  const gatesByRun = pausedRuns.map((run) => ({
    run,
    pending: pendingHumanGates(deps.runs.loadRunEvents(run.id)),
  }));

  // "Attention" = a FAILED run (any of them — by status, NOT just the displayed top-N, so a failure beyond the
  // cap can never leak into "Continue") or a paused run carrying ≥1 human gate. The human-gated ids are an
  // explicit set; failed is tested by status below. Built BEFORE the recent window so it can be widened to compensate.
  const humanGatedRunIds = new Set(
    gatesByRun.filter((g) => g.pending.length > 0).map((g) => g.run.id),
  );
  // Over-fetch the recent window by the count of rows we KNOW we will strip (the displayed failed + the gated),
  // so after the attention rows are removed "Continue" still fills to `limit` whenever that many neutral runs
  // exist below the cutoff — a burst of failures must not starve Continue. (A run-burst deeper than this margin
  // can still under-fill; that is the accepted edge for a glanceable strip — it never leaks an attention run.)
  const overFetch = failedRunRecords.length + humanGatedRunIds.size;
  const recentRunRecords = deps.runs.listRuns({ limit: limit + overFetch });

  // ONE batched, primary-key slug lookup for every run we will render (recent ∪ failed ∪ paused), ids deduped.
  const slugById = deps.runs.loadWorkflowSlugs([
    ...new Set([...recentRunRecords, ...failedRunRecords, ...pausedRuns].map((r) => r.workflowId)),
  ]);
  const slugOf = (run: RunRecord): string | undefined => slugById.get(run.workflowId);

  const gates: HomeGateRow[] = gatesByRun.flatMap(({ run, pending }) =>
    pending.map((gate) => ({
      runId: run.id,
      workflowSlug: slugOf(run),
      gateId: gate.gateId,
      gateType: gate.gateType,
      nodeId: gate.nodeId,
      message: gate.message,
      expiresAt: gate.expiresAt,
    })),
  );

  const failedRuns = failedRunRecords.map((run) => toRunRow(run, slugOf(run)));
  const recentRuns = recentRunRecords
    .filter((run) => run.status !== 'failed' && !humanGatedRunIds.has(run.id)) // never repeat an attention run
    .slice(0, limit) // trim the over-fetch back to the top-N survivors
    .map((run) => toRunRow(run, slugOf(run)));

  const recentSessions = recentSessionRecords.map(toSessionRow);
  const recentAgents = deriveRecentAgents(recentSessionRecords);

  const isEmpty =
    recentSessions.length === 0 &&
    recentRuns.length === 0 &&
    gates.length === 0 &&
    failedRuns.length === 0;

  return { attention: { gates, failedRuns }, recentSessions, recentRuns, recentAgents, isEmpty };
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
