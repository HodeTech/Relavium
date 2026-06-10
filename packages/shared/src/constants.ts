/**
 * Canonical literal constants shared across the schema set. Two roles:
 * - **Directly validated vocabularies** — providers, execution modes, error codes, stop reasons,
 *   fs-scope tiers, and `ENGINE_NODE_TYPES` are consumed via `z.enum(...)` (e.g. `node:started.nodeType`
 *   in run-event.ts), so the constant *is* the validated set.
 * - **Parallel authoritative lists** — run-event names and `WORKFLOW_NODE_TYPES` are a single source
 *   of truth that a discriminated union re-declares by hand (`NodeSchema` carries a `z.literal` per
 *   variant); tests pin the two in lock-step so they never drift.
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
 * The four **media input modalities** a `media` content part can carry (ADR-0031). The modality
 * of a part is derived from its MIME type (`image/*`, `audio/*`, `video/*`, `application/pdf`),
 * never stored as a second field; `document` (PDF) is deliberately distinct from `image` — a
 * separate modality with a separate token/cost profile (maintainer decision A2). The matching
 * `CapabilityFlags.media.input` booleans in `@relavium/llm` gate each one.
 */
export const MEDIA_MODALITIES = ['image', 'audio', 'video', 'document'] as const;
export type MediaModality = (typeof MEDIA_MODALITIES)[number];

/**
 * The **output modalities** a request may ask an inline-surface model to emit
 * (`LlmRequest.outputModalities`, ADR-0031 decision #5) and the member vocabulary of a
 * `CapabilityFlags.media.outputCombinations` modality-set. Also the future vocabulary of the
 * authored `output_modalities` node field (1.AF), which is why it lives in `@relavium/shared`.
 * `document` is input-only — no provider emits a PDF as a chat-turn output.
 */
export const OUTPUT_MODALITIES = ['text', 'image', 'audio', 'video'] as const;
export type OutputModality = (typeof OUTPUT_MODALITIES)[number];

/**
 * The modalities billed as **media units** rather than tokens (`Usage.mediaUnits`, ADR-0031
 * decision #4). A deliberately **complete closed set**: `document` (PDF) and `text` bill as
 * tokens, so they are intentionally excluded, not forgotten (ADR-0031 §Freeze-criticality —
 * this inner enum is breaking-to-extend, like a union arm, so it ships complete now).
 */
export const MEDIA_BILLED_MODALITIES = ['image', 'audio', 'video'] as const;
export type MediaBilledModality = (typeof MEDIA_BILLED_MODALITIES)[number];

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
