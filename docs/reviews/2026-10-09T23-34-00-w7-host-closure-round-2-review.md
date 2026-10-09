# Review: W7 consolidated host closure, cumulative round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`host_closure_r2_authority`, `host_closure_r2_lifecycle`), plus Parent confirmation.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through `ccb42bc250fd9c06e1ca5be17cf104be4b7f5968`, 117 paths / 336 literal hunks.
- Outcome: changes required for two confirmed High findings and one adjacent canonical-documentation issue. Parent corrections require fresh complete review.

## Findings and correction

Lifecycle independently discovers that departure repeatedly starts an already-due budget
approval while its asynchronous preparation is pending. The synchronous loop never reaches its
activity wait, admitting more than 1,000 preparations and starving Promise, timer and signal
continuations. Its supported injected executor adds a deadline to a real runner-generated frozen
budget gate; stock budget-gate creation currently adds no such deadline. Refused, held and
real-timer-overlap probes require external watchdog termination (-9); not-due, ordinary human
approval and budget rejection controls complete. Authority corroborates after disclosure;
Parent also reproduces the original probe. Neither corroboration is independent discovery.

Parent introduces one synchronous in-flight timeout claim per gate, shared by real timers and
departure deadline service. Departure waits actual retained activity while that claim exists.
The existing refusal policy remains: a refused timeout approval terminates with `run_timeout`;
the alternative suggestion to retain the unchanged pause is not adopted. Seven permanent
public-handle cases cover held/refused/live preparation, timer overlap and the three controls.

Authority independently discovers that invocation aggregate transfer can synchronously cancel
the caller after the previous guard, yet generate, stream, media submission and raw polling
still enter the provider. Lifecycle corroborates the disclosed text probe. Parent reruns the
original text and corrected typed-media inputs: four cancelled-entry assertions fail, four live
controls pass. This establishes provider entry, without real network or billing. The original
media fixture's unnecessary generic cast remains preserved and receives no strict-type proof
credit; the separate cast-free fixture reproduces the same defect.

Parent rechecks caller/merged-deadline cancellation after transfer and before provider entry,
marks text attempts invoked only after the guard, captures the poll method with its receiver,
and retires transferred ownership on refusal. A proven pre-egress media refusal releases its
unused admission. Twelve permanent text/media controls cover live, caller cancellation, outer
retainer cancellation and merged-deadline refusal, including actual attempt/usage and refund
assertions. Together with the seven gate cases, the correction adds nineteen permanent cases.

Lifecycle also identifies stale adjacent canonical statements about effect/terminal exit priority
and the absence of public departure. The effect-journal and execution-model references now link
the current [CLI remedies](../reference/cli/commands.md#exit-codes) and
[engine departure contract](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).
Accepted ADR-0103 policy, provider wire behaviour and durable event schemas are unchanged.

## Evidence and limits

Both fresh reviewers assess the complete composition independently: all 117 paths / 336 literal
hunks, substantive per-file/per-hunk assessments and explicit test attribution. Authority runs
87 targeted cases successfully, directly without Turbo cache or coverage. Earlier Parent full
CI/coverage is supplied evidence, not repeated independently in this round. All original failed
assertions, watchdog kills, typed-fixture qualification and an audit helper's prose-comment
false positive are retained. A separate qualified audit passes; no failed result counts as green.

Parent reads both reports and complete assessment maps, validates path/content/diff/literal-hunk
identities against Git, checks original inputs/logs, and reruns both confirmed defects. All 1,324
tracked files, HEAD, index and clean status remain unchanged through the frozen review. Ignored
build/test output may change; no whole dependency/.git/untracked-tree immutability is claimed.
Freeze release: `2026-10-09T23:30:13.382104+00:00`, changes required. Corrected initial focused
execution passes 57 cases. Strict compilation catches an invalid result tag in a new fixture;
that fixture is corrected to the supported typed failure, with the failed check retained. The
first root CI also catches a missing await in a new async-generator fixture; the corrected
fixture passes lint. Corrected full root CI then passes, including all three offline smokes,
with disclosed Turbo cache hits. Full root coverage passes 443 files / 9,320 tests + 11 skipped,
with statement/branch/function coverage 95.97% / 92.72% / 96.35%. Original provider/media probes
now pass all eight paired cases. The original due-budget child exits0 without watchdog
termination and reaches its existing timeout terminal. No failed intermediate check counts as
success; all corrected command outputs and unchanged-source comparisons remain retained.

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-host-closure-20261010/round-2`.
Authority report/map SHA-256:
`5509f51f2c0b514eacc396843986b6c8e1aae40880edfbfe667ec0adcc084c82` /
`6519c9399e33c5cb199f6e2cd3eece2d97f866568aab74e2584a40c26205a6ca`.
Lifecycle report/map SHA-256:
`826228834a98a2470211ef37dd6990f76a385b80769138734a5628cd4895e2ce` /
`37b56e10061f157de698644fb63a488f95b335f48d6d6c2b69276979be40efef`.
Original commands/logs, `parent/map-freeze-audit.json` and `parent/freeze-release.json` bind this result.

## Remaining work

Fresh complete review of the corrected composition, Step 8 compaction/recovery and final
whole-wave Step 12 remain required. All six W7 items remain open (41/51 closed); PR #90 remains
draft/unmerged. No user approval, paid call, credential or provider capture is pending.
