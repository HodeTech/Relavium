/**
 * The `NodeExecutor` seam (1.N) — the boundary the run loop dispatches each ready vertex through, and
 * the contract the later workstreams **fill**: the `AgentRunner` (1.O) for `agent` vertices and the
 * node-type handlers (1.P) for `condition` / `transform` / `fan_out` / `fan_in` / `input` / `output` /
 * `human_in_the_loop`. 1.N owns the *loop* (readiness, skip-propagation, the event stream, the
 * exactly-one-terminal-event guarantee, cancellation); it does **not** execute node bodies. Keeping the
 * executor an injected interface lets the loop be proven end-to-end with stub executors before 1.O/1.P
 * exist, and lets a real executor plug in unchanged.
 *
 * A node sees only its **declared inputs** (its config block + the settled upstream outputs it resolves
 * `{{ … }}` against), never the whole run state or another node's transcript — context isolation
 * ([shared-core-engine.md](../../../../docs/architecture/shared-core-engine.md)). Streaming events a
 * node produces mid-execution (`agent:token` / `agent:reasoning` / `agent:tool_call` / `agent:tool_result` /
 * `cost:updated` / `agent:file_patch_proposed`) are emitted through {@link NodeExecContext.emit}; the
 * envelope (`runId` / `timestamp` / `sequenceNumber`) is stamped centrally by the bus, so a node hands
 * over only the event body. A node is responsible for sanitizing its own `toolInput` (no secrets)
 * before emitting — the producer-side translation point validates, it does not redact.
 */

import type {
  AbortSignalLike,
  ErrorCode,
  HumanGatePausedEvent,
  LlmProviderId,
  MediaBilledModality,
  TokensUsed,
  ToolPolicy,
} from '@relavium/shared';

import type { MediaJobStatus } from '@relavium/llm';

import type { RunEventDraft } from './event-bus.js';
import type { PlanVertex } from '../run-plan.js';

/** The gate-type triad (`approval` | `input` | `review`), derived from the event contract. */
export type GateType = HumanGatePausedEvent['gateType'];

/** The event types a node may emit *during* its own execution (carried on the run/session envelope). */
type InNodeEventType =
  | 'agent:token'
  | 'agent:reasoning'
  | 'agent:tool_call'
  | 'agent:tool_result'
  | 'cost:updated'
  | 'agent:file_patch_proposed';

/** Distribute `Omit` across each union member so the discriminated union (and `.type` narrowing) survives. */
type DistributiveKeyOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An in-node streaming event body — one of the in-node event types, minus the envelope the bus stamps
 * (`runId` / `sessionId` / `timestamp` / `sequenceNumber`). The executor sets the payload (incl.
 * `nodeId`); the engine attaches the correlation key + sequence. Distributive, so a consumer can narrow
 * on `event.type` and reach a member's own fields (e.g. `cost:updated`'s `costMicrocents`).
 */
export type NodeStreamEvent = DistributiveKeyOmit<
  Extract<RunEventDraft, { type: InNodeEventType }>,
  'runId' | 'sessionId'
>;

/** A node failure mapped to the closed `ErrorCode` taxonomy (`@relavium/shared`, error-handling.md). */
export interface NodeFailure {
  readonly code: ErrorCode;
  /** User-safe, secret-free; the internal correlation id rides the event, not this message. */
  readonly message: string;
  readonly retryable: boolean;
}

/** A node's request to suspend the run at a human gate (`human_in_the_loop` → `human_gate:paused`). */
export interface GateRequest {
  /** Stable id the resume path keys on; the engine generates one when the executor omits it. */
  readonly gateId?: string;
  readonly gateType: GateType;
  readonly message: string;
  readonly assignee?: string;
  readonly timeoutMs?: number;
  /**
   * What the engine does if the gate's `timeoutMs` elapses with no decision (1.Q): `approve` auto-resolves
   * the gate as approved (`decidedBy: 'timeout'`, the run continues); `reject` fails the run with
   * `run_timeout` (execution-model.md `AwaitingGate → Failed`). The handler supplies it from the node's
   * `timeout_action` (defaulting to the safe `reject`); it is only acted on when `timeoutMs` is set.
   */
  readonly timeoutAction?: 'approve' | 'reject';
  /** The wall-clock deadline; the engine computes it from `timeoutMs` against its clock when omitted. */
  readonly expiresAt?: string;
  /**
   * Budget-gate only (ADR-0028, 1.AC): the figures carried on the paired `budget:paused` event so a
   * surface can show spent/limit before it decides whether to continue.
   */
  readonly spentMicrocents?: number;
  readonly limitMicrocents?: number;
  /**
   * Set by the budget governor so the engine can treat a `rejected` decision as a run-level
   * `budget_exceeded` failure rather than completing the gate vertex.
   */
  readonly isBudgetGate?: boolean;
}

/**
 * An async media-generation job the executor submitted but cannot await synchronously (Sora/Veo,
 * minute-scale LROs — 1.AG Section D, [ADR-0045](../../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)).
 * The executor resolved the provider + submitted the job (`generateMedia` → `{ jobId }`); the ENGINE then
 * owns the poll/checkpoint/resume/cancel loop. The opaque `jobId` is re-polled (never re-submitted), so the
 * record carries everything the loop needs to poll + price the result without the executor: `provider` +
 * `model` re-resolve the adapter + credential (the key is NEVER persisted — re-resolved on resume), `modality`
 * de-inlines + prices the `done` media, and `units` is the authored volume for the lone realized cost addend
 * (ADR-0045 §5). `units` is recomputed from the node config on cross-process resume (it is not persisted).
 */
export interface MediaJobSubmission {
  readonly jobId: string;
  readonly provider: LlmProviderId;
  readonly model: string;
  readonly modality: MediaBilledModality;
  /** The authored output volume (count for image; duration_seconds for audio/video) → the realized cost addend. */
  readonly units: number;
  /** Optional override of `MEDIA_JOB_POLL_DEFAULTS.deadlineMs`; the engine computes `deadlineAt` against its clock. */
  readonly deadlineMs?: number;
}

/**
 * The result of executing one vertex. Discriminated on `kind`:
 * - `completed` — the node produced an `output` (and, for an LLM node, `tokensUsed`).
 * - `failed` — a classified failure; the run loop maps it to `node:failed` and fails the run (node
 *   retry above the provider chain is 1.S, layered later).
 * - `branch` — a `condition` node's routing: `selected` lists the immediate target vertex ids to keep
 *   live; every other dependent of the condition is skip-propagated by the loop.
 * - `paused` — a `human_in_the_loop` node suspends the run; the loop emits `human_gate:paused`, parks
 *   the gate, and continues other branches until it resumes via `engine.resume`.
 * - `media_job` — a generative node submitted an async media job; the loop emits `media_job:submitted`,
 *   parks the node (reusing the gate suspend machinery), and drives the poll loop to terminal (1.AG Section D).
 */
export type NodeOutcome =
  | { readonly kind: 'completed'; readonly output: unknown; readonly tokensUsed?: TokensUsed }
  | { readonly kind: 'failed'; readonly error: NodeFailure }
  | {
      readonly kind: 'branch';
      readonly output?: unknown;
      readonly selected: readonly string[];
      readonly tokensUsed?: TokensUsed;
    }
  | { readonly kind: 'paused'; readonly gate: GateRequest }
  | { readonly kind: 'media_job'; readonly job: MediaJobSubmission };

/** The context handed to a node executor for one dispatch of one vertex. */
export interface NodeExecContext {
  /** The vertex being executed — its engine type, config block, and un-evaluated input templates. */
  readonly vertex: PlanVertex;
  /** Settled upstream outputs by vertex id — the data the node resolves its `{{ run.outputs }}` against. */
  readonly runOutputs: ReadonlyMap<string, unknown>;
  /** The run-wide inputs (the `input` namespace); a `secret`-typed input is carried per the taint rules. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /**
   * The resolved workflow `context:` namespace (the `ctx.*` reads) — the engine resolves it **once** at run
   * start (the spec's eager-once context; `resolveContext`) and threads the frozen result here, so a bare
   * `ctx.key` JS read in a `condition`/`transform`/`merge_fn` expression (and an agent prompt) sees the real
   * value, not `undefined`. `{}` when the workflow declares no `context:`. Values are strings (resolved
   * templates); a `secret`-derived context value is gated at parse by the taint analyzer, never here.
   */
  readonly ctx: Readonly<Record<string, string>>;
  /**
   * The names of `secret`-typed inputs (`inputs.<name>` declared `type: secret`). A handler that emits
   * inputs into a node output (the `input` node) or into the expression sandbox (`condition`/`transform`/
   * `merge_fn`) MUST mask/omit these so a raw secret never reaches an event payload or an expression — the
   * engine masks `inputs` only for `run:started`, so the handler is the second gate (CLAUDE.md rule 6;
   * sse-event-schema.md; the sandbox's "secrets are never injected — the caller filters" contract).
   */
  readonly secretInputNames: ReadonlySet<string>;
  /**
   * The workflow-wide tool policy (`allowedCommands` / `allowedCommandGlobs` / `allowedDomains` —
   * [ADR-0029](../../../../docs/decisions/0029-tool-policy-hardening.md)) a tool-dispatching node
   * (the `AgentRunner` 1.O, the `tool` handler 1.P) threads into the `ToolHost` dispatch. The engine
   * sources it from `workflow.tools` (empty ⇒ deny-all for allowlist-gated tools, the secure default).
   */
  readonly toolPolicy: ToolPolicy;
  /** Emit a streaming event mid-execution; the engine stamps the envelope and routes it to the bus. */
  emit: (event: NodeStreamEvent) => void;
  /** Aborts when the run is cancelled, fails elsewhere, or times out — thread it into provider/tool calls. */
  readonly signal: AbortSignalLike;
  /** 1-based attempt number for this dispatch (always 1 in 1.N; node-level retry is 1.S). */
  readonly attemptNumber: number;
  /**
   * Pre-egress budget hook (ADR-0028, 1.AC). Supplied by the run loop when a workflow `budget` is
   * configured; the agent runner forwards it into the turn core / fallback chain so every provider
   * attempt is gated before egress.
   */
  readonly preEgress?: import('./agent-turn.js').PreEgressHook;
}

/** The injected per-vertex executor. 1.O (`AgentRunner`) and 1.P (node handlers) implement it. */
export interface NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome>;
  /**
   * Poll an async media job the executor previously submitted (1.AG Section D, ADR-0045 §3). The ENGINE owns
   * the poll/checkpoint/resume/cancel loop, but provider + credential resolution lives in the executor (the
   * `resolveProvider`/`keyFor` capabilities), so the engine delegates the actual poll here. The executor
   * re-resolves the adapter + key from `job.provider` and calls `provider.pollMediaJob(job.jobId, key, signal)`.
   * `signal` aborts the in-flight poll on a run cancel. Optional — an executor with no generative providers
   * (or before Section D is wired) omits it; the engine treats its absence as a host-wiring gap (`internal`).
   */
  pollMediaJob?(job: MediaJobSubmission, signal: AbortSignalLike): Promise<MediaJobStatus>;
}
