import { z } from 'zod';

import { nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import { ERROR_CODES, EXECUTION_MODES, FS_SCOPE_TIERS, STOP_REASONS } from './constants.js';
import { GateTypeSchema } from './node.js';

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
 * `sessionId` on a session. "Exactly one present" is an **emit-time invariant** the engine
 * upholds — it is deliberately not Zod-enforced here, because a `discriminatedUnion` member
 * cannot carry a cross-field refinement and these events stay lenient (non-strict).
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

/** The shared failure shape: a closed `code`, a user-safe `message`, and `retryable`. */
const eventErrorFields = {
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
};

/**
 * The workspace situation a session runs against (agent-session-spec.md). Self-contained (no
 * seam types), so it lands here with the `SessionEvent` union; the `SessionMessage` /
 * `AgentSession` schemas — which depend on the seam's `ContentPart` — land with the
 * agent-first sub-spine (1.V/1.X).
 */
export const SessionContextSchema = z.object({
  workingDir: nonEmptyString,
  activeFile: nonEmptyString.optional(),
  selection: z
    .object({ file: nonEmptyString, startLine: nonNegativeInt, endLine: nonNegativeInt })
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
  inputs: z.record(z.string(), z.unknown()), // secret-typed inputs are masked at emit time
  executionMode: z.enum(EXECUTION_MODES),
});

export const NodeStartedEventSchema = z.object({
  type: z.literal('node:started'),
  ...runBase,
  nodeId: nonEmptyString,
  nodeType: nonEmptyString,
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
  attemptNumber: positiveInt.optional(), // 1-based retry attempt (matches cost:updated)
});

export const AgentToolResultEventSchema = z.object({
  type: z.literal('agent:tool_result'),
  ...dualBase,
  nodeId: nonEmptyString,
  toolId: nonEmptyString,
  success: z.boolean(),
  outputSummary: z.string(),
  attemptNumber: positiveInt.optional(),
});

export const AgentFilePatchProposedEventSchema = z.object({
  type: z.literal('agent:file_patch_proposed'),
  ...runBase,
  nodeId: nonEmptyString,
  // Gated — no write until the user accepts (e.g. the VS Code inline-diff review).
  patches: z.array(z.object({ uri: nonEmptyString, unifiedDiff: z.string() })),
  attemptNumber: positiveInt.optional(),
});

export const CostUpdatedEventSchema = z.object({
  type: z.literal('cost:updated'),
  ...dualBase,
  nodeId: nonEmptyString,
  model: nonEmptyString,
  inputTokens: nonNegativeInt,
  outputTokens: nonNegativeInt,
  costMicrocents: nonNegativeInt, // integer micro-cents (canonical unit); from Relavium's pricing table, never the provider
  cumulativeCostMicrocents: nonNegativeInt,
  attemptNumber: positiveInt.optional(), // 1-based retry attempt this cost belongs to
});
export type CostUpdatedEvent = z.infer<typeof CostUpdatedEventSchema>;

export const NodeCompletedEventSchema = z.object({
  type: z.literal('node:completed'),
  ...runBase,
  nodeId: nonEmptyString,
  output: z.unknown(),
  tokensUsed: TokensUsedSchema,
  durationMs: nonNegativeInt,
  attemptNumber: positiveInt.optional(), // 1-based retry attempt (matches cost:updated)
});

export const NodeFailedEventSchema = z.object({
  type: z.literal('node:failed'),
  ...runBase,
  nodeId: nonEmptyString,
  error: z.object(eventErrorFields),
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
  error: z.object({ ...eventErrorFields, nodeId: z.string().optional() }), // nodeId = root-cause node
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

/** The full run-event discriminated union every surface consumes. */
export const RunEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  NodeStartedEventSchema,
  AgentTokenEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentFilePatchProposedEventSchema,
  CostUpdatedEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
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

// Per-variant inferred types, for consumers that handle a specific event.
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;
export type AgentTokenEvent = z.infer<typeof AgentTokenEventSchema>;
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;
export type AgentFilePatchProposedEvent = z.infer<typeof AgentFilePatchProposedEventSchema>;
export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;
export type NodeFailedEvent = z.infer<typeof NodeFailedEventSchema>;
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
