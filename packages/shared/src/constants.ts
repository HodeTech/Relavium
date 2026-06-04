/**
 * Canonical literal constants shared across the schema set. These are the single
 * source of truth for the closed vocabularies the rest of the package validates
 * against (event names, node types, providers, execution modes).
 */

/** The workflow/agent YAML schema version this package targets. */
export const SCHEMA_VERSION = '1.0';
export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * The canonical, **colon-namespaced** run-event type names (sse-event-schema.md).
 * Never the legacy dotted names (`node.started`), never `node:error`/`run:error`,
 * and the per-event ordinal is always `sequenceNumber`, never `seqNo`.
 */
export const RUN_EVENT_TYPES = [
  'run:started',
  'node:started',
  'agent:token',
  'agent:tool_call',
  'agent:tool_result',
  'cost:updated',
  'node:completed',
  'node:failed',
  'human_gate:paused',
  'human_gate:resumed',
  'run:completed',
  'run:failed',
  'run:cancelled',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * The eight **authored** YAML node types (workflow-yaml-spec.md v1.0). The richer
 * canvas-component / engine-enum taxonomy (which adds `tool`, `loop`, `subworkflow`)
 * is reconciled in node-types.md; these eight are the user-authored surface.
 */
export const WORKFLOW_NODE_TYPES = [
  'input',
  'agent',
  'human_gate',
  'condition',
  'transform',
  'parallel',
  'merge',
  'output',
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** The four supported LLM providers (the `LLMProvider` seam's closed id set). */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

/** The three execution modes (local BYOK, cloud BYOK-central, managed gateway). */
export const EXECUTION_MODES = ['local', 'cloud', 'managed'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];
