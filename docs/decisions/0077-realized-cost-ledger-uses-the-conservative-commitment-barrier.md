# ADR-0077: The realized-cost ledger uses ADR-0074 §2's barrier mechanism (amends ADR-0076 §1)

- **Status**: Accepted
- **Date**: 2026-08-10
- **Related**: [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) §1 (the mechanism this corrects; its decision, event and properties stand), [ADR-0074](0074-durable-conservative-budget-commitments.md) §2 (the mechanism this adopts), [ADR-0038](0038-agentrunner-llm-call-boundary.md) (the one-chain-per-node-execution boundary the barriers sit on), [ADR-0011](0011-internal-llm-abstraction.md) (the `LLMProvider` seam the rejected alternative would have widened), and [sse-event-schema.md](../reference/contracts/sse-event-schema.md) (the canonical event contract).

## Context

[ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) decided that a settled provider attempt's realized
charge becomes a durable run event, `cost:attempt_settled`. That decision is right and is not reopened here.

Its §1 also decided **how** the write becomes a barrier, and drew a line against its own sibling:

> **The mechanism is the awaited emit plus an explicit check, NOT a §2-style queue-and-flush.** §2 needs
> `flushBudgetCommitments` because a conservative commitment is emitted fire-and-forget from inside the
> governor, so something has to join the outstanding writes at the turn boundary. A settled attempt is emitted
> by the engine at the point it settles, on the path that is about to continue, so no queue is needed — and
> adding one would introduce the very concurrency the await removes.

**The asymmetry that paragraph rests on does not exist**, and the code says so in three places:

1. The seam's attempt observer is synchronous and returns nothing —
   `onAttempt?: (record: AttemptRecord) => void` ([fallback-chain.ts](../../packages/llm/src/fallback-chain.ts)),
   invoked as a bare synchronous call inside the chain's attempt loop.
2. Both money events are emitted from **that same callback, a few lines apart** — the conservative
   `settleAtReservedEstimate()` and the realized `cost:updated` sit in one `onAttempt` body
   ([agent-turn.ts](../../packages/core/src/engine/agent-turn.ts)). There is no "engine path that is about to
   continue" for one of them and not the other; there is one synchronous observer for both.
3. The governor's own field documentation already states the constraint in plain words: *"The ledger mutation
   is SYNCHRONOUS — `settleAtReservedEstimate` is called from inside the fallback chain's `onAttempt` callback,
   **which cannot await**"* ([budget-governor.ts](../../packages/core/src/engine/budget-governor.ts)).

So §1 asked for an `await` at a point where no `await` can be placed. Worse, the codebase had already written
the warning for exactly this mistake: [node-executor.ts](../../packages/core/src/engine/node-executor.ts)'s
comment on why `budget:estimate_committed` is absent from the streamed in-node event union ends with *"If you
came here to add it, add it to the governor's emit type instead."*

Two things §1 got **right** are worth keeping explicit, because this ADR narrows one paragraph and not the
section:

- `#emitDurable` is **total for store faults** — a `persistEvent` rejection is absorbed into the run's failure
  state and the promise RESOLVES. Awaiting it alone is therefore never a barrier. §1 named this trap and the
  trap is real; it survives unchanged.
- The guarantee §1 wanted — *written before the next thing that can spend or mutate* — is the right guarantee.
  Only its shape was wrong.

## Decision

**`cost:attempt_settled` uses the same mechanism ADR-0074 §2 built for its estimate twin: the emit is started
synchronously at the settle point onto a chained in-flight promise, and JOINED at every barrier that precedes
spending or mutating. It is not a bare awaited emit.**

Concretely, five things:

1. **Start the write at the settle instant.** `onAttempt` cannot await, but it can *begin*. The emit is chained
   onto a per-owner in-flight promise, copying the shape of §2's `#commitmentsInFlight` — which also serializes
   the writes, so two settles in the same tick cannot interleave their persists. **The shape is copied; the
   owner is not** — see §5.
2. **Join at three barriers, not two.** §2 joins at the pre-egress check and at the turn/node boundary.
   ADR-0076's guarantee names a third thing to precede — the next **tool side effect** — so the ledger's
   barrier set is, and these three names are used throughout this ADR:

   - **B1** — before the next egress admission (§2 has this one);
   - **B2** — **before tool dispatch** (new here);
   - **B3** — at the turn/node terminal (§2 has this one).

   **B2** is what this ADR adds to the §2 shape; without it the ledger would repeat §2's coverage rather than
   extend it, and the duplicate-effect window ADR-0076 exists to narrow would stay open on the path that
   mutates the world.
3. **Every barrier awaits AND observes.** Because `#emitDurable` is total, a barrier that only awaits proceeds
   on a run whose ledger write did not land. Each barrier must therefore also read the failure state and refuse
   to continue, and §2's retained-failure pattern (`#commitmentFailure`, re-thrown at the next barrier) is the
   shape that carries it — a rejection nobody awaits at the call site would otherwise be unhandled.
4. **One join, not two.** After this ADR there are two chained in-flight promises — the conservative one and
   the realized one — and three barriers that must join both. Joining them individually is a correctness bug
   waiting for the next barrier someone adds. So the barriers call **one** joining entry point that owns both
   chains and both retained failures; there is no supported way to await half the money. This is what turns
   the "a future barrier joins only one chain" hazard from a review item into something a caller cannot
   express.
5. **The ledger and its join are owned by the ENGINE, unconditionally — never by `BudgetGovernor`.** Reading
   §1's "as §2's `#commitmentsInFlight`" as "put it on the governor" would silently omit most runs, and every
   signpost in the codebase points that way (`node-executor.ts`'s comment even says "add it to the governor's
   emit type instead"). It is wrong here, because the governor is **conditional and the ledger is not**:

   - `engine.ts` constructs a `BudgetGovernor` only `if (params.plan.budget !== undefined)`, and `budget` is
     optional in the workflow schema. An unbudgeted run spends real money and would get no ledger at all.
   - `#flushBudgetCommitments` returns immediately when there is no governor, so **barrier B3 becomes a
     no-op**.
   - `#makePreEgressHook()` returns `undefined` without a governor, so the turn core never installs the
     `preAttempt` wrapper and **barrier B1 does not exist**.
   - Even on a BUDGETED run, `const preEgress = budgetApproved ? undefined : this.#makePreEgressHook()` drops
     the hook for an approved `pause_for_approval` re-dispatch — so B1 disappears on the exact path the user
     just authorised more money on.

   Implemented literally, an unbudgeted run would get one barrier of three, and an unbudgeted run with no tool
   calls would get none — the fire-and-forget state this ADR exists to remove, passing every test written
   against a budgeted fixture.

   **The correct shape already exists one surface over.** `session-host.ts` installs an `preEgress` hook that
   is *"ALWAYS present, cap or no cap"*, reads the durability probe FIRST, and only then delegates to
   `governor?.preEgress(info)` — *"It composes with the governor rather than replacing it, and it runs
   FIRST."* The run path never got that. So this ADR's own "the session path is stronger here" section had the
   answer to this flaw in it; the run path adopts the same composition.

### Two implementation traps this decision creates

Named because both are silent, and both would look correct in review:

- **The ledger emit must follow the cumulative fold, not precede it.** The engine advances its run-wide total
  in `#nodeEmit`'s `cost:updated` arm. Emitting the ledger draft *before* that leaves the cumulative stale, and
  `refineCostAttemptSettled` rejects `cumulative < cost` at the producer gate — which runs in `#bus.next`,
  **outside** `#emitDurable`'s `try`. So the wrong order does not degrade: `#emitDurable` **rejects** instead
  of resolving, in the one place the whole design assumes it cannot. Nothing pins that order today.
- **The durable emit must not be routed through `#nodeEmit`.** It returns `void`, so the promise would be
  unawaitable — the exact unbarriered shape this ADR exists to prevent, reached through the door
  `node-executor.ts`'s in-node-event-union comment already warns about.

The hook that carries the emit into the turn core is an OPTIONAL `AgentTurnParams` field, modelled on
`preEgress`, because `agent-turn.ts` is the boundary `AgentSession` shares. Leaving it unset on the session
path is what makes this event run-only as a runtime fact rather than a comment.

### Why the tool-dispatch barrier matters beyond this ADR

It is the first place the engine is required to reach a durability checkpoint *before dispatching a side
effect*, and that checkpoint is the seam the durable **effect journal** (`CR-12` in the 2.6.5 phase) needs:
`prepared → dispatched → committed | ambiguous` has to be written at exactly this point in exactly this path.
Landing it here means the effect journal extends an existing barrier rather than threading a new one through
`ToolRegistry.dispatch`. Named so the two are not built twice, and so a reviewer of either can check the other.

Considered and rejected:

- **Make the seam's `onAttempt` awaitable** (`void | Promise<void>`, awaited by the chain), so §1's sentence
  becomes literally true. Rejected on three counts. It widens `@relavium/llm`'s public API for a concern that
  is not the seam's — durability belongs to the engine, and [ADR-0011](0011-internal-llm-abstraction.md) keeps
  the seam a provider contract, not an execution-host one. It would let a durable store write block a live
  provider stream, and an observer that hangs would stall the chain with no timeout of our own. And it would
  give the two money events emitted from one callback two different durability mechanisms, which is precisely
  the drift that made this correction necessary.
- **Emit from the turn loop after the chain call returns**, where an `await` is genuinely available. Rejected
  because it is strictly worse than the chosen mechanism on the failure this ADR is about: the write would not
  even *start* until the whole chain call finished, so a crash mid-chain loses every failover attempt inside
  it. Chaining starts the write at the settle instant and only *joins* later, which is a narrower window, not a
  wider one.
- **Leave §1 as written and implement something else.** Rejected outright. An ADR whose mechanism paragraph
  describes something the code does not do is the corpus drift this project has repeatedly paid for; the
  remedy is an append-only correction, not a quiet reinterpretation.

### The session path needs no barrier, and the reason is structural

ADR-0076 scoped its event to the run path on the ground that "the session path already has this ledger". A
review of this ADR asked whether that leaves a session resume losing realized cost the same way. It does not,
and the reason is worth recording once so the question stops recurring: the session write is **synchronous and
already committed** when the handler returns.

`persister.ts` handles `cost:updated` through `persistDurably(() => store.recordSessionCost(...))`, and
`recordSessionCost` is declared `(entry: SessionCostEntry) => void` — a synchronous `better-sqlite3`
transaction, not a promise. `persistDurably` calls it inline and re-throws, so the money is on disk before the
next line of the handler runs, and the handler itself runs on the delivery of an event emitted from the
synchronous `onAttempt`. There is no in-flight window for a crash to land in.

So the asymmetry this ADR institutionalises is not "run path protected, session path forgotten". It is that
the run path's store is `persistEvent: (event) => Promise<void>` — asynchronous by seam design, because a
cloud store must plug in — and an asynchronous write is exactly what needs a barrier. The session path is
stronger here, not weaker, and stays so until its store becomes asynchronous; at that point it inherits this
decision rather than needing a new one.

### What ADR-0076 keeps

Unchanged and not reopened: the event exists, its name, its meaning, its shape's canonical home, the
idempotency boundary and the crash-after-commit case it explicitly does NOT cover, the no-double-count
arithmetic against `node:completed`'s telescoping delta, the run-path-only scope and why the session path needs
no arm, the four rejected alternatives, and the reason it lands after
[ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md). This ADR replaces one paragraph.

## Consequences

### Positive

- **One mechanism for both money events, emitted from one callback.** They cannot drift apart, and a future
  reader who finds one finds the other. The alternative left two durability shapes three lines apart in the
  same function.
- **The guarantee ADR-0076 wanted is actually obtainable**, and the tool-dispatch barrier makes it stronger
  than §2's: realized spend is durable before the run mutates the world, not merely before it spends again.
- **No seam change.** `@relavium/llm` keeps its provider contract, and a slow disk cannot stall a provider
  stream.
- The write starts earlier than any barrier-only design would allow, so the crash window is the narrowest of
  the three mechanisms considered.

### Negative

- **A third barrier on the hot path.** Mitigation: §2's outstanding-count guard applies unchanged — the barrier
  costs nothing when nothing is in flight, which is the common case, and an unconditional await would change
  observable interleaving that existing tests legitimately pin.
- **Two chained in-flight promises now exist** (the governor's conservative chain and the ledger's realized
  chain), so a barrier that joined only one would be silently half-safe. Mitigation is structural rather than
  advisory — Decision §4: the barriers join through a single entry point that owns both chains and both
  retained failures, so "await the wrong one" is not an expressible mistake. What a reviewer still has to
  catch is a new barrier that calls neither.
- **Three barrier holes have to close for this to be true at all**, and each is a line that reads as correct
  today: the governor-conditional `#flushBudgetCommitments` early return, the `undefined` from
  `#makePreEgressHook`, and `budgetApproved ? undefined`. Mitigation: Decision §5 names all three, and the
  regression that proves them is an **unbudgeted** run — a fixture with a budget passes even when every
  barrier is missing.
- **The tool-dispatch barrier is new engine surface**, on the hottest path a run has, and it lands before the
  effect journal that will build on it. If it is placed wrong, both this ledger and `CR-12` inherit the same
  crash window. Mitigation: it goes in at `agent-turn.ts`'s single `await dispatchToolCalls(...)` — one call
  site, before any tool runs — rather than inside `ToolRegistry.dispatch`, where per-call placement would have
  to be re-proven for every dispatch path.
- **A durability failure now fails a turn at the tool boundary too**, where previously it would have surfaced
  only at the next egress or the terminal. Deliberate, and the same posture §2 accepted: a run that cannot
  record what it spent must not go on to mutate anything.
- **ADR-0076 §1 must be read together with this ADR**, since the corpus is append-only and that paragraph
  stays on the page. Mitigation: the title, the `Related` line and the "What ADR-0076 keeps" section above make
  the scope of the correction unambiguous — one paragraph, not a section.
