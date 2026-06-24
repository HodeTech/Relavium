import {
  RunEventSchema,
  type ExecutionMode,
  type RunEvent,
  type RunStatus,
} from '@relavium/shared';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import {
  runCosts,
  runEvents,
  runs,
  stepExecutions,
  workflows,
  type NewRunCostRow,
  type NewRunEventRow,
  type NewRunRow,
  type NewStepExecutionRow,
  type RunRow,
  type StepExecutionRow,
} from './schema.js';
import { epochMsToIso, isoToEpochMs } from './time.js';

/**
 * Durable CLI run history (workstream **2.H**) — the SQLite-backed `RunStore` the CLI host injects in
 * place of the in-memory reference, plus the read API `relavium list`/`logs`/`status` (2.I) and the
 * cross-process resume substrate (2.G) consume. It writes the four run-history tables
 * (`runs` / `step_executions` / `run_events` / `run_costs`) the engine's emit-time `persistEvent`
 * chokepoint feeds (ADR-0036 persist-before-deliver), mirroring `session-store.ts`: the mappers are the
 * single domain↔row + validation boundary, ids/timestamps are caller/event-supplied, and timestamps cross
 * the ISO↔epoch-ms edge in `time.ts`.
 *
 * **Scope of what reaches `persistEvent`.** The bus persists only the *durable* events; the streamed
 * `agent:*` / `cost:updated` events go through `#bus.emit` and never reach here (run-event-contract;
 * engine.ts). So the durable per-node cost source is `node:completed.cumulativeCostMicrocents` (a run-wide
 * running-total **snapshot**), not `cost:updated` — a `run_costs` row stores the *delta* of that snapshot,
 * so `sum(run_costs.cost_microcents) == runs.total_cost_microcents`. `run:started.workflowId` is a UUID,
 * never the slug (ADR-0022); the slug→UUID upsert is `resolveWorkflowId`.
 *
 * **Secrets.** The engine masks `secret`-typed inputs / tool I/O at the bus before this store sees an event
 * (ADR-0036, ADR-0006); the writer is **pass-through** — it persists the already-masked event verbatim and
 * never re-masks. The no-raw-secret invariant on the unsafe columns (`run_events.payload_json`, the
 * `step_executions` JSON, `run_costs`, `runs.workflow_definition_snapshot`) is the engine's guarantee,
 * verified end-to-end by the secrets fixture in this package's tests (database-schema.md §"Secrets at the
 * write boundary", [ADR-0050](../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)).
 *
 * At-rest encryption posture for `history.db` is per-surface: the CLI's file is unencrypted, guarded by
 * `0600`/`0700` OS permissions ([ADR-0050](../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)).
 * That is the host's open-path concern (`apps/cli/src/history`), not this store's.
 */

/** A run with a `run:started` but no terminal event — for startup crash reconciliation (core `InterruptedRun`). */
export interface InterruptedRunInfo {
  readonly runId: string;
  readonly workflowId: string;
  /** `true` when the run was suspended at a gate (resumable); `false` when it died mid-execution. */
  readonly resumable: boolean;
  /** The highest `sequenceNumber` already persisted for this run. */
  readonly lastSequenceNumber: number;
}

/** A run summary for `relavium list` / `status` (2.I) — row-derived, with ISO timestamps. */
export interface RunRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly status: RunStatus;
  readonly executionMode: ExecutionMode;
  // `string`, not a union: trigger_type carries NO strict CHECK (schema.ts) — webhook/schedule are Phase-2
  // values that may legitimately appear, so the read type stays open by design.
  readonly triggerType: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostMicrocents: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A per-node step row for `relavium status` (2.I) — row-derived, with ISO timestamps. */
export interface StepRecord {
  readonly nodeId: string;
  readonly nodeType: string;
  /** The persisted `step_executions.status` (the closed StepStatus set), reused from the inferred row type. */
  readonly status: StepExecutionRow['status'];
  readonly attemptNumber: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly costMicrocents: number;
}

/** The latest run for one workflow (joined by slug) — the `relavium list` last-run-status overlay. */
export interface WorkflowRunSummary {
  readonly slug: string;
  readonly lastRun: RunRecord;
}

/** The catalog identity + frozen graph of the workflow a store instance records (events don't carry the graph). */
export interface RunHistoryWorkflow {
  readonly slug: string;
  readonly name: string;
  /** `JSON.stringify(WorkflowDefinition)` — the frozen `runs.workflow_definition_snapshot` for replay/resume. */
  readonly definitionJson: string;
}

export interface RunHistoryStoreDeps {
  /** Row-PK source (the engine supplies run/node ids inside events, but DB row ids are the store's). */
  readonly uuid: () => string;
  /** epoch-ms clock — used only for the `workflows` catalog row, which `resolveWorkflowId` mints before any event. */
  readonly now: () => number;
  /** The single workflow this store records (one per `relavium run`); supplies the durable snapshot. */
  readonly workflow: RunHistoryWorkflow;
}

/**
 * The workflow-agnostic read API the `relavium list`/`logs`/`status`/`gate list` (2.I) commands consume.
 * Constructed from a db handle alone ({@link createRunHistoryReader}) — no `deps.workflow`, since the reads
 * span every workflow (the same standalone-read rationale as {@link loadRunSnapshot}, which the
 * workflow-scoped {@link createRunHistoryStore} can't satisfy for a cross-workflow listing).
 * {@link RunHistoryStore} re-exposes the first three (the writer also reads back its own event log).
 */
export interface RunHistoryReader {
  /** All runs (newest first), excluding soft-deleted. */
  listRuns: () => RunRecord[];
  /** One run by id (soft-deleted excluded), or `undefined` — the existence check `logs`/`status`/`gate list` gate on. */
  loadRun: (runId: string) => RunRecord | undefined;
  /** A run's full event log in `seq` order — for `relavium logs` and the 2.G resume reconstruct. Keyed by
   *  `runId` alone (no soft-delete re-check); the caller validates existence/deletion via {@link loadRun} first. */
  loadRunEvents: (runId: string) => RunEvent[];
  /** Non-terminal runs (pending/running/paused), newest first — `relavium status` + `gate list` (all-runs). */
  listActiveRuns: () => RunRecord[];
  /** The latest run per workflow (joined by slug) — `relavium list`'s last-run-status overlay. */
  loadLatestRunPerWorkflow: () => WorkflowRunSummary[];
  /** A run's per-node step rows in execution order — `relavium status`'s per-node detail. Keyed by `runId`
   *  alone; the caller validates the run via {@link loadRun} first (the active-run list is already filtered). */
  loadStepExecutions: (runId: string) => StepRecord[];
}

/**
 * The durable run-history store. The first three methods are the engine's `RunStore` port (async to match
 * the seam, synchronous under `better-sqlite3`); it also re-exposes the {@link RunHistoryReader} reads it
 * shares (the 2.G resume reconstruct reads back this store's own log).
 */
export interface RunHistoryStore extends Pick<
  RunHistoryReader,
  'listRuns' | 'loadRun' | 'loadRunEvents'
> {
  resolveWorkflowId: (slug: string) => Promise<string>;
  persistEvent: (event: RunEvent) => Promise<void>;
  listInterruptedRuns: () => Promise<readonly InterruptedRunInfo[]>;
}

const NON_TERMINAL_STATUSES = ['pending', 'running', 'paused'] as const;

function fromRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    workflowId: row.workflowId,
    status: row.status,
    executionMode: row.executionMode,
    triggerType: row.triggerType,
    ...(row.startedAt === null ? {} : { startedAt: epochMsToIso(row.startedAt) }),
    ...(row.completedAt === null ? {} : { completedAt: epochMsToIso(row.completedAt) }),
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCostMicrocents: row.totalCostMicrocents,
    createdAt: epochMsToIso(row.createdAt),
    updatedAt: epochMsToIso(row.updatedAt),
  };
}

/** Wire a {@link RunHistoryStore} over a `@relavium/db` connection. */
export function createRunHistoryStore(db: Db, deps: RunHistoryStoreDeps): RunHistoryStore {
  // The store's own read methods are the workflow-agnostic reader's — one implementation per query, and the
  // 2.I read commands reach the same SQL without this store's workflow scope (createRunHistoryReader).
  const reader = createRunHistoryReader(db);

  /** The run-wide cumulative cost already persisted on `runs` — the baseline a node-cost delta subtracts from. */
  const currentRunCost = (runId: string): number =>
    db.select({ c: runs.totalCostMicrocents }).from(runs).where(eq(runs.id, runId)).get()?.c ?? 0;

  /** Apply an event's derived `runs`/`step_executions`/`run_costs` writes (`run:started` inserts the runs row). */
  const applyDerived = (event: RunEvent, runId: string, ts: number): void => {
    switch (event.type) {
      case 'run:started': {
        const row: NewRunRow = {
          id: runId,
          workflowId: event.workflowId,
          workflowDefinitionSnapshot: deps.workflow.definitionJson,
          status: 'running',
          executionMode: event.executionMode,
          triggerType: 'manual',
          inputJson: JSON.stringify(event.inputs),
          startedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        };
        db.insert(runs).values(row).run();
        return;
      }
      case 'node:started': {
        const row: NewStepExecutionRow = {
          id: deps.uuid(),
          runId,
          nodeId: event.nodeId,
          nodeType: event.nodeType,
          attemptNumber: event.attemptNumber ?? 1,
          status: 'running',
          startedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        };
        db.insert(stepExecutions).values(row).run();
        return;
      }
      case 'node:completed': {
        // Per-node cost = the delta of the run-wide cumulative snapshot since the last boundary. The
        // run-level SUM is exact (the deltas telescope to the final cumulative; events arrive serially in
        // sequenceNumber order even for parallel branches). The per-node ATTRIBUTION is approximate under a
        // fan-out: a sibling that accrued cost before this node:completed inflates this delta and shrinks the
        // sibling's — so `relavium status`/`logs` per-node cost is exact only for serial execution. Absent
        // cumulative (backward-compat for pre-field logs) ⇒ delta 0; `Math.max(0, …)` guards a non-monotonic
        // cumulative (a deeper engine bug).
        const prev = currentRunCost(runId);
        const cumulative = event.cumulativeCostMicrocents ?? prev;
        const nodeCost = Math.max(0, cumulative - prev);
        db.insert(runCosts)
          .values({
            id: deps.uuid(),
            runId,
            nodeId: event.nodeId,
            inputTokens: event.tokensUsed.input,
            outputTokens: event.tokensUsed.output,
            costMicrocents: nodeCost,
            createdAt: ts,
          } satisfies NewRunCostRow)
          .run();
        db.update(stepExecutions)
          .set({
            status: 'completed',
            outputJson: JSON.stringify(event.output),
            inputTokens: event.tokensUsed.input,
            outputTokens: event.tokensUsed.output,
            costMicrocents: nodeCost,
            durationMs: event.durationMs,
            completedAt: ts,
            updatedAt: ts,
          })
          .where(stepMatch(runId, event.nodeId, event.attemptNumber))
          .run();
        db.update(runs)
          .set({
            totalInputTokens: sql`${runs.totalInputTokens} + ${event.tokensUsed.input}`,
            totalOutputTokens: sql`${runs.totalOutputTokens} + ${event.tokensUsed.output}`,
            // `prev + nodeCost` (= max(prev, cumulative)), NOT the raw `cumulative` — so the run total stays
            // monotonic + always equals sum(run_costs) even if a snapshot regressed (a deeper engine bug).
            totalCostMicrocents: prev + nodeCost,
            updatedAt: ts,
          })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      case 'node:failed':
      case 'node:retrying': {
        // Mark the attempt's step row `failed`. For `node:failed` this is the node's TERMINAL failure
        // (node-retry budget exhausted); for `node:retrying` it is the intermediate attempt that will
        // re-dispatch as a fresh row on the next `node:started`. Either way the attempt's row must not
        // linger as `running` (a ghost in `relavium status`, 2.I). Both carry `error` + `attemptNumber`.
        db.update(stepExecutions)
          .set({
            status: 'failed',
            errorJson: JSON.stringify(event.error),
            completedAt: ts,
            updatedAt: ts,
          })
          .where(stepMatch(runId, event.nodeId, event.attemptNumber))
          .run();
        return;
      }
      case 'human_gate:paused':
      case 'budget:paused':
      case 'run:paused': {
        db.update(runs).set({ status: 'paused', updatedAt: ts }).where(eq(runs.id, runId)).run();
        return;
      }
      case 'human_gate:resumed': {
        db.update(runs).set({ status: 'running', updatedAt: ts }).where(eq(runs.id, runId)).run();
        return;
      }
      case 'run:completed': {
        db.update(runs)
          .set({
            status: 'completed',
            outputJson: JSON.stringify(event.outputs),
            totalInputTokens: event.totalTokensUsed.input,
            totalOutputTokens: event.totalTokensUsed.output,
            totalCostMicrocents: event.totalCostMicrocents,
            completedAt: ts,
            updatedAt: ts,
          })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      case 'run:failed': {
        // Known limitation: run:failed / run:cancelled carry no total-cost field in the run-event schema,
        // and the failing node's cost is unrecoverable here (node:failed has no cost; cost:updated is not
        // persisted). So a failed run's runs.total_cost_microcents is the last node:completed cumulative —
        // it may undercount spend incurred after it. `sum(run_costs) == total` still holds (both undercount).
        // A true failed-run total needs a shared-schema change (a total on run:failed) — out of 2.H scope.
        db.update(runs)
          .set({
            status: 'failed',
            errorJson: JSON.stringify(event.error),
            outputJson: JSON.stringify(event.partialOutputs),
            completedAt: ts,
            updatedAt: ts,
          })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      case 'run:cancelled': {
        db.update(runs)
          .set({ status: 'cancelled', completedAt: ts, updatedAt: ts })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      default:
        // node:skipped / media_job:submitted / run:timeout (+ any future durable event): captured in
        // run_events below; no derived runs/step/cost write in 2.H's scope. (A skipped node has no nodeType
        // on its event, so it gets no step_executions row — the run_events log records the skip.)
        return;
    }
  };

  /**
   * Persist one event: derived writes FIRST, then the `run_events` append — so `run:started`'s `runs` row
   * (the FK target of `run_events.run_id`) exists before its event row. The whole pair is one transaction
   * (the caller wraps it), so a crash never leaves a derived row without its event, or vice-versa.
   */
  const fold = (event: RunEvent, runId: string, ts: number): void => {
    applyDerived(event, runId, ts);
    const eventRow: NewRunEventRow = {
      id: deps.uuid(),
      runId,
      seq: event.sequenceNumber,
      eventType: event.type,
      nodeId: 'nodeId' in event ? event.nodeId : null,
      // The full canonical RunEvent (lossless); the seq/eventType/nodeId/ts columns are denormalized projections.
      payloadJson: JSON.stringify(event),
      ts,
    };
    db.insert(runEvents).values(eventRow).run();
  };

  return {
    resolveWorkflowId: (slug) => {
      const find = (): string | undefined =>
        db
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.slug, slug), isNull(workflows.deletedAt)))
          .get()?.id;
      const existing = find();
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      // Insert-or-ignore, then read back the winning id. Atomic against a concurrent `relavium run` on the
      // same slug: a plain SELECT-then-INSERT could let two processes both read empty and both insert, with
      // the second hitting the active-slug UNIQUE index — ON CONFLICT DO NOTHING makes the loser a no-op.
      const id = deps.uuid();
      const t = deps.now();
      db.insert(workflows)
        .values({
          id,
          name: deps.workflow.name,
          slug,
          definition: deps.workflow.definitionJson,
          createdAt: t,
          updatedAt: t,
        })
        .onConflictDoNothing()
        .run();
      return Promise.resolve(find() ?? id);
    },

    persistEvent: (event) => {
      // Synchronous (better-sqlite3) but Promise-returning to honor the async RunStore port — a fault (bad
      // event, UNIQUE(run_id, seq), FK, disk) becomes a REJECTED promise, never a synchronous throw, so the
      // engine's `await persistEvent(...)` (durability-first: ADR-0050 fatal posture) and any `.catch` see it.
      try {
        const parsed = RunEventSchema.parse(event); // validate on the way in (round-trip + envelope)
        const runId = parsed.runId;
        if (runId === undefined) {
          // The bus never routes a session-only event to the run store (ADR-0036); fail loud if it ever does.
          throw new Error(`run-history store received a non-run event: ${parsed.type}`);
        }
        const ts = isoToEpochMs(parsed.timestamp);
        // One transaction per event: the run_events append and its derived rows land atomically, so a crash
        // can never leave a derived row without its event (or vice-versa).
        db.transaction(() => {
          fold(parsed, runId, ts);
        });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },

    listInterruptedRuns: () => {
      // One pass: a LEFT JOIN + coalesce(max(seq),0), grouped by the run PK. No second round-trip and no
      // `inArray(ids)` (which would hit SQLite's host-parameter limit when many runs are interrupted) — this
      // is a RunStore port method the desktop/cloud surfaces also implement, so it must scale.
      const rows = db
        .select({
          id: runs.id,
          workflowId: runs.workflowId,
          status: runs.status,
          lastSeq: sql<number>`coalesce(max(${runEvents.seq}), 0)`,
        })
        .from(runs)
        .leftJoin(runEvents, eq(runEvents.runId, runs.id))
        .where(and(inArray(runs.status, [...NON_TERMINAL_STATUSES]), isNull(runs.deletedAt)))
        .groupBy(runs.id)
        .all();
      return Promise.resolve(
        rows.map(
          (row): InterruptedRunInfo => ({
            runId: row.id,
            workflowId: row.workflowId,
            resumable: row.status === 'paused',
            lastSequenceNumber: row.lastSeq,
          }),
        ),
      );
    },

    listRuns: reader.listRuns,
    loadRun: reader.loadRun,
    loadRunEvents: reader.loadRunEvents,
  };
}

/**
 * Wire a workflow-agnostic {@link RunHistoryReader} over a `@relavium/db` connection — the read backend for
 * `relavium list`/`logs`/`status`/`gate list` (2.I). It needs no `deps.workflow` ({@link createRunHistoryStore}
 * is workflow-scoped at construction, which a cross-workflow listing can't satisfy), so a read command opens it
 * from a plain db handle (mirroring the standalone {@link loadRunSnapshot}). All methods are synchronous
 * (better-sqlite3) and validate at the row↔domain boundary, like the writer mappers above.
 */
export function createRunHistoryReader(db: Db): RunHistoryReader {
  return {
    listRuns: () =>
      db
        .select()
        .from(runs)
        .where(isNull(runs.deletedAt))
        // `id` is a stable secondary key so the order never flips between reads for same-createdAt runs
        // (same tiebreak as loadLatestRunPerWorkflow) — keeps `status`/`list` output deterministic.
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .all()
        .map(fromRunRow),

    loadRun: (runId) => {
      // Excludes soft-deleted runs, matching listRuns/listActiveRuns — a run hidden from `relavium list`
      // must also read as not-found via logs/status/gate-list (and not be resumable, see loadRunSnapshot).
      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
        .get();
      return row === undefined ? undefined : fromRunRow(row);
    },

    loadRunEvents: (runId) =>
      db
        .select({ payloadJson: runEvents.payloadJson })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(asc(runEvents.seq))
        .all()
        .map((r) => RunEventSchema.parse(JSON.parse(r.payloadJson))),

    listActiveRuns: () =>
      db
        .select()
        .from(runs)
        .where(and(inArray(runs.status, [...NON_TERMINAL_STATUSES]), isNull(runs.deletedAt)))
        .orderBy(desc(runs.createdAt), desc(runs.id)) // stable secondary key — see listRuns
        .all()
        .map(fromRunRow),

    loadLatestRunPerWorkflow: () => {
      // SQLite has no DISTINCT ON, so rank runs within each workflow and keep rn = 1 — the latest run per
      // workflow (newest createdAt; id as a deterministic tiebreak). The slug innerJoin lets `relavium list`
      // overlay last-run status onto its disk-discovered catalog (events carry a UUID workflowId, not the slug).
      const ranked = db.$with('ranked').as(
        db
          .select({
            ...getTableColumns(runs),
            slug: workflows.slug,
            rn: sql<number>`row_number() over (partition by ${runs.workflowId} order by ${runs.createdAt} desc, ${runs.id} desc)`.as(
              'rn',
            ),
          })
          .from(runs)
          .innerJoin(workflows, eq(runs.workflowId, workflows.id))
          .where(and(isNull(runs.deletedAt), isNull(workflows.deletedAt))),
      );
      return db
        .with(ranked)
        .select()
        .from(ranked)
        .where(eq(ranked.rn, 1))
        .all()
        .map((row): WorkflowRunSummary => ({ slug: row.slug, lastRun: fromRunRow(row) }));
    },

    loadStepExecutions: (runId) =>
      db
        .select({
          nodeId: stepExecutions.nodeId,
          nodeType: stepExecutions.nodeType,
          status: stepExecutions.status,
          attemptNumber: stepExecutions.attemptNumber,
          startedAt: stepExecutions.startedAt,
          completedAt: stepExecutions.completedAt,
          durationMs: stepExecutions.durationMs,
          costMicrocents: stepExecutions.costMicrocents,
        })
        .from(stepExecutions)
        .where(eq(stepExecutions.runId, runId))
        // createdAt is the execution-order key; `rowid` (insertion order = persist/seq order) is the
        // deterministic tiebreak for same-millisecond steps, so the per-node order never depends on the
        // engine clock resolution or a future index over createdAt.
        .orderBy(asc(stepExecutions.createdAt), asc(sql`rowid`))
        .all()
        .map(
          (r): StepRecord => ({
            nodeId: r.nodeId,
            nodeType: r.nodeType,
            status: r.status,
            attemptNumber: r.attemptNumber,
            ...(r.startedAt === null ? {} : { startedAt: epochMsToIso(r.startedAt) }),
            ...(r.completedAt === null ? {} : { completedAt: epochMsToIso(r.completedAt) }),
            ...(r.durationMs === null ? {} : { durationMs: r.durationMs }),
            costMicrocents: r.costMicrocents,
          }),
        ),
  };
}

/** Match the `step_executions` row for a node attempt (the node-retry dispatch index; absent ⇒ 1). */
function stepMatch(runId: string, nodeId: string, attemptNumber: number | undefined) {
  return and(
    eq(stepExecutions.runId, runId),
    eq(stepExecutions.nodeId, nodeId),
    eq(stepExecutions.attemptNumber, attemptNumber ?? 1),
  );
}

/** A paused run's frozen workflow snapshot + inputs, read by id (just the bits a cross-process resume rebuilds from). */
export interface RunResumeSnapshot {
  /** `JSON.stringify(WorkflowDefinition)` — the frozen `runs.workflow_definition_snapshot` (the events don't
   * carry the graph). The caller re-validates it with the shared `WorkflowSchema` before resuming. */
  readonly workflowDefinitionSnapshot: string;
  /** `JSON.stringify(inputs)` from `run:started` (`runs.input_json`) — restored on resume so a post-gate node
   * that reads `{{ inputs.x }}` sees the value the run started with (the events don't replay the inputs). */
  readonly inputJson: string;
}

/**
 * Read one run's frozen `workflow_definition_snapshot` + `input_json` by id — the substrate `relavium gate`
 * (2.G) needs to rebuild the `WorkflowDefinition` + inputs for a cross-process `resumeFromCheckpoint` **before**
 * it knows which workflow the paused run used. Standalone (a plain `runs`-row read) rather than a
 * {@link RunHistoryStore} method, because the store is workflow-scoped at construction (`deps.workflow`) and
 * the gate command only learns the workflow *from* this snapshot — a chicken-and-egg the standalone read
 * resolves. (Run *status* is not returned — the gate command uses the authoritative `checkpoint.runStatus`
 * folded fresh from the event log, and `loadRun(runId).status` covers any status-by-id need.) Returns
 * `undefined` for an unknown OR soft-deleted `runId` (matching `loadRun` — a soft-deleted run is not
 * resumable). The snapshot/inputs are unsafe-column data (no raw secrets — the engine masks at the write
 * boundary, ADR-0050); this read is pass-through and never logs them.
 */
export function loadRunSnapshot(db: Db, runId: string): RunResumeSnapshot | undefined {
  const row = db
    .select({
      snapshot: runs.workflowDefinitionSnapshot,
      inputJson: runs.inputJson,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .get();
  return row === undefined
    ? undefined
    : {
        workflowDefinitionSnapshot: row.snapshot,
        inputJson: row.inputJson,
      };
}
