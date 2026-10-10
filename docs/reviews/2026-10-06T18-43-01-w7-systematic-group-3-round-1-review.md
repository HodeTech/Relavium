# W7 systematic group 3, round 1 — decision and pause acknowledgement races

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_round1_contracts`, `/root/w7_group3_round1_runtime`; parent `/root`
- **Subject**: complete operator correction `ad825fb1..4301b8ad`, 28 changed paths
- **Outcome**: Changes requested; two independently verified High findings corrected, fresh complete round 2 required

## Findings and corrections

Contracts (`gpt-6-astra / xhigh`) reproduces a late refused deadline approval overriding a
synchronously claimed human decision while the decided authorization is already persisted and its
acknowledgement is held. The still-pending gate row does not confer decision ownership. Both human
approval and rejection lose their actual outcome to `run_timeout`. `a78f859a` makes the timeout
failure backstop respect the existing claim. Six actual-runner controls cover both races, genuine
uncontended timeout, already-acknowledged decisions and cancellation. Removing that check breaks
the two held-acknowledgement controls.

Runtime (`gpt-6.1-sol / xhigh`) reproduces the actual `runCommand` closing native SQLite after a
refused inline approval while the aggregate pause append is outstanding. The write then fails with
"The database connection is not open"; replay ends at the gate companion and the lease remains
until its TTL. `7ceae889` stops further prompts and drains the real ordered stream to the acknowledged
aggregate pause or competing terminal before resources close. The permanent native regression
holds the real append with an explicit latch, observes actual refusal before releasing it, and
asserts database lifetime, command completion, replay and lease release. Approval, rejection,
cancellation and ordinary human gates remain genuine controls. Existing driver tests now require
the actual aggregate pause instead of forbidding its delivery.

The two reviewers independently exercise actual CLI/runner/quote/native-store paths rather than
only pricing helpers. Early rate comparison remains refusal-only and write-free; the full engine
still rejects changed candidate eligibility after an early match. Matching prices confer no
approval. Excluded candidate projections, scalar authority, resolved ordinary-gate refusal,
resource construction order, notice pruning and diagnostic sink failures remain in scope.

## Verification

Contracts finishes five fresh ordered package builds and strict fixture compilation. Its final
21-file run has **695 passing tests and two finding failures**: 686 permanent cases and nine of
eleven independent cases pass. Runtime also finishes five fresh builds and strict compilation;
its final 20-file run has **692 passing tests and two finding failures**: 686 permanent cases and
six of eight independent cases pass. These are pre-correction findings, not acceptance of the fixes.
The narrow diagnostic mutants pass all eleven and eight fresh cases respectively.

The parent promotes all 19 independent cases as three permanent regression suites. Against the
old Original production, the combined 24-case set has **17 passes and seven expected failures**:
the two claim races, two native premature-close cases and three existing actual-pause expectations.
The corrected production passes **all 24**. Forced Original lint/typecheck/test subsequently passes
**23 tasks, 362 files, 8,239 tests and 12 existing skips**. Six forced build tasks, test isolation,
format and `git diff --check` pass. Canonical command/execution text and an append-only ADR-0097
note describe the existing barriers; no new financial policy, error code or durable schema is added.

The first full check fails only on a new fixture's unnecessary `async` prompt callback. Returning
its actual resolved promises removes that lint failure without a dummy await or suppression; the
corrected full check passes. Earlier prepared-parent pool and fixture assertions, and naive parent
Markdown/comment screens, remain failed preparation attempts rather than retroactive passes.

## Evidence integrity and qualifications

Before Original runtime or changes resume, the parent fully reads both reports, every changed-path
disposition and the complete independent fixtures/proofs. Every actual recorded nofollow metadata,
content, child-list, link/manifest, inventory self, bootstrap pin and pre-runtime Original identity
field is independently checked. Each Own has **1,139 restored source pins**, 79 literal dependency
links and 11 canonical Own package targets; file identities are unique and disjoint from Original.
Both sealed Own trees remain permanently unexecuted and unmodified after release.

| Own | Inventory rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,779 | 1,780 | `e8aaf551b4b138cb3f32147c8e762ac68e468ba8d79b37e17ad0d66e1dd3f2ef` | `83db36682de33b57f63ad7e886411a48123c090282700029cb5e8a5484835c1e` |
| Runtime | 2,021 | 2,022 | `a4227fd4bf071a5327dede7677cb07ea8ad6b005475b7fc1bfe0b53e408d961c` | `40530696787bdc9ba851afafb30e41ab055f7817f7a310718748836aa69da172` |

All **3,802 actual physical entries** and **362 externally delivered artifact byte/hash tuples**
match. Contracts records five stable metadata fields. Runtime's inventory additionally records
exact Python nanosecond timestamps; optional externally transmitted timestamp numbers were rounded
by JavaScript and are not treated as exact. The byte-pinned inventory's exact integer timestamps
and all five stable external fields are independently verified. No discrepancy is concealed or
fixed by resealing.

Actual mains/workers independently exercise credential/network denials and Own resolutions before
source imports. Runtime exercises CJS/native paths; its ESM denial hook is statically inspected,
not separately runtime-certified. These guards are exercised JavaScript containment, not a kernel
sandbox. Changed production/tests and related inherited assertions are semantically reviewed;
Runtime explicitly does not claim full lexical reading of unrelated large inherited test bodies.
Preparation failures and this scope qualification remain part of the verdict.

Group 3 remains open until fresh complete round 2 accepts the full committed scope. Group 2a's
[qualified round-14 acceptance](2026-10-06T17-49-28-w7-systematic-group-2a-round-14-review.md)
is unchanged. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
remains Proposed and unimplemented. Remaining systematic Groups 4–6, three-of-five live captures,
Steps 7–8, whole Step 12, current Sonar, W7 and draft PR #90 remain open. No provider key read,
live call or additional paid generation occurs.
