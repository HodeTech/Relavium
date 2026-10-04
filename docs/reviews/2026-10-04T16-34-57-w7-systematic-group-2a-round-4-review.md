# W7 systematic group 2a, round 4

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round4_runtime`, `/root/w7_group2a_round4_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..7954e74b`, all 19 changed paths
- **Outcome**: Changes requested; verified accounting corrections committed, fresh complete round 5 required

## Findings and correction

Both fresh reviewers reproduce three inherited accounting defects under the new carrier's broader
promise. Runtime groups the frozen and typed-exception variants as one High family; contracts
separates classified successful flush as another High. They agree on the concrete evidence:

1. A frozen genuine `AgentTurnError` throws a replacement `TypeError` during metadata augmentation,
   preventing the canonical outcome from reaching the session. Known usage becomes zero and an
   engaged hard-cap slot is returned. The public turn API also loses original error identity.
2. Without `preEgress`, readiness flags count a non-skipped attempt record as engagement even when
   credential or local prepared-cap refusal proves the provider never ran. A repaired key cannot
   retry within a session whose `maxTurns` slot was incorrectly consumed.
3. A successful turn counted before flushing loses its known usage, or counts twice, when the flush
   throws a genuine classified exception. Unrelated exception metadata can replace real quantities.

Runtime also verifies a pause-shaped cost callback ignoring the carrier's known usage/engagement.
These typed trusted-port variants do not claim the built-in governor normally throws those classes.
Its initial generic pre-egress error probe separately exposes arbitrary host exception text in a
public normalized error; no actual credential leak is asserted.

Correction `ecf0b209` makes the internal captured outcome independent of exception inspection or
mutation. Public `runAgentTurn` retains best-effort legacy metadata on mutable data properties and
always rethrows the original failure. Session counting and usage selection happen before error-class
presentation: canonical failed accounting consumes its slot once; successful usage outranks later
exception metadata and is not counted again. EA7, terminal cancel and typed money identities retain
their existing handling. A later pause retains earlier provider engagement and usage.

`FallbackChain` now owns explicit `providerInvoked` evidence. Local cap preparation, hooks, key
resolution, cancellation before invocation and deadline setup do not establish invocation. Core
uses that evidence with or without a governor, preserving proven reservation release and unknown-bill
retention. Untyped chain exceptions have a fixed public diagnostic; original causes remain outside
public events, while typed provider/control-flow handling is retained. This corrects existing EA2
and privacy implementation; no new financial policy, runtime dependency or vendor SPI is added.
Canonical session and LLM contracts are updated; ADR-0055 receives an append-only correction.

## Independent evidence and limits

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Both examine the complete
19-path group, not only the latest commit. Restored runtime has **756 passing / 12 failing** tests
across 16 files; all 613 permanent cases pass. Contracts has **621 passing / 7 failing** across
14 files, including the same 613 permanent cases and 15 independent controls. Strict checks pass.
Narrow causal controls correct the respective observed failures and are restored byte-for-byte;
they are evidence, not accepted production implementations.

Actual Session/Registry/EffectJournal controls distinguish unknown usage, explicit zero use,
first provider chunks and observed stops, raw identity, recovered tools and cancellation. Real
Governor/MoneyDurability and actual WorkflowEngine checks verify authoritative cumulative folding,
mandatory realized-row initiation, owner/cause typing and tool suppression. Existing B1/B2/B3,
all four tool notifications, typed local cap refusal, default approved failover and native JSON
controls remain clean. Runtime's two native stack-size workers test native JSON agreement without
claiming one universal stack limit.

No whole-root CI, current Sonar certification, live provider, SDK request-ownership, Steps 7–8/12,
W7 or PR acceptance is supplied by these reviewer runs. Contracts explicitly limits adjacent
hostile descriptors/concurrent sibling races and typed EA7 flush coverage; the parent regression
matrix separately covers the relevant frozen/accessor and typed flush/pause variants.

## Parent validation

Before production correction, three new/extended permanent regression files run on unchanged
Original code: **34 failing / 243 passing**. Twelve new session cases cover frozen genuine
classified errors across ordinary/EA7 and paid/zero use; eight cover success-flush classes and stale
metadata; two cover pause-shaped paid callbacks; four cover key/deadline setup refusals with/without
hooks. Twelve chain cases cover actual generate/stream invocation versus local refusal, and two
public turn cases preserve frozen/accessor error identity. The zero-use generation control has
explicit zero quantities rather than a default nonzero fixture.

After correction the eight-file Original run passes **451 tests**. Forced full root
lint/typecheck/test passes **23 tasks**, **332 files**, **7,665 tests / 12 skips**. Forced build
passes six tasks; test isolation, append-only ADR, added-source architecture and diff checks pass.
Later changes only correct a stale normalizer comment and wrap documentation; no runtime behaviour
changes after the full checks.

Private preparation errors are retained: the initial fixture omitted the third pause constructor
argument and used an invalid timer return type; corrected before the meaningful baseline. Two
local-cap fixture assumptions (native Anthropic zero and authored zero) did not produce refusal;
the final fixture uses a genuine endpoint-mismatched prepared plan. These were incorrect oracles,
not product defects. Parent separate DB/replay prototypes are not shipped or acceptance evidence
for this group. Existing reports remain point-in-time records and are not rewritten.

## Isolation and integrity

Each reviewer independently verifies 1,099 physical source pins, 79 literal dependency links and
manifest hashes, 11 canonical internal targets and its exact bootstrap before execution. Five
ordered fresh package builds and main/worker credential/network denials precede tests. All logs,
variants, private fixtures, fresh distributions and physical directory/file/link records are sealed.
The parent reads both full reports and independently verifies **every 3,524 sealed entry** and all
source/dependency pins against unchanged `7954e74b` before Original resumes. No sealed reviewer
root is executed or mutated. The first parent runtime verifier assumes physical directory size;
its schema is corrected to verify the released compact child-name JSON and separate `lstat_bytes`,
then every entry passes without changing sealed data.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,764 | 42,560 / `4c1211562046596793e951fa2255f2c98e970250817c3ec1bfa36910d84f5706` | 420,293 / `ec3c545e3cd19f96eaab7a086923ea5f8009f2aca5c3187200519f9edddd099e` |
| Contracts | 1,760 | 33,543 / `24d97a68cf639d903b91a840737bcf19ea4adaeadfecf481227532b2297fd7ad` | 463,557 / `061454fdfc075d1ab5d604dcffd882ca4ebd0604b61d1d69b538fc8f43ad4c97` |

## Follow-ups

Fresh complete round 5 is required before group closure. No live call occurs.
[Proposed ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
requires explicit maintainer approval before dependent implementation. Remaining systematic groups,
measured-request ownership, Steps 7–8, whole Step 12, current Sonar and PR acceptance remain open.
The existing-head GitHub check rollup is read separately: required lint/typecheck/test and coverage
are successful at `7954e74b`, while SonarCloud is still failing. This does not certify the new commit.
