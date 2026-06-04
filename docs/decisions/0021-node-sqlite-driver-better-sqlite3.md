# ADR-0021: better-sqlite3 as the Node-side SQLite driver for `@relavium/db`

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md), [ADR-0001](0001-tauri-v2-over-electron.md), [ADR-0018](0018-desktop-execution-and-rust-egress.md), [tech-stack.md](../tech-stack.md)

## Context

[ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) settled the store —
**SQLite + Drizzle locally, PostgreSQL cloud, one Drizzle schema in `packages/db`** —
but it named only the *desktop's* SQLite access path (`tauri-plugin-sql`, Rust-side,
SQLCipher-encrypted; see [ADR-0001](0001-tauri-v2-over-electron.md) and
[ADR-0018](0018-desktop-execution-and-rust-egress.md)). It left **open** which driver
the *Node-side* consumers use. That gap has to be closed in Phase 0 (workstream 0.I),
because the `@relavium/db` scaffold needs a concrete driver for two things that run in
Node, not in the Tauri WebView:

- the **migration runner / client factory** the package exports, and
- the **Vitest smoke test** that opens a fresh database, applies every `drizzle-kit`
  migration, and round-trips a row.

Phase-2's CLI run-history reader is also a Node consumer. The desktop reaches SQLite
through the Rust plugin and does **not** load this driver, so the choice is scoped to
Node contexts (tests now, CLI later), not the desktop binary.

Constraints that frame the choice: the repo's runtime floor is `engines.node >= 20.11.0`
(`.nvmrc` pins the 22 line); CI must build the driver without a bespoke native toolchain;
and CLAUDE.md non-negotiable #2 forbids a new runtime dependency without an ADR — hence
this record. Drizzle is fixed by ADR-0005; only the underlying driver is being decided.

## Decision

**We use `better-sqlite3` as the Node-side SQLite driver for `@relavium/db`, wired
through Drizzle's `drizzle-orm/better-sqlite3` adapter and its migrator.** Versions are
pinned in [tech-stack.md](../tech-stack.md) via the pnpm catalog.

Considered options:

1. **`better-sqlite3` + `drizzle-orm/better-sqlite3`** — Drizzle's reference SQLite
   driver. Synchronous, which keeps the client factory and the migration runner trivial
   (no async ceremony around schema setup); runs on Node ≥ 20.11 (matches `engines`); and
   ships prebuilt binaries for common platforms so CI needs no native compiler. *Chosen.*
2. **Node's built-in `node:sqlite`** — zero added dependency, but it requires Node ≥ 22.5
   (above our 20.11 floor), is still flagged experimental, and Drizzle's adapter for it is
   immature. Adopting it would force raising the Node floor for a Phase-0 scaffold and bet
   on an unstable API. *Rejected.*
3. **`@libsql/client` + `drizzle-orm/libsql`** — cross-platform and async, but oriented at
   remote / embedded-replica libSQL use we do not need for a single local file in Phase 1,
   and heavier than `better-sqlite3` for no Phase-1 benefit. *Rejected.*

This decision concerns only the Node-side **driver**. It does not touch the desktop's
encrypted `tauri-plugin-sql` path, the dialect-identical schema, or the Phase-2 Postgres
port — those remain as set by ADR-0005.

## Consequences

### Positive

- The `@relavium/db` client factory and migration runner are synchronous and small; the
  0.I smoke test can open a fresh DB, run every migration, and assert a round-trip with no
  async plumbing.
- Node ≥ 20.11 compatibility holds, so the documented `engines` floor stays honest and a
  fresh checkout builds on the pinned toolchain without extra setup.
- Prebuilt binaries mean CI installs the driver without a native build step in the common
  case, keeping the 0.G pipeline fast and deterministic.
- It is the most documented Drizzle SQLite path, so Phase-1/2 Node consumers (CLI run
  history) inherit a well-trodden integration.

### Negative

- `better-sqlite3` is a native module: platforms without a prebuilt binary fall back to a
  source build (needs a C++ toolchain), and the binary is ABI-bound to the Node version —
  mitigated by pinning Node via `.nvmrc` and installing with a frozen lockfile in CI.
- It is a Node-only driver and is **not** the desktop's runtime path (the desktop uses the
  Rust `tauri-plugin-sql`), so the persistence layer is exercised through two different
  SQLite bindings; the single Drizzle schema is the shared contract that keeps them honest,
  and migrations must be validated against the desktop path when that surface lands.
- Synchronous I/O blocks the calling thread; acceptable for the CLI and tests, and a
  non-issue for the desktop, which never loads this driver.
