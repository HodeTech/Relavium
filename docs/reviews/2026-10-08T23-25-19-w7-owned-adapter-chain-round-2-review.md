# W7 owned adapter/chain integration — round 2

- **Type**: Code
- **Date**: 2026-10-08
- **Reviewer(s)**: `/root/adr0102_adapter_chain_r2_authority`, `/root/adr0102_adapter_chain_r2_lifecycle`
- **Subject**: `303338d1..cd8c6502`, all 22 paths / 75 textual hunks; cumulative approved ADR-0102 adapter/chain integration
- **Outcome**: Changes requested; two scoped fixture budgets corrected in the accompanying commit, fresh cumulative round 3 and corrected-head CI required

## Scope and judgment

Two new reviewers read the complete cumulative increment, its surrounding authority/lifecycle paths,
all 112 original new cases, 13 added record guards, changed predecessor controls and canonical docs,
and the full first-round record/index. Authority uses `gpt-6-astra` at `xhigh`; lifecycle uses
`gpt-6.1-sol` at `xhigh`. Parent reads both entire reports, verifies all 22 source hashes and 75-hunk
inventories, and compares all 1,223 tracked files in each exact external archive to pinned Git before
releasing the clean shared freeze. No new scoped production correctness/security finding is verified.
A required-check blocker is deduplicated; Windows is an unresolved advisory observation, rated Medium
by authority and needing confirmation by lifecycle. Neither is misrepresented as a new product flaw.

This review does not accept the current red head, the production request-ownership High, exact core
measured-round reuse, ADR-0103 host integration, Step 8 or whole W7. The reviewed adapter/chain
production behavior is clean within scope, but acceptance waits for corrected-head checks and fresh
cumulative review.

## Verified CI findings and correction

**Blocker — `packages/core/src/engine/agent-turn.test.ts:1154`.** The unchanged parameterized
15,000-level valid argument fixture has a default five-second timeout. PR required CI observes its
object case at 6,613 ms; its array case passes at 446 ms and 2,752 other core cases pass. The failure
is outside this file's changed schema-expectation hunk. Literal-head push required CI passes, which
cannot override the PR required failure. Independent private base/head timing observes the same
object case at about 14 / 206 ms, establishing capture overhead locally without attributing all
remote elapsed time to it. There is no demonstrated recursive failure or loss of the byte/privacy
assertions. The two structural forms receive an explicit 30-second fixture budget, preserving full
15,000 depth, correction, exact argument bytes and provider-ID privacy assertions.

**Medium / unresolved advisory — `apps/cli/src/harness/session-chain.e2e.test.ts:110`.** Literal-head
push Windows observes the unchanged functional fresh/persist/resume/continue/export test at 7,786 ms
against five seconds. This file is outside the reviewed 22-path inventory. All 24 DB files / 522 tests,
the other five selected CLI cases and dedicated performance-budget assertions pass; PR Windows also
passes. These successes do not waive the functional failure. Parent's exact-head private macOS lane
passes six cases and this case takes 35 ms. Fresh open/build/send take 12.27 / 0.84 / 8.50 ms;
resume open/build/send/export take 1.91 / 1.60 / 2.18 / 4.64 ms. Diagnostic edits are restored.
This is neither a Windows reproduction nor evidence that remote product performance is sound.
The functional native-file fixture receives an explicit 30-second budget with every persistence,
resume, request, totals and export assertion retained; separate performance assertions are untouched.
Actual corrected-head Windows verification remains required.

No global timeout, graph-size limit, production policy, input acceptance, test depth or assertion
changes. A separate exact-head private trial passes changed-file ESLint/format, 141 core cases and
all six Windows-lane selected cases after these two budgets are applied, then restores both files.
Neither that trial nor the earlier local full CI substitutes for corrected-head remote CI.

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
| `docs/reviews/2026-10-08T23-02-00-w7-owned-adapter-chain-round-1-review.md` | 130 / 0 | 1 |
| `docs/reviews/README.md` | 3 / 0 | 1 |
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
| `packages/llm/src/inert-data.test.ts` | 70 / 0 | 1 |
| `packages/llm/src/inert-data.ts` | 5 / 1 | 3 |
| `packages/llm/src/output-cap.ts` | 23 / 0 | 1 |

## Independent validation and causal evidence

Authority's exact restored archive passes **68 files / 2,222 permanent tests / 11 existing skips**:
the full LLM suite plus 22 core suites. Eighteen separate independent controls pass typed/runtime
checks after two initial reviewer-fixture type errors are corrected. Cold Shared→LLM→Core builds,
strict/seam/purity and both package lints pass. Nine separate removals fail generated-record
revalidation (13), raw native-brand probes (5 fail / 1 still refused by metadata), capture memo (2),
working memo (2), original prepared-cap binding (4 fail / 2 independently refused), invocation stream
capture (1), media-source ownership (2), prototype-key refusal (32), and initial payload ownership
(8). Some removal failures are later guard refusals rather than actual mutated HTTP sends; the
causal result is qualified accordingly. All source bytes are restored before final cold/full checks.

Lifecycle's final exact archive passes **148 files / 4,305 permanent tests / 11 existing skips**:
46 LLM files / 1,552 passes plus 102 core files / 2,753 passes. Eleven separate independent controls
pass; an initial privately mistyped reviewer fixture is excluded from relied-upon evidence.
Nine separate removals fail invocation stream capture (1), resolver-source copy (2), capture memo (2),
working memo (2), generated-record revalidation (13), raw native probes (10 fail / 2 independently
refused by String metadata), prototype-key refusal (32), initial ownership (8), and original prepared
binding (3 fail / 4 independently refused). Every mutation and the base/head timing experiment are
restored before the final rebuild and complete suites. Strict/seam/purity, both package lints and
engine dependency fence pass.

The reviewers' permanent/control selections overlap and are not added together. Failure counts are
selected causal controls, not new skipped coverage. Both reviewers verify capture before first
stream pull; immutable whole-graph aliases and separate mutable SDK attempts; native 70/90 cap
identity/serializer reuse through retries and heterogeneous fallback; actual endpoint authority;
local fake usage/observer provenance; live abort before key/SDK work; and captured resolver-source
cache behavior without adding a tool-result media resolution path. Raw caller brands remain refused;
only exact helper allocations skip redundant native internal-slot probes, while all generated-record
descriptor/prototype/key/serializer/cycle checks continue.

Both reviews operate only in external exact-head archives with private workspace dependency links and
private caches. No shared source/dist/cache mutation, branch change, commit, credential, network or
live-provider call occurs. Installed-SDK HTTP fixtures prove deterministic lowering and serialization,
not real provider acceptance, live SSE or invoice accuracy. The complete seven changed canonical
ADR/reference documents distinguish this increment from open core/host/session work; no dependency,
platform import, vendor type, event schema or durable request payload is introduced.

## Exact-head status and remaining gates

At `cd8c6502`, PR run 37857605705 fails required CI at the deep core fixture; literal push run
37857599172 passes required CI but fails Windows advisory at the functional fixture. Both coverage
and Node 22 floor lanes, peers and Sonar pass; PR Windows passes. This is not a merge-green head.
The [first-round record](2026-10-08T23-02-00-w7-owned-adapter-chain-round-1-review.md) preserves earlier
SDK stress failures and their guarded correction. Current SDK stress cases pass remotely with the
full depth/alias/HTTP assertions; those earlier failures are not confused with these two fixtures.

Parent's previous `CI=true pnpm run ci` passes **385 files / 8,839 tests / 12 skips**, with unaffected
cache hits, all 23 initial and seven build/format tasks and three offline smokes. That evidence
predates this correction and does not substitute for the corrected checks.

After the two budget edits, parent's complete `CI=true pnpm run ci` exits zero: **385 files /
8,839 passed / 12 skips**, 23 successful initial tasks (12 cached), seven build/format tasks
(five cached), strict/seam/purity, database/tools/dependency checks and all three offline smokes.
All 118 relative links in this record/index resolve and `git diff --check` passes. Expected replay
negative-control diagnostics precede the successful receipts; they are not an ignored error.
Corrected-head remote checks remain outstanding.
A fresh third round must inspect all cumulative production/test/doc changes, these two budget edits,
this record and the index. Exact core round reuse is the next approved increment, followed by
ADR-0103 production host integration and Step 8 atomic compaction/recovery. Step 12, all six W7
register items and draft PR #90 remain open. No paid call or further credential/ADR approval is needed.
