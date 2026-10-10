# Review: W7 consolidated host closure, cumulative round 4

- Date: 2026-10-10
- Type: Code + Security
- Reviewer(s): @codex (`host_closure_r4_authority`, `host_closure_r4_lifecycle`), plus Parent confirmation.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through `62a08ccc262f28c0a7ebd49d2aa74b1f41b781a5`, 125 paths / 362 literal hunks.
- Outcome: changes required for one confirmed High. Parent correction requires fresh complete independent review.

## Finding and correction

Lifecycle independently discovers that public stream `return()` and `throw()` skip the
underlying generator exit when immediate invocation retirement throws. Caller listener
removal seals/aborts the scope, but a yielded provider iterator never receives its cleanup
request; cooperative work and host departure remain owed indefinitely. Authority identifies
the adjacent ordering risk independently in source and corroborates the runtime finding after
disclosure. Parent separately reproduces it. The direct wrapper, fallback chain and installed
OpenAI SDK adapter with in-memory SSE all reproduce closed=0/pending=1 against normal
closed=1/pending=0 controls. A second explicit return repairs the original witness. No network,
credential, provider call or dependency installation occurs.

Parent always forwards generator exit after synchronous retirement, preserving an established
consumer throw over secondary cleanup and keeping a standalone return retirement fault loud.
Actual held cleanup remains joined. Twelve permanent cases cover public chain return/throw
and direct original-error identity, paired normal/faulting detach and quiet/held close. They
require cleanup to begin on the first exit call and acknowledgement to await actual work.
The [provider seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline)
remains the canonical contract; no accepted policy or wire behaviour changes.

## Evidence and limits

Both fresh reviewers read every cumulative production, test and documentation hunk plus
adjacent continuations. Parent reads both complete reports and all assessment rows, validates
exact path/content/diff/hunk identities and unchanged tracked files, HEAD, logical index and
clean status before releasing the freeze. Ignored build output and dependency/Git internals
are outside that comparison. No acceptance is inherited from prior scoped reviews.

Original reviewer probes exit 0 as defect observations, not product passes. Lifecycle retains
its first shared throw fixture's ordinary missing-throw TypeError and gives it no original-error
proof credit; its refined matrix supplies the valid direct/chain witness without claiming
native private-cause identity. The original Parent regression draft contains an incorrect
raw-promise identity expectation (the parent owns the aggregate) and two unhandled assertion
failures; these intermediate failures remain retained and receive no acceptance credit.
The corrected regression negative run fails exactly six fault cases and passes sixty existing
or normal controls, with no unhandled error. The same sixty-six cases pass after the correction.
Initial root CI catches unsafe access through the test's default IteratorResult return type;
Parent narrows an unknown return through `done: false`. Corrected root CI passes, including
lint/typecheck/tests/build/format, fences and all three smoke harnesses. Full enforced coverage
passes 443 files / 9,364 cases plus 11 skips. Parent reruns the twelve-row shared/chain/native
matrix after the installed build: every actual close starts once and pending work reaches zero;
consumer throw identity remains primary in the qualified shared/chain witnesses. These are
Parent results, not reviewer execution.

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-host-closure-20261010/round-4`.
Authority report/map SHA-256:
`05a4a80a23ce06cbf90c9fd2a78886fe6098a4f19e6caca98351ba2e9378e662` /
`b86e2f4539b4af66311e759f6ba35098a42c0462d79f642dd8ea76ea2c7ef778`.
Lifecycle report/map SHA-256:
`397ca63c8433a8d7c463f72f73f5198e0350d7cd5977d1089cf58e2c0af04316` /
`b00ded17e42d0f71dd04fe06c2e380d996b474e529374c006c86702867447f0d`.
Original command receipts/logs and Parent freeze-release audit bind these results.

## Remaining work

Two fresh complete clean review rounds, Step 8 compaction/recovery and final whole-wave
Step 12 remain required. All six W7 items remain open (41/51 closed); PR #90 remains draft.
No maintainer approval, paid call, credential or provider capture is pending.
