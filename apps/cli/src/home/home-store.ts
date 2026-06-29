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
   * (most-recent first). Gate order tracks the paused RUN's creation time (`created_at DESC`) — a reliable
   * proxy for start time on a local run (both are set in one transaction), not the gate's own raise time (a fine
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
  /**
   * Top-N per list (default {@link DEFAULT_HOME_LIMIT}). A positive integer; a non-positive value is clamped to
   * `1` (unlike the DB-layer `≤0 ⇒ unbounded` convention, `0` is not a meaningful Home request).
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

/**
 * Aggregate one {@link HomeSnapshot} from the read seams. A failed or human-gated run is lifted into the
 * "attention" section and EXCLUDED from the neutral "Continue" runs, so it is never shown twice.
 */
export function buildHomeSnapshot(deps: HomeStoreDeps): HomeSnapshot {
  // Clamp to ≥1: the DB layer's `≤0 ⇒ unbounded` convention must NOT leak to a Home caller — a `limit: 0` would
  // otherwise read every session/run unbounded yet slice `recentRuns` to empty (incoherent). `0` is not a
  // meaningful Home request, so treat any non-positive value as the smallest glanceable strip.
  const limit = Math.max(deps.limit ?? DEFAULT_HOME_LIMIT, 1);

  const recentSessionRecords = deps.sessions.listSessions({ limit });
  const failedRunRecords = deps.runs.listRuns({ status: 'failed', limit });
  // A budget-paused run carries no human gate (pendingHumanGates excludes budget gates), so it stays in "Continue".
  // The DISPLAYED gates come from the most-recent `limit` paused runs: a paused run accumulates indefinitely (a
  // gate never resolved, a crash before the terminal), and each costs a `loadRunEvents` + reconstruct, so the
  // shown fan-out is capped (the glanceable-strip contract). Derive each displayed one's gates ONCE.
  const allPausedRuns = deps.runs.listActiveRuns().filter((run) => run.status === 'paused');
  const displayedPausedRuns = allPausedRuns.slice(0, limit);
  const gatesByRun = displayedPausedRuns.map((run) => ({
    run,
    pending: pendingHumanGates(deps.runs.loadRunEvents(run.id)),
  }));

  // "Attention" lifts a FAILED run (by STATUS — any of them, so a failure beyond the cap can never leak into
  // "Continue") or a paused run carrying ≥1 human gate. The DISPLAYED gated ids drive the over-fetch math.
  const displayedGatedRunIds = new Set(
    gatesByRun.filter((g) => g.pending.length > 0).map((g) => g.run.id),
  );
  // Over-fetch the recent window by the rows we KNOW we will strip (the displayed failed + the displayed gated),
  // so after the attention rows are removed "Continue" still fills to `limit` whenever that many neutral runs
  // exist below the cutoff — a burst of failures must not starve Continue.
  const overFetch = failedRunRecords.length + displayedGatedRunIds.size;
  const recentRunRecords = deps.runs.listRuns({ limit: limit + overFetch });

  // Close the gated-leak: a paused+human-gated run BEYOND the display cap could still fall inside the Continue
  // window and leak in. So the EXCLUSION set is widened to every paused run that appears in `recentRunRecords` —
  // checking the gates of the not-yet-checked ones (bounded by the window size, not all of N_paused). A
  // budget-paused run carries no human gate, so it correctly STAYS in Continue. (A neutral run-burst deeper than
  // the over-fetch margin can still under-fill Continue; that is the accepted glanceable edge — it never leaks.)
  const recentRunIds = new Set(recentRunRecords.map((r) => r.id));
  const checkedRunIds = new Set(displayedPausedRuns.map((r) => r.id));
  const humanGatedRunIds = new Set(displayedGatedRunIds);
  for (const run of allPausedRuns) {
    if (checkedRunIds.has(run.id) || !recentRunIds.has(run.id)) continue; // already checked, or outside the window
    if (pendingHumanGates(deps.runs.loadRunEvents(run.id)).length > 0) humanGatedRunIds.add(run.id);
  }

  // ONE batched, primary-key slug lookup for every run we will render (recent ∪ failed ∪ displayed paused), deduped.
  const slugById = deps.runs.loadWorkflowSlugs([
    ...new Set(
      [...recentRunRecords, ...failedRunRecords, ...displayedPausedRuns].map((r) => r.workflowId),
    ),
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

  // `recentAgents` is intentionally omitted: it derives from `recentSessionRecords`, so a non-empty agent list
  // implies non-empty `recentSessions`, which already makes `isEmpty` false. (If agents ever get a separate DB
  // read seam, add the check here.)
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
