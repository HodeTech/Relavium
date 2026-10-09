# Review: W7 MCP transport and protocol lifetimes, round 1

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`mcp_authority_fresh_static`, GPT-6.1 Sol, xhigh;
  `mcp_lifecycle_fresh_static`, GPT-6 Astra, xhigh), plus Parent's separate runtime,
  source, artifact and shared-tree audits.
- Subject: complete cumulative MCP increment, `8e3818b66732add45e13ca0f12d3296e24a01d81`
  through `d2c888f91387dd29f2f23879e9389c284860868f`: 27 paths / 55 textual hunks.
- Outcome: changes required. Four distinct confirmed obligations are corrected below;
  a NEW complete cumulative second round remains required before scoped acceptance.

Both fresh reviewers read every changed path/hunk, new implementation and tests in full,
relevant contracts and installed SDK implementation. Existing large documents were read by
changed hunk and relevant context, not claimed as full historical audits. These are static
reviews; neither reviewer ran tests/native/network probes or implemented corrections.
Parent supplied separate runtime evidence in an outside-workspace private source copy,
with individual dependency links and private outputs/caches.

## Confirmed findings and corrections

| Finding | Evidence and consequence | Correction |
| --- | --- | --- |
| Queued peer reservation never completes | Installed SDK task/schema rejection precedes the registered handler. Cancellation/close suppresses its reply; the unused activation slot keeps host and transport completion pending forever. Both reviewers identify this defect. | Revoke only unused reservations on validated peer cancellation/native close. Keep entered handler/send/raw descendants owed. Match SDK schema/ID rules; check the original aborted signal before looking up a reused peer ID. |
| Synchronous abort plus entry refusal leaves an unobserved guard | `operation()` can abort and throw before the race receives its deadline guard. | Preserve synchronous entry and original refusal; include its rejected operation in the race so both branches are observed. |
| Throwing injected body disposer leaves a read pending | EOF/oversize cleanup marks the body closed before disposal throws; the catch mistakes its own cleanup refusal for independent closure. | Settle this reader with the fixed content-free read error. Pending return/native work remains owed. This is a supported injected-disposer case, not a reproduced Node socket-destroy failure. |
| Mandatory MCP branch coverage fails | Literal-head push coverage and PR synthetic-merge coverage both report 89.03%, below the existing 90% floor. Root `ci` does not run this separate gate. | Add missing SDK refusal/cancellation controls and strengthen native-error/no-close-ACK verification; leave thresholds and included source unchanged. |

Two real Sonar maintainability findings are corrected separately: redundant `void` on a
synchronous PID sample, and excessive response-dispatch complexity. Synchronous helpers
preserve exact raw Promise identity and entry order. Analyzer dispositions remain separate
from these product corrections and runtime acceptance.

Nineteen new permanent cases supplement the original 48: six installed-SDK queued task/schema/
ordinary cases, seven public HTTP cancellation controls, one stale same-ID callback case, two
real-SDK synchronous transfer-abort cases, one deadline regression and two CLI disposer cases.
The existing native-close test additionally proves that active/late errors and fulfilled SDK
close cannot replace positive native close. The increment has 67 new permanent cases;
synthetic retained tails remain distinguished from actual native paths.

## Verification and limits

Original-source fixtures first pass strict TypeScript and lint. The SDK refusal run then has
three semantic failures without a timeout; the deadline/disposer run has two semantic failures
and one unhandled guard rejection. Fixed targeted controls pass. Removing only the pre-lookup
aborted-signal guard, after strict checking and rebuilding MCP, breaks same-ID reuse semantically;
exact source restoration and rebuild restore all 34 cases in its three-file check.

Final private enforced coverage passes 411 files, 9,097 cases and 12 existing skips. MCP reports
96.17% lines and 90.22% branches. A prior run's five CLI fixture failures came from putting
`TMPDIR` beneath the user's home, allowing project discovery to find parent configuration.
The four unchanged files pass all 137 cases under private `/private/tmp`; `HOME` never changes.
Failed runs remain preserved and receive no passing-coverage credit. Strict MCP/CLI checks,
actual MCP/CLI builds and changed-file lint pass.

The restored shared tree also passes actual `CI=true pnpm run ci`: 23 lint/type/test tasks
(16 cached), seven build/format tasks (five cached), database/tool/fence/dependency checks,
actual CLI build and all three offline smokes. Its package totals are the same 411 files /
9,097 passes / 12 skips. This cache-qualified CI run is distinct from the fresh private
mandatory-coverage run; neither certifies final forced whole-wave validation.

Parent physically verifies all 75 and 77 inventory entries, compares all 27 head snapshots
with git bytes, and reads full reports and scope maps. The fresh shared-tree audit records
646,498 entries before and after, zero changes, clean `development` at `d2c888f9`; all checks
precede explicit freeze release. Earlier temporary scratch artifacts disappeared after a
runtime reset and receive no re-audited fresh proof credit. Replacement static reports and
fresh runtime receipts supply this round.

| Artifact | SHA-256 |
| --- | --- |
| Authority report | `5f6cb5ae8f2efc5ac8f8222c923c5ccf514b52119b830dab1b2203272a8c5993` |
| Lifecycle report | `fb993a0f5f2917dc3ed5b0ef7a065960ba54027907c95293cdde1f30e3f567b2` |
| Authority inventory | `c0408f9d0262d75e6aab29594efc41e0fec814d47316198395659616b8bdda4c` |
| Lifecycle inventory | `852489397d048dc23a7d2955743511af25bd2e0155fa1d74dc8b2893dccd69dc` |
| Both shared-tree snapshots | `9cbc78fb3498162e3adc1ad259cedf488e59afdfd1f7ebd102f648a39ab3b990` |
| Final coverage input manifest | `2ba3755a09cc74e967ee812b3c18ab72a11cd227fd9b5a2dbf41db3a72ad0a3e` |
| Final coverage stdout | `4bcd2404a98965723dd198e4141ef4f48ba4ea29f812f2ec9c0d76b290aed337` |
| Shared-tree root CI stdout | `612ade6ebad9d4e4f0f6bc1f61d91f6930efb4e577f55d26123acf0904dc06e4` |

The detailed contract has its single home in
[MCP integration](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes).
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
and [W7](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) retain complete manager
startup/all-actor retirement, custom-provider descendants, final receipt health, parked clocks,
public departure and acknowledged CLI teardown as open work. Step 8, final Step 12 and
whole-wave acceptance remain open. No paid call, credential or new ADR approval is needed.
