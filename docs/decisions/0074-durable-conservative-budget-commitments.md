# ADR-0074: Durable conservative budget commitments across run and session resume (amends ADR-0028, ADR-0036, ADR-0045, and ADR-0070)

- **Status**: Proposed
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

Actual totals, per-model actual-cost attribution, and `cost:updated` remain realized-only. A conservative commitment is never silently downgraded by a later actual-cost snapshot; it remains cap-consuming until a future provider protocol supplies a legitimate reconciliation mechanism for that exact attempt.

### 2. Persist an uncertain provider charge before later egress can proceed

Add an additive, secret-free dual-envelope event, `budget:estimate_committed`, carrying the node/agent identity, model id, bounded `estimateMicrocents`, and the owner-local cumulative conservative amount. For workflows it is a durable `run_events` entry; for sessions it is a durable session-budget write and a streamed session event.

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

## Consequences

### Positive

- A strict cap stays enforced across concurrent branches, provider responses without usage, async-media re-attach, process crashes, workflow resume, and chat resume.
- Cost reporting stays honest: actual provider-derived cost is not inflated by an upper bound, while the user can still see the committed uncertainty that protects their cap.
- Async media's durable descriptor becomes a true replay record: it preserves the acceptance-time request volume and money basis instead of asking current mutable state to reconstruct history.
- The change remains seam-pure: it introduces no vendor SDK type, no platform import in `@relavium/core`, and no new runtime dependency.

### Negative

- The event/schema and checkpoint contracts grow, and the session implementation needs a migration plus a transactional persistence path. These are deliberate cross-surface changes, not a local `budget-governor.ts` edit.
- A conservative commitment can block a later request even when the provider ultimately charged less or nothing. This is the intentionally safe direction; its presentation must identify it as an estimate rather than hide the tradeoff.
- **Older binaries cannot replay a log containing the new event discriminant, and this is harder than a first reading suggests.** The premise that "current readers already handle unknown event types" is **false**, verified against the code: `RunEventUnionSchema` is a `z.discriminatedUnion('type', …)` ([run-event.ts](../../packages/shared/src/run-event.ts)) and `loadRunEvents` parses **every** row through it ([run-history-store.ts](../../packages/db/src/run-history-store.ts)), so an unknown `type` **throws rather than being skipped** — one new event in the log makes the whole run unreadable to an older binary, not merely partially understood. Implementing §2 therefore also requires deciding the reader posture: either a tolerant read path that drops unknown types (with the fold treating them as no-ops) or an explicit refusal to downgrade while such a run exists. Until that is settled the new event must not be emitted, because emitting it is a one-way door for the log.
- Legacy async-media records cannot recover a price that was never persisted. They therefore choose temporary fail-closed capacity rather than a fabricated historical amount.

### Rejected alternatives

- **Add the estimate to `cost:updated` or actual totals.** Rejected: it makes an estimate look like realized spend and corrupts the realized-cost boundary.
- **Keep the commitment process-local until node/session completion.** Rejected: a crash before that boundary reopens the cap.
- **Reprice an async job on resume.** Rejected: current catalog/workflow state is not evidence of the price or volume accepted by a prior provider submission.
- **Fix workflows but leave resumed chat unprotected.** Rejected: both surfaces share the governor; a safety guarantee that disappears after `chat-resume` is not a first-class cost cap.
