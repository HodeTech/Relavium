# W7 systematic group 3, round 2 — cancellation retains terminal authority

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_round2_contracts`, `/root/w7_group3_round2_runtime`; parent `/root`
- **Subject**: complete operator correction `ad825fb1..09e021be`, 35 changed paths
- **Outcome**: Changes requested; one independently verified High corrected, fresh complete round 3 required

## Finding and correction

Both fresh reviewers reproduce the same High in `drive.ts`: after an invalid or stale inline
budget approval, SIGINT during a held native aggregate-pause append requests real cancellation,
but the driver exits on the old acknowledged pause. The command returns exit 3 and closes SQLite
with durable paused history instead of a cancellation terminal. The cancellation writer has not
entered; this reproduction does not establish another writer exception or retained lease.

`350f7152` requires that cancellation has not started before breaking on a pause. The existing
ordered stream therefore delivers the actual acknowledged cancellation terminal before command
resources close. No pause is invented, no financial policy changes, and no new timer, error code,
request-ownership rule or durable schema is introduced. The canonical
[command contract](../reference/cli/commands.md#relavium-budget-resume) states the operator outcome.

Seven promoted native command controls cover invalid/stale decisions with and without cancellation,
genuine approval/rejection and an ordinary human gate. In the two cancellation cases the actual
`run:cancelled` append is also held: SQLite must remain open and the command unsettled until its
acknowledgement. A race against command settlement detects the old premature exit without relying
on a wall-clock delay. Four further native controls bind human approval/rejection and cancellation
to an already persisted authorization while late timeout preparation refuses. These preserve
actual outcome, one durable decision, zero premature key/provider calls and lease/timer cleanup.

## Verification

Contracts (`gpt-6-astra / xhigh`) finishes five fresh ordered builds and strict compilation.
Its complete 24-file focus has **719 passing tests and two finding failures**: all 705 permanent
cases and 14 of 16 independent cases pass. Runtime (`gpt-6.1-sol / xhigh`) also finishes five
fresh builds and strict compilation. Its 24-file focus has **713 passes and one finding failure**:
all 705 permanent cases and eight of nine independent cases pass. Narrow cancellation controls
pass after the guard; removing the prior engine claim guard breaks the intended claim controls.
Exact production source pins are restored before each final build.

The parent independently reproduces **22 passes and three finding failures** among the 25 fresh
cases in a separate unsealed source copy. The one-guard correction passes all 25 plus the eleven
prepared permanent cases (**36 total**). Promoted Original cases against old production have
**nine passes and two expected failures**. Corrected Original forced lint/typecheck/test passes
**23 tasks, 364 files, 8,250 tests and 12 existing skips**. Six forced build tasks, test isolation,
source format and `git diff --check` pass. The first full check finds only a new native mock's
missing asynchronous response wait; it now awaits the real held authorization acknowledgement,
with the provider-call counter incremented before that wait. No arbitrary delay or suppression
is added. Failed preparation remains recorded rather than retroactively certified.

## Evidence integrity and qualifications

Both full reports, all 35 dispositions per reviewer, all four independent fixtures and the
preparation/proof supplements are read before Original changes resume. The parent independently
verifies every actual recorded nofollow metadata, content, sorted child-list, literal/resolved
link, target/manifest, inventory self, source pin and pre-runtime Original identity field.
Each Own has **1,143 restored source pins**, 79 named dependency links and 11 canonical Own targets;
regular file identities are unique, single-linked and disjoint from Original. All **3,635 actual
physical entries** and **862 externally bound artifact tuples** match. Runtime's exact sorted
compact UTF-8 432-tuple transport reconstructs to 51,664 bytes and its delivered digest. Parent
initial filename/schema guesses and truncated reads are corrected through actual schema/full-span
reads; sealed Owns are never executed, modified, cleaned or resealed.

| Own | Inventory rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,817 | 1,818 | `28e6a50b2459e57a9f4dfaf25bb4f07809879f140d84836d9089b0a6dfe85cc3` | `7d69eb1050e11f1d5f8d253602f13d5bb072589913531a5875b1f8d66d980b52` |
| Runtime | 1,816 | 1,817 | `53d7563888102616884a059c2b447779f102aec44410dc745e361b6874b3f814` | `eb340dbb3f5dad088d8d77eaf0d5e6f9daf33307e29f35df2c058f1254300776` |

Contracts independently exercises 22 actual mains and 53 source workers before source imports;
nine extra pool bootstraps have supplied preload coverage only. Its CJS/native denials are
exercised, with no separate hostile ESM credential probe. Runtime's final ten actual mains and
24 source workers independently exercise both synchronous and explicit ESM probes. Its three
existing native OS-SIGINT writer controls pass; the new cancellation reproduction uses
`process.emit('SIGINT')` and is not presented as another OS-delivered signal test. Initial SDK
environment injection, fixture readiness, omitted glob and child-preload failures remain qualified.
Neither reviewer claims kernel containment, live-provider evidence or full lexical rereading of
unrelated large inherited test bodies. All changed cases and relevant actual callers are reviewed;
the full supplied focus is executed. No child review agents are used.

Group 3 remains open until fresh complete round 3 accepts all original corrections and both fixes.
[Round 1](2026-10-06T18-43-01-w7-systematic-group-3-round-1-review.md) and Group 2a's qualified
round-14 acceptance remain historical evidence. ADR-0102 remains Proposed and unimplemented.
Groups 4–6, three-of-five live captures, Steps 7–8/12, current Sonar, W7 and draft PR #90 remain open.
No provider key read, live call or additional paid generation occurs.
