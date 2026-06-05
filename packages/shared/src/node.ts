import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, positiveInt, temperatureSchema } from './common.js';
import { RetrySchema } from './agent.js';

/**
 * The eight authored workflow node types (workflow-yaml-spec.md v1.0), modeled as
 * a discriminated union on `type`. Each node carries a kebab-case `id` unique within
 * the workflow. The richer canvas/engine taxonomy is reconciled in node-types.md;
 * `NodeSchema` validates the user-authored YAML surface only.
 *
 * Every node object is `.strict()`: an unknown or mistyped key in authored YAML is a
 * validation error, not a silently stripped field (ADR-0023).
 */

/**
 * Expression language for `condition` / `transform`. v1.0 ships **`js` only** (the deterministic
 * QuickJS sandbox, ADR-0027); `jmespath` / `jsonlogic` are reserved for a future ADR — each would
 * add an undeclared dependency — so an authored value of either is rejected at parse, not silently
 * accepted. (A custom `merge_fn` is always `js` and carries no `expression_type` selector.)
 */
export const ExpressionTypeSchema = z.enum(['js']);

/** Human-gate kind. */
export const GateTypeSchema = z.enum(['approval', 'input', 'review']);

/**
 * What a human gate does when its timeout elapses. `escalate` is **reserved in v1.0** (real
 * escalation needs the Phase-2 notification system), so the validator accepts only `reject` /
 * `approve`; a timeout then resolves with `decidedBy: 'timeout'` (workflow-yaml-spec.md).
 */
export const TimeoutActionSchema = z.enum(['reject', 'approve']);

/** How a `merge` node combines its inputs (`best_of_n` is reserved, not v1.0). */
export const MergeStrategySchema = z.enum(['concat', 'object_merge', 'first', 'custom']);

/**
 * An optional `output_schema` on `agent` / `transform` nodes — a JSON-Schema-subset object the
 * engine validates the node's output against (workflow-yaml-spec.md). Modeled as a permissive
 * object map here; the deep JSON-Schema-subset validation is an engine concern (1.L/1.P).
 */
export const OutputSchemaSchema = z.record(z.string(), z.unknown());

export const InputNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('input'),
    label: z.string().optional(),
  })
  .strict();

export const AgentNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('agent'),
    agent_ref: kebabIdSchema,
    system_prompt_append: z.string().optional(), // appended to the agent's system_prompt for THIS node
    prompt_template: z.string().optional(),
    tools: z.array(nonEmptyString).optional(), // NARROWS the agent's tools (never widens — ADR-0029)
    model: nonEmptyString.optional(),
    temperature: temperatureSchema.optional(), // provider-agnostic [0, 2] (common.ts)
    max_tokens: positiveInt.optional(),
    output_schema: OutputSchemaSchema.optional(),
    timeout_ms: positiveInt.optional(),
    retry: RetrySchema.optional(),
  })
  .strict();

export const HumanGateNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('human_gate'),
    gate_type: GateTypeSchema,
    assignee: z.string().optional(),
    message_template: z.string().optional(),
    timeout_ms: positiveInt.optional(),
    timeout_action: TimeoutActionSchema.optional(),
  })
  .strict();

/** A branch of a `condition` node: `when` value → `target_node`. */
export const ConditionBranchSchema = z
  .object({
    when: z.union([z.boolean(), z.string(), z.number()]),
    target_node: kebabIdSchema,
  })
  .strict();

export const ConditionNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('condition'),
    expression: nonEmptyString,
    expression_type: ExpressionTypeSchema.optional(),
    branches: z
      .array(ConditionBranchSchema)
      .min(1, 'a condition node must declare at least one branch'),
    default: kebabIdSchema.optional(),
  })
  .strict();

export const TransformNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('transform'),
    transform: nonEmptyString,
    expression_type: ExpressionTypeSchema.optional(),
    output_schema: OutputSchemaSchema.optional(),
  })
  .strict();

export const ParallelNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('parallel'),
    // Authoritative for branch membership; the parser materializes a fan-out edge per entry.
    parallel_of: z.array(kebabIdSchema).min(1),
  })
  .strict();

export const MergeNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('merge'),
    merge_strategy: MergeStrategySchema,
    // Required only when merge_strategy = custom; enforced at the workflow level
    // (a discriminated-union option cannot carry a cross-field refinement).
    merge_fn: z.string().optional(),
  })
  .strict();

export const OutputNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('output'),
    output_format: z.string().optional(),
  })
  .strict();

/** The authored node discriminated union. */
export const NodeSchema = z.discriminatedUnion('type', [
  InputNodeSchema,
  AgentNodeSchema,
  HumanGateNodeSchema,
  ConditionNodeSchema,
  TransformNodeSchema,
  ParallelNodeSchema,
  MergeNodeSchema,
  OutputNodeSchema,
]);
export type WorkflowNode = z.infer<typeof NodeSchema>;
