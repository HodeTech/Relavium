# ADR-0073: `runMigrations` is serialized across processes by an OS lock file, not by a transaction

- **Status**: Proposed
- **Date**: 2026-07-29
- **Related**: [ADR-0064](0064-live-model-catalog.md) (its 2026-07-07 "2.5.I — DB write-path concurrency" amendment note establishes the `BEGIN IMMEDIATE` + bounded-retry convention this extends), [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md) + [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (the synchronous driver), [ADR-0050](0050-cli-history-db-at-rest-posture.md) (the `0700`/`0600` guard the lock file inherits), [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) (one schema, two dialects — the Postgres port must not inherit this mechanism). Canonical home for the mechanism: the "Concurrency & transaction behavior" section of [database-schema.md](../reference/shared-core/database-schema.md).

## Context

`~/.relavium/history.db` is a **single shared file** that two `relavium` processes may open at
once — the case [ADR-0064](0064-live-model-catalog.md) §5 already accepted and its 2.5.I
amendment note gave a concrete mechanism for. That note covers steady-state **writes**. It does
not cover **first-run migration**, which is a different race with a different shape.

`runMigrations` ([client.ts](../../packages/db/src/client.ts)) delegates to drizzle's
`migrate()`. Its synchronous SQLite implementation does three things in this order:

1. `CREATE TABLE IF NOT EXISTS __drizzle_migrations` — auto-committed, outside any transaction.
2. `SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1` —
   **also outside any transaction**. This single read decides which migrations are pending.
3. `BEGIN` (drizzle's **DEFERRED** default) → apply each pending migration's statements → `COMMIT`.

The deciding read in step 2 is therefore not covered by the write in step 3. Two processes
launched together against a fresh file — two shells, or a CLI and a VS Code extension host —
both observe an empty table, both decide the full migration set is pending, and both proceed.
One commits; the other then runs `CREATE TABLE \`runs\`` against a database that already has it
and dies with a raw `DrizzleError`. Reproduced live; recorded as finding `#99`.

The stakes are a **first-run** crash, which is the worst place to have one: the user has no
history to lose, but also no reason to believe the tool works. And the failure is timing-
dependent, so it survives casual testing.

Two constraints bound the solution space. The engine-purity rule (CLAUDE.md rule 5) does not
apply — `packages/db` is a Node-side package that already imports `node:fs`. But
[architectural-principles.md](../standards/architectural-principles.md) §9 does: **no new
runtime dependency without an ADR**, which rules out reaching for `proper-lockfile` and is part
of why this decision is being recorded rather than quietly implemented.

## Decision

**We will serialize the whole `runMigrations` batch across processes with an OS lock file at
`<db-path>.migrate.lock`, created with `openSync(path, 'wx')`, and fall back to a
run-then-reconcile retry when the lock cannot be created at all.**

The lock holder writes its pid and start time, releases in a `finally`, and a waiter that finds
a lock older than a stale threshold takes it over — a crashed holder must not wedge every future
invocation. The wait is bounded; a migration batch on a local SQLite file completes in
milliseconds, so any wait beyond a couple of seconds means something is wrong rather than slow.
`'wx'` (`O_CREAT|O_EXCL`) is the atomic-create idiom this repo already uses in
[config/write.ts](../../apps/cli/src/config/write.ts),
[media-write.ts](../../packages/db/src/media-write.ts) and the tool-host fs arm, so this
introduces a new *use*, not a new *technique*.

**This decision is scoped to migration.** It changes nothing about steady-state writes, which
keep ADR-0064's `BEGIN IMMEDIATE` + `withBusyRetry` convention unchanged, and it is a **Node/CLI**
mechanism: the Phase-6 Postgres port replaces it with a real advisory lock rather than inheriting
a lock file, and the desktop's Rust path is untouched.

Considered:

- **`BEGIN IMMEDIATE` around the migration batch** — *rejected: not implementable.* This was the
  originally-proposed fix and it cannot work against the migrator described above. Taking the
  write lock up front closes the read→write **upgrade** race, but the read that decides what to
  apply happens *before* the transaction, so both processes still decide identically; and we
  cannot hoist drizzle's `migrate()` into our own transaction, because its raw `BEGIN` would
  throw inside one. Recorded here explicitly so the option is not re-proposed.
- **Run-then-reconcile only, with no lock file** — *rejected as the primary, kept as the
  fallback.* On failure, re-run `migrate()` once: the loser's second pass observes the winner's
  committed row and applies nothing. It is roughly fifteen lines, keeps no state on disk, and has
  no stale-lock failure mode. But it **recovers from** the collision instead of preventing it,
  and its correctness rests entirely on every migration being replay-safe after a partial
  concurrent apply — a property that holds today only because drizzle wraps the batch in a
  transaction, and that no test would catch us losing. It is retained as the fallback for the
  case where the lock file genuinely cannot be created (a read-only directory, an exotic mount
  where `'wx'` is not atomic), where crashing would be strictly worse.
- **Owning the migration runner** — *rejected: highest risk, no proportionate gain.* Reading
  `_journal.json` and the `.sql` files ourselves and applying them inside one `BEGIN IMMEDIATE`
  is the only option that makes the read and the write genuinely atomic. But it obliges us to
  reproduce drizzle-kit's `hash` and `folderMillis` semantics exactly and forever: get it wrong
  and a released build re-applies every migration against a populated database. That is a much
  worse failure than the one being fixed, traded for elegance.
- **Doing nothing / documenting the race** — *rejected.* It is a live, reproduced first-run
  crash, and Wave 1 exists to stop exactly this class of bleeding.

## Consequences

### Positive

- Two processes racing a fresh `history.db` produce a clean **wait-and-continue** rather than a
  raw `DrizzleError` — the behaviour the finding asked for, not merely the absence of a crash.
- The guarantee is **independent of drizzle's internals**. If a future drizzle release changes
  where its deciding read sits, or makes a migration non-replay-safe, the lock still holds; the
  reconcile fallback alone would not.
- It generalizes to the migration we cannot see yet: a data-backfilling migration that is *not*
  idempotent on replay is safe under a lock and unsafe under reconcile-only.
- No new runtime dependency, and `'wx'` atomic-create is an idiom already established in three
  places in this repo.

### Negative

- **A new on-disk artifact with its own failure mode.** A crashed holder leaves a lock file
  behind. Mitigated by the stale-takeover threshold and the bounded wait — but a stale threshold
  is a tuning constant, and a wrong one either wedges startup or lets two processes in. The
  threshold is generous relative to a millisecond-scale batch, and the reconcile fallback still
  catches the double-entry case.
- **Two mechanisms instead of one** (lock, then reconcile), so there are two paths to test rather
  than one. Accepted deliberately: the fallback exists precisely for the environments where the
  primary cannot run, and both are covered by the two-process regression test.
- **A local-only answer to a general problem.** This does not serialize anything for the Phase-2
  cloud/Postgres path, which will need its own advisory lock. Named here so the Postgres port
  does not inherit a lock file by accident.
- The lock file sits beside `history.db` inside `~/.relavium/`, so it inherits ADR-0050's `0700`
  directory guard — but it is one more file a user may see and wonder about. It is named for what
  it is.
