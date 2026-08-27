/**
 * Checkpoint/resume (1.R) — the read-side that reconstructs a run's state from its persisted event
 * stream so a run interrupted (a crash, or suspended at a human gate) can resume without re-running the
 * work already done. There is **no checkpoint table** — the {@link CheckpointState} is *derived* from the
 * ordered `run_events` the {@link RunStore} already persists (ADR-0003; execution-model.md §5). The real
 * SQLite/cloud-backed `Checkpointer` is Phase-2/CLI; 1.R ships the in-memory reference
 * ({@link createInMemoryHost}).
 *
 * Reconstruction is a **pure replay**: walk the events in order and fold each into per-node state.
 * Crucially, a node that emitted `node:started` but no terminal event (it was running when the process
 * died) is simply ABSENT from {@link CheckpointState.nodeStates} — so the rehydrating engine seeds it
 * `pending` and re-runs it. A half-run EXTERNAL side effect is RECORDED by the effect journal (ADR-0080) —
 * every effectful dispatch is bracketed by a durable prepare/settle — but the resume GATE that would read
 * those records and refuses the re-run runs before anything is scheduled (`RunExecution`), so a node whose
 * prior attempt left an effect unresolved is NOT re-run — the run fails `effect_needs_attention` instead.
 * A `condition`'s `selected` branch is restored from
 * `node:completed.selected` so a selected branch mid-flight at the crash re-runs rather than being
 * wrongly skip-propagated; the dimmed branches are restored from `node:skipped`.
 */

import type {
  ExecutionMode,
  LlmProviderId,
  MediaBilledModality,
  RunEvent,
  RunStatus,
} from '@relavium/shared';

import type { GateRequest, NodeFailure } from './node-executor.js';

/** The schema version of the *derivation* (not a stored blob) — lets a later engine refuse/migrate it. */
export const CHECKPOINT_SCHEMA_VERSION = 1;

/** The reconstructed terminal-or-paused state of one vertex (a still-running vertex is omitted — re-run). */
export interface CheckpointNodeState {
  readonly status: 'completed' | 'failed' | 'skipped' | 'paused';
  /** The node output, for a `completed` vertex (incl. a resumed gate's decision payload). */
  readonly output?: unknown;
  /** The failure, for a `failed` vertex. */
  readonly error?: NodeFailure;
  /** A `completed` `condition`'s selected immediate target ids — restores `selectedTargets` on resume. */
  readonly selectedTargets?: readonly string[];
}

/** A gate still awaiting a decision at the checkpoint — the run resumes by applying a `GateDecision`. */
export interface CheckpointPendingGate {
  readonly gateId: string;
  readonly nodeId: string;
  /** True for a budget gate, so a rejected decision can still fail the run on resume. */
  readonly isBudgetGate: boolean;
  /**
   * The gate's ABSOLUTE deadline, when one was configured (`CR-22`).
   *
   * Both this and {@link timeoutAction} were already on the durable `human_gate:paused` event — its schema
   * says in as many words that they ride there "so a Phase-2 crash-resume can re-arm the timer from the
   * persisted log". The fold simply dropped them, so a rehydrated run lost the deadline of every gate it did
   * not resume, and the loss was silent. Absolute rather than remaining, deliberately: a duration would
   * restart on each resume, which is the defect, and an absolute instant is what the event already carries.
   */
  readonly expiresAt?: string;
  /** What the engine does when {@link expiresAt} passes — carried with it, since one is inert without the other. */
  readonly timeoutAction?: GateRequest['timeoutAction'];
}

/**
 * An async media-generation job still in flight at the checkpoint (1.AG, ADR-0045 §2-3). The run resumes by
 * **re-polling** the persisted opaque `jobId` (re-attach), NEVER re-submitting. Keyed by `nodeId` in the
 * fold — one in-flight job per node, latest `media_job:submitted` wins. Carries everything a re-attach needs.
 */
export interface CheckpointPendingMediaJob {
  readonly nodeId: string;
  /** The Relavium-opaque job id to re-poll (never the vendor operation-name). */
  readonly jobId: string;
  readonly provider: LlmProviderId;
  readonly model: string;
  readonly modality: MediaBilledModality;
  /** ISO-8601 submit time and absolute deadline; on resume `now > deadlineAt` short-circuits a doomed re-poll. */
  readonly startedAt: string;
  readonly deadlineAt: string;
  /**
   * The money basis FROZEN at submit time ([ADR-0074](../../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §3):
   * the authored billed volume, and the amount the admission actually reserved.
   *
   * Both absent ⇒ a LEGACY row written before §3. Resume then has to re-derive the volume from the workflow
   * definition and re-price from the current catalog — which is exactly what §3 stops doing, because a node edit
   * or a price change between submission and resume would otherwise move a commitment the provider had already
   * accepted. A legacy job is therefore handled fail-closed rather than trusted.
   */
  readonly units?: number;
  readonly acceptedCostMicrocents?: number;
}

/** The derived state a rehydrating run is rebuilt from — never a persisted blob (reconstructed from rows). */
export interface CheckpointState {
  readonly schemaVersion: number;
  readonly runStatus: RunStatus;
  /** The surrogate `workflows.id` UUID from `run:started` — resume refuses a different workflow (identity guard). */
  readonly workflowId: string;
  /** `run:started.timestamp` as epoch ms — the resumed run keeps measuring `durationMs` from the ORIGINAL
   *  start, so a terminal event reports total wall-clock across the pre- and post-resume segments. */
  readonly startedAtMs: number;
  /**
   * What the run was ADMITTED with
   * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md) §5).
   *
   * `run:started` is the authoritative record — the ordered durable log ADR-0078 built — and the fold
   * already reads that event, so carrying these needs no new port and no new persisted state. A resume
   * verifies the caller's copies against them rather than trusting what it was handed; a host that passes
   * something different learns it instead of being silently overridden.
   *
   * `admittedInputs` carries a `secret`-typed value already MASKED to `{ secret: true, ref }` — the event
   * masks at emit time, so a credential was never in the log to fold.
   */
  readonly admittedInputs: Readonly<Record<string, unknown>>;
  readonly executionMode: ExecutionMode;
  /** Per-vertex settled/paused state; a vertex absent here is `pending` (never started, or running at crash). */
  readonly nodeStates: ReadonlyMap<string, CheckpointNodeState>;
  /** Convenience projection of the `completed` vertices (the engine derives `pending` from the plan). */
  readonly completedNodeIds: readonly string[];
  /** Gates still pending a decision — the run is resumable via `engine.resume(runId, gateId, decision)`. */
  readonly pendingGates: readonly CheckpointPendingGate[];
  /** Async media jobs in flight at the checkpoint — the run resumes by re-polling each (re-attach, ADR-0045 §3). */
  readonly pendingMediaJobs: readonly CheckpointPendingMediaJob[];
  /** Gate ids ALREADY resolved (a `human_gate:resumed` was persisted) — so re-delivering a decision after a
   *  reconnect is an idempotent no-op rather than advancing the run twice (execution-model.md §gate). */
  readonly resolvedGateIds: readonly string[];
  /** The highest persisted `sequenceNumber` — the resumed run seeds its counter to this + 1 (gap-free). */
  readonly lastSequenceNumber: number;
  /** Running token totals (summed from `node:completed`), restored so a resumed run's `run:completed` totals stay correct. */
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /**
   * The run-wide realized cost (integer micro-cents), restored on resume so post-resume spend keeps
   * accumulating against a cap that remembers what already went out.
   *
   * **The fold is `Math.max` over every durable ABSOLUTE total that is folded here**, and there are exactly
   * three: `node:completed.cumulativeCostMicrocents`, `node:failed.cumulativeCostMicrocents`, and — since
   * [ADR-0076](../../../../docs/decisions/0076-durable-per-attempt-realized-cost-ledger.md) —
   * `cost:attempt_settled.cumulativeCostMicrocents`. Plus `budget:paused.spentMicrocents` in
   * `applyGateEvent`, maxed the same way. Each is read immediately after its own increment, so each is a true
   * run-wide total at that instant and the largest is the engine's real total, whatever order the rows landed
   * in.
   *
   * **`run:failed` / `run:cancelled` carry the field but are NOT folded here**, and that is deliberate rather
   * than an oversight — the engine states it at the emit site. A run terminal is the last event of the run, so
   * a restored total that omitted it would only ever be read by a resume that cannot happen. Named because the
   * field list above reads like it should include them.
   *
   * **Neither obvious alternative works, and one of them under-counts silently:**
   *
   * - SUMMING `cost:attempt_settled.costMicrocents` into this field double-counts, because a node terminal's
   *   snapshot already contains the attempts it covers.
   * - Summing the attempts into a SEPARATE accumulator and taking the max of the two families under-counts.
   *   The families cover different money — a media node writes a snapshot and emits no attempt row at all —
   *   so whenever earlier media spend is the larger figure, every attempt made after the last node boundary
   *   is silently dropped. That is exactly the crash-mid-agent-loop case the ledger exists for.
   *
   * The `Math.max` reasoning {@link conservativeCostMicrocents} rejects does not carry here: it was rejected
   * there only because a future deliberate release would DECREASE the conservative total. Realized spend has
   * no release and is monotonic by construction.
   *
   * (`cost:updated` is also folded when present, but it is streamed, not persisted, so it never appears in a
   * real durable log.)
   */
  readonly cumulativeCostMicrocents: number;
  /**
   * The run-wide durable **conservative** total (integer micro-cents) — money a provider may already have billed
   * for an attempt that returned no trustworthy usage ([ADR-0074](../../../../docs/decisions/0074-durable-conservative-budget-commitments.md) §1/§2).
   *
   * Kept strictly apart from {@link cumulativeCostMicrocents}: this is an ESTIMATE, never realized spend, so it
   * consumes cap capacity without ever inflating a reported actual cost. Restored on resume so the first
   * post-resume pre-egress check projects against a cap that has NOT forgotten it — otherwise a crash reopens a
   * strict cap against money that may already be owed, which is the bypass ADR-0074 exists to close.
   *
   * Folded as a SUM of `budget:estimate_committed.estimateMicrocents`. Three candidate folds, and the reasoning
   * matters because two of them look fine:
   *
   * - **last-wins** over the event's `cumulativeConservativeMicrocents` is WRONG. The engine assigns
   *   `sequenceNumber` after an `await` and states that concurrent events have no canonical order, so under a
   *   `fan_out` the lower `seq` can carry the higher cumulative — restoring the last one would hand already-owed
   *   money back to the cap as headroom.
   * - **`Math.max`** over those snapshots is, in fact, order-independent and correct TODAY: each snapshot is read
   *   immediately after its own increment, so the largest one is always the true running total. It is not chosen
   *   only because it stops being correct the moment §1's deliberate release DECREASES the total.
   * - **the sum of deltas** is correct in both worlds, so it is what the contract prescribes.
   *
   * The canonical statement lives in
   * [sse-event-schema.md](../../../../docs/reference/contracts/sse-event-schema.md).
   */
  readonly conservativeCostMicrocents: number;
}

/**
 * The read port that reconstructs a run's {@link CheckpointState} from persisted rows. Returns
 * `undefined` for a run with no `run:started` (unknown / never-persisted). 1.N's {@link RunStore} is
 * write+enumerate only; this is the 1.R read side, kept a separate port (single responsibility).
 */
export interface Checkpointer {
  load: (runId: string) => Promise<CheckpointState | undefined>;
}

/** The mutable fold accumulator, threaded through the per-category appliers below. */
interface ReconAccumulator {
  started: boolean;
  workflowId: string;
  startedAtMs: number;
  admittedInputs: Readonly<Record<string, unknown>>;
  executionMode: ExecutionMode;
  runStatus: RunStatus;
  lastSequenceNumber: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  cumulativeCostMicrocents: number;
  conservativeCostMicrocents: number;
  readonly nodeStates: Map<string, CheckpointNodeState>;
  readonly pendingGates: Map<
    string,
    {
      nodeId: string;
      isBudgetGate: boolean;
      expiresAt?: string;
      timeoutAction?: GateRequest['timeoutAction'];
    }
  >;
  /** Keyed by `nodeId` — one in-flight media job per node; a re-submit replaces the entry (latest wins). */
  readonly pendingMediaJobs: Map<string, CheckpointPendingMediaJob>;
  readonly resolvedGateIds: Set<string>;
}

const RUN_STATUS_BY_EVENT: Partial<Record<RunEvent['type'], RunStatus>> = {
  'run:paused': 'paused',
  'run:completed': 'completed',
  'run:failed': 'failed',
  'run:cancelled': 'cancelled',
};

/** Run-level lifecycle: capture start identity/clock and fold the run status. */
function applyRunEvent(acc: ReconAccumulator, event: RunEvent): void {
  if (event.type === 'run:started') {
    acc.started = true;
    acc.workflowId = event.workflowId;
    acc.startedAtMs = Date.parse(event.timestamp);
    acc.admittedInputs = event.inputs;
    acc.executionMode = event.executionMode;
    acc.runStatus = 'running';
    return;
  }
  const status = RUN_STATUS_BY_EVENT[event.type];
  if (status !== undefined) {
    acc.runStatus = status;
  }
}

/** Node-level settlements: completed (+ branch selection, token tally), failed, skipped. */
function applyNodeEvent(acc: ReconAccumulator, event: RunEvent): void {
  // A node's terminal clears any in-flight media job it had parked (ADR-0045 §2): the artifact (or failure)
  // has settled, so there is nothing to re-attach to on resume.
  if (
    event.type === 'node:completed' ||
    event.type === 'node:failed' ||
    event.type === 'node:skipped'
  ) {
    acc.pendingMediaJobs.delete(event.nodeId);
  }
  switch (event.type) {
    case 'node:completed':
      acc.nodeStates.set(event.nodeId, {
        status: 'completed',
        output: event.output,
        ...(event.selected === undefined ? {} : { selectedTargets: event.selected }),
      });
      acc.totalInputTokens += event.tokensUsed.input;
      acc.totalOutputTokens += event.tokensUsed.output;
      // Restore the run-wide cumulative cost from the durable node boundary (cost:updated is streamed, not
      // persisted, so it is otherwise lost on a plain-human-gate / crash resume). `Math.max` keeps it
      // monotonic and order-independent — it reconciles with the `budget:paused.spentMicrocents` restore
      // (applyGateEvent) regardless of which durable cost source has the higher sequence number.
      if (event.cumulativeCostMicrocents !== undefined) {
        acc.cumulativeCostMicrocents = Math.max(
          acc.cumulativeCostMicrocents,
          event.cumulativeCostMicrocents,
        );
      }
      break;
    case 'node:failed':
      acc.nodeStates.set(event.nodeId, {
        status: 'failed',
        error: {
          code: event.error.code,
          message: event.error.message,
          retryable: event.error.retryable,
        },
      });
      // The SAME durable cost restore as `node:completed` above, which this arm was missing (#W15-6). A node
      // that failed can still have SPENT: a paid media job billed provider-side before the failure, or a
      // provider call that returned usage and then failed downstream. `cost:updated` is streamed, never
      // persisted, so this snapshot is the only durable carrier — and a resume that skips it restores a
      // cumulative that has forgotten real spend, handing the cap headroom it does not have.
      if (event.cumulativeCostMicrocents !== undefined) {
        acc.cumulativeCostMicrocents = Math.max(
          acc.cumulativeCostMicrocents,
          event.cumulativeCostMicrocents,
        );
      }
      break;
    case 'node:skipped':
      acc.nodeStates.set(event.nodeId, { status: 'skipped' });
      break;
    default:
      // node:started (running at crash → omit, re-run) and node:retrying (a non-terminal retry attempt,
      // 1.S/ADR-0040 — the terminal is a later node:failed/node:completed) are non-state-bearing here.
      break;
  }
}

/**
 * Async media-job lifecycle (ADR-0045 §2-3): a `media_job:submitted` PARKS the node (a non-terminal
 * suspension) and records the job keyed by `nodeId` (latest submit replaces — a node-retry re-dispatch
 * mints a fresh job for the same node). The terminal clear lives in {@link applyNodeEvent}.
 */
function applyMediaJobEvent(acc: ReconAccumulator, event: RunEvent): void {
  if (event.type !== 'media_job:submitted') {
    return;
  }
  // Defensive: never resurrect a node that has already SETTLED. The emit-order invariant (a submit precedes
  // its node's terminal) holds, so this is belt-and-suspenders — but it makes the fold order-independent, so
  // a stale/duplicate submit folded after a node:completed/failed/skipped cannot re-park the node or re-add a
  // cleared entry.
  const settled = acc.nodeStates.get(event.nodeId)?.status;
  if (settled === 'completed' || settled === 'failed' || settled === 'skipped') {
    return;
  }
  acc.nodeStates.set(event.nodeId, { status: 'paused' });
  acc.pendingMediaJobs.set(event.nodeId, {
    nodeId: event.nodeId,
    jobId: event.jobId,
    provider: event.provider,
    model: event.model,
    modality: event.modality,
    startedAt: event.startedAt,
    deadlineAt: event.deadlineAt,
    // Carried through verbatim, never defaulted: ABSENT is the signal that this row predates ADR-0074 §3, and
    // substituting a value here would erase the very distinction the resume path needs.
    ...(event.units === undefined ? {} : { units: event.units }),
    ...(event.acceptedCostMicrocents === undefined
      ? {}
      : { acceptedCostMicrocents: event.acceptedCostMicrocents }),
  });
}

/** Human-gate / budget-gate lifecycle: park a pending gate, or resolve it (decision becomes the gate vertex output). */
function applyGateEvent(acc: ReconAccumulator, event: RunEvent): void {
  if (event.type === 'human_gate:paused' || event.type === 'budget:paused') {
    acc.nodeStates.set(event.nodeId, { status: 'paused' });
    const priorGate = acc.pendingGates.get(event.gateId);
    acc.pendingGates.set(event.gateId, {
      nodeId: event.nodeId,
      // Only `human_gate:paused` carries a deadline; a `budget:paused` companion shares the gateId and must
      // not erase what its sibling recorded (they arrive in either order for one gate — see the flag below).
      ...(event.type === 'human_gate:paused' && event.expiresAt !== undefined
        ? { expiresAt: event.expiresAt }
        : priorGate?.expiresAt === undefined
          ? {}
          : { expiresAt: priorGate.expiresAt }),
      ...(event.type === 'human_gate:paused' && event.timeoutAction !== undefined
        ? { timeoutAction: event.timeoutAction }
        : priorGate?.timeoutAction === undefined
          ? {}
          : { timeoutAction: priorGate.timeoutAction }),
      // A budget gate emits BOTH `budget:paused` then a companion `human_gate:paused` with the SAME gateId
      // (engine `#settlePaused`). OR the flag so the later human_gate:paused never downgrades a budget gate
      // to a plain human gate on reconstruction — else a resumed `rejected` budget gate would not fail the
      // run with `budget_exceeded` (the resume reject branch is gated on `isBudgetGate`).
      isBudgetGate: priorGate?.isBudgetGate === true || event.type === 'budget:paused',
    });
    // `cost:updated` is streamed (not persisted), so the cost cannot be recovered from it; but
    // `budget:paused.spentMicrocents` IS the durable cumulative-at-pause. Restore it so a resumed budgeted run
    // keeps its spend and the re-seeded governor blocks correctly (H2). A plain-human-gate / crash resume now
    // recovers the same total from the durable `node:completed.cumulativeCostMicrocents` (applyNodeEvent above) —
    // the two durable sources reconcile via that `Math.max` fold (cost-event persistence is no longer deferred).
    //
    // `Math.max`, not an ASSIGN — which is what this was, while the comment above already claimed otherwise.
    // `spentMicrocents` is captured at `checkPreEgress` and the event is emitted much later, after the
    // outcome propagates through `#onOutcome`/`#settlePaused`. Under a `fan_out` a sibling attempt can settle
    // a HIGHER cumulative in that window, and an assign then clobbers it — handing the resumed cap headroom
    // for money already spent, which is the exact bypass ADR-0074/ADR-0076 exist to close. Latent before the
    // realized ledger, because `node:completed` was the only other writer and node boundaries are rarer;
    // `cost:attempt_settled` multiplies the high-water marks available to clobber.
    if (event.type === 'budget:paused') {
      acc.cumulativeCostMicrocents = Math.max(acc.cumulativeCostMicrocents, event.spentMicrocents);
    }
    return;
  }
  if (event.type !== 'human_gate:resumed') {
    return;
  }
  // The decision IS the gate vertex's output (engine resume: output = payload ?? { decision }).
  acc.nodeStates.set(event.nodeId, {
    status: 'completed',
    output: event.payload === undefined ? { decision: event.decision } : event.payload,
  });
  // Collect this gate's pending ids first, then mutate — never delete while iterating the Map.
  const resolvedForNode = [...acc.pendingGates]
    .filter(([, entry]) => entry.nodeId === event.nodeId)
    .map(([gateId]) => gateId);
  for (const gateId of resolvedForNode) {
    acc.pendingGates.delete(gateId);
    acc.resolvedGateIds.add(gateId);
  }
}

/**
 * Pure reconstruction: fold the ordered event stream into a {@link CheckpointState}. Total + deterministic
 * (same events → same state — the basis of idempotent resume). The caller passes events in persisted
 * (sequence) order; this does not re-sort (the store/bus already guarantee order). The per-category
 * appliers ({@link applyRunEvent} / {@link applyNodeEvent} / {@link applyGateEvent}) keep this fold flat.
 */
export function reconstructCheckpointState(
  events: readonly RunEvent[],
): CheckpointState | undefined {
  const acc: ReconAccumulator = {
    started: false,
    workflowId: '',
    startedAtMs: 0,
    // A log with no `run:started` yields these defaults, and the caller of `reconstructCheckpointState`
    // already refuses such a log (`started` is false) — so they are never read, only well-typed.
    admittedInputs: {},
    executionMode: 'local',
    runStatus: 'running',
    lastSequenceNumber: -1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cumulativeCostMicrocents: 0,
    conservativeCostMicrocents: 0,
    nodeStates: new Map(),
    pendingGates: new Map(),
    pendingMediaJobs: new Map(),
    resolvedGateIds: new Set(),
  };

  for (const event of events) {
    acc.lastSequenceNumber = Math.max(acc.lastSequenceNumber, event.sequenceNumber);
    if (event.type === 'cost:updated') {
      acc.cumulativeCostMicrocents = event.cumulativeCostMicrocents; // already a running total
    }
    if (event.type === 'budget:estimate_committed') {
      // SUM the per-commitment delta (ADR-0074 §2) — never a LAST-WINS read of the event's own
      // `cumulativeConservativeMicrocents`, whose seq order is not guaranteed under a `fan_out` and could restore
      // a LOWER total. (`Math.max` over those snapshots would also be correct today; the sum is what survives
      // §1's future release. See the field's doc for the full comparison.)
      acc.conservativeCostMicrocents += event.estimateMicrocents;
    }
    if (event.type === 'cost:attempt_settled') {
      // `Math.max` over the event's ABSOLUTE cumulative — the same fold `node:completed` / `node:failed` use
      // two arms above, and deliberately NOT the sum-of-deltas its conservative sibling uses. Three things
      // make that the right choice, and two plausible alternatives are wrong:
      //
      // - SUMMING `costMicrocents` into this field DOUBLE-COUNTS: a node terminal's snapshot already contains
      //   the attempts it covers, and both write here.
      // - Summing into a SEPARATE accumulator and taking the max at the end UNDER-counts, which is subtler.
      //   The two families cover different money: a media node writes a snapshot and emits no attempt row at
      //   all, so `max(snapshots, sum(attempts))` silently drops every attempt made after the last boundary
      //   whenever earlier media spend is the larger number.
      // - `Math.max` over absolute totals has neither failure. The producer reads this counter AFTER folding
      //   this attempt into it, so the value is a true run-wide total at that instant, exactly like a node
      //   boundary's — and the largest one seen is the engine's real total no matter what order the rows land
      //   in.
      //
      // ADR-0074 §2 rejected `Math.max` for the CONSERVATIVE total, and that reasoning does not carry: it was
      // rejected only because a future deliberate release would DECREASE that total. Realized spend has no
      // release and is monotonic by construction.
      acc.cumulativeCostMicrocents = Math.max(
        acc.cumulativeCostMicrocents,
        event.cumulativeCostMicrocents,
      );
    }
    applyRunEvent(acc, event);
    applyNodeEvent(acc, event);
    applyMediaJobEvent(acc, event);
    applyGateEvent(acc, event);
  }

  if (!acc.started) {
    return undefined;
  }
  const completedNodeIds = [...acc.nodeStates]
    .filter(([, s]) => s.status === 'completed')
    .map(([id]) => id);
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runStatus: acc.runStatus,
    workflowId: acc.workflowId,
    startedAtMs: acc.startedAtMs,
    admittedInputs: acc.admittedInputs,
    executionMode: acc.executionMode,
    nodeStates: acc.nodeStates,
    completedNodeIds,
    pendingGates: [...acc.pendingGates].map(([gateId, entry]) => ({
      gateId,
      nodeId: entry.nodeId,
      isBudgetGate: entry.isBudgetGate,
      ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
      ...(entry.timeoutAction === undefined ? {} : { timeoutAction: entry.timeoutAction }),
    })),
    pendingMediaJobs: [...acc.pendingMediaJobs.values()],
    resolvedGateIds: [...acc.resolvedGateIds],
    lastSequenceNumber: acc.lastSequenceNumber,
    totalInputTokens: acc.totalInputTokens,
    totalOutputTokens: acc.totalOutputTokens,
    cumulativeCostMicrocents: acc.cumulativeCostMicrocents,
    conservativeCostMicrocents: acc.conservativeCostMicrocents,
  };
}
