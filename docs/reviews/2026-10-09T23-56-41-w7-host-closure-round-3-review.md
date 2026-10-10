# Review: W7 consolidated host closure, cumulative round 3

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`host_closure_r3_authority`, `host_closure_r3_lifecycle`), plus Parent confirmation.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through `455a3283c0cfc8930f2dab3ae83a5f21d186fbf9`, 121 paths / 345 literal hunks.
- Outcome: changes required for two confirmed Highs. Parent corrections require fresh complete independent review.

## Findings and correction

Authority independently discovers that successful generated content/usage remains aliased
through invocation retirement. Supported synchronous caller cleanup changes output and token
counts 3/2 to 0/0 before ownership, affecting the result and attempt accounting. Its poll control
also changes a returned failure diagnostic. Separate media submission has the same ordering by
source inspection; no text-usage accounting claim is made for that different pricing path.
Lifecycle corroborates the disclosed result-order defect in source. Parent reruns the original
source-aliased six-case probe: five intended failures, one passing failure-usage mutation control.

Lifecycle independently reproduces throwing caller-listener removal skipping abort and quiet
acknowledgement after sealing the invocation. Authority reproduces the same variant after
Parent raises it. A second retire cannot repair the sealed scope; a proved-empty aggregate stays
owed. Chain finally also escapes before attempt observation, replacing successful or failed
provider outcomes. The observation probe exits 0 to witness the defect, not product correctness.

Parent captures successful output/quantities and media result/status before retirement. The
existing shared diagnostic snapshot is exported to preserve typed media failures; opaque
unclassified errors retain identity. Retirement attempts abort/quiet ACK even when detach
throws, also unwinding partial constructor setup. Text settlement contains cleanup failure until
known usage is accounted; established provider/cancellation diagnosis stays primary. Media
cleanup-only failures remain loud. No new wire, request-ownership or accepted ADR policy is added.
Thirty-two permanent cases cover text generate/stream success/failure with live/mutating/throwing
cleanup, abort-observer mutation, held/quiet retirement, constructor failure, poll states and
actual runner submission/receipt joining. Canonical mechanics live in the
[provider seam](../reference/shared-core/llm-provider-seam.md#the-per-attempt-deadline).

## Evidence and limits

Both fresh reviewers independently assess all 121 paths / 345 hunks, including changed tests
and adjacent lifetime continuations. Lifecycle directly passes 18 files / 153 cases; Authority
retains the six-case original failure/control probe. Supplied Parent full CI/coverage is not
reviewer execution. No network, credential, provider call or dependency install occurs.

Parent reads both complete reports/maps, validates all content/diff/scope hashes against Git,
checks original command receipts/logs and reruns the source-aliased six-case input. All 1,326
tracked files, HEAD, logical index and clean status remain unchanged through freeze release
at `2026-10-09T23:51:55.706492+00:00`. Ignored build/test output may change; no dependency/.git
or untracked-tree immutability claim. The initial Parent invocation names a nonexistent optional
config and is a retained setup failure, not product evidence; the corrected invocation uses the
actual retained config and reproduces the defect.

Initial correction checks pass 64 focused cases and all six original probes. The expanded
focused batch exposes stale built LLM imports plus the missing public diagnostic-helper export;
those intermediate failures remain retained. After adding that export and rebuilding LLM, all
80 focused cases pass. Lifecycle also preserves its two preliminary standalone fixture-typecheck
failures (missing type root/MTS syntax); the final cast-free typed probe passes and reproduces.
Full CI exposes three existing invalid-media classification controls: schema capture initially
throws raw validation errors or labels an invalid poll as transport failure. Parent restores fixed
internal classification before retirement, retaining the original protocol guards. Root CI then
passes (23 tasks, 11 cached, followed by all root checks/smokes); full coverage passes 443 files /
9,352 cases plus 11 skips: statements/lines 96.01%, branches 92.67%, functions 96.41%.
A mistaken `pnpm ci` invocation is retained as a pnpm command-selection failure; actual CI is
`pnpm run ci`. Final ordering also folds known generated usage before a deferred capture fault.
Root CI is rerun green on that final ordering; the final full coverage run passes the same
443 files / 9,352 cases plus 11 skips: statements/lines 96.02%, branches 92.68%, functions 96.41%.
Qualified standards checks and `git diff --check` pass.

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-host-closure-20261010/round-3`.
Authority report/map SHA-256:
`1fc953f7ce8f80500ce22c5720b73d1e4f2b08ca279bb88461450f6e989a2894` /
`474bdcaf7e54874834c2f03ab60e8974606a1ed019be2b7ba35f4ae6dee56cbb`.
Lifecycle report/map SHA-256:
`d60599feb39f50e6ef21d4bb5cf0b6f44fbb159988bc736ad1cc0c62980ee9cc` /
`80a13f87f380b0d82b2d09600a900949d85337b64f8b33d5546baa9a4fc6c978`.
Original commands/logs and Parent map/freeze-release audit bind the result.

## Remaining work

Fresh complete review of the corrected composition, Step 8 compaction/recovery and final
whole-wave Step 12 remain required. All six W7 items remain open (41/51 closed); PR #90 remains
draft/unmerged. No user approval, paid call, credential or provider capture is pending.
