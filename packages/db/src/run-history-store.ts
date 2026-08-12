import {
  AppendConflictError,
  LeaseFencedError,
  parseStoredRunEvent,
  RunEventSchema,
  type DurableWriteContext,
  type ExecutionMode,
  type RunEvent,
  type RunLeasePort,
  type RunStatus,
} from '@relavium/shared';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import type { Db, TxDb } from './client.js';
import { withBusyRetry, withBusyRetryAsync } from './retry.js';
import {
  runCosts,
  runEvents,
  runLeases,
  runs,
  stepExecutions,
  workflows,
  type NewRunCostRow,
  type NewRunEventRow,
  type NewRunLeaseRow,
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

/**
 * Adapt the store's SYNCHRONOUS lease operations to the engine's async `RunLeasePort` (ADR-0079).
 *
 * The store is synchronous because `better-sqlite3` is; the port is `Promise`-typed because the seam has to
 * admit a genuinely async store (the Phase-2 cloud one). Wrapping here rather than making the store async
 * keeps the two shapes honest: nothing in this file pretends to await.
 */
export function createRunLeasePort(store: RunHistoryStore): RunLeasePort {
  return {
    acquire: (runId, ownerId, ttlMs) => {
      const lease = store.leases.acquire(runId, ownerId, ttlMs);
      return Promise.resolve(
        lease === undefined ? undefined : { ownerId: lease.ownerId, generation: lease.generation },
      );
    },
    heartbeat: (runId, fence, ttlMs) =>
      Promise.resolve(store.leases.heartbeat(runId, fence.ownerId, fence.generation, ttlMs)),
    release: (runId, fence) => {
      store.leases.release(runId, fence.ownerId, fence.generation);
      return Promise.resolve();
    },
    read: (runId) => {
      const lease = store.leases.read(runId);
      return Promise.resolve(
        lease === undefined
          ? undefined
          : {
              runId: lease.runId,
              ownerId: lease.ownerId,
              generation: lease.generation,
              expiresAt: lease.expiresAt,
              live: lease.live,
            },
      );
    },
  };
}

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
  /** The run's project root (the cwd `relavium run` was invoked in), persisted to `runs.project_root` at
   *  run-start so a cross-process `relavium gate` resume can re-jail `save_to` under the ORIGINAL run's root
   *  rather than the resumer's cwd. Absent (tests / the in-memory path) ⇒ NULL. */
  readonly projectRoot?: string;
}

/**
 * A stored row this binary could not interpret because a NEWER one wrote it (ADR-0074 §5).
 *
 * Both fields come from the denormalized `run_events` COLUMNS, never from the payload: `seq` is the value the
 * `UNIQUE(run_id, seq)` index actually enforces (so it is the number a resumed run must not collide with), and
 * `event_type` is the row's own label. Parsing the payload to recover them would mean trusting the very blob we
 * just failed to read.
 */
export interface SkippedRunEvent {
  readonly sequenceNumber: number;
  readonly type: string;
}

/** A run's event log together with what reading it had to leave out. See {@link RunHistoryReader.loadRunEventLog}. */
export interface RunEventLog {
  readonly events: RunEvent[];
  readonly skipped: readonly SkippedRunEvent[];
}

/**
 * A stored `run_events` row that is damaged — not merely written by a newer binary.
 *
 * Both failure shapes land here: unreadable JSON in `payload_json`, and a `type` this binary DOES know whose body
 * does not parse. ADR-0050's durability-first posture says neither may be swallowed, and
 * [error-handling.md](../../../docs/standards/error-handling.md) says the error that surfaces must be typed and
 * carry structured context. Without this, a single bad row out of thousands reached the user as
 * `An unexpected internal error occurred.` — no run, no row, no next step.
 */
export class CorruptRunEventError extends Error {
  override readonly name = 'CorruptRunEventError';
  readonly code = 'corrupt_run_event' as const;

  constructor(
    readonly runId: string,
    readonly sequenceNumber: number,
    /**
     * The row's `event_type` column. Our own writes put a union literal here, but the column carries no CHECK
     * (`schema.ts`), so a hand-edited DB could hold arbitrary text — hence the length bound in the message below.
     * Terminal/bidi control bytes are stripped one layer up, where every user-facing error passes through
     * `sanitizeInline` (`apps/cli/src/process/render-error.ts`); this field is not a second sanitization seam.
     */
    readonly eventType: string,
    cause: unknown,
  ) {
    const shownType = eventType.length > 64 ? `${eventType.slice(0, 64)}…` : eventType;
    super(
      `run ${runId} has a damaged event row at seq ${sequenceNumber} (type ${shownType})`,
      // Preserved so `--verbose` can still show the underlying ZodError/SyntaxError detail.
      { cause },
    );
  }
}

/**
 * Narrow an unknown thrown value to {@link CorruptRunEventError} by its `code`, not by `instanceof`.
 *
 * The CLI bundles `@relavium/db` into one file while its tests import the package directly, so two realizations of
 * the class can coexist and `instanceof` would silently answer `false` at exactly the boundary that has to catch it.
 * Cast-free narrowing (the same shape `content.ts` uses).
 */
export function isCorruptRunEventError(value: unknown): value is CorruptRunEventError {
  return value instanceof Error && 'code' in value && value.code === 'corrupt_run_event';
}

/**
 * A run whose event log cannot be fully read by THIS binary, refused because the caller is a REPLAY
 * ([ADR-0075](../../../docs/decisions/0075-fail-closed-resume-on-an-unreadable-event-log.md)).
 *
 * ADR-0074 §5's tolerant read drops a row whose `type` a newer binary wrote, which is right for a display and
 * wrong for a resume: `checkpointer.ts` builds resumable state from what the read returns, and an older binary
 * cannot know whether the dropped row was a node terminal, a job submission, a gate decision or a cost
 * commitment — so it may re-run completed work or re-submit an already-billed media job.
 *
 * Distinct from {@link CorruptRunEventError}: that one means the DATA is damaged and upgrading will not help;
 * this one means the data is fine and this binary is too old, so the remedy is real and the user can perform it.
 */
export class UnreadableRunEventLogError extends Error {
  override readonly name = 'UnreadableRunEventLogError';
  readonly code = 'unreadable_run_event_log' as const;

  constructor(
    readonly runId: string,
    /** The skipped rows' authoritative `seq` values, ascending — the lead a support conversation needs. */
    readonly skippedSequenceNumbers: readonly number[],
  ) {
    const count = skippedSequenceNumbers.length;
    // BOUNDED, like `logs.ts`'s note: the count is the signal, the first few numbers are the lead. A run
    // replayed under a much newer binary could skip thousands, and one unbounded integer list is not a
    // diagnostic. The row TYPES are deliberately not named — this binary does not know what they are.
    const shown = skippedSequenceNumbers.slice(0, MAX_REPORTED_UNREADABLE_SEQS);
    const seqs = count > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
    super(
      `run ${runId} contains ${count} event${count === 1 ? '' : 's'} written by a newer version of ` +
        `Relavium (seq ${seqs}); it cannot be resumed by this one. Upgrade to resume it.`,
    );
  }
}

/** How many skipped `seq` values {@link UnreadableRunEventLogError} names before it elides. */
const MAX_REPORTED_UNREADABLE_SEQS = 8;

/**
 * Narrow an unknown thrown value to {@link UnreadableRunEventLogError} by its `code`, not by `instanceof` —
 * same bundling reason as {@link isCorruptRunEventError}.
 */
export function isUnreadableRunEventLogError(value: unknown): value is UnreadableRunEventLogError {
  return value instanceof Error && 'code' in value && value.code === 'unreadable_run_event_log';
}

/**
 * The workflow-agnostic read API the `relavium list`/`logs`/`status`/`gate list` (2.I) commands consume.
 * Constructed from a db handle alone ({@link createRunHistoryReader}) — no `deps.workflow`, since the reads
 * span every workflow (the same standalone-read rationale as {@link loadRunSnapshot}, which the
 * workflow-scoped {@link createRunHistoryStore} can't satisfy for a cross-workflow listing).
 * {@link RunHistoryStore} re-exposes the read members listed in its own `Pick` (the writer also reads back its own event log).
 */
export interface RunHistoryReader {
  /**
   * Runs newest-first (`created_at DESC, id DESC`), excluding soft-deleted. Pass `{ limit }` for an indexed
   * top-N (the 2.5.B Home "recent runs" strip) and/or `{ status }` to filter (e.g. the Home "attention"
   * section's recent `failed` runs). The recency order is served straight off `idx_runs_created` (no filesort).
   * A `{ status }` filter is served off `idx_runs_status` for the equality + the `created_at DESC` order; the
   * `id DESC` tiebreak is that index's missing last term, so it *may* incur a small bounded `TEMP B-TREE` — but
   * only when rows tie on `created_at` at the `LIMIT` boundary (rare for epoch-ms timestamps), and acceptable
   * regardless because the only `status` caller is the bounded Home failed strip (`LIMIT 8`). A `limit <= 0` reads as
   * unbounded (the codebase's `≤0 ⇒ no cap` convention). Omit the opts for the full list (`relavium list`).
   */
  listRuns: (opts?: { readonly limit?: number; readonly status?: RunStatus }) => RunRecord[];
  /** One run by id (soft-deleted excluded), or `undefined` — the existence check `logs`/`status`/`gate list` gate on. */
  loadRun: (runId: string) => RunRecord | undefined;
  /** A run's full event log in `seq` order — for `relavium logs` and the 2.G resume reconstruct. Keyed by
   *  `runId` alone (no soft-delete re-check); the caller validates existence/deletion via {@link loadRun} first.
   *
   *  Rows a NEWER binary wrote are dropped (ADR-0074 §5), so this array can be SHORTER than the stored log. Any
   *  caller that cares about that — because it counts events, or derives a sequence high-water mark — must use
   *  {@link loadRunEventLog} instead and account for the skipped rows. */
  loadRunEvents: (runId: string) => RunEvent[];
  /**
   * {@link loadRunEvents} plus the identity of every row it had to drop (ADR-0074 §5).
   *
   * Two callers genuinely need this, and both break subtly without it:
   *
   * - **Resume** seeds the post-resume sequence counter from the fold's `lastSequenceNumber`. If the dropped row
   *   is the log's TAIL, a fold over `events` alone yields a high-water mark BELOW what is stored, the resumed run
   *   re-uses a taken `seq`, and `UNIQUE(run_id, seq)` fails the write — turning a run that merely needed a newer
   *   binary into a terminally failed one. `skipped` carries the authoritative `seq` column so the mark stays true.
   * - **`relavium logs`** prints an event count and a `[seq]` column. Silently short output over a healthy DB reads
   *   as data loss, and `sse-event-schema.md` §Transport tells consumers to diagnose gaps from `sequenceNumber`.
   */
  loadRunEventLog: (runId: string) => RunEventLog;
  /**
   * The log for a REPLAY — the same read, refusing when anything had to be skipped (ADR-0075).
   *
   * Use this, never {@link loadRunEvents} / {@link loadRunEventLog}, from any caller that reconstructs state
   * in order to DO something (resume, re-attach a job, re-ask a gate). The tolerant reads are for surfaces
   * that DISPLAY a log; tolerating a hole in a fold that decides what work still has to happen is how a resume
   * silently re-runs completed work.
   *
   * @throws {UnreadableRunEventLogError} when any row was written by a newer binary.
   * @throws {CorruptRunEventError} when a row is damaged (unchanged from the tolerant reads).
   */
  loadRunEventLogForReplay: (runId: string) => RunEvent[];
  /** A run's STATE-BEARING events in `seq` order — the full log MINUS the per-token/tool streaming firehose
   *  (`agent:token` / `agent:tool_call` / `agent:tool_result`), which neither checkpoint reconstruction nor gate
   *  detection consults. For a bounded gate/checkpoint fold over a long run (the Home strip) that must NOT pay to
   *  parse the whole firehose. NOT for `logs`/resume, which need every event. */
  loadRunStateEvents: (runId: string) => RunEvent[];
  /** Non-terminal runs (pending/running/paused), newest first — `relavium status` + `gate list` (all-runs). */
  listActiveRuns: () => RunRecord[];
  /** The latest run per workflow (joined by slug) — `relavium list`'s last-run-status overlay. */
  loadLatestRunPerWorkflow: () => WorkflowRunSummary[];
  /** A run's per-node step rows in execution order — `relavium status`'s per-node detail. Keyed by `runId`
   *  alone; the caller validates the run via {@link loadRun} first (the active-run list is already filtered). */
  loadStepExecutions: (runId: string) => StepRecord[];
  /** Map each given workflow id → its slug, for labeling run rows in the 2.5.B Home (a `RunRecord` carries only
   *  the workflow UUID). Soft-deleted workflows are excluded; bounded by the id set — an indexed primary-key
   *  `id IN (...)` lookup, never a scan. An empty input returns an empty map without touching the db. */
  loadWorkflowSlugs: (ids: readonly string[]) => Map<string, string>;
}

/**
 * The durable run-history store. The first three methods are the engine's `RunStore` port (async to match
 * the seam, synchronous under `better-sqlite3`); it also re-exposes the {@link RunHistoryReader} reads it
 * shares (the 2.G resume reconstruct reads back this store's own log).
 */
export interface RunHistoryStore extends Pick<
  RunHistoryReader,
  'listRuns' | 'loadRun' | 'loadRunEvents' | 'loadRunEventLog' | 'loadRunEventLogForReplay'
> {
  resolveWorkflowId: (slug: string) => Promise<string>;
  /** Structurally the core `RunStore.persistEvent`; `ctx` carries ADR-0078 §2's compare-and-append guard. */
  persistEvent: (event: RunEvent, ctx?: DurableWriteContext) => Promise<void>;
  listInterruptedRuns: () => Promise<readonly InterruptedRunInfo[]>;
  /** Cross-process run ownership (ADR-0079). Structurally the core `RunLeasePort`. */
  readonly leases: RunLeaseStore;
}

/**
 * The run-lease operations (ADR-0079 §1, §6). Every one evaluates expiry against the store's OWN injected
 * epoch-ms clock, never a caller-supplied time — so every process on the machine compares against one clock
 * and a caller cannot widen its own lease by lying about `now`.
 */
export interface RunLeaseStore {
  /**
   * Take or renew ownership of `runId`, returning the fence to carry on every durable write.
   *
   * Succeeds when there is no lease, when the existing one has EXPIRED, or when `ownerId` already holds it
   * (a re-acquire by the same process is a renewal, not a takeover). Fails — returns `undefined` — when a
   * DIFFERENT owner holds a live lease. Every success bumps `generation`, including a takeover, which is
   * what fences the previous owner out.
   */
  acquire: (runId: string, ownerId: string, ttlMs: number) => RunLease | undefined;
  /**
   * Push the expiry forward for a lease this owner still holds at this generation. Returns `false` when the
   * lease has been taken over — which is how a heartbeat discovers it lost, without a second query.
   */
  heartbeat: (runId: string, ownerId: string, generation: number, ttlMs: number) => boolean;
  /** Drop a lease this owner holds. A no-op when someone else has taken it — never steals it back. */
  release: (runId: string, ownerId: string, generation: number) => void;
  /** The current lease and whether it is live, for `reconcile()`'s skip and for diagnosis. */
  read: (runId: string) => RunLeaseState | undefined;
}

/** The fence a caller carries after a successful acquire. */
export interface RunLease {
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly expiresAt: number;
}

/** A lease as READ, with the store's own verdict on whether it is still live. */
export interface RunLeaseState extends RunLease {
  /** Evaluated against the store's injected clock at read time — never re-derived by the caller. */
  readonly live: boolean;
}

const NON_TERMINAL_STATUSES = ['pending', 'running', 'paused'] as const;

/** The per-token/tool streaming firehose — the highest-volume events, which checkpoint reconstruction and gate
 *  detection ignore. {@link RunHistoryReader.loadRunStateEvents} excludes these so a bounded fold over a long run
 *  does not pay to parse them. (Matches `runEvents.eventType`, which stores `event.type`.) `agent:reasoning`
 *  (EA6, 2.5.H) is a streamed firehose event of the same class; it is never persisted (streamed `agent:*` events
 *  go through the bus, not `persistEvent`), so it is listed here for defensive consistency, not effect. */
const STREAMING_EVENT_TYPES = [
  'agent:token',
  'agent:reasoning',
  'agent:tool_call',
  'agent:tool_result',
];

/**
 * The `run_costs.node_id` used for a RUN-level cost addend — the residual a `run:failed` / `run:cancelled`
 * terminal carries (#W15-6).
 *
 * The empty string, deliberately. That money is real (a sibling's paid media job, billed provider-side and
 * folded just before the terminal — ADR-0045 §5) but the event does NOT say which node it belongs to, and
 * inventing an attribution would be worse than admitting there is none. `run_costs.node_id` is `NOT NULL`, and
 * every event-carried `nodeId` is `nonEmptyString`, so an empty one is PROVABLY not an authored node — no
 * sentinel string could collide with a real id the way a plausible-looking `(run)` might.
 *
 * Writing the row (rather than only bumping `runs.total_cost_microcents`) is what keeps ADR-0070's
 * `SUM(run_costs) == runs.total_cost_microcents` exactly true.
 */
const RUN_LEVEL_COST_NODE_ID = '';

/**
 * The one place a stored `run_events` row becomes a {@link RunEvent} — the read boundary ADR-0074 §5 asks for.
 *
 * Three outcomes, and the whole design is in keeping them apart:
 *
 * - **readable** ⇒ the event joins `events`;
 * - **an unknown `type`** ⇒ a newer binary wrote it, so it joins `skipped` with the authoritative `seq`/`type`
 *   COLUMNS. Dropping it without recording that is what silently truncated the sequence high-water mark;
 * - **damaged** (bad JSON, or a known `type` with an unparseable body) ⇒ a typed
 *   {@link CorruptRunEventError} carrying the run and the row, because ADR-0050 forbids swallowing it and
 *   error-handling.md forbids surfacing it bare.
 *
 * `seq` and `event_type` are selected alongside the payload precisely so the last two outcomes can name the row
 * without parsing the blob that just failed to parse.
 */
function readEventLog(
  db: Db,
  runId: string,
  opts: { readonly streamingIncluded: boolean },
): RunEventLog {
  const rows = db
    .select({
      seq: runEvents.seq,
      eventType: runEvents.eventType,
      payloadJson: runEvents.payloadJson,
    })
    .from(runEvents)
    // Excluding the per-token/tool streaming firehose at the DB level keeps a gate/checkpoint fold over a long run
    // from paying to JSON.parse + Zod-validate thousands of `agent:token` rows the reconstruction ignores.
    .where(
      opts.streamingIncluded
        ? eq(runEvents.runId, runId)
        : and(eq(runEvents.runId, runId), notInArray(runEvents.eventType, STREAMING_EVENT_TYPES)),
    )
    .orderBy(asc(runEvents.seq))
    .all();

  const events: RunEvent[] = [];
  const skipped: SkippedRunEvent[] = [];
  for (const row of rows) {
    let event: RunEvent | undefined;
    try {
      event = parseStoredRunEvent(JSON.parse(row.payloadJson));
    } catch (cause) {
      throw new CorruptRunEventError(runId, row.seq, row.eventType, cause);
    }
    if (event === undefined) {
      skipped.push({ sequenceNumber: row.seq, type: row.eventType });
      continue;
    }
    const mismatch = projectionMismatch(event, runId, row);
    if (mismatch !== undefined) {
      throw new CorruptRunEventError(runId, row.seq, row.eventType, new Error(mismatch));
    }
    events.push(event);
  }
  return { events, skipped };
}

/**
 * Compare the parsed event against the denormalized COLUMNS that were supposed to project it (#W15-5).
 *
 * `run_id`, `seq` and `event_type` are written from the event at persist time and are the authoritative keys
 * afterwards: `seq` carries the `UNIQUE(run_id, seq)` constraint and orders this read, `run_id` scopes it, and
 * `event_type` is what the streaming-firehose filter and the skip path name a row by. Nothing checked that the
 * blob still agreed with them.
 *
 * The failure that makes this worth a throw: a row at `seq = 2` whose payload says `sequenceNumber: 1` parses
 * fine and is accepted, so the log's high-water mark comes back one short — and the resumed run's first write
 * collides on `UNIQUE(run_id, seq)` and fails the run. A `run_id` mismatch is worse: one run's event folded
 * into another's state. Both are silent today and neither is recoverable downstream, which is precisely the
 * shape ADR-0050 says must fail loudly at the read boundary rather than propagate.
 *
 * Returns the mismatch description, or `undefined` when the projections agree.
 */
function projectionMismatch(
  event: RunEvent,
  runId: string,
  row: { readonly seq: number; readonly eventType: string },
): string | undefined {
  if (event.runId !== runId) {
    // `undefined` counts as a mismatch: a row living in `run_events` under a `run_id` must carry it. The
    // dual-envelope events (ADR-0074 §1) have a session form WITHOUT a runId, and one of those reaching this
    // table means the bus routed a session event into run history — a real defect, not a tolerable variant.
    return `payload runId ${String(event.runId)} does not match the run_id column ${runId}`;
  }
  if (event.sequenceNumber !== row.seq) {
    return `payload sequenceNumber ${event.sequenceNumber} does not match the seq column ${row.seq}`;
  }
  if (event.type !== row.eventType) {
    return `payload type ${event.type} does not match the event_type column ${row.eventType}`;
  }
  return undefined;
}

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
  const currentRunCost = (tx: TxDb, runId: string): number =>
    tx.select({ c: runs.totalCostMicrocents }).from(runs).where(eq(runs.id, runId)).get()?.c ?? 0;

  /** Close an attempt's `step_executions` row as `failed` — shared by `node:failed` and `node:retrying`. */
  const failStepRow = (
    tx: TxDb,
    event: {
      readonly nodeId: string;
      readonly error: unknown;
      readonly attemptNumber?: number | undefined;
    },
    runId: string,
    ts: number,
  ): void => {
    tx.update(stepExecutions)
      .set({
        status: 'failed',
        errorJson: JSON.stringify(event.error),
        completedAt: ts,
        updatedAt: ts,
      })
      .where(stepMatch(runId, event.nodeId, event.attemptNumber))
      .run();
  };

  /**
   * Fold a durable run-wide cumulative SNAPSHOT into the money of record, and return the delta it added
   * (#W15-6). The same telescoping arithmetic `node:completed` uses: the delta since the last boundary, so
   * `sum(run_costs) == runs.total_cost_microcents` keeps holding exactly.
   *
   * `Math.max(0, …)` guards a non-monotonic snapshot (a deeper engine bug) and makes a re-emitted or absent
   * snapshot a no-op rather than a negative charge. A zero delta writes nothing at all — the common case for a
   * failure with no spend after the last boundary, which must not litter `run_costs` with empty rows.
   */
  const foldCumulative = (
    tx: TxDb,
    runId: string,
    cumulative: number | undefined,
    ts: number,
    nodeId: string,
  ): number => {
    if (cumulative === undefined) return 0; // a log written before the field existed
    const prev = currentRunCost(tx, runId);
    const delta = Math.max(0, cumulative - prev);
    if (delta === 0) return 0;
    tx.insert(runCosts)
      .values({
        id: deps.uuid(),
        runId,
        nodeId,
        inputTokens: 0, // a fail-cost addend carries no token attribution — only money
        outputTokens: 0,
        costMicrocents: delta,
        createdAt: ts,
      } satisfies NewRunCostRow)
      .run();
    tx.update(runs)
      .set({ totalCostMicrocents: prev + delta, updatedAt: ts })
      .where(eq(runs.id, runId))
      .run();
    return delta;
  };

  /**
   * Every micro-cent `run_costs` holds for one node — the step row's TRUE cost once a node's money can arrive
   * in more than one row (ADR-0076).
   *
   * Before the realized-cost ledger, a node's whole charge landed in exactly one `run_costs` row written at its
   * terminal, so the terminal's telescoping delta and the node's cost were the same number and the terminal arms
   * used one variable for both. They are no longer the same number: `cost:attempt_settled` rows advance
   * `runs.total_cost_microcents` as each attempt settles, so by the time the terminal folds its snapshot the
   * delta is **zero by arithmetic** — which is correct for the run total and wrong for `step_executions`, a
   * user-visible column (`relavium status --json`). Read the node's rows instead.
   *
   * **Attribution caveat, stated rather than discovered.** Under a node-RETRY there are several
   * `step_executions` rows for one `nodeId` (keyed by attempt), while `run_costs` has no attempt column — so an
   * earlier attempt's money lands on the final step row. That is the same class of approximation the per-node
   * fan-out delta already carries (see the `node:completed` arm); the run-level SUM stays exact either way.
   */
  const nodeSettledCost = (tx: TxDb, runId: string, nodeId: string): number =>
    tx
      .select({ c: sql<number>`coalesce(sum(${runCosts.costMicrocents}), 0)` })
      .from(runCosts)
      .where(and(eq(runCosts.runId, runId), eq(runCosts.nodeId, nodeId)))
      .get()?.c ?? 0;

  /** Apply an event's derived `runs`/`step_executions`/`run_costs` writes (`run:started` inserts the runs row). */
  const applyDerived = (tx: TxDb, event: RunEvent, runId: string, ts: number): void => {
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
          projectRoot: deps.projectRoot ?? null,
          startedAt: ts,
          createdAt: ts,
          updatedAt: ts,
        };
        tx.insert(runs).values(row).run();
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
        tx.insert(stepExecutions).values(row).run();
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
        const prev = currentRunCost(tx, runId);
        const cumulative = event.cumulativeCostMicrocents ?? prev;
        const nodeCost = Math.max(0, cumulative - prev);
        tx.insert(runCosts)
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
        tx.update(stepExecutions)
          .set({
            status: 'completed',
            outputJson: JSON.stringify(event.output),
            inputTokens: event.tokensUsed.input,
            outputTokens: event.tokensUsed.output,
            // The node's TRUE cost, NOT `nodeCost` (ADR-0076). `nodeCost` is the terminal's telescoping delta,
            // and once `cost:attempt_settled` rows have advanced the run total it is zero by arithmetic —
            // correct for `runs`, and a silent regression here, because this column is user-visible. Read after
            // the insert above so this node's terminal row is included. See `nodeSettledCost`.
            costMicrocents: nodeSettledCost(tx, runId, event.nodeId),
            durationMs: event.durationMs,
            completedAt: ts,
            updatedAt: ts,
          })
          .where(stepMatch(runId, event.nodeId, event.attemptNumber))
          .run();
        tx.update(runs)
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
      case 'node:retrying': {
        // The intermediate attempt that will re-dispatch as a fresh row on the next `node:started`. Its row
        // must not linger as `running` (a ghost in `relavium status`, 2.I). It carries no cost snapshot —
        // the node has not reached a boundary yet.
        failStepRow(tx, event, runId, ts);
        return;
      }
      case 'node:failed': {
        // The node's TERMINAL failure (node-retry budget exhausted). Same step-row close as `node:retrying`,
        // PLUS the cost fold `node:completed` gets and this arm was missing (#W15-6): a node that failed can
        // still have SPENT — a paid media job billed provider-side before the failure (ADR-0045 §5), or a
        // provider call that returned usage and then failed downstream. `cost:updated` is streamed, never
        // persisted, so this snapshot is the only durable carrier, and dropping it left the run total (and
        // `sum(run_costs)`) short of money that was really charged.
        failStepRow(tx, event, runId, ts);
        foldCumulative(tx, runId, event.cumulativeCostMicrocents, ts, event.nodeId);
        // Same correction as `node:completed` (ADR-0076): the step row carries the node's TRUE cost, not the
        // terminal's telescoping delta. The old `if (nodeCost > 0)` guard went with it — with attempt rows in
        // play the delta is routinely zero on a node that really spent, so the guard would skip the write on
        // exactly the failures whose cost matters most. `nodeSettledCost` returns 0 for a node that spent
        // nothing, which writes a truthful 0 rather than leaving a stale value.
        tx.update(stepExecutions)
          .set({ costMicrocents: nodeSettledCost(tx, runId, event.nodeId), updatedAt: ts })
          .where(stepMatch(runId, event.nodeId, event.attemptNumber))
          .run();
        return;
      }
      case 'cost:attempt_settled': {
        // ADR-0076: one settled provider attempt's REALIZED charge becomes a `run_costs` row in the SAME
        // transaction as its event, which is what makes the ledger idempotent without a second uniqueness key —
        // `UNIQUE(run_id, seq)` already bars a duplicate event, and the derived row cannot outlive it.
        //
        // **The row is a TELESCOPING delta off the event's cumulative — NOT the raw `costMicrocents`.** The
        // raw value is this attempt's true charge and the event keeps carrying it (that is what a reader and
        // the checkpoint fold sum); what goes in `run_costs` is `max(0, cumulative - currentRunCost)`, the same
        // arithmetic every other money arm here uses.
        //
        // **The reason, CORRECTED (ADR-0078 §8).** An earlier version of this comment blamed out-of-order
        // COMMIT — "`#emitDurable` starts each `persistEvent` immediately … so a later event's write can
        // commit FIRST". ADR-0078 §1 has since made the append ordered per run, so that reason no longer
        // exists, and leaving it here would invite the next reader to delete the telescoping along with it.
        //
        // The real reason survives the ordered tail untouched, because it is about STAMP time, not commit
        // time. `MoneyDurability` chains its writes and captures the run-wide cumulative at `record()` time
        // (ADR-0077), while `#bus.next` assigns the sequence number later, after the media de-inline await.
        // So under a `fan_out` a LATER-sequenced money event can legitimately carry an EARLIER, staler
        // absolute cumulative — perfectly ordered commits and all. Writing the raw per-attempt delta would
        // then DOUBLE-COUNT: a sibling's `node:completed` lands with a cumulative that already includes this
        // attempt, and this row adds it again. Telescoping cannot — every money event carries an ABSOLUTE
        // cumulative, so the running total converges on the largest one seen whatever order the stamps came
        // in, and `SUM(run_costs) == runs.total_cost_microcents` holds by construction.
        //
        // In the sequential case (the normal one) the two are identical: `cumulative - prev == costMicrocents`
        // exactly. The divergence is the `fan_out` case, where per-ATTEMPT attribution degrades to an
        // approximation — precisely the caveat `node:completed`'s per-node delta already carries and
        // documents. The event remains the exact per-attempt record; this row is the money of record.
        //
        // **The two writes are a pair.** ADR-0076 property 3 says the terminal's fold telescopes to zero
        // because the attempt rows advanced `sum(run_costs)`. What the fold actually subtracts is
        // `runs.total_cost_microcents` (`currentRunCost`), and the two are equal only because every writer
        // bumps `runs` alongside its `run_costs` insert. Dropping either write here would keep compiling, keep
        // a test that checks only one table green, and corrupt every later delta.
        const prev = currentRunCost(tx, runId);
        const attemptCost = Math.max(0, event.cumulativeCostMicrocents - prev);
        tx.insert(runCosts)
          .values({
            id: deps.uuid(),
            runId,
            nodeId: event.nodeId,
            // The REAL per-attempt tokens, unlike `foldCumulative`'s money-only addend — per-attempt token
            // attribution is half of why this ledger exists. The row is written even when `attemptCost` is 0
            // (an unpriced or free attempt, or one whose money a concurrent sibling already banked), because
            // the tokens are still real; `foldCumulative` skips a zero row only because it has none to carry.
            // Only the COST column carries ADR-0070's `SUM(run_costs) == runs.total_cost_microcents`
            // invariant; nothing sums these token columns, and `node:completed` remains the single writer of
            // the run-level token totals (see below).
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            costMicrocents: attemptCost,
            createdAt: ts,
            // `modelId` is deliberately NOT written. It is an FK to `model_catalog` (a UUID) and `schema.ts`
            // documents it as a dead column; `event.model` is a raw provider string this store cannot resolve.
            // Per-model attribution on the run path comes from the durable EVENT, not from this row.
          } satisfies NewRunCostRow)
          .run();
        tx.update(runs)
          // Money only. `runs.total_input_tokens` / `total_output_tokens` are NOT bumped here: `node:completed`
          // already adds the turn's full `tokensUsed`, which is the sum across these attempts, so adding them
          // here would double the run's token totals.
          .set({ totalCostMicrocents: prev + attemptCost, updatedAt: ts })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      case 'human_gate:paused':
      case 'budget:paused':
      case 'run:paused': {
        tx.update(runs).set({ status: 'paused', updatedAt: ts }).where(eq(runs.id, runId)).run();
        return;
      }
      case 'human_gate:resumed': {
        tx.update(runs).set({ status: 'running', updatedAt: ts }).where(eq(runs.id, runId)).run();
        return;
      }
      case 'run:completed': {
        tx.update(runs)
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
        // Both terminals DO carry the run-wide cumulative now, and folding it is the point (#W15-6). The
        // root-cause node's `node:failed` snapshots the cumulative as of THAT node, but a SIBLING's paid
        // media job abandoned by the failure is folded only just BEFORE this terminal (ADR-0045 §5) — after
        // that `node:failed` was already emitted. So this event is the only durable carrier of that last
        // addend, and without it a failed run's total silently undercounted real spend.
        foldCumulative(tx, runId, event.cumulativeCostMicrocents, ts, RUN_LEVEL_COST_NODE_ID);
        tx.update(runs)
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
        // Same fold as `run:failed`: a paid media job still pending at the cancel was billed provider-side
        // and its lone estimate addend lands just before this terminal (#W15-6, ADR-0045 §5).
        foldCumulative(tx, runId, event.cumulativeCostMicrocents, ts, RUN_LEVEL_COST_NODE_ID);
        tx.update(runs)
          .set({ status: 'cancelled', completedAt: ts, updatedAt: ts })
          .where(eq(runs.id, runId))
          .run();
        return;
      }
      default:
        // node:skipped / media_job:submitted / run:timeout / budget:estimate_committed (+ any future durable
        // event): captured in run_events below; no derived runs/step/cost write in 2.H's scope. (A skipped node
        // has no nodeType on its event, so it gets no step_executions row — the run_events log records the skip.)
        //
        // `budget:estimate_committed` is named explicitly because it is the one MONEY event routed here, and
        // that routing IS ADR-0074's central negative guarantee: a conservative commitment is an ESTIMATE, so it
        // must never reach `runs.total_cost_microcents` or `run_costs`. Folding it into either would present an
        // upper bound as an invoice and break ADR-0070's `SUM(run_costs) == runs.total_cost_microcents`. Falling
        // through here is what keeps that true — asserted, not assumed, in this package's tests.
        //
        // Its realized twin `cost:attempt_settled` (ADR-0076) does the OPPOSITE and has its own arm above. Note
        // what that means for anyone adding the next durable type: this `default` is not an exhaustiveness
        // guard. `RunEvent` has no `assertNever` anywhere in the repo, so a new money event added without an
        // arm lands here silently — a `run_events` row, no derived write, no compile error, no failing test.
        // Decide deliberately which side of this line a new type belongs on.
        return;
    }
  };

  /**
   * Persist one event: derived writes FIRST, then the `run_events` append — so `run:started`'s `runs` row
   * (the FK target of `run_events.run_id`) exists before its event row. The whole pair is one transaction
   * (the caller wraps it), so a crash never leaves a derived row without its event, or vice-versa.
   *
   * Every statement goes through the {@link TxDb} handle the transaction hands in, never the outer `db`
   * (#W15-23). Under `better-sqlite3` the two share a connection and the difference is invisible; with a
   * pooled Postgres driver the outer handle is a DIFFERENT client, so its statements would run outside the
   * transaction and survive a rollback — on the run's highest-volume money write. The handle is a parameter
   * rather than a closure so the compiler, not a reviewer, is what keeps this true.
   */
  const fold = (
    tx: TxDb,
    event: RunEvent,
    runId: string,
    ts: number,
    ctx: DurableWriteContext | undefined,
  ): void => {
    // **The compare-and-append (ADR-0078 §2), INSIDE this transaction and through `tx`.** Outside it the
    // read and the insert would be two statements a concurrent writer could interleave, which is the exact
    // race the guard exists to close; through the outer `db` it would, on a pooled Postgres driver, be a
    // different client whose read is not part of the transaction it is guarding. `UNIQUE(run_id, seq)` bars
    // a duplicate and says nothing about order or holes — this is what says the rest.
    //
    // `max(seq)` rather than a denormalized `runs.last_event_seq`: the unique index on (run_id, seq) already
    // serves it, so there is no migration, no drizzle snapshot regeneration, and no second source of truth
    // that can drift from the rows it describes.
    if (ctx !== undefined) {
      const actual =
        tx
          .select({ max: sql<number | null>`max(${runEvents.seq})` })
          .from(runEvents)
          .where(eq(runEvents.runId, runId))
          .get()?.max ?? -1;
      if (actual !== ctx.expectedLastSequenceNumber) {
        throw new AppendConflictError(runId, ctx.expectedLastSequenceNumber, actual);
      }
    }
    // **The fence (ADR-0079 §2), beside the append guard and inside the SAME transaction.** Checked here
    // rather than before it because both are refusals of the same write and both must be atomic with it;
    // checked AFTER the append guard because a stale belief about the log is the more specific diagnosis
    // when a writer has both problems, and a fenced writer's belief is stale precisely BECAUSE it was fenced.
    //
    // A missing lease row is a rejection too, not a pass: the run was taken over and released, or the row was
    // never created. Either way this writer cannot prove ownership, and ADR-0079 fails closed.
    if (ctx?.fence !== undefined) {
      const lease = tx
        .select({ ownerId: runLeases.ownerId, generation: runLeases.generation })
        .from(runLeases)
        .where(eq(runLeases.runId, runId))
        .get();
      if (
        lease === undefined ||
        lease.ownerId !== ctx.fence.ownerId ||
        lease.generation !== ctx.fence.generation
      ) {
        throw new LeaseFencedError(
          runId,
          ctx.fence.ownerId,
          ctx.fence.generation,
          lease?.generation,
        );
      }
    }
    applyDerived(tx, event, runId, ts);
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
    tx.insert(runEvents).values(eventRow).run();
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

    persistEvent: async (event, ctx) => {
      // The DB work is synchronous (better-sqlite3) but this honors the async RunStore port — a fault (bad
      // event, UNIQUE(run_id, seq), FK, disk) becomes a REJECTED promise, never a synchronous throw, so the
      // engine's `await persistEvent(...)` (durability-first: ADR-0050 fatal posture) and any `.catch` see it.
      // `async` guarantees that on its own: an async function can only ever reject, never throw synchronously.
      try {
        const parsed = RunEventSchema.parse(event); // validate on the way in (round-trip + envelope)
        const runId = parsed.runId;
        if (runId === undefined) {
          // The bus never routes a session-only event to the run store (ADR-0036); fail loud if it ever does.
          throw new Error(`run-history store received a non-run event: ${parsed.type}`);
        }
        const ts = isoToEpochMs(parsed.timestamp);
        // One IMMEDIATE transaction per event: the run_events append and its derived rows land atomically, so a
        // crash can never leave a derived row without its event (or vice-versa). `BEGIN IMMEDIATE` takes the
        // write lock up front (never a DEFERRED read→write upgrade race), and the retry waits out residual
        // cross-process lock contention — fail-loud, so a swallowed write can never be silent data loss
        // (ADR-0050; the ADR-0064 amendment note — DB write-path concurrency).
        //
        // The ASYNC twin (#226): this caller is already async, so the backoff between attempts yields the event
        // loop instead of parking the thread on `Atomics.wait`. The yield is observable — a sibling branch's
        // `persistEvent` may commit during our backoff — which is exactly what the backoff is for, and is safe
        // because each event's fold is ONE self-contained IMMEDIATE transaction that has already rolled back
        // before we sleep. Within a single branch the engine awaits these sequentially, so no event can
        // overtake its own predecessor.
        await withBusyRetryAsync(() =>
          db.transaction((tx) => fold(tx, parsed, runId, ts, ctx), { behavior: 'immediate' }),
        );
      } catch (error) {
        // Preserve the root cause (error-handling.md): never swallow it to rethrow a vaguer one.
        throw error instanceof Error ? error : new Error(String(error), { cause: error });
      }
    },

    leases: {
      // Every operation is ONE `BEGIN IMMEDIATE` transaction: acquire reads the current row and writes the
      // new generation atomically, so two processes racing cannot both read "expired" and both win. A
      // DEFERRED read-then-write would take a read lock first and lose the upgrade race under exactly the
      // contention this exists for (database-schema.md §"Concurrency & transaction behavior").
      acquire: (runId, ownerId, ttlMs) =>
        withBusyRetry(() =>
          db.transaction(
            (tx) => {
              const now = deps.now();
              const current = tx.select().from(runLeases).where(eq(runLeases.runId, runId)).get();
              // A DIFFERENT owner holding a LIVE lease is the only refusal. Same owner ⇒ renewal; expired ⇒
              // takeover. Expiry is `deps.now()`, the store's clock, never the caller's.
              if (current !== undefined && current.ownerId !== ownerId && current.expiresAt > now) {
                return undefined;
              }
              const generation = (current?.generation ?? 0) + 1;
              const row: NewRunLeaseRow = {
                runId,
                ownerId,
                generation,
                expiresAt: now + ttlMs,
                createdAt: current?.createdAt ?? now,
                updatedAt: now,
              };
              if (current === undefined) {
                tx.insert(runLeases).values(row).run();
              } else {
                tx.update(runLeases)
                  .set({ ownerId, generation, expiresAt: row.expiresAt, updatedAt: now })
                  .where(eq(runLeases.runId, runId))
                  .run();
              }
              return {
                runId,
                ownerId,
                generation,
                expiresAt: row.expiresAt,
              } satisfies RunLease;
            },
            { behavior: 'immediate' },
          ),
        ),

      heartbeat: (runId, ownerId, generation, ttlMs) =>
        withBusyRetry(() =>
          db.transaction(
            (tx) => {
              const now = deps.now();
              // Matching on (owner, generation) is what makes this discover a takeover without a second
              // query: a newer generation means someone fenced us out, and the update matches nothing.
              const updated = tx
                .update(runLeases)
                .set({ expiresAt: now + ttlMs, updatedAt: now })
                .where(
                  and(
                    eq(runLeases.runId, runId),
                    eq(runLeases.ownerId, ownerId),
                    eq(runLeases.generation, generation),
                  ),
                )
                .run();
              return updated.changes > 0;
            },
            { behavior: 'immediate' },
          ),
        ),

      release: (runId, ownerId, generation) => {
        withBusyRetry(() =>
          db.transaction(
            (tx) => {
              // Scoped to (owner, generation) so a process that has ALREADY been fenced out cannot delete
              // the new owner's lease on its way down — a release must never steal.
              tx.delete(runLeases)
                .where(
                  and(
                    eq(runLeases.runId, runId),
                    eq(runLeases.ownerId, ownerId),
                    eq(runLeases.generation, generation),
                  ),
                )
                .run();
            },
            { behavior: 'immediate' },
          ),
        );
      },

      read: (runId) => {
        const row = db.select().from(runLeases).where(eq(runLeases.runId, runId)).get();
        if (row === undefined) return undefined;
        return {
          runId: row.runId,
          ownerId: row.ownerId,
          generation: row.generation,
          expiresAt: row.expiresAt,
          // The store decides liveness, not the caller — one clock, one verdict.
          live: row.expiresAt > deps.now(),
        };
      },
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
    loadRunEventLog: reader.loadRunEventLog,
    loadRunEventLogForReplay: reader.loadRunEventLogForReplay,
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
    listRuns: (opts) => {
      // `id` is a stable secondary key so the order never flips between reads for same-createdAt runs (same
      // tiebreak as loadLatestRunPerWorkflow) — keeps `status`/`list` output deterministic. A `status` opt adds
      // the equality predicate (served by `idx_runs_status`); `limit` bounds to an indexed top-N for the Home.
      const where =
        opts?.status === undefined
          ? isNull(runs.deletedAt)
          : and(eq(runs.status, opts.status), isNull(runs.deletedAt));
      // The no-status ORDER BY is index-served (idx_runs_created, no filesort); its plan is pinned by
      // apps/cli/src/harness/perf-budget.e2e.test.ts (2.5.I S5) — keep the WHERE/ORDER BY in sync with it.
      const query = db
        .select()
        .from(runs)
        .where(where)
        .orderBy(desc(runs.createdAt), desc(runs.id));
      // Only a FINITE POSITIVE INTEGER bounds the read; undefined / `≤0` / a fraction / `NaN` / `Infinity` fall
      // back to the unbounded `all()` (the `≤0 ⇒ unbounded` convention, hardened so a non-integer never reaches
      // SQLite `LIMIT` — a `LIMIT 0` empty result would read as data loss, a negative as "all rows").
      const limit = opts?.limit;
      const rows =
        limit !== undefined && Number.isInteger(limit) && limit > 0
          ? query.limit(limit).all()
          : query.all();
      return rows.map(fromRunRow);
    },

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

    loadRunEvents: (runId) => readEventLog(db, runId, { streamingIncluded: true }).events,

    // The tolerant log + what it had to leave out. `logs` reports the skipped rows as a note; the RESUME path
    // does not use this — see `loadRunEventLogForReplay` below (ADR-0075).
    loadRunEventLog: (runId) => readEventLog(db, runId, { streamingIncluded: true }),

    loadRunEventLogForReplay: (runId) => {
      const log = readEventLog(db, runId, { streamingIncluded: true });
      if (log.skipped.length > 0) {
        // ADR-0075. The skipped rows' `seq` values come from the COLUMN, so the diagnostic names rows this
        // binary could not parse — which is the whole reason `readEventLog` selects them separately.
        throw new UnreadableRunEventLogError(
          runId,
          log.skipped.map((row) => row.sequenceNumber),
        );
      }
      return log.events;
    },

    loadRunStateEvents: (runId) =>
      // Same forward-compatible read (ADR-0074 §5). The skipped rows are deliberately DISCARDED here rather than
      // reported: this read is the 2.5.B Home's bounded gate/state fold, it already excludes the streaming
      // firehose (so its max `seq` is not the run's anyway), and nothing seeds a sequence counter from it. A row
      // this binary cannot read also cannot describe a gate this binary knows how to render.
      readEventLog(db, runId, { streamingIncluded: false }).events,

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

    loadWorkflowSlugs: (ids) => {
      if (ids.length === 0) return new Map(); // no query for an empty set — the Home with no runs hits this
      const rows = db
        .select({ id: workflows.id, slug: workflows.slug })
        .from(workflows)
        .where(and(inArray(workflows.id, [...ids]), isNull(workflows.deletedAt)))
        .all();
      return new Map(rows.map((r) => [r.id, r.slug]));
    },
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
  /** `runs.project_root` — the ORIGINAL run's cwd, so a cross-process resume re-jails `save_to` under it (a run
   * started in dir A and resumed from B still writes under A). `null` for a run started before this column was
   * populated ⇒ the caller falls back to the resumer's cwd. */
  readonly projectRoot: string | null;
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
      projectRoot: runs.projectRoot,
    })
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .get();
  return row === undefined
    ? undefined
    : {
        workflowDefinitionSnapshot: row.snapshot,
        inputJson: row.inputJson,
        projectRoot: row.projectRoot,
      };
}
