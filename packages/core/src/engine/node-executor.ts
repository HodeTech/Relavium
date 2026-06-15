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
 * node produces mid-execution (`agent:token` / `agent:tool_call` / `agent:tool_result` /
 * `cost:updated` / `agent:file_patch_proposed`) are emitted through {@link NodeExecContext.emit}; the
 * envelope (`runId` / `timestamp` / `sequenceNumber`) is stamped centrally by the bus, so a node hands
 * over only the event body. A node is responsible for sanitizing its own `toolInput` (no secrets)
 * before emitting — the producer-side translation point validates, it does not redact.
 */

import type {
  AbortSignalLike,
  ErrorCode,
  HumanGatePausedEvent,
  TokensUsed,
  ToolPolicy,
} from '@relavium/shared';

import type { RunEventDraft } from './event-bus.js';
import type { PlanVertex } from '../run-plan.js';

/** The gate-type triad (`approval` | `input` | `review`), derived from the event contract. */
export type GateType = HumanGatePausedEvent['gateType'];

/** The event types a node may emit *during* its own execution (carried on the run/session envelope). */
type InNodeEventType =
  | 'agent:token'
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
  | { readonly kind: 'paused'; readonly gate: GateRequest };

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
}

/** The injected per-vertex executor. 1.O (`AgentRunner`) and 1.P (node handlers) implement it. */
export interface NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome>;
}
