# ADR-0104: Unknown provider usage is durable cost uncertainty

- **Status**: Accepted — maintainer approved the reviewed revision and W8 execution plan on 2026-10-10; implementation staged in W8
- **Date**: 2026-10-10
- **Related**: [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md) · [ADR-0011](0011-internal-llm-abstraction.md) · [ADR-0028](0028-workflow-resource-governance.md) · [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) · [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) · [ADR-0049](0049-cli-machine-output-contract.md) · [ADR-0064](0064-live-model-catalog.md) · [ADR-0065](0065-provider-economics-and-extensibility.md) · [ADR-0070](0070-durable-per-model-session-cost-attribution.md) · [ADR-0071](0071-models-dev-as-the-model-metadata-source.md) · [ADR-0074](0074-durable-conservative-budget-commitments.md) · [ADR-0075](0075-fail-closed-resume-on-an-unreadable-event-log.md) · [ADR-0076](0076-durable-per-attempt-realized-cost-ledger.md) · [ADR-0077](0077-realized-cost-ledger-uses-the-conservative-commitment-barrier.md) · [ADR-0082](0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) · [ADR-0089](0089-media-correctness-four-boundaries.md) · [ADR-0096](0096-a-request-is-measured-before-it-is-sent.md) · [ADR-0097](0097-a-budget-approval-is-an-allowance-not-an-exemption.md) · [ADR-0099](0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md) · [ADR-0100](0100-budget-authorization-is-durable-state-with-a-replay-barrier.md) · [ADR-0103](0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
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

**We adopt one discriminated usage-evidence value, durable coverage bracketing each potentially
billable token-provider invocation, and qualified totals through every live and persisted reader.**
The maintainer accepted the complete reviewed revision (SHA-256
`e7aa88cb48c4293476906d946652c828ae66f02b876dd7edd9b9d80581306d50`) and seven-step W8 plan on
2026-10-10. Dependent implementation is authorized; acceptance of this decision does not claim
that its runtime protocol or CR-82 is implemented.

### One evidence value, with a complete-only pricing boundary

Keep the existing complete `Usage` quantity type and its safe-integer validation and owned snapshot.
Introduce `UsageEvidence` with `complete`, `partial` and `missing` alternatives. Complete evidence
contains a validated complete `Usage`; partial evidence contains only known canonical quantities;
missing evidence contains no invented quantities. Reasons are fixed, content-free values.

Use that single value at the result, stop, accountable error and invoked-attempt boundaries.
Do not maintain an independently writable usage record and completeness flag that can disagree.
An error before provider invocation has no provider evidence; a local diagnostic must not become
an incurred charge. External implementations of the seam must migrate to the explicit evidence
contract. This is an intentional breaking change to the local/Phase-1 `LLMProvider` API, not an
additive optional alias. Migrate all in-tree implementations, mocks and consumers together before
activating the protocol; document the package/API compatibility change for external implementers.
The managed gateway is **Phase 2 (cloud), not implemented**; its future provider must implement
the new contract. There is no claim of compatibility with an old gateway or a new runtime
version-negotiation protocol. Export `UsageEvidenceSchema` and an owned validation boundary whose
fixed, content-free typed rejection is `InvalidUsageEvidenceError`; invalid evidence cannot enter
pricing or become synthetic complete-zero usage. Use existing error classification, without a
new durable `ErrorCode`. Successful stream stops carry `stopReason` and `UsageEvidence`, whose
`missing` arm is legal; a stop no longer promises complete quantities.

An explicitly reported zero remains zero. Absent required counters remain absent. Validate native
quantities before arithmetic: a contradictory cache split must not become plausible through
clamping. Derive canonical net input only when the provider's gross/cache evidence supports it.
Record the provider-specific omission rules for optional cache, reasoning and media quantities in
the seam's canonical usage section. SDK optionality alone is not evidence of a zero. Non-applicable
media on a text-only call differs from generated media whose billed units were not reported.

Construct evidence from native field presence **before** applying defaults or subtraction. The
following are decision rules; the canonical seam owns their complete dialect mapping and fixtures
on implementation. Absence is not zero merely because a JSON/SDK field is optional.

| Dialect | Required evidence and treatment of absence |
| --- | --- |
| OpenAI Chat Completions | A known `prompt_tokens` is gross input. Derive net input only with a validated applicable cache split (`prompt_tokens_details.cached_tokens`, including explicit zero, and any separately billed cache-write class applicable to the supported model). Gross input without the required cache evidence is partial: preserve independently known canonical output/cache quantities, but do not publish gross as net input or infer a cache miss. Missing `completion_tokens` leaves output unknown; its known value already includes reasoning. Missing an observability-only reasoning subset does not invalidate known output. |
| DeepSeek | Validate native `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` and the compatible `cached_tokens` alias when present. Native hit/miss quantities are cache-read/net-input evidence; when gross or duplicate aliases are also present, require agreement (`gross = hit + miss`). Gross plus a known hit can derive miss, or gross plus a known miss can derive hit. Gross alone cannot establish the split; retain partial evidence. Missing completion remains unknown. |
| Anthropic | Preserve native non-cached input, output and applicable cache-read/write quantities independently. A cumulative accumulator starts with absent fields, never zero. Later cumulative frames replace the quantities they actually report and retain earlier trustworthy fields; they are not additive deltas. Complete status requires authoritative final usage and every applicable billing quantity; an absent required input cannot be supplied by a final output-only frame. |
| Gemini | Missing `promptTokenCount` leaves input unknown even when output is known. Prompt is gross including cached content; derive net input only when the applicable cached quantity is known. A known candidate count alone does not establish output for a thinking-enabled call: applicable thought tokens must be known too. Tool-use prompt tokens are required when applicable. An absent optional class may contribute zero only when the owned request/dialect proves that class inapplicable or a documented omission rule proves zero; otherwise retain partial evidence. Never use `Math.max` to conceal a negative cache subtraction. |

These conservative rules deliberately allow useful custom/compatible responses to have partial
billing coverage. They do not introduce another paid call. An explicit zero, or an absent class
whose non-applicability is established, remains a valid zero. Contradictory or invalid quantities
do not become complete through clamping; preserve only independently trustworthy observations
with a fixed reason. Do not persist a raw provider usage object merely to retain gross counters.
Applicable inline-media billing quantities follow the same presence rule; missing media rates
remain the distinct ADR-0071 disclosure.

The native field relationships are documented by the providers: [OpenAI Chat Completions caching](https://developers.openai.com/cookbook/examples/prompt_caching101),
[DeepSeek completion usage](https://api-docs.deepseek.com/api/create-chat-completion/),
[Anthropic cumulative stream usage](https://platform.claude.com/docs/en/build-with-claude/streaming),
and [Gemini usage metadata](https://ai.google.dev/api/generate-content#UsageMetadata).
The decision to retain uncertainty when necessary evidence is absent is Relavium's policy;
these references do not justify treating an omitted field as zero.

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
egress. Follow ADR-0064's bounded deterministic busy/locked retry around the entire outer
`BEGIN IMMEDIATE` transaction, including the session revision protocol below. A retryable lock
within that budget is not a final failed write; exhausted retries or a non-retryable failure
roll back the whole transaction and refuse egress. Do not retry the provider call or only the
acknowledgement. Skipped candidates need no marker. Admission or credential/cancellation failure after
the marker resolves it only when non-invocation is proven. The marker means a call may occur;
it is not proof of invocation or billing, a realized charge, a conservative money commitment,
or recovered allowance/retry authority. Keep pending counts separate from observed call counts.

Allocate an immutable invocation identity that distinguishes owner, dispatch, tool/summariser
round and within-chain attempt. Do not join by model or a resettable attempt number alone.
Use the same identity for pending coverage, authoritative settlement and registered late
receipts. Resolve pending coverage atomically with its complete, partial, missing or proven
non-invoked disposition; duplicate settlement/receipt delivery cannot charge or count twice.
No independently writable completion flag may assert that an unmatched marker is settled.

This identity is coverage/receipt correlation only, not a second money deduplication key.
ADR-0076's run append uniqueness remains `UNIQUE(run_id, seq)`; session model aggregation remains
`UNIQUE(session_id, model, is_legacy)` with its one transactional writer. Keep both existing money
arithmetic rules. ADR-0076 §3's chain-attempt and node-retry counters remain distinct and cannot
join each other. Coverage resolution cannot replay a money write.

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
exceptions **1, 2 and 5**: usage-less successful/failed attempts and unsettled crash prefixes gain
coverage dispositions without inventing realized spend. Complete evidence still follows the
existing actual-money path; the missing-price and non-reconciling token-total exceptions remain
independent. Permanently unavailable usage cannot be recovered from a revision or pending marker.
Persisted-history hosts must acknowledge the pending write before provider egress; an entirely
volatile embedding cannot promise crash persistence. The shipping persisted-history host is the
CLI, for both workflows and sessions. Desktop and VS Code currently have placeholder app trees;
their future persisted hosts must honour this boundary before claiming equivalent crash coverage.

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
The names distinguish scope: `coverage_started` establishes an owner's historical basis;
`usage_pending` and `usage_disposition` bracket one invocation's usage evidence. All three belong
to the durable `cost:` namespace alongside the existing `cost:attempt_settled` member.
Optional fields on a known event alone are insufficient because predecessors can strip them.
Prove that an executable predecessor refuses the new event before egress, while legacy positive
controls remain resumable and tolerant read-only display still works. Do not rewrite frozen
predecessor source or dependency artifacts to obtain that result. Historical session columns are
not an event log, so the run discriminator alone cannot protect session writes by a predecessor.

Protect session coverage with database-maintained mutation revisions and transactional writer
acknowledgements. This narrowly refines **ADR-0070 §3's rejection of a trigger**: its objection
was duplicating money logic in two languages. These triggers only advance mutation metadata;
they never price usage, alter actual totals, reconcile money or become another cost writer.
They are needed because an older writer cannot cooperate with newly introduced columns.

The canonical [database schema](../reference/shared-core/database-schema.md) must own the concrete
revision/acknowledgement/taint transition table, trigger/column inventory and migration on landing.
The decision constraints for that table are:

1. Relevant session business fields, transcript and per-model accounting inserts/updates/deletes
   advance the owning session's mutation revision, including an older executable's writes.
   Child deletion advances the prior owner's revision; reparenting affects both old and new
   owners. Coverage/acknowledgement bookkeeping columns are excluded from these triggers so
   acknowledging a write cannot recursively create self-taint.
2. In one outer `BEGIN IMMEDIATE` transaction, a new writer reads the **entry** revision,
   acknowledged revision and persisted legacy/unverified taint before its business mutations.
   An entry mismatch first sets sticky taint. It then performs its own writes and acknowledges
   the **final trigger-produced revision** in that transaction, preserving all existing taint.
   Acknowledgement does not mean historical coverage is complete.
3. For example, `(revision=10, ack=10, taint=false)` becomes `(11,10,false)` after an old write.
   A new write observes the mismatch and commits `(12,12,true)`; subsequent writes and estimate
   release cannot clear it. Reads classify mismatch **or** sticky taint as unverified and never
   acknowledge. A failed transaction rolls back its business writes, taint and acknowledgement
   together; the original mismatch remains visible.
4. Default coverage for migrated or predecessor-inserted rows is unverified. Only genuinely new
   owner creation may atomically insert the owner, establish complete-zero coverage and acknowledge
   its initial revision. Resume, reseat, reinsertion of legacy history or an ordinary update cannot
   use that privilege to reset uncertainty. Do not rely on a timestamp or a writer-active flag
   that can survive a crash.

The additive migration owns this mechanism and its triggers. Cover every shipping mutation,
including insertion, update and deletion, with aggregate/per-model consistency and crash/reopen
controls. Preserve known amounts and existing conservative commitments; do not fabricate unknown
call counts for an uninstrumented writer. A new → old → new executable session round trip must
never recover complete/free coverage after the old writer's synthetic-zero accounting. Subsequent
new writes and estimate release cannot clear that taint.

ADR-0005 permits dialect-specific implementation inside `packages/db`, not different accounting
semantics. SQLite trigger DDL and its transaction controls land and are tested in W8. **Phase 2
(cloud)** PostgreSQL must implement the same transition table with dialect-specific triggers and
locking/migration tests before that persistence target is enabled. This is a dialect/target change
without a data-model fork; no PostgreSQL implementation or tested parity is claimed in this local
wave. Record this refinement in dated notes to ADR-0005 and ADR-0070 on implementation.

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

### Coverage bookkeeping and retention

Coverage adds **one owner-basis event and, ordinarily, at most two durable records per eligible
invocation**: pending plus its settlement (the existing actual-cost event or a disposition).
Registered late evidence can add a bounded disposition per authoritative receipt transition;
duplicate callbacks and cumulative token frames add none. Bound each record to correlated
identity, fixed reasons and canonical quantities, with bounded identifier lengths and at most
one entry per supported media billing axis in the canonical schemas; never include raw payloads
or emit per token.

Fold incrementally. Retire a settled invocation's identity once it has no permitted receipt
authority, retaining its aggregate unknown/pending/model coverage rather than its completed
attempt history. Duplicate rejection after retirement must not require a lifetime completed-ID
set. Added fold state is `O(models + unresolved invocations + receipt-eligible invocations)`,
not `O(all historical attempts)`; do not rescan a full prefix on every settlement. Replay must
use incremental/batched reading, rather than materializing the additional coverage history.
Crash-orphaned pending markers remain uncertain; aggregate them once the prior owner's receipt
authority is fenced, preserving known model attribution and no recovered invocation authority.
Do not discard a genuinely live late receipt to satisfy a memory target: ADR-0103's conditional
close liveness is unchanged, and no constant bound is claimed for outstanding receipt work.

The authoritative run event log remains append-only and grows linearly with attempts, as the
existing ADR-0076 ledger does. W8 does not introduce destructive ledger compaction or silently
change history retention. Coverage follows its owning run's existing explicit deletion/retention
policy; it is not independently pruned while a retained run still needs replay. ADR-0087 §1's
in-memory delivery modes do not promise a constant-size database. Acceptance uses **100,000
settled invocations with up to 64 simultaneously unresolved controls** to pin write counts,
bounded metadata size and no growth of completed-invocation fold state. Separately test genuinely
unresolved prefixes and registered late receipts; acknowledge their surviving state explicitly.

### Alternatives considered

- Optional complete usage alone: rejected as the final contract because it loses partial evidence
  and leaves budgetless/history totals falsely certain.
- Optional numeric fields throughout the current `Usage`, with a completeness flag: rejected
  because complete-only pricing becomes indistinguishable from an incomplete observation and
  the independently writable flag can contradict the fields; zero defaults become tempting.
- Parallel usage and status fields: rejected because two writable accounts can contradict.
- Fail or retry every useful response without usage: rejected because unknown billing is not
  evidence that generation failed, and a retry can incur another charge.
- Price unknown quantities as zero, or report the reservation as actual: rejected because both
  manufacture an accounting fact.
- Persist uncertainty only when a cap exists: rejected because an uncapped run still spends money.
- Coverage fields only on existing events: rejected as the sole replay protection because older
  known-event parsers can discard them silently.

## Acceptance and landing obligations

Each numbered invariant needs direct regression evidence and its stated causal control. Mock
parity or assertion quantity is not acceptance. These are implementation obligations, not claims
that the accepted contract is already shipped.

1. **Native evidence construction.** Actual offline SDK generate/stream controls cover missing
   whole usage, empty/partial counters, complete zero, each dialect's gross/cache rule above,
   contradictory splits, reasoning and applicable inline media. Separately restore whole-zero
   defaults, required-counter zero filling and gross-as-net fallback; each restoration must break
   its corresponding regression, and exact restoration of the fix must pass.
2. **Owned observations survive terminal failure.** Own and validate every evidence arm across
   adapters, fallback attempts, errors and the held terminal/confirming read. Cover cumulative
   frames, absent Anthropic start input, usage before error/truncation, alias mutation, malformed
   tails, deadlines and native context-window stops. Removing the relevant observation retention
   or ownership must fail the associated control. Invalid evidence after invocation retains
   uncertainty and never causes a paid retry solely to obtain accounting data.
3. **Pending durability precedes every eligible invocation.** Real child executions are killed
   after invocation but before settlement, for capped/uncapped sessions and runs, failover and
   summariser calls. Reopen retains pending uncertainty. Removing pre-egress pending durability
   must break the crash regression. Failed pending writes prove zero egress; retryable SQLite
   locks can succeed within the existing bounded retry budget, while exhaustion rolls back and
   refuses. Cover cancellation and credential failure between marker and invocation.
4. **Settlement, correlation and money stay single-owned.** Real engine/native SQLite tests cover
   concurrent attempts, complete/partial/missing settlement, proven non-invocation and official
   pre-content refusal, genuine zero release, retained admissions, both money invariants,
   repeated identities, late receipts and B1/B2/B3 uncertainty-write failures with/without a cap.
   Restore the usage-less early return or omit the durable disposition independently: the
   corresponding regression must fail. Later success, compaction and estimate release cannot
   erase unknown coverage or turn a pending marker into an observed paid call.
5. **Strict replay protects the new basis and attempts.** Run an executable predecessor against
   all three new discriminators and genuine legacy positive controls; tolerant read-only display
   still works. Include a newly initialized run paused at an ordinary gate before its first
   provider call: old resume refuses, releases its lease and produces no invocation. A prefix
   without initialization and genuine pre-upgrade history remain legacy/unverified. Removing
   owner initialization must break this control. Do not rewrite frozen source/dependency bytes.
6. **Session revisions cannot launder old writes.** Exercise actual new → old → new writers,
   predecessor inserts/updates/deletes, reparenting, subsequent new writes and estimate release,
   and crash cuts before/after acknowledgement. Cover all shipping CLI persister entry points
   (fresh/resumed/reseated chat and Home) independent of governor presence. Check creation versus
   migrated defaults, no recursive bookkeeping triggers, one outer transaction and atomic
   aggregate/per-model taint. Removing database revision protection must break the real
   round-trip regression. Add the concrete transition table and dialect obligations to the
   database schema; do not label unimplemented PostgreSQL parity tested.
7. **Every total qualifies coverage; media keeps its basis.** Test every affected human and JSON
   reader, live/history/per-model, crash/resume/reseat, compaction and cancellation. Restore
   unqualified/free rendering and its regression must fail. Preserve separate-endpoint media
   positive controls: authored/frozen basis, fractional volumes, missing rates, once-only
   accounting, retained reservations and terminal barriers. Unknown tokens cannot replace
   legitimate native-media zero token quantities.
8. **Coverage history does not become a completed-invocation memory leak.** Exercise 100,000
   settled invocations with up to 64 simultaneous pending controls, mixed models and uncertainty.
   Assert added write counts and bounded schema/metadata shape, no per-frame durable events,
   retirement of completed identities and preserved aggregate coverage. Incremental replay and
   live settlement retain only the state defined above. Duplicates after retirement, orphaned
   crash prefixes and still-authorized late receipts preserve their stated outcomes. Removing
   retirement or introducing a per-settlement full-prefix scan must fail the structural control;
   a wall-clock threshold alone is insufficient.

On implementation, update the canonical homes linked above and dated forward notes in
ADR-0005/0011/0028/0030/0031/0049/0064/0065/0070/0071/0074/0075/0076/0077/0082/0089/0096/0097/
0099/0100/0103. Preserve all accepted bodies. Specifically reconcile ADR-0070 §3 exceptions
1/2/5 and its metadata-only trigger refinement, ADR-0076's identity/two-counter rules,
ADR-0028/0097 admission versus actual coverage, ADR-0071 missing prices, ADR-0049 JSON and
ADR-0099 compaction totals. No proposed schema is pre-landed as current runtime behaviour.

Explicit landing checks include `packages/shared/src/constants.ts`'s durable `cost:` classification
and obsolete sole-member comment, the shared event schemas and seam cost-event inventory;
the seam's stop grammar, owned terminal evidence, dialect cache table (including Gemini's
existing cache split) and Phase-2 managed-gateway wording. Forced `include_usage` is a request
for usage, not proof that a final usage chunk survives interruption. Keep these exact contracts
in their canonical homes, not copied into runner/session guidance.

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

### W8 activation review correction — 2026-10-10

The third cumulative activation review reproduced native repair, receipt-scope and live publication
gaps. Each potentially billed repair now obtains its own existing admission after settling and joining
the prior invocation; a custom unknown call retains its exposure when a later call reports zero.
Late pending acknowledgement must retire a positively uninvoked repair with its exact correlation.
Receipt identity never bypasses an ended producer scope; the runner explicitly transfers accounting
work and joins its registered raw producers. Cumulative native observations retain independently known
quantities without promoting incomplete evidence. The ordered workflow writer folds acknowledged
coverage before publication; session views seed amount and coverage from one atomic breakdown.
The canonical [seam](../reference/shared-core/llm-provider-seam.md),
[runner](../reference/shared-core/agent-runner.md) and
[event contract](../reference/contracts/sse-event-schema.md) own these implementation details.
Step 5 acceptance, Step 6's additional review gates and whole-wave closure remain open at this correction.

### W8 acknowledgement and late-receipt correction — 2026-10-11

The fourth cumulative activation review reproduced premature public completion before an actual
writer acknowledgement, resumed session totals overwritten by a stale construction-time counter,
and late receipts borrowing a newer fallback's model and diagnostic attempt. Coverage completion
follows the existing sole actual writer's ACK. Failed workflow accounting asks remain observable
under ADR-0078 with unchanged qualified coverage; they do not advance a live reader's correlation.
Persisted session totals publish the atomic durable amount/price/coverage tuple after the direct
write, while streamed content reuses the cached tuple. A post-ACK projection failure stays distinct
from persistence failure and cannot fabricate complete coverage or repeat the charge. Exact live
receipt metadata retains only its historical diagnostic attempt and local uncertainty contribution;
it cannot reseat another response or mutate an already published outcome. The canonical
[event contract](../reference/contracts/sse-event-schema.md) owns publication details and the
[runner contract](../reference/shared-core/agent-runner.md) owns receipt ownership.
Step 5 acceptance and the further Step 6/whole-wave gates remain open at this correction.

### W8 interrupted-consumer and hidden-accounting correction — 2026-10-11

The fifth cumulative activation review reproduced two gaps. An abruptly closed stream consumer
could retire its raw producer without settling the acknowledged invocation, even after owning
complete terminal usage. Teardown must preserve that usage through the existing sole cost writer
or record the incomplete disposition, exactly once, without replacing the established consumer
error, retrying or publishing a new terminal. Separately, an accounting snapshot must read a
retained owner's known money independently of the visibility filter that protects hidden one-shot
and soft-deleted sessions. Numeric accounting access grants no transcript or resume authority.
The canonical [seam](../reference/shared-core/llm-provider-seam.md) and
[database schema](../reference/shared-core/database-schema.md) own these details. Step 5 still
requires two NEW clean complete cumulative rounds; Step 6 and whole-W8 gates remain open.

### W8 native-predecessor and status-snapshot correction — 2026-10-11

The sixth cumulative activation review reproduced three gaps. A native repair's predecessor
must use the existing complete-only accounting path before fresh admission; complete evidence
accepted by the public hook cannot become an unqualified priced zero. Current OpenAI HTTP
parameter failures carry no usage, so the positive-evidence control applies to supported external
seam implementations. Host observer failures inside that repair boundary retain their opaque
identity through adapter normalization, without another predecessor record or paid repair.
This preserves the existing admission/lease fault classification and required conservative cleanup.
Separately, status must read step money and lifecycle under the same SQLite snapshot as the owner
amount and coverage fold; joining a later step SELECT can falsely qualify unknown usage as complete.
The canonical [seam](../reference/shared-core/llm-provider-seam.md) and
[database contract](../reference/shared-core/database-schema.md) own these corrections. Step 5
requires two NEW clean complete cumulative reviews after correction. Step 6's further controls
and reviews, CR-82 and whole-W8 acceptance remain open.

### W8 missing-evidence and legacy-model correction — 2026-10-11

The seventh cumulative activation review reproduced two gaps. An explicit `missing` error
usage arm cannot establish processed content merely by being present. Generate and native
repair must preserve the same pre-content refusal/failover policy as an omitted usage field;
partial or complete quantities, including zero, and actual content retain their existing proof.
Separately, a legacy session-money aggregate is not an attributable model. The coverage/model
union excludes monetary rows by their `is_legacy` flag while preserving a real model whose
literal name happens to match the sentinel. Historical money and its unavailable-breakdown
disclosure remain visible. The canonical [seam](../reference/shared-core/llm-provider-seam.md)
and [database contract](../reference/shared-core/database-schema.md) own these corrections.
Step 5 requires two NEW clean complete cumulative reviews after correction. Step 6's further
controls and reviews, CR-82 and whole-W8 acceptance remain open.

### W8 observer cleanup and historical identity correction — 2026-10-11

The eighth cumulative activation review reproduced one receipt-lifetime gap and two identifier
compatibility gaps. Registered late evidence must activate even if the primary attempt observer
throws, preserving that exact primary throwable when activation itself observes a secondary
accounting failure. This extends no provider or retry authority and leaves actual money with
the existing sole writer. The public observer and admission ports are the demonstrated boundary;
the current CLI governor normally latches its own failures instead of throwing synchronously.
Separately, a host's bounded dispatch identity must be independent of an unbounded valid authored
agent identifier. Historical monetary model names retain their original raw identity and known
amount without inheriting the new invocation-model bound. New invocation validation remains
strict, and historical uncertainty remains visible. The canonical
[seam](../reference/shared-core/llm-provider-seam.md) and
[database contract](../reference/shared-core/database-schema.md) own these corrections.
Step 5 still requires two NEW clean complete cumulative reviews. Step 6's further controls
and reviews, CR-82 and whole-W8 acceptance remain open; no new policy or deferral is introduced.

### W8 behavioral-port and admission-cleanup correction — 2026-10-11

The ninth cumulative activation review reproduced two surviving turn-boundary gaps. A behavioral
money port can implement its capabilities on a class prototype or use receiver state. Turn capture
must preserve those methods, their optional presence and their original receiver; copying own
enumerable fields can silently bypass the pending acknowledgement and lose unknown coverage.
The public session dependency accepts this interface. The demonstrated class implementation is
a supported external host; the current CLI's object-literal port is not claimed to exhibit it.

Conservative cleanup must also preserve an established exact primary throwable. Both the
actual-to-estimate fallback and final cleanup of an outstanding admission can encounter a distinct
secondary callback failure. That secondary failure retains accounting-health consequences without
replacing the primary; a failing diagnostic callback cannot change this precedence. Standalone
cleanup failures still surface. No uncertain admission is released, no successful settlement is
invented and no additional paid attempt is authorized. This is a supported admission callback
failure path, not a reproduced distinct-second-throw defect in the current built-in governor.
The canonical [runner contract](../reference/shared-core/agent-runner.md#usage-evidence-and-durable-coverage)
owns these behavioral-port and cleanup requirements. Step 5's two NEW clean complete cumulative
rounds and the further Step 6/whole-W8 gates remain required; this finding-bearing review supplies
neither acceptance round and introduces no policy change or deferral.

### W8 historical workflow missing-price correction — 2026-10-11

The tenth cumulative activation review reproduced a checkpoint compatibility gap: an explicit
historical unpriced attempt could retain its known money and unverified usage while losing its
independent missing-price count on resume. Reconstruction must retain that recorded price gap
without adding an already inclusive absolute snapshot twice. Native-media snapshot-only gaps
remain intact, and genuinely priced zero does not acquire an invented price gap. The canonical
[runner contract](../reference/shared-core/agent-runner.md#usage-evidence-and-durable-coverage)
owns this clarification. No actual-money arithmetic, admission policy, writer or public seam
changes. This finding-bearing round supplies no clean acceptance; Step 5 still requires two NEW
complete clean cumulative reviews, followed by the further Step 6 and whole-W8 gates.

### W8 retained-correlation and observer-origin correction — 2026-10-11

The eleventh cumulative activation review reproduced two ownership gaps and one reader gap.
A fold must own the scalar invocation identity it retains: a mutable public pending event cannot
change the private correlation used to accept a later exact receipt. This requires no public-event
freezing guarantee, additional authority or completed-identity history. Separately, optional native
predecessor `emitCost` notifications keep observer provenance as well as their original receiver.
A supported external host's budget/provider-shaped observer exception cannot become admission or
retry authority; exact throwable identity and mandatory realized accounting remain intact.

Status also initializes node coverage from `node:started` under the current owner basis. Native
media and ordinary nodes need no token-invocation event to retain an already verified basis;
genuine pre-basis history remains unverified. Known money and native volume accounting do not
change. The canonical [event contract](../reference/contracts/sse-event-schema.md),
[runner contract](../reference/shared-core/agent-runner.md#usage-evidence-and-durable-coverage) and
[database contract](../reference/shared-core/database-schema.md) own these requirements. This
finding-bearing round supplies no clean acceptance; Step 5 still requires two NEW complete clean
cumulative reviews before Step 6's further controls/reviews and the whole-W8 gates.

### W8 blocked-terminal evidence and corrupt-history isolation — 2026-10-11

The twelfth complete cumulative activation review reproduced a Gemini streaming ordering defect:
current prompt-block authority must be recognized before interpreting that frame's usage.
Fully explicit applicable counters on that terminal reach actual pricing and close coverage,
including legitimate zero. Missing, partial, contradictory, invalid and earlier nonfinal evidence
remain uncertain. This corrects normalization; it does not authorize a retry, change admission
policy or establish provider invoice behavior. The canonical
[usage contract](../reference/shared-core/llm-provider-seam.md#6-usage) owns the rule.

Individually valid persisted rows can form a corrupt coverage sequence. The incremental fold
classifies its duplicate-basis and non-increasing-ordinal invariants using the existing typed
per-run corruption boundary. Strict checkpoint loading still refuses the affected history;
Home/status preserve healthy neighbors and explicitly mark that run unavailable/unverified.
Unrelated runtime, database and observer exceptions are not swallowed or reclassified. The
[event contract](../reference/contracts/sse-event-schema.md#event-envelope) owns this distinction.
The session namespace's stale absent-money-port rationale is corrected to reflect its direct
writer and acknowledged `cost:updated` publication; the run-only event boundary is unchanged.

This finding-bearing round supplies no clean acceptance. Step 5 still requires two NEW complete
clean cumulative rounds after correction, followed by Step 6's further controls/reviews and
whole-W8 validation/publication. No new dependency, key, paid capture or deferral is introduced.

### W8 coverage callback observation and session stream correction — 2026-10-11

The thirteenth complete cumulative review reproduced failures in supported injected money
ports. Post-provider `claimUsage` and `usageDisposition` preserve observer origin, original
receiver and exact throwable, as the existing cost notifications do. Physical engagement and
canonical complete observations precede these callbacks; a host fault cannot erase a consumed
session turn or already observed quantities. Exact pending-receipt metadata and its local unknown
contribution also precede notification, so registered late evidence can refine or retire only
its own identity. Explicit false claims restore only their provisional state and grant no new
charge authority. Mandatory pending admission, money joins and conservative cleanup retain their
existing precedence. The [runner contract](../reference/shared-core/agent-runner.md#usage-evidence-and-durable-coverage)
owns this behavioral-port boundary.

The exported session-handle union and the canonical
[session event inventory](../reference/contracts/sse-event-schema.md#session-event-namespace)
include the already active session-envelope usage pending/disposition events. This corrects
their advertised type without adding a session basis event or run-only attempt-ledger event.

The finding-bearing review grants no clean acceptance. Step 5 still requires two NEW complete
clean cumulative rounds after correction, followed by Step 6's further controls/reviews and
whole-W8 validation/publication. No new dependency, paid call or deferral is introduced.

### W8 Gemini streamed observation ownership correction — 2026-10-11

The fourteenth complete cumulative activation review reproduced a stream-only ownership gap
in the supported injected Gemini transport. Content access could throw or mutate native counters
before the adapter owned them, and the response usage property was read twice. Generate already
preserved this observation. Stream normalization must likewise own the canonical quantities once
before further response access, retain them as partial until terminal authority is verified, then
promote that same observation without rereading native counters. Inline-media applicability still
demotes otherwise complete evidence, and a later terminal without usage cannot make earlier
nonfinal counts complete. The canonical
[usage contract](../reference/shared-core/llm-provider-seam.md#6-usage) owns this clarification.

The finding is established for the typed injected transport; ordinary installed-SDK HTTP controls
did not reproduce it. This does not change native pricing, admission, retry policy or invoice
claims. The finding-bearing round supplies no clean acceptance: Step 5 still needs two NEW
complete clean cumulative rounds, followed by Step 6's further controls/reviews and whole-W8
validation/publication. No new decision, dependency, paid call or deferral is introduced.

### W8 OpenAI-compatible streamed evidence correction — 2026-10-11

The fifteenth complete cumulative activation review reproduced two distinct retention defects
through the installed SDK's ordinary offline HTTP/SSE path. Malformed absent/null choices could
throw before the adapter owned otherwise valid native usage. Such a failure retains nonfinal
known quantities as partial; malformed content does not supply terminal authority. Separately,
a later cumulative text-only usage frame could erase an earlier native audio counter and enter
complete-only pricing without that billing axis. Input/output audio-counter presence remains
applicable across the invocation, including explicit zero and invalid quantities. Invalid
quantities establish no billed units; omission cannot repair them, while a later explicit valid
counter can. The canonical [usage contract](../reference/shared-core/llm-provider-seam.md#6-usage)
owns the mapping and regression obligations.

Absent/null choices is malformed native runtime input admitted by the SDK parser, not valid
typed provider grammar. The controls establish retention and pricing eligibility, not observed
provider behaviour or an invoice amount. These existing-contract corrections introduce no new
decision, dependency, paid call or deferral. The finding-bearing round supplies no clean
acceptance; Step 5 still requires two NEW complete clean cumulative rounds, followed by
Step 6's further controls/reviews and whole-W8 validation/publication.

### W8 OpenAI-compatible generate cleanup correction — 2026-10-11

The sixteenth complete cumulative activation review reproduced a generate-only cleanup gap
through the installed OpenAI SDK's ordinary offline HTTP path, for OpenAI and DeepSeek.
Invocation retirement could discard already owned complete usage or replace an established
HTTP provider refusal when a supported caller-listener cleanup callback threw. Cleanup keeps
that observation on the typed failure, and an existing provider diagnosis stays primary. A
cleanup-only fault receives fixed content-free, non-retryable `unknown` presentation and keeps
its original value only as an opaque private cause; its exception class grants no provider retry,
admission or budget authority. Complete evidence still reaches the existing sole cost writer
exactly once, while partial or missing evidence remains uncertain. The canonical
[seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline) owns this boundary.

The fault is demonstrated with a supported custom signal callback, not a claim that native
first-party AbortSignal cleanup throws or that a provider invoice was measured. This is an
existing-contract correction, with no new decision, dependency, paid call or deferral. The
finding-bearing round supplies no clean acceptance. Step 5 still requires two NEW complete
clean cumulative rounds after correction, followed by Step 6's further controls/reviews and
whole-W8 validation/publication.

### W8 complete-path activation acceptance — 2026-10-11

The [Step 5 register](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#step-5-combined-acceptance--2026-10-11)
records two NEW complete clean cumulative rounds at `21aa4d5e` after all sixteen corrections.
Complete-path activation is accepted on `development`; this does not close CR-82. The further
Step 6 permanent causal/crash/reader/retirement controls and two independent review rounds,
then Step 7 whole-wave checks and publication, remain required. No new decision or deferral
is introduced; the eight acceptance groups above remain the whole-W8 obligations.

### W8 Anthropic final output authority correction — 2026-10-11

The first complete cumulative Step 6 review reproduced an invalid final promotion through the
installed Anthropic SDK's offline SSE path. A final stop reason with omitted, empty, input-only
or null usage could promote the retained initial output count into complete evidence. An
independent real-engine/native-SQLite probe confirmed once-only actual pricing and closed coverage
using that unverified output. This is one corroborated finding, not two independent defects.

Final authority requires the current frame's validated nonnegative safe-integer output count,
observed in the existing single read. Earlier trustworthy input/cache/output remain partial when
that final count is absent or invalid. Legitimate output-only final usage retains earlier input
and cache; explicit final zero remains complete. The canonical
[usage contract](../reference/shared-core/llm-provider-seam.md#6-usage) owns this clarification.
Malformed native payloads admitted by the SDK parser establish the boundary defect, not a claim
about live provider behaviour or invoice amounts. No admission, retry or realized-money policy
changes, new dependency, decision, paid call or deferral are introduced.

The finding-bearing round supplies no clean acceptance. Step 6 requires two FURTHER NEW complete
clean cumulative rounds after this correction; Step 7 whole-W8 checks/reviews/publication and
CR-82 remain open.

### W8 permanent-control acceptance — 2026-10-11

The [Step 6 register](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#step-6-combined-acceptance--2026-10-11)
records two FURTHER NEW complete clean cumulative rounds, R4 and R5, at `38c04748` after the
Anthropic final-authority and canonical lifetime-wording corrections. Permanent controls are
accepted on `development`; the earlier dated Step 6 pending statements are historical.
Step 7's actual whole-wave gates, two NEW independent whole-W8 rounds and publication still
gate CR-82 and final wave acceptance. No new decision or deferral is introduced.

### W8 whole-wave implementation acceptance — 2026-10-11

All eight acceptance groups and all seven implementation/review steps are independently accepted on
`development`. The [closing register](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-closing-register--2026-10-11)
joins actual whole CI/bare and enforced coverage, permanent controls, 21 copied-source causal
mechanisms and two NEW complete cumulative main→development review rounds. Earlier dated
pending statements describe their checkpoint, not current implementation status. CR-82 closes
on `development`; publication checks and maintainer review/merge still gate landing on `main`.
The approved evidence/identity/arithmetic/native-media boundaries and existing deferrals are
unchanged. No new decision, dependency, provider invoice, paid call or platform result is claimed.

### Canonical dialect clarification — 2026-10-11

PR #92's systematic review identifies an overbroad cache-write qualification in the original
OpenAI row above. The supported OpenAI Chat Completions dialect has no separate native
cache-write billing counter. Its exact evidence requirements, including applicable native
billing classes and omission rules on every dialect, are owned by the
[canonical seam usage section](../reference/shared-core/llm-provider-seam.md#6-usage).
That implemented contract qualifies the earlier condensed decision table; the table is not a
second independently maintained dialect specification. Gross input without the required
cache split remains partial, and neither missing evidence nor a non-applicable billing class
is invented as a reported quantity. This correction does not change realized-money arithmetic,
authorization, request ownership or the accepted uncertainty protocol.
