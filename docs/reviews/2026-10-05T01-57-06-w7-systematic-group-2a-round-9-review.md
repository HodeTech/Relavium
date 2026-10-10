# W7 systematic group 2a, round 9

- **Type**: Code
- **Date**: 2026-10-05
- **Reviewer(s)**: `/root/w7_group2a_round9_contracts` (`gpt-6-astra`, `xhigh`), `/root/w7_group2a_round9_runtime` (`gpt-6.1-sol`, `xhigh`); parent `/root`
- **Subject**: `development`, `90a5eee8..06dd5e48`, all 35 changed paths
- **Outcome**: Changes requested; both reviews complete and physically verified; verified corrections require fresh complete round 10

## Verified findings

Contracts reports four High families. A second tool-round readiness/token callback shaped as a
BudgetPauseError loses exact identity and observer origin; actual Session/Workflow callers read its
private budget diagnostic. The reproduction has two provider calls and one real tool; it does not
claim a false gate or retry on this path. Compaction separately exposes a typed cost callback's private
message, or replaces an opaque throwable during reflection. Typed delivery versus raw rejection is
part of the existing contract and must survive correction.

Contracts also verifies generated content/raw/stop-reason getters escaping after paid observation:
actual workflows retry, with two fully-priced 12-microcent rows and private diagnostics. Runtime
independently reproduces the content getter with two fully-priced 18-microcent rows. Its raw and stop
reason cases are explicitly adjacent unexecuted hypotheses; Contracts supplies their independent
execution. Missing-runtime-usage variants have no certified price/row claim. Both reviewers verify
observer-origin LedgerDurabilityError/CommitmentDurabilityError nominating a false failure writer,
with one actual paid row belonging to the true node. No lost or duplicate row is claimed for that
family.

Runtime rates its two authority/retry families Blocker and writer attribution High. Pricing overlay
lookup/output-rate getters and provider causes shaped as AgentTurnError or BudgetPauseError are
unwrapped solely by class and acquire retry/gate authority. Failed pricing retains known 7/11 token
quantities, but the realized rows are **unpriced zero placeholders**, not certified actual charges.
Provider-cause variants have no certified usage/realized-row claim. Genuine pre-egress and actual
shared ledger failure controls preserve zero-egress refusal and the actual earlier writer. These
findings overlap the Contracts result/writer families; failing dimensions are not counted as unique
bugs or live charges.

## Corrections and permanent controls

`1b23ff82` commits guarded generated projection; `22d9df14` commits core admission/observer provenance.

Core retains the exact error escaping the current pre-attempt boundary; only that provenance permits
budget/money cause unwrapping. External observer money classes cannot nominate a writer. Later tool
rounds preserve both observer and internal attempt escape. Compaction consumes the captured outcome
and tracks start/finish notifications locally, preserving classified delivery, raw/opaque rejection,
private-safe presentation and state cleanup. The parent independently verifies an additional host
clock/backoff route to the same authority confusion and tracks those callbacks as external origin;
this additional route is not attributed to the sealed reviewers.

Generated content/stop reason/raw properties are read once into a plain result within guarded
post-response projection, before attempt notification. A projection failure emits one failed record
with any already folded price; pricing failure instead preserves valid quantities as unpriced.
Whole content/request deep ownership is not claimed. Canonical contracts and dated append-only
Accepted ADR-0055/0077/0082 corrections describe the mechanism without changing financial policy.

The [39 turn/compaction/result controls](../../packages/core/src/engine/agent-turn-origin-boundary.test.ts)
promote Contracts' 30 cases and add nine compaction lifecycle cases. The
[35 actual accounting-cause controls](../../packages/core/src/engine/accounting-cause-provenance.test.ts)
retain Runtime's assertions, with source/seam imports adapted and filesystem evidence logging removed.
The [12 held-terminal controls](../../packages/llm/src/held-terminal-controls.test.ts) retain its zero,
cache/media, teardown and duplicate-terminal cases. Existing observer tests expand from 12 to 40,
with 20 clock/backoff class variants, four genuine retry controls and four actual money-class workflow
controls. Tool-round tests expand from 24 to 27; turn tests add two genuine generated pre-egress
controls. The old provider-generated BudgetExceeded cause test is corrected to expect fixed internal
refusal, with true admission fail/pause controls proving zero provider calls. The existing unsafe
actual-cost/conservative-settlement suite remains unchanged.

## Independent evidence and parent checks

Contracts' permanent baseline passes 914 checks in 21 files; its private fixture reproduces 14 failures
and 16 passes. Runtime's final exact restored baseline passes 926 checks in 22 files, including its
12 held-terminal controls; its private defect fixture reproduces 20 failures and 15 passes. The
Runtime causal intervention makes all 35 defect controls pass, but its broader initial run exposes an
opaque pre-hook identity regression and the old unsafe provider-cause expectation. The former is
corrected experimentally; the latter test is not edited in Own. These source interventions are causal
evidence, not shipping acceptance. Both reviewers restore all original source before sealing.

The unsealed parent passes 555 checks in nine focused files, then 465 checks in seven overlapping
files after restoring an original-production baseline experiment. That experiment substitutes only
four production files from unchanged `06dd5e48` into the otherwise staged Parent graph: 49 failure
dimensions reproduce the defects; two additional failures are updated malformed missing-usage/raw
read expectations and are **not** original product bugs. It is not a complete exact-Root graph baseline.
Exact inert copies of Runtime's two fixtures pass all 47 checks; their promoted permanent versions
also pass all 47, and strict compilation includes the new files explicitly. Parent builds are ordered
incremental builds, not claimed clean fresh certification. One new control initially expects the wrong
provider code; its corrected assertion retains real retry counts and origin. A promotion preparation
assertion mistakes a `node:retrying` literal for a Node import, and the nonexistent-file follow-up fails;
those preparations are retained and excluded from passing evidence.

Final forced Original lint/typecheck/test passes **23 tasks, 339 files, 7,950 tests / 12 existing skips**.
The first run fails only the new async test generators' missing await lint requirement; explicit async
fixture scheduling fixes it without suppression. Its cancelled concurrent tasks do not certify a full
run. Forced Original build passes six tasks; test isolation passes.

## Integrity and scope

The parent reads both complete reports without truncation and independently recomputes every
**3,784 physical entry**, all 1,109 source byte/mode/unique-inode/nlink pins per Own, 79 literal named
links/manifests and 11 canonical Own targets, plus exact bootstrap/report/inventory hashes, against
clean unchanged Original `06dd5e48`. Runtime's supplied Original inode receipt also matches every
source inode and is disjoint from Own. Only named dependency targets are followed; dependency trees
are not broadly inventoried. Sealed trees are never executed, modified or cleaned. Original stays
frozen until both complete verification receipts exist.

| Reviewer | Entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Contracts | 1,880 | 11,548 / `edf436d2a28b6e729478d67ed8e9c8dfb71e345471913bb16914dbd0810e9582` | 692,114 / `4d6d29e1dfc80986aff4cdf83a7f59d30937a15a588142174b53831e7cf7a01d` |
| Runtime | 1,904 | 11,920 / `f890fac4f308b9f9b88b74f3ed6a9d9e8c8e89df0c94d97a78862bd0aa42f32f` | 707,291 / `e041899f8984da691411d69ec0b940acc8acb9276d0c9cc3e5edd538f7e974a5` |

The complete reports name separately retained command/read/change/runtime registers, proof logs,
preparation failures and causal artifacts. All their physical bytes are hash-verified; no full semantic
review of every unchanged historical document or every register payload is claimed. Contracts'
initial builds precede Original inode comparison; Apple Python shim outer environment qualification
is retained, with later actual-driver assertions and fresh certification. Runtime retains initial
nonruntime pwd without env-i, its refused shim outer-environment assertion, nonexistent alternate
interpreter, type/module/media/oracle preparations and final exact driver assertions. Clean later
children do not certify earlier startup gaps retroactively. Main and actual workers independently
prove credential/network denials and 11 canonical resolutions before source imports. No automatic
execution-risk rejection occurs. Missing earlier timestamps/environment observations are not invented.

## Disposition

Fresh complete round 10 must review the whole corrected group and callers. Group 2a, remaining
systematic groups, Proposed ADR-0102 approval, Steps 7–8/12, current Sonar, W7 and PR #90 remain open.
All seven authorised live generation slots remain exhausted; no additional paid call is authorised.
