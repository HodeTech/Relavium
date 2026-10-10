# Review: W7 MCP transport and protocol lifetimes, round 3

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`mcp_authority_r3`, GPT-6.1 Sol, xhigh;
  `mcp_lifecycle_r3_fresh`, GPT-6.1 Sol, xhigh), plus Parent's complete artifact,
  source, shared-tree and separate correction/runtime checks.
- Subject: complete cumulative MCP increment, `8e3818b66732add45e13ca0f12d3296e24a01d81`
  through `4f119cab1eebb6ff9fb39d81d95f899307d6c55c`: 35 paths / 67 textual hunks.
- Outcome: changes required. The lifecycle review identifies one High, independently
  verified by Parent. The authority review finds no new material issue. The correction
  below requires a NEW complete cumulative round 4 before scoped acceptance.

Every changed path/hunk and all new implementations/tests were reviewed in two separate
private source copies with independent outputs/caches. Large historical documents are
reviewed by changed hunk and relevant contract context. Neither reviewer certifies whole W7.

## Confirmed finding and correction

A peer request reusing an ID still owned by an active handler/response send is refused
without replacing the original reservation. However, the owner throws that refusal from
its incoming base/lane callback. Installed SDK 1.29's WebSocket callback catches parsing
only; delivery is outside that catch. Legacy SSE also forwards delivery outside its parse
catch, but installed EventSource catches the resulting reader-loop rejection and schedules
reconnect. These are source-confirmed error-boundary consequences. Neither a native process
crash nor a persistent native leak was experimentally reproduced. The existing installed
in-memory SDK test's sender-Promise rejection proves neither native boundary safe.

The owner now reports its fixed, content-free typed ambiguity through the normal error
channel and suppresses only the refused message. Base and request-lane delivery both
honour that admission result. The original handler, queued response ownership and raw
operation remain retained; no tool is replayed and no prior request is replaced.

Two new permanent local callback controls verify base/lane nonthrowing refusal, exactly
one SDK delivery/error, exact raw handler identity, zero replacement-factory entries and
close remaining pending until admitted handler/request work settles. The existing installed
in-memory SDK test now verifies the error channel while a real response send remains held.
The increment now has 70 new permanent cases. These local and installed in-memory controls
are distinct from a native WebSocket/SSE duplicate-message experiment, which was not run.

## Verification and custody

The two complete reviewers pass cold private shared/llm/core/db/mcp builds, strict MCP/CLI
checks, scoped lint and the existing 17-file / 259-case suite. Authority additionally runs
actual private CLI build/version smoke and strictly compiled MCP-dist controls; Lifecycle
uses CLI source integration with rebuilt workspace libraries and makes no compiled-CLI claim.
A separately interrupted preliminary lifecycle attempt has no complete-review credit. No
proposed duplicate-peer native/network experiment ran. All failed setup/tooling attempts
remain preserved and receive no semantic credit.

Parent's new permanent tests pass strict checking/lint before failing against original
production: three semantic failures, no timeout. Fixed focused controls pass 24 cases;
strict checking, lint, actual MCP build and formatting pass. Fresh enforced private coverage
passes 411 files / 9,100 cases / 12 existing skips with unchanged thresholds: MCP lines
96.42%, branches 90.41%. Coverage precedes one additional reservation-preservation assertion;
production is unchanged, and final focused/strict/lint/format checks cover that assertion.
Actual shared-source `CI=true pnpm run ci` passes 411 files / 9,100 cases / 12 existing
skips, all 23 lint/type/test tasks (16 cached), seven build/format tasks (five cached),
tool/database/fence/dependency checks, actual compiled CLI and three offline smokes.
New documentation is checked separately after this code-only CI. These are scoped,
cache-qualified results, not final forced whole-wave proof.

Parent reads both complete reports/maps. Incorrect draft lifecycle attributions are preserved
without proof credit and corrected after every exact hunk/new implementation/test is reread.
Authority's sampler wording and two dispatch-field/seam attributions are corrected in two
separately sealed siblings; original sealed artifacts remain unchanged. Parent's own mistaken
field-name objection is explicitly withdrawn after verifying `ctx.hostCallOptions` in Git.
These are evidence corrections, not additional product findings or runtime proof.

Parent physically verifies all 52,184 authority and 13,978 lifecycle inventory entries,
all 39/nine runner receipts, copied inputs/logs and seal bindings, all 35 head snapshots and
67 literal hunks. Both authority corrections are separately audited (109 and 116 inventoried
files). All task-owned trees are read-only; original authority/corrections also carry immutable
flags. Parent separately verifies all 13 correction runs and 11,466 copied source/config inputs.
The complete shared-tree audit includes source, outputs, caches, dependencies and Git
bytes, modes, mtimes and link targets: 646,647 entries before/after, zero changes and
clean `development` at the reviewed head. Explicit freeze release precedes the two-file
shared correction (`23310428`).

| Artifact | SHA-256 |
| --- | --- |
| Authority original report | `0798f089b4a0ac03897acb91d809c63669ad2a9f08f2e1e9964aa72e5aa5741d` |
| Lifecycle final report | `39da9d3a96649df6ecd2d2a40bab3919ccaf1e230e19991c2494a0a9b4ee6e9e` |
| Authority original inventory | `a4114a2cf617cc6b8fa1e87c7ea861a74725329e552e523e3325adbff149b115` |
| Lifecycle final inventory | `c2ad28523add1b19a6a6bbc88fa14ea854645d24052709f250234b4df89ad237` |
| Authority final attribution-correction seal | `c023bd1684ce729dbeff28d669fc3beb1c1e39b791e09f60c3d0874ddea08e06` |
| Lifecycle final seal | `a7350c3ea8443b027c14b7c1a58c20dd27e79615f5431d0fcc7d46e31197ea1c` |
| Both shared-tree snapshots | `8d738a9bb2ac3783399d7f59f26c8bf6cdcff0b51356549755c85cbcbbfbbf54` |
| Corrected private coverage inputs | `9f2f558606976f98ffb1535ab295c93b2ddcfa3a76f573651814a9afb5dff038` |
| Corrected private coverage stdout | `03763d62009bf13681d6d15c748db2aa578bd56217030ccc545188c27cf2daaf` |
| Corrected shared-source root CI stdout | `2685f3d68c03dd2cd6b817b9e618ea8e8fb22ab8e1f5c8b1386b9cf8d8b394bd` |

The canonical contract remains in
[MCP integration](../reference/shared-core/mcp-integration.md#invocation-and-transport-lifetimes).
[ADR-0103](../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
and [the W7 plan](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) retain complete
manager startup/all-actor retirement, custom-provider descendants, sticky final receipt health,
parked clocks, public departure and acknowledged CLI teardown as open work. Step 8, final
Step 12 and all six W7 register items remain open (41/51 closed). PR #90 remains draft and
unmerged. No further paid call, credential or new ADR approval is needed.
