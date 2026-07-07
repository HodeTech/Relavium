# Desktop Database Schema (Local SQLite)

> Last updated: 2026-06-03

- **Status**: Reference
- **Surface**: Desktop (Tauri v2)
- **Scope**: Phase 1, local-first. SQLite via `tauri-plugin-sql`, schema managed by Drizzle ORM in `packages/db` (see [project-structure.md](../../project-structure.md)).
- **Related**: [keychain-and-secrets.md](keychain-and-secrets.md), [tauri-plugins.md](tauri-plugins.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md), [../../architecture/managed-inference.md](../../architecture/managed-inference.md), [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md)

This is the canonical reference for the **local** run-history and catalog database that the desktop app (and the Phase-2 CLI) persists on the user's machine. There is no cloud, no account, and no server in Phase 1 — every table below lives in a single local SQLite file. **At-rest encryption is per-surface:** the desktop opens `history.db` with SQLCipher, while the Phase-2 **CLI** opens the same **path** with `better-sqlite3` **unencrypted, guarded by `0600`/`0700` OS permissions** ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)). Because a standard `better-sqlite3` build cannot open a SQLCipher file (nor vice-versa), the two surfaces **cannot share one file** — see [Encryption at rest](#encryption-at-rest) and the cross-host callout under the agent-session tables. The Phase-2 PostgreSQL divergences are described at the end and detailed in [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).

## Storage layout

```mermaid
flowchart TB
  subgraph Global["~/.relavium/ (global, cross-project)"]
    H["history.db<br/>(desktop: SQLCipher · CLI: 0600/0700 OS perms)<br/>full run + event + cost history"]
  end
  subgraph Project["{projectRoot}/.relavium/ (per-project, git-committed)"]
    R["runs.db<br/>(run metadata only,<br/>no event payloads)"]
    WF[".relavium/*.relavium.yaml<br/>workflows (source of truth)"]
    AG[".relavium/agents/*.agent.yaml<br/>agents (source of truth)"]
  end
  WF -. parsed at run time .-> H
  AG -. parsed at run time .-> H
  H -. metadata mirror .-> R
```

Two SQLite databases exist:

| Database | Path | Encryption | Contents | Git |
|----------|------|-----------|----------|-----|
| Global history | `~/.relavium/history.db` | Desktop: SQLCipher (key from OS keychain) · CLI: none — `0600`/`0700` OS perms ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)) | Full runs, every event, every cost row, the catalog tables | Never committed |
| Project history | `{projectRoot}/.relavium/runs.db` | None | Run **metadata only** (no event payloads) so teammates see historical run summaries after a `git pull` | Committed |

The database is opened with `PRAGMA journal_mode = WAL` (readers never block the writer and vice-versa — but SQLite still allows **only one writer at a time**, so engine authors must funnel `run_events` and other hot-path writes through a single serialized writer, never concurrent writers) and `PRAGMA foreign_keys = ON` per connection (SQLite does **not** enforce foreign keys by default). Run events in `history.db` are pruned after 90 days by a background job that runs on app launch.

> Workflows and agents are **not** the database's source of truth. The git-committable YAML files (`.relavium.yaml` / `.agent.yaml`) are authoritative; see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md) and [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md). The catalog tables below cache and snapshot them for fast querying, run reproducibility, and offline browsing.

## SQLite type conventions

Because this schema is adapted from a Postgres-first design (see [../../analysis/_archive/](../../analysis/_archive/)), the following local-first conventions apply consistently across every table:

| Concept | Postgres (Phase 2) | SQLite (Phase 1, here) |
|---------|--------------------|------------------------|
| Primary key | `UUID DEFAULT gen_random_uuid()` | `TEXT` UUID generated in application code (Drizzle) |
| Structured blob | `JSONB` | `TEXT` (JSON string); query with `json_extract()` |
| String array (tags) | `TEXT[]` | `TEXT` (JSON array, e.g. `["review","ci"]`); query with `json_each()` |
| Timestamp | `TIMESTAMPTZ` | `INTEGER` (Unix epoch ms) for reliable ordering; timezone handled in app code |
| Money / cost | `NUMERIC(14,8)` | `INTEGER` **micro-cents** (USD x 100,000,000, i.e. cents x 1,000,000 — one micro-cent = 1e-8 USD = 1e-6 cent) to avoid IEEE-754 rounding. The `NUMERIC(14,8)` Postgres form is consistent: 8 fractional digits = 1e-8 USD = one micro-cent. Canonical unit definition: [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md#6-usage). |
| Enum | `CREATE TYPE ... AS ENUM` | `TEXT` with a `CHECK` constraint |
| Soft delete | `deleted_at TIMESTAMPTZ` partial index | `deleted_at INTEGER NULL`; partial indexes supported since SQLite 3.8.9 |

A full 14-item porting table lives in [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).

## Tables

The local schema is the Postgres 13-table design reduced to what a single-user, local-first app needs. The two LangGraph checkpoint tables are **dropped** (the engine is pure TypeScript — no LangGraph; see [decision 0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)); checkpoint/resume needs no dedicated table — engine state is **reconstructed from `step_executions` + `run_events`** (+ `messages` for an orchestrator's history), per [execution-model.md](../../architecture/execution-model.md#5-checkpoint-each-node-boundary). `workflow_schedules` is **Phase 2 only** (schedule/webhook triggers require a cloud listener; see [../../ideas/scheduled-and-webhook-triggers.md](../../ideas/scheduled-and-webhook-triggers.md)). The `*_versions` tables are unnecessary locally because version history is provided by git on the YAML files.

### Catalog tables

#### `llm_providers`

Registered LLM providers. The actual API key never lives here — only a reference; the key is stored in the OS keychain (see [keychain-and-secrets.md](keychain-and-secrets.md)).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `name` | TEXT | NOT NULL UNIQUE (e.g. `anthropic`, `openai`) |
| `display_name` | TEXT | NOT NULL |
| `base_url` | TEXT | NOT NULL — a custom endpoint (2.5.G S9); actually used at routing time for an OpenAI-compatible provider (ADR-0065 §3) |
| `api_key_keychain_ref` | TEXT | NULL — keychain `account` identifier, not the key itself |
| `default_headers` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `kind` | TEXT | NULL — the protocol `ProviderKind` (`anthropic`/`openai-compatible`/`gemini`), added by migration `0008` (ADR-0065 §5). Populated for uniformity; validated against `PROVIDER_KINDS` at the store read boundary (no DB CHECK — SQLite `ALTER ADD` limit; a foreign value ⇒ `undefined`). Load-bearing only for a future custom provider. |
| `pricing_reference_url` | TEXT | NULL — a pricing-page URL (a UX pointer for user-supplied pricing, S10), added by migration `0008` (ADR-0065 §5) |
| `is_active` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_llm_providers_name ON llm_providers (name) WHERE deleted_at IS NULL;
```

#### `model_catalog`

Models offered by each provider, including pricing used for local cost tracking. The `*_per_mtok_microcents` columns are price **per million tokens, in integer micro-cents** (one micro-cent = 1e-8 USD = cents x 1,000,000; see the [money/cost convention](#sqlite-type-conventions)). The three `media_*_cost_microcents` columns are the projection of `ModelPricing.mediaOutputRates` (1.AF/D17, [ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md) §3) — integer micro-cents **per billed media-output unit** (per image, per audio-second, per video-second); **NULL** when the model has no metered media rate (the realized fold + the pre-egress estimate degrade to 0 for it — H4). `document`/PDF is excluded (it bills as tokens). No shipped model carries a media rate yet, so these are NULL across the seeded catalog.

**Live-discovery cache role ([ADR-0064](../../decisions/0064-live-model-catalog.md) §4/§5).** As of 2.5.G this table doubles as the **live-discovery cache** — "which model ids a given key can reach" — filled by a bulk refresh over the seam's `listModels`, with the static `MODEL_PRICING` registry enriching **at read time** (the registry is **never** seeded into the DB — that would create a second, drift-prone pricing home). The `source` discriminant records provenance: **`static`** (a hardcoded capability/media seed — the media-routing `upsert` path's default), **`live`** (discovered via `listModels` — the refresh writes it), **`user`** (user-supplied pricing, [ADR-0065](../../decisions/0065-provider-economics-and-extensibility.md)). `last_refreshed_at` is the freshness stamp backing the 24h TTL. The bulk refresh (`replaceProviderModels`) **soft-deactivates** (`is_active = 0`, `deleted_at` left NULL) every currently-active `source='live'` row of a provider whose model id vanishes from the new list, and **reactivates** a reappearing one by reusing the same row — it **never hard-DELETEs** (`model_catalog.id` is an FK target from five tables) and **never touches a `source='user'` or `source='static'` row** (a refresh must not clobber user pricing or regress the media-routing seed). The existing narrow media-routing projection (`resolveMediaSurface` / the D15 capability load-check) is untouched by the widening. Because SQLite `ALTER TABLE ADD` cannot carry a CHECK, the closed `source` value set is validated at the store read boundary (`coerceModelCatalogSource`, degrading a foreign value to `static`), like `media_surface`.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `provider_id` | TEXT | NOT NULL REFERENCES `llm_providers(id)` |
| `model_id` | TEXT | NOT NULL (e.g. `claude-sonnet-4-6`) |
| `display_name` | TEXT | NOT NULL |
| `context_window_tokens` | INTEGER | NOT NULL |
| `max_output_tokens` | INTEGER | NOT NULL |
| `input_cost_per_mtok_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `output_cost_per_mtok_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `cached_input_cost_per_mtok_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `media_image_cost_microcents` | INTEGER | NULL — µ¢ per output image (1.AF/D17) |
| `media_audio_cost_microcents` | INTEGER | NULL — µ¢ per output audio-second |
| `media_video_cost_microcents` | INTEGER | NULL — µ¢ per output video-second |
| `media_surface` | TEXT | NOT NULL DEFAULT `'chat'` — `'chat'` \| `'generative'`; routes an agent node to the normal turn vs `generateMedia()` (1.AG/ADR-0045 §1) |
| `supports_tool_calling` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `supports_vision` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `supports_streaming` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `supports_json_mode` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `capabilities` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `deprecation_date` | INTEGER | NULL |
| `source` | TEXT | NOT NULL DEFAULT `'static'` — provenance: `'static'` \| `'live'` \| `'user'` (the live-discovery cache discriminant, [ADR-0064](../../decisions/0064-live-model-catalog.md) §4); validated at the store read boundary (no DB CHECK — SQLite `ALTER ADD`) |
| `last_refreshed_at` | INTEGER | NULL — epoch-ms a live refresh last wrote this row (ADR-0064 §5 TTL freshness); NULL for a static/user or never-refreshed row |
| `is_active` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_model_catalog_provider_model ON model_catalog (provider_id, model_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_model_catalog_provider ON model_catalog (provider_id);
CREATE INDEX idx_model_catalog_active   ON model_catalog (is_active) WHERE deleted_at IS NULL;
```

#### `agents`

A cached/snapshot copy of agent definitions for fast catalog browsing and run reproducibility. The `.agent.yaml` file remains authoritative.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `name` | TEXT | NOT NULL |
| `slug` | TEXT | NOT NULL UNIQUE |
| `description` | TEXT | NULL |
| `model_id` | TEXT | NOT NULL REFERENCES `model_catalog(id)` |
| `system_prompt` | TEXT | NOT NULL DEFAULT `''` |
| `tools` | TEXT (JSON) | NOT NULL DEFAULT `'[]'` |
| `config` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` (temperature, max_tokens, fallback_chain) |
| `input_schema` | TEXT (JSON) | NULL |
| `output_schema` | TEXT (JSON) | NULL |
| `tags` | TEXT (JSON array) | NOT NULL DEFAULT `'[]'` |
| `source_path` | TEXT | NULL — workspace-relative path to the `.agent.yaml` file |
| `is_active` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_agents_slug   ON agents (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_agents_model         ON agents (model_id);
CREATE INDEX idx_agents_active        ON agents (is_active, created_at DESC) WHERE deleted_at IS NULL;
-- tags are queried with json_each(); SQLite has no GIN index (see cloud-phase-2.md)
```

> Postgres `version INTEGER` + the separate `agent_versions` table are dropped locally — git history on the YAML file is the version record.

#### `workflows`

Cached/snapshot copy of workflow definitions. The `definition` column holds the parsed workflow graph (the canonical format is [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `name` | TEXT | NOT NULL |
| `slug` | TEXT | NOT NULL UNIQUE |
| `description` | TEXT | NULL |
| `definition` | TEXT (JSON) | NOT NULL — parsed graph (nodes, edges, agents, context) |
| `input_schema` | TEXT (JSON) | NULL |
| `tags` | TEXT (JSON array) | NOT NULL DEFAULT `'[]'` |
| `source_path` | TEXT | NULL — workspace-relative path to the `.relavium.yaml` file |
| `is_active` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_workflows_slug ON workflows (slug) WHERE deleted_at IS NULL;
CREATE INDEX idx_workflows_active      ON workflows (is_active, updated_at DESC) WHERE deleted_at IS NULL;
```

### Run-history tables

#### `runs`

One row per workflow execution. `workflow_definition_snapshot` freezes the exact graph that ran, so a run can be replayed or inspected even after the YAML file changes. Cost is stored as integer micro-cents.

> **Logical `Run` vs persisted `RunRow`.** `@relavium/shared` exports `RunSchema` — the **narrow, engine-/surface-facing** view of a run (status, trigger, inputs/outputs, token + cost totals, timestamps). This `runs` table is the **persistence** shape and carries additional columns that are a database concern, modeled by `@relavium/db` as a distinct `RunRow` mirroring the DDL below: `workflow_definition_snapshot` (the frozen graph for replay/resume), `trigger_metadata`, `workflow_path`/`project_root`, and the `deleted_at` soft-delete cursor. Those are intentionally absent from the logical `RunSchema`; a consumer that needs them reads the `RunRow`. The split keeps the engine view free of storage details while `@relavium/db` owns the row ↔ column mapping.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `workflow_id` | TEXT | NOT NULL REFERENCES `workflows(id)` — the surrogate **UUID** PK, **not** the authored kebab id (that lives in `workflows.slug`). `RunSchema.workflowId` mirrors this UUID FK ([ADR-0022](../../decisions/0022-run-references-workflow-by-uuid.md)). |
| `workflow_path` | TEXT | NULL — source `.relavium.yaml` path |
| `project_root` | TEXT | NULL — workspace that owned the run |
| `workflow_definition_snapshot` | TEXT (JSON) | NOT NULL |
| `status` | TEXT | NOT NULL DEFAULT `'pending'` — `CHECK (status IN ('pending','running','paused','completed','failed','cancelled'))` |
| `execution_mode` | TEXT | NOT NULL DEFAULT `'local'` — `CHECK (execution_mode IN ('local','cloud','managed'))`; which mode the run used (cost/billing attribution + history) |
| `trigger_type` | TEXT | NOT NULL DEFAULT `'manual'` (`manual`, `file_change`, `mcp_call`; `webhook`/`schedule` are Phase 2) |
| `trigger_metadata` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `input_json` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `output_json` | TEXT (JSON) | NULL |
| `error_json` | TEXT (JSON) | NULL |
| `started_at` | INTEGER | NULL |
| `completed_at` | INTEGER | NULL |
| `total_input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `total_output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `total_cost_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE INDEX idx_runs_workflow      ON runs (workflow_id, created_at DESC);
CREATE INDEX idx_runs_status        ON runs (status, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_runs_cost          ON runs (workflow_id, created_at, total_cost_microcents) WHERE deleted_at IS NULL;
```

#### `step_executions`

One row per node attempt within a run. This is what drives the per-node run trace, the Gantt timeline, retry-from-node, and per-node cost attribution. `agent_snapshot` freezes the agent config that executed the node.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `run_id` | TEXT | NOT NULL REFERENCES `runs(id)` ON DELETE CASCADE |
| `node_id` | TEXT | NOT NULL — graph node id |
| `node_type` | TEXT | NOT NULL — one of the engine node-type enum values, since this column records what the engine executed (see [../shared-core/node-types.md](../shared-core/node-types.md)) |
| `agent_id` | TEXT | NULL REFERENCES `agents(id)` |
| `agent_snapshot` | TEXT (JSON) | NULL |
| `model_id` | TEXT | NULL REFERENCES `model_catalog(id)` |
| `attempt_number` | INTEGER | NOT NULL DEFAULT 1 |
| `status` | TEXT | NOT NULL DEFAULT `'pending'` — `CHECK (status IN ('pending','running','completed','failed','skipped'))` |
| `input_json` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `output_json` | TEXT (JSON) | NULL |
| `error_json` | TEXT (JSON) | NULL |
| `started_at` | INTEGER | NULL |
| `completed_at` | INTEGER | NULL |
| `duration_ms` | INTEGER | NULL |
| `input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cached_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cost_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE INDEX idx_step_exec_run       ON step_executions (run_id, created_at ASC);
CREATE INDEX idx_step_exec_run_node  ON step_executions (run_id, node_id, attempt_number);
CREATE INDEX idx_step_exec_agent     ON step_executions (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_step_exec_model     ON step_executions (model_id, created_at DESC) WHERE model_id IS NOT NULL;
CREATE INDEX idx_step_exec_cost      ON step_executions (model_id, created_at, cost_microcents) WHERE model_id IS NOT NULL;
```

#### `messages`

The LLM conversation for each agent step (prompt, completion, tool calls). Cascades from `step_executions`. Used for run inspection and to seed retry-from-node.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `step_execution_id` | TEXT | NOT NULL REFERENCES `step_executions(id)` ON DELETE CASCADE |
| `run_id` | TEXT | NOT NULL |
| `sequence_number` | INTEGER | NOT NULL |
| `role` | TEXT | NOT NULL (`system`, `user`, `assistant`, `tool`) |
| `content` | TEXT | NULL |
| `content_parts` | TEXT (JSON) | NULL — multimodal/structured parts |
| `tool_calls` | TEXT (JSON) | NULL |
| `tool_call_id` | TEXT | NULL |
| `name` | TEXT | NULL |
| `finish_reason` | TEXT | NULL |
| `created_at` | INTEGER | NOT NULL |

```sql
CREATE INDEX idx_messages_step ON messages (step_execution_id, sequence_number ASC);
CREATE INDEX idx_messages_run  ON messages (run_id, created_at ASC);
```

#### `run_events`

The append-only event log for a run — the persistent record of the [SSE/RunEvent stream](../contracts/sse-event-schema.md). This is what the run-detail log drawer replays and what powers reconnect/resync. `seq` is monotonic per run and is used for gap detection.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `run_id` | TEXT | NOT NULL REFERENCES `runs(id)` ON DELETE CASCADE |
| `step_execution_id` | TEXT | NULL |
| `seq` | INTEGER | NOT NULL — monotonic per run |
| `event_type` | TEXT | NOT NULL — e.g. `node:started`, `agent:token`, `human_gate:paused` |
| `level` | TEXT | NOT NULL DEFAULT `'info'` |
| `node_id` | TEXT | NULL |
| `payload_json` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `ts` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_run_events_run_seq ON run_events (run_id, seq ASC);  -- seq is monotonic per run: (run_id, seq) is unique
CREATE INDEX idx_run_events_step        ON run_events (step_execution_id, ts ASC) WHERE step_execution_id IS NOT NULL;
CREATE INDEX idx_run_events_run_type    ON run_events (run_id, event_type, ts ASC);
```

> `token`-level events are high volume. They are stored to support full replay but are the primary target of the 90-day pruning job; `runs`/`step_executions` metadata is retained longer.

> **Timestamp unit at the persistence boundary.** The wire `RunEvent.timestamp` is an **ISO-8601 string** ([sse-event-schema.md](../contracts/sse-event-schema.md) envelope), but it is persisted here as `run_events.ts` = **epoch-milliseconds `INTEGER`** (the table convention, for reliable ordering). The conversion ISO ↔ epoch-ms happens at the `@relavium/db` write/read boundary; the logical `RunSchema` timestamps (`createdAt`/`startedAt`/…) are already epoch-ms and pass through unchanged.

#### `run_costs`

Denormalized per-node cost rows for fast cost-waterfall rendering without re-aggregating `step_executions`. Stored as integer micro-cents.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `run_id` | TEXT | NOT NULL REFERENCES `runs(id)` ON DELETE CASCADE |
| `node_id` | TEXT | NOT NULL |
| `model_id` | TEXT | NULL REFERENCES `model_catalog(id)` |
| `input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cost_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `created_at` | INTEGER | NOT NULL |

```sql
CREATE INDEX idx_run_costs_run ON run_costs (run_id);
```

### Agent-session tables

These two tables persist **agent sessions** (the agent-first chat entry point —
[ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md),
[agent-session-spec.md](../contracts/agent-session-spec.md)). They live in the **same
`~/.relavium/history.db`** (desktop: SQLCipher-encrypted; CLI: unencrypted + `0600`/`0700` OS perms,
[ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)) as run history — there is **no** separate
`sessions.db`. They are **bound to a session**, deliberately **distinct** from the per-step run
[`messages`](#messages) table (which is bound to `step_executions` within a workflow run); the two
share a shape family but must not be merged, because a session and a run have different lifecycles.

#### `agent_sessions`

One row per chat session. `context_json` freezes the `SessionContext` (active file, selection,
session variables); `agent_snapshot` freezes the agent config the session ran against.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `agent_id` | TEXT | NULL REFERENCES `agents(id)` |
| `agent_slug` | TEXT | NOT NULL — the authored `agent_ref` the session is bound to |
| `agent_snapshot` | TEXT (JSON) | NULL — frozen agent config for reproducibility |
| `title` | TEXT | NULL — display title (derived from the first message or user-set) |
| `model_id` | TEXT | NULL REFERENCES `model_catalog(id)` — the session's **configured primary** model (resolved at start); the actual per-turn model, which may differ under fallback, is `session_messages.model_id` |
| `working_dir` | TEXT | NULL — session-context workspace root |
| `git_ref` | TEXT | NULL — branch/commit at session start, for provenance |
| `fs_scope_tier` | TEXT | NOT NULL DEFAULT `'sandboxed'` — `CHECK (fs_scope_tier IN ('sandboxed','project','full'))` (the same tier enum as workflows; see [built-in-tools.md](../shared-core/built-in-tools.md#filesystem-permission-tiers)) |
| `status` | TEXT | NOT NULL DEFAULT `'active'` — `CHECK (status IN ('active','idle','exported','ended'))` |
| `context_json` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` — the frozen `SessionContext` |
| `total_input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `total_output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `total_cost_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `exported_workflow_path` | TEXT | NULL — set when the session is exported to a `.relavium.yaml` |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE INDEX idx_agent_sessions_status ON agent_sessions (status, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_agent_sessions_agent  ON agent_sessions (agent_id, created_at DESC) WHERE agent_id IS NOT NULL;
```

#### `session_messages`

The **append-only** conversation transcript for a session — the session-scoped counterpart of the
run `messages` table. Never updated or deleted in normal operation (mirrors the run-event-log
pattern). Cascades from `agent_sessions`.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `session_id` | TEXT | NOT NULL REFERENCES `agent_sessions(id)` ON DELETE CASCADE |
| `sequence_number` | INTEGER | NOT NULL — monotonic per session (append-only) |
| `role` | TEXT | NOT NULL (`system`, `user`, `assistant`, `tool`) |
| `content` | TEXT | NULL |
| `content_parts` | TEXT (JSON) | NULL — multimodal/structured parts |
| `tool_calls` | TEXT (JSON) | NULL |
| `tool_call_id` | TEXT | NULL |
| `name` | TEXT | NULL |
| `finish_reason` | TEXT | NULL |
| `model_id` | TEXT | NULL REFERENCES `model_catalog(id)` — the model that produced an assistant turn (**fallback-aware**, so the transcript shows which model answered; NULL for non-assistant rows) |
| `compaction_dropped_through_sequence` | INTEGER | NULL — ADR-0062: set ONLY on a `role='system'` compaction/trim boundary marker; the durable `sequence_number` through which older messages are superseded (resume drops rows at/below it). Additive nullable column (migration 0006); NULL on every normal transcript row |
| `input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cost_microcents` | INTEGER | NOT NULL DEFAULT 0 |
| `created_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_session_messages_seq ON session_messages (session_id, sequence_number);
CREATE INDEX idx_session_messages_session    ON session_messages (session_id, created_at ASC);
```

> **Mapping the durable `SessionMessage` to a row (1.X).** `@relavium/shared`'s `SessionMessage`
> (agent-session-spec.md §"Session messages") carries the transcript body as a single
> `content: DurableContentPart[]` array. That array is the **canonical** body and is stored as JSON in
> **`content_parts`** — the source of truth the `@relavium/db` mapper round-trips. The remaining scalar
> columns (`content`, `tool_calls`, `tool_call_id`, `name`, `finish_reason`, `input_tokens`,
> `output_tokens`, `cost_microcents`) are **optional denormalized metadata** (a plain-text projection for
> display/search and the per-message counters) the persistence layer MAY populate; they are NULL/0 when the
> durable parts array is the sole source of a row. They keep `session_messages` in the run [`messages`](#messages)
> shape family without forcing a session to decompose its parts. The reasoning `signature` and inline media
> bytes are **structurally impossible** in `content_parts` — `DurableContentPart` has no `signature` field
> and only handle-only media ([ADR-0030](../../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)/[ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)),
> enforced at the mapper's parse boundary on both write and read.

> A `secret`-typed value is never persisted into `session_messages` — per
> [ADR-0029](../../decisions/0029-tool-policy-hardening.md) secrets are rejected from prompt/tool text
> at parse, so they never reach a message body. The user's own conversational content is stored here
> and is protected at rest by `history.db`'s SQLCipher encryption on the desktop, and by `0600`/`0700`
> OS file permissions on the CLI ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)).

> **Cross-host access (CLI / VS Code) and the at-rest divergence.** The same `history.db` path is
> opened by the non-Tauri hosts: the **CLI** uses the `better-sqlite3` path
> ([ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md)); the **VS Code extension host**
> uses a **wasm SQLite** build (no native module — respects
> [ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)'s no-arbitrary-native-modules
> constraint). **At-rest encryption is per-surface and not yet unified:** the desktop opens the file with
> SQLCipher, but the **CLI opens it unencrypted** (no passphrase), guarded by `0600`/`0700` OS permissions
> ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)). A standard `better-sqlite3` build
> cannot open a SQLCipher file (nor vice-versa), so the desktop (SQLCipher) and the CLI (unencrypted)
> **cannot share one file at `~/.relavium/history.db`**. In Phase 2 there is **no live collision** — the
> desktop does not exist yet (Phase 3) and the CLI is the sole writer. **Cross-surface session/run resume
> across the desktop and CLI is therefore a named Phase-3 follow-on**
> ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)): the desktop phase reconciles the
> shared-path posture (a uniformly-unencrypted shared store, per-surface separate files, or a CLI/Node
> SQLCipher-capable build). Until then there is **no** cross-surface shared session/run store.

### Media tables (1.AF)

These two tables are the **media retention/GC store** ([ADR-0042](../../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)) — the **first persisted, mutable state outside the [ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md) derived-from-`run_events` model** (a retention store, NOT a checkpoint store). The byte blobs themselves live in a host content-addressed store (a filesystem CAS on CLI/VS Code, the Rust CAS on desktop — [ADR-0032](../../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)), **not** in the database; these tables track existence, metadata, references (the refcount), and the `read_media` authz scope-set. The content-addressed `media://sha256-<64hex>` handle **is** the integrity hash — there is no separate checksum column. *(At P1+P2 the schema is landed but the row-writer / refcount / sweep wiring is not — P3/P4, D10/D11 — so these tables ship empty.)*

#### `media_objects`

One row per distinct stored media blob, keyed by its content-address handle.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `handle` | TEXT | NOT NULL **UNIQUE** — the `media://sha256-<64hex>` content-address. A UNIQUE **constraint** (not merely an index) so the `media_references` Postgres FK can target it ([ADR-0005](../../decisions/0005-sqlite-drizzle-local-postgres-cloud.md) parity) |
| `mime_type` | TEXT | NOT NULL |
| `modality` | TEXT | NOT NULL — CHECK in (`image`, `audio`, `video`, `document`) (the `@relavium/shared` `MEDIA_MODALITIES` set) |
| `byte_length` | INTEGER | NOT NULL — what a `read_media` `Range` request is bounded against (host-populated; never a client-supplied size) |
| `duration_ms` | INTEGER | NULL — audio/video only |
| `last_referenced_at` | INTEGER | NOT NULL — epoch-ms; the grace-window basis for GC |
| `deleted_at` | INTEGER | NULL — soft-delete (the table convention); set by GC byte-reclamation |
| `created_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX media_objects_handle_unique ON media_objects (handle);
CREATE INDEX idx_media_objects_gc ON media_objects (last_referenced_at) WHERE deleted_at IS NULL;
```

#### `media_references`

The **per-distinct-reference junction** the refcount derives from, and the persistence home of the `read_media` scope-set authz. Cascades from `media_objects`.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `handle` | TEXT | NOT NULL REFERENCES `media_objects(handle)` ON DELETE CASCADE |
| `scope_kind` | TEXT | NOT NULL — CHECK in (`run`, `node`, `session`, `workspace`) (the `MEDIA_SCOPE_KINDS` superset) |
| `scope_id` | TEXT | NOT NULL |
| `created_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_media_references_unique ON media_references (handle, scope_kind, scope_id);
CREATE INDEX idx_media_references_scope  ON media_references (scope_kind, scope_id);
CREATE INDEX idx_media_references_handle ON media_references (handle);
```

> **Refcount ↔ authz keying — one junction, two roles ([ADR-0042](../../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md) §3 / [ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md)).** A handle's refcount is its **row count** here. `scope_kind` is a deliberate **superset**: `run` / `node` references are lifetime/refcount entries ONLY (the terminal-state sweep reclaims a run's `run` rows when it reaches `run:completed|failed|cancelled`), while `session` / (reserved) `workspace` are ALSO the `read_media` authz `Scope` kinds — `read_media` authz consults **only** the `session`/`workspace` rows, so a `run`/`node` reference **never grants read**. A handle may carry both a `run` reference (lifetime) and a `session` reference (authz); the terminal sweep removing the run row leaves the handle alive while a session row remains.

> **Retention / GC ([ADR-0042](../../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md) §4).** A handle whose reference count reaches zero enters a **grace window** (default **7 days**, measured from `last_referenced_at`); refcount-GC reclaims the bytes and sets `deleted_at` only after it elapses — distinct from the 90-day `run_events` prune. GC ownership is the host's (Rust on desktop / filesystem on CLI/VS Code).

## Common query patterns

| Pattern | Where it's used | Index relied on |
|---------|-----------------|-----------------|
| Replay a run's event stream in order | Run-detail log drawer | `idx_run_events_run_seq` |
| Resume a paused run from its last checkpoint | Human-gate resume | `idx_step_exec_run`, `idx_run_events_run_seq` |
| Cost analytics grouped by workflow/model | Cost tracking screen | `idx_runs_cost`, `idx_step_exec_cost` |
| List workflows with their last-run status | Workflows list screen | `idx_workflows_active` + a `ROW_NUMBER()` subquery (SQLite has no `DISTINCT ON`) |

> Postgres `DISTINCT ON (workflow_id)` for "latest run per workflow" is **not** supported in SQLite. Use `ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY created_at DESC)` instead — it works identically in both engines, easing the Phase-2 port.

## Concurrency & transaction behavior

`history.db` is a **single shared file** two concurrent `relavium` processes may write at once — e.g. a `run` persisting events while a `chat` refreshes the live model catalog ([ADR-0064](../../decisions/0064-live-model-catalog.md) §5). The Node/CLI path (`better-sqlite3`, [ADR-0021](../../decisions/0021-node-sqlite-driver-better-sqlite3.md)) hardens this at the connection and the transaction level; this is the one canonical home for the policy that `packages/db/src/retry.ts` and the store doc-comments cite.

- **Connection PRAGMAs** ([`client.ts`](../../../packages/db/src/client.ts)): `journal_mode = WAL` (readers never block the single writer, and vice-versa), `busy_timeout = 5000` (SQLite's built-in busy handler waits up to 5 s for a contended lock before returning `SQLITE_BUSY`), `synchronous = NORMAL` (the recommended durability/throughput trade-off under WAL), and `foreign_keys = ON`.
- **Write transactions use `BEGIN IMMEDIATE`**, never drizzle's `DEFERRED` default. A DEFERRED transaction that reads before it writes takes a read lock first and must *upgrade* to a write lock on the first write — if another connection committed in between, that upgrade fails immediately with `SQLITE_BUSY` (`SQLITE_BUSY_SNAPSHOT`), which `busy_timeout` does **not** cover. `BEGIN IMMEDIATE` takes the write lock up front, so the upgrade race cannot occur. Applied to every multi-statement writer: `persistEvent` (run history), the model-catalog `replaceProviderModels` (bulk live-upsert) and `upsert` (per-model pricing), and the provider `upsert` read-then-write. It applies only to the OUTERMOST `BEGIN` — a store method called inside another transaction is demoted to a `SAVEPOINT` and the IMMEDIATE behavior is ignored, so a future batch-in-one-transaction caller must itself open `BEGIN IMMEDIATE`.
- **The bounded retry** (`packages/db/src/retry.ts`, `withBusyRetry`) wraps those write transactions and retries only `SQLITE_BUSY`/`SQLITE_LOCKED` up to a bounded attempt budget (default 5) with a **deterministic** linear backoff — **no jitter**, never `Math.random`, per the no-jitter/deterministic-replay convention of [ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md). It is **fail-loud**: on an exhausted budget (or any non-lock fault) it rethrows the original error and never silently drops a write, preserving [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)'s durability-first `persistEvent` posture. A retried transaction rolls back with no partial write and re-runs the whole (idempotent) body. Because each attempt's `BEGIN IMMEDIATE` can itself wait up to `busy_timeout` (5 s) for the lock, the compounded worst case under sustained contention is ~25 s (5 attempts × 5 s + the sub-300 ms backoffs) of a synchronous block before the fail-loud rethrow — a deliberate durability-over-latency trade on a path that only stalls under pathological multi-writer contention.
- **Single-statement writes** (e.g. `appendMessage`, `setKeychainRef`) go straight for the write lock and rely on SQLite's built-in busy handler (`busy_timeout`); they need no explicit transaction.
- **Reads that must be consistent across statements** use a read transaction: `sessionStore.loadFull` reads the session row and its transcript inside one deferred transaction so **both reads observe a single consistent DB snapshot** (never a two-`SELECT` straddle across a concurrent commit). Note this guarantees *snapshot* consistency, not *turn* atomicity: the CLI persister writes a turn's messages and its updated session totals as separate auto-committed statements, so a snapshot can still legitimately observe messages ahead of their totals. A "totals always match the returned messages" guarantee would additionally require the host to persist each turn in one transaction (a tracked follow-up).
- **Cross-platform:** `BEGIN IMMEDIATE` + the retry behave identically on every OS. The `0600`/`0700` at-rest guard below is a documented Windows no-op, so the concurrency test lane gates POSIX-permission assertions off Windows only.

This realizes the concurrent-process write requirement recorded in the [ADR-0064](../../decisions/0064-live-model-catalog.md) §5 amendment note (2.5.I).

## Encryption at rest

At-rest encryption of `history.db` is **per-surface**:

- **Desktop:** opened with SQLCipher. The passphrase is derived from a stable machine secret (combined with the OS keychain entry) so the database opens on restart without prompting the user; see [keychain-and-secrets.md](keychain-and-secrets.md).
- **CLI (Phase 2):** opened with `better-sqlite3` **unencrypted**, guarded by owner-only OS file permissions — `~/.relavium/` at `0700` and `history.db` (with its `-wal`/`-shm` sidecars) at `0600`, set with an explicit `chmod` (umask-independent, applied even to a pre-existing directory). On Windows, POSIX mode bits do not apply (`chmod` is a no-op); protection falls to the per-user `%USERPROFILE%` NTFS ACL. The file holds **no credentials** — keys stay in the OS keychain ([ADR-0006](../../decisions/0006-os-keychain-for-api-keys.md)) and the engine masks secrets at the bus before persistence ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) — so the unencrypted-at-rest content is run data (prompts, outputs, costs), not secrets. Rationale and the cross-surface Phase-3 follow-on: [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md).

The per-project `runs.db` is **not** encrypted on any surface because it is intentionally git-committed and contains only non-sensitive run metadata (no prompts, completions, or tokens).

### Secrets at the write boundary

The history writer is **pass-through** for secrets — it never re-masks (the engine already masked secret-typed inputs and tool I/O at the `RunEventBus`, [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) and adds **no** runtime secret-detection (infeasible on opaque JSON). The no-raw-secret invariant on the unsafe columns — `run_events.payload_json`, the `step_executions` `input_json` / `output_json` / `error_json`, `run_costs`, and `runs.workflow_definition_snapshot` — is therefore the **upstream masking guarantee**, regression-guarded by the package's **secrets fixture** (`run-history-store.test.ts`): a raw API key, `Authorization` header, or `secret`-typed value must never appear in these columns; a `secret`-typed value persists only as its `{ secret: true, ref }` placeholder. (A future desktop/cloud history writer inherits the same contract — masking is upstream, verification is by fixture; it must not be expected to implement a runtime secret scan.)

## Phase 2 (PostgreSQL) divergences

> The following applies only to **Phase 2 cloud execution**. None of it ships in Phase 1. See [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md) for the full design and the complete 14-item SQLite-vs-Postgres porting table.

Drizzle ORM is used for both engines, so table and column names are identical and only the driver changes. The notable divergences:

- **Types restored to native Postgres**: `TEXT` UUIDs → `UUID DEFAULT gen_random_uuid()`; JSON `TEXT` → `JSONB` (with GIN indexes on `tags`, `definition`); epoch `INTEGER` → `TIMESTAMPTZ`; micro-cent `INTEGER` → `NUMERIC(14,8)`; `CHECK`-string statuses → native enums.
- **Multi-tenancy**: an `org_id` column is added to every table with Postgres row-level security and team-level sharing permissions.
- **`run_events` partitioning**: the unbounded event log uses Postgres declarative `RANGE`-by-month partitioning (or a TimescaleDB hypertable) with `pg_cron` retention `DROP TABLE`. SQLite has no partitioning, hence the local 90-day archive/prune job.
- **Concurrency**: Postgres MVCC supports many concurrent writers; SQLite's single-writer WAL lock is adequate locally but would bottleneck cloud-scale parallel runs.
- **Reintroduced tables**: `workflow_schedules` (cron/interval triggers) becomes functional in Phase 2; `*_versions` tables may return if portal-managed (non-git) versioning is needed.

### Managed-inference tables (Phase 2)

> These tables exist **only in the Phase-2 managed-inference gateway** and have **no SQLite/local counterpart** — managed inference is a cloud capability (Relavium holds the provider key and meters usage; see [../../architecture/managed-inference.md](../../architecture/managed-inference.md)). They are Postgres-native and follow the same Phase-2 conventions as every other cloud table: integer **micro-cents** for money, an `org_id` column with **row-level security**, `TIMESTAMPTZ` timestamps, and `JSONB` blobs. They are governed by [ADR-0013](../../decisions/0013-managed-key-vault-and-pools.md) (key vault/pools), [ADR-0014](../../decisions/0014-managed-metering-quota-and-billing.md) (metering/quota/billing), and [ADR-0015](../../decisions/0015-managed-mode-data-handling-and-compliance.md) (data handling).

#### `provider_key_pool`

The pool of **Relavium's own** provider keys the gateway draws from, one row per key. The **key value is never stored here** — only a reference to the KMS entry that holds it, mirroring the local "keychain ref, not the key" rule for `llm_providers.api_key_keychain_ref`. Multiple rows per provider give per-provider rate-limit headroom, rotation, and 429-cooldown.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT `gen_random_uuid()` |
| `org_id` | UUID | NOT NULL — RLS tenant (platform-org for the shared pool) |
| `provider` | TEXT | NOT NULL — `anthropic` / `openai` / `gemini` / `deepseek` |
| `region` | TEXT | NULL — segregation key for residency/ban containment |
| `kms_key_ref` | TEXT | NOT NULL — **reference to the KMS entry; never the key value** |
| `status` | TEXT | NOT NULL DEFAULT `'active'` — enum `('active','cooldown','rotating','retired','quarantined')` |
| `cooldown_until` | TIMESTAMPTZ | NULL — set on a 429; key skipped until then |
| `last_used_at` | TIMESTAMPTZ | NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |

```sql
CREATE INDEX idx_pkp_provider_status ON provider_key_pool (provider, status) WHERE status = 'active';
ALTER TABLE provider_key_pool ENABLE ROW LEVEL SECURITY;
```

#### `subscriptions`

A **mirror of the billing provider's subscription state** — the control plane's source of truth for "what tier is this org on, and is it current." Synced from **billing-provider webhooks** (the merchant-of-record is the primary rail; a direct Stripe integration is the mutually-exclusive alternative — [ADR-0014](../../decisions/0014-managed-metering-quota-and-billing.md), [tech-stack.md](../../tech-stack.md)); never authoritative over the billing provider. The columns are **provider-neutral**: `billing_provider` records which rail issued the ids, and `billing_customer_id` / `billing_subscription_id` hold that rail's identifiers.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT `gen_random_uuid()` |
| `org_id` | UUID | NOT NULL UNIQUE — RLS tenant |
| `billing_provider` | TEXT | NOT NULL — `paddle` / `lemonsqueezy` / `stripe` (MoR primary; Stripe is the alternative rail) |
| `billing_customer_id` | TEXT | NOT NULL — customer id in the configured billing provider |
| `billing_subscription_id` | TEXT | NULL — subscription id in the configured billing provider |
| `tier` | TEXT | NOT NULL — `free` / `pro` / `team` / `enterprise` (see [../portal/api-reference.md](../portal/api-reference.md#licensing-tiers)) |
| `status` | TEXT | NOT NULL — mirrors the billing provider (`active`,`past_due`,`canceled`,`trialing`,…) |
| `included_usage_microcents` | INTEGER | NOT NULL DEFAULT 0 — the **hard included-usage cap** for the period |
| `prepaid_credit_microcents` | INTEGER | NOT NULL DEFAULT 0 — remaining prepaid balance |
| `current_period_start` | TIMESTAMPTZ | NULL |
| `current_period_end` | TIMESTAMPTZ | NULL |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |

```sql
CREATE UNIQUE INDEX idx_subscriptions_org ON subscriptions (org_id);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
```

#### `quota_policies`

The enforceable budget/quota **policy** per org (the control-plane record the gateway reads at reserve time). Separate from `subscriptions` so a tier can carry several policies (per-day, per-model) and so enterprise can set custom limits.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT `gen_random_uuid()` |
| `org_id` | UUID | NOT NULL — RLS tenant |
| `scope` | TEXT | NOT NULL — `org` / `user` / `model` |
| `scope_ref` | TEXT | NULL — user id or canonical model id when scoped |
| `period` | TEXT | NOT NULL — `day` / `month` |
| `budget_microcents` | INTEGER | NOT NULL — the cap for the period |
| `enforcement` | TEXT | NOT NULL DEFAULT `'hard_stop'` — `warn` / `throttle` / `hard_stop` |
| `warn_threshold_pct` | INTEGER | NOT NULL DEFAULT 80 |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |

```sql
CREATE INDEX idx_quota_policies_org_scope ON quota_policies (org_id, scope, period) WHERE is_active;
ALTER TABLE quota_policies ENABLE ROW LEVEL SECURITY;
```

#### `usage_events`

The **immutable, append-only billing ledger** — one row per metered managed request, written when the gateway **settles** the reserve→settle metering (see [../../architecture/managed-inference.md](../../architecture/managed-inference.md#metering-quota-and-budgets-reserve--settle)). **No prompt or completion bodies are stored** — only counts and costs (meter content, not text; [ADR-0015](../../decisions/0015-managed-mode-data-handling-and-compliance.md)). The UNIQUE `request_id` is what makes settle **idempotent**: a retried settle is a no-op, so a delivery retry can never double-bill. Because it is unbounded and time-ordered, it uses the same **`RANGE`-by-month partitioning** as `run_events`.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT `gen_random_uuid()` |
| `org_id` | UUID | NOT NULL — RLS tenant |
| `request_id` | TEXT | NOT NULL **UNIQUE** — idempotency key for reserve→settle |
| `user_id` | UUID | NULL — the member who incurred the usage |
| `provider` | TEXT | NOT NULL — `anthropic` / `openai` / `gemini` / `deepseek` |
| `model_id` | TEXT | NOT NULL — canonical model id (the pricing key) |
| `pool_key_id` | UUID | NOT NULL REFERENCES `provider_key_pool(id)` — which Relavium key served it |
| `input_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `output_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cache_read_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `cache_write_tokens` | INTEGER | NOT NULL DEFAULT 0 |
| `usage_source` | TEXT | NOT NULL DEFAULT `'streamed'` — `streamed` / `estimated` / `reconciled` (how the counts were obtained) |
| `provider_cost_microcents` | INTEGER | NOT NULL — **COGS**: Relavium's cost from the canonical pricing table |
| `billed_cost_microcents` | INTEGER | NOT NULL — what the tenant is charged (margin = billed − provider) |
| `occurred_at` | TIMESTAMPTZ | NOT NULL — partition key |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |

```sql
-- immutable ledger: append-only, no UPDATE/DELETE in normal operation
CREATE UNIQUE INDEX idx_usage_events_request ON usage_events (request_id);
CREATE INDEX idx_usage_events_org_time ON usage_events (org_id, occurred_at DESC);
CREATE INDEX idx_usage_events_org_model ON usage_events (org_id, model_id, occurred_at DESC);
-- PARTITION BY RANGE (occurred_at) — monthly partitions, pg_cron retention, as for run_events
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
```

#### `usage_aggregates_daily`

A pre-rolled **daily rollup** of `usage_events` per org (and per model) so the portal's usage/quota dashboards and the reserve-time per-day budget check do not scan the raw ledger. Rebuilt by the nightly reconciliation job, so it is the **reconciled** view of spend.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | UUID | PRIMARY KEY DEFAULT `gen_random_uuid()` |
| `org_id` | UUID | NOT NULL — RLS tenant |
| `day` | DATE | NOT NULL |
| `model_id` | TEXT | NULL — NULL row = all-models total for the day |
| `input_tokens` | BIGINT | NOT NULL DEFAULT 0 |
| `output_tokens` | BIGINT | NOT NULL DEFAULT 0 |
| `request_count` | INTEGER | NOT NULL DEFAULT 0 |
| `provider_cost_microcents` | BIGINT | NOT NULL DEFAULT 0 |
| `billed_cost_microcents` | BIGINT | NOT NULL DEFAULT 0 |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT `now()` |

```sql
CREATE UNIQUE INDEX idx_usage_agg_daily_org_day_model ON usage_aggregates_daily (org_id, day, COALESCE(model_id, ''));
CREATE INDEX idx_usage_agg_daily_org_day ON usage_aggregates_daily (org_id, day DESC);
ALTER TABLE usage_aggregates_daily ENABLE ROW LEVEL SECURITY;
```
