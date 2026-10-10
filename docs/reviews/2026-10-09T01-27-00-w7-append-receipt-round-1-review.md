# W7 append/receipt integration — round 1

- **Type**: Code
- **Date**: 2026-10-09
- **Reviewer(s)**: `/root/append_receipt_r1_authority`, `/root/append_receipt_r1_lifecycle`
- **Subject**: `17fed25b..a35739a4`, all 17 paths / 57 textual hunks
- **Outcome**: No new verified scoped finding; fresh round 2 required

## Scope and decision

Both fresh reviewers inspect the complete cumulative append/receipt increment and return zero
verified product findings. Parent reads all 590 authority and 180 lifecycle report lines and
independently audits the evidence before releasing the source freeze. No source correction is
requested. This first round does not accept the increment, full ADR-0103, public host departure,
Step 8, Step 12, W7 or PR #90. Two NEW cumulative reviewers follow this record.

Per-append persistence acknowledgement, same-writer terminal-head advancement, sticky uncertain
terminal refusal, exact raw/prepared execution and narrow transferred/entered receipt lifetime
retain their separate responsibilities. A bounded primary terminal remains observable while
actual raw work may retain the exact fence and heartbeat. Lifetime observation grants no new
provider/media/prepare authority and does not consume the semantic money owner's error.

## Independent authority evidence

Four actual package baselines pass: Core 106 files / 2,823 tests; actual CLI 184 / 3,059 with
one existing skip; LLM 47 / 1,555 with eleven existing skips; DB 24 / 522. Together these are
361 files / 7,959 passing cases / 12 skips. Ten private native/reference controls separately
verify acknowledged terminal then two incurred receipts, failed versus lost terminal ACK,
original outbox recovery and genuinely acquired held/released successors. Corrected fixtures
use a fresh recovering engine and compare fence fields to the complete lease row; initial
6-pass/4-fail evidence remains retained. They are not product fixes or additional shipping cases.

Six isolated production removals compile and fail unchanged assertions: terminal head, sticky
terminal refusal, required realized ACK, required conservative ACK, retained fence and
nonconsuming money observation. Each restoration rebuilds the changed export and passes its
selection. Final 34 Core and 20 CLI focused passes overlap the baselines and independent controls.
Strict, purity/seam, lint, formatting and dependency fences pass. Private DB-sync wrapper fails
for a missing shim; directly interpreting declared installed Drizzle generation passes with
identical migration bytes. The failed wrapper is not credited as a passing wrapper invocation.

Parent verifies 2,771 sealed regular artifacts, all 1,233 shared/private tracked originals,
316 private emitted files, 9,272 final installed dependency files and six causal restorations.
Report SHA-256 `abd2edb9fb3920d03aff6269d4d280e510cab0b86e88d14f7c76b8cd5d265d4d`;
inventory `b81355e992049067b6868c4a2fc0228dca1f69f7189f810ae0aff211062380b8`;
seal `39aea873b155304b6c0d693d5ef635b7fcdd853b410e9bbabf77143fdd418db8`.

## Independent lifecycle evidence

The same four disjoint package baselines pass independently. Eleven fresh private controls
cover actual native ledger/fence/retention, held heartbeat, rejected scope, genuinely transferred
entered effect work and the shipping passive agent/dispatcher preparation followed by a
controlled exact `prepared.execute`. That last control invokes no provider. A deliberately
never-ending raw fixture leaves retirement pending; it does not certify safe host release.
Final 21 CLI and 34 Core focused passes overlap existing baselines; no counts are added twice.

Ten distinct mechanisms are removed in eleven mutant runs. The first entered-operation removal
survives an early observation and receives no kill credit. A separate one-tick observation
correction makes the same removal fail premature native release, with expected behaviour intact.
All corrected mechanism controls fail only under removal and pass after exact source/export
restoration. Fixture-only setup, retention-output, strict/lint and count corrections remain
preserved. No global timeout, depth, performance or product assertion is weakened.

Parent verifies all 2,796 private regular files, 286 directories, 99 symlinks, 25 selected
external references, 318 restored exports, 1,050 private cache files and all 1,233 tracked
originals. All 38,274 generated/cache files equal the reviewer's **midreview** snapshot.
Report SHA-256 `d2fe7ac65a4edd7061293eb9e00b8aac5919c32853c61c74d51d44ebf399450a`;
inventory `aad19043f5aca37d7c79e1b251ce9f33a43f263de539d55245c6f76a8c0e59d3`;
seal `a31ee110a347da492f2269dc79030f815ce07f66ff3e55bba408e73db043d6ed`.

## Evidence qualifications and exact-head checks

Neither reviewer nor Parent captured an initial shared untracked/generated/cache baseline.
Authority also lacks initial installed-byte, private pre-build generated and runtime-resolution
receipts. Final-only and midreview manifests cannot prove their earlier state. These custody
limits are explicit; the next round must capture its initial manifests before private work.
Individual installed public dependencies are reused with privately cold-built workspace exports
and real private cache directories. This is application/path isolation, not OS mount isolation.
No paid call, key access, shared source/build mutation or new approval occurs in either review.

Parent's actual cache-qualified `CI=true pnpm run ci` passes 391 files / 8,922 tests / 12 existing
skips, 23 initial tasks (12 cached), seven build/format tasks (five cached), and three offline
smokes. Exact `a35739a4` [PR run 37867735152](https://github.com/HodeTech/Relavium/actions/runs/37867735152)
and [push run 37867731646](https://github.com/HodeTech/Relavium/actions/runs/37867731646)
finish successfully, including required CI, coverage floor, Node 22 floor, Windows and peers.
Same-head SonarCloud and CodeRabbit pass; Sourcery skipped supplies no acceptance credit.
These are parent-fetched receipts, not independent reviewer remote/coverage invocations.

## Remaining work

Raw shipping SDK/iterator/poll/native and transitive transport integration, complete engine
actor/generation retirement, sticky final money/effects, original parked clocks, primary cursor
and public departure, acknowledged CLI input/host teardown and exit 8 remain open. Shipping
attempt accounting already precedes executor settlement; missing lower producer registration
alone does not establish a newly introduced monetary loss. Step 8, final whole-wave Step 12,
all six W7 register items and systematic ownership/lifecycle Highs remain open; 41/51 is unchanged.
Draft PR #90 remains unmerged. No further paid call, credential or ADR approval is required.
