import { z } from 'zod';

import {
  jsonSchemaMetadataSchema,
  kebabIdSchema,
  nonEmptyString,
  positiveInt,
  temperatureSchema,
} from './common.js';
import { OUTPUT_MODALITIES } from './constants.js';
// RetrySchema is owned by agent.ts; node.ts depends on agent.ts one-way — agent.ts must never
// import node.ts (the dependency stays acyclic).
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

/**
 * The authored `output_modalities` on an `agent` node (1.AF, ADR-0031/0044) — the non-text output a
 * turn requests, lowered to `LlmRequest.outputModalities`. Member vocabulary is `OUTPUT_MODALITIES`
 * (`text` | `image` | `audio` | `video`); `document` is **not** an output modality (PDF is input-only),
 * so it is rejected by the enum. An **empty array is rejected** (`.min(1)`): omit the field to request
 * the default (text). Load-time MEMBERSHIP against the model's `media.outputCombinations` is a separate
 * engine-loader pass (1.AF) — the schema only constrains the vocabulary.
 */
export const OutputModalitiesSchema = z
  .array(z.enum(OUTPUT_MODALITIES))
  .min(1, 'output_modalities must declare at least one modality (omit the field for text-only)');

/**
 * The authored `save_to` on an `output` node (1.AF, ADR-0031/0044, A9) — a **relative** path template
 * the surface writes generated media bytes to (the engine carries the handle on the edge; bytes
 * materialize only at the surface boundary). It may interpolate **only `{{ run.id }}`** — never
 * `inputs`/`ctx`/`run.outputs` (a filesystem path must not draw arbitrary authored data into it).
 * Authored fail-fast: an absolute path, a `..` traversal segment, or a non-`run.id` interpolation is
 * rejected at parse; the host write port additionally enforces `realpath`+`commonpath` fail-closed
 * against a scope root (security-review.md §Media byte delivery). The deep path discipline is the
 * host's; these are the authoring guards.
 */
export const SaveToSchema = nonEmptyString
  .refine((p) => !p.startsWith('/') && !p.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(p), {
    // Reject an absolute POSIX path ("/…"), a Windows drive ("C:\" / "C:/"), and a leading backslash —
    // which also covers a UNC path ("\\server\share"). The host write port's realpath+commonpath gate is
    // the binding control on the interpolated result; this is the authoring fail-fast.
    message: 'save_to must be a relative path (no leading "/" or "\\", and no drive letter)',
  })
  .refine((p) => !p.split(/[\\/]/).includes('..'), {
    message: 'save_to must not contain a ".." path segment',
  })
  .refine((p) => !p.replace(/\{\{\s*run\.id\s*\}\}/g, '').includes('{{'), {
    // The run.id-only reference restriction (1.AF, ADR-0044 §2; workflow-yaml-spec.md): a save_to path
    // template may interpolate ONLY `{{ run.id }}`. Strip every well-formed `{{ run.id }}` (whitespace-
    // tolerant) and reject if any `{{` remains — so a non-`run.id` reference (`{{ inputs.x }}`), a filtered
    // `{{ run.id | … }}`, a trailing-path `{{ run.id.x }}`, a degenerate `{{}}`, or a brace-in-string
    // `{{ run.outputs["a}b"] }}` is caught at LOAD (CLI exit 2), never a mid-run surprise. This is a check,
    // NOT a second interpolation parser: it shares no grammar with the engine lexer, so it cannot diverge into
    // accepting a reference the engine resolves to nothing at runtime. A literal (no `{{`) save_to is allowed.
    message:
      'save_to may interpolate only `{{ run.id }}` (no inputs/ctx/run.outputs in a filesystem path)',
  });

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
export const OutputSchemaSchema = jsonSchemaMetadataSchema;

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
    output_modalities: OutputModalitiesSchema.optional(), // non-text output request (1.AF, ADR-0031/0044)
    // Media-volume knobs for a `media_surface: 'generative'` model (1.AG Section C, ADR-0045 §1): the author's
    // requested output volume, mapped to `MediaGenRequest.count`/`durationSeconds` at dispatch. `count` =
    // images per call (image generators); `duration_seconds` = target length (audio/video generators). Inline
    // on the agent node (no nested `agent_config` object); ignored by a `'chat'` model. node-types.md is SSOT.
    count: positiveInt.optional(),
    duration_seconds: z.number().positive().optional(),
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
    retry: RetrySchema.optional(), // above-chain node-retry budget (ADR-0040) — the expression runs in the sandbox
  })
  .strict();

export const TransformNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('transform'),
    transform: nonEmptyString,
    expression_type: ExpressionTypeSchema.optional(),
    output_schema: OutputSchemaSchema.optional(),
    retry: RetrySchema.optional(), // above-chain node-retry budget (ADR-0040) — the expression runs in the sandbox
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
    retry: RetrySchema.optional(), // above-chain node-retry budget (ADR-0040) — a custom merge_fn runs in the sandbox
  })
  .strict();

export const OutputNodeSchema = z
  .object({
    id: kebabIdSchema,
    type: z.literal('output'),
    output_format: z.string().optional(),
    save_to: SaveToSchema.optional(), // surface-only media write target (1.AF, ADR-0031/0044, A9)
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
