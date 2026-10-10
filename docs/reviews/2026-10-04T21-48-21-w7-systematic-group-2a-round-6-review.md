# W7 systematic group 2a, round 6

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round6_runtime`, `/root/w7_group2a_round6_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..dddbc784`, all 24 changed paths
- **Outcome**: Changes requested; verified corrections committed, fresh complete round 7 required

## Findings and correction

Both fresh reviewers verify the preceding protections and reproduce six overlapping High families:

1. R5 retains generated quantities after pricing failure but omits `priced: false`. Actual core and
   MoneyDurability publish a fully-priced zero row. The real governor retains its reservation; neither
   reviewer claims a refund or a known undercharge.
2. Nested typed diagnostic getters escape normalization. An actual session can lose its invocation
   record and make a second call past `maxTurns: 1`; a status getter can lose conservative durable
   settlement. This is distinct from outer throwable presentation.
3. Successful generated and streamed accounting still uses mutable provider quantities after their
   validation. Actual pricing mutation can rewrite totals to zero, NaN or 400/600 instead of 4/6.
4. Missing required generated input/output counts fail schema validation, but that failure is ignored
   and arithmetic accepts undefined, producing a successful NaN priced amount.
5. Cancellation during provider-method lookup still permits invocation with an already-aborted signal.
6. Pricing and core cause classifiers perform unguarded prototype inspection and replace the private
   original cause. The actual session still emits one terminal and retains its paid slot; no refund
   or suppressed terminal is asserted for this separate manifestation.

Correction `b4134e99` uses an internal owned, validated, frozen Usage snapshot for pricing, records,
generated results and stream stop delivery. Direct CostTracker/public cost entry also captures before
host pricing; required counts cannot be absent. Failed pricing carries trustworthy quantities with
an explicit unpriced flag and retains conservative commitment. Nested typed diagnostics are captured
inside guarded normalization. Opaque causes follow normal turn mapping; typed budget/money identities
and raw consumer callback identities retain their established handling. Admission ownership remains
until discharge succeeds, and cancellation is checked after method lookup/setup before invocation.

The generated result is rebuilt from its normalized fields without reading usage twice. Consumer
observers remain outside provider/accounting catches. Canonical session/LLM contracts and append-only
ADR-0055/0077 implementation notes accompany the existing-contract repair. No new dependency or
financial policy is introduced. Returned Usage ownership is distinct from Proposed ADR-0102's whole
measured Request ownership, whose explicit approval gate remains pending.

## Independent evidence and limits

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Each independently reviews
all 24 paths with actual Session/Registry, Governor/MoneyDurability and WorkflowEngine controls.
Restored runtime: **853 passing / 16 failing**, 869 tests across 17 files; all 758 permanent cases
pass, with 95/111 independent controls passing. Restored contracts: **824 passing / 7 failing**,
831 tests across 17 files; all 756 permanent cases and 68/75 independent controls pass. Their selected
permanent sets differ; these totals are not summed as disjoint coverage.

Strict private checks and five ordered fresh traced builds pass. Narrow causal controls fix the
corresponding failures, then exact source restoration reproduces them. Mandatory-ledger-finally,
engagement and all four tool-notification negative controls break actual implementation oracles and
are restored. Experimental patches diagnose mechanisms and are not accepted production code.

Neither reviewer certifies current whole-root CI, current Sonar, live capture, SDK wire/request
ownership, Steps 7–8/12, W7 or PR acceptance. Documentation limits are explicit: relevant changed
mechanisms are reviewed; hashes or stored full logs do not imply a semantic reread of every historical
ADR/test/roadmap paragraph. No verified family is accepted or deferred to close this group.

## Parent validation

Corrected permanent regressions run on exact `dddbc784` production after a forced baseline build:
**25 failing / 19 passing**, 44 tests. They exercise actual sessions, conservative commitments,
realised rows, direct cache/media pricing, missing counts, accessor reads and cancellation boundaries.
Corrected Original focus passes **461 tests** in nine files. Final forced root lint/typecheck/test
passes **23 tasks**, **333 files**, **7,738 tests / 12 skips**; forced build passes six tasks.
Formatting, test isolation, added-source architecture and Accepted ADR prefix checks pass.

Preparation failures are retained: a Parent preimage differs by one non-runtime comment and application
refuses before writes; a subsequent unchanged-source build is not corrected-build evidence. Exact
runtime preimages are reconciled and current Original wording retained. A candidate result spread
rereads usage; an existing permanent test catches it and explicit normalized fields correct it. A
readiness fixture initially mutates before stop exists; it is corrected and the exact-head baseline
rerun. Private-to-permanent extraction has a stray closing delimiter; formatting catches it. An
interrupted full-root run finds 20 fixture lint errors; typed Error proxies, explicit async completion,
used observations and unknown-typed Reflect return correct them without suppressions. The final full
root includes those corrections. Failed preparation is never presented as acceptance evidence.

## Isolation and integrity

Both reviewers fully release their Own trees. The parent reads both complete reports and verifies
**every 3,922 physical entry**, all 1,102 source byte/mode/inode pins per Own, 79 literal named links
and manifests, 11 internal canonical targets and exact bootstraps against unchanged `dddbc784` before
Original resumes. Runtime's complete narrative, non-JSON register and all 188 command-register rows
are read; repetitive shared environment/path fields are factored losslessly and reconstruction is
checked. Contracts' complete 29,433-byte report is read in two unclipped segments.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,954 | 217,646 / `3d4321faca8db99ad772d09db6b48256c38b00b63cbdd02d6994cea59092889a` | 664,323 / `406d60dffcd84111ea859236bb9fdaccea68e91c06f720d7a8cec7297f086b17` |
| Contracts | 1,968 | 29,433 / `e4cdd29ed6949ed995edc342c78fbbd6e8ae4fcefbc698859ff627aa028de58a` | 909,249 / `27e213b3ee198c7a3c46a9769398a967e661f6b7e86f710aa0bc410860f6bd8a` |

The unsealed parent verifier checks both declared physical-inventory schemas, including root listing
conventions, every directory/file/link field and dependency manifest. Sealed reviewer trees are never
executed, changed, reused or cleaned. Every-entry/read receipts precede correction. The first report
lookup guesses REPORT.md and fails; the named REPORT.txt is then read and exactly verified. Runtime
common-register factoring initially assumes JSON through the entire tail; the explicit non-JSON
sections are read and both complete JSONL groups are losslessly reconstructed.

## Disposition

Fresh independent complete round 7 is required after this correction. Group 2a remains open, together
with measured-request ownership, remaining systematic groups, Steps 7–8/12, current Sonar and PR #90.
Historical review records remain point-in-time observations; no W7/merge acceptance is claimed.
