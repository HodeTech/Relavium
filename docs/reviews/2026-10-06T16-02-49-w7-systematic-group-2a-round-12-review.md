# W7 systematic group 2a, round 12 — qualified recovery and corrections

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: retained independent Contracts and Runtime reviews; different report-only recovery agents `/root/w7_r12_contracts_report_recovery` and `/root/w7_r12_runtime_report_recovery`; parent `/root`
- **Subject**: interrupted frozen review `90a5eee8..32386da3`; parent corrections through `99ce3028`
- **Outcome**: Two verified High corrections committed; fresh complete independent round 13 required

## Findings and corrections

Contracts reproduces terminal cancellation during provider resolution on a cold reconstructed
session. Compaction then arms a controller, overwrites cancellation and invokes the provider; a later
send is accepted. Its real schema/resume/event-bus/handle controls show the primary handle already
closed while passive events continue. The trigger is a custom resolver, not a reproduced ordinary CLI
resolver. Cold no-cancel, idle abort and warm memoized-plan contrasts pass. `860bf682` checks terminal
state immediately after plan resolution, before controller setup, preserving idle abort's no-op.

Both retained reviews independently reproduce host pricing rewriting generated text before typed
output ownership. Actual workflow completion stores the replacement while accounting still charges
correctly: Contracts measures seven microcents; Runtime includes cache/media quantities and measures
101. These are synthetic offline measurements. `67bc7a91` captures typed output before host pricing,
but prices already owned valid usage even if output projection fails. A simultaneous pricing failure
stays primary; known cost and one failed attempt remain truthful, with no retry/gate authority from
private error classes. This is bounded result ownership, not Proposed ADR-0102 implementation.

Four permanent files promote 29 independent controls plus two parent projection/pricing contrasts:
[cold plans and generated workflow text](../../packages/core/src/engine/session-cold-plan-and-pricing.test.ts),
[current money barriers, actual settlement and session delivery](../../packages/core/src/engine/pricing-result-accounting.test.ts),
[projection/pricing precedence](../../packages/core/src/engine/generated-pricing-precedence.test.ts), and
[native SQLite session-command privacy](../../apps/cli/src/engine/session-command-journal-privacy.test.ts).
The native control uses public core/db ports, checks absent stored result bytes and refuses the same
committed session identity. `99ce3028` commits that control. No live provider is involved.
Canonical session/seam contracts and dated ADR-0055/0082 notes describe the existing-contract repairs.

## Verification and qualifications

Retained Contracts final restoration passes five fresh builds, strict compilation and 1,031 permanent
tests; its nine novel controls have three expected failures and six passes. Retained Runtime final
restoration passes five fresh builds, strict compilation and 1,319 permanent tests; its 20 novel
controls have one expected failure and 19 passes. Runtime has no retained independent cold-compaction
proof, and its recovery report does not claim one.

The parent runs all 31 promoted controls against the pre-correction Original production sources:
**five fail and 26 pass**. Four failures demonstrate the two product defects; the fifth distinguishes
projection-before-pricing order when pricing itself throws. A fixture deferred callback initially
infers `never`; its explicit `() => void` annotation is corrected and strict Parent compilation then
passes. That type-only preparation failure does not become a claimed prior strict pass.
A naive projection-first repair loses known price on projection failure and fails both additional
controls; the restored candidate passes. Private original fixtures remain inert. Three older controls
are updated for the deliberate read-before-pricing order and strengthened with distinct pricing and
projection identities. Earlier full runs fail on those stale expectations and an unused throwing
generator's lint rule; neither run is called green and no behavioral assertion is removed to hide a defect.

Final forced Original lint/typecheck/test passes **23 tasks, 355 files, 8,179 tests and 12 existing
skips**. Forced build passes six tasks and test isolation passes. These passing checks verify the
corrections; they are not a substitute for fresh complete independent review.

The original reviewers became unavailable before final reports/seals. Different recovery agents
perform static report recovery only; they do not rerun or certify the interrupted reviewers' work.
Both complete recovery reports are fully read, and every **3,534 physical entry**, all 1,127 pins and
pre-runtime Original metadata rows per Own, all 79 literal links/manifests, 11 Own targets, bootstrap
bytes and final inventory fields are independently audited before Original resumes. Both seals match.
Sealed trees are never executed, edited, cleaned or resealed by parent.

| Retained Own | Entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | --- | --- |
| Contracts | 1,767 | `2461ea3479ffb629ae34b7c4208f614503f0ea1dbe1c335e01f3a9cc4d615087` | `7fc39344bba9e64e60fe15fe12f04ceaf666845059cad691cfb4d7680ec96916` |
| Runtime | 1,767 | `0981bee2e04be7ef9f76a13e367c92609afc5345ad6c3d6351bb37f1747e15e5` | `eec5a44d4185531d8f7d6b08cfd28b5b72ffb9651413c1abb30eb8afcb6c2bcd` |

Reports name exact read/command/change/proof/recovery registers. Missing chronology, early entry/read
and materialization gaps, Runtime's five stale helper hashes and unpaired combined-launch proofs remain
explicitly qualified. Restored runs and byte audits do not retroactively establish full semantic
coverage or execution containment. This is a complete recovery of substantiated findings, not a fresh
full-scope acceptance. Fresh complete round 13, remaining systematic groups, ADR-0102 approval,
Steps 7–8/12, Sonar, W7 and draft PR #90 remain open. No additional paid generation is authorized.
