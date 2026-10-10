# W7 post-closure systematic review — intake

- **Type**: Code + Security
- **Date**: 2026-10-10
- **Reviewer(s)**: `/root/new_review_core_triage` (gpt-6-astra, xhigh), `/root/new_review_db_cli_triage` and `/root/new_review_tools_triage` (gpt-6.1-sol, xhigh); Parent `/root`
- **Subject**: the maintainer's new PR #90 report at `b7fe32d8`
- **Outcome**: bounded triage; confirmed corrections reopen scoped W7 acceptance

The [previous closing register](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10)
is a point-in-time acceptance. This new report reopens the corrections below. Triage is not final
review credit. Parent implements on development; each increment requires two NEW independent
cumulative review rounds, correction commits, applicable gates and a current draft-PR update.
No provider call, key access, billing change, new dependency or branch switch is needed.

## Execution increments

1. Core: atomic compaction notification/projection, balanced moments, monotonic realized snapshots,
   media cleanup precedence, scheduler failure settlement, and truthful receipt-retirement comments.
2. CLI/DB: deferred opening-checkpoint notice, precise session audit projections, and bounded
   surface/documentation consistency fixes. Preserve validated history and empty checkpoint retries.
3. Tooling/docs: exact replay acceptance inventory, immutable-baseline CI availability, dependency
   provenance/reproduction qualifications, nine additive ADR landings, schema pointer and evidence.

These implement existing accepted guarantees. A genuinely new architectural choice still requires
a separately drafted ADR and maintainer approval; no such choice is needed for the confirmed fixes.

## High/medium dispositions

| Report ID | Verified disposition and action |
| --- | --- |
| H1 | Nine ADRs lack the later closing note. Append landings to 0036/0042/0045/0049/0076/0077/0078/0079/0085; retain their historical open notes. Documentation drift, not evidence of an unimplemented wave. |
| M1 | Both isIdle fast paths are unreachable inside registered writer/actor scopes. Remove them and obsolete pre-publication release claims. ADR-0103 explicitly retains the fence until actual work settles; forcing early release would violate that decision. Inline resume registers before awaiting; idle park rechecks the pause episode. |
| M2 | Reproduced: rejected completion notification leaves the new summary/history installed. Restore prior projection on synchronous sink rejection, preserve spend/cancellation, and close the accepted start once. A void sink cannot promise rollback of external side effects it performs before throwing. |
| M3 | Store persist is explicitly awaited. Two check-phase yields serve queued native SIGINT after synchronous SQLite contention, with real OS-signal tests. Keep this cancellation ordering; it is not a substitute for the store ACK. |
| M4 | Production already acknowledges releaseInput, host departure and primary completion before finalize. The optional finalizer callback is redundant, not a missing production safety barrier. |
| M5 | Shared disposal deliberately attempts all cleanup then throws; document that contract. Separate media submission/poll callers must preserve an established primary refusal/failure over a secondary cleanup fault. Cleanup-only faults remain observable. Text chain already preserves precedence. |
| M6 | Reproduced decreasing snapshot reopens headroom. Merge finite nonnegative safe integers monotonically, retaining admitted settlement. NaN poisons diagnostics but does not bypass fail-policy comparison; normal shipping folds are increasing. |
| M7 | Full parsing cost is real and explicitly accepted. SQL-only streaming skips previously hid a real pause and invented a terminal. Keep discriminator/schema/identity validation before exclusion. See [Group 4 round 4](2026-10-07T09-10-29-w7-systematic-group-4-round-4-review.md). |
| M8 | Reject only-if-rows-changed checkpoint: a previously deferred clear can have zero matching rows next time while sensitive WAL bytes remain. Independent native SQLite control confirms empty retry removes those bytes. |
| M9 | Confirmed: CLI drops the migration checkpoint disposition. Emit the existing fixed deferred-erasure warning without changing stdout, rejecting a logically successful open, or exposing driver/content data. |
| M10 | Confirmed inventory gap: predecessor loops whatever producer supplies. Require the exact twelve unique label/cut pairs, matching completed refusal results, and two named positive controls; test omissions and duplicates. |
| M11 | Source/lockfile are Git-anchored; captured portable dependency bytes/graph are digest-pinned reviewed evidence. Lock-key membership does not attest registry-tarball origin. Document this boundary without refreezing or pretending a tarball hash equals extracted-file hashes. |
| M12 | Current development supplies the baseline; main does not. Explicit pinned-SHA availability setup belongs in CI, outside the offline harness, with a clear missing-object diagnosis and server-retention qualification. |
| M13 | After-turn preparation is deliberately best-effort so optional metadata cannot reject an already completed turn. Clarify this broad boundary; no new durable event or failed-turn rewrite follows from the observation. |

## Low dispositions

The submitted lows have no numeric IDs; the labels below make every reference traceable.

| Label | Disposition |
| --- | --- |
| Core C1: running/gapped primary | ADR-0103's later gap correction refuses a primary that cannot deliver advancement. Keep fail-closed; the running result-table row does not authorize a missing cursor. |
| Core C2: scheduler rejection | Reproduced one-shot skip-publication clock fault strands settlement until external cancellation. Registry observes rejection but supplies no semantic failure. Add a bounded settlement backstop preserving prior failure/cancel precedence. |
| Core C3: opened before start sink | Reproduced orphan failed moment after rejected start. Open only after synchronous start acceptance. |
| Core C4: summary wrapper floor | Refuted: buildTurnMessages adds opening/closing prose before the prepared request is measured. |
| Core C5: mixed-window label | Correct policy, ambiguous nothing_to_compact label. Clarify its no-effective-automatic-work meaning; do not invent capacity or add a new result API. |
| Core C6: inline lease test | Keep real behavioral coverage, correct obsolete mechanism claims, and assert retained exact fence/acknowledged eventual release. |
| LLM1: SDK apostrophe | Correct comment typo. |
| LLM2: optional system | EstimateTokensInput requires system:string; admitted callers normalize optional LlmRequest.system. Invalid outside-contract JS input does not establish an admitted TypeError. |
| LLM3: overflow refusal assertions | Strengthen safe HTTP error-message/commitment/usage assertions; keep native overflow-stop actual usage distinct. |
| MCP1: constructor TDZ | Pinned SDK constructors only retain options; start occurs after owner assignment. No current TDZ established. Do not introduce partially initialized owners for a hypothetical SDK change. |
| MCP2: base signal | SDK already passes its base controller in init.signal and aborts it on close; lane-specific signals are additional authority. Asymmetry alone establishes no missing cancellation. |
| CLI1: optional context catch | Deliberately degrades optional metadata to unknown. Add an explanatory comment. |
| CLI2: misplaced JSDoc | Move comments immediately above their intended properties. |
| CLI3: status gate array | Unconditional pendingBudgetGates is the documented stable machine contract, including empty arrays. |
| CLI4: policy-refused strings | Current producers are fixed literals; sanitize at the display boundary for consistency. |
| CLI5: shadowed delivery | Rename the warning-local value; no behavior change. |
| CLI6: duplicate disclosure | Production reconciliation handles its own failures and resolves. No normal duplicate-then-reject path established; retain unexpected-hook fallback. |
| CLI7: credential-less fallback | Existing optional credential semantics are explicitly tested. A required-vs-optional credential policy is a separate contract choice; no leak/grant widening established. No policy reversal is required by this low allegation. |
| CLI8: timeout allocation | Native timeout is unref'd and weakly held; fixed fifteen-minute strong retention was not established. Clearing on headers would remove the owed streaming-body backstop. |
| DB1: audit result projection | Session readers suppress before JSON parsing but still SELECT legacy result bytes. Use metadata-only session projections; retain run replay. |
| DB2: dist-absent e2e skip | Required Turbo DB test owns its build. Tighten explicitly requested integration execution to fail clearly without dist; preserve required build ordering. |
| DB3: legacy floor/disclosure join | Different purposes: conservative identity floor vs structurally proven completed exchange. Identical classifiers can lower the floor and reuse identities. |
| DB4: unknown PRAGMA response | Fail-closed is intentional and tested; unknown counters cannot certify physical erasure. |
| DB5: run sweep checkpoint | Run logical deletion has no session forensic-erasure promise. Do not conflate SQL removal with physical erasure or checkpoint inside an arbitrary transaction. |
| SH1: internal eventType controls | Surface sanitization already covers human/JSON errors and verbose stacks. No unsafe shipping print sink established; preserve one display boundary. |
| SH2: partial companions | Missing historical amount/deadline compatibility is deliberate. Display-only duplicate fields do not change authority; clarify conflict fields rather than compare whole events including sequence/time. |
| SH3: nonfinite timer input | Authored schemas reject it; direct helper robustness gap is real. Refuse nonfinite input before arming, preserving finite negative/long-hop behavior. |
| SH4: colocated tests | No missing module/behavior named; reducer and deadline have colocated suites plus integration coverage. No implementation-mirror tests merely to satisfy a filename count. |
| T1: Turbo schema | Point CLI schema at the installed 2.11.4 schema; no dependency/task change. |
| T2: frozen packaging recipe | Document ordering/formats and read-only validation. Preserve original bytes; do not claim byte-identical regeneration without demonstrating it. |
| S1: historical scope | Published docs: subject lacks scope. Record historical exception; use compliant future subjects, no history rewrite. |
| S2: missing Refs count | Standard allows inline ADR references; bulk missing-trailer count overstates violations. Record genuine historical gaps without rewrite; new implementation commits carry references. |
| S3: Codex co-author | Canonical standard is Claude-only while actual assistant is Codex. Permit truthful tool identity; never falsify co-authorship or rewrite published commits. |
| E1: external causal harness | Real scoped evidence, not a permanent CI harness or historical whole-source build. Preserve qualification and provide a reproducible bounded procedure where practical. |
| E2: gate/head difference | No production change between coverage b68188fe and b7fe32d8; later test watchdogs/comments/docs are separately qualified. New fixes require new gates. |
| E3: eleven skips | Retained complete log proves eleven existing capability/key-gated LLM skips, distinct from remote CLI platform skips. Count alone establishes no missing required test. |

## Evidence bounds

Core triage ran seven exact-source probes, including the reported compaction, start-moment,
media cleanup, governor and scheduler schedules. DB triage ran a separate native SQLite substrate
control, not a production TypeScript suite. Tooling triage was static and inspected attributed
existing receipts. All three released the clean b7fe32d8 tree before implementation. These scopes
are bounded; no reviewer claims a fresh literal line audit of all 661 PR files or all 103 ADRs.

## First increment, author verification

Implementation commit `e71710ab` adds twelve permanent cases. Ten focused suites pass all 307
cases. Four exact-file predecessor interventions fail in the expected assertions (six failures);
a separate removal of only projection rollback fails the next-request history assertion. Restored
sources pass. These are scoped interventions, not independent historical builds.

The first root CI attempt fails four new lint issues; they are corrected. The second `pnpm run ci`
exits 0 (23 lint/typecheck/test tasks, build/format and all fences/offline smokes). Shared disposal
documentation is changed with its core callers. Fresh independent review remains required.
