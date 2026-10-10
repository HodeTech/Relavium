# Review: W7 MCP transport and protocol lifetimes, round 4

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`mcp_authority_r4`, GPT-6.1 Sol, xhigh;
  `mcp_lifecycle_r4`, GPT-6 Astra, xhigh), plus Parent's full source/artifact/freeze
  audits and separate correction checks.
- Subject: complete cumulative MCP increment, `8e3818b66732add45e13ca0f12d3296e24a01d81`
  through `2a4a006901777f42b2a01faff92f38b720a71b17`: 36 paths / 68 textual hunks.
- Outcome: changes required for one Medium; a NEW complete cumulative round 5
  must review the correction before scoped acceptance.

## Confirmed finding and correction

Every HTTP control/reply lane is inserted into its enclosing request's retained controls
set, but completed lanes are never removed while that request remains live. Sequential
valid peer responses therefore accumulate completed transport/controller/scope references.
Authority discovers the defect; Parent independently confirms it, and Lifecycle verifies it
from the frozen source after cross-review. Lifecycle's earlier clean draft is preserved
without acceptance credit. This is source-confirmed reference retention, with no measured
native leak, heap size, GC behaviour or OOM claim.

The correction removes only the exact lane whose `work.done` acknowledges all admitted
raw/body/native-close work. Pending lanes remain retained and eligible for close. A
package-internal read-only count makes reference cardinality testable without changing
the public package index or adding GC-dependent controls.

Seven new permanent local controls cover reply/cancellation sends resolving or rejecting,
held native-close/body descendants, and sequential completed replies while their outer
request remains unresolved. All seven fail semantically against reviewed production plus
only the count getter. Exact-completion pruning passes; deliberately pruning at send
settlement instead fails exactly the two pending-descendant controls. These are controlled
local lifetime/cardinality tests, not installed-native heap/network experiments. The
cumulative increment now adds 77 permanent cases.

## Verification and custody

Both reviewers independently cold-build shared/llm/core/db/mcp, pass strict MCP/CLI checks,
scoped lint and all 17 files / 261 existing cases on identical unchanged private inputs.
CLI proof is source Vitest with rebuilt libraries; neither claims a compiled CLI, root
coverage/CI or whole-W7 acceptance. Original runner receipts, copied inputs and complete
project logs are preserved. Initial administrative display-only reads have explicitly
limited physical capture; later reads do not masquerade as original stdout.

Parent's correction passes focused tests, strict checking/lint, actual MCP build and final
format check. Fresh enforced private coverage passes 412 files / 9,107 cases / 12 existing
skips; MCP lines 96.43%, branches 90.68%, with unchanged thresholds. The initial format
check failed and is preserved before correction. Parent physically verifies all 14 private
correction receipts/logs/original runners and 12,362 copied source/config inputs. Markdown
is outside that private runner's input capture; documentation receives separate checks.

Parent reads both entire reports and synchronized maps, physically checks all 13,278
Authority and 13,471 Lifecycle inventory entries, each review's nine runner receipts and
11,169 copied inputs, all 36 frozen head snapshots and 68 literal hunks. Parent also
independently matches the ten claimed installed SDK/EventSource source copies. Superseded
Lifecycle drafts and all failed administrative attempts remain preserved without proof credit.

Parent rejects Authority's initially unsupported read-only custody claim. A separately sealed
metadata-only correction preserves all 13,281 original files byte-for-byte, including the
original controls, and all 99 links; it protects owned files/directories and records the
original limitation. Parent audits all 21 correction inventory entries and its three controls,
both complete metadata records and every original file again. Lifecycle is separately read-only.
This custody correction changes no source, original report/map/seal content or review verdict.

The complete shared-tree audit compares 646,710 entries, including source, Git, caches,
outputs and dependencies: zero byte/mode/mtime/link changes and clean `development` at
the reviewed head. Explicit freeze release precedes the checked two-file correction
(`37220a95`). Actual development-source `CI=true pnpm run ci` passes, including all
412 test files / 9,107 passing cases / 12 existing skips, build/type/lint/format and
tool/database/fence/dependency checks, actual compiled CLI and all three offline smokes.
Task caching remains enabled; this is scoped proof, not final forced whole-wave acceptance.
New documentation is checked separately after that code-only CI. Markdown is ignored by
the repository's Prettier policy and receives no claimed Prettier validation.

| Artifact | SHA-256 |
| --- | --- |
| Authority report | `6567a0c563675910b609bd9348e584a00a3f285ea38918958009d8173870296c` |
| Lifecycle revised report | `c258fb487273fe3e7afe4d8e1045d9be4959a3d7d64933d2880f8dda41eb7069` |
| Authority original seal | `bc2308c09187a3e70979e60d51976b624173d9d179595873a0dfc80f6ca6fc94` |
| Lifecycle final seal | `c502a761b4a2007cae4ad0646661c5d0bd21d88343b6b35da2f1853fe14c8d4e` |
| Authority custody-correction seal | `510470273cb54f26633d49615910648fc68e94be0cbb27c30c8519545bcc001d` |
| Both complete shared-tree snapshots | `98928b269407423998c8940fa1a821f5824c59bc0d4dd5e35ace5a4753cff307` |
| Corrected private coverage stdout | `964d0af45952c1480e8a71f913c6718c3b14c0d31f10b3f35a231ec646dddfa7` |
| Corrected development-source root CI stdout | `6973f57caadd4db72aeee49240f336499138dab3999997184dd143b736d22cf3` |

The canonical contract remains in
[MCP integration](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes).
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
and [the W7 plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) retain complete
manager startup/all-actor retirement, custom-provider descendants, sticky final receipt
health, parked clocks, public departure and acknowledged CLI teardown as open. Step 8,
final Step 12 and all six W7 register items remain open (41/51 closed). PR #90 remains
draft and unmerged; no further paid call, credential or ADR approval is needed.
