import { z } from 'zod';

import { kebabIdSchema, nonEmptyString, nonNegativeInt } from './common.js';
import { SCHEMA_VERSION } from './constants.js';
import { AgentSchema } from './agent.js';
import { NodeSchema } from './node.js';
import { EdgeSchema } from './edge.js';

/**
 * Workflow YAML schema v1.0 (workflow-yaml-spec.md). A workflow is a
 * git-committable directed graph of nodes; it is a **public API**, so `WorkflowSchema`
 * is the migration anchor (`schema_version`) and unknown extra keys are **silently
 * stripped** (Zod's default `z.object` behavior) rather than rejected — so a newer
 * file's added optional fields never break an older parser (forward-compatible parsing).
 */

/** How a run is initiated. */
export const TriggerTypeSchema = z.enum([
  'manual',
  'webhook',
  'schedule',
  'file_change',
  'mcp_call',
]);

// `TriggerTypeSchema` above is the flat enum (used by the run record's `triggerType`).
// `TriggerSchema` is the *authored* form: a discriminated union so each type carries
// exactly its required payload (e.g. `webhook` must include `{ path, secret_env }`,
// `manual`/`mcp_call` carry none).
export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('webhook'),
    webhook: z.object({ path: nonEmptyString, secret_env: nonEmptyString }),
  }),
  z.object({ type: z.literal('schedule'), schedule: z.string() }), // cron expression
  z.object({
    type: z.literal('file_change'),
    file_change: z.object({ glob: nonEmptyString, debounce_ms: nonNegativeInt }),
  }),
  z.object({ type: z.literal('mcp_call') }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/** A typed workflow input declaration. */
export const InputTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'file_path',
  'code_diff',
  'secret',
]);

export const WorkflowInputSchema = z.object({
  name: nonEmptyString,
  type: InputTypeSchema,
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

/** A shared variable exposed as `{{ctx.key}}`. */
export const ContextEntrySchema = z.object({
  key: nonEmptyString,
  value: z.string(),
});
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/** Workflow-wide tool guardrails (the canonical home for the command allowlist). */
export const ToolPolicySchema = z.object({
  allowedCommands: z.array(z.string()).optional(),
  allowedDomains: z.array(z.string()).optional(),
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** The body under the top-level `workflow:` key. */
export const WorkflowSpecSchema = z.object({
  id: kebabIdSchema,
  version: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  trigger: TriggerSchema.optional(),
  inputs: z.array(WorkflowInputSchema).optional(),
  context: z.array(ContextEntrySchema).optional(),
  agents: z.array(AgentSchema).optional(),
  tools: ToolPolicySchema.optional(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** The complete workflow document: `schema_version` + `workflow`. */
export const WorkflowSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    workflow: WorkflowSpecSchema,
  })
  .superRefine((doc, ctx) => {
    const { nodes } = doc.workflow;

    // `merge_fn` is required when `merge_strategy` is `custom`.
    nodes.forEach((node, i) => {
      if (node.type === 'merge' && node.merge_strategy === 'custom' && !node.merge_fn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'merge_fn is required when merge_strategy is "custom"',
          path: ['workflow', 'nodes', i, 'merge_fn'],
        });
      }
    });

    // Referenced identifiers must be unique within a workflow — node ids, input names,
    // context keys, and agent ids are each addressed by reference (edges, `{{inputs.*}}`,
    // `{{ctx.*}}`, `agent_ref`), so a duplicate is an ambiguity, not a forward-compat field.
    const reportDuplicates = (values: string[], label: string, path: (string | number)[]) => {
      const seen = new Set<string>();
      const duplicates = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        seen.add(value);
      }
      if (duplicates.size > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${label}: ${[...duplicates].join(', ')}`,
          path,
        });
      }
    };
    reportDuplicates(
      nodes.map((n) => n.id),
      'node id(s)',
      ['workflow', 'nodes'],
    );
    reportDuplicates(
      (doc.workflow.inputs ?? []).map((i) => i.name),
      'input name(s)',
      ['workflow', 'inputs'],
    );
    reportDuplicates(
      (doc.workflow.context ?? []).map((c) => c.key),
      'context key(s)',
      ['workflow', 'context'],
    );
    reportDuplicates(
      (doc.workflow.agents ?? []).map((a) => a.id),
      'agent id(s)',
      ['workflow', 'agents'],
    );

    // `parallel_of` is authoritative for branch membership: an explicit edge out of a
    // `parallel` node must target a node listed in that node's `parallel_of`
    // (workflow-yaml-spec.md). Explicit fan-out edges are redundant with `parallel_of`,
    // but if present they must not contradict it.
    const branchesByParallelId = new Map<string, readonly string[]>();
    for (const node of nodes) {
      if (node.type === 'parallel') branchesByParallelId.set(node.id, node.parallel_of);
    }
    doc.workflow.edges.forEach((edge, i) => {
      const fromId = edge.from.split(':')[0] ?? edge.from;
      const branches = branchesByParallelId.get(fromId);
      if (branches && !branches.includes(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge from parallel node '${fromId}' targets '${edge.to}', which is not in its parallel_of`,
          path: ['workflow', 'edges', i, 'to'],
        });
      }
    });

    // Note: `agent_ref` → agent resolution and `agents` presence are NOT validated here.
    // An agent node's agent may be declared inline, in a sibling `.agent.yaml`, or in the
    // workspace agent registry — only the engine, with the full registry, can resolve it.
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
