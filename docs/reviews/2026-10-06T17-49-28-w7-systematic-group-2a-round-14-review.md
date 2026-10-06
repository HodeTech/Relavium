# W7 systematic group 2a, round 14 — qualified scoped acceptance

- **Type**: Code
- **Date**: 2026-10-06
- **Reviewer(s)**: `/root/w7_group2a_round14_contracts`, `/root/w7_group2a_round14_runtime`; stopped static supplement `/root/w7_group2a_round14_runtime/static_scope`; parent `/root`
- **Subject**: complete scoped review `90a5eee8..207b2716`, including correction `9f35173a`
- **Outcome**: Accepted with qualifications — no new substantiated finding in Group 2a; whole W7 and PR acceptance remain open

## Behaviour and independent verification

Contracts uses `gpt-6-astra / xhigh`; Runtime uses `gpt-6.1-sol / xhigh`. Both complete
the 66-path delta with one semantic disposition per path. The parent fully reads both reports,
all dispositions and Runtime's complete stopped static supplement. Production changes and
current session, turn, workflow, admission, accounting, registry and native SQLite callers are
traced. Changed test scenarios are distinguished from full test execution; unchanged historical
ADRs are not all claimed as semantic rereads. Earlier interrupted reviews remain qualified.

Fresh reconstructed-session controls confirm that cold resolver reentry keeps the nested send or
registered command's sole controller. Outer compaction refuses with existing `not_active` before
arming a controller. Abort/cancel reaches the actual owner; primary and passive consumers agree.
Warm memoization, cold cancellation, no-op/refusal paths and late successful-result abort retain
their existing behaviour. Removing only the post-plan idle check breaks these controls.

Independent generated-result matrices verify that typed output and accountable quantities are
captured before host pricing or teardown mutates the returned result. Known token/cache/media
quantities remain chargeable once on projection failure; simultaneous genuine pricing failure
keeps precedence. Genuine transport retry remains distinct from callback/refusal provenance.
Moving capture after host pricing breaks the ownership control. Opaque raw/tool deep ownership
and whole measured-request ownership remain outside this group's claim.

Fresh controls exercise actual B1/B2 admission waits, conservative and realized durability tails,
B3 sibling writers and final workflow ledger completion. Held, failed and cancelled acknowledgments
block egress or success and preserve the genuine writer's identity. Replacing the money-tail loop
with one snapshot breaks B1 controls; Runtime's B2 controls pass that specific mutant and are not
claimed as its discriminator. Native SQLite command reconstruction uses disjoint durable turn keys,
stores no result and refuses session replay. Serialized database inspection does not certify
physical disk/WAL erasure.

Each reviewer restores every production pin before final certification, removes only its own
package outputs, and passes five fresh ordered builds and strict fixture compilation. Contracts
passes **955 tests in 38 files, zero skips/failures**: 939 pinned cases plus 16 independent cases.
Runtime passes **934 tests in 36 files, zero skips/failures**: 901 pinned cases plus 33 independent
cases. Both execute all 34 changed test suites. Retained causal failures are diagnostic mutants,
not failing final production checks. The prior Original result of 8,195 passes / 12 existing skips,
23 forced tasks and six builds is historical evidence at this head, not a fresh full-suite rerun.

## Evidence integrity and qualifications

Before Original execution or modification resumes, the parent independently verifies every actual
recorded nofollow metadata, file content, child-list, link/manifest and inventory-self field. Each
Own has 1,136 restored source pins and pre-runtime Original receipt rows, 79 literal dependency
links and 11 canonical Own package targets. Own file identities are unique and disjoint from all
supplied Original identities. There are **3,553 actual physical entries**, including both inventory
files; 3,551 rows exclude only each inventory self while root children include its name. All
**153 externally delivered artifact byte/hash tuples** and Runtime's 75 static child tuples match.
Sealed Own trees are never executed, edited, cleaned or resealed by the parent.

| Own | Inventoried rows | Actual entries | Report SHA256 | Inventory SHA256 |
| --- | ---: | ---: | --- | --- |
| Contracts | 1,781 | 1,782 | `35b9490556ad00ee042e1c6cbe5930ea194c5320b164b254e6d696a5de54eea7` | `cc7c4d4d2ce6c5f03fa9b4773dfb08af46f15d7850f6dd74ea7ebd9b7b3e81ab` |
| Runtime | 1,770 | 1,771 | `fbcff19d5516ad99a28c681060f7c3349eb392970e3e933301f9fcff61e550e5` | `c91fda6204eb5a48faa7909aad18154ef457b302f42357bd18d53cbf1c372603` |

Before source imports, actual mains and source workers independently exercise credential/network
denials and Own package resolutions in addition to supplied preloads. Contracts reports 37 main
and 43 source-worker proofs; Runtime reports 32 and 81. These exercised guards are not a kernel
sandbox certificate. Runtime's earliest proof rows precede explicit actual-environment-key recording;
their retained launch environments do not retroactively supply that missing field.

Initial Apple Python environment injection, refused static entries, the stopped child's wrong-root
entry, clipped reads and fixture/type/assertion preparation failures remain explicit. Corrected reads
and final checks do not make these initial attempts green. Parent's first coverage/schema samples
and duplicated static-child source prefix fail, then bounded complete reads and the corrected full
audit pass without Own mutation. Inventories record five stable lstat fields; timestamps are neither
recorded nor invented. No automatic approval rejection is bypassed.

Group 2a is accepted within this stated scope. [ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
remains Proposed and unimplemented pending maintainer approval. The request-ownership High,
remaining systematic Groups 3–6, live-fixture-gated Steps 7–8, final Step 12, current Sonar and
whole W7 remain open. No live provider call, keychain read or additional paid generation occurs.
Draft PR #90 stays unmerged.
