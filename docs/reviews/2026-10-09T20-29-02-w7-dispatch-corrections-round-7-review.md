# Review: W7 differing-order grace correction, round 7

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`dispatch_r7_authority`, GPT-6.1 Sol, xhigh;
  `dispatch_r7_lifecycle`, GPT-6 Astra, xhigh), plus Parent's source, artifact and freeze audits.
- Subject: `522fb8c9beff820004c72e0243d7868da7546474` through
  `da83e42de5bf29e6e1ef643de2325ca6ecd9bf9e`: twenty paths / thirty-four literal hunks.
- Outcome: changes required for one confirmed High; no later correction is accepted.
  NEW complete cumulative reviews are required after correction.

## Confirmed finding and correction

Lifecycle independently discovers the source path. Authority corroborates after disclosure;
Parent alone owns runtime confirmation, correction and causal removal controls.

The scheduler claims a ready batch in topological plan order, while grace iterates states
in authored order. Author `[a,b,y,x,z]` with `x→a` and `y→b`; the plan is `[y,b,x,a,z]`.
Hold the third root's readiness until the other two roots and their completion appends
finish. The next child batch is `[b,a]`. Hold `b`'s start append, cancel and fire grace.
Grace reaches authored `a` first, sets it failed synchronously and queues its failure
behind `b`'s held start. Scheduler finally restores only still-running claims, so it
cannot restore `a`. Child starts are `[b]`, but failures are `[a,b]`: a never-started,
never-executed sibling receives a durable abandonment result.

This inherited omission breaks the cumulative scoped unstarted-claim guarantee. The
previous flat-width hypothesis remains correctly disproved: matching iteration orders
hide the defect by waiting on the entered node first. Neither schedule establishes extra
spending, a duplicate effect or a native/public departure failure.

The correction explicitly tracks current unstarted scheduler claims, removes membership
synchronously at actual first-start entry and in unwind, and excludes those claims from
grace terminalization. Historical attempt identity cannot serve as the discriminator
because an approved redispatch may retain a prior entered attempt. The [canonical engine
architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns these mechanics; accepted ADR policy, public API and event schema are unchanged.

Three permanent cases use differing orders with live, cancel and grace endings. All
assert actual child starts/executor entries/terminals and final timer/lease cleanup.
Identical final-fixture original/removal controls each fail only grace (one fail/two pass);
fixed/restored pass all three. Parent reads complete original logs and verifies 5,044
physical input copies. Final fixed engine SHA-256 is
`0712fb3b4e1716fb51fc55987a82be52bc8bec2702a1a1698e81c3e02ad9b772`.
The fixture SHA-256 is `7c5410bb7d8eeb3a865d270f45f2e5596dbb9aaf502acebb95fca85238df4237`.

The first Parent reordered fixture used the wrong context property and timed out; it is
retained as a fixture failure, not product proof. A subsequent fixture narrowing failed
strict TypeScript and was corrected with separate discriminant filters. Controls were
rerun with that exact final fixture, then rerun after the source comment was made precise.
Earlier private strict/purity/lint/full-core checks pass (120 files / 2,891 cases), but
include two private flat-width controls and precede that comment-only adjustment. They
are not the landing suite count or exact-final source proof. The main landing gate has
its own original capture. No assertion is weakened or earlier failure erased.

## Complete review and evidence custody

Each reviewer independently covers all twenty paths/thirty-four literal hunks and the
actual continuations, without partition or inherited acceptance. Seven original checks
pass per reviewer: sequential cold shared/LLM/core builds, strict core, purity, scoped
lint and full offline core, 118 files / 2,886 cases, zero skips/unhandled errors.
The new Parent regression is additional attributed evidence, outside those original tests.

Parent reads both complete reports, all forty individual file and sixty-eight hunk
assessments, and fourteen original receipts/complete logs. Original metadata and exact
JSON/Markdown concordance are verified mechanically. Both 1,297-file archives, all heads,
literal hunks and complete patch match exact Git bytes; 17,696 original input copies
are physically verified. Each private tree has 99 actual dependency links, eleven
remapped workspace links. Owned inventories and original temporary outputs receive
physically verified 0444/0555 protection; no dependency target is traversed or chmodded.
The owner can reverse protection. Parent does not claim an independent full raw-Markdown
metadata read; individual assessment text is read and metadata identity checked.

| Reviewer | Report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `5318de8bdac99c3504ba990272d3070562bc00d147118522cc3fd7d3c1ffee9a` | `dd5c7303ae9eb30532eb17b5390c91654638c8fcecce3ed88ce59c5c03ae5e1b` |
| Lifecycle | `ef9fe97c1d70e76c2a790248d3cc62de073f24b0c7c004183bdf7dbdfc0082fe` | `eeda475974cd10e394eac0270008366ea94b0ebb5aaeb8901869a57638b89b6d` |

Evidence root: `/Users/cemililik/.codex/relavium-evidence/w7-dispatch-corrections-r7-20261009T200819Z`.
Parent controls remain in `w7-scheduler-readiness-r2-20261009T154612Z/parent-dispatch`.
Administrative audit assumptions and oversized/mistargeted reads are retained/qualified;
no source or original project capture changes. The 647,635-entry shared tree is identical
before explicit release at `2026-10-09T20:29:02.116927+00:00`. Only after release does the
correction land. Round 6 remains its historical first clean round; this rejected round
does not create a second clean round or accept the corrected source.

## Remaining work

Complete actor/MCP startup/custom-provider ownership, public departure and CLI host close,
sticky final money/effect health, original parked clocks and primary/input/host acknowledgements
remain required. The broader private actor prototype, including its original 38 CLI failures,
is unaccepted. Step 8 and final Step 12 remain open, all six W7 items stay OPEN (41/51),
and PR #90 remains draft/unmerged. No paid call, credential, ADR approval or maintainer
answer is pending. No W7 work is deferred by this checkpoint.
