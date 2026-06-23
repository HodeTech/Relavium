import { RunEventSchema, type RunEvent, type RunStatus } from '@relavium/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

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
  readonly executionMode: string;
  readonly triggerType: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostMicrocents: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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
 * The durable run-history store. The first three methods are the engine's `RunStore` port (async to match
 * the seam, synchronous under `better-sqlite3`); the rest are the 2.I/2.G read API.
 */
export interface RunHistoryStore {
  resolveWorkflowId: (slug: string) => Promise<string>;
  persistEvent: (event: RunEvent) => Promise<void>;
  listInterruptedRuns: () => Promise<readonly InterruptedRunInfo[]>;
  /** All runs (newest first), excluding soft-deleted — for `relavium list`. */
  listRuns: () => RunRecord[];
  /** One run by id, or `undefined` — for `relavium status`. */
  loadRun: (runId: string) => RunRecord | undefined;
  /** A run's full event log in `seq` order — for `relavium logs` and the 2.G resume reconstruct. */
  loadRunEvents: (runId: string) => RunEvent[];
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
            totalCostMicrocents: cumulative,
            updatedAt: ts,
          })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      case 'node:failed': {
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
      case 'node:retrying': {
        // The attempt that just failed gets a terminal `failed` status; the next `node:started(attempt+1)`
        // inserts a fresh row. Without this, the intermediate attempt's row would linger as `running` forever
        // and surface as a ghost step in `relavium status` (2.I). The terminal `node:failed` (budget
        // exhausted) closes the LAST attempt's row via the same `stepMatch`.
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
      const existing = db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.slug, slug), isNull(workflows.deletedAt)))
        .get();
      if (existing !== undefined) {
        return Promise.resolve(existing.id);
      }
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
        .run();
      return Promise.resolve(id);
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
      const rows = db
        .select()
        .from(runs)
        .where(and(inArray(runs.status, [...NON_TERMINAL_STATUSES]), isNull(runs.deletedAt)))
        .all();
      if (rows.length === 0) {
        return Promise.resolve([]);
      }
      // One aggregating query for the per-run last seq (a single GROUP BY, not N+1) — this is a RunStore
      // port method the desktop/cloud surfaces also implement, so it must scale past a single-user CLI.
      const lastByRun = new Map(
        db
          .select({ runId: runEvents.runId, m: sql<number>`max(${runEvents.seq})` })
          .from(runEvents)
          .where(
            inArray(
              runEvents.runId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(runEvents.runId)
          .all()
          .map((r) => [r.runId, r.m]),
      );
      const interrupted = rows.map(
        (row): InterruptedRunInfo => ({
          runId: row.id,
          workflowId: row.workflowId,
          resumable: row.status === 'paused',
          lastSequenceNumber: lastByRun.get(row.id) ?? 0,
        }),
      );
      return Promise.resolve(interrupted);
    },

    listRuns: () =>
      db
        .select()
        .from(runs)
        .where(isNull(runs.deletedAt))
        .orderBy(desc(runs.createdAt))
        .all()
        .map(fromRunRow),

    loadRun: (runId) => {
      const row = db.select().from(runs).where(eq(runs.id, runId)).get();
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
