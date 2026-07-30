# ADR-0073: `runMigrations` is serialized across processes by an OS lock file, not by a transaction

- **Status**: Accepted
- **Date**: 2026-07-29
- **Related**: [ADR-0064](0064-live-model-catalog.md) (its 2026-07-07 "2.5.I — DB write-path concurrency" amendment note establishes the `BEGIN IMMEDIATE` + bounded-retry convention this extends), [ADR-0021](0021-node-sqlite-driver-better-sqlite3.md) + [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (the synchronous driver), [ADR-0050](0050-cli-history-db-at-rest-posture.md) (the `0700`/`0600` guard the lock file inherits), [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) (one schema, two dialects — the Postgres port must not inherit this mechanism). Canonical home for the mechanism: the "Concurrency & transaction behavior" section of [database-schema.md](../reference/shared-core/database-schema.md).

> **Amended 2026-07-30 (append-only, mechanism replaced — the decision stands).** The Decision below chose an
> **OS lock file** with a staleness threshold and an atomic-`rename` takeover. Review found that protocol
> **unsound, and it was replaced before merge.** Two failures, both reproducible: the takeover's `rename` fixes
> only the file's final contents, so two takers can each `rename` and then each read back their own nonce and
> both enter the critical section; and `release()` unlinked unconditionally, so a superseded holder could delete
> the new owner's lock and admit a third process. Breaking a stale lock with plain file operations cannot be
> made mutually exclusive — which is exactly why this ADR named `flock`/`LockFileEx` the mechanically superior
> option and rejected it only for lacking a dependency-free Node binding.
>
> **The implementation now takes that advisory lock through SQLite instead**: `BEGIN EXCLUSIVE` on a dedicated
> `<db-path>.migrate.lock` database. That is a real `fcntl` lock held for the life of the transaction, and the
> kernel releases it when the process dies — so the 30 s threshold, the 50 ms poll, the pid field and the whole
> takeover protocol are **deleted rather than tuned**, and the negative this ADR recorded about `finally` not
> surviving `SIGKILL` no longer applies. It needs no new dependency (`better-sqlite3` is already the driver) and
> keeps a separate file from `history.db`, because taking `BEGIN EXCLUSIVE` on the database drizzle is about to
> migrate would deadlock it against our own connection.
>
> Unchanged: the decision to serialize the batch at all, why `BEGIN IMMEDIATE` cannot do it, the `:memory:`
> no-op, the run-then-reconcile fallback for a filesystem that refuses the lock, and the Node/CLI scoping (the
> Phase-6 Postgres port still gets a real advisory lock of its own, not this).

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

**The constants, pinned here rather than left to the implementation** — they are this decision's
whole tuning surface:

| Constant | Value | Why |
|---|---|---|
| Stale threshold | **30 s** | Two orders of magnitude above a real batch (milliseconds on a local file), so a live holder is never mistaken for a dead one even on a loaded CI box; and short enough that a crashed holder costs one pause, not a support ticket. |
| Max wait | **10 s** | A waiter that has not been let in by then is not waiting on a slow migration; falling through to reconcile beats hanging first-run startup. |
| Poll interval | **50 ms** | Bounded busy-wait; the whole batch is shorter than this on the happy path. |

**Staleness is decided by the recorded start time, never by the pid.** The holder writes both,
but pids recycle — a "is that pid alive?" check can be confidently wrong in either direction
(reporting a stranger's process as our live holder, or a recycled pid as dead). The pid is
therefore **diagnostic only**, for a human reading a stuck lock file; the timestamp is the only
input to the takeover decision.

**Takeover is an atomic swap, not delete-then-create.** Naïve "unlink the stale lock, then
create ours" recreates the original race one level up: two waiters can both observe the same
stale lock, both unlink, and both create. Instead the taker writes its claim to a
uniquely-named temp file in the same directory and `rename`s it over the lock path — `rename`
is atomic and last-writer-wins, so concurrent takers converge on exactly one owner rather than
two believing they hold it. A taker then re-reads the lock and proceeds only if the claim it
reads back is its own.

`'wx'` (`O_CREAT|O_EXCL`) is the atomic-create idiom this repo already uses in
[config/write.ts](../../apps/cli/src/config/write.ts),
[media-write.ts](../../packages/db/src/media-write.ts) and the tool-host fs arm, so this
introduces a new *use*, not a new *technique*.

**This decision is scoped to migration.** It changes nothing about steady-state writes, which
keep ADR-0064's `BEGIN IMMEDIATE` + `withBusyRetry` convention unchanged, and it is a **Node/CLI**
mechanism: the Phase-6 Postgres port replaces it with a real advisory lock rather than inheriting
a lock file, and the desktop's Rust path is untouched.

**It is also a no-op for an in-memory database.** `createClient(':memory:')` is private to its
own connection, so cross-process contention is impossible by construction and a lock file named
`:memory:.migrate.lock` would be nonsense. The lock is taken only for a real filesystem path —
which also keeps the entire test suite (hundreds of `:memory:` migrations) off the lock path.

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
- **An OS advisory lock (`flock` / `LockFileEx`)** — *rejected, reluctantly: no dependency-free
  Node primitive exists.* This is the mechanically superior answer and deserves naming as such,
  because it has **no stale-lock problem at all**: the kernel releases an advisory lock when the
  holding process dies, however it dies, so the 30 s threshold and the takeover protocol above
  would both be unnecessary. Node's `fs` does not expose `flock(2)` (`fs.open`'s `'wx'` is
  `O_CREAT|O_EXCL`, an atomic *create*, which is a different primitive), and `LockFileEx` is
  unreachable too — so taking this route means a native addon or an npm dependency, which
  [architectural-principles.md](../standards/architectural-principles.md) §9 gates behind exactly
  this kind of ADR and which we are not willing to add for a first-run edge case. Recorded as the
  upgrade path: if Node ever exposes advisory locking, or if `packages/db` acquires a native
  dependency for another reason, this mechanism should be replaced by it rather than tuned.
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

- **A new on-disk artifact with its own failure mode, and `finally` is not a guarantee.** The
  holder releases in a `finally`, which covers a thrown migration and a normal exit — but
  **`SIGKILL`, a power loss, or an OOM kill skips it**, so a crashed holder WILL leave a lock file
  behind. That is a design assumption, not an oversight: the stale threshold is the only thing
  that recovers it, which is precisely why an advisory lock (rejected above) would have been
  better. A wrong threshold either wedges startup or lets two processes in; 30 s against a
  millisecond-scale batch leaves three orders of magnitude of headroom, and the reconcile
  fallback still catches the double-entry case.
- **Windows deserves naming, not lumping in with "exotic".** `'wx'` maps to `CREATE_NEW`, which
  is atomic on NTFS, so the primary path holds — but a virus scanner or an indexer holding a
  transient handle can make the *unlink*/`rename` fail in ways POSIX does not, and network
  redirectors (SMB/DFS) do not guarantee `O_EXCL` semantics at all. This joins the corpus's
  existing Windows caveat (ADR-0050's `0600`/`0700` no-op) rather than hiding behind it: on
  Windows the reconcile fallback is load-bearing, not decorative.
- **Two mechanisms instead of one** (lock, then reconcile), so there are two paths to test rather
  than one. Accepted deliberately: the fallback exists precisely for the environments where the
  primary cannot run, and both **will be** covered by the two-process regression test the
  implementation lands with.
- **A local-only answer to a general problem.** This does not serialize anything for the Phase-2
  cloud/Postgres path, which will need its own advisory lock. Named here so the Postgres port
  does not inherit a lock file by accident.
- The lock file sits beside `history.db` inside `~/.relavium/`, so it inherits ADR-0050's `0700`
  directory guard — but it is one more file a user may see and wonder about. It is named for what
  it is.
