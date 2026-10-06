# W7 group 3, round 5 correction — two narrow review rounds

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group3_r5_correction_contracts_r1`, `/root/w7_group3_r5_correction_runtime_r1`, `/root/w7_group3_r5_correction_contracts_r2`, `/root/w7_group3_r5_correction_runtime_r2`; parent `/root`
- **Subject**: nine-path correction `8e13771c..8e241377`, including `fa884a92`
- **Outcome**: Narrow correction accepted; full Group 3 remains changes requested

## Accepted correction and remaining boundary

Both fresh static reviews read all nine changed paths, the three complete changed tests, the full
new report and relevant actual callers. Neither finds a new material issue. The command regression
now awaits actual completion with its obsolete prompt held, rather than treating terminal writer
acknowledgement or fixed event-loop turns as command completion. A contrasting held genuine host
sweep requires SQLite to remain open until cleanup completes. Five actual SQLite/status JSON
variants pin the existing safe exclusion strings and scalar authority. The ordinary local-array
matcher preserves its former length semantics. The canonical JSON description and earlier broad
paused-handoff wording accurately describe these boundaries.

The [full round-5 High](2026-10-06T21-43-24-w7-systematic-group-3-round-5-review.md) remains open:
voluntary paused renderer finalization can outrun authored timer work or an unpublished writer.
Passing cancellation/card/cleanup controls do not repair that race. ADR-0103 is a draft under
independent design review; neither a new lifecycle decision nor dependent code is approved.
[ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md) also remains
Proposed. This record accepts neither all of Group 3 nor W7 or merge readiness.

## Independent execution and causal controls

| Review | Executed evidence | Disposition |
| --- | --- | --- |
| Round 1 contracts | Static only; nine paths and actual callers | Qualified clean |
| Round 1 runtime | Five fresh ordered package builds; strict actual inclusion; 11 files / 98 tests | Qualified clean |
| Round 2 contracts | Static only; all 18 hunks and actual callers | Qualified clean |
| Round 2 runtime | Five fresh ordered package builds; strict actual inclusion; 10 files / 96 tests | Qualified clean |

Round 1 adds two actual-command/CAS controls. They write/read a real orphan handle, invoke the real
host sweep, require that handle's physical deletion, then verify the actual terminal, one summary,
one SQLite close and released lease. The second injects a recognized cleanup rejection after the
real sweep and preserves the actual failed outcome. Removing the command's awaited cleanup causes
both controls to fail at early SQLite closure. An initial exact total-orphan-count expectation was
corrected to require this control's own handle deletion and a positive real count; the isolated CAS
also contained an earlier causal control's orphan. That preparation failure is retained.

Round 2 independently reuses the actual native harness. Removing the cleanup await fails the held
cleanup control. Removing the safe exclusion projection fails four actual JSON cases; legacy still
passes. Both production mutations are restored byte for byte before final strict/focus checks.
No causal failure is reported as a newly discovered product defect or a passing test.

Original verification remains the committed correction's `CI=true` result: 23 forced lint/typecheck/
test tasks, 369 files, 8,292 passing tests and 12 existing skips; isolation, formatting and diff checks
pass. These test/documentation commits do not acquire a new full-build or coverage claim.

## Evidence integrity and limits

Parent reads both complete reports per round, all dispositions and preparation/read/command/proof
registers, and the complete new first-round fixture. Independent nofollow physical audits compare
every actual inventoried metadata, file/hash, directory-child, link/manifest and source-pin field.
All 1,154 Original byte/hash/mode/identity receipts match before the corresponding freeze is released.
The full canonical regular-artifact union includes separately bound inventory/table self tuples.

| Reviewer | Actual entries | Regular artifacts | Complete union SHA256 |
| --- | --- | --- | --- |
| Round 1 contracts | 1,281 | 1,163 | `0cb1e973285e5450baeda0eb738608aeb71ca8ff4a0dd976c6329f6cce916cc6` |
| Round 1 runtime | 1,773 | 1,524 | `a4c0778b53945c2111c8165e7372adea8b91b85d8cbd08914a291b402a4cf7fe` |
| Round 2 contracts | 1,285 | 1,167 | `f52478d13f55b4e1cc03742efe88b4d1826dcdba48b496dcbeef808a76571db2` |
| Round 2 runtime | 1,767 | 1,522 | `056b9aba290d7a0cd766880e71e836099758c321af1130ccec666712c48770a1` |

The first abandoned static preparation is separately audited (1,279 entries / 1,161 artifacts), with
no semantic review verdict: its first shell omitted the requested explicit shell selection. The
replacement Own begins with a fresh compliant entry. All sealed Owns are permanently retired.

First-round runtime proves 15 actual mains / 35 source workers, 37 independent denials and 11 Own
package edges per proof. Second-round runtime proves 13 mains / 22 source workers, seven additional
independent denials and 11 edges, separately retaining the supplied 36-denial proofs. JavaScript
guards are not OS/kernel isolation or protection from arbitrary native code. Actual Apple/Vitest
environment bookkeeping, early pre-import assertion/syntax failures and repaired setup attempts
remain explicit. Static review has no runtime dependency closure; it does not certify those proofs.

Overlarge read output is qualified and consequential changed material is recovered in bounded
reads. Unchanged focus bodies are execution evidence, and unrelated roadmap/ADR spans are not
wholly semantically certified. Earlier reviewers' raw artifacts and historical CI counts are
attributed context rather than independently recertified by these reviewers. Parent metadata/schema
inspection and assertion-preparation misses caused no sealed-Own execution/mutation; they were
corrected before successful audits. Access time is excluded where a reviewer explicitly inventories
stable metadata. The sterile parent's global-ignore difference exposes only the name of the private
settings file; its content is never read.

Synthetic prompt input/timer callbacks do not establish real TTY or wall-clock expiry. The five
existing self-SIGINT modes retain Windows qualifications; these new cleanup/JSON cases are enabled.
There is no new Windows, whole CI, current remote/Sonar, coverage, live-provider or paid-call verdict.
Independent Groups 4–6 can proceed under the recorded plan while the separate lifecycle/ownership
approval gates and whole-wave acceptance remain open.
