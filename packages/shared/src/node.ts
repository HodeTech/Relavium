import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, positiveInt } from './common.js';
import { RetrySchema } from './agent.js';

/**
 * The eight authored workflow node types (workflow-yaml-spec.md v1.0), modeled as
 * a discriminated union on `type`. Each node carries a kebab-case `id` unique within
 * the workflow. The richer canvas/engine taxonomy is reconciled in node-types.md;
 * `NodeSchema` validates the user-authored YAML surface only.
 */

/** Expression language for `condition` / `transform` (default `js`, engine-side). */
export const ExpressionTypeSchema = z.enum(['js', 'jmespath', 'jsonlogic']);

/** Human-gate kind. */
export const GateTypeSchema = z.enum(['approval', 'input', 'review']);

/** What a human gate does when its timeout elapses (canonical enum). */
export const TimeoutActionSchema = z.enum(['reject', 'approve', 'escalate']);

/** How a `merge` node combines its inputs (`best_of_n` is reserved, not v1.0). */
export const MergeStrategySchema = z.enum(['concat', 'object_merge', 'first', 'custom']);

export const InputNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('input'),
  label: z.string().optional(),
});

export const AgentNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('agent'),
  agent_ref: kebabIdSchema,
  prompt_template: z.string().optional(),
  tools: z.array(nonEmptyString).optional(),
  model: nonEmptyString.optional(),
  temperature: z.number().optional(),
  max_tokens: positiveInt.optional(),
  timeout_ms: positiveInt.optional(),
  retry: RetrySchema.optional(),
});

export const HumanGateNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('human_gate'),
  gate_type: GateTypeSchema,
  assignee: z.string().optional(),
  message_template: z.string().optional(),
  timeout_ms: positiveInt.optional(),
  timeout_action: TimeoutActionSchema.optional(),
});

/** A branch of a `condition` node: `when` value → `target_node`. */
export const ConditionBranchSchema = z.object({
  when: z.union([z.boolean(), z.string(), z.number()]),
  target_node: kebabIdSchema,
});

export const ConditionNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('condition'),
  expression: nonEmptyString,
  expression_type: ExpressionTypeSchema.optional(),
  branches: z.array(ConditionBranchSchema),
  default: kebabIdSchema.optional(),
});

export const TransformNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('transform'),
  transform: nonEmptyString,
  expression_type: ExpressionTypeSchema.optional(),
});

export const ParallelNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('parallel'),
  // Authoritative for branch membership; the parser materializes a fan-out edge per entry.
  parallel_of: z.array(kebabIdSchema).min(1),
});

export const MergeNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('merge'),
  merge_strategy: MergeStrategySchema,
  // Required only when merge_strategy = custom; enforced at the workflow level
  // (a discriminated-union option cannot carry a cross-field refinement).
  merge_fn: z.string().optional(),
});

export const OutputNodeSchema = z.object({
  id: kebabIdSchema,
  type: z.literal('output'),
  output_format: z.string().optional(),
});

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
