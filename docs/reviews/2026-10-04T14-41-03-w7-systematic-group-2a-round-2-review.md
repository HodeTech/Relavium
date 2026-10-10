# W7 systematic group 2a, round 2

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round2_runtime`, `/root/w7_group2a_round2_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..bf8aab08`, all 11 changed paths
- **Outcome**: Changes requested; one inherited High corrected, fresh complete round 3 required

## Finding and correction

Both independent reviewers verify the successful-tool observer correction, then reproduce an
adjacent inherited failure-path defect. The two notifications in
[toolFailureMessage](../../packages/core/src/engine/agent-turn.ts) still invoke the observer directly.
After a provider engages, invalid tool arguments or a recoverable host read failure enters this
path. A throwing observer bypasses EA2, loses real terminal usage and returns the engaged hard-cap
slot. With `maxTurns: 1`, a second send reads another credential and calls the provider. An EA7
mid-turn abort followed by an observer throw also loses engagement and usage. This is inherited
at the pre-group base, rather than introduced by the successful-tool repair.

The contracts reviewer independently crosses both failed notifications, both registry failures
and ordinary/EA7-aborting callbacks: eight failures. The runtime reviewer uses four actual-session
cases, independently confirms the pre-group baseline and reaches the same two-site repair.
Changing only those notifications to the existing fixed-message, nonretryable, cancel-aware
boundary restores billed usage and refuses the second send. Each restores exact source bytes
and reproduces the original failures. The narrow registry dispatch catch stays narrow; restoring
the old broad catch would revive the structural-result defect.

Parent correction `41a3ef9a` applies that boundary and expands the
[permanent actual-session suite](../../packages/core/src/engine/session-tool-observer.test.ts).
Eight new regressions fail on Original before the production repair, alongside eight passing
controls. After repair, the root suite passes all 16: successful read/effect observer failures,
cancellation, invalid arguments/read failures, EA7 abort and genuine model correction when
observers succeed. Private observer and host causes do not enter public events. No later tool,
provider or credential call is permitted after the failed engaged turn.

## Coverage and limits

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Both examine the complete
initial repair, first-round correction, added tests, documentation and prior reports. Permanent
focused tests pass; independently designed controls also verify accumulated multi-round usage,
zero-use engagement, settled effect identities, native Map/Set/undefined/custom-serializer
results, fatal cap refusal before admission or keys, and actual approved retry/fallback.
The contracts stale-cap control correctly refuses an altered frozen quote before credentials;
restoring its original cap permits the expected three attempts. Its first contrary oracle is
retained as a reviewer mistake, not a product defect.

Exact restored runtime HEAD: 12 files, **542 passing / four failing** tests; its two-site diagnostic
variant passes 546. Exact restored contracts HEAD: eight files, **276 passing / eight failing**;
its isolated session variant passes 21. The failures are this High. Neither diagnostic variant
is final acceptance. Both strict checks pass. Setup, fixture, search, truncated-read recoveries,
negative controls and seal-validator mistakes remain in their full reports. Historical ADR
metadata coverage and executed older tests are explicitly distinguished from full semantic reads.
Neither review claims whole-root CI, live SDK/provider acceptance or the separate ownership fix.

## Isolation and integrity

Each fresh physical Own pins 1,096 source files, 79 individually named dependency links/manifests
and 11 canonical internal targets. Main and every test worker deny credentials/native keyring
and live networking, resolve this Own, and start after five ordered fresh package builds and a
main proof. Local data-WASM decoding permits no live socket. Every runtime command, build trace,
worker proof and causal restoration remains inventoried.

After both full releases and complete report reads, the parent verifies **every one of 3,611
sealed records**, every source pin, literal dependency target/manifest and canonical internal
target against unchanged `bf8aab08`. The sealed roots are neither executed nor mutated. Original
freeze ends only after both checks pass. A parent sample-schema `kind` assumption fails before
verification; the corrected validator computes every released field and fully passes.

| Reviewer | Sealed records | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,794 | 25,192 / `4fcd250d82228036c4872002ad079e160ec526987977e55ab084722664af1b74` | 373,862 / `9744f33c1e5f7b5061e2bc1259199570aa5185572e6e3dfd2f8ef9ad94925841` |
| Contracts | 1,817 | 37,363 / `64280913330b5feb57ef955c0dfe50cd8a46f04bfaae8f710d7c90fec150ae4c` | 380,123 / `e439f2d1d4460d876d66c5109df23912290bf4b1f0da214edc6f3a0737eb847d` |

## Follow-ups

Parent forced lint/typecheck/test passes all 23 tasks: 330 files, 7,579 passing tests, 12 skips.
Forced build passes six tasks; standards and diff checks pass. An earlier parent private fixture
uses the wrong limits property, corrected before its meaningful baseline; a nonexistent test
filter and older Parent failover fixture are not counted as current Original acceptance.
These checks support the repair; fresh complete round 3 remains required before group closure.

No live call occurs. [Proposed ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
requires maintainer approval before dependent implementation. Ownership, remaining systematic
groups, Steps 7–8, whole Step 12, Sonar and PR acceptance remain open.
