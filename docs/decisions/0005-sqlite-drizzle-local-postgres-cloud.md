# ADR-0005: SQLite + Drizzle local, PostgreSQL cloud

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0001-tauri-v2-over-electron.md](0001-tauri-v2-over-electron.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0021-node-sqlite-driver-better-sqlite3.md](0021-node-sqlite-driver-better-sqlite3.md), [tech-stack.md](../tech-stack.md)

> Amended 2026-06-04: this ADR fixed "SQLite + Drizzle" and the desktop's encrypted
> `tauri-plugin-sql` path but left the **Node-side** SQLite driver open. That gap is now
> closed by [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md): `@relavium/db` uses
> `better-sqlite3` for its Node consumers (the migration runner, tests, and the Phase-2
> CLI). The decision here is unchanged.

## Context

Relavium persists run history, the per-run event log, and per-node cost data so the desktop app can show run monitoring and cost tracking, and so the engine can resume paused runs (e.g. after a human gate). The data model is concrete and documented in [reference/desktop/database-schema.md](../reference/desktop/database-schema.md): run history (`runs`, `step_executions`, `run_events`, `run_costs`, `messages`), catalog tables, and per-project metadata — see [reference/desktop/database-schema.md](../reference/desktop/database-schema.md) for the canonical, fuller set.

Phase 1 is local-first with no cloud dependency and no account (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)), so this store must be **embedded, file-based, and encryptable at rest** — it holds prompts, outputs, and tool I/O that may be sensitive. Phase 2 adds cloud execution where many concurrent workers read and write shared run state, which is a different storage profile entirely. The schema and ORM must serve both without forking the data model.

## Decision

**We use SQLite + Drizzle ORM locally (Phase 1), encrypted with SQLCipher, and PostgreSQL 16 + Redis 7 + BullMQ in the cloud (Phase 2).** Drizzle is the single ORM/schema layer across both, in `packages/db`.

Considered options:

1. **SQLite (local) → PostgreSQL (cloud), unified by Drizzle** — embedded in Phase 1, server-grade in Phase 2, one schema dialect-targeted to both. *Chosen.*
2. **PostgreSQL from day one** — one engine everywhere, but requires a running server even for local single-user use.
3. **A non-SQL embedded store (e.g. an embedded KV / document store)** — simple locally but a hard pivot for the relational Phase-2 model.

SQLite is the right local store: it is a single encrypted file, needs no server, and Tauri exposes it through `tauri-plugin-sql` (see [ADR-0001](0001-tauri-v2-over-electron.md) and [reference/desktop/tauri-plugins.md](../reference/desktop/tauri-plugins.md)). Encryption at rest is provided by the SQLCipher feature, with the passphrase derived from a stable machine secret in the Tauri setup hook so the database opens on restart without prompting; this complements keychain-based key storage from [ADR-0006](0006-os-keychain-for-api-keys.md). `journal_mode=WAL` gives concurrent-read performance for the UI while a run writes events. Requiring a Postgres server for local single-user use (Option 2) would violate the zero-dependency, no-account Phase-1 promise.

PostgreSQL 16 + Redis 7 + BullMQ is the Phase-2 cloud store: Postgres for structured run state at concurrency, Redis for the real-time event fan-out to connected stream clients, and BullMQ for the run queue feeding cloud workers. This is **Phase-2-only** and must not leak into Phase-1 design. Drizzle is the single ORM across both targets so one schema definition and one migration toolchain serve SQLite and Postgres, keeping the [database schema](../reference/desktop/database-schema.md) canonical in one place. Dialect differences between SQLite and Postgres are handled in `packages/db` and are explicitly called out where they matter. Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Phase 1 needs no server, no account, and no cloud: run history is a single local file, satisfying the local-first promise of [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md).
- SQLCipher encrypts run data at rest, so prompts, outputs, and tool I/O are protected on disk alongside keychain-stored secrets ([ADR-0006](0006-os-keychain-for-api-keys.md)).
- WAL mode lets the UI read run history while a run is actively writing events, keeping run monitoring responsive.
- One Drizzle schema and migration toolchain spans SQLite and Postgres, so the Phase-1 → Phase-2 storage move is a dialect/target change rather than a data-model rewrite.
- Postgres + Redis + BullMQ is a well-understood stack for concurrent cloud execution when Phase 2 arrives.

### Negative

- SQLite and Postgres are not identical; some column types and queries must be written dialect-aware in `packages/db`, and migrations must be validated against both targets.
- SQLCipher requires the passphrase to be set before the database is opened (in the Tauri Rust setup hook) and derived from a stable machine secret; getting this wrong means the database fails to open or re-prompts on every launch.
- Operating two database engines across phases is more surface area than committing to one; accepted because neither engine alone fits both the embedded local and concurrent cloud profiles.
- Local run history does not automatically appear in the cloud; Phase-2 sync of historical local runs is an explicit, opt-in concern documented in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md), not an implicit migration.
