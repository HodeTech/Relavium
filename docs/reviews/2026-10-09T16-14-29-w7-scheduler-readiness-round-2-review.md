# Review: W7 scheduler readiness, round 2

- Date: 2026-10-09
- Type: Code + Security
- Reviewer(s): @codex (`readiness_r2_authority`, GPT-6.1 Sol, xhigh;
  `readiness_r2_lifecycle`, GPT-6 Astra, xhigh), plus Parent's complete report/map,
  source, original-input, physical artifact and shared-tree audits.
- Subject: `e0927f29acf5c2ee8a111bb174025697275ba6ee` through
  `95f3923a3c154639b960298bca3cfab920dda942`: nine paths / ten literal hunks.
- Outcome: accepted within the cumulative readiness scope; zero new scoped findings.
  Two inherited dispatch Highs and the remaining whole-W7 obligations stay open.

## Independent review and checks

Both NEW reviewers examine the complete cumulative change, including the original
readiness implementation, getter/receiver correction, twelve permanent cases, diagnostic
backstop correction and first-round record. Each maps every path and literal hunk with
separate read scope, rationale and disposition. Neither partitions the diff or inherits
the original verdict. Complete affected functions and relevant registry, scheduler,
settlement, writer, retirement, cancellation and lease continuations are read; neither
claims a deep reading of every unrelated historical engine/roadmap line.

Each independently passes seven prescribed original checks: strictly sequential cold
shared/LLM/core builds, strict core typecheck, core purity, scoped lint and the full
offline core suite: **110 files / 2,862 cases / no skips**. No reviewer edits source or
tests, executes new probes/mutants, installs dependencies, uses network/credentials or
runs shared-tree project commands. Root CI, coverage, compiled CLI, provider and native
host observations are not independent reviewer results.

Raw readiness is registered before public method acquisition, and remains owned after
the scheduler's abort race completes. A reentrant getter cannot enter its returned
method after cancellation; live invocation preserves the handle receiver. Claimed
vertices that never enter `node:started` unwind without inventing running executors.
The nested diagnostic backstop lets scheduler reevaluation complete after the tested
one-shot ID/clock publication fault. The twelve cases require bounded terminal progress
and eventual exact lease/timer cleanup separately. Mechanics remain in the
[canonical engine architecture](../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103).

The [first-round record](2026-10-09T15-44-15-w7-scheduler-readiness-round-1-review.md)
remains CHANGES REQUIRED: Lifecycle discovered the secondary diagnostic fault first;
Parent reproduced it and then informed Authority. This is one consolidated discovery,
not two independent discoveries. Parent's later correction and before/fixed/removal
controls are attributed evidence, not retroactive first-round reviewer proof.

## Known inherited dispatch Highs remain required work

Parent discovered two existing defects in separate private preparation during this round.
Both reviewers independently corroborate their conditions from the frozen source, but
neither reruns Parent's controls nor accepts its private proposed correction:

1. After an entered `node:started` append completes, the existing guard checks settlement
   and the grace latch but omits abort. Cancellation during a held append can therefore
   freshly arm an authored node deadline. This vertex has already left the readiness
   unstarted-claim set. Correction must refuse fresh dispatch and settle that matching
   entered node without leaving phantom running work.
2. The existing detached dispatch catch reads raw `Error.message` or calls `String(cause)`
   before its inner fallback. Raw text can enter a public failure; a throwing coercion
   can reject the catch itself and strand normal terminal progress. Correction must use
   content-free diagnostics and own the complete failure continuation.

These Highs predate the readiness increment and belong to explicitly open complete
scheduler/dispatch integration. They are retained for correction within W7, not deferred.
The narrow readiness verdict does not certify those branches or whole-host correctness.

## Parent custody and freeze audit

External evidence lives under
`/Users/cemililik/.codex/relavium-evidence/w7-scheduler-readiness-r2-20261009T154612Z`.
Parent reads both complete reports and all eighteen path/twenty hunk rationales, then
verifies exact Git base/head/patch/blob/archive identities, all nine head snapshots,
ten hunks, original wrappers/manifests/logs/input copies and 99 individual dependency
links per reviewer, including eleven private workspace remaps. **32 original captures /
40,000 copied eligible inputs** are physically verified.

Authority's inventory contains 32,694 regular files including three bound self-controls,
2,701 directories and 99 links; Lifecycle's contains 12,646 regular files, 1,024 directories
and 99 links. Each also retains 981 original temporary files, with 36 and 20 original
temporary directories respectively. Parent rereads owned regular bytes/link targets,
applies and verifies 0444/0555 protection without traversing dependency targets, and binds
the inventory controls separately. The owner can reverse permission protection.

| Reviewer | Final report SHA-256 | Parent seal SHA-256 |
| --- | --- | --- |
| Authority | `03be6ab141cf80cc8bea6ce411d95c612d28b01dba2a926332025ff3bf54db7b` | `2ffe6f719788fb02c902c1ebacb6250511924b762c44d1666401037731b4c439` |
| Lifecycle | `37b0842359032e9b9315f054baf072070b1d9727ce955d8962a1383bcc81312c` | `65016817ceee125ce82d9b03d4ed3d19352d0e0b712f4735574c128dc7a892fc` |

Authority retains two failed administrative reads (an out-of-range span and guessed
abort filename), with corrected reads separately captured. Lifecycle retains transcript
qualifications for wrong cwd/log suffix/ADR filename and oversized direct reads; none is
invented as an original runner receipt. All prescribed checks pass. Parent likewise
recovers its initially oversized combined report/map read in bounded complete chunks.
The post-release helper-copy typo is qualified separately and touches no main source.

The complete **647,245-entry** before/after shared-tree comparison has zero differences;
both snapshots hash to `a6873fad8f85626f083a6eec9c74ad5b4dbd760ef71e1f4581c02d8488639107`.
HEAD and clean status stay unchanged. Explicit freeze release occurs at
`2026-10-09T16:14:29.012515+00:00`, before acceptance documentation is written.
Parent's earlier exact-input correction CI passes 415 files / 9,133 cases / twelve
existing skips, with cache-qualified tasks, fences, compiled CLI and three offline smokes.
It is neither fresh coverage nor final whole-wave acceptance. Finite reference-host
faults do not prove native backpressure, permanently unavailable clocks or public departure.

## Remaining work

Complete scheduler/dispatch/timer/resume/pre-handle roots, MCP startup/all actors,
custom-provider descendants, final sticky receipt/writer/money health, parked clocks,
public departure/primary acknowledgement and CLI teardown remain required, alongside
Step 8 compaction/recovery and whole-wave Step 12. All six W7 register items stay OPEN
(41/51 closed); PR #90 stays draft and unmerged. No further paid call, credential,
maintainer decision or ADR approval is pending.
