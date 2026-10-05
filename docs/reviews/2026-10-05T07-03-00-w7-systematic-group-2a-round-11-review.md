# W7 systematic group 2a, round 11

- **Type**: Code
- **Date**: 2026-10-05
- **Reviewer(s)**: `/root/w7_group2a_round11_contracts` (`gpt-6-astra`, `xhigh`), `/root/w7_group2a_round11_runtime` (`gpt-6.1-sol`, `xhigh`); parent `/root`
- **Subject**: frozen `development`, `90a5eee8..733f0ee8`, all 44 changed paths
- **Outcome**: Changes requested; verified corrections committed, fresh complete round 12 required

## Verified findings

Both independent reviewers reproduce completion after terminal cancellation during a successful
commitment flush. An actual session sink and RunEventBus see completion after cancellation; the
primary SessionHandle closes at cancellation and sees only that terminal. Known usage and price
remain present: Contracts measures 19 microcents; Runtime measures eight. This is an ordinary
asynchronous durability handoff, rather than a duplicate primary-handle terminal claim. Cancellation
after a rejected flush stays quiet, and EA7 late abort after successful generation remains a no-op.
Contracts also reproduces cancellation inside a custom post-summary token estimator. Source order
shows that the previous implementation installs summary/history first; no public private-history
getter or next-turn observation is claimed for the cancelled session.

Runtime separately reproduces lost abort/cancel intent inside a custom controller factory before its
returned controller is stored. Send, compaction and an actual registered synthetic command can still
perform work; cancellation can be followed by start/compaction notifications. First-party factories
simply construct native controllers. This is a supported custom trusted-host boundary, not a native
controller exploit.

Both reviewers reproduce throwing custom deadline cleanup bypassing truthful attempt settlement and
allowing exception classes to acquire retry, budget-pause or failure-writer authority. Actual
Workflow/Runner/store controls demonstrate duplicate successful invocations, missing known realized
rows, false pauses, private retry diagnostics and counterfeit writer attribution. Contracts measures
a generated 80-microcent call with cache/media quantities; Runtime measures a streamed eight-microcent
call. These are offline known-price observations, not live charges. Prior canonical auth refusals
also lose their attempt records. The shared disposer can skip listener detach or leave a pending race
unwoken after a callback throws. First-party native cleanup has not been reproduced as faulty. All
three optional iterator-return controls pass; no separate iterator-return defect is asserted.

## Corrections and controls

`fce10817` makes shared disposal attempt both callbacks, release pending waiters, then rethrow the
first original failure. `1ef109c8` contains cleanup through truthful settlement and owns generated
quantities/typed content before custom cleanup. Existing provider/admission failures stay primary;
successful cleanup faults retain one known-cost failed record with fixed non-retryable presentation
and opaque cause. `0e2b016f` carries factory-raised intent onto the returned signal, refuses work after
terminal cancellation, rechecks successful flush, and estimates prospective compaction state before
installation. Known usage, price, provider-engaged cap consumption and post-summary EA7 late-abort
behaviour remain intact. Canonical contracts and append-only ADR-0055/0082/0085 notes document these
implementation repairs without introducing policy, dependencies or Request ownership.

Eight permanent files promote **99 independent controls**, with two additional parent cleanup-mutation
controls; shared disposal adds three controls. The new core files cover
[successful-flush cancellation](../../packages/core/src/engine/session-finalization-cancellation.test.ts),
[operation cancellation](../../packages/core/src/engine/session-operation-cancellation.test.ts),
[direct attempt accounting](../../packages/core/src/engine/attempt-teardown-accounting.test.ts),
[generated Workflow settlement](../../packages/core/src/engine/generated-teardown-workflow.test.ts),
[controller reentrancy](../../packages/core/src/engine/session-controller-reentrancy.test.ts),
[cleanup precedence and ownership](../../packages/core/src/engine/deadline-cleanup-precedence.test.ts),
[real queued money barriers](../../packages/core/src/engine/money-barrier-queued-writes.test.ts), and
[stream Workflow settlement](../../packages/core/src/engine/stream-teardown-workflow.test.ts).

Evidence-only writers are removed and imports/scheduling/strict fixture types adapted. Original
private fixtures remain inert. Cleanup raw escape and stream-auth throw observations are not
normative repair expectations: permanent controls require fixed typed diagnostics or error chunks,
original provider precedence and truthful money records. No behavioral assertion is removed to hide
a defect. The existing unsafe actual-cost/conservative-settlement controls remain unchanged.

## Verification and integrity

Contracts restores all pins, passes five fresh ordered builds, strict compilation and 1,079 permanent
tests in 29 files; its 51 independent cases have 18 failures and 33 passes. Runtime restores all pins,
passes five fresh ordered builds, strict fixtures/setup/config and purity/seam gates, and 1,240
permanent tests in 27 files; its 48 independent cases have 21 failures and 27 passes. Deliberate
baseline failures support changes requested, not passing acceptance. Fresh actual main and fixture
workers independently exercise credential/network denials and 11 Own package targets; idle worker
proofs are qualified separately.

Parent substitutions of only the pre-fix session/fallback files produce 18 failures/33 passes;
substituting pre-fix shared deadline too for Runtime's controls produces 21 failures/27 passes. Exact
candidates and ordered builds are restored, with all 51 and 48 controls passing. Additional cleanup
mutation controls fail twice against the earlier candidate and pass after capture precedes cleanup.
These are prepared Parent graph experiments, not exact whole-Original baseline runs or fresh builds.

Final forced Original lint/typecheck/test passes **23 tasks, 351 files, 8,148 tests and 12 existing
skips**. Forced build passes six tasks; isolation passes. Earlier full checks fail on fixture lint
issues; two relocation imports and a count script's assumed package count are corrected. Failed
preparations remain recorded. Assertions are not weakened and interrupted runs are not called green.

Both complete reports are read without truncation. Before Original resumes, every **3,548 actual
physical entry**, all 1,118 source pins and pre-runtime Original receipt rows per Own, all 79 literal
links/manifests and 11 Own targets, bootstrap bytes and every recorded metadata/hash field are
independently audited. Both final inventories match exactly. Sealed Own trees are never executed,
edited, cleaned or resealed by Parent; only nofollow static reads and inert copies are used.

| Reviewer | Entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Contracts | 1,748 | 17,638 / `f080f01de6cb3d3538eee30ef61e5bb859bd391318f2e34589c736beb763a033` | 712,765 / `0f49b3c97bd77b49101dd010523cd746a3f0dfd22ade16e38e5d36dd754a53eb` |
| Runtime | 1,800 | 13,759 / `d93f212cd3b736fdb7172deb37896fd6a0e09cc36c919cda436f7b9510d51281` | 658,546 / `560d17efb4bc02d5eb4bac69537fd6b50e55b076c5623e713bb2fd695b6ccc78` |

Reports separately name command/read/change/preparation/proof/runtime observation registers. Early
Apple startup refusals, static-read environment gaps, reconstructed chronology, overwritten initial
Contracts validation and Runtime's unmeasured full-review elapsed time remain qualified. Later clean
launches do not retrospectively certify those entries. Hashes and isolation probes do not establish
semantic completeness or a kernel sandbox. The prior R10 seal discrepancy remains historical and
qualified; it is not reused as a clean certificate. No automatic execution-risk rejection occurs.

Fresh complete round 12 remains required. Group 2a, remaining systematic groups, Proposed ADR-0102
approval, Steps 7–8/12, Sonar, W7 and draft PR #90 remain open. All seven authorised paid-generation
slots remain exhausted; no further paid call is authorised.
