# Review: W7 first-start publication, cumulative round 9

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r9_authority`, `dispatch_r9_lifecycle`), plus Parent confirmation.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through `777c9ddd41a254c5cb9f8b2afd967ca68fb7e63f`, 23 paths / 41 literal hunks.
- Outcome: changes required for one confirmed High. The corrected source needs fresh complete cumulative reviews.

## Confirmed finding

Authority independently discovers a first-start publication failure. The entered first
`node:started` append sits outside its diagnostic catch: a synchronous clock fault can reject the
detached scheduler, leave a running claim without an executor/deadline and produce an unhandled
rejection. Lifecycle initially misses it and corroborates only after disclosure; this is not
credited as a second independent discovery.

Parent reproduces the defect, then contains first-start publication with the existing fixed
failure/backstop path. The entered attempt stays at 1, including an approved redispatch after a
previous retry. A readiness refusal before fresh start retains the earlier entered attempt.
The [canonical engine contract](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns those mechanics.

Six permanent paired live/fault cases cover widths 1/3 and approved redispatch. Final-fixture
original-source controls fail three cases with three unhandled rejections; the correction passes
all six. The fix lands with the consolidated host-departure integration and does not receive
acceptance from these earlier reviews.

## Complete review and custody

Both reviewers cover every path/hunk and independently pass seven checks, including 119 core
files / 2,889 cases. Parent reads both reports, individual coverage assessments and all fourteen
original receipts/logs. Each review retains 1,267 physical source inputs and exact command/source
hashes; main tracked source/HEAD/status and dependency-link topology remain unchanged. There is
no full shared-dependency or `.git` immutability claim. Explicit release is
`2026-10-09T21:43:39.109407+00:00`, with changes required.

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-dispatch-corrections-r9-20261009T210501Z`.
Authority report/seal SHA-256: `f77864d0ffd9282e0715664e1261491900daa377f023b9ec3a4fbc8aba3f8067` /
`f84869f877068490993df119e102e8b8ca738b3a761a87174200553a72a6f446`.
Lifecycle report/seal SHA-256: `b0e0717ba24133aceb640b8c12d8d79051adfbd915192eeef427f2f57e3f9161` /
`a10d4ec32a07582330d2f6361e7419677abeba387ac00ce5fa92ce81beebb520`.
Final controls live in `w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`;
`retained-controls-parent-audit.json` verifies all nine retained first-start/parked-clock runs.

## Remaining work

Fresh independent review of the complete host-departure integration, Step 8 compaction/recovery
and Step 12 whole-wave validation remain required. All six W7 register items remain open (41/51
closed), and PR #90 remains draft/unmerged. No paid call, credential or approval is pending.
