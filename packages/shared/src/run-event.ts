import { z } from 'zod';

import { nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import {
  ENGINE_NODE_TYPES,
  ERROR_CODES,
  EXECUTION_MODES,
  FS_SCOPE_TIERS,
  STOP_REASONS,
} from './constants.js';
import { GateTypeSchema, TimeoutActionSchema } from './node.js';

/**
 * The run-event stream contract (sse-event-schema.md). A workflow run produces one ordered
 * stream of `RunEvent` objects (keyed by `runId`); an agent session produces a `SessionEvent`
 * stream (keyed by `sessionId`). Both share one base envelope and a monotonic `sequenceNumber`.
 * Event names are the canonical **colon-namespaced** form; events are intentionally lenient
 * (not `.strict()`) so adding an optional field stays forward-compatible.
 */

// --- The base envelope (sse-event-schema.md §"Event envelope") -------------------------------
// `timestamp` is ISO-8601 (UTC `Z` or an offset); `sequenceNumber` is monotonic per run OR per
// session. Exactly one correlation key — `runId` on a run, `sessionId` on a session — is present.

const timestampSeq = {
  timestamp: z.string().datetime({ offset: true }),
  sequenceNumber: nonNegativeInt,
};

/** A run-correlated event (`runId` required). */
const runBase = { runId: nonEmptyString, ...timestampSeq };

/** A session-correlated event (`sessionId` required). */
const sessionBase = { sessionId: nonEmptyString, ...timestampSeq };

/**
 * The dual envelope for the four events reused across both streams (`agent:token` /
 * `agent:tool_call` / `agent:tool_result` / `cost:updated`): they carry `runId` on a run and
 * `sessionId` on a session. A `discriminatedUnion` *member* can't carry a cross-field
 * refinement, so the "exactly one of runId / sessionId" invariant is enforced at the **union**
 * level (see `RunEventSchema`). Run-only / session-only events satisfy it by construction (the
 * other key isn't declared, so it is stripped on parse), so the check only constrains these four.
 */
const dualBase = {
  runId: nonEmptyString.optional(),
  sessionId: nonEmptyString.optional(),
  ...timestampSeq,
};

/** The common envelope (the spec's `BaseEvent`): both correlation keys optional at the type level. */
export const BaseEventSchema = z.object({ type: z.string(), ...dualBase });
export type BaseEvent = z.infer<typeof BaseEventSchema>;

// --- Shared field schemas --------------------------------------------------------------------

export const TokensUsedSchema = z.object({
  input: nonNegativeInt,
  output: nonNegativeInt,
  // Present only when an LLM produced the tokens. A non-agent node (condition, transform,
  // merge, …) completes with input/output 0 and no model — so `model` is optional here.
  model: nonEmptyString.optional(),
});
export type TokensUsed = z.infer<typeof TokensUsedSchema>;

/**
 * A secret-typed `run:started` input, masked at emit time — the raw value is replaced with a
 * keychain/env `ref` (sse-event-schema.md §Security). Never carries the secret itself. The named
 * contract every surface renders for a masked input value.
 */
export const MaskedSecretSchema = z
  .object({ secret: z.literal(true), ref: nonEmptyString })
  .strict(); // reject any extra field so a raw secret value can never ride alongside the masked shape
export type MaskedSecret = z.infer<typeof MaskedSecretSchema>;

/** A gate decision value, shared by the resumed event and `GateDecision`. */
export const GateDecisionValueSchema = z.enum(['approved', 'rejected', 'input_provided']);
export type GateDecisionValue = z.infer<typeof GateDecisionValueSchema>;

/**
 * The closed `ErrorCode` taxonomy carried by `node:failed` / `run:failed` /
 * `session:turn_completed` (sse-event-schema.md §"Error-code taxonomy"). The retryable/fatal
 * mapping is owned by docs/standards/error-handling.md.
 */
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** The five-value LLM stop reason. Canonical home — the `@relavium/llm` seam re-exports this. */
export const StopReasonSchema = z.enum(STOP_REASONS);

/**
 * The shared failure shape: a closed `code`, a user-safe `message`, `retryable`, and an optional,
 * secret-free `correlationId` the engine stamps at the single producer-side translation point so a
 * surface can quote it and an operator can join it to the structured internal log (reconciles
 * error-handling.md's "user-safe message plus an internal correlation id"; ADR-0036). Additive and
 * forward-compatible — an emitter may omit it.
 */
const eventErrorFields = {
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  correlationId: nonEmptyString.optional(),
};

/**
 * The workspace situation a session runs against (agent-session-spec.md). Self-contained (no
 * cross-package types), so it lands here with the `SessionEvent` union. The `SessionMessage` /
 * `AgentSession` schemas land with the agent-first sub-spine (1.V/1.X): they reference
 * `ContentPart`, which must be **owned by `@relavium/shared`** and re-exported by the seam
 * (the `StopReason` precedent above) — never imported by shared from `@relavium/llm`, which
 * would invert the package dependency.
 */
export const SessionContextSchema = z.object({
  workingDir: nonEmptyString,
  activeFile: nonEmptyString.optional(),
  selection: z
    .object({ file: nonEmptyString, startLine: nonNegativeInt, endLine: nonNegativeInt })
    .refine((sel) => sel.startLine <= sel.endLine, {
      message: 'startLine must be <= endLine',
      path: ['endLine'],
    })
    .optional(),
  gitRef: nonEmptyString.optional(),
  fsScopeTier: z.enum(FS_SCOPE_TIERS),
  variables: z.record(z.string(), z.string()).optional(),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

// --- Run events (sse-event-schema.md §"The RunEvent union") -----------------------------------

export const RunStartedEventSchema = z.object({
  type: z.literal('run:started'),
  ...runBase,
  workflowId: z.string().uuid(), // FK to workflows.id (surrogate UUID), matching RunSchema — ADR-0022
  inputs: z.record(z.string(), z.unknown()), // a secret-typed input is masked at emit time as MaskedSecret ({ secret: true, ref }); a non-secret keeps its raw value
  executionMode: z.enum(EXECUTION_MODES),
});

export const NodeStartedEventSchema = z.object({
  type: z.literal('node:started'),
  ...runBase,
  nodeId: nonEmptyString,
  // The engine node type (node-types.md is the canonical taxonomy), not the authored YAML type —
  // `parallel`/`merge` have already expanded to `fan_out`/`fan_in` by the time the engine runs.
  nodeType: z.enum(ENGINE_NODE_TYPES),
  // 1-based dispatch attempt (1.S, ADR-0040). Absent ⇒ attempt 1; present + >1 ⇒ a node-retry re-dispatch,
  // so a surface distinguishes "attempt N starting" from a replay. The node may emit several of these.
  attemptNumber: positiveInt.optional(),
});

export const AgentTokenEventSchema = z.object({
  type: z.literal('agent:token'),
  ...dualBase,
  nodeId: nonEmptyString,
  token: z.string(),
  model: nonEmptyString,
});

export const AgentToolCallEventSchema = z.object({
  type: z.literal('agent:tool_call'),
  ...dualBase,
  nodeId: nonEmptyString,
  model: nonEmptyString, // the invoking model — attributable across a failover
  toolId: nonEmptyString,
  toolInput: z.unknown(), // sanitized — no secrets
  attemptNumber: positiveInt.optional(), // 1-based within-chain (FallbackChain) attempt — matches cost:updated
});

export const AgentToolResultEventSchema = z.object({
  type: z.literal('agent:tool_result'),
  ...dualBase,
  nodeId: nonEmptyString,
  toolId: nonEmptyString,
  success: z.boolean(),
  outputSummary: z.string(),
  attemptNumber: positiveInt.optional(), // 1-based within-chain attempt — matches cost:updated
});

export const AgentFilePatchProposedEventSchema = z.object({
  type: z.literal('agent:file_patch_proposed'),
  ...runBase,
  nodeId: nonEmptyString,
  // Gated — no write until the user accepts (e.g. the VS Code inline-diff review).
  // At least one patch — an empty proposal is meaningless (mirrors run:paused.gateIds).
  patches: z.array(z.object({ uri: nonEmptyString, unifiedDiff: z.string() })).min(1),
  attemptNumber: positiveInt.optional(), // 1-based within-chain attempt — matches cost:updated
});

export const CostUpdatedEventSchema = z.object({
  type: z.literal('cost:updated'),
  ...dualBase,
  nodeId: nonEmptyString,
  model: nonEmptyString,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  costMicrocents: nonNegativeInt, // integer micro-cents (canonical unit); from Relavium's pricing table, never the provider
  cumulativeCostMicrocents: nonNegativeInt, // integer micro-cents running total for the whole run
  // 1-based WITHIN-CHAIN (FallbackChain) attempt this cost belongs to; resets to 1 on each node-retry
  // re-dispatch. DISTINCT from node:*.attemptNumber (the node-retry dispatch index) — the two do NOT join.
  // To attribute cost to a node-retry attempt, partition the sequenceNumber-ordered stream at the
  // node:started / node:retrying boundaries; do not key by (nodeId, attemptNumber) across the two families.
  attemptNumber: positiveInt.optional(),
});
export type CostUpdatedEvent = z.infer<typeof CostUpdatedEventSchema>;

export const NodeCompletedEventSchema = z.object({
  type: z.literal('node:completed'),
  ...runBase,
  nodeId: nonEmptyString,
  output: z.unknown(),
  tokensUsed: TokensUsedSchema,
  durationMs: nonNegativeInt,
  // 1-based NODE-RETRY dispatch attempt (1.S, ADR-0040) — the same counter as node:started/node:failed.
  // Absent ⇒ attempt 1. DISTINCT from cost:updated/agent:* attemptNumber (the within-chain FallbackChain
  // index, which resets per node re-dispatch); the two counters do NOT join — see cost:updated above.
  attemptNumber: positiveInt.optional(),
  // The immediate downstream ids a `condition` kept live (its branch selection). Present ONLY for a
  // condition's branch outcome — it is the authoritative record checkpoint/resume (1.R) reconstructs
  // `selectedTargets` from, so a selected branch that was mid-flight at a crash re-runs (not skipped).
  // NOT `.min(1)`: an EMPTY `selected` is a valid outcome — a condition that routes to no branch, which
  // the engine skip-propagates across all downstream (engine.ts `#hasLiveEdge`); only the standard
  // condition handler never emits it (it fails without a default), but the engine contract allows it.
  selected: z.array(nonEmptyString).optional(),
});

export const NodeFailedEventSchema = z.object({
  type: z.literal('node:failed'),
  ...runBase,
  nodeId: nonEmptyString,
  error: z.object(eventErrorFields),
  // 1-based attempt this terminal failure belongs to (1.S, ADR-0040) — the last attempt when a node-retry
  // budget is exhausted. `node:failed` stays the single TERMINAL failure per node; per-attempt failures
  // surface as `node:retrying` (below).
  attemptNumber: positiveInt.optional(),
});

/**
 * A retryable node attempt failed and the engine will re-dispatch the whole node (1.S,
 * [ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md)) — **non-terminal**: it does NOT end the
 * node (the terminal is `node:failed`, emitted only when the budget is exhausted). Carries the failed attempt's
 * error (the `NodeFailure` shape, **no** `correlationId` — that anchors the terminal failure) and the `delayMs`
 * backoff before the next attempt. Checkpoint/resume folds it as non-state-bearing (like `node:started`).
 */
export const NodeRetryingEventSchema = z.object({
  type: z.literal('node:retrying'),
  ...runBase,
  nodeId: nonEmptyString,
  /** The attempt that just failed (1-based). The next attempt is `attemptNumber + 1`. */
  attemptNumber: positiveInt,
  // Derived from the canonical `eventErrorFields` (single source of truth) minus `correlationId` — which
  // anchors only the TERMINAL failure (`node:failed`), never a per-attempt retry. Deriving keeps this in
  // lockstep if a field is later added to the shared failure shape, instead of silently drifting.
  error: z.object(eventErrorFields).omit({ correlationId: true }),
  /** The backoff delay (ms) before the next attempt is dispatched. */
  delayMs: nonNegativeInt,
});

/** Why a node was skipped — `branch_not_taken` (a `condition` routed away) or `upstream_unreachable`. */
export const NodeSkippedReasonSchema = z.enum(['branch_not_taken', 'upstream_unreachable']);
export type NodeSkippedReason = z.infer<typeof NodeSkippedReasonSchema>;

/**
 * A vertex the run loop skip-propagated (a `condition` routed away from it, or every in-edge is dead
 * because an upstream was skipped/failed). Emitted so the event log is a **complete, replayable** record
 * — checkpoint/resume (1.R) reconstructs a skipped vertex from this event, and a surface can render the
 * dimmed path instead of seeing the node silently vanish.
 */
export const NodeSkippedEventSchema = z.object({
  type: z.literal('node:skipped'),
  ...runBase,
  nodeId: nonEmptyString,
  reason: NodeSkippedReasonSchema,
});

export const HumanGatePausedEventSchema = z.object({
  type: z.literal('human_gate:paused'),
  ...runBase,
  nodeId: nonEmptyString,
  gateId: nonEmptyString,
  gateType: GateTypeSchema,
  message: z.string(),
  assignee: z.string().optional(),
  timeoutMs: nonNegativeInt.optional(),
  // The on-timeout policy (present only with timeoutMs). Carried on the event so a surface can show how a
  // gate auto-resolves AND so a Phase-2 crash-resume can re-arm the timer from the persisted log (the
  // engine derives no separate gate record — execution-model.md). Absent ⇒ no timeout configured.
  timeoutAction: TimeoutActionSchema.optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type HumanGatePausedEvent = z.infer<typeof HumanGatePausedEventSchema>;

export const HumanGateResumedEventSchema = z.object({
  type: z.literal('human_gate:resumed'),
  ...runBase,
  nodeId: nonEmptyString,
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString, // user id, or 'timeout' when a gate auto-resolves on timeout
  payload: z.unknown().optional(),
});
export type HumanGateResumedEvent = z.infer<typeof HumanGateResumedEventSchema>;

/** Either human-gate event (convenience union). */
export type HumanGateEvent = HumanGatePausedEvent | HumanGateResumedEvent;

export const RunCompletedEventSchema = z.object({
  type: z.literal('run:completed'),
  ...runBase,
  outputs: z.record(z.string(), z.unknown()),
  totalTokensUsed: z.object({ input: nonNegativeInt, output: nonNegativeInt }),
  totalCostMicrocents: nonNegativeInt, // integer micro-cents closing total for the run
  durationMs: nonNegativeInt,
});

export const RunFailedEventSchema = z.object({
  type: z.literal('run:failed'),
  ...runBase,
  error: z.object({ ...eventErrorFields, nodeId: nonEmptyString.optional() }), // nodeId = root-cause node
  partialOutputs: z.record(z.string(), z.unknown()),
});

export const RunCancelledEventSchema = z.object({
  type: z.literal('run:cancelled'),
  ...runBase,
});

export const RunPausedEventSchema = z.object({
  type: z.literal('run:paused'),
  ...runBase,
  // The multi-gate aggregate — emitted while ≥1 gate is pending (parallel branches each gate).
  pendingGateCount: positiveInt,
  gateIds: z.array(nonEmptyString).min(1),
});

export const RunTimeoutEventSchema = z.object({
  type: z.literal('run:timeout'),
  ...runBase,
  elapsedMs: nonNegativeInt,
  timeoutMs: nonNegativeInt,
});

export const BudgetWarningEventSchema = z.object({
  type: z.literal('budget:warning'),
  ...runBase,
  spentMicrocents: nonNegativeInt,
  limitMicrocents: nonNegativeInt,
  thresholdPct: z.number().finite().min(0).max(100),
});

export const BudgetPausedEventSchema = z.object({
  type: z.literal('budget:paused'),
  ...runBase,
  spentMicrocents: nonNegativeInt,
  limitMicrocents: nonNegativeInt,
});

/** The run-event variants, discriminated on `type` (exposed via `RunEventSchema.innerType()`). */
const RunEventUnionSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  NodeStartedEventSchema,
  AgentTokenEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentFilePatchProposedEventSchema,
  CostUpdatedEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
  NodeSkippedEventSchema,
  NodeRetryingEventSchema,
  HumanGatePausedEventSchema,
  HumanGateResumedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
  RunPausedEventSchema,
  RunTimeoutEventSchema,
  BudgetWarningEventSchema,
  BudgetPausedEventSchema,
]);

/**
 * The full run-event schema every surface consumes: the discriminated union plus the
 * **exactly one of `runId` / `sessionId`** correlation-key invariant (sse-event-schema.md
 * §"Correlation key"). Run-only / session-only events satisfy it by construction — a stray
 * opposite key is stripped by their `z.object` before this refine runs, so the parsed output
 * stays compliant (the deliberate non-strict, forward-compatible posture). The four
 * dual-envelope events declare both keys as optional, so this is where neither/both is rejected.
 */
export const RunEventSchema = RunEventUnionSchema.superRefine((event, ctx) => {
  const hasRunId = 'runId' in event && event.runId !== undefined;
  const hasSessionId = 'sessionId' in event && event.sessionId !== undefined;
  if (hasRunId === hasSessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'exactly one of runId / sessionId must be present',
      path: [hasRunId ? 'sessionId' : 'runId'],
    });
  }
  // A gate's on-timeout policy only has meaning when a timeout is configured — refused at the union level
  // because a discriminatedUnion member can't carry its own cross-field refinement (see note above).
  if (
    event.type === 'human_gate:paused' &&
    event.timeoutAction !== undefined &&
    event.timeoutMs === undefined
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'timeoutAction is only valid when timeoutMs is also present',
      path: ['timeoutAction'],
    });
  }
});
export type RunEvent = z.infer<typeof RunEventSchema>;

// --- Session events (sse-event-schema.md §"Session event namespace") --------------------------

export const SessionStartedEventSchema = z.object({
  type: z.literal('session:started'),
  ...sessionBase,
  agentRef: nonEmptyString,
  model: nonEmptyString,
  context: SessionContextSchema,
});

export const SessionTurnStartedEventSchema = z.object({
  type: z.literal('session:turn_started'),
  ...sessionBase,
});

export const SessionTurnCompletedEventSchema = z.object({
  type: z.literal('session:turn_completed'),
  ...sessionBase,
  stopReason: StopReasonSchema,
  tokensUsed: TokensUsedSchema,
  // A failed turn (provider error, rate limit, cancellation) still completes — with an error.
  error: z.object(eventErrorFields).optional(),
});

export const SessionCancelledEventSchema = z.object({
  type: z.literal('session:cancelled'),
  ...sessionBase,
});

export const SessionExportedEventSchema = z.object({
  type: z.literal('session:exported'),
  ...sessionBase,
  workflowPath: nonEmptyString,
});

/**
 * The five `session:*` lifecycle events. Within a turn a session also reuses the four
 * dual-envelope events above (`agent:token` / `agent:tool_call` / `agent:tool_result` /
 * `cost:updated`), carried with `sessionId` — so the complete session stream is this union
 * plus those four.
 */
export const SessionEventSchema = z.discriminatedUnion('type', [
  SessionStartedEventSchema,
  SessionTurnStartedEventSchema,
  SessionTurnCompletedEventSchema,
  SessionCancelledEventSchema,
  SessionExportedEventSchema,
]);
export type SessionEvent = z.infer<typeof SessionEventSchema>;

// Per-variant inferred types, for consumers that handle a specific event. NOTE: this block is the
// rest of the per-variant exports — a few (CostUpdatedEvent, the HumanGate* events, SessionContext)
// are exported inline next to their schemas above; this trailing block is NOT the exhaustive set.
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;
export type AgentTokenEvent = z.infer<typeof AgentTokenEventSchema>;
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;
export type AgentFilePatchProposedEvent = z.infer<typeof AgentFilePatchProposedEventSchema>;
export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;
export type NodeFailedEvent = z.infer<typeof NodeFailedEventSchema>;
export type NodeSkippedEvent = z.infer<typeof NodeSkippedEventSchema>;
export type NodeRetryingEvent = z.infer<typeof NodeRetryingEventSchema>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;
export type RunPausedEvent = z.infer<typeof RunPausedEventSchema>;
export type RunTimeoutEvent = z.infer<typeof RunTimeoutEventSchema>;
export type BudgetWarningEvent = z.infer<typeof BudgetWarningEventSchema>;
export type BudgetPausedEvent = z.infer<typeof BudgetPausedEventSchema>;
export type SessionStartedEvent = z.infer<typeof SessionStartedEventSchema>;
export type SessionTurnStartedEvent = z.infer<typeof SessionTurnStartedEventSchema>;
export type SessionTurnCompletedEvent = z.infer<typeof SessionTurnCompletedEventSchema>;
export type SessionCancelledEvent = z.infer<typeof SessionCancelledEventSchema>;
export type SessionExportedEvent = z.infer<typeof SessionExportedEventSchema>;

/** The decision applied to resume a human gate (`engine.resume(runId, gateId, decision)`). */
export const GateDecisionSchema = z.object({
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString, // user id, or 'timeout' when a gate auto-resolves on timeout
  payload: z.unknown().optional(),
  comment: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;
