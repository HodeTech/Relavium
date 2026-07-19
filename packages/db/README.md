# `@relavium/db`

Drizzle schema + migrations + the local SQLite client — **one schema, two dialects**
(SQLite local, Postgres cloud) ([ADR-0005](../../docs/decisions/0005-sqlite-drizzle-local-postgres-cloud.md)).
Canonical DDL: [database-schema.md](../../docs/reference/shared-core/database-schema.md).

## Status

**Phase 0 scaffold (workstream 0.I).** Built but **not wired into a running engine** —
its Phase-1 (engine checkpoint/resume) and Phase-2 (CLI run history) consumers come
later. The package ships:

- The **Drizzle SQLite schema** ([src/schema.ts](src/schema.ts)) for the nine Phase-1
  tables — `llm_providers`, `model_catalog`, `agents`, `workflows`, `runs`,
  `step_executions`, `messages`, `run_events`, `run_costs` — mirroring the canonical DDL.
- A **`drizzle-kit` migration set** ([drizzle/](drizzle/)).
- The **SQLite client factory + migration runner** ([src/client.ts](src/client.ts)) over
  `better-sqlite3` ([ADR-0021](../../docs/decisions/0021-node-sqlite-driver-better-sqlite3.md)).
- A **smoke test** that applies every migration to a fresh DB and round-trips a row.

Its runtime dependencies are `@relavium/shared` (the contract enums its CHECKs reuse),
`drizzle-orm` ([ADR-0005](../../docs/decisions/0005-sqlite-drizzle-local-postgres-cloud.md)),
and the `better-sqlite3` Node driver
([ADR-0021](../../docs/decisions/0021-node-sqlite-driver-better-sqlite3.md)); `drizzle-kit`
is a dev dependency.

## Conventions (from the canonical DDL)

- **UUID** primary keys are `TEXT`, generated in app code — never a DB default.
- **JSON** is `TEXT` (a JSON string); **tags** are a JSON array as `TEXT`.
- **Timestamps** are `INTEGER` epoch-milliseconds; **money** is `INTEGER` micro-cents.
- **Enums** are `TEXT` + a `CHECK (... IN (...))`. The `runs.status` / `runs.execution_mode`
  value sets are imported from `@relavium/shared` so the persisted CHECK can never drift
  from the logical contract.
- **Soft delete** is a nullable `deleted_at` with partial indexes (`WHERE deleted_at IS NULL`).
- Table/column names are kept **dialect-identical** for the Phase-2 Postgres port.
- The client applies `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.

The desktop reaches SQLite through the Rust `tauri-plugin-sql` (SQLCipher-encrypted at
rest); this `better-sqlite3` client is the **Node-side** path (tests now, CLI later).

## Scripts

| Script | What it does |
|--------|--------------|
| `build` | `tsc -p tsconfig.build.json` → `dist/` |
| `typecheck` | `tsc -p tsconfig.json --noEmit` (includes tests) |
| `lint` | `eslint src` |
| `test` | `vitest run` (the migration + round-trip smoke test) |
| `db:generate` | `drizzle-kit generate` — diff `src/schema.ts` → a new migration in `drizzle/` |
