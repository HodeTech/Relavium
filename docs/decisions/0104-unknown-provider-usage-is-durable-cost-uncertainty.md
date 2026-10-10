# ADR-0104: Unknown provider usage is durable cost uncertainty

- **Status**: Proposed — maintainer approval required before dependent implementation
- **Date**: 2026-10-10
- **Related**: [ADR-0011](0011-internal-llm-abstraction.md) · [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) · [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) · [ADR-0065](0065-provider-economics-and-extensibility.md) · [ADR-0070](0070-durable-per-model-session-cost-attribution.md) · [ADR-0074](0074-durable-conservative-budget-commitments.md) · [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) · [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) · [ADR-0077](0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) · [ADR-0089](0089-media-correctness-four-boundaries.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md) · [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
- **Scope**: W8 / CR-82. Refines the usage representation and coverage of reported cost without changing realized-money arithmetic, admission estimates, authorization, or native separate-endpoint media's accepted volume basis.
- **Canonical homes on implementation**: [LLM seam](../reference/shared-core/llm-provider-seam.md), [event contract](../reference/contracts/sse-event-schema.md), [database schema](../reference/shared-core/database-schema.md), [runner](../reference/shared-core/agent-runner.md), [session contract](../reference/contracts/agent-session-spec.md), and [CLI](../reference/cli/commands.md).

## Context

CR-82 requires missing or partial usage to remain unknown on every path reaching a cost total.
The current seam requires numeric input/output counts on every generated result and successful
stream stop. OpenAI/DeepSeek and Gemini can substitute an entirely zero record or zero-fill a
missing required counter. Anthropic can start cumulative accounting at zero without having
received the corresponding input evidence. These values satisfy the current complete-usage
schema and can release a real budget reservation as a fully priced zero call.

The adapters also retain usage locally during a stream but can omit it from an error or truncated
terminal. W7 preserves evidence that crosses the seam; it cannot preserve an observation that an
adapter discards. Its absent-usage path retains a capped admission, but an unbudgeted usage-less
attempt produces no corresponding durable uncertainty. Existing CLI totals can consequently say
`free` even when provider billing is unknown.

These are coupled contract gaps, not just three adapter defaults. An optional complete usage record
would protect some reservations while losing partial observations and leaving persisted totals
ambiguous. Conversely, making every existing complete-usage field optional would weaken the
pricing boundary and invite another implicit zero. Input completeness matters to context-tier
selection as well as to multiplication.

The [W8 preflight and execution plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-preflight-and-proposed-execution-plan--2026-10-10)
tracks the source findings and proposed implementation increments. The constraints are
[engine-first](../standards/architectural-principles.md#1-engine-first), platform purity, one
canonical home, no new dependency, and preservation of W7's actual/conservative money separation,
request ownership, error provenance, receipt lifetimes and durability barriers.

## Decision

**We propose one discriminated usage-evidence value, durable coverage bracketing each potentially
billable token-provider invocation, and qualified totals through every live and persisted reader.**
This proposal does not authorize dependent code until the maintainer accepts it.

### One evidence value, with a complete-only pricing boundary

Keep the existing complete `Usage` quantity type and its safe-integer validation and owned snapshot.
Introduce `UsageEvidence` with `complete`, `partial` and `missing` alternatives. Complete evidence
contains a validated complete `Usage`; partial evidence contains only known canonical quantities;
missing evidence contains no invented quantities. Reasons are fixed, content-free values.

Use that single value at the result, stop, accountable error and invoked-attempt boundaries.
Do not maintain an independently writable usage record and completeness flag that can disagree.
An error before provider invocation has no provider evidence; a local diagnostic must not become
an incurred charge. External implementations of the seam must migrate to the explicit evidence
contract, with a documented compatibility change and typed boundary validation.

An explicitly reported zero remains zero. Absent required counters remain absent. Validate native
quantities before arithmetic: a contradictory cache split must not become plausible through
clamping. Derive canonical net input only when the provider's gross/cache evidence supports it.
Record the provider-specific omission rules for optional cache, reasoning and media quantities in
the seam's canonical usage section. SDK optionality alone is not evidence of a zero. Non-applicable
media on a text-only call differs from generated media whose billed units were not reported.

An interrupted cumulative observation is partial unless that dialect supplied authoritative final
usage before interruption. Preserve the latest trustworthy quantities without summing cumulative
frames repeatedly. A complete native context-window stop retains its actual usage and existing
failed-attempt accounting. Useful content with unknown billing does not trigger another paid call
merely to recover usage.

Only complete, trustworthy usage enters the existing actual-cost pricing path. Partial quantities
remain observable, but this decision introduces no guessed partial monetary charge: substituting
zero for unknown context can select the wrong price tier. Already known complete charges from
other attempts remain in actual totals. The remaining charge is unknown, even if their known sum
is zero. Reservations and authored request estimates remain separate from realized spend.

### Uncertainty is durably bracketed even without a budget

Before permitting each eligible token-provider invocation, persist a coverage-only
`cost:usage_pending` event and join its successful write through the existing asynchronous
pre-attempt/money boundary, whether or not a governor exists. A failed pending write refuses
egress. Skipped candidates need no marker. Admission or credential/cancellation failure after
the marker resolves it only when non-invocation is proven. The marker means a call may occur;
it is not proof of invocation or billing, a realized charge, a conservative money commitment,
or recovered allowance/retry authority. Keep pending counts separate from observed call counts.

Allocate an immutable invocation identity that distinguishes owner, dispatch, tool/summariser
round and within-chain attempt. Do not join by model or a resettable attempt number alone.
Use the same identity for pending coverage, authoritative settlement and registered late
receipts. Resolve pending coverage atomically with its complete, partial, missing or proven
non-invoked disposition; duplicate settlement/receipt delivery cannot charge or count twice.
No independently writable completion flag may assert that an unmatched marker is settled.

Complete-usage settlement resolves pending coverage through the existing sole actual-cost write,
with matching invocation correlation, including the existing distinct missing-price disclosure.
Introduce `cost:usage_disposition` for partial/missing usage and for proven non-invocation or
approved official pre-content refusal without usage. Its fixed discriminated disposition
distinguishes these outcomes: only an invoked, potentially billed incomplete outcome adds unknown
charge coverage. A proven release does not invent complete-zero token usage or a paid call.
It carries correlated identity, fixed evidence/reason and known canonical quantities, with no
request, provider payload, credential, invented token count or invented realized amount. Exact
schemas belong only in the canonical event contract and its shared Zod implementation.

For runs, persist it through the existing ordered writer and exact ownership fence. For sessions,
the existing single-owner persister records equivalent per-model and aggregate coverage in one
transaction. Start the disposition write at settlement and join it through the existing B1/B2/B3
money barrier, with retained failure, whether or not a governor exists. A failed uncertainty write
cannot silently permit another egress, tool effect or successful enclosing boundary.

On crash/reopen, an unmatched pending marker remains uncertain even if its owner later succeeds
or an estimate is released. Realized amounts are still unrecoverable without evidence; qualify
the known sum instead of manufacturing spend or assuming a free call. This refines ADR-0070 §3
exception 5's presentation of an unsettled crash while preserving its realized-money invariant.
Persisted-history hosts must acknowledge the pending write before provider egress; an entirely
volatile embedding cannot promise crash persistence.

An engaged, incompletely accounted attempt retains its held admission at the safe estimate.
Proven pre-provider failures and approved official pre-content refusal cases keep their current
release authority. Their observed outcome must not be recast as an unknown paid call merely
because a provider supplied no usage on a refused request. Custom endpoints retain their existing
conservative policy. A complete, explicitly zero and fully priced attempt can settle at zero.
Releasing an estimate deliberately does not erase historical uncertainty about usage.

Do not redefine `cost:attempt_settled` as an actual charge when none is established. Preserve
the run's telescoping delta/max-snapshot rules and the session's single-writer sum invariant.
Coverage is an independent fold, never another money addend or another competing cost writer.
Late evidence from a permitted registered receipt remains joined under ADR-0103; it cannot reopen
the primary stream or rewrite an already published terminal payload. Final history/host health
may reflect its durable disposition under the existing receipt contract.

### Replay, legacy history and all total readers

Persist coverage and unknown-call attribution for both capped and uncapped owners. It survives
crash/reopen, workflow resume, session resume/reseat, compaction, failed/aborted turns and estimate
release. Its fold cannot become complete because a later attempt succeeds. Session per-model
counts and aggregate coverage change atomically with their owning record.

An additive migration preserves historical numeric actual totals. Mark pre-upgrade coverage as
legacy/unverified; do not manufacture historical calls, token counts, reservations or evidence.
A newly created owner with no potentially billable attempt has complete zero coverage. Keep
missing usage distinct from missing model/modality prices, while allowing a total to disclose both.

Every human-facing total and machine-readable projection carries coverage. This includes live
headers, final summaries, `/cost`, compaction notices, Home, history, status, logs, list/detail JSON
and per-model breakdowns. A known numeric sum with incomplete or legacy coverage is qualified
as such; it cannot render as an unqualified total or `free`. Report known complete amounts and
unknown quantities separately. Existing numeric money fields retain their actual-known-sum
meaning; accompanying explicit coverage is required in the new output contract. No estimate is
reported as actual to fill a missing charge.

For a workflow run, append a content-free `cost:coverage_started` discriminator before publishing
complete coverage or permitting new-contract production/checkpoint handoff. It establishes the
coverage basis: a new owner's complete zero, or an upgraded owner's retained legacy/unverified
history. A run without this basis is unverified, never implicitly complete. This is accounting
state, not a global application/log-version field. Initialize once per owner; resume cannot reset
existing pending, unknown or legacy coverage by writing another complete-zero basis. The boundary
precedes ordinary authored gates too, so a pre-first-provider pause cannot be resumed by an
uninstrumented predecessor. A failed
boundary append permits no new-contract execution; a crash prefix without it remains unverified.

All three new durable discriminators supply the existing strict predecessor replay barrier under
ADR-0075/0100, including owner-initialization and pending-only prefixes.
Optional fields on a known event alone are insufficient because predecessors can strip them.
Prove that an executable predecessor refuses the new event before egress, while legacy positive
controls remain resumable and tolerant read-only display still works. Do not rewrite frozen
predecessor source or dependency artifacts to obtain that result. Historical session columns are
not an event log, so the run discriminator alone cannot protect session writes by a predecessor.

Protect session coverage with database-maintained mutation revisions and transactional writer
acknowledgements. Relevant session, transcript and per-model accounting writes advance the
owning session's revision, including writes issued by an older executable. A new writer first
checks the previously acknowledged revision, then acknowledges its own completed writes in the
same transaction. An existing mismatch is sticky legacy/unverified coverage; a new writer must
not acknowledge it away as complete. Reads with an unacknowledged revision are also unverified.
Default coverage for rows inserted without the new protocol is unverified. Creation of a new,
complete-zero owner and its initial acknowledgement are atomic. Do not rely on an old writer
updating new columns, a timestamp, or a persistent writer-active flag that can survive a crash.

The additive migration owns this mechanism and its triggers. Cover every shipping mutation,
including insertion, update and deletion, with aggregate/per-model consistency and crash/reopen
controls. Preserve known amounts and existing conservative commitments; do not fabricate unknown
call counts for an uninstrumented writer. A new → old → new executable session round trip must
never recover complete/free coverage after the old writer's synthetic-zero accounting. Subsequent
new writes and estimate release cannot clear that taint.

An older executable cannot display coverage or enforce this new accounting contract. Active
downgrade execution is unsupported: these database controls preserve uncertainty after legacy
writes, not the old runtime's budget safety, and cannot reconstruct an old call that left no
durable trace. State that limit explicitly. Existing retained conservative commitments remain
intact; do not claim that they prevent the predecessor's synthetic-zero release defect.

### Native separate-endpoint media retains its existing basis

Native generative media/job accounting uses its accepted authored output volume and frozen
submission basis. Its legitimate zero token counts mean no token billing on that path. They are
not synthetic provider token usage. Preserve fractional durations, missing-rate disclosures,
once-only accounting, reservation retention and terminal money barriers. This proposal does not
replace that basis with a fabricated token record or classify it as missing token usage.
Inline generated media carried by the token seam remains within the applicable usage-evidence
and missing-media-rate rules above.

### Alternatives considered

- Optional complete usage alone: rejected as the final contract because it loses partial evidence
  and leaves budgetless/history totals falsely certain.
- Optional numeric fields throughout the current `Usage`: rejected because complete-only pricing
  becomes indistinguishable from an incomplete observation and zero defaults become tempting.
- Parallel usage and status fields: rejected because two writable accounts can contradict.
- Fail or retry every useful response without usage: rejected because unknown billing is not
  evidence that generation failed, and a retry can incur another charge.
- Price unknown quantities as zero, or report the reservation as actual: rejected because both
  manufacture an accounting fact.
- Persist uncertainty only when a cap exists: rejected because an uncapped run still spends money.
- Coverage fields only on existing events: rejected as the sole replay protection because older
  known-event parsers can discard them silently.

## Acceptance and landing obligations

Actual offline SDK generate/stream controls cover missing whole usage, empty/partial counters,
complete zero, cumulative frames, contradictory cache splits, usage before error/truncation,
reasoning, inline media and native overflow. Preserve separate-endpoint media positive controls.

Real engine and native SQLite tests cover cap/no-cap, concurrent attempts, admission retention,
genuine zero release, failed uncertainty writes at all three barriers, crash/reopen, legacy rows,
resume/reseat, compaction, cancellation, estimate release, late receipts and both money invariants.
Kill a real child execution after provider invocation but before settlement; reopening retains
pending uncertainty for capped and uncapped sessions/runs, failover and summariser calls.
Test failed pending writes, cancellation/credential failure before invocation, repeated identities,
and subsequent success without erasing unmatched coverage. Removing pre-egress pending durability
must break the corresponding crash regression.
Exercise actual predecessor session writers in the new → old → new schedule, old inserts and
updates/deletions, new writes after taint, and crashes around revision acknowledgement. Removing
the database revision protection must break the corresponding round-trip regression.
Tests cover every affected human and JSON total; no unknown amount is asserted as a free call.

Causal removals must separately restore whole-zero defaults, required-counter zero filling,
the usage-less early return, omitted durable coverage and unqualified rendering. Each must fail
its corresponding regression; exact restoration must pass. Run the executable predecessor
against all three new discriminators and both legacy controls. Include a newly initialized run
paused at an ordinary gate before its first provider call: old resume must refuse, release its
lease and produce no provider invocation. A prefix without the initialization boundary and a
genuine pre-upgrade run retain legacy/unverified coverage. Removing owner initialization must
break this new/old/new control. Do not count assertion quantity or mock parity as these proofs.

On implementation, update the canonical homes linked above and dated forward notes in
ADR-0011/0030/0031/0070/0074/0075/0076/0077/0089/0100/0103. Preserve all accepted bodies.
Record actual schema/migration identities after generation, not hypothetical filenames. Update
the conformance contracts and frozen replay harness coverage without regenerating genuine W7
overflow artifacts. CR-82 remains open until end-to-end implementation and both fresh review
rounds, whole-wave checks and documentation reconciliation are complete.

## Consequences

### Positive

- Missing evidence cannot masquerade as a free attempt or silently refund a held admission.
- A crash before settlement leaves durable uncertainty without inventing an actual charge.
- Partial observations survive failures without weakening complete-only money arithmetic.
- Capped and uncapped histories disclose the same uncertainty through every surface.
- Existing request ownership, money barriers, native-media accounting and late receipt rules remain intact.

### Negative

- The exported seam changes intentionally; all shipping consumers and test providers must migrate
  in reviewed increments, with compile-time and runtime boundary checks.
- Persistence and projections grow coverage metadata and new events. Mitigate with additive
  migrations, strict replay controls and the existing single ownership of money writes.
- Eligible provider invocations add a pre-egress durability write. It buys crash coverage;
  settlement must join it without introducing a second realized-cost writer or unbounded
  completed-attempt session history. Retain only required aggregate/pending state.
- Historical exact usage cannot be recovered. Preserve its amounts and disclose legacy coverage
  rather than inventing a backfill.
- An incomplete attempt may retain an overestimate and show unknown actual spend. Keep the
  established explicit estimate-release surface and explain the two independent facts.
