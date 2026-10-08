# W7 owned adapter/chain integration — round 1

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_adapter_chain_r1_authority`, `/root/adr0102_adapter_chain_r1_lifecycle`
- **Subject**: `303338d1..dbea0935`, all 18 paths / 69 textual hunks; approved ADR-0102 production adapter/chain increment
- **Outcome**: Changes requested; verified CI finding corrected in the accompanying commit, fresh cumulative round 2 required

## Scope and judgment

Both new independent reviewers inspect the complete committed increment, including all 112 new
cases (95 installed-SDK wire and 17 chain cases), changed predecessor cap/refusal tests, the two
core schema expectations, canonical contracts and four append-only ADR notes. Authority uses
`gpt-6-astra` at `xhigh`; lifecycle uses `gpt-6.1-sol` at `xhigh`. Parent reads both full reports,
checks their exact source/restoration inventories and verifies the shared source is clean before
releasing the freeze. One deduplicated required-CI finding is verified; authority rates it High,
lifecycle rates a red required check Blocker under the repository rubric. No further material
correctness/security finding is verified. This record grants no acceptance of the ownership High,
core measured-round reuse, Step 8, ADR-0103 integration or whole W7.

## Verified finding and correction

**High / required-check blocker — `packages/llm/src/adapters/request-ownership-wire.test.ts:921`.**
The two new 12,000-record Gemini generate/stream structural cases exceed Vitest's default five-second
budget on actual CI. Literal `dbea0935` push CI records 11,354 / 11,488 ms, both failures. PR CI
records 5,978 / 5,573 ms, both failures; the Node 22 floor passes generate at 4,686 ms but fails stream
at 5,252 ms. PR CI executes merge `269c6e4` of this head into `fc1b0384`; the separate push log
establishes the literal-head failure. Later coverage, Windows, strict peers and Sonar pass, but
those results cannot override the red required jobs.

Independent phase timing attributes most cost to six deliberate incompatible-receiver exceptions
per ordinary record, repeated on raw capture and the private SDK working copy. The alias assertion
loop is about eight–nine percent of local measured work. A diagnostic-only removal drops capture
from roughly 210–242 ms to 13–18 ms and working/SDK from 186–253 ms to 9–12 ms; it weakens raw
Date/boxed refusal and is restored, never adopted. The traversal is iterative and memoized; the
finding is not evidence of recursive or duplicate-alias expansion.

The correction brands only fresh ordinary records allocated inside the inert-data helper with a
private WeakSet. Native internal-slot probes are skipped only for those exact allocations. JavaScript
cannot attach Date/boxed internal slots to an ordinary record. Prototype, descriptors, metadata,
serializer, key, ancestor-cycle and alias checks still run on every reuse. Raw objects, Map/Set,
proxies and caller-supplied typed roots are not trusted by shape or prototype. Thirteen permanent
controls revalidate seven hostile mutations on generated working records without executing them,
and six raw native brands inserted into generated parents under both ordinary/null prototypes.
Existing raw native-brand controls remain intact.

Only these two deep structural SDK cases receive an explicit 30-second test budget, matching the
existing 20,000-record inert-graph structural control. Their full depth, repeated edges, every alias
and actual HTTP body assertion remain. No global timeout, production size limit, accepted-input
policy or five-second product-latency promise changes. The guarded private trial passes 169 cases
and reduces its two deep cases to 336 / 342 ms locally; this is a candidate measurement, not proof
of remote performance. Corrected-head required CI and fresh full cumulative review remain required.

## Complete reviewed inventory

| Path | Added / deleted | Textual hunks |
| --- | ---: | ---: |
| `docs/decisions/0011-internal-llm-abstraction.md` | 16 / 0 | 1 |
| `docs/decisions/0031-llm-seam-shape-amendment-multimodal-io.md` | 16 / 0 | 1 |
| `docs/decisions/0096-a-request-is-measured-before-it-is-sent.md` | 16 / 0 | 1 |
| `docs/decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md` | 16 / 0 | 1 |
| `docs/reference/contracts/agent-session-spec.md` | 5 / 0 | 1 |
| `docs/reference/shared-core/agent-runner.md` | 6 / 2 | 1 |
| `docs/reference/shared-core/llm-provider-seam.md` | 70 / 4 | 3 |
| `packages/core/src/engine/agent-turn.test.ts` | 8 / 1 | 1 |
| `packages/llm/src/adapters/anthropic.ts` | 42 / 13 | 8 |
| `packages/llm/src/adapters/gemini.ts` | 41 / 10 | 7 |
| `packages/llm/src/adapters/openai.ts` | 56 / 21 | 8 |
| `packages/llm/src/adapters/output-cap-prototype-wire.test.ts` | 19 / 3 | 3 |
| `packages/llm/src/adapters/output-cap-refusal.test.ts` | 46 / 19 | 4 |
| `packages/llm/src/adapters/request-ownership-wire.test.ts` | 1214 / 0 | 1 |
| `packages/llm/src/fallback-chain.ts` | 153 / 39 | 25 |
| `packages/llm/src/fallback-request-ownership.test.ts` | 499 / 0 | 1 |
| `packages/llm/src/index.ts` | 1 / 0 | 1 |
| `packages/llm/src/output-cap.ts` | 23 / 0 | 1 |

## Independent validation and causal evidence

Authority's exact restored archive passes all 46 LLM files plus three core suites: **49 files /
1,777 passed / 11 existing skips**. LLM strict/seam, core strict/purity and changed-file lint pass.
Seven separate removals fail capture memo (2), mutable memo (2), invocation stream capture (1), media
source ownership (2), own prototype-key refusal (32), initial inert payload ownership (8), and
pre-projection cap binding (3). Source bytes for all 18 paths and the unchanged inert helper are
restored exactly. Memo removals select small converter-visible Gemini aliases, avoiding deep
shared-graph amplification.

Lifecycle's pristine complete LLM suite passes **46 files / 1,539 tests / 11 skips**; seven additional
core money/origin suites pass 117 tests. Focused 359-case and surrounding 443-case runs overlap with
those totals and are not added together. Twenty-one independent controls pass strict checking and
runtime after an initial reviewer-fixture type error is corrected. Four separate removals fail
invocation capture (1), media-source copy (2), capture memo (2), and mutable memo (2); exact restoration
is verified before the complete suite. The guarded optimization is tested privately with all 169
selected cases and then restored before the pinned inventory is recorded.

Both reviewers build Shared→LLM→Core solely in external exact-head archives. Lifecycle's attempted
offline install fails for a missing Turbo tarball; installed public dependencies are copied with
private workspace links instead. Installed Turbo 2.11.4 has no bundled docs directory; no Turbo
configuration/command change is made. No live provider, key, network call, remote comment, commit,
branch change or shared source/dist mutation occurs in either review. Offline canned responses prove
installed SDK lowering/HTTP serialization, not provider acceptance, live SSE or invoice accuracy.
Some body controls compare parsed JSON; the eight key-wait mutation controls compare raw HTTP bytes.

Parent's implementation `CI=true pnpm run ci` passes **385 files / 8,826 tests / 12 skips**, all 23
initial tasks, seven build/format tasks and three offline smokes, with unaffected cache hits. That
local evidence predates the later red remote checks and is not substituted for corrected-head CI.
Parent's seven separate isolated removals and exact restoration pass 375 focused cases. Full-report
and machine-inventory evidence are consumed before changes resume; review selection totals overlap.

After correction, parent separately removes generated-record revalidation (13 selected failures)
and all native-brand probes (10 selected failures). Exact restoration of the three changed LLM
files passes **201 cases / four suites**, including both installed-SDK deep paths. These trials layer
the current guarded files onto the previous isolated adapter archive; they are not a full new-head
reconstruction. No shared source is mutated by the causal trials.

The corrected `CI=true pnpm run ci` completes with exit zero: **385 files / 8,839 passed / 12 skips**,
23 initial tasks, seven build/format tasks, strict/seam/purity and all three offline smokes. Eight
initial and five later tasks are cached. An initial run catches a test callback implicitly returning
the library's `any`-typed `Object.setPrototypeOf` result; the callback now has a void block, and the
complete rerun passes. The replay smoke deliberately prints its negative-control worker/evidence
failure messages before all positive receipts; those expected diagnostics are not an ignored CI
failure. Corrected-head remote CI and fresh cumulative review remain outstanding.

## Remaining obligations

A fresh complete cumulative second round must review the original 18 paths, this guarded correction,
its permanent tests and this record/index. Exact first measured/quoted core-round reuse remains a
separate approved increment; the request-ownership High is open. Step 7 is accepted only in its
[recorded scope](2026-10-08T22-30-10-w7-step-7-round-4-review.md). ADR-0103 production departure,
Step 8 atomic compaction/recovery, final Step 12, all six W7 register items and draft PR #90 remain
open. No further credential, provider call or ADR approval is required for these approved increments.
