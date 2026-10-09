# Review: W7 approved redispatch readiness correlation, round 5

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r5_authority`, GPT-6.1 Sol, xhigh;
  `dispatch_r5_lifecycle`, GPT-6 Astra, xhigh), plus Parent's source, artifact and freeze audits.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through
  `0e2a0d1d4f1c0b1139a05b3667434a9b33275611`: eighteen paths / thirty-two literal hunks.
- Outcome: changes required for one confirmed High. The private correction receives no
  acceptance from this rejected round; NEW complete cumulative review is required.

## Confirmed finding and correction

Authority independently discovers the source path. Lifecycle corroborates after disclosure;
Parent owns runtime confirmation, correction and causal removal controls.

A node enters attempt 1, retries to 2 and pauses for budget approval. Approval restores
pending state without entering a fresh start. Redispatch waits for consumer readiness
before resetting the first-start basis. A readiness rejection nevertheless passes literal 1
to the failed-settlement helper, assigning the single terminal to an attempt that did not
just start. Starts and executor entries remain `[1,2]`; the terminal belongs to 2.

Readiness failure now forwards the latest entered attempt, falling back to 1 for a node
that has never started. Reset remains immediately before an actual fresh first-start append.
The [canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns these mechanics. Two permanent cases pair rejected readiness (`[1,2]`, failure at 2)
with live approved redispatch (`[1,2,1]`, completion). This is node-attempt correlation;
no extra spending, repeated effect or duplicate terminal is established by the finding.

The final seven-file/twenty-case controls use identical formatted fixtures: exact frozen
original and literal removal each give one intended failure/nineteen passes; fixed and
restored give twenty passes. Parent reads every original stdout/stderr and physically
verifies 5,036 input copies. Fixed strict core, scoped lint and complete core pass:
118 files / 2,886 cases, no skips/unhandled errors, with 3,777 physical input copies verified.

## Complete review and evidence custody

Each reviewer inspects the complete cumulative eighteen paths/thirty-two literal hunks
and relevant actual continuations, without partition or inherited acceptance. Each passes
seven original checks: sequential cold shared/LLM/core builds, strict core, purity, scoped
lint and complete offline core, 117 files / 2,884 cases, no skips/unhandled errors.

Parent reads both complete reports and every individual file/hunk read scope, rationale
and disposition. Exact JSON/Markdown concordance and original metadata are mechanically
verified. Both archives contain 1,295 regular source files; fourteen original captures
contain 17,668 physically verified input copies. Every head/literal hunk/archive matches
exact Git bytes. Each reviewer has 99 individual dependency links, eleven remapped to its
private workspace. Protected inventories are physically checked, including actual
0444/0555 modes; targets are never traversed or chmodded. The owner can reverse protection.

| Reviewer | Report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `7c9e03173754081b61bd8cb636d1cbbbee2cd0f982c0442f96029012c6c48feb` | `7d46c98cc8976e05646c5d7ff9fc24f3a86008fd6d8f5b2399ee05c438f6da3d` |
| Lifecycle | `53ee551a572d6d05c82fdb72204ed015ca890eaee259cb0f1d80c352d50f4757` | `57113524067770603bc154bf9e0b6f714949b4fc18fd22da078f0fd66e74f144` |

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-dispatch-corrections-r5-20261009T191625Z`. Parent controls are in
`w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`, with the three
`redispatch-readiness-*.json` control/input/validation audits.

Before sealing, Parent catches inaccurate Authority descriptions of three fixture groups.
The reviewer rereads all seven complete new files and existing fixture hunks, corrects its
report/maps/validation only and checks exact concordance again. Original artifacts are
retained separately; source and original project captures never change. The High and its
discovery attribution remain unchanged. Oversized/mistargeted administrative reads and
Parent's first check-summary key mismatch are qualified; none is a failed project check
or a retrospective runtime receipt. Historical round 1 remains Accepted/zero findings;
rounds 2–5 reject their frozen candidates.

The entire shared-tree comparison precedes explicit freeze release at
`2026-10-09T19:41:03.798074+00:00`. Source/test correction lands only after that release.
The final landing gate has its own original capture; earlier root CI does not prove later
documentation bytes. This record creates no coverage/Sonar, native CLI or whole-wave claim.

## Required remaining work

NEW complete cumulative reviews must inspect this correction and all preceding dispatch
changes. Complete scheduler/resume/timer/MCP/custom-provider roots must integrate with
shipping public departure, sticky final money/effect health, original parked clocks and
primary/input/host acknowledgements. Broader private actor/departure controls remain
unaccepted, including the original 38 CLI failures. Step 8 and final Step 12 remain required.
All six W7 items stay OPEN (41/51); PR #90 remains draft/unmerged. No paid call, credential,
maintainer decision or ADR approval is pending. No W7 work is deferred by this correction.
