# ADR-0074: Durable conservative budget commitments across run and session resume (amends ADR-0028, ADR-0036, ADR-0045, and ADR-0070)

- **Status**: Accepted
- **Date**: 2026-07-29
- **Related**: [ADR-0028](0028-workflow-resource-governance.md) (the pre-egress cap), [ADR-0036](0036-run-loop-substrate-event-bus-and-execution-host.md) (durable run events), [ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) (async media re-attach), [ADR-0070](0070-durable-per-model-session-cost-attribution.md) (session-cost accounting), [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) (the strict-cost-cap posture), and [sse-event-schema.md](../reference/contracts/sse-event-schema.md) (the canonical event contract).

## Context

The pre-egress governor must make two deliberately different statements about money:

1. **Realized cost** is a provider-usage-derived amount that belongs in the user-visible actual-cost total.
2. **Conservative commitment** is a bounded estimate retained when a provider may already have accepted or billed a request but the response supplies no trustworthy usage. It must consume cap capacity, but it is not evidence of an actual invoice amount.

Keeping only the first amount reopens a hard cap after a clean EOF, a partial-stream failure, a crash, or a resume. Folding the second into `cost:updated` or `totalCostMicrocents` prevents that bypass, but falsely presents an estimate as realized spend and breaks the realized-cost contract that the second 2.6.Q money PR is intended to complete.

Async media has a parallel replay hazard. A submitted provider job is already irrevocably billable, but the existing durable `media_job:submitted` descriptor does not contain its authored unit volume or the price accepted at submission. A new process consequently re-derives both from mutable workflow content and the current pricing overlay. A lower later overlay can under-reserve the already-submitted job, admit a sibling, and silently exceed the authored cap; it can also rewrite the job's eventual reported cost.

The same governor backs resumable chat. Session persistence currently stores only realized `total_cost_microcents`, so an uncertain post-egress charge is also lost across `chat-resume`. A workflow-only repair would leave the shared safety control materially inconsistent by surface.

## Decision

### 1. Keep actual and conservative money separate

Every governed execution keeps three independent quantities:

- durable **realized** cost;
- durable **conservative committed** cost; and
- live, process-local **admissions** for prospective egress.

The pre-egress projection is:

`realized + conservativeCommitted + liveAdmissions + nextWorstCaseEstimate`.

Actual totals, per-model actual-cost attribution, and `cost:updated` remain realized-only. A conservative commitment is never silently downgraded by a later actual-cost snapshot; it remains cap-consuming for the lifetime of the owning run or session.

**It is not, however, unbounded in time.** "Until a future provider protocol can reconcile that exact attempt" would mean an indefinite block, which is a worse failure than the overspend it prevents: a single usage-less response would permanently shrink a long-lived chat's cap with no way out. Two bounds apply. The commitment dies with its owner — a completed run and an ended session discard it with the rest of their governor state, so it can never leak into unrelated work. And within a live owner the user must be able to clear it deliberately: the surfaces that render the committed amount as *estimated, possibly billed* also expose releasing it, which is an explicit user decision about their own money, exactly like raising the cap under `on_exceed`. What is forbidden is the system silently deciding the estimate was wrong.

### 2. Persist an uncertain provider charge before later egress can proceed

> **Note (2026-07-30).** The event's shape is now settled in its canonical home
> ([sse-event-schema.md](../reference/contracts/sse-event-schema.md) §Workflow governance and reserved events,
> [run-event.ts](../../packages/shared/src/run-event.ts)); this ADR is not rewritten (rule 9), and the note records
> only what implementation SETTLED that the Decision below deliberately left to the spec. Two points a reader of
> this section alone would get wrong. **A reader restores the conservative total by SUMMING `estimateMicrocents`,
> not by last-wins over the cumulative snapshot** — the engine assigns `sequenceNumber` after an `await` and states
> that concurrent events have no canonical order, so under a `fan_out` the lower `seq` can carry the higher
> cumulative and a last-wins restore would hand already-owed money back to the cap. `Math.max` over those snapshots
> would also be order-independent and correct today, but it stops being correct once §1's deliberate release
> DECREASES the total; the sum is correct in both worlds. And **§1's release is representable**: it
> is a reserved `budget:estimate_released`, declared in the spec but emitted by no Phase-1 code, which is what makes
> the sum-less-release rule a settled contract rather than an open question.
>
> **What that leaves outstanding, stated plainly rather than left to be discovered.** §1 ties the release to the
> rendering — "the surfaces that render the committed amount as *estimated, possibly billed* also expose releasing
> it". The rendering half now exists (the run TUI and `relavium logs` both show the amount in those words); the
> release half does not, on any surface. Before this work a crash reset the in-memory total to zero, so runs had an
> *accidental* escape; making the total durable removes that accident, and the deliberate replacement is not yet
> built. The exposure differs by surface, and neither is the indefinite block §1 forbids:
>
> - a **workflow run** is not a long-lived owner. It completes, fails, or is resumed to completion, and §1's first
>   bound then discards the commitment. Within one run the deliberate escapes that already exist are
>   `on_exceed: pause_for_approval` (approve the node; the engine records a one-shot per-node bypass) and, under
>   `on_exceed: fail`, raising `max_cost_microcents` — literally the act §1 draws its analogy to.
> - a **chat session** IS long-lived, which is the case §1's harm sentence actually names. Its total is not
>   persisted yet, so nothing is blocked today either; §4 must ship `releaseConservativeCommitments` on the same
>   commit that persists it, or it would create the exact failure §1 rejects. The marker for that lives beside the
>   wiring, in `apps/cli/src/chat/session-host.ts`.
>
> **Closed 2026-08-09.** The release half shipped with the persistence, as this note required: `/cost --release`
> on the chat surface — the one that renders the amount, which is what §1 ties it to — clearing the durable
> per-model and aggregate columns first and the live governor second, so a released commitment does not return
> on the next `chat-resume`. `/cost` also renders the durability state. The reserved `budget:estimate_released`
> event stays reserved and unemitted: the session path restores its conservative total from COLUMNS rather than
> by replaying events, so zeroing them is what makes the release durable there. That event is needed only by a
> workflow-run release surface, which does not exist — the workflow escapes named above still stand.

Add an additive, secret-free dual-envelope event, `budget:estimate_committed`, carrying the node/agent identity, model id, bounded `estimateMicrocents`, and the owner-local cumulative conservative amount. It is a **new event `type`**, not an optional field on `cost:updated` — the rejected alternatives below say why. Its exact Zod shape, which discriminated-union arms it joins, and its envelope rules have one canonical home in [sse-event-schema.md](../reference/contracts/sse-event-schema.md) and [run-event.ts](../../packages/shared/src/run-event.ts); this ADR decides that it exists and what it means, and deliberately does not restate the spec. For workflows it is a durable `run_events` entry; for sessions it is a durable session-budget write and a streamed session event.

When an admission becomes uncertain, its ledger mutation is synchronous, but the next provider attempt and the enclosing turn completion wait for the commitment's durability acknowledgement. This closes the crash window between a potentially billable provider call and a later node/session boundary. A persistence failure never releases capacity; it fails the active owner loudly while preserving the conservative reservation in memory for the terminal path.

Checkpoint reconstruction folds conservative commitments separately from actual-cost snapshots and restores both before it schedules resumed work. The historical `totalCostMicrocents` / run terminal actual-cost field remains actual-only; surfaces render an explicit *estimated, possibly billed* amount rather than claiming that it was realized usage.

### 3. Freeze the accepted money basis of an async media job

`media_job:submitted` gains additive, backwards-compatible submit-time fields:

- `units` — the exact authored billed volume; and
- `acceptedCostMicrocents` — the priced amount used for the admission at submission.

New emitters always populate both. Resume reconstructs the admission from `acceptedCostMicrocents` without a pricing lookup and uses the frozen units/cost for the job's one terminal addend. A user-price/catalog or same-workflow-content change after submission cannot change an already accepted commitment or rewrite its historical cost.

Legacy submitted-job rows without the fields remain readable. With a configured cap, a resumed legacy pending job is treated fail-closed for new egress until it settles; it is never silently under-reserved from a newer, cheaper price. The compatibility fallback is observable so operators can distinguish legacy uncertainty from a current priced submission.

### 4. Make resumable sessions preserve the same safety state

Session persistence receives a separate conservative-cost aggregate and per-model conservative attribution beside ADR-0070's realized `session_costs` data. The persister owns the additive, transactional write of a `budget:estimate_committed`; `AgentSession.resume` restores the realized and conservative totals together into the same `BudgetGovernor` used by a fresh session. The existing invariant for realized cost stays intact rather than being weakened to mix actual and estimated figures.

### 5. Settle forward-compatibility first: a tolerant READ, a strict BODY (amended by ADR-0075)

> **Amended 2026-08-09 by [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) — a narrowing, not
> a reversal.** The tolerant read below stands for every read that feeds a DISPLAY (`logs`, `status`,
> `gate list`, the Home). It does NOT stand for the read that feeds a REPLAY: `checkpointer.ts` builds
> resumable state from what the read returns, and an older binary that drops a row cannot know whether it was
> a node terminal, a job submission, a gate decision or a cost commitment — so it may re-run completed or
> already-submitted work. The resume path now refuses when any row was skipped. ADR-0075 answers this
> section's three stated reasons for rejecting that, including the one that has since become false: the
> refusal needs no durable version marker, because `skipped.length > 0` is derived at read time.


The event in §2 cannot be emitted until this is decided, so it is decided here rather than left open.

**The reader tolerates an unknown event `type` and drops it; a KNOWN type with an invalid body still fails
loud.** That single distinction is the whole rule: an unrecognized discriminator is a newer writer, which is
forward evolution; a recognized discriminator whose payload does not parse is corruption, and
[ADR-0050](0050-cli-history-db-at-rest-posture.md)'s durability-first posture says corruption must never be
swallowed.

This is **not a new choice** — it is the contract [sse-event-schema.md](../reference/contracts/sse-event-schema.md)
§Forward-compatibility already states: adding a new event `type` is "always v1.0-legal and never a breaking
change, **provided consumers ignore unknown `type`s and unknown fields**". The code is the deviation, and it
predates this ADR: `RunEventSchema` and `SessionEventSchema` are both `z.discriminatedUnion('type', …)` and
`RunOrSessionEventSchema` is a `z.union` of the two, so **all three throw** on an unknown type, and
`loadRunEvents` parses every stored row through one of them. So the work §2 depends on is *fixing a
pre-existing doc↔code contradiction*, not weakening a guarantee to make room for a new event.

Both paths need it, not just the run path: `budget:estimate_committed` is dual-envelope, so the session
discriminated union and the `z.union` wrapper are equally affected. The correct seam is a `safeParse` at the
**read** boundary that distinguishes the two failure modes, never a `.catch()` at the call site — one rule, one
place, so a third reader cannot get it wrong.

The rejected alternative was an explicit refusal to downgrade while a run/session carries new events. It needs a
durable version marker the schema deliberately does not have (it is "versioned by additive evolution, not a
version field"), it converts a recoverable read into a hard failure, and it would leave the documented
ignore-unknown promise unfulfilled anyway.

## Consequences

### Positive

- A strict cap stays enforced across concurrent branches, provider responses without usage, async-media re-attach, process crashes, workflow resume, and chat resume.
- Cost reporting stays honest: actual provider-derived cost is not inflated by an upper bound, while the user can still see the committed uncertainty that protects their cap.
- Async media's durable descriptor becomes a true replay record: it preserves the acceptance-time request volume and money basis instead of asking current mutable state to reconstruct history.

### Negative

- The event/schema and checkpoint contracts grow, and the session implementation needs a migration plus a transactional persistence path. These are deliberate cross-surface changes, not a local `budget-governor.ts` edit.
- A conservative commitment can block a later request even when the provider ultimately charged less or nothing. This is the intentionally safe direction; its presentation must identify it as an estimate rather than hide the tradeoff.
- **Older binaries cannot replay a log containing the new event discriminant, and this is harder than a first reading suggests.** The premise that "current readers already handle unknown event types" is **false**, verified against the code: `RunEventUnionSchema` is a `z.discriminatedUnion('type', …)` ([run-event.ts](../../packages/shared/src/run-event.ts)) and `loadRunEvents` parses **every** row through it ([run-history-store.ts](../../packages/db/src/run-history-store.ts)), so an unknown `type` **throws rather than being skipped** — one new event in the log makes the whole run unreadable to an older binary, not merely partially understood. **§5 settles this**: the read boundary tolerates an unknown `type` and drops it, while a known type with an invalid body still fails loud — which is the contract `sse-event-schema.md` already documents and the code never implemented. The same fix is required on the session discriminated union and the `z.union` wrapper, because this event is dual-envelope. That work is a **precondition** for emitting the event: until the tolerant read ships, one new discriminant in the log makes the whole run unreadable to an older binary.
- Legacy async-media records cannot recover a price that was never persisted. They therefore choose temporary fail-closed capacity rather than a fabricated historical amount.

### Rejected alternatives

- **Add the estimate to `cost:updated` or actual totals.** Rejected: it makes an estimate look like realized spend and corrupts the realized-cost boundary.
- **Keep the commitment process-local until node/session completion.** Rejected: a crash before that boundary reopens the cap.
- **Reprice an async job on resume.** Rejected: current catalog/workflow state is not evidence of the price or volume accepted by a prior provider submission.
- **Fix workflows but leave resumed chat unprotected.** Rejected: both surfaces share the governor; a safety guarantee that disappears after `chat-resume` is not a first-class cost cap.
