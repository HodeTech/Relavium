# Desktop Database Schema (Local SQLite)

> Last updated: 2026-06-03

- **Status**: Reference
- **Surface**: Desktop (Tauri v2)
- **Scope**: Phase 1, local-first. SQLite via `tauri-plugin-sql`, schema managed by Drizzle ORM in `packages/db` (see [project-structure.md](../../project-structure.md)).
- **Related**: [keychain-and-secrets.md](keychain-and-secrets.md), [tauri-plugins.md](tauri-plugins.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md), [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md)

This is the canonical reference for the **local** run-history and catalog database that the desktop app persists on the user's machine. There is no cloud, no account, and no server in Phase 1 — every table below lives in a single encrypted SQLite file. The Phase-2 PostgreSQL divergences are described at the end and detailed in [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).

## Storage layout

```mermaid
flowchart TB
  subgraph Global["~/.relavium/ (global, cross-project)"]
    H["history.db<br/>(SQLCipher-encrypted)<br/>full run + event + cost history"]
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
| Global history | `~/.relavium/history.db` | SQLCipher (key from OS keychain) | Full runs, every event, every cost row, the catalog tables | Never committed |
| Project history | `{projectRoot}/.relavium/runs.db` | None | Run **metadata only** (no event payloads) so teammates see historical run summaries after a `git pull` | Committed |

The database is opened with `PRAGMA journal_mode = WAL` for concurrent read performance and `PRAGMA foreign_keys = ON` per connection (SQLite does **not** enforce foreign keys by default). Run events in `history.db` are pruned after 90 days by a background job that runs on app launch.

> Workflows and agents are **not** the database's source of truth. The git-committable YAML files (`.relavium.yaml` / `.agent.yaml`) are authoritative; see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md) and [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md). The catalog tables below cache and snapshot them for fast querying, run reproducibility, and offline browsing.

## SQLite type conventions

Because this schema is adapted from a Postgres-first design (see [../../analysis/_archive/](../../analysis/_archive/)), the following local-first conventions apply consistently across every table:

| Concept | Postgres (Phase 2) | SQLite (Phase 1, here) |
|---------|--------------------|------------------------|
| Primary key | `UUID DEFAULT gen_random_uuid()` | `TEXT` UUID generated in application code (Drizzle) |
| Structured blob | `JSONB` | `TEXT` (JSON string); query with `json_extract()` |
| String array (tags) | `TEXT[]` | `TEXT` (JSON array, e.g. `["review","ci"]`); query with `json_each()` |
| Timestamp | `TIMESTAMPTZ` | `INTEGER` (Unix epoch ms) for reliable ordering; timezone handled in app code |
| Money / cost | `NUMERIC(14,8)` | `INTEGER` micro-cents (USD x 1,000,000) to avoid IEEE-754 rounding |
| Enum | `CREATE TYPE ... AS ENUM` | `TEXT` with a `CHECK` constraint |
| Soft delete | `deleted_at TIMESTAMPTZ` partial index | `deleted_at INTEGER NULL`; partial indexes supported since SQLite 3.8.9 |

A full 14-item porting table lives in [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).

## Tables

The local schema is the Postgres 13-table design reduced to what a single-user, local-first app needs. The two LangGraph checkpoint tables are **dropped** (the engine is pure TypeScript — no LangGraph; see [decision 0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md)). `workflow_schedules` is **Phase 2 only** (schedule/webhook triggers require a cloud listener; see [../../ideas/scheduled-and-webhook-triggers.md](../../ideas/scheduled-and-webhook-triggers.md)). The `*_versions` tables are unnecessary locally because version history is provided by git on the YAML files.

### Catalog tables

#### `llm_providers`

Registered LLM providers. The actual API key never lives here — only a reference; the key is stored in the OS keychain (see [keychain-and-secrets.md](keychain-and-secrets.md)).

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `name` | TEXT | NOT NULL UNIQUE (e.g. `anthropic`, `openai`) |
| `display_name` | TEXT | NOT NULL |
| `base_url` | TEXT | NOT NULL |
| `api_key_keychain_ref` | TEXT | NULL — keychain `account` identifier, not the key itself |
| `default_headers` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `is_active` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `deleted_at` | INTEGER | NULL |
| `created_at` | INTEGER | NOT NULL |
| `updated_at` | INTEGER | NOT NULL |

```sql
CREATE UNIQUE INDEX idx_llm_providers_name ON llm_providers (name) WHERE deleted_at IS NULL;
```

#### `model_catalog`

Models offered by each provider, including pricing used for local cost tracking. Costs are stored as integer micro-cents.

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
| `supports_tool_calling` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `supports_vision` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `supports_streaming` | INTEGER (bool) | NOT NULL DEFAULT 1 |
| `supports_json_mode` | INTEGER (bool) | NOT NULL DEFAULT 0 |
| `capabilities` | TEXT (JSON) | NOT NULL DEFAULT `'{}'` |
| `deprecation_date` | INTEGER | NULL |
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

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | TEXT | PRIMARY KEY (UUID) |
| `workflow_id` | TEXT | NOT NULL REFERENCES `workflows(id)` |
| `workflow_path` | TEXT | NULL — source `.relavium.yaml` path |
| `project_root` | TEXT | NULL — workspace that owned the run |
| `workflow_definition_snapshot` | TEXT (JSON) | NOT NULL |
| `status` | TEXT | NOT NULL DEFAULT `'pending'` — `CHECK (status IN ('pending','running','paused','completed','failed','cancelled'))` |
| `trigger_type` | TEXT | NOT NULL DEFAULT `'manual'` (`manual`, `file_change`; `webhook`/`schedule` are Phase 2) |
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
CREATE INDEX idx_run_events_run_seq    ON run_events (run_id, seq ASC);
CREATE INDEX idx_run_events_step        ON run_events (step_execution_id, ts ASC) WHERE step_execution_id IS NOT NULL;
CREATE INDEX idx_run_events_run_type    ON run_events (run_id, event_type, ts ASC);
```

> `token`-level events are high volume. They are stored to support full replay but are the primary target of the 90-day pruning job; `runs`/`step_executions` metadata is retained longer.

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

## Common query patterns

| Pattern | Where it's used | Index relied on |
|---------|-----------------|-----------------|
| Replay a run's event stream in order | Run-detail log drawer | `idx_run_events_run_seq` |
| Resume a paused run from its last checkpoint | Human-gate resume | `idx_step_exec_run`, `idx_run_events_run_seq` |
| Cost analytics grouped by workflow/model | Cost tracking screen | `idx_runs_cost`, `idx_step_exec_cost` |
| List workflows with their last-run status | Workflows list screen | `idx_workflows_active` + a `ROW_NUMBER()` subquery (SQLite has no `DISTINCT ON`) |

> Postgres `DISTINCT ON (workflow_id)` for "latest run per workflow" is **not** supported in SQLite. Use `ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY created_at DESC)` instead — it works identically in both engines, easing the Phase-2 port.

## Encryption at rest

`history.db` is opened with SQLCipher. The passphrase is derived from a stable machine secret (combined with the OS keychain entry) so the database opens on restart without prompting the user; see [keychain-and-secrets.md](keychain-and-secrets.md). The per-project `runs.db` is **not** encrypted because it is intentionally git-committed and contains only non-sensitive run metadata (no prompts, completions, or tokens).

## Phase 2 (PostgreSQL) divergences

> The following applies only to **Phase 2 cloud execution**. None of it ships in Phase 1. See [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md) for the full design and the complete 14-item SQLite-vs-Postgres porting table.

Drizzle ORM is used for both engines, so table and column names are identical and only the driver changes. The notable divergences:

- **Types restored to native Postgres**: `TEXT` UUIDs → `UUID DEFAULT gen_random_uuid()`; JSON `TEXT` → `JSONB` (with GIN indexes on `tags`, `definition`); epoch `INTEGER` → `TIMESTAMPTZ`; micro-cent `INTEGER` → `NUMERIC(14,8)`; `CHECK`-string statuses → native enums.
- **Multi-tenancy**: an `org_id` column is added to every table with Postgres row-level security and team-level sharing permissions.
- **`run_events` partitioning**: the unbounded event log uses Postgres declarative `RANGE`-by-month partitioning (or a TimescaleDB hypertable) with `pg_cron` retention `DROP TABLE`. SQLite has no partitioning, hence the local 90-day archive/prune job.
- **Concurrency**: Postgres MVCC supports many concurrent writers; SQLite's single-writer WAL lock is adequate locally but would bottleneck cloud-scale parallel runs.
- **Reintroduced tables**: `workflow_schedules` (cron/interval triggers) becomes functional in Phase 2; `*_versions` tables may return if portal-managed (non-git) versioning is needed.
