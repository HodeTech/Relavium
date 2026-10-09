# Review: W7 consolidated host closure, cumulative round 1

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`host_closure_r1_authority`, `host_closure_r1_lifecycle`), plus Parent confirmation.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through `d5ed56f4d08ef047e2a4a9799f9b71c35c289fed`, 113 paths / 328 literal hunks.
- Outcome: changes required for three confirmed High findings and one required acceptance gap. The subsequent correction requires fresh complete review.

## Findings and correction

Lifecycle independently discovers that a successful money receipt published after a consumed
pause permanently invalidates the old publication-count equality. Even after the same primary
drains that receipt, departure repeatedly returns `continue` without any future progress owed.
Parent reproduces it and corrects pause identity to require the original consumed pause and the
fully drained **current** cursor. Generation, gate, idle, failure, cancellation, actor and absolute
deadline checks remain. Two permanent waiting-reader/buffered controls pin successful detachment
and refusal while the new receipt is unconsumed; no extra pause or reader is introduced.

Authority independently discovers that rejected checkpoint activation calls synchronous
abandonment and releases its fence before an entered heartbeat settles. A partial restored-node
timer also survives. Parent reproduces both schedules, including a due-checked heartbeat, and
adds awaited abandonment: stop runtime roots and every installed timer, abort, join actual entered
actors/receipts/delivery/parking work, then release the exact fence and preserve the original
rejection. Two permanent public-engine controls pin held ownership, no host use after return,
zero surviving timers and no invented terminal.

Authority also discovers that Ink consumes a terminal after input unmount but displays nothing
while host receipts remain held. Parent reproduces it. Ink now emits one fixed provisional human
terminal notice to stderr independently of its mount and final summary; it carries no provider
error or final receipt verdict. An installed-Ink regression checks actual output after native
input ACK while the host is held. Native SQLite input-first/receipt-first controls now assert
visible outcome before finalization, while the sole persistent summary still waits for both ACKs.

Lifecycle corroborates and reruns Authority's disclosed probes; this is not credited as a second
independent discovery. Authority separately identifies an acceptance gap, without inferring a
runtime defect: native receipt tests bypassed ToolRegistry's quiet settlement/discard and
mapping/bounding paths. Thirteen additional permanent shipping-registry/native-SQLite controls
cover refused committed/ambiguous/discard ACKs, mapping/bounding before settlement, combined
money priority, and successful committed/discard/ambiguous controls. Real journal evidence and
unchanged cancellation terminals determine the final disposition; caught errors cannot erase it.

The [canonical engine contract](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
and [CLI output/remedies](../reference/cli/commands.md#exit-codes) own the corrected mechanics.
These fixes implement accepted ADR-0103 without a new policy decision.

## Evidence and limits

Both reviewers independently assess every changed path and literal hunk, including the complete
dispatch/MCP/custom-provider/host-health/clock/CLI composition. Root CI passes with disclosed
Turbo cache hits. Lifecycle independently executes 440 files / 9,283 passed + 11 skipped and
enforced coverage. Parent's earlier full coverage also passes. Authority's coverage invocation
fails during report generation with a missing `coverage/.tmp` JSON; it is retained and is **not**
counted as successful. Shared ignored-output interference is possible, not established.

Parent reads both reports and all individual assessments, verifies per-path hashes/hunks against
the exact Git patch, inspects original command/log evidence and reruns the confirmed probes.
Lifecycle preserves and corrects five fixture-attribution descriptions after Parent flags two
of them; original maps and the separate clarification remain retained. The correction does not
change the findings or claim a fresh review. Parent's initial mistaken objection to Authority's
exit-code assessment is withdrawn after checking the actual diff; Authority's map was correct.
Tracked source/HEAD/index/status remain unchanged through the frozen review. Ignored build/test
outputs may change; there is no whole `.git`, dependency or shared-tree immutability claim.
Freeze release: `2026-10-09T22:55:59.719804+00:00`, changes required.

Before the production fix, the four core regression cases fail on their intended assertions,
and the real-Ink case fails on missing provisional output. Corrected focused execution passes
61 cases. Intermediate test-definition/type errors are retained as fixture errors, not product
findings or successful checks. Full corrected root CI passes, including all three offline smoke
harnesses. Corrected enforced coverage passes 442 files / 9,301 tests + 11 skipped; all-file
statement/branch/function coverage is 95.96% / 92.70% / 96.35%. Both commands preserve tracked
source/HEAD/index/status and retain their original logs and exit results.

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-host-closure-20261010/round-1`.
Authority report/map SHA-256:
`03c2a03897b29cba9deaf35fbc9c32a2cdc4a4ab156fefaffe0c956b5aebaac7` /
`1ec455de8751443563a65f7366188ee95f3aaf2e82c1acebc4d8e1bd04a48f21`.
Lifecycle report/map SHA-256:
`70224e3113ae02b2baba103b0a7345c16566501551b8a76a0d94d89e34b431d5` /
`36d9ce549274f2db98ca5d1497c44af4eea395aa6aaf775d1442206833c2e587`.
`parent/artifact-audit.json`, original commands/logs and `freeze-release.json` bind this result.

## Remaining work

Fresh complete review of the corrected composition, Step 8 compaction/recovery and final
whole-wave Step 12 remain required. All six W7 items remain open (41/51 closed); PR #90 remains
draft/unmerged. No user approval, paid call, credential or provider capture is pending.
