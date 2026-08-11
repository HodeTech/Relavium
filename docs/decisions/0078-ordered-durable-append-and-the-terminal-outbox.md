# ADR-0078: The durable event log is an ordered append, and a terminal that cannot be made durable says so (amends ADR-0036; establishes the shared durable-write seam)

- **Status**: Accepted
- **Date**: 2026-08-11
- **Related**: [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (the event bus, the `ExecutionHost` seam and exactly-one-terminal — amended here) · [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) (one schema, two dialects) · [ADR-0073](0073-history-db-migration-lock.md) (the store's cross-process posture) · [ADR-0074](0074-durable-conservative-budget-commitments.md) · [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) · [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) · [ADR-0077](0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) (the money barriers whose correctness rests on `#emitDurable`'s totality) · [ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md) §3-4 (the media reclaim this reorders). The store's concurrency and transaction policy has one canonical home, [database-schema.md](../reference/shared-core/database-schema.md) §"Concurrency & transaction behavior"; the event contract is [sse-event-schema.md](../reference/contracts/sse-event-schema.md). Closes `CR-10` and `CR-92` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).

## Context

Every durability guarantee this project has shipped assumes the durable event log is an **ordered prefix** of what the run produced: the checkpoint fold, resume, reconciliation, and ADR-0075's strict read all read it that way. Nothing establishes it.

`#emitDurable` assigns a sequence number at one authoritative point and then **starts each event's persistence independently**, serializing only delivery — *"Persists stay concurrent; only delivery is serialized."* (`engine.ts`). The store commits each event in its own `IMMEDIATE` transaction, and the only database-level constraint is `UNIQUE(run_id, seq)`, which bars a duplicate and says nothing about order or holes.

**How reachable that is, stated precisely, because an imprecise version of this sentence would make this ADR wrong on its first pass.** On the CLI's own store the happy path is not affected: `better-sqlite3`'s `db.transaction(...)` is fully synchronous and runs before the first real `await`, so the commit lands inside the same synchronous block that assigned the sequence — measured, commit order was `1,2` every time. Out-of-order commit becomes reachable through exactly two doors: a `SQLITE_BUSY` backoff that yields the event loop mid-retry — which the store's own comments and `database-schema.md` already describe, and which cross-process contention on a shared `history.db` makes expected — or a genuinely asynchronous store, which the `Promise`-typed port exists for and which Phase 2's cloud store will be. So the defect today is that **nothing but timing prevents it**, and the seam is explicitly designed to admit an implementation where timing does not.

The damage is not a mis-ordered read. Readers already sort. The damage is the **missing row**: a `node:completed` that never lands leaves its vertex absent from the reconstructed state, so a resumed engine seeds it `pending` and re-runs it — which is how this item opens the duplicate-effect door that `CR-12` owns.

The terminal has a second, distinct problem. `#emitDurable` is deliberately **total for store faults**: a failed write is absorbed and the event is delivered anyway, because exactly-one-terminal is sacred and a store fault must never escape as an unhandled rejection out of the fire-and-forget loop. For a non-terminal event the run is additionally failed, so progress is never reported that the log lacks. **For a terminal there is no such compensation.** A caller receives `run:completed` with outputs while the durable record says the run failed — or says nothing at all — and `reconcile()` may later write a *different* terminal for the same run. The media reclaim compounds it: the run's media references are released *before* the terminal write is known to have landed.

Three constraints shape what may be done about it:

1. **ADR-0077's money barriers rest on that totality.** Both `money-durability.ts` and `engine.ts` state in terms that the `CommitmentDurabilityError` catch is "deliberately unreachable" on the run path *because* `#emitDurable` absorbs and resolves. Both money events are non-terminal.
2. **`reconcile()` is a second write path.** It bypasses `#emitDurable` entirely and calls the store directly. Every property established at the choke point has to be re-established there, or it holds for one of the two writers.
3. **The store that must hold a terminal outbox is the store that just failed.** A row in the same `history.db` is unavailable for most of the fault class the outbox exists to survive.

Finally, three sibling W1 items — `CR-11`'s fencing token and `CR-12`'s effect journal — need to change the *same* `persistEvent` signature. Landing them separately would break one exported port three times across four packages and every test double.

## Decision

**We will serialize each run's durable appends into one ordered tail, guard the append at the store with a compare-and-append, hold a terminal the store could not accept in a host-owned outbox outside the store, and report a run whose terminal is not known to be durable as `uncertain` rather than as success.** The `persistEvent` port takes one extensible context object so the two sibling items extend it rather than re-break it.

### 1. One ordered append tail per run

`#emitDurable` moves the `persistEvent` call **inside** the existing per-run serialized region, so event `N+1`'s write is not started until `N`'s has settled. Delivery ordering is unchanged; today's region already resolves in sequence order, and this makes the *ask* order match it.

**The mechanism is a one-line move, and no second tail is introduced.** Today the region reads *start the persist → `await prior` → deliver*, so `#deliveryTail` serializes only delivery. It becomes *`await prior` → persist → deliver*: the same single tail then serializes the ask, the write and the delivery, in that order, for one run. This matters beyond tidiness — it is what makes §2's `expectedLastSequenceNumber` well-defined at the call site, because the previous event's write is known to have settled before this one is composed. A separate `#persistTail` alongside the delivery tail is rejected: two chains over one ordering property is how they drift, and the totality argument in §6 would then have to be re-derived for each.

The awaited total is unchanged — callers already awaited a region that contained `await prior` — so this moves *when* the write starts, not how long `#emitDurable` takes to resolve.

Two placements are stated separately because they are twenty lines apart in the same method and a reviewer skimming "move the media call" will conflate them:

- **The media de-inline stays OUTSIDE the region.** It is an awaited host round-trip (`MediaStore.put` / `fetchMedia`) with no bound this engine controls. Inside the region an unbounded host stall would block every later durable write for the run, including the terminal.
- **The media reclaim moves AFTER a successful terminal persist.** A terminal whose write failed must not have already released the run's media references (ADR-0042 §3-4).

Considered instead: a global append tail across all runs (rejected — one slow run would stall every other, and the ordering property is per-run by definition); and leaving the engine unordered and relying solely on §2's store guard (rejected — the guard would then *reject* legitimate concurrent asks, converting a latent ordering hazard into a live failure).

### 2. Compare-and-append at the store, through one context object

`persistEvent` becomes `persistEvent(event, ctx: DurableWriteContext)`. `DurableWriteContext` carries `expectedLastSequenceNumber` now; `CR-11` adds its fencing token and `CR-12` its journal correlation to the same object.

The store evaluates the guard with a `SELECT max(seq)` **inside the existing `IMMEDIATE` transaction**, through the `tx` handle rather than the outer `db` — the reason is already recorded in `run-history-store.ts`: with a pooled Postgres driver the outer handle is a different client, so its statements would run outside the transaction and survive a rollback. A violation is a typed rejection, not a silent skip.

Considered instead: a denormalized `runs.last_event_seq` column (rejected — it needs a migration and a snapshot regeneration for a value `max(seq)` already yields, and it introduces a second source of truth that can drift from the rows); and a parameter list rather than a context object (rejected — it is the signature that gets broken three times).

`InMemoryRunStore` enforces the identical guard. A reference implementation that accepts what the real store rejects makes every `packages/core` test prove nothing.

### 3. `reconcile()` is a first-class second write path

It passes its own expected last sequence, and its repair append becomes **conditional on no terminal being present**. Without that condition §4's outbox retry and reconciliation can both append a terminal, breaking ADR-0036's exactly-one-terminal invariant. Fixing this is nearly free today — no shipping surface calls `reconcile()` — and becomes a data-loss bug the moment one does.

### 4. The terminal outbox lives outside the store, behind a host port

A terminal whose durable write fails is written to a **`TerminalOutbox` port on `ExecutionHost`**, retried under the same identity, and drained on the next start.

This is the one place this ADR spends real complexity, and it is deliberate. The alternatives were weighed:

- **An outbox row in `history.db`** (rejected): unavailable for most of the fault class it exists to survive — a full disk, a corrupt database, an exhausted busy-retry all fail the outbox write for the same reason they failed the terminal write.
- **No outbox at all**, relying on `reconcile()` to repair (rejected): reconciliation writes `run:failed{internal}` for a run that actually *completed*. The divergence is relabelled, not closed, and the outputs are gone. The phase's exit criterion permits this cheap option; the maintainer ruled for real fault isolation instead, and the reasoning is that a lost `run:completed` payload is unrecoverable while an extra host port is merely more code.

The port is **required**, not optional. The optional-port precedent on `ExecutionHost` (`mediaStore?`, `fetchMedia?`) is absent-tolerant because a text-only host legitimately has no media. There is no legitimate host with no terminal durability, so optional here would mean a host that forgets the port silently has no guarantee — a fail-open default inside a fail-closed item, invisible at every call site.

**The outbox is drained BEFORE reconciliation, and that order is load-bearing.** §3's "no terminal present" condition makes the two writers safe within one process; across processes it does not. A crashed process leaves its terminal in the outbox, and if the next process reconciles first it sees a run with no durable terminal, concludes it needs repair, and writes `run:failed{internal}` for a run that completed — the exact divergence this section exists to close, reintroduced by ordering. Draining first means a terminal a prior process could not commit is recovered before any process decides the run is broken.

**A drained entry is reconciled against the log, not replayed blindly.** An entry whose run already carries a durable terminal is dropped, not appended — the write may have committed and only its acknowledgement been lost, and appending would break exactly-one-terminal in the other direction.

**An entry whose run is never started again stays until it is swept.** That is correct, not a leak: the run finished, only its durable record is missing, and the payload is the only surviving copy. It does mean the outbox is unbounded in principle, so the host implementation carries a retention bound — the entry is dropped once its run's terminal is durable, and a host may age out entries under the same retention policy that governs run history. The engine does not own that policy; it owns only the write-and-drain contract.

### 5. Durability is reported, not assumed

`RunHandle` gains a `durability: 'durable' | 'uncertain'` disposition alongside its terminal. `uncertain` means the terminal was delivered in-process but its durable write did not land and the outbox has not yet confirmed it.

The marker is **handle-level, never on the `RunEvent`**. The store persists the delivered event verbatim as the lossless canonical record, so a live-only field either lands on disk — self-contradictory, since the row existing *is* the durability — or forces the delivered and persisted forms to diverge.

This vocabulary is minted **once, here**. `CR-11` reuses it for a fenced-out run and `CR-14` for a grammar violation on already-forwarded content, rather than each inventing a parallel shape. The CLI maps `uncertain` to its own exit code; the taxonomy extension is recorded in [ADR-0049](0049-cli-machine-output-contract.md)'s canonical home.

### 6. Totality is preserved for non-terminal events

Every disposition change above is scoped to the **terminal** arm. Non-terminal writes keep absorbing store faults into the run's failure state and resolving, exactly as ADR-0077's B1/B2/B3 correctness argument requires — and both money events are non-terminal. The two comments that state that argument are re-derived in the same change, because a reviewer reading only `#emitDurable` will not find them.

### 7. What "durable" means here

**Process-crash durability, not power-loss durability.** The client sets `synchronous = NORMAL` under WAL, so a committed transaction can be lost on an OS crash or power loss. Every sentence in this ADR of the form "`N` is durable before `N+1` is written" is scoped accordingly. Flipping to `FULL` is a measurable throughput change on the run's highest-volume write path and deserves its own decision with its own measurement — not a side effect of an ordering ADR.

### 8. What this ADR does NOT change

Stated explicitly, because the next reader will otherwise try to simplify it away: **ADR-0074's sum-vs-last-wins rule and the `Math.max` checkpoint fold survive completely unchanged.** Those are driven by sequence-*assignment* order among concurrent emitters, not by commit order. An ordered append tail cannot give two concurrent `fan_out` branches a canonical order — nothing can. Likewise the realized-cost ledger's telescoping `run_costs` delta stays: its cause is that `MoneyDurability` stamps the cumulative captured at `record()` time, which is correct and is not an ordering artefact.

## Consequences

### Positive

- The durable log becomes an ordered append in fact, not by assumption, and the guard survives a store implementation whose commits are genuinely concurrent.
- A caller can no longer be told a run completed while the durable record disagrees — the single failure the durable-truth oracle was built to detect.
- One port change instead of three: `CR-11` and `CR-12` extend `DurableWriteContext` rather than re-breaking `persistEvent`.
- `reconcile()` stops being a write path with none of the choke point's properties.

### Negative

- **Throughput.** Serializing the appends removes write concurrency within a run. Mitigated by the media de-inline staying outside the region — the only unbounded await on the path — and by the fact that the store's transaction is synchronous today, so the concurrency being removed is largely notional.
- **A new required host port**, which every host and every test double must supply. Mitigated by an in-memory reference implementation shipped with `createInMemoryHost`, following the `newAbortController` precedent.
- **`uncertain` is a new outcome surfaces must handle**, and a CLI exit code is a user-visible contract change. Mitigated by minting it once for three items rather than three times, and by recording it in ADR-0049's canonical home.
- **The outbox can itself fail.** A host whose outbox write fails has no further recourse; the run reports `uncertain` and stops there. That is the honest floor, and it is stated rather than papered over.
- **`CR-10`'s headline property is still not provable from the log alone.** Streamed events consume sequence numbers and are never persisted, so a healthy log legitimately reads `[0,1,2,3,5,10,…]` and a streamed event's absence is indistinguishable from a lost one. Proving "the committed set is a prefix of the asked set" needs a store harness that records what it was *asked* to persist. That harness is built before the implementation, exported from `packages/core` the same way `checkDurableTruth` is, and its own vacuity is checked by mutating it to compare sets instead of prefixes.
