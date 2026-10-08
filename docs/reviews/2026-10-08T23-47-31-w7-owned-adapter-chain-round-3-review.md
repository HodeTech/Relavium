# W7 owned adapter/chain integration — round 3

- **Type**: Code
- **Date**: 2026-10-08 (UTC record; reviewers worked on 2026-10-09 Europe/Istanbul)
- **Reviewer(s)**: `/root/adr0102_adapter_chain_r3_authority`, `/root/adr0102_adapter_chain_r3_lifecycle`
- **Subject**: `303338d1..0c3c185b`, all 24 paths / 78 textual hunks; cumulative approved ADR-0102 adapter/chain integration
- **Outcome**: Accepted within the adapter/chain scope; exact core rounds, host departure, Step 8 and whole-wave acceptance remain open

## Scope and parent decision

Two fresh independent reviewers inspect the entire cumulative production/test/doc increment,
including all earlier fixes, both complete review records and the final fixture budgets. Authority
uses `gpt-6-astra` at `xhigh`; lifecycle uses `gpt-6.1-sol` at `xhigh`, as assigned under the
maintainer's model-choice authorization. Neither verified a new scoped material finding.
Parent reads both entire reports, including the full hunk appendices and causal qualifications,
then independently verifies all 24 source hashes/78 hunks against pinned Git. Authority's individual
raw hunk byte hashes and lifecycle's Git blob IDs/header inventory match. All 1,224 tracked files
in each private archive and the shared checkout match the pinned Git bytes; shared status is clean
before this acceptance record releases the source/dist freeze.

This accepts controlled adapter/chain ownership only. The request-ownership High, core's exact
first measured/quoted-round handoff, ADR-0103 production host departure, Step 8 compaction/recovery,
Step 12 and all six W7 register items remain open. Draft PR #90 is unmerged.

## Independent evidence and qualifications

Authority's distinct permanent selection passes **151 files / 4,311 tests / 11 existing skips**:
46 LLM files / 1,552 passes, 102 core files / 2,753 passes and three native-file CLI lane files /
six passes. Fifteen separate strict-passing independent controls pass, including disguised native
root brands, actual SDK retry/failover 70/70/90 cap bodies and cap-only hook privacy. Nine isolated
trials across eight mechanisms are restored in `finally`. Capture/working memo removals change actual
Gemini HTTP bodies; the stronger independent stream removal sends late-mutated text through the
actual OpenAI SDK. The permanent stream negative also hits a later capability guard and alone is
not wrong-wire evidence. Raw probes detect five native brands while boxed String remains refused
by metadata; original-control removal detects three bindings while four independent guards survive.
Generated-record removal drops properties and detects all 13 selected expectations; it is a negative
control, not a proposed performance implementation. Prototype-key removal detects all 32 selected
cases without claiming provider exploitation.

Lifecycle independently passes **385 files / 8,839 tests / 12 existing skips** across Shared, LLM,
Core, CLI, DB and MCP, plus 16 distinct private controls. Eight mechanisms are tested in nine causal
invocations. Its generated revalidation bypass detects five selected forms with eight overlapping
guards surviving; raw-probe removal detects ten cases while two String metadata controls survive.
Original binding detects three with four independent refusals surviving. Capture/working memo
removals change actual installed-SDK bodies. Resolver removal changes actual provider handoff and
later cached URL reuse. Extra stream controls prove changed foreign-provider data and loss of a
retained getter refusal. The same selected identities across mechanisms and repeated pristine/
restored runs are not added as distinct coverage. Selected-out causal tests are deselections.

Both reviewers cold-build private declared workspace graphs and pass strict/seam/purity, package
lint and their stated format/dependency checks. All 95 SDK and 17 chain cases, 13 added guards,
72 predecessor cap cases, 34 refusal cases, retained 15,000-depth core forms and the native-file
CLI lifecycle fixture remain exercised. Caller data stays mutable; one owned graph and one SDK
working graph each preserve aliases, with separate copies per attempt. Cap reconciliation remains
in its single existing authority, endpoint binding remains actual, and no request body becomes
persistent quote/event data. The whole estimator domain is not widened by ownership.

Both archives bind to SHA-256 `968b300e6276b2c869bd474e011d9925ca63956b68a957a41189c7ca2d0dec87`.
Parent verifies every top-level evidence seal: 53 authority artifacts and 84 lifecycle artifacts.
Authority's full report hash is `8efa5349d233f2c76c1e6f53f727fa053a0419d56f4761c634be362ffa5f0557`,
its evidence inventory `fff61a1a7777b26670631b8260c585f80850b414480704e697ab567571a1f04b`.
Lifecycle's full report hash is `2db9caedea285d3c437e92d0df6845e048af11120f0e7b6d8bfd044582805b7c`,
its inventory `1284b75121721904de9cb4c3d4831761dba20be7ef9993e97ef3da816f17b787`.
These are external local evidence artifacts, not newly committed request/provider payloads.

Private workspace links/cache directories avoid shared build outputs/caches; public installed
packages are reused offline through links, not OS-enforced read-only mounts or a fresh dependency
store. Lifecycle separately verifies Git byte/type/executable identity and records extraction
umask's 0664→0644 group-write difference; raw POSIX permissions are not claimed identical.
Fixture/path/type/setup failures remain recorded and excluded from pass evidence. Local SDK
HTTP fixtures prove serialization/normalization, not live acceptance, live SSE, invoice accuracy,
arbitrary SDK compatibility or termination of hostile host code. File-target link audits do not
attest every historical anchor or remote URL. Existing prompt-brand fence residuals remain qualified.

## Complete cumulative inventory

Counts use Git's default three-line context. Each entire path and all hunks were reviewed.

| Path | Added / deleted | Textual hunks |
| --- | ---: | ---: |
| `apps/cli/src/harness/session-chain.e2e.test.ts` | 1 / 1 | 1 |
| `docs/decisions/0011-internal-llm-abstraction.md` | 16 / 0 | 1 |
| `docs/decisions/0031-llm-seam-shape-amendment-multimodal-io.md` | 16 / 0 | 1 |
| `docs/decisions/0096-a-request-is-measured-before-it-is-sent.md` | 16 / 0 | 1 |
| `docs/decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md` | 16 / 0 | 1 |
| `docs/reference/contracts/agent-session-spec.md` | 5 / 0 | 1 |
| `docs/reference/shared-core/agent-runner.md` | 6 / 2 | 1 |
| `docs/reference/shared-core/llm-provider-seam.md` | 70 / 4 | 3 |
| `docs/reviews/2026-10-08T23-02-00-w7-owned-adapter-chain-round-1-review.md` | 130 / 0 | 1 |
| `docs/reviews/2026-10-08T23-25-19-w7-owned-adapter-chain-round-2-review.md` | 141 / 0 | 1 |
| `docs/reviews/README.md` | 6 / 0 | 1 |
| `packages/core/src/engine/agent-turn.test.ts` | 9 / 1 | 2 |
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

## Exact-head CI and history

Parent independently fetches current status and actual job logs; both reviewers inspect those
saved artifacts offline and attribute remote retrieval to Parent. PR run **37859664004** and
literal push run **37859658278** bind to `0c3c185b` and succeed: required CI, coverage, Node 22
floor, Windows and strict peers. Parent additionally verifies Sonar and CodeRabbit success.
Retained array/object cases take 558 / 4,351 ms in PR and 313 / 4,654 ms in push; native Windows
session cases pass at 231 / 201 ms, with all 24 DB files / 522 cases, six selected CLI cases and
headless smoke green. Private macOS observations never substitute for remote Windows.

Parent's exact-head `CI=true pnpm run ci` exits zero: **385 files / 8,839 passed / 12 skips**,
23 successful initial tasks (12 cached), seven build/format tasks (five cached), strict/seam/purity,
database/tools/dependency checks and three offline smokes. Reviewer package totals and parent
wrapper/smoke evidence are separately attributed. No final whole-wave forced validation is claimed.

The [round-1](2026-10-08T23-02-00-w7-owned-adapter-chain-round-1-review.md) SDK stress failures and
[round-2](2026-10-08T23-25-19-w7-owned-adapter-chain-round-2-review.md) required/advisory fixture
failures remain historical. Their scoped 30-second fixture budgets retain every depth, byte,
privacy, persistence, request, totals and export assertion; global/product performance controls
remain unchanged. Current green checks satisfy the gate without waiving those past failures.

Exact core owned-round integration now proceeds automatically, followed by approved ADR-0103
host integration and Step 8. No new ADR approval, credential or paid provider call is needed.
