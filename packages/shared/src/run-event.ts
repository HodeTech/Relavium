import { z } from 'zod';

import { nonEmptyString, nonNegativeInt, positiveInt } from './common.js';
import { EXECUTION_MODES } from './constants.js';
import { GateTypeSchema } from './node.js';

/**
 * The run-event stream contract (sse-event-schema.md). Every run produces one ordered
 * stream of `RunEvent` objects, identical on every surface and transport. Event names
 * are the canonical **colon-namespaced** form; the per-event ordinal is `sequenceNumber`.
 */

/** Fields every event carries (the `BaseEvent` envelope), minus the discriminator. */
const baseFields = {
  runId: nonEmptyString,
  timestamp: z.string().datetime({ offset: true }), // ISO 8601 (UTC `Z` or an offset)
  sequenceNumber: nonNegativeInt,
};

/** The common envelope, exported for consumers that need the base shape alone. */
export const BaseEventSchema = z.object({ type: z.string(), ...baseFields });
export type BaseEvent = z.infer<typeof BaseEventSchema>;

export const TokensUsedSchema = z.object({
  input: nonNegativeInt,
  output: nonNegativeInt,
  model: nonEmptyString,
});
export type TokensUsed = z.infer<typeof TokensUsedSchema>;

/** A gate decision value, shared by the resumed event and `GateDecision`. */
export const GateDecisionValueSchema = z.enum(['approved', 'rejected', 'input_provided']);
export type GateDecisionValue = z.infer<typeof GateDecisionValueSchema>;

export const RunStartedEventSchema = z.object({
  type: z.literal('run:started'),
  ...baseFields,
  workflowId: nonEmptyString,
  inputs: z.record(z.string(), z.unknown()), // secret-typed inputs are masked at emit time
  executionMode: z.enum(EXECUTION_MODES),
});

export const NodeStartedEventSchema = z.object({
  type: z.literal('node:started'),
  ...baseFields,
  nodeId: nonEmptyString,
  nodeType: nonEmptyString,
});

export const AgentTokenEventSchema = z.object({
  type: z.literal('agent:token'),
  ...baseFields,
  nodeId: nonEmptyString,
  token: z.string(),
  model: nonEmptyString,
});

export const AgentToolCallEventSchema = z.object({
  type: z.literal('agent:tool_call'),
  ...baseFields,
  nodeId: nonEmptyString,
  model: nonEmptyString, // the invoking model — attributable across a failover
  toolId: nonEmptyString,
  toolInput: z.unknown(), // sanitized — no secrets
});

export const AgentToolResultEventSchema = z.object({
  type: z.literal('agent:tool_result'),
  ...baseFields,
  nodeId: nonEmptyString,
  toolId: nonEmptyString,
  success: z.boolean(),
  outputSummary: z.string(),
});

export const CostUpdatedEventSchema = z.object({
  type: z.literal('cost:updated'),
  ...baseFields,
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
  ...baseFields,
  nodeId: nonEmptyString,
  output: z.unknown(),
  tokensUsed: TokensUsedSchema,
  durationMs: nonNegativeInt,
});

export const NodeFailedEventSchema = z.object({
  type: z.literal('node:failed'),
  ...baseFields,
  nodeId: nonEmptyString,
  error: z.object({ code: nonEmptyString, message: z.string(), retryable: z.boolean() }),
});

export const HumanGatePausedEventSchema = z.object({
  type: z.literal('human_gate:paused'),
  ...baseFields,
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
  ...baseFields,
  nodeId: nonEmptyString,
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString,
  payload: z.unknown().optional(),
});
export type HumanGateResumedEvent = z.infer<typeof HumanGateResumedEventSchema>;

/** Either human-gate event (convenience union). */
export type HumanGateEvent = HumanGatePausedEvent | HumanGateResumedEvent;

export const RunCompletedEventSchema = z.object({
  type: z.literal('run:completed'),
  ...baseFields,
  outputs: z.record(z.string(), z.unknown()),
  totalTokensUsed: z.object({ input: nonNegativeInt, output: nonNegativeInt }),
  totalCostMicrocents: nonNegativeInt, // integer micro-cents closing total for the run
  durationMs: nonNegativeInt,
});

export const RunFailedEventSchema = z.object({
  type: z.literal('run:failed'),
  ...baseFields,
  error: z.object({ code: nonEmptyString, message: z.string(), nodeId: z.string().optional() }),
  partialOutputs: z.record(z.string(), z.unknown()),
});

export const RunCancelledEventSchema = z.object({
  type: z.literal('run:cancelled'),
  ...baseFields,
});

/** The full discriminated union every surface consumes. */
export const RunEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  NodeStartedEventSchema,
  AgentTokenEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  CostUpdatedEventSchema,
  NodeCompletedEventSchema,
  NodeFailedEventSchema,
  HumanGatePausedEventSchema,
  HumanGateResumedEventSchema,
  RunCompletedEventSchema,
  RunFailedEventSchema,
  RunCancelledEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

// Per-variant inferred types, for consumers that handle a specific event.
export type RunStartedEvent = z.infer<typeof RunStartedEventSchema>;
export type NodeStartedEvent = z.infer<typeof NodeStartedEventSchema>;
export type AgentTokenEvent = z.infer<typeof AgentTokenEventSchema>;
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;
export type NodeCompletedEvent = z.infer<typeof NodeCompletedEventSchema>;
export type NodeFailedEvent = z.infer<typeof NodeFailedEventSchema>;
export type RunCompletedEvent = z.infer<typeof RunCompletedEventSchema>;
export type RunFailedEvent = z.infer<typeof RunFailedEventSchema>;
export type RunCancelledEvent = z.infer<typeof RunCancelledEventSchema>;

/** The decision applied to resume a human gate (`engine.resume(runId, gateId, decision)`). */
export const GateDecisionSchema = z.object({
  decision: GateDecisionValueSchema,
  decidedBy: nonEmptyString, // user id or 'timeout_escalation'
  payload: z.unknown().optional(),
  comment: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;
