import {
  EXECUTION_MODES,
  FS_SCOPE_TIERS,
  MEDIA_MODALITIES,
  MEDIA_SCOPE_KINDS,
  RunStatusSchema,
  SessionStatusSchema,
  type ExecutionMode,
  type FsScopeTier,
  type MediaModality,
  type MediaScopeKind,
  type MediaSurface,
  type ModelCatalogSource,
  type ProviderKind,
  type RunStatus,
  type SessionStatus,
} from '@relavium/shared';
import { desc, sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The Phase-1 local table set, modeling the canonical DDL in
 * [database-schema.md](../../../docs/reference/shared-core/database-schema.md) as a Drizzle
 * SQLite schema. **One schema, two dialects** ([ADR-0005](../../../docs/decisions/0005-sqlite-drizzle-local-postgres-cloud.md)):
 * table and column names are kept dialect-identical so the Phase-2 Postgres port is a
 * driver/dialect change, not a rewrite.
 *
 * Conventions enforced here (from database-schema.md §conventions):
 * - **UUID** primary keys are `TEXT`, generated in application code — never a DB default.
 * - **JSON** documents are stored as `TEXT` (a JSON string; queried with `json_extract`).
 *   Kept as `string` at this layer; typed accessors are a consumer concern (Phase 1).
 * - **Timestamps** are `INTEGER` Unix **epoch-milliseconds** (timezone handled in app code).
 * - **Money** is `INTEGER` **micro-cents** (1 micro-cent = 1e-8 USD).
 * - **Enums** are `TEXT` + a `CHECK (... IN (...))` constraint — never a native enum type.
 *   The `runs.status` and `runs.execution_mode` value sets are imported from
 *   `@relavium/shared` so the persisted CHECK can never drift from the logical contract.
 * - **Booleans** are `INTEGER` 0/1 (Drizzle `mode: 'boolean'`).
 * - **Soft delete** is a nullable `deleted_at` epoch-ms cursor with partial unique/active
 *   indexes (`WHERE deleted_at IS NULL`).
 *
 * No engine wiring lives here — this is schema/migrations only (Phase 0 workstream 0.I);
 * the FK-cascade and index choices come straight from the reference DDL.
 */

// --- Column-convention helpers (each returns a fresh builder per call) ---

/** UUID stored as TEXT, generated in application code (no DB default). */
const uuidPk = () => text('id').primaryKey();
/** Epoch-millisecond timestamp stored as INTEGER. */
const epochMs = (name: string) => integer(name);
/** Integer micro-cents (money), defaulting to 0. */
const microcents = (name: string) => integer(name).notNull().default(0);
/** A non-negative token counter, defaulting to 0. */
const tokenCount = (name: string) => integer(name).notNull().default(0);
/** A JSON document stored as a TEXT string. */
const jsonText = (name: string) => text(name);

/** An INTEGER bool (0/1) flag with a 0/1 default, matching the canonical DDL exactly
 * (Drizzle `mode: 'boolean'` reads/writes JS booleans over the 0/1 storage). */
const boolFlag = (name: string, def: boolean) =>
  integer(name, { mode: 'boolean' })
    .notNull()
    .default(def ? sql`1` : sql`0`);

/** A `CHECK (col IN ('a','b',...))` from a closed value list. Values come from our own
 * `as const` constants (never user input); the single-quote escape is belt-and-suspenders
 * so the helper is safe even if a value with a quote is ever passed. */
const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(', '));

// --- 1. llm_providers (no FKs) ---

export const llmProviders = sqliteTable(
  'llm_providers',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    displayName: text('display_name').notNull(),
    baseUrl: text('base_url').notNull(),
    // keychain `account` identifier — NEVER the key itself (ADR-0006).
    apiKeyKeychainRef: text('api_key_keychain_ref'),
    defaultHeaders: jsonText('default_headers').notNull().default('{}'),
    // ADR-0065 §5: the provider's protocol `kind` (a custom OpenAI-compatible `base_url` reuses it) + a pricing
    // page `pricing_reference_url` (a UX pointer for user-supplied pricing, S10). Both NULLABLE — populated for
    // uniformity, load-bearing only for a custom provider; validated against `PROVIDER_KINDS` at the store read
    // boundary (no DB CHECK — SQLite `ALTER ADD` limitation), mirroring `model_catalog.source`.
    kind: text('kind').$type<ProviderKind>(),
    pricingReferenceUrl: text('pricing_reference_url'),
    isActive: boolFlag('is_active', true),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_llm_providers_name')
      .on(t.name)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 2. model_catalog (-> llm_providers) ---

export const modelCatalog = sqliteTable(
  'model_catalog',
  {
    id: uuidPk(),
    providerId: text('provider_id')
      .notNull()
      .references(() => llmProviders.id),
    modelId: text('model_id').notNull(),
    displayName: text('display_name').notNull(),
    contextWindowTokens: integer('context_window_tokens').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    inputCostPerMtokMicrocents: microcents('input_cost_per_mtok_microcents'),
    outputCostPerMtokMicrocents: microcents('output_cost_per_mtok_microcents'),
    cachedInputCostPerMtokMicrocents: microcents('cached_input_cost_per_mtok_microcents'),
    /**
     * Did the USER actually state a cache-read rate (ADR-0071 §10)?
     *
     * The money column is `NOT NULL DEFAULT 0`, so it cannot tell "the user typed `--cached 0`" — a genuinely free
     * cache on a self-hosted endpoint — apart from "the user never mentioned cache reads". Reading a stored `0` as
     * "free" bills a whole class of tokens at nothing; reading it as "unset" discards an explicit instruction. One
     * money column cannot hold both meanings, so the FACT of the statement gets its own flag.
     *
     * `0` ⇒ not stated: the cache rate is derived at read time from the catalog's cache DISCOUNT applied to the
     * user's own input rate (never the catalog's absolute rate — a user who negotiated $0.10/MTok on a model whose
     * catalog cache rate is $0.50 would otherwise pay 5× MORE for a cache hit than for a miss).
     */
    cachedInputStated: boolFlag('cached_input_stated', false),
    // Per-modality media-OUTPUT rates (1.AF/D17, ADR-0044 §3) — integer µ¢ per billed unit (per image,
    // per audio-second, per video-second). NULLABLE: a model with no metered media rate degrades to 0
    // (H4). The projection of `ModelPricing.mediaOutputRates`; no shipped model carries one yet.
    mediaImageCostMicrocents: integer('media_image_cost_microcents'),
    mediaAudioCostMicrocents: integer('media_audio_cost_microcents'),
    mediaVideoCostMicrocents: integer('media_video_cost_microcents'),
    // Inline-vs-generative media-output routing (1.AG/ADR-0045 §1): a 'generative' model routes an agent
    // node to generateMedia() (separate-endpoint sync / async-LRO); 'chat' (default) uses the normal turn
    // with output_modalities. Projects onto CapabilityFlags.media.surface; data-driven (no hardcoded ids).
    // Value-set enforced by the `MediaSurface` type + the closed `MEDIA_SURFACES` set (and, at the seam,
    // the optional `CapabilityFlags.media.surface = z.enum(MEDIA_SURFACES)`). A DB CHECK is deferred:
    // SQLite does not support adding a CHECK via `ALTER TABLE ADD COLUMN` — enforcing it would need a full
    // table-rebuild migration (the sibling enum checks live in the initial CREATE; this column is an ALTER ADD).
    mediaSurface: text('media_surface').$type<MediaSurface>().notNull().default('chat'),
    supportsToolCalling: boolFlag('supports_tool_calling', false),
    supportsVision: boolFlag('supports_vision', false),
    supportsStreaming: boolFlag('supports_streaming', true),
    supportsJsonMode: boolFlag('supports_json_mode', false),
    capabilities: jsonText('capabilities').notNull().default('{}'),
    deprecationDate: epochMs('deprecation_date'),
    // Live-discovery cache provenance (2.5.G/ADR-0064 §4): `'static'` (a hardcoded capability/media seed — the
    // default the media-routing `upsert` path writes), `'live'` (discovered via the seam's `listModels` — the
    // bulk refresh writes it), `'user'` (user-supplied pricing, ADR-0065). A text column with a CONSTANT default
    // is legal on `ALTER TABLE ADD` (the table ships EMPTY so existing rows are moot). Like `media_surface`,
    // SQLite `ALTER ADD` carries no CHECK, so the closed `MODEL_CATALOG_SOURCES` set is validated at the store
    // read boundary (`coerceModelCatalogSource`, model-catalog-store.ts) — a tampered value degrades to `'static'`.
    source: text('source').$type<ModelCatalogSource>().notNull().default('static'),
    // The epoch-ms a live refresh last wrote this row (ADR-0064 §5 TTL freshness); NULLABLE — NULL for a
    // static/user row or a never-refreshed row. Backs `providerRefreshedAt` (the max over a provider's active
    // `source='live'` rows). Additive nullable ALTER ADD, like the `media_*_cost_microcents` columns (0003).
    lastRefreshedAt: epochMs('last_refreshed_at'),
    isActive: boolFlag('is_active', true),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_model_catalog_provider_model')
      .on(t.providerId, t.modelId)
      .where(sql`${t.deletedAt} is null`),
    index('idx_model_catalog_provider').on(t.providerId),
    index('idx_model_catalog_active')
      .on(t.isActive)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 3. agents (-> model_catalog) ---

export const agents = sqliteTable(
  'agents',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    modelId: text('model_id')
      .notNull()
      .references(() => modelCatalog.id),
    systemPrompt: text('system_prompt').notNull().default(''),
    tools: jsonText('tools').notNull().default('[]'),
    config: jsonText('config').notNull().default('{}'),
    inputSchema: jsonText('input_schema'),
    outputSchema: jsonText('output_schema'),
    tags: jsonText('tags').notNull().default('[]'),
    sourcePath: text('source_path'),
    isActive: boolFlag('is_active', true),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_agents_slug')
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('idx_agents_model').on(t.modelId),
    index('idx_agents_active')
      .on(t.isActive, desc(t.createdAt))
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 4. workflows (no FKs) ---

export const workflows = sqliteTable(
  'workflows',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    definition: jsonText('definition').notNull(),
    inputSchema: jsonText('input_schema'),
    tags: jsonText('tags').notNull().default('[]'),
    sourcePath: text('source_path'),
    isActive: boolFlag('is_active', true),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('idx_workflows_slug')
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('idx_workflows_active')
      .on(t.isActive, desc(t.updatedAt))
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 5. runs (-> workflows) ---

export const runs = sqliteTable(
  'runs',
  {
    id: uuidPk(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id),
    workflowPath: text('workflow_path'),
    projectRoot: text('project_root'),
    // The frozen graph that actually ran — for replay/resume after the YAML changes.
    workflowDefinitionSnapshot: jsonText('workflow_definition_snapshot').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('pending'),
    executionMode: text('execution_mode').$type<ExecutionMode>().notNull().default('local'),
    // trigger_type carries NO strict CHECK (database-schema.md) — webhook/schedule are
    // Phase-2 values that may legitimately appear; only the default is pinned here.
    triggerType: text('trigger_type').notNull().default('manual'),
    triggerMetadata: jsonText('trigger_metadata').notNull().default('{}'),
    inputJson: jsonText('input_json').notNull().default('{}'),
    outputJson: jsonText('output_json'),
    errorJson: jsonText('error_json'),
    startedAt: epochMs('started_at'),
    completedAt: epochMs('completed_at'),
    totalInputTokens: tokenCount('total_input_tokens'),
    totalOutputTokens: tokenCount('total_output_tokens'),
    totalCostMicrocents: microcents('total_cost_microcents'),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    // CHECK value sets imported from @relavium/shared so the persisted enum cannot
    // drift from the logical RunSchema contract.
    check('runs_status_check', sql`${t.status} in (${inList(RunStatusSchema.options)})`),
    check('runs_execution_mode_check', sql`${t.executionMode} in (${inList(EXECUTION_MODES)})`),
    index('idx_runs_workflow').on(t.workflowId, desc(t.createdAt)),
    index('idx_runs_status')
      .on(t.status, desc(t.createdAt))
      .where(sql`${t.deletedAt} is null`),
    index('idx_runs_cost')
      .on(t.workflowId, t.createdAt, t.totalCostMicrocents)
      .where(sql`${t.deletedAt} is null`),
    // Backs the workflow-agnostic recency lists (`listRuns`/`listActiveRuns` + the 2.5.B Home strip): the
    // ORDER BY `(created_at DESC, id DESC)` over the non-deleted set is served straight off this partial index
    // instead of a `USE TEMP B-TREE` filesort, so the Home cold-open stays fast at scale (discharges the §2.I
    // perf follow-up). The `WHERE deleted_at IS NULL` partial matches every read's soft-delete predicate.
    index('idx_runs_created')
      .on(desc(t.createdAt), desc(t.id))
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 6. step_executions (-> runs CASCADE, agents, model_catalog) ---

const STEP_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
type StepStatus = (typeof STEP_STATUSES)[number];

export const stepExecutions = sqliteTable(
  'step_executions',
  {
    id: uuidPk(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    nodeType: text('node_type').notNull(),
    agentId: text('agent_id').references(() => agents.id),
    agentSnapshot: jsonText('agent_snapshot'),
    modelId: text('model_id').references(() => modelCatalog.id),
    attemptNumber: integer('attempt_number').notNull().default(1),
    status: text('status').$type<StepStatus>().notNull().default('pending'),
    inputJson: jsonText('input_json').notNull().default('{}'),
    outputJson: jsonText('output_json'),
    errorJson: jsonText('error_json'),
    startedAt: epochMs('started_at'),
    completedAt: epochMs('completed_at'),
    durationMs: integer('duration_ms'),
    inputTokens: tokenCount('input_tokens'),
    outputTokens: tokenCount('output_tokens'),
    cachedTokens: tokenCount('cached_tokens'),
    costMicrocents: microcents('cost_microcents'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    check('step_executions_status_check', sql`${t.status} in (${inList(STEP_STATUSES)})`),
    index('idx_step_exec_run').on(t.runId, t.createdAt),
    index('idx_step_exec_run_node').on(t.runId, t.nodeId, t.attemptNumber),
    index('idx_step_exec_agent')
      .on(t.agentId, desc(t.createdAt))
      .where(sql`${t.agentId} is not null`),
    index('idx_step_exec_model')
      .on(t.modelId, desc(t.createdAt))
      .where(sql`${t.modelId} is not null`),
    index('idx_step_exec_cost')
      .on(t.modelId, t.createdAt, t.costMicrocents)
      .where(sql`${t.modelId} is not null`),
  ],
);

// --- 7. messages (-> step_executions CASCADE; run_id denormalized, no FK) ---

export const messages = sqliteTable(
  'messages',
  {
    id: uuidPk(),
    stepExecutionId: text('step_execution_id')
      .notNull()
      .references(() => stepExecutions.id, { onDelete: 'cascade' }),
    // Denormalized for per-run query efficiency; the reference DDL declares no FK here.
    runId: text('run_id').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    // role values (system|user|assistant|tool) are documented literals; the reference
    // DDL declares no CHECK on role, so none is added here.
    role: text('role').notNull(),
    content: text('content'),
    contentParts: jsonText('content_parts'),
    toolCalls: jsonText('tool_calls'),
    toolCallId: text('tool_call_id'),
    name: text('name'),
    finishReason: text('finish_reason'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    index('idx_messages_step').on(t.stepExecutionId, t.sequenceNumber),
    index('idx_messages_run').on(t.runId, t.createdAt),
  ],
);

// --- 8. run_events (-> runs CASCADE; step_execution_id denormalized, no FK) ---

export const runEvents = sqliteTable(
  'run_events',
  {
    id: uuidPk(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepExecutionId: text('step_execution_id'),
    // monotonic per run — used for gap detection on reconnect/resync.
    seq: integer('seq').notNull(),
    eventType: text('event_type').notNull(),
    level: text('level').notNull().default('info'),
    nodeId: text('node_id'),
    payloadJson: jsonText('payload_json').notNull().default('{}'),
    ts: epochMs('ts').notNull(),
  },
  (t) => [
    // UNIQUE: `seq` is monotonic per run, so (run_id, seq) must be unique — this enforces
    // the gap-detection invariant at the DB level (a double-write can't reuse a sequence).
    uniqueIndex('idx_run_events_run_seq').on(t.runId, t.seq),
    index('idx_run_events_step')
      .on(t.stepExecutionId, t.ts)
      .where(sql`${t.stepExecutionId} is not null`),
    index('idx_run_events_run_type').on(t.runId, t.eventType, t.ts),
  ],
);

// --- 9. run_costs (-> runs CASCADE, model_catalog) ---

export const runCosts = sqliteTable(
  'run_costs',
  {
    id: uuidPk(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    nodeId: text('node_id').notNull(),
    modelId: text('model_id').references(() => modelCatalog.id),
    inputTokens: tokenCount('input_tokens'),
    outputTokens: tokenCount('output_tokens'),
    costMicrocents: microcents('cost_microcents'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [index('idx_run_costs_run').on(t.runId)],
);

// --- 10. agent_sessions (-> agents, model_catalog; the agent-first chat session, ADR-0024) ---

export const agentSessions = sqliteTable(
  'agent_sessions',
  {
    id: uuidPk(),
    agentId: text('agent_id').references(() => agents.id),
    agentSlug: text('agent_slug').notNull(),
    agentSnapshot: jsonText('agent_snapshot'),
    title: text('title'),
    modelId: text('model_id').references(() => modelCatalog.id),
    // working_dir / git_ref / fs_scope_tier are denormalized out of context_json for indexing/filtering;
    // context_json remains the authoritative frozen SessionContext.
    workingDir: text('working_dir'),
    gitRef: text('git_ref'),
    fsScopeTier: text('fs_scope_tier').$type<FsScopeTier>().notNull().default('sandboxed'),
    status: text('status').$type<SessionStatus>().notNull().default('active'),
    contextJson: jsonText('context_json').notNull().default('{}'),
    totalInputTokens: tokenCount('total_input_tokens'),
    totalOutputTokens: tokenCount('total_output_tokens'),
    totalCostMicrocents: microcents('total_cost_microcents'),
    exportedWorkflowPath: text('exported_workflow_path'),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    // CHECK value sets imported from @relavium/shared so the persisted enum cannot drift from the
    // logical contract: the shared FS_SCOPE_TIERS list and the SessionStatus contract (session.ts).
    check(
      'agent_sessions_fs_scope_tier_check',
      sql`${t.fsScopeTier} in (${inList(FS_SCOPE_TIERS)})`,
    ),
    check(
      'agent_sessions_status_check',
      sql`${t.status} in (${inList(SessionStatusSchema.options)})`,
    ),
    index('idx_agent_sessions_status')
      .on(t.status, desc(t.updatedAt))
      .where(sql`${t.deletedAt} is null`),
    index('idx_agent_sessions_agent')
      .on(t.agentId, desc(t.createdAt))
      .where(sql`${t.agentId} is not null`),
    // Backs `listSessions` + the 2.5.B Home "recent sessions" strip: the ORDER BY `(updated_at DESC, id DESC)`
    // over the non-deleted set is served off this partial index rather than a filesort (the session counterpart
    // of `idx_runs_created`; §2.I perf discharge). `WHERE deleted_at IS NULL` matches the read's soft-delete filter.
    index('idx_agent_sessions_updated')
      .on(desc(t.updatedAt), desc(t.id))
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 11. session_messages (-> agent_sessions CASCADE, model_catalog; append-only transcript) ---

export const sessionMessages = sqliteTable(
  'session_messages',
  {
    id: uuidPk(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    sequenceNumber: integer('sequence_number').notNull(),
    // role values (system|user|assistant|tool) are documented literals; the reference DDL declares no
    // CHECK on role (mirrors the run `messages` table), so none is added — the SessionMessageSchema
    // (@relavium/shared) enforces the closed role set at the mapper boundary.
    role: text('role').notNull(),
    content: text('content'),
    // The canonical durable transcript: SessionMessage.content (DurableContentPart[]) is stored here as
    // JSON (database-schema.md §"Mapping SessionMessage to the row"). The other scalar columns below are
    // optional denormalized metadata (NULL when the durable parts array is the sole source of a row).
    contentParts: jsonText('content_parts'),
    toolCalls: jsonText('tool_calls'),
    toolCallId: text('tool_call_id'),
    name: text('name'),
    finishReason: text('finish_reason'),
    // The model that produced an assistant turn (fallback-aware); NULL for non-assistant rows.
    modelId: text('model_id').references(() => modelCatalog.id),
    // NOTE (ADR-0070 §5): the per-message `input_tokens` / `output_tokens` / `cost_microcents` columns were DROPPED.
    // They were never written (the persister never passed a meta payload, so every row shipped 0), never read back,
    // and — decisively — a per-message cost column is STRUCTURALLY incapable of holding the truth for a turn whose
    // tool loop billed two models. Money attribution lives in `session_costs`. `model_id` STAYS: it is written
    // (ADR-0059) and remains the per-message "which model wrote this reply" label.
    // Present ONLY on a compaction/trim boundary marker row (role='system', ADR-0062): the durable
    // sequence_number THROUGH which older messages are superseded. NULL on every normal transcript row.
    // Additive nullable column — an older reader that lacks it reads the marker as an inert system row.
    compactionDroppedThroughSequence: integer('compaction_dropped_through_sequence'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    // UNIQUE: sequence_number is monotonic per session (append-only), so (session_id, sequence_number)
    // must be unique — enforcing the gap-free transcript invariant at the DB level (no double-write).
    uniqueIndex('idx_session_messages_seq').on(t.sessionId, t.sequenceNumber),
    index('idx_session_messages_session').on(t.sessionId, t.createdAt),
  ],
);

// --- 11b. session_costs (per-(session, model) money attribution, ADR-0070) ---
// The durable per-model spend of a chat session. It exists because a `session_messages` row holds exactly ONE
// `model_id`, and a single turn can bill TWO models: the tool loop makes a fresh fallback-chain call per iteration,
// so iteration 1 can succeed on model A and iteration 2 fail over to B. A per-message cost column cannot represent
// that turn without lying — which is why `session_messages`' own token/cost columns were dropped (ADR-0070 §5).
//
// THE INVARIANT (ADR-0070 §3): SUM(session_costs.cost_microcents) == agent_sessions.total_cost_microcents, for every
// session. It holds because both sides are fed by the SAME `cost:updated` event, with the same arithmetic, in the
// SAME transaction, from the single emitter — including errored turns, aborted turns, and compaction spend.
export const sessionCosts = sqliteTable(
  'session_costs',
  {
    id: uuidPk(),
    sessionId: text('session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    // The RAW provider model string from `cost:updated.model` — the KEY, deliberately NOT the catalog FK (a divergence
    // from `run_costs`, and a reviewer must not "fix" it back). The FK target is a catalog UUID that resolves to NULL
    // for an UNCATALOGED model (custom, self-hosted, brand-new), and NULLs are DISTINCT under UNIQUE in both SQLite
    // and Postgres — so keying on it would make `ON CONFLICT` never match: every uncataloged egress would insert a
    // NEW row, and two different uncataloged models would collapse into one indistinguishable bucket.
    model: text('model').notNull(),
    // Nullable, WRITTEN (never a dead column, unlike `run_costs.model_id`) join column for catalog enrichment only.
    modelCatalogId: text('model_catalog_id').references(() => modelCatalog.id),
    inputTokens: tokenCount('input_tokens'),
    outputTokens: tokenCount('output_tokens'),
    costMicrocents: microcents('cost_microcents'),
    // COUNTERS, not booleans: 2.6.Q can price a model MID-SESSION, so a single (session, model) row folds both priced
    // and unpriced egresses. A boolean would become meaningless the moment that happens (ADR-0070 §6).
    callCount: tokenCount('call_count'),
    unpricedCalls: tokenCount('unpriced_calls'),
    // The legacy discriminator (ADR-0070 §4; column added by migration 0010). 0009's backfill wrote ONE aggregate
    // row per pre-2.6.C session — a
    // real total with no per-model breakdown behind it — and it must be distinguishable from a real model row by the
    // SCHEMA, never by its `model` string. The sentinel string alone cannot do it: `model` is the RAW provider id
    // precisely BECAUSE a custom/self-hosted id can be any non-empty string (see `model` above), so "no real id looks
    // like the sentinel" is the one assumption this table is built to refuse. It rides in the unique index, so a real
    // egress (always `false`) can never upsert ONTO the legacy row — not even one whose model is literally the
    // sentinel. `/cost` branches on this column, not on a string compare.
    isLegacy: integer('is_legacy', { mode: 'boolean' }).notNull().default(false),
    createdAt: epochMs('created_at').notNull(),
    updatedAt: epochMs('updated_at').notNull(),
  },
  (t) => [
    // The upsert target. One row per (session, model, isLegacy) — the shape the additive fold needs, with the legacy
    // aggregate held apart from the real rows by construction rather than by convention.
    uniqueIndex('idx_session_costs_session_model').on(t.sessionId, t.model, t.isLegacy),
    // Covering the `/cost` read: per-session, ordered by spend.
    index('idx_session_costs_session').on(t.sessionId, t.costMicrocents),
    // The DB is the system of record: an empty-string model would be a silent, un-attributable money bucket. The
    // event type already forbids it (`cost:updated.model` is a Zod nonEmptyString) — this is the last line.
    check('session_costs_model_nonempty', sql`${t.model} <> ''`),
  ],
);

// --- 12. media_objects (no FK; the host-owned media retention/GC store, ADR-0042) ---
// The FIRST persisted mutable state outside the ADR-0003 derived-from-run_events model — a retention
// store, NOT a checkpoint store. The content-addressed `media://sha256-<64hex>` handle is the integrity
// hash (no separate checksum). `deleted_at` (the table soft-delete convention) is set by refcount-GC
// byte-reclamation once the grace window (default 7 days, from `last_referenced_at`) has elapsed.
export const mediaObjects = sqliteTable(
  'media_objects',
  {
    id: uuidPk(),
    // A UNIQUE CONSTRAINT (not merely a unique index): the media_references FK targets handle, and a
    // Postgres FK target must be a unique constraint / PK (a bare unique index is insufficient) — so
    // `.unique()` keeps the SQLite↔Postgres parity ([ADR-0005]/[ADR-0042]).
    handle: text('handle').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    modality: text('modality').$type<MediaModality>().notNull(),
    byteLength: integer('byte_length').notNull(),
    durationMs: integer('duration_ms'),
    lastReferencedAt: epochMs('last_referenced_at').notNull(),
    deletedAt: epochMs('deleted_at'),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    check('media_objects_modality_check', sql`${t.modality} in (${inList(MEDIA_MODALITIES)})`),
    // GC sweep cursor: live objects ordered by recency-of-reference (grace-window candidates first).
    index('idx_media_objects_gc')
      .on(t.lastReferencedAt)
      .where(sql`${t.deletedAt} is null`),
  ],
);

// --- 13. media_references (-> media_objects.handle CASCADE; per-distinct-reference junction, ADR-0042) ---
// One junction serves BOTH refcount/sweep and read_media authz. `scope_kind` is a superset:
// `run`/`node` are refcount + terminal-sweep lifetime entries; `session`/`workspace` are ALSO the
// ADR-0044 read_media authz Scope kinds (authz consults session/workspace rows ONLY — a run/node
// reference never grants read). The refcount derives from the row count; the terminal sweep removes
// the run's `run` rows.
export const mediaReferences = sqliteTable(
  'media_references',
  {
    id: uuidPk(),
    handle: text('handle')
      .notNull()
      .references(() => mediaObjects.handle, { onDelete: 'cascade' }),
    scopeKind: text('scope_kind').$type<MediaScopeKind>().notNull(),
    scopeId: text('scope_id').notNull(),
    createdAt: epochMs('created_at').notNull(),
  },
  (t) => [
    check(
      'media_references_scope_kind_check',
      sql`${t.scopeKind} in (${inList(MEDIA_SCOPE_KINDS)})`,
    ),
    // A scope references a handle at most once (per-distinct-reference; the refcount = row count).
    uniqueIndex('idx_media_references_unique').on(t.handle, t.scopeKind, t.scopeId),
    // Terminal-state sweep (reclaim a run's refs) + read_media authz lookup (by scope).
    index('idx_media_references_scope').on(t.scopeKind, t.scopeId),
    index('idx_media_references_handle').on(t.handle),
  ],
);

// --- Inferred row types (select + insert) for each table ---

export type LlmProviderRow = typeof llmProviders.$inferSelect;
export type NewLlmProviderRow = typeof llmProviders.$inferInsert;
export type ModelCatalogRow = typeof modelCatalog.$inferSelect;
export type NewModelCatalogRow = typeof modelCatalog.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type WorkflowRow = typeof workflows.$inferSelect;
export type NewWorkflowRow = typeof workflows.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type StepExecutionRow = typeof stepExecutions.$inferSelect;
export type NewStepExecutionRow = typeof stepExecutions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
export type RunEventRow = typeof runEvents.$inferSelect;
export type NewRunEventRow = typeof runEvents.$inferInsert;
export type RunCostRow = typeof runCosts.$inferSelect;
export type NewRunCostRow = typeof runCosts.$inferInsert;
export type AgentSessionRow = typeof agentSessions.$inferSelect;
export type NewAgentSessionRow = typeof agentSessions.$inferInsert;
export type SessionMessageRow = typeof sessionMessages.$inferSelect;
export type NewSessionMessageRow = typeof sessionMessages.$inferInsert;
export type MediaObjectRow = typeof mediaObjects.$inferSelect;
export type NewMediaObjectRow = typeof mediaObjects.$inferInsert;
export type MediaReferenceRow = typeof mediaReferences.$inferSelect;
export type NewMediaReferenceRow = typeof mediaReferences.$inferInsert;
