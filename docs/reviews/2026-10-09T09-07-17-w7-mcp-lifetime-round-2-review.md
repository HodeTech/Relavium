# Review: W7 MCP transport and protocol lifetimes, round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`mcp_authority_r2`, GPT-6.1 Sol, xhigh;
  `mcp_lifetime_r2`, GPT-6 Astra, xhigh), plus Parent's full artifact, source,
  shared-tree and separate correction/runtime checks.
- Subject: complete cumulative MCP increment, `8e3818b66732add45e13ca0f12d3296e24a01d81`
  through `e296ea4d32f9cf092ec7b95cafd3f54d697ed886`: 33 paths / 61 textual hunks.
- Outcome: changes required. Both reviewers independently verify one High finding;
  its correction below requires a NEW complete cumulative round 3 before acceptance.

Every changed path/hunk and new implementation/test was reviewed. Existing historical
large documents were reviewed by changed hunk and relevant contract context. The two
reviewers have separate private source copies, workspace links, outputs and caches.
Neither modifies the shared repository or certifies whole W7.

## Confirmed finding and correction

An already-aborted public stdio open creates its PID latch and global child registration
before `raceDeadline` refuses SDK connection entry. SDK client cleanup has no attached
transport and therefore does nothing. No child starts, but the unused registration and
unref'd 20 ms sampler remain for the life of the process. An empty PID list and a bounded
caller rejection do not reveal or retire that resource leak.

Failed-connect cleanup now independently starts the owner's idempotent close. A proved-empty
owner releases registration immediately; an entered native owner still owes actual native
close and admitted descendants. Concurrent client/owner cleanup reaches the same published
join and does not issue another native close. Cleanup never extends the caller's deadline
or replaces the original typed refusal. No grace-based PID release is restored.

One new permanent public regression proves that SDK start never enters, the timer count
returns to its initial value, actual SDK close runs once and the original cancellation type
survives. The increment now has 68 new permanent cases. An obsolete failed-spawn test comment
is corrected to describe actual callback acknowledgement.

## Verification and custody

Each reviewer independently preserves a strict-checked original semantic red, a private
owner-cleanup causal green, and an exact-restored original red. The authority fixture runs
public MCP source under Vitest with rebuilt private workspace dependencies; the lifecycle
fixture imports actual private MCP `dist`. These are distinct source and compiled controls.
Neither red relies on a timeout. Original restored focused checks pass 142 cases / 10 files
and 258 cases / 17 files respectively; these overlapping counts are nonadditive.

Parent separately reproduces the permanent test's semantic red after strict checking and
lint. The production correction passes strict MCP checking, lint, actual MCP build and all
26 native/stdio/work controls. Fresh enforced private coverage passes 411 files, 9,098 cases
and 12 existing skips, under unchanged thresholds; MCP reports 96.17% lines / 90.42% branches.
The corrected shared source also passes actual `CI=true pnpm run ci`: all 23 lint/type/test
tasks (16 cached), seven build/format tasks (five cached), tool/database/fence/dependency
checks and all three offline smokes. New documentation is checked separately after this
code-only CI run. These are scoped, cache-qualified checks, not final forced whole-wave proof.

Parent reads both complete reports/maps; the reviewer corrects flagged per-hunk test
attribution before sealing. Parent physically verifies all 19,076 and 26,831 inventory entries, all relied-on run inputs,
logs/receipts and seal bindings, and compares every reviewed head snapshot/hunk with git.
The complete shared-tree audit includes source, outputs, caches, dependencies and Git bytes,
modes, mtimes and symlink targets: 646,589 entries before/after, zero changes and clean
`development` at the reviewed head. Explicit freeze release precedes shared correction.

| Artifact | SHA-256 |
| --- | --- |
| Authority report | `559d1ef050f02b60d6b140deb78abf20cf8b7bab13826a05fc09b5d021123f16` |
| Lifecycle report | `bdece4b213715789ce97e088012877d3cdbcd7c251529bd0652e391f3f1a8cbf` |
| Authority inventory | `f0f8a3519ee2979722949c5ed56bcb6d5e09e43e78cdcc2a3efd4e4bb8a478ab` |
| Lifecycle inventory | `878037516482b80b08c289f58813aa1e90de2af575efc82581ac13fbae3fa558` |
| Both shared-tree snapshots | `48a4f1fe802942d0be7b9371823302411bbb66345381f6d1dac047111802a0f7` |
| Corrected private coverage input manifest | `0aeb0c1b641de64d2f2dffbdcf11387e2cc552e06c25c801585bde97ef30cdea` |
| Corrected private coverage stdout | `d05d4d8120b62a669b33e67a7e1ae6df674bf51039db436e0f8c70189c0b3fd3` |
| Corrected shared-source root CI stdout | `bf032d11690b2dbdba065f91256519b0f1538631d0f288fdcbcd5c6ba79ad299` |

The canonical contract remains in
[MCP integration](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes).
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
and [the W7 plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) retain complete
manager startup/all-actor retirement, custom-provider descendants, final receipt health,
parked clocks, public departure and acknowledged CLI teardown as open work. Step 8 and final
Step 12 remain open. Passing this correction's checks is not whole-wave acceptance; no
further paid call, credential or new ADR approval is needed.
