# ADR-0076: A durable per-attempt realized-cost ledger (amends ADR-0070, extends ADR-0074)

- **Status**: Accepted
- **Date**: 2026-08-09
- **Related**: [ADR-0074](0074-durable-conservative-budget-commitments.md) (the conservative half of the same problem), [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) (how this event degrades on an older binary), [ADR-0070](0070-durable-per-model-session-cost-attribution.md) (`SUM(run_costs) == runs.total_cost_microcents`), [ADR-0028](0028-workflow-resource-governance.md) (the pre-egress cap), [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (durable run events), and [sse-event-schema.md](../reference/contracts/sse-event-schema.md) (the canonical event contract).

## Context

ADR-0074 made the **conservative** commitment durable — money a provider may already have billed for a call that returned no trustworthy usage. It deliberately did not touch the other half. A call that *did* return trustworthy usage has no equivalent barrier, and that gap is larger than it looks.

`cost:updated` is the only carrier of a realized per-attempt charge, and it is **streamed, never persisted**. The durable record of realized spend is reconstructed from a LATER boundary: `node:completed`'s `cumulativeCostMicrocents` snapshot, folded into a `run_costs` delta. So between a paid provider call and the node terminal that records it, the charge exists only in memory.

That window is not narrow, and it is exactly where the engine does its riskiest work:

> A paid call succeeds → the model asks for a tool → the process dies during the tool → the realized cost is gone. The resumed node re-runs the same paid call, against a cap that has forgotten the first one.

An agent turn is a loop; a node can make many paid calls before it completes. A crash mid-loop discards every one of them. Worse, the resumed run does not merely *forget* the money — it **spends it again**, because the cap it re-evaluates against is understated by exactly the amount already charged. A cap is a safety control, and a safety control that resets on a crash is not one.

This is the same shape ADR-0074 §2 identified and fixed for estimates, and the reasoning there applies verbatim: the durable write has to happen *before* the next thing that can spend or mutate, not at a convenient boundary afterwards.

There is also an accounting consequence independent of the cap. `run_costs` is per-NODE, derived from a delta between node boundaries, and its per-node attribution is already documented as approximate under a `fan_out`. A per-attempt ledger records what was actually charged, per attempt, per model — which is what a user asking "why did this run cost that" needs, and what `relavium logs` cannot show today.

## Decision

**Add an additive, durable run event — `cost:attempt_settled` — recording one settled provider attempt's realized charge, emitted through an awaited durable write, and folded into a `run_costs` row at persist time.**

The name pairs with its estimate twin: `budget:estimate_committed` records an amount that MIGHT have been billed, `cost:attempt_settled` records one that WAS, per attempt. It reuses the admission vocabulary (`settle`, `settleAtReservedEstimate`) deliberately, because a settled admission is exactly the moment it is emitted.

The event carries the attempt's identity (node, model, the within-chain attempt index), its realized `costMicrocents` and token counts, the run-wide cumulative *after* it, and whether it could be priced. Its exact shape and envelope rules have ONE canonical home — [sse-event-schema.md](../reference/contracts/sse-event-schema.md); [run-event.ts](../../packages/shared/src/run-event.ts) is the Zod validation that implements it, not a second specification. This ADR decides that the event exists, when it is written, and what it means.

Three properties make it a ledger rather than another observation:

1. **Written before the next thing that can spend or mutate.** It goes through the engine's `#emitDurable` choke point, and the attempt boundary AWAITS that call — before the next tool side effect, before the next egress, and before the node/turn terminal. A durability failure fails the active owner loudly, exactly as ADR-0074 §2 decided for its estimate twin; surfacing it on a later unrelated node is the misattribution that barrier exists to prevent.

   **The mechanism is the awaited emit plus an explicit check, NOT a §2-style queue-and-flush.** §2 needs
   `flushBudgetCommitments` because a conservative commitment is emitted fire-and-forget from inside the
   governor, so something has to join the outstanding writes at the turn boundary. A settled attempt is
   emitted by the engine at the point it settles, on the path that is about to continue, so no queue is
   needed — and adding one would introduce the very concurrency the await removes.

   But the await ALONE is not the barrier, and this is the implementation trap worth naming. `#emitDurable`
   is **total for store faults**: a `persistEvent` rejection is absorbed into the run's failure state and the
   promise RESOLVES. So a caller that only awaits it proceeds normally into the next tool effect or egress on
   a run whose ledger write did not land — the exact thing this property exists to forbid. The attempt
   boundary must therefore await AND observe the run's failure/abort state before dispatching anything
   further, and a regression test must plant a rejecting `persistEvent` and assert that no subsequent side
   effect runs. Changing `#emitDurable` to reject instead is NOT the fix: its totality is what keeps the
   exactly-one-terminal-event invariant and stops an unhandled rejection escaping the fire-and-forget loop.
2. **Idempotent by construction, not by a new key — and the boundary of that claim, stated.** `run_events`
   carries `UNIQUE(run_id, seq)` and the derived `run_costs` row is written in the SAME transaction as its
   event (ADR-0074 §5's persist path), so one emitted event cannot be recorded twice and a resume READS the
   log rather than re-emitting it. No second uniqueness key is introduced, because a second key is a second
   thing that can disagree.

   What that does NOT cover, so it is not mistaken for more: a crash AFTER the ledger row commits but before
   the engine acts on it. The resumed run re-dispatches the node and makes a **new** provider call, which is
   a genuinely new charge and correctly gets its own row — the ledger is not double-counting a single charge,
   it is recording two real ones. The duplicate the user experiences is the re-run itself, and no cost key
   prevents that; preventing it is the effect-journal decision this ADR puts out of scope below.
3. **It does not double-count.** The `node:completed` delta fold is `max(0, cumulative − sum(run_costs so far))`. Once the attempt rows have advanced that sum to the node's cumulative, the terminal's delta is zero by arithmetic — the telescoping is self-correcting, and ADR-0070's `SUM(run_costs) == runs.total_cost_microcents` continues to hold without a special case. The terminal row is still written, because it carries the node's token totals and its `node_id` attribution.

### Scope: the RUN path only, and why that is not an omission

`cost:updated` is dual-envelope, so the obvious question is whether this event needs a session arm. It does
not, and the reason is that **the session path already has this ledger**: `persister.ts` writes
`recordSessionCost` on every `cost:updated`, carrying the PER-ATTEMPT increment — not a cumulative snapshot —
into `session_costs` and `agent_sessions` under ADR-0070. Since `#W15-4` that write is also latched, and a
failure gates further egress. So a chat session already records what it spent, per attempt, before it spends
again. This ADR closes the RUN path's equivalent gap; the asymmetry it removes is the one ADR-0074 §4 removed
in the other direction, and after both the two surfaces state the same guarantee.

**Explicitly out of scope: the cost of a TOOL effect.** This ledger covers provider egress. A tool that
mutates the world — an `http_request` POST, a `run_command`, an MCP call — can still be re-executed by a
resume, and no amount of cost bookkeeping prevents that; the duplicate EFFECT is the harm, not its price. That
needs a durable effect journal with a prepare/receipt pair, which is a different decision about a different
failure, and it earns its own ADR. Named here so the reader does not read "realized cost is now durable" as
"a resume cannot repeat work".

Considered and rejected:

- **Make `cost:updated` itself durable.** The obvious move, and the one with no new discriminant — so no forward-compatibility hazard at all. Rejected because it silently changes what every existing reader of `run_events` sees for an event the contract documents as streamed-only, and because `cost:updated` is dual-envelope: the session path streams it too, while `persistEvent` refuses a session event. A durable-on-one-envelope-only event is a contract that cannot be stated in one sentence. An additive type is the evolution `sse-event-schema.md` §Forward-compatibility already blesses.
- **Persist to a new `attempt_costs` table with its own uniqueness key, no event.** Avoids touching the event schema entirely. Rejected because replay and checkpoint reconstruction would not come for free — the engine's whole recovery story is "fold the durable event log" — and because ADR-0070's SUM invariant would have to be re-established by hand across two tables instead of holding by arithmetic.
- **Snapshot more often instead: emit `node:completed`-style cumulative snapshots mid-node.** Rejected: a snapshot is last-wins, and ADR-0074 §2 already established that concurrent events under a `fan_out` have no canonical `seq` order, so a snapshot can restore a LOWER total. A per-attempt delta summed across the log is order-independent, which is the same reason §2 chose a sum.
- **Do nothing and rely on the conservative commitment.** It does not cover this case: a call that returned *trustworthy* usage holds no conservative commitment by design, so the cap sees nothing at all.

### Why this lands after ADR-0075

A new durable event `type` is precisely the input ADR-0075 governs. Before it, an older binary reading a log containing this event dropped the row and resumed anyway — re-running paid work against a cap missing the very charges this ADR exists to record, which would have made the fix self-defeating on a downgrade. With ADR-0075 the degradation is defined: the replay refuses, the display stays tolerant.

## Consequences

### Positive

- A crash mid-agent-loop no longer discards realized spend, and a resumed run no longer re-spends it. The cap survives the boundary it was previously blind to, which is what makes it a control rather than a heuristic.
- Cost attribution becomes per-attempt and per-model on the run path, matching what ADR-0070 already gives sessions. "Why did this run cost that" becomes answerable from the durable log, including for a run that never reached a terminal.
- A failed or cancelled run's realized cost is recorded as it is incurred rather than reconstructed from a terminal that may never arrive — the same class of gap `#W15-6` closed for the terminal snapshots, closed at its source.
- The SUM invariant holds by arithmetic rather than by a new rule, so no reconciliation step and no second key.

### Negative

- **More durable writes on the hot path**, one per settled provider attempt, each awaited. That is the cost of the barrier and it is the same cost ADR-0074 §2 accepted for estimates; the volume is per-attempt, not per-token, so a long run adds rows in the hundreds, not the millions. Mitigation: the write shares the single `BEGIN IMMEDIATE` its event already takes, so it is not an additional transaction.
- **A durability failure now fails a turn that would previously have completed.** Deliberate, and the same posture as §2: a run that cannot record what it spent must not keep spending. Mitigation: the failure is classified and names the attempt, rather than surfacing later as an unexplained cap refusal.
- **An older binary cannot replay a log containing this event.** Inherited from ADR-0075 and stated there; the remedy is an upgrade, and every read-only surface still shows the run.
- **`cost:updated` remains, and now has a durable sibling.** Two events describing one charge is a real risk of drift. Mitigation: the streamed one keeps its documented role as the live observation and the durable one is the record; the spec says which is authoritative, and the engine emits both from one place so they cannot disagree about the amount.
