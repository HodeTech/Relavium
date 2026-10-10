# W7 systematic group 4, round 1 — preserve quarantined identity evidence

- **Type**: Code
- **Date**: 2026-10-07
- **Reviewer(s)**: `/root/w7_group4_contracts_r1`, `/root/w7_group4_runtime_r1`; parent `/root`
- **Subject**: 21-path Group-4 implementation `7e79f366..4dd5b064`, followed by its nine-path correction
- **Outcome**: Changes requested; verified High corrected, fresh complete round 2 required

## Verified finding and correction

Both independent reviewers identify the same High. Open-time isolation leaves a corrupt legacy
session's effect-turn high-water mark at zero. Actual acknowledged activation subsequently deletes
its committed identity evidence. Reservation then reconstructs a smaller floor from the transcript
and reissues a used key. Native SQLite reproduction includes canonical scopes `:2` and `:99` plus
malformed `:01`: opening succeeds, reservation initially refuses, acknowledged activation deletes
all three rows, then reservation returns `2`. Healthy and prepared-row controls distinguish this
defect from intended cleanup or continued refusal.

The correction invokes the existing legacy initializer for an existing session **inside the captured
committed-row deletion transaction**. A trustworthy floor and every deletion chunk commit together;
invalid history refuses the sweep and preserves all evidence. A chunk failure also rolls back the
floor. Missing-session orphan privacy erasure remains available. The active surface gives a fixed,
content-free warning that evidence was retained and effect-turn allocation remains blocked. No
sentinel, migration, inferred corruption repair or new public error code is introduced.

The canonical contract is [database-schema.md](../reference/shared-core/database-schema.md#session-content-parts),
linked from [effect-journal.md](../reference/shared-core/effect-journal.md). The correction note is
appended to [ADR-0098](../decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md),
preserving its earlier accepted body.

## Coverage and execution

Contracts uses GPT-6 Astra at xhigh effort for all 21 changed paths, changed hunks, six complete
regression bodies, eight documentation changes and actual callers. It checks typed-error compatibility,
aggregate discovery refusal, rejection reconciliation, current projection count and ADR notes.
Its runtime confirmation is attributed to parent, not represented as its own execution.

Runtime uses GPT-6.1 Sol at high effort. Five fresh ordered builds and strict actual fixture/setup/
configuration inclusion pass. Its final **24-file / 594-test** focus includes seven independent
activation/SQLite controls and the native budget child fixture. Its startup causal mutation fails
five corrupt-history controls; healthy and operational-fault controls still pass. Exact restoration
precedes the final seven-control run. Removing the current producer's `keptTurnCount` fails strict
compilation, with the original bytes then restored.

Parent prepares the correction separately: five fresh builds, strict inclusion and **25 files / 585
tests** pass. Removing only the sweep's identity-preservation call fails seven selected controls in
three files; 44 cases are filtered by that negative run, not shipping skips. Exact restoration and
five rebuilds are followed by **all 51 cases passing** in those files. Permanent controls cover four
malformed scope variants, acknowledged activation, healthy cleanup without another open, and floor/
deletion rollback across 101 captured rows.

Original `CI=true` verification passes **23 forced lint/typecheck/test tasks, 371 files, 8,316 tests
and 12 existing skips**, six forced builds and isolation. Formatting and diff checks pass before the
correction commit. This does not establish whole GitHub CI, coverage, current Sonar, Windows,
live-provider or real TTY acceptance.

Expanded strict JavaScript checking separately reports existing TS7006 in
`apps/cli/src/commands/fixtures/budget-signal-writer.mjs:14`, outside the reviewed paths. It remains
a tools/test-quality follow-up; the strict TypeScript result does not hide it.

## Evidence integrity and qualifications

Parent reads both complete reports, all 21 dispositions and the complete independent native fixture.
Full command/read/proof registers are parsed and checked against actual artifacts; overlarge register
output is not represented as wholly rendered human reading. Independent nofollow audits compare every
recorded stable metadata field, byte/hash, sorted directory-child list, link literal, resolved target/
manifest field and source pin. All 1,158 current Original byte/hash/mode/identity receipts match before
the freeze is released. Each complete canonical regular-artifact union includes separately bound
inventory and tuple-table self artifacts.

| Reviewer | Actual entries | Regular artifacts | Complete union SHA256 |
| --- | --- | --- | --- |
| Contracts | 1,293 | 1,175 | `43caaf27bd207ff381463df53100b222e6f11c0997ee1e159982a522d8be807f` |
| Runtime | 1,774 | 1,529 | `18dd114c5d83b29b4b93001706d1ef773ef20ff920d26384af439903e301047f` |

Runtime registers contain 191 proof rows, 55 actual source-worker rows and nine actual native child
processes. The final targeted run supplies actual main/worker environment values and child pre-import
proof; earlier rows have narrower environment fields. All 19 runtime command environments, 36
independent denials and 11 Own package edges are checked. JavaScript guards are not kernel isolation
or arbitrary native-code protection. Both sealed Owns are permanently retired; correction preparation
uses a separate unsealed tree.

First-entry environment overrides and the initial wrong static task-path assumption are qualified:
later natural Apple Python entry is verified before semantic/runtime work, without claiming flawless
initial protocol. Bounded unchanged-body reads, repaired setup attempts and truncated displays remain
explicit. Runtime's displayed Vitest duration crosses a clock discontinuity; its controller records
41.954 seconds, and the display is not elapsed-time evidence. Access time alone is excluded from the
declared stable metadata inventory. The private settings file is never read.

## Follow-ups

Fresh independent reviewers must review the complete corrected Group-4 scope before acceptance.
The [Group-3 paused-departure High](2026-10-06T21-43-24-w7-systematic-group-3-round-5-review.md) remains
open. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md) remains
Proposed; ADR-0103 remains an unapproved draft. Groups 5–6, live-fixture-gated Steps 7–8, final Step 12,
current CI/Sonar, whole W7 and draft PR #90 remain open. No additional paid generation is authorised.
