# Review: W7 inherited dispatch corrections, round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r2_authority`, GPT-6.1 Sol, xhigh;
  `dispatch_r2_lifecycle`, GPT-6 Astra, xhigh), plus Parent's source, complete report/map,
  physical artifact and shared-tree audits. Parent owns all runtime controls and fixes.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through
  `53cccc38a239cade09a16d22792a7a5ef104c378`: ten paths / nineteen literal hunks.
- Outcome: both independently request changes for one confirmed High. The later Parent
  correction requires NEW complete cumulative reviews; it is not accepted by this round.

## Confirmed finding and correction

Both reviewers independently identify the unchecked continuation after a retry's awaited
`node:started` append. A held attempt-2 append followed by cancellation, sibling failure
or grace still enters the executor with an aborted signal. The initial dispatch guard
does not cover this second boundary. This is an inherited omission, not a regression
introduced by the first-start fix. The existing absolute node deadline is shared by
retries: fresh executor entry is proven, not a newly armed retry deadline or live egress.

Parent confirms exact frozen production entering attempts `[1, 2]` where refusal requires
`[1]`. The correction captures the entered retry identity before the await, refuses fresh
entry afterwards, settles the matching attempt through the diagnostic backstop and
preserves cancellation/earlier sibling failure. Already settled work gets no duplicate
terminal. Parent separately discovers missing grace-attempt correlation in its first
guard-only correction; that is not a second independent reviewer finding.

After both reports, Parent additionally confirms synchronous cancellation from node
deadline setup can still enter the executor. Actual attempt entry now guards before
method acquisition, after acquisition and after context/effect factories, capturing the
method once and preserving its receiver and exact raw Promise. This is a subsequent
Parent finding/correction, outside the reviewers' frozen-head verdict. The mechanics
live in the [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

Four permanent held-retry cases cover live/cancel/sibling-failure/grace, actual entry,
matching terminal attempt, earlier cause and lease/timer cleanup. Six live/cancelled
synchronous deadline/method-getter/effect-factory cases cover entry ordering, receiver,
terminal and cleanup. These reference-host tests do not certify public/native departure.

Parent's exact-final ten-case matrix has eleven original stages: old production fails
six/passes four; fixed/restored pass ten. Removing the before-acquisition,
after-acquisition or before-execute guard fails one each; removing the receiver fails
three live cases. Removing early retry capture fails grace correlation; removing
attempt forwarding fails two terminal identities; removing matching settlement causes
two actual five-second timeouts. Removing all new entry guards fails six/passes four.
No syntax/collection failure or unhandled rejection occurs in these final stages.
All **13,805 input copies** are physically verified and all original logs read completely.
Strict core types and scoped lint pass on those final bytes.

The earlier guard-only matrices remain historical, not individual load-bearing proof
after layered guards. Initial fixture TS2739 and TS2322 failures are retained and
corrected with the actual signal type and explicit `Promise<NodeOutcome>`, without
casts. A prior summary's glob selected older captures; final associations use each
actual driver's receipt JSON and are physically checked. An earlier receiver assertion
could trigger getter access during diagnostic formatting; final controls use an inert
boolean witness and fail directly on the receiver. An inline audit's unsupported Python
`zip(strict=True)` failed before auditing; explicit length validation corrects it.

## Independent checks and custody

Each reviewer reads every path/hunk and the complete relevant continuations, without
scope partition or inherited acceptance. Each passes seven prescribed originals:
sequential cold shared/LLM/core builds, strict core types, platform purity, scoped lint
and the complete offline core suite: **112 files / 2,868 cases / no skips or unhandled
errors**. Those are frozen-head results, not checks of the subsequent correction.
No reviewer source/test edit, new probe/mutant, install, network/provider call, shared
project command, native/CLI/root-CI or coverage result is claimed.

Evidence roots are `w7-dispatch-corrections-r2-20261009T173019Z` and Parent's
`w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`, under
`/Users/cemililik/.codex/relavium-evidence/`. Final Parent controls are
`actual-entry-inert-control-summary.json` and `actual-entry-inert-parent-audit.json`;
sealed reviewer roots are not modified by those later controls.

Parent reads both reports and complete concordant JSON/Markdown maps: twenty path and
thirty-eight hunk rationales. Exact Git/archive/head/patch identities, all original
receipts/logs/wrappers and **fourteen original captures / 17,556 copied eligible inputs**
are physically verified. Each archive has 1,287 files and 99 dependency links, including
eleven private workspace remaps. Authority/Lifecycle protected inventories contain
11,407/11,419 regular files, 916 directories and 99 links each; each temporary inventory
contains 981 files and nineteen directories. Parent verifies bytes/link targets and
0444/0555 protection without traversing dependency targets; owners can reverse protection.

| Reviewer | Report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `7ecb1ef03ab6cb2a0c7712a457e28b45a4a423fc0f95c66881e7b8c885f145a1` | `d8fabb8b4483aea7e02cd01b5adad2679fae5010eef1100f6aba70f4d6c378a2` |
| Lifecycle | `1ef5224f35aedd4fac8a5a23f962b1c43f0017ae9591c578f6fc35206a10917f` | `7a4a10cea20bc088686028f51bb26c2db69cba1f18441a5e4574a52dd2806e68` |

Guessed ADR reads and oversized-output truncations receive bounded recovery reads.
Authority retains an artifact-generator SyntaxError and its corrected generator.
These administrative failures receive no runtime proof credit; no retrospective
original command receipt is invented. All prescribed original checks pass.

The **647,374-entry** shared-tree comparison has zero changes, identical SHA-256
`caa72eb9dc9d861530aea55a7d814ceb877fa88886e98f9d059d6bea9af7ecd9`,
and unchanged clean HEAD. Explicit release is `2026-10-09T17:58:41.957529+00:00`, before
main-source correction. Historical round-1 acceptance remains in its original record.

## Required remaining work

NEW complete cumulative reviews must assess all corrections, original six and new ten
cases, adjacent continuations and documents. Complete scheduler/dispatch/resume/timer/
pre-handle roots must integrate with shipping departure: the broader private prototype's
38 CLI failures remain unaccepted, with original failures/assertions retained. MCP startup,
custom-provider descendants, sticky final health, parked clocks, primary/input/host ACK,
public departure and CLI teardown, Step 8 and final Step 12 stay required. All six W7
items remain OPEN (41/51); draft PR #90 remains unmerged. No new paid call, key, maintainer
decision, ADR approval or accepted-decision change is pending.
