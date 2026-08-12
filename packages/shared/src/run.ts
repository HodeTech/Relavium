import { z } from 'zod';

import { nonEmptyString, nonNegativeInt } from './common.js';
import { EXECUTION_MODES } from './constants.js';
import { ErrorCodeSchema, type RunEvent } from './run-event.js';
import { TriggerTypeSchema } from './workflow.js';

/**
 * The logical run record (`RunSchema`) — the **engine-/surface-facing** shape of a
 * workflow execution.
 *
 * **`workflowId` is a surrogate UUID, not the authored slug (ADR-0022).** A run
 * references the persisted `workflows` catalog row by its surrogate primary key
 * (`runs.workflow_id` → `workflows.id`, a UUID), *not* by the authored kebab id from the
 * YAML — that authored id lives in `workflows.slug`. So `workflowId` here is a
 * `z.string().uuid()`, matching the FK; a surface joins it directly against `workflows.id`.
 * (The same field on the `run:started` event carries the same UUID.) The engine resolves
 * the authored slug → UUID when it materializes the `workflows` row.
 *
 * **Boundary (logical vs persisted).** `RunSchema` is deliberately the *narrow* view.
 * The persisted row carries additional columns that are a **persistence concern owned
 * by `@relavium/db`** (workstream 0.I), modeled there as a distinct `RunRow` mirroring
 * the canonical DDL in
 * [database-schema.md](../../../docs/reference/shared-core/database-schema.md): notably
 * `workflow_definition_snapshot` (the frozen graph for replay/resume — an engine
 * deliverable), `trigger_metadata`, `workflow_path`/`project_root`, and the
 * `deleted_at` soft-delete cursor. Those do not belong on the logical run view and are
 * intentionally absent here; a consumer that needs them reads the `RunRow` from
 * `@relavium/db`. Timestamps are epoch-milliseconds; money is integer micro-cents.
 */

/** Run lifecycle status (matches the `runs.status` CHECK in database-schema.md). */
export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z
  .object({
    id: z.string().uuid(), // run id (UUID, generated in application code)
    workflowId: z.string().uuid(), // FK to workflows.id (surrogate UUID), not the slug — ADR-0022
    status: RunStatusSchema,
    // Which mode the run used — persisted (`runs.execution_mode`) for cost/billing
    // attribution and history, matching the `run:started` event's `executionMode`.
    executionMode: z.enum(EXECUTION_MODES),
    // What triggered this run — the canonical trigger vocabulary (the runs table sets no
    // strict CHECK on trigger_type, so all five values are valid).
    triggerType: TriggerTypeSchema,
    inputs: z.record(z.string(), z.unknown()),
    outputs: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({
        code: ErrorCodeSchema, // closed ErrorCode taxonomy (sse-event-schema.md), matching run:failed
        message: z.string(),
        retryable: z.boolean(),
        nodeId: nonEmptyString.optional(), // a node id is never empty (matches event nodeId fields)
      })
      .optional(),
    startedAt: nonNegativeInt.optional(), // epoch ms
    completedAt: nonNegativeInt.optional(),
    totalInputTokens: nonNegativeInt,
    totalOutputTokens: nonNegativeInt,
    totalCostMicrocents: nonNegativeInt,
    createdAt: nonNegativeInt,
    updatedAt: nonNegativeInt,
  })
  .superRefine((run, ctx) => {
    // Temporal invariants: a run cannot finish before it starts, or be updated before it was created.
    if (
      run.startedAt !== undefined &&
      run.completedAt !== undefined &&
      run.completedAt < run.startedAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completedAt must be >= startedAt',
        path: ['completedAt'],
      });
    }
    if (run.updatedAt < run.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'updatedAt must be >= createdAt',
        path: ['updatedAt'],
      });
    }
  });
export type Run = z.infer<typeof RunSchema>;

// --- The durable-append contract (ADR-0078) ---------------------------------------------------------

/**
 * What a caller believes about a run's durable state when it asks for an append
 * ([ADR-0078](../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §2).
 *
 * **It lives in `@relavium/shared`, not beside the port it belongs to.** The port is
 * `ExecutionHost.RunStore` in `@relavium/core`, but `@relavium/db` implements it and depends only on this
 * package — the dependency runs one way, and a contract both sides must agree on has to sit where both can
 * reach it.
 *
 * **One extensible object, deliberately, rather than a parameter.** Three phase-2.6.5 items widen this same
 * write: `CR-10` needs the compare-and-append below, `CR-11` a fencing token, `CR-12` an effect-journal
 * correlation. Passing each as its own argument would break one exported port three times across four
 * packages and every test double; extending this object breaks it once.
 */
export interface DurableWriteContext {
  /**
   * The sequence number this writer last ASKED the store to append for the run — not the last it saw
   * succeed — or `-1` when it has asked for nothing yet.
   *
   * The store rejects the append when its own maximum for the run differs. That is what makes the log a
   * prefix rather than merely a set: a second process that committed something this writer never saw, an
   * out-of-order commit, and a replayed append all present as a mismatch here.
   *
   * **"Last asked", not "last committed", and the difference is the whole guard.** After a failed write the
   * engine keeps running — `#emitDurable` is total for non-terminal store faults (ADR-0078 §6) — so it would
   * otherwise report the last SUCCESSFUL sequence, and an append skipping the failed one would then match,
   * creating exactly the hole this exists to prevent. Reporting the last *asked* makes the next append fail
   * closed instead.
   */
  readonly expectedLastSequenceNumber: number;
}

/**
 * A durable append refused because the store's state is not what the caller believed (ADR-0078 §2).
 *
 * Typed rather than a bare `Error` (error-handling.md): the engine has to tell "the write failed" from "the
 * write was REFUSED because someone else moved the log", and only the second one means another writer exists.
 */
export class AppendConflictError extends Error {
  override readonly name = 'AppendConflictError';
  readonly runId: string;
  readonly expectedLastSequenceNumber: number;
  readonly actualLastSequenceNumber: number;

  constructor(runId: string, expected: number, actual: number) {
    super(
      `durable append refused for run ${runId}: expected the log to end at sequence ${String(expected)}, ` +
        `but it ends at ${String(actual)} — appending here would leave a hole a reader cannot distinguish ` +
        `from an event that was never meant to persist`,
    );
    this.runId = runId;
    this.expectedLastSequenceNumber = expected;
    this.actualLastSequenceNumber = actual;
  }
}

/** Narrow a thrown value to {@link AppendConflictError} — the class survives a store's promise rejection. */
export function isAppendConflictError(value: unknown): value is AppendConflictError {
  return value instanceof AppendConflictError;
}

/**
 * A terminal the store would not accept, held OUTSIDE the store so it can be retried
 * ([ADR-0078](../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §4).
 *
 * **Why not a row in the same database.** The store that must hold it is the store that just failed: a full
 * disk, a corrupt file or an exhausted busy-retry fails the outbox write for exactly the reason it failed the
 * terminal write. The alternative — no outbox, and let `reconcile()` repair — writes `run:failed{internal}`
 * for a run that actually COMPLETED, which relabels the divergence rather than closing it and loses the
 * outputs. So the host owns this, and a host that keeps it in a separate file gets real fault isolation.
 *
 * **Required on `ExecutionHost`, not optional.** The optional-port precedent there (`mediaStore?`) is
 * absent-tolerant because a text-only host legitimately has no media. There is no legitimate host with no
 * terminal durability, so optional would mean a host that forgets the port silently has no guarantee — a
 * fail-open default inside a fail-closed item, invisible at every call site.
 */
export interface TerminalOutbox {
  /** Record a terminal whose durable write did not land. Must not throw for a caller that cannot recover. */
  put: (event: RunEvent) => Promise<void>;
  /** Every recorded terminal, oldest first. Drained at start BEFORE reconciliation — see ADR-0078 §4. */
  list: () => Promise<readonly RunEvent[]>;
  /** Forget the entry for a run, once its terminal is durable (or was found to be already). */
  remove: (runId: string) => Promise<void>;
}

/**
 * Whether a run's terminal is known to have reached the durable log (ADR-0078 §5).
 *
 * `'uncertain'` is the disposition that stops a caller being told a run completed when the record disagrees.
 * It is HANDLE-level and never a field on the terminal `RunEvent`: the store persists the delivered event
 * verbatim as the lossless canonical record, so a live-only field either lands on disk — self-contradictory,
 * since the row existing IS the durability — or forces the delivered and persisted forms to diverge.
 *
 * `CR-11` reuses this for a fenced-out run and `CR-14` for a grammar violation on already-forwarded content,
 * rather than each minting a parallel shape.
 */
export type RunDurability = 'pending' | 'durable' | 'uncertain';
