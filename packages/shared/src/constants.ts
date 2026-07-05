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
 * `RunEvent` union in the spec: `agent:approval_requested` + `agent:file_patch_proposed` sit after
 * `agent:tool_result`, and the four governance events (`run:paused`, `run:timeout`, `budget:warning`,
 * `budget:paused`; ADR-0028) close the list.
 */
export const RUN_EVENT_TYPES = [
  'run:started',
  'node:started',
  'agent:token',
  'agent:tool_call',
  'agent:tool_result',
  // A side-effecting tool dispatch is awaiting an interactive per-tool approval decision (ADR-0057 EA3/EA5).
  // A dual-envelope event (runId on a run, sessionId on a session); in Phase 2.5 it is session-only (the chat
  // approval regime). The host's ConfirmActionHook emits it before prompting; never carries a secret.
  'agent:approval_requested',
  'agent:file_patch_proposed',
  'cost:updated',
  'node:completed',
  'node:failed',
  'node:skipped',
  'node:retrying',
  'media_job:submitted',
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
  'session:compacting', // ADR-0062 — context compaction STARTED (the "Summarizing…" moment; paired with the below)
  'session:compacted', // ADR-0062 — model-summarised context compaction applied
  'session:trimmed', // ADR-0062 — deterministic history trim applied (no LLM call)
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * The closed **`ErrorCode`** taxonomy (sse-event-schema.md §"Error-code taxonomy").
 * `node:failed` / `run:failed` / `session:turn_completed` carry one of these as
 * `error.code` (never a free string), so a surface can branch on cause. The
 * retryable/fatal mapping is owned by docs/standards/error-handling.md.
 * `turn_limit` is the limit-family code for a HARD agent/session turn/round cap
 * (the knob is settled at 1.V): distinct from `run_timeout`/`budget_exceeded` so a
 * capped conversation surfaces its own cause instead of a silent stop. Not to be
 * confused with `[chat].max_messages`, which is a history-trim threshold
 * (config-spec.md) — trimming continues the session and emits no error.
 */
export const ERROR_CODES = [
  'validation',
  // A provider content-policy rejection (text or media-generation) — a FATAL cause distinct from
  // `validation` (an authoring/shape error), so a surface shows the right reason/remediation. The
  // `content_filter` LlmErrorKind maps here (1.AG/ADR-0045 §6); not in RETRYABLE_ERROR_CODES.
  'content_filter',
  'provider_auth',
  'provider_rate_limit',
  'provider_unavailable',
  'tool_denied',
  'tool_failed',
  // A required `ToolHost` capability arm (`fs` / `process` / `egress` / …) was not wired — a host/config
  // gap, not the model's fault (EA1, ADR-0055; the dispatch-layer `ToolUnavailableError`). FATAL and NOT in
  // RETRYABLE_ERROR_CODES — re-issuing the same call against the same host just re-fails. Distinct from
  // `internal` (an unexpected engine fault) so a surface names the missing capability + the tool actionably,
  // and from `tool_denied` (a policy/grant denial of a *present* capability).
  'tool_unavailable',
  'budget_exceeded',
  'run_timeout',
  'turn_limit',
  'cancelled',
  'sandbox_error',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The `ErrorCode`s a node-retry budget (1.S, [ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md))
 * may re-attempt — the **transient** failures of [error-handling.md](../standards/error-handling.md): a
 * provider rate-limit / unavailability that exhausted the fallback chain, a transient tool-execution failure,
 * and a sandbox **wall-clock-timeout** (`sandbox_error`; the deterministic sandbox failures are
 * `retryable: false` and excluded at the engine gate, not here). The single source of which authored
 * `retry_on` codes are valid — a `retry_on` member outside this set is rejected at parse (ADR-0040 A.4).
 * Retryability of a *runtime* failure is still decided by `NodeFailure.retryable`; this set only bounds the
 * authored `retry_on` filter.
 */
export const RETRYABLE_ERROR_CODES = [
  'provider_rate_limit',
  'provider_unavailable',
  'tool_failed',
  'sandbox_error',
] as const satisfies readonly ErrorCode[];
export type RetryableErrorCode = (typeof RETRYABLE_ERROR_CODES)[number];

/**
 * The side-effecting **tool ACTION classes** a per-tool approval governs (ADR-0057 EA3). Derived from a
 * tool's `ToolPolicyClass` (tool-registry.md): `fs_write` (a `write_file`), `process` (a model-controlled
 * `run_command` — **not** the pre-approved `git_status`, which exposes no model command), `egress`
 * (`http_request` / `web_search` / `mcp_call`), and `os` (`read_clipboard` / `notify` — the clipboard is
 * ambient, un-jailed OS state that routinely holds a freshly-copied secret, so a READ is an exfiltration
 * sink, and `notify` paints a native desktop notification; both are gated like any governed action, ADR-0057
 * §security review). Read-only fs reads + `git_status` are **not** governed (mirrors
 * [ADR-0041](../decisions/0041-external-action-governance-seam.md) §ActionClass). Carried by
 * `agent:approval_requested` and the engine's `ConfirmActionHook`; it lives here so `@relavium/shared` owns
 * the vocabulary and the engine derives its `ToolActionClass` type from this one list (no second home).
 */
export const TOOL_ACTION_CLASSES = ['fs_write', 'process', 'egress', 'os'] as const;
export type ToolActionClass = (typeof TOOL_ACTION_CLASSES)[number];

/**
 * The five-value LLM **stop reason** vocabulary, used today by `session:turn_completed`.
 * Intended canonical home: `@relavium/shared`, with the `@relavium/llm` seam re-exporting it
 * rather than redefining it. (The seam doc still defines it locally; codifying the re-export is
 * tracked in deferred-tasks alongside `ContentPart`.)
 */
export const STOP_REASONS = ['stop', 'length', 'tool_use', 'content_filter', 'error'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/**
 * The **session** turn stop-reason vocabulary — the five LLM {@link STOP_REASONS} **plus** `aborted`, the
 * user's **mid-turn abort** (ADR-0057 EA7: `Esc` ends the in-flight turn but keeps the session alive, so the
 * turn settles with `session:turn_completed{stopReason:'aborted'}`, **not** `session:cancelled`). `aborted` is
 * a session-lifecycle concept, **not** an LLM stop reason, so it lives here and the `@relavium/llm` seam's
 * `StopReason` stays the clean five-value set. Only `session:turn_completed.stopReason` uses this superset.
 */
export const SESSION_STOP_REASONS = [...STOP_REASONS, 'aborted'] as const;
export type SessionStopReason = (typeof SESSION_STOP_REASONS)[number];

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
 * A model's **media-output surface** (`model_catalog.media_surface`, 1.AG/ADR-0045 §1). `'chat'`
 * (default) routes an agent node to the normal turn with `output_modalities`; `'generative'` routes
 * it to the separate-endpoint `generateMedia()` (sync or async LRO). Data-drives the inline-vs-generative
 * dispatch (no hardcoded model ids). Projects onto `CapabilityFlags.media.surface` in `@relavium/llm`.
 */
export const MEDIA_SURFACES = ['chat', 'generative'] as const;
export type MediaSurface = (typeof MEDIA_SURFACES)[number];

/**
 * The async media-job (generateMedia LRO) poll cadence + deadline DEFAULTS (1.AG/ADR-0045 §7). The single
 * source of these magic numbers — the engine poll loop (Section D) uses them directly: poll at `pollInitialMs`,
 * exponential-back-off (no jitter) capped at `pollMaxMs`, abandon a job past `deadlineMs` (from submit) as a
 * retryable timeout. The `[defaults].media_job_poll_initial_ms` / `_max_ms` / `_deadline_ms` config OVERRIDES
 * exist + validate (config.ts), but the engine does NOT yet read them — wiring the host-resolved overrides into
 * the run loop (the `max_tokens_estimate` pattern) is 1.AH host-wiring, like the other `[defaults].*` reads.
 */
export const MEDIA_JOB_POLL_DEFAULTS = {
  pollInitialMs: 5_000,
  pollMaxMs: 30_000,
  deadlineMs: 1_800_000, // 30 min
} as const;

/**
 * The **media reference scope kinds** persisted in the `media_references` junction (ADR-0042 §3).
 * A deliberate **superset** with two roles: `run` / `node` references are refcount + terminal-sweep
 * lifetime entries only, while `session` / `workspace` are **also** the `read_media` authz `Scope`
 * kinds (ADR-0044). The refcount derives from ALL rows; the terminal sweep reclaims the `run` rows;
 * `read_media` authz consults ONLY {@link MEDIA_AUTHZ_SCOPE_KINDS} rows — a `run`/`node` reference
 * never grants read. `workspace` is **reserved** (documented, not implemented) so cross-session
 * shared-asset reads are an additive scope kind with no handle-model migration.
 */
export const MEDIA_SCOPE_KINDS = ['run', 'node', 'session', 'workspace'] as const;
export type MediaScopeKind = (typeof MEDIA_SCOPE_KINDS)[number];

/** The subset of {@link MEDIA_SCOPE_KINDS} that GRANTS `read_media` access (ADR-0044, A8). */
export const MEDIA_AUTHZ_SCOPE_KINDS = ['session', 'workspace'] as const;
export type MediaAuthzScopeKind = (typeof MEDIA_AUTHZ_SCOPE_KINDS)[number];

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
 * The three provider **protocol kinds** (the `kind` abstraction, [ADR-0064] §2) — a closed vocabulary
 * that derives, **once per protocol rather than per provider**, the adapter factory, the list-models
 * endpoint, the auth style, and the response mapper. `anthropic` and `gemini` map 1:1 to their id;
 * `openai` and `deepseek` share `openai-compatible` (DeepSeek is the OpenAI-compatible adapter at a
 * custom base URL). This is a SEPARATE axis from the provider **id** ({@link LLM_PROVIDERS}), which
 * stays the closed persisted-contract enum; `kind` is the protocol axis `@relavium/llm` derives from
 * it (`providerKind`). The enum itself stays closed — an open custom-provider registry is future work
 * (ADR-0065), not this one.
 */
export const PROVIDER_KINDS = ['anthropic', 'openai-compatible', 'gemini'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

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
