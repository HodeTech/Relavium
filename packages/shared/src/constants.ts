/**
 * Canonical literal constants shared across the schema set. Two roles:
 * - **Directly validated vocabularies** — providers, execution modes, error codes, stop
 *   reasons, fs-scope tiers are consumed via `z.enum(...)`, so the constant *is* the
 *   validated set.
 * - **Parallel authoritative lists** — run-event names and the node-type taxonomies are a
 *   single source of truth that the discriminated unions re-declare by hand (a `z.literal`
 *   per member); tests pin the two in lock-step so they never drift.
 */

/** The workflow/agent YAML schema version this package targets. */
export const SCHEMA_VERSION = '1.0';
export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * The canonical, **colon-namespaced** run-event type names (sse-event-schema.md).
 * Never the legacy dotted names (`node.started`), never `node:error`/`run:error`,
 * and the per-event ordinal is always `sequenceNumber`, never `seqNo`. Order mirrors the
 * `RunEvent` union in the spec: `agent:file_patch_proposed` sits after `agent:tool_result`, and
 * the four governance events (`run:paused`, `run:timeout`, `budget:warning`, `budget:paused`;
 * ADR-0028) close the list.
 */
export const RUN_EVENT_TYPES = [
  'run:started',
  'node:started',
  'agent:token',
  'agent:tool_call',
  'agent:tool_result',
  'agent:file_patch_proposed',
  'cost:updated',
  'node:completed',
  'node:failed',
  'human_gate:paused',
  'human_gate:resumed',
  'run:completed',
  'run:failed',
  'run:cancelled',
  'run:paused',
  'run:timeout',
  'budget:warning',
  'budget:paused',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * The five **`session:*`** lifecycle event names for an agent session
 * (sse-event-schema.md §"Session event namespace", [ADR-0024]). Disjoint from
 * `RUN_EVENT_TYPES`; within a turn a session also reuses `agent:token` /
 * `agent:tool_call` / `agent:tool_result` / `cost:updated` carried on the session
 * envelope (`sessionId`).
 */
export const SESSION_EVENT_TYPES = [
  'session:started',
  'session:turn_started',
  'session:turn_completed',
  'session:cancelled',
  'session:exported',
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * The closed **`ErrorCode`** taxonomy (sse-event-schema.md §"Error-code taxonomy").
 * `node:failed` / `run:failed` / `session:turn_completed` carry one of these as
 * `error.code` (never a free string), so a surface can branch on cause. The
 * retryable/fatal mapping is owned by docs/standards/error-handling.md.
 */
export const ERROR_CODES = [
  'validation',
  'provider_auth',
  'provider_rate_limit',
  'provider_unavailable',
  'tool_denied',
  'tool_failed',
  'budget_exceeded',
  'run_timeout',
  'cancelled',
  'sandbox_error',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The five-value LLM **stop reason** vocabulary, used today by `session:turn_completed`.
 * Intended canonical home: `@relavium/shared`, with the `@relavium/llm` seam re-exporting it
 * rather than redefining it. (The seam doc still defines it locally; codifying the re-export is
 * tracked in deferred-tasks alongside `ContentPart`.)
 */
export const STOP_REASONS = ['stop', 'length', 'tool_use', 'content_filter', 'error'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

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

/**
 * The eleven **engine** node types (node-types.md §"engine enum") — the runtime taxonomy the
 * engine executes and the `node:started` run event carries. It differs from the authored set
 * above: `parallel`/`merge` expand to `fan_out`/`fan_in`, and `tool`/`loop`/`subworkflow` are
 * engine-only. node-types.md is the canonical home for the taxonomy.
 */
export const ENGINE_NODE_TYPES = [
  'agent',
  'condition',
  'tool',
  'transform',
  'input',
  'output',
  'loop',
  'fan_out',
  'fan_in',
  'human_in_the_loop',
  'subworkflow',
] as const;
export type EngineNodeType = (typeof ENGINE_NODE_TYPES)[number];

/** The four supported LLM providers (the `LLMProvider` seam's closed id set). */
export const LLM_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

/**
 * The three filesystem permission tiers (built-in-tools.md). The canonical vocabulary
 * for the config `fs_scope` (config-spec.md) and a session's `fsScopeTier`
 * (agent-session-spec.md), so both derive their enum from this one list.
 */
export const FS_SCOPE_TIERS = ['sandboxed', 'project', 'full'] as const;
export type FsScopeTier = (typeof FS_SCOPE_TIERS)[number];

/** The three execution modes (local BYOK, cloud BYOK-central, managed gateway). */
export const EXECUTION_MODES = ['local', 'cloud', 'managed'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/**
 * What a resource-governance cap does when exceeded (ADR-0028). Shared by a workflow
 * `budget.on_exceed` (workflow-yaml-spec.md) and a chat session's `[chat].on_exceed`
 * (config-spec.md) — the same governor backs both.
 */
export const ON_EXCEED_ACTIONS = ['fail', 'pause_for_approval', 'warn'] as const;
export type OnExceedAction = (typeof ON_EXCEED_ACTIONS)[number];
