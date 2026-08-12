# ADR-0079: Cross-process run ownership — a durable run lease with a monotonic fencing token (amends ADR-0036)

- **Status**: Accepted
- **Date**: 2026-08-12
- **Related**:
  - [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) — the `ExecutionHost` seam and exactly-one-terminal. **Amended here.**
  - [ADR-0078](0078-ordered-durable-append-and-the-terminal-outbox.md) — the `DurableWriteContext` this extends, and the `uncertain` disposition it reuses.
  - [ADR-0073](0073-history-db-migration-lock.md) — precedent only, not a component (§8).
  - [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) — the nearest philosophical precedent: a resume that cannot be trusted refuses. Cited, not changed.
  - [ADR-0070](0070-durable-per-model-session-cost-attribution.md) — the session-path drift this deliberately leaves alone (§8).
  - [ADR-0049](0049-cli-machine-output-contract.md) — the exit-code taxonomy §7 extends.
  - [ADR-0050](0050-cli-history-db-at-rest-posture.md) — the durability-first store posture this classifies against, without changing it.
  - [database-schema.md](../reference/shared-core/database-schema.md) — the one canonical home for the schema and the concurrency policy.
- **Closes**: **Decides** `CR-11` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md); implementation staged behind it.

## Context

The engine's own docblock says its cross-process guarantee "is bounded by the store's durability". The only uniqueness the database actually enforces is `UNIQUE(run_id, seq)`, and `resumeFromCheckpoint` performs an **in-memory** `this.#runs.has(runId)` check before loading a checkpoint and building an independent `RunExecution`. An in-memory check is per-process by construction.

So two `relavium` processes can resume the same paused run at the same time and become **two independent side-effect producers for one run**. Both read the same checkpoint, both dispatch the same nodes, both call the same tools. `ADR-0078`'s compare-and-append stops the second one *writing the same row* — it does not stop either of them *doing the work*, because the effect happens before anything is written. That gap is why `CR-12`'s effect journal cannot mean anything until this closes: an idempotency key is worthless when two owners each believe they are the only one.

Three constraints shape the answer:

1. **The engine is platform-free.** It has an ISO-string clock and no filesystem, so the mechanism cannot be an OS lock and the TTL cannot be evaluated engine-side against an ambient clock.
2. **`ADR-0073`'s migrate-lock is precedent, not a component.** It imports `better-sqlite3` (unreachable from `packages/core`), yields no token, is invisible to `listInterruptedRuns`, and ADR-0073 explicitly forbids the Postgres port inheriting it.
3. **A CAS is not enough, and the phase already settled why.** A compare-and-swap on `last_seq` stops two processes writing the same row; the *fence* is what makes a stale owner harmless **after** it loses ownership — which is the only thing that helps when the loser is mid-run and about to call a tool.

## Decision

**We will take a durable per-run lease carrying a monotonic fencing token, check that token inside the same transaction as every durable write, and make a process that loses its lease stop without claiming an outcome it does not know.**

### 1. The lease is a row, in its own table

A `run_leases` table keyed by `run_id`, holding the owner id, a monotonically increasing `generation`, and an expiry. Not a column on `runs`: that row is a **derived projection** the event fold rewrites (`applyDerived`), so putting authoritative, non-derived ownership state in it mixes two lifetimes in one row and invites a fold to clobber it. A table is also queryable — by `listInterruptedRuns`, and by a human diagnosing a stuck run.

`generation` increments on every successful acquire — including the takeover `reconcile()` performs on an expired lease (§7) — and never resets. That is the fence: a token that only moves forward, so a stale owner's token is recognisably old rather than merely different.

### 2. The fence rides `DurableWriteContext` — the port is not broken again

`ADR-0078` §2 introduced `DurableWriteContext` as one extensible object precisely so the two items after it would extend rather than re-break `persistEvent`. This is the first of them: the context gains `fence`, and nothing else about the port changes.

The store checks it **inside the existing `BEGIN IMMEDIATE` transaction**, next to the compare-and-append and through the same `tx` handle. Outside the transaction the read and the write would be two statements another process could interleave — the exact race the check exists to close.

Considered instead: binding the store to a lease at construction (rejected — cheaper, but it makes the fence invisible to the type system at every call site, which is how this project resolved the identical fork for `expectedLastSequenceNumber`); and a bare `last_seq` CAS (rejected — see Context 3).

### 3. A fresh run's lease is created in the same transaction as `run:started`

`WorkflowEngine.start()` is synchronous, so it cannot await an acquire. It does not need to: a fresh `runId` comes from `host.ids.newId()`, so the start-side lease is **uncontended by construction**. Creating the row inside the same transaction that folds `run:started` means a run either has both or neither, with no window and no API break.

All contention is on the resume path, which is already async.

### 4. A losing resume refuses before it reads anything

`resumeFromCheckpoint` acquires the lease **first**. A failed acquire throws a new typed `EngineStateError` naming the current holder and the remedy — before the checkpoint is loaded and before any `RunExecution` exists, so a loser never becomes a second producer even briefly.

**The lease is released when the process stops WORKING on the run — which includes a re-pause, not only a
terminal.** This was under-specified when the section was first written and implementation found it: a
sequential multi-gate run resumes, re-pauses at the next gate, and the very next `relavium gate` is refused
for the full TTL by a lease nobody is using. A parked run has no process executing it, and the point of
ownership is to stop two processes *acting*. Releasing is safe because the next resume re-acquires anyway, and
the generation still only moves forward — so a stale owner stays fenced. Every refusal path above also
releases what it just took, or a run that does not exist would lock its own id.

**A typed refusal, not an observer handle.** The acceptance says the loser "degrades to observer with a typed, actionable error" — two deliverables in one phrase. **The typed error is in scope; the observer handle is not.** A real observer — tailing the durable log and synthesising a `RunHandle` stream — is a new engine capability, and `createClosedRunHandle` shows the tree already prefers a degenerate handle to a new streaming mode. The observer is recorded as a named follow-up with its trigger: the first surface that must *watch* another process's run rather than merely be refused by it.

### 5. A fenced-out IN-FLIGHT run stops without claiming an outcome

This is the sharpest decision in the ADR, and it is deliberate.

A process whose lease is revoked mid-run knows it lost. It does **not** know what happened to the run — the new owner may be completing it successfully right now. So the loser:

- **emits no terminal at all.** Writing `run:failed` would be a durable **lie** about a run another process is finishing. It could not be written anyway: the fence rejects it, which is the mechanism working.
- **closes its local stream** so the consumer's `for await` completes rather than hanging.
- **reports `durability: 'uncertain'`** — reusing exactly the vocabulary ADR-0078 §5 minted, which is what §5 said `CR-11` would do. The disposition is honest here for the same reason it was there: the run has an outcome, and this process does not know it.

Considered instead: a local-only `run:failed` (rejected — the surface would say "failed" while the run may be succeeding elsewhere, which is the very divergence `CR-92` closed); and a new `run:fenced` terminal (rejected — it widens ADR-0036's exactly-one-terminal set and forces every surface, schema and the checkpoint fold to handle a new variant, for a state the caller learns from the handle instead).

### 6. Expiry is evaluated store-side, on one clock

The TTL is **60 seconds**, heartbeat every **20 seconds**. Three missed heartbeats permit a takeover: wide enough that a long provider call or disk pressure is not mistaken for death, narrow enough that a crashed run is not locked for more than a minute.

Expiry is compared **store-side**, against the epoch-millisecond clock the store already has injected (`RunHistoryStoreDeps.now`). Every process on the machine then compares against one clock, and the engine gains no new time seam — it has only an ISO-string clock, and adding a second notion of time to a platform-free package to support a lock is the wrong direction. The heartbeat re-arms through the existing `ExecutionHost.setTimer`, the same way ADR-0045's media poll does.

### 7. `reconcile()` becomes lease-aware here, and a lease loss has its own exit code

`reconcile()` writes a terminal for every non-resumable interrupted run — from a process that may not own it. That is latent today (no surface calls it except `ADR-0078` §4's drain), which makes it cheap to fix now and a data-loss bug later. It skips any run holding a **live** lease; reconciling an expired-lease run **bumps the generation**, so the old owner is fenced out if it ever wakes.

The CLI maps a lease loss to **exit code 6**, distinct from the blanket `EngineStateError` → exit 2. A lease loss is *transient and retryable*; every other `EngineStateError` (unknown run, workflow mismatch, already terminal) is a permanent invocation fault. An automation loop has to be able to tell "try again shortly" from "never call this again". The taxonomy extension is recorded in ADR-0049's canonical home.

### 8. Scope, stated rather than left to be inferred

- **Runs only.** `AgentSession` / `chat-resume` keeps the two-process drift ADR-0070 already recorded and accepted. The asymmetry is named honestly: ADR-0070's accepted drift is *cost-reporting* drift, while two chat processes on one session also interleave tool effects — that is a real gap, and it is `CR-12`'s and a future session-ownership item's, not this one's.
- **Local only.** One `history.db` on one machine. The Phase-2 Postgres path gets its own advisory mechanism and must not inherit this one, mirroring ADR-0073's scoping clause.
- **This does NOT amend ADR-0073.** It is precedent for "route the lock through SQLite because Node has no dependency-free `flock`", nothing more: different lifetime, different granularity, and it needs a token an OS lock cannot give.
- **This does NOT supersede ADR-0075.** Its fail-closed resume is the nearest philosophical precedent and is cited, not changed.
- **ADR-0050's durability-first posture is unchanged.** A stale-fence rejection is an **expected refusal**, not data loss: it must not be retried by `withBusyRetryAsync` and must not collapse into the fatal path — the same classification `AppendConflictError` already has.

## Consequences

### Positive

- Two processes can no longer become two side-effect producers for one run, which is the precondition `CR-12`'s effect journal needs to mean anything.
- The fence makes a *stale* owner harmless, not merely a *slow* one — the property a CAS cannot provide.
- One more field on `DurableWriteContext` rather than a third break of `persistEvent`, which is what that object was introduced for.
- `reconcile()` stops being able to terminate a run another process is running, before any surface wires it.

### Negative

- **A new required host port and a migration.** Every host and test double must supply the lease port; the schema gains a table and `tools/db-sync` needs its snapshot regenerated. Mitigated by an in-memory reference implementation shipped with `createInMemoryHost`, following the `newAbortController` and `TerminalOutbox` precedents.
- **A heartbeat is a timer on every run.** Cheap, but it is real work on the hot path and one more thing that must be disarmed on settle. The existing `setTimer` seam and its disarm contract carry it.
- **60 seconds of lock after a crash.** A run whose process died is not resumable for up to a minute. That is the cost of not mistaking a slow run for a dead one, and the number is stated here so it can be changed with evidence rather than by feel.
- **A fenced loser reports `uncertain` and writes nothing**, so a user watching that process sees the run stop with no terminal of its own. That is honest — the run's real outcome is in the durable log the new owner is writing — but it is a new thing for a surface to explain, and the CLI's exit code 6 is what makes it actionable rather than merely puzzling.
- **The two-process race cannot be proven in one Node process.** `better-sqlite3` is synchronous, so in-process concurrency is serialized by construction. The regression follows `migrate-lock.e2e.test.ts`: spawn real children, and be **visibly skipped** rather than silently passing when the build output is absent.
- **The observer handle is deferred**, with its trigger named in §4. Until then a loser is refused rather than able to watch.
