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
   * succeed — or `-1` when it has asked for nothing yet. **Absent means "do not check the ordering"**: the
   * two claims on this object are independent, and the run TERMINAL carries the fence without the append
   * guard (ADR-0078 §2 exempts it, ADR-0079 §5 does not).
   *
   * The store rejects the append when its own maximum for the run differs — and, independently, when the
   * incoming event's own `sequenceNumber` is not GREATER than that maximum. Both halves are needed and the
   * second was once missing: sequence gaps are legitimate (a transient event consumes a number without
   * becoming a row), so a stale event's number is both unique and lower, and equality alone let a terminal
   * append behind durable work while the derived projection called the run finished.
   *
   * Together they are what make the log a prefix rather than merely a set: a second process that committed
   * something this writer never saw, an out-of-order commit, and a replayed append all present as a refusal
   * here — the first as a mismatch, the last two as a sequence that does not advance.
   *
   * **"Last asked", not "last committed", and the difference is the whole guard.** After a failed write the
   * engine keeps running — `#emitDurable` is total for non-terminal store faults (ADR-0078 §6) — so it would
   * otherwise report the last SUCCESSFUL sequence, and an append skipping the failed one would then match,
   * creating exactly the hole this exists to prevent. Reporting the last *asked* makes the next append fail
   * closed instead.
   */
  readonly expectedLastSequenceNumber?: number;
  /**
   * The fencing token this writer holds for the run
   * ([ADR-0079](../../../docs/decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md) §2), or
   * absent when the caller holds no lease.
   *
   * **This field is why `DurableWriteContext` is an object.** ADR-0078 §2 introduced it as one extensible
   * parameter precisely so the items after it would extend rather than re-break `persistEvent`; this is the
   * first of them, and `CR-12`'s journal correlation is the second.
   *
   * The store checks it in the SAME transaction as the append — a check outside would be two statements
   * another process could interleave, which is the race it exists to close. A token older than the run's
   * current `generation` means this process has been fenced out: another owner took the run over, and every
   * write from here on is refused. That is the property a `last_seq` CAS cannot give — a CAS stops two
   * processes writing the same row, the fence stops the LOSER continuing to act.
   */
  readonly fence?: RunFence;
}

/** A writer's claim on a run: who it believes it is, and at which generation (ADR-0079 §1). */
export interface RunFence {
  readonly ownerId: string;
  readonly generation: number;
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
  /**
   * The refused event's own sequence number, when it was the sequence — not the belief — that was wrong.
   *
   * Present only for the not-ahead refusal, so a caller can tell the two apart without parsing a message.
   */
  readonly incomingSequenceNumber?: number;

  constructor(runId: string, expected: number, actual: number, incoming?: number) {
    super(
      incoming !== undefined
        ? `durable append refused for run ${runId}: the event carries sequence ${String(incoming)}, which ` +
            `is not AHEAD of the log's ${String(actual)} — appending it would put this event behind work ` +
            `that is already durable, and the log would stop being an ordered prefix of what happened`
        : `durable append refused for run ${runId}: expected the log to end at sequence ${String(expected)}, ` +
            `but it ends at ${String(actual)} — appending here would leave a hole a reader cannot distinguish ` +
            `from an event that was never meant to persist`,
    );
    this.runId = runId;
    this.expectedLastSequenceNumber = expected;
    this.actualLastSequenceNumber = actual;
    if (incoming !== undefined) this.incomingSequenceNumber = incoming;
  }
}

/** Narrow a thrown value to {@link AppendConflictError} — the class survives a store's promise rejection. */
export function isAppendConflictError(value: unknown): value is AppendConflictError {
  return value instanceof AppendConflictError;
}

/**
 * A durable write refused because the writer no longer owns the run (ADR-0079 §2).
 *
 * Distinct from {@link AppendConflictError}, and the distinction is what a caller acts on: an append
 * conflict means "the log moved under you, your belief is stale"; a fence rejection means "you are not the
 * owner any more, and you must stop" — including stopping short of the terminal, because the run's real
 * outcome now belongs to somebody else (ADR-0079 §5).
 */
export class LeaseFencedError extends Error {
  override readonly name = 'LeaseFencedError';
  readonly runId: string;
  readonly ownerId: string;
  readonly generation: number;
  /** The generation the store actually holds — strictly greater than {@link generation} when fenced. */
  readonly currentGeneration: number | undefined;

  constructor(runId: string, ownerId: string, generation: number, current: number | undefined) {
    super(
      `run ${runId} is no longer owned by ${ownerId} at generation ${String(generation)}` +
        (current === undefined
          ? ' — the lease is gone'
          : ` — it is now at generation ${String(current)}`),
    );
    this.runId = runId;
    this.ownerId = ownerId;
    this.generation = generation;
    this.currentGeneration = current;
  }
}

/** Narrow a thrown value to {@link LeaseFencedError} — the class survives a store's promise rejection. */
export function isLeaseFencedError(value: unknown): value is LeaseFencedError {
  return value instanceof LeaseFencedError;
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

/**
 * Cross-process ownership of a run
 * ([ADR-0079](../../../docs/decisions/0079-cross-process-run-ownership-lease-and-fencing-token.md)).
 *
 * **Required on `ExecutionHost`, not optional** — the same reasoning as `TerminalOutbox`: the optional
 * media ports are absent-tolerant because a text-only host legitimately has no media, and there is no
 * legitimate host with no run ownership. Optional here would mean a host that forgets the port silently has
 * NO ownership guarantee, which is a security-shaped default no reviewer catches at a call site.
 *
 * Every method evaluates expiry against the HOST's own clock, never a caller-supplied time, so a caller
 * cannot widen its own lease and every process on the machine compares against one clock (§6).
 */
export interface RunLeasePort {
  /**
   * Take or renew ownership, returning the fence to carry on every durable write, or `undefined` when a
   * DIFFERENT owner holds a live lease. Every success bumps the generation — including a takeover of an
   * expired lease, which is what fences the previous owner out.
   */
  acquire: (runId: string, ownerId: string, ttlMs: number) => Promise<RunFence | undefined>;
  /**
   * Push the expiry forward for a lease this owner still holds at this generation. `false` means it has
   * been taken over — which is how a heartbeat discovers the loss without a second query.
   */
  heartbeat: (runId: string, fence: RunFence, ttlMs: number) => Promise<boolean>;
  /** Drop a lease this owner holds. A no-op when someone else has taken it — a release must never steal. */
  release: (runId: string, fence: RunFence) => Promise<void>;
  /** The current holder and whether the lease is live — for `reconcile()`'s skip and for the refusal message. */
  read: (runId: string) => Promise<RunLeaseInfo | undefined>;
}

/** A lease as read, with the host's own verdict on liveness — never re-derived by the caller. */
export interface RunLeaseInfo extends RunFence {
  readonly runId: string;
  readonly expiresAt: number;
  readonly live: boolean;
}

/**
 * How long a lease stays live without a heartbeat, and how often the owner renews it (ADR-0079 §6).
 *
 * Three missed beats permit a takeover: wide enough that a long provider call or disk pressure is not
 * mistaken for death, narrow enough that a crashed run is not locked for more than a minute. The numbers are
 * here rather than inline so they can be changed with evidence rather than by feel.
 */
export const RUN_LEASE_TTL_MS = 60_000;
export const RUN_LEASE_HEARTBEAT_MS = 20_000;

// --- The effect journal (ADR-0080) ------------------------------------------------------------
//
// Five identities, deliberately separate. Collapsing any two of them is how this design goes wrong: the
// phase document's original single key did exactly that and became unimplementable. The canonical home for
// the contract is `docs/reference/shared-core/effect-journal.md`.

/**
 * Which run/node or session/turn an effect belongs to (ADR-0080 §1).
 *
 * A discriminated union rather than optional fields, mirroring the invariant the run-event envelope already
 * enforces at runtime: exactly one of `runId`/`sessionId`. A session can never fabricate a `runId` — the
 * property ADR-0024 protects — and a run never borrows a session's.
 *
 * `attempt` is the NODE-RETRY attempt (ADR-0040), carried for audit only. It is deliberately excluded from
 * the resume-gate lookup: the node-retry attempt resets to 1 on both a crash-resume and a budget approval, so
 * an attempt-scoped lookup would miss the very row it exists to find.
 */
export type EffectCorrelation =
  | {
      readonly kind: 'run';
      readonly runId: string;
      readonly nodeId: string;
      readonly attempt: number;
    }
  | { readonly kind: 'session'; readonly sessionId: string; readonly turn: number };

/**
 * Which effect WITHIN one correlation — a zero-based ordinal over the tool calls of a single model response,
 * in the order the provider returned them. It disambiguates two effects in one turn, which the correlation
 * alone cannot.
 *
 * Stable only within one model response: a replay may regenerate a different number of calls in a different
 * order, so a slot from before a crash is not comparable to one after it. That is precisely why the resume
 * gate is at NODE granularity and not at slot granularity.
 */
// A DOMAIN alias, not a redundant one: the docblock above is where "what a slot is" lives, and
// replacing every occurrence with `number` would delete the concept from the type surface along with it.
export type EffectSlot = number; // NOSONAR — a DOMAIN alias; see the docblock above

/**
 * The journal's UNIQUE key: the correlation with `attempt` dropped, plus the slot, plus the tool.
 *
 * Its job is CONCURRENCY, not replay — two processes preparing the same effect collide on it, so one loses
 * and learns another attempt exists. It is **not** claimed to be reproducible after a model replay, and no
 * part of the design depends on it being so.
 */
export interface EffectIdentity {
  /** `run:<runId>:<nodeId>` or `session:<sessionId>:<turn>` — the correlation, minus the retry attempt. */
  readonly scope: string;
  readonly slot: EffectSlot;
  readonly toolId: string;
}

/**
 * The audit identity of ONE occurrence. Never used for dedup — it is deliberately unstable, because its
 * question is "which occurrence was this?" rather than "is this the same effect?".
 */
export interface EffectAttemptId {
  /** The node-retry attempt (ADR-0040), or `undefined` on the session path, which has no node retry. */
  readonly nodeAttempt?: number;
  /** The within-chain provider failover attempt — the counter that actually reaches the dispatch. */
  readonly providerAttempt: number;
  /** The provider's own id for this tool call. */
  readonly toolCallId: string;
  /** The ADR-0079 fence that owned the run when this occurrence happened; absent on the session path. */
  readonly fence?: RunFence;
}

/**
 * What the engine can honestly promise about an effect, decided by what the TARGET supports (ADR-0080 §3).
 *
 * Tiers 1 and 2 are reserved and specified; **nothing in the tree claims either today**. Every effect that
 * ships is tier 3, and only tier 1 may use the words "exactly once".
 */
export const EFFECT_TIERS = [
  // 1 — the target honours a caller-supplied idempotency key: safe retry, effectively exactly-once.
  1,
  // 2 — the target's outcome is queryable: exactly-once after reconciling a receipt.
  2,
  // 3 — opaque and non-idempotent: at-most-once dispatch ATTEMPT, never auto-retried.
  3,
] as const;
export type EffectTier = (typeof EFFECT_TIERS)[number];

/**
 * The journal row's state (ADR-0080 §6). `dispatched` is a DERIVED reading of `prepared` when no settle
 * followed — not a third durable write, because a write between the prepare and the call would be a second
 * crash window rather than fewer.
 */
export const EFFECT_STATES = [
  'prepared',
  'dispatched',
  'committed',
  'ambiguous',
  'needs_attention',
] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** A journal row as the engine reads it back on resume. */
export interface EffectRecord {
  readonly identity: EffectIdentity;
  readonly state: EffectState;
  readonly tier: EffectTier;
  /** Present only when the tool's result was retained, which is what buys re-delivery instead of refusal. */
  readonly result?: unknown;
  /** Tier 1 only: what was handed to the target, so a retry reuses it verbatim. */
  readonly targetIdempotencyKey?: string;
}

/**
 * The journal's READ side, as the RESUME GATE sees it (ADR-0080 §2b,
 * [effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §4).
 *
 * Deliberately narrower than `@relavium/db`'s `EffectJournalStore`: the gate needs to know what is
 * UNRESOLVED for a correlation and nothing else, so that is all this names. The full record set, the
 * digests and the sweep stay host-side, where they are actually used.
 *
 * `unresolvedFor` takes the correlation with **`attempt` already dropped** — {@link effectScope} drops it —
 * because the node-retry attempt resets to 1 both on a crash-resume and on a budget approval, so an
 * attempt-scoped lookup would miss the very row it exists to find.
 */
export interface EffectResumePort {
  /**
   * Every unresolved effect of one RUN, across all its nodes — one range scan, not one query per node.
   *
   * Run-scoped rather than node-scoped for two reasons. It is a single index range instead of N sequential
   * round-trips on the resume critical path; and a node RENAMED between the crash and the resume (same
   * workflow surrogate id, edited content — a risk `resumeFromCheckpoint` explicitly leaves to the caller)
   * leaves rows under a `nodeId` a per-node loop would never think to ask about. An orphaned row should
   * block, and this shape makes that the default rather than a special case.
   */
  unresolvedForRun: (runId: string) => Promise<readonly UnresolvedEffect[]>;
}

/** One effect a resumed correlation cannot move past, and why — the gate's whole vocabulary. */
export interface UnresolvedEffect {
  readonly identity: EffectIdentity;
  readonly state: EffectState;
  readonly tier: EffectTier;
  /** The node this effect belongs to, decoded from the scope — what the refusal message has to name. */
  readonly nodeId: string;
}

/**
 * Is this record blocking on resume? §4's table in one predicate, and the bold line under it:
 * **a `committed` row is not a green light.** If the journal did not retain enough to re-deliver the result,
 * it blocks exactly as an unresolved row does — that is the window where settle succeeded, the process died
 * before `node:completed` persisted, and a gate examining only unresolved rows would wave the re-run through.
 */
export function blocksResume(record: {
  readonly state: EffectState;
  readonly result?: unknown;
}): boolean {
  return record.state !== 'committed' || record.result === undefined;
}

/**
 * A settle did not move exactly one `prepared` row — the transition the caller asked for did not happen.
 *
 * Distinct from {@link EffectConflictError}, and the distinction is what a caller does about it: a conflict
 * means another attempt legitimately holds the identity and this dispatch must not proceed. This means the
 * durable record is not what the caller believed — the row is missing, or already terminal — while the
 * external effect it describes may well have LANDED. That is the one condition
 * `ToolEffectNeedsAttentionError` exists for, and a store that swallowed it reported durable success for an
 * effect nothing recorded.
 */
export class EffectTransitionError extends Error {
  override readonly name = 'EffectTransitionError';
  readonly identity: EffectIdentity;
  readonly attemptedState: EffectState;
  /** How many rows the transition actually moved — `0` for a missing or already-terminal row. */
  readonly changed: number;

  constructor(identity: EffectIdentity, attempted: EffectState, changed: number) {
    super(
      `effect ${identity.scope} slot ${String(identity.slot)} (${identity.toolId}) could not be settled to ` +
        `${attempted}: ${String(changed)} prepared rows matched, expected exactly 1 — the row is missing or ` +
        `already terminal, so the durable record does not describe what happened`,
    );
    this.identity = identity;
    this.attemptedState = attempted;
    this.changed = changed;
  }
}

/** Narrow an unknown throw to {@link EffectTransitionError} — callers narrow on this, never on `message`. */
export function isEffectTransitionError(value: unknown): value is EffectTransitionError {
  return value instanceof EffectTransitionError;
}

/** Another attempt already holds this {@link EffectIdentity} — the concurrency collision, not a fault. */
export class EffectConflictError extends Error {
  override readonly name = 'EffectConflictError';
  readonly identity: EffectIdentity;

  constructor(identity: EffectIdentity) {
    super(
      `effect ${identity.scope} slot ${String(identity.slot)} (${identity.toolId}) is already claimed by another attempt`,
    );
    this.identity = identity;
  }
}

/** Narrow an unknown throw to {@link EffectConflictError} — callers narrow on this, never on `message`. */
export function isEffectConflictError(value: unknown): value is EffectConflictError {
  return value instanceof EffectConflictError;
}

/**
 * The node id back out of a run scope — the inverse of {@link effectScope}'s run arm.
 *
 * Lives beside the scope builder so the encoding and its inverse cannot drift; a decoded id that does not
 * round-trip would put the wrong node in a refusal message an operator acts on.
 */
export function nodeIdFromRunScope(scope: string): string | undefined {
  const parts = scope.split(':');
  if (parts.length !== 3 || parts[0] !== 'run') return undefined;
  return decodeURIComponent(parts[2] ?? '');
}

/**
 * The correlation's lookup scope — the resume gate's key, with the retry attempt deliberately dropped.
 *
 * **Every component is percent-encoded**, so a component can never introduce the `:` that separates
 * components. Without it a run id of `r1:x` produces the scope `run:r1:x:n`, which a prefix range for run
 * `r1` matches — and the host's retention sweep then DELETES another run's committed rows, destroying the
 * replay evidence the gate reads while that run is still resumable. A review reproduced both halves against
 * a real SQLite file: a cross-session disclosure and a cross-run delete.
 *
 * Ids are UUIDs on every shipping surface, so the encoding is the identity function in practice. It is here
 * because `history.db` is shared and a session id is only schema-constrained to a non-empty string —
 * precisely the reasoning that moved the host's scope queries from `LIKE` to a byte range.
 */
export function effectScope(correlation: EffectCorrelation): string {
  return correlation.kind === 'run'
    ? `run:${encodeURIComponent(correlation.runId)}:${encodeURIComponent(correlation.nodeId)}`
    : `session:${encodeURIComponent(correlation.sessionId)}:${String(correlation.turn)}`;
}

/**
 * What a `prepare` decided — [effect-journal.md](../../../docs/reference/shared-core/effect-journal.md) §4.
 *
 * `'proceed'` claimed the identity and the dispatch may run. `'replay'` found this exact effect already
 * `committed` — same identity, same args digest — with its result retained, so the call must NOT be made
 * again and the stored result stands in for it. That is the one row in §4's table that lets a resumed node
 * move forward instead of stopping, and it is decided host-side because only the host can compute the digest
 * the comparison needs (the engine is platform-free).
 *
 * A committed row that does NOT match — a different digest at the same slot, or no retained result — is not
 * a verdict; it rejects with {@link EffectConflictError}, because "an effect already happened here and we
 * cannot reproduce its result" is exactly what a human has to look at.
 */
export type EffectPrepareVerdict =
  | { readonly outcome: 'proceed' }
  | { readonly outcome: 'replay'; readonly result: unknown };

/**
 * The journal as a DISPATCH sees it (ADR-0080 §7) — the correlation is already closed over, so a dispatch
 * site cannot get it wrong, and the engine stamps it because only the engine knows it.
 *
 * This mirrors `TurnMoneyPort` (ADR-0076) and deliberately EXTENDS it: the money port is run-path only, while
 * this one is supplied by both entry points, because a session's effects need journaling just as a run's do.
 *
 * **Required, not optional**, on ADR-0078 §4's reasoning: an optional port would mean a host that forgets it
 * silently has no guarantee — a fail-open default inside a fail-closed item, invisible at every call site.
 */
export interface EffectDispatchPort {
  /**
   * Durably record the intent to dispatch, BEFORE the effect leaves the process.
   *
   * Rejects with {@link EffectConflictError} when another attempt already holds this slot — which is how two
   * processes preparing the same effect resolve to one dispatch rather than two.
   */
  prepare: (
    slot: EffectSlot,
    toolId: string,
    tier: EffectTier,
    /**
     * The effective args with every secret-tainted key **already removed** — the port hashes this, it does
     * not receive a digest.
     *
     * The split is forced and worth stating. The engine is platform-free and cannot compute SHA-256, so the
     * hash has to happen host-side; but only the engine knows which keys are secret-tainted, so the
     * REDACTION has to happen here. Passing the redacted projection rather than raw args keeps a secret from
     * reaching the hash at all — a digest is a permanent equality oracle, and a low-entropy secret is
     * recoverable from one by dictionary attack on a `history.db` that may be unencrypted at rest.
     */
    redactedArgs: unknown,
    targetIdempotencyKey?: string,
  ) => Promise<EffectPrepareVerdict>;
  /** Durably record the outcome, immediately after the call returns or fails. */
  settle: (
    slot: EffectSlot,
    toolId: string,
    state: Extract<EffectState, 'committed' | 'ambiguous'>,
    result?: unknown,
  ) => Promise<void>;
  /**
   * Release a `prepared` claim for an effect that PROVABLY never left the process.
   *
   * The narrow companion to {@link settle}, and it exists because the state machine had no honest answer for
   * one case. A missing host capability throws synchronously inside the dispatch arm before the host is ever
   * touched, so the effect demonstrably did not happen — `ambiguous` would be a lie, and the code correctly
   * refused to write it. But nothing else happened either: the row stayed `prepared`, which the machine reads
   * as UNRESOLVED. That blocks workflow resume, is disclosed on session resume as an effect that may have
   * landed, and is never swept by age — a permanent operator-facing record of a wiring error.
   *
   * Deleting the row rather than adding a terminal state, because the claim describes an effect that did not
   * occur: there is nothing to retain, and no reader benefits from a tombstone for a call that never left.
   * The row was written moments earlier by this same dispatch, so discarding it restores exactly the state
   * that preceded the prepare.
   *
   * **Only for a proven non-dispatch.** Genuine post-dispatch uncertainty must still settle `ambiguous` and
   * block, which is the entire point of the journal.
   */
  discard: (slot: EffectSlot, toolId: string) => Promise<void>;
}

/**
 * A port that fails loudly if anything tries to journal through it — for fixtures that dispatch no effects.
 *
 * Deliberately NOT a silent no-op. A no-op default is the fail-open this contract rejects: it would let a
 * production wiring mistake look exactly like a test that never had effects. This turns "nobody wired the
 * journal" into a loud failure at the moment an effect would have gone unrecorded.
 */
export function unwiredEffectJournal(): EffectDispatchPort {
  // REJECTS rather than throwing synchronously. The port is Promise-typed, and a synchronous throw out of a
  // Promise-typed method breaks any caller that uses `.catch()` rather than `await`-in-`try` — the same
  // defect a review found in an earlier lease port.
  const fail = (slot: EffectSlot, toolId: string): Promise<never> =>
    Promise.reject(
      new Error(
        `no effect journal is wired, but ${toolId} (slot ${String(slot)}) is an effect that must be journaled (ADR-0080)`,
      ),
    );
  return { prepare: fail, settle: fail, discard: fail };
}
