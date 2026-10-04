# W7 systematic group 2a, round 7

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round7_contracts`, `/root/w7_group2a_round7_runtime`; parent `/root`
- **Subject**: `development`, `90a5eee8..4769dbd6`, all 26 changed paths
- **Outcome**: Changes requested; contracts review complete, runtime review incomplete; correction committed, fresh complete round 8 required

## Findings and correction

The complete contracts review verifies one High defect: a successful generated provider call can
be followed by an attempt observer throwing `LlmProviderError`. Core incorrectly classifies that
observer exception as a retryable provider failure. An actual WorkflowEngine with authored retries
makes two paid generations, records two 18-microcent realised rows with cumulative totals 18 and 36,
and publishes the synthetic private observer diagnostic in three public error events. A throwing
nested cause getter can also replace the original observer failure. Genuine provider failures still
require normal classification; suppressing an entire error class would be incorrect.

The incomplete runtime review observes a second family: after completed tools, unguarded budget
`instanceof` inspection replaces a hostile callback throwable. The parent independently reproduces
the cost, token and readiness variants in actual Session/Registry/EffectJournal controls, together
with first-round, ordinary-error and cancellation controls. These observations are actionable
parent-verified evidence, not a completed runtime review or group acceptance.

`dd9d5a7d` records the exact exception escaping the core attempt observer and skips generated provider
classification only for that escape. Later tool-round budget inspection is guarded and preserves the
original throwable when reflection fails. Valid budget refusal behaviour remains intact. Mandatory
realised recording, usage ownership, admission settlement, provider taxonomy and financial policy
are unchanged. Canonical session/LLM contracts and dated ADR-0055/0077 corrections describe the repair.
No whole-request ownership change under Proposed ADR-0102 is implemented.

## Independent evidence and limits

Contracts uses `gpt-6.1-sol`, `xhigh`. Its final narrow causal cycle passes **824 tests** in 17 files;
exact restoration and five fresh builds reproduce **820 passing / 4 failing**. All 802 permanent
cases pass. Seven provenance cases and fifteen independently designed protections exercise actual
turns, WorkflowEngine, Session, Registry, CostTracker, Governor and MoneyDurability. Removing usage
snapshotting or post-lookup cancellation makes the corresponding three independent controls fail.
Forty fresh traced builds and strict private checks pass. Actual worker denial and canonical package
resolution proofs are retained; an accidentally unscoped interrupted preparation is excluded from
acceptance. Pre-audit argv gaps and failed fixture/report preparations are explicitly qualified.

Runtime uses `gpt-6-astra`, `ultra`. Platform risk interruptions prevent a complete review. The parent
stops further experiments and requests administrative restoration, reporting and release only.
Its meaningful baseline has **21 passing / 5 failing** tests; narrow prototypes pass 26 controls,
but no final restored runtime repeat or exhaustive workflow review follows. Final source pins are
restored; its experimental dist/buildinfo artifacts are not restored-build certification. Static
stream-grammar mutation, copied commitment diagnostics and typed budget diagnostic hypotheses remain
unverified considerations for the next complete review, not accepted findings or production claims.

Neither report certifies whole-root CI, current Sonar, SDK measured-request ownership, live captures,
Steps 7–8/12, W7 or PR acceptance. Prior passing scoped reviews do not waive new findings.

## Parent validation

The parent copies inert fixture bytes out of both sealed trees and executes only an unsealed parent
area. Strict compilation passes; 48 independent controls reproduce **9 failing / 39 passing**,
including the actual duplicate generation, doubled realised rows and public synthetic diagnostic.
Permanent Original regressions before correction reproduce **7 failing / 24 passing**, 31 tests.
The final formatted fixtures reproduce the same seven failures against exact pinned `agent-turn.ts`
in the unsealed parent area; its unrelated prepared session projection helper is qualified.
After correction, five fresh ordered parent builds and strict compilation pass; all 79 cases across
the copied independent and permanent fixtures pass, with overlapping cases reported as such. The
actual parent workflow now makes one generation and records one 18-microcent row; public errors are
fixed, internal and non-retryable.

Corrected Original focus passes **200 tests** in four files. Final forced root lint/typecheck/test
passes **23 tasks**, **335 files**, **7,769 tests / 12 skips**; forced build passes six tasks.
Test isolation passes. The first full run finds two new fixture lint errors: an unbound provider
method and an async readiness callback without await. Explicit binding and a returned promise correct
them without suppressions; only the final complete run is whole-root passing evidence.

## Isolation and integrity

Both reviewers fully release their sealed Own trees. The parent reads both entire reports and verifies
**every 4,140 physical entry**, all 1,104 source byte/mode/independent-inode pins per Own, 79 literal
named links and manifests, 11 canonical internal targets and exact bootstraps against unchanged
`4769dbd6` before Original resumes. Contracts' 218 factored register rows and runtime's 83 rows are
losslessly reconstructed and matched to their raw registers. Runtime remains explicitly incomplete.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Contracts | 2,223 | 207,417 / `56a532180fdba0f0bd29bd03b25a713171f5a6cdd4dd0732dd6c3a35f32f2724` | 1,042,296 / `369d84e3ead7a6586e25782f84da7e680cc62d4ef14885bb04b6fa69be78e798` |
| Runtime, incomplete | 1,917 | 46,286 / `71434e1b7545db4011d9c557badc412368b129d44f3f393f6a693af3ba5aea5b` | 593,065 / `c4164921e601de0d7b4fcdab298da78d9b3ca88cb6b320b28d2cf510224b5cc1` |

Only each inventory's self-file is excluded from its entries. Parent verifiers inspect actual
directory/file/link fields and declared digest conventions without executing or modifying sealed
trees. A guessed inventory filename fails before writes; the explicitly named inventory is then
read. A receipt-field spelling mismatch initially prevents freeze release; verified declared fields
correct it before any Original mutation. No failure is silently converted into acceptance.
A document append script writes the two valid ADR notes before refusing a guessed review-index
heading. The actual heading is inspected and the remaining index/status updates complete without
duplicating notes; both Accepted ADR historical prefixes are rechecked against the committed head.

## Disposition

Fresh independent complete round 8 must challenge the whole corrected group. Group 2a remains open,
together with ADR-0102 approval, remaining systematic groups, Steps 7–8/12, current Sonar and PR #90.
The seven authorised live generation slots remain exhausted; no further paid call is authorised.
