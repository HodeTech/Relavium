# W7 systematic group 2a, round 3

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round3_runtime`, `/root/w7_group2a_round3_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..c15c55a7`, all 12 changed paths
- **Outcome**: Changes requested; one inherited High corrected, fresh complete round 4 required

## Finding and correction

Both fresh independent reviewers verify all four repaired tool-outcome notifications, then reproduce
an inherited callback-accounting gap beyond them. A raw token/reasoning/cost sink, readiness rejection,
retry sleep rejection or cooldown clock failure can escape after actual provider engagement. EA2
metadata reaches the session only on `AgentTurnError`; the raw failure path knows only successfully
returned turns. Known billed usage becomes zero and the engaged hard-cap slot is returned. With
`maxTurns: 1`, another send invokes a third provider/key lookup. EA7 abort has the same omission;
explicit zero-use settled attempts independently reproduce the cap failure.

First actual provider content can also precede `onAttempt`; interrupting readiness or delivery there
proves engagement without an attempt record. Missing current usage must remain unknown. The contracts
reviewer separately verifies actual settlement before a throwing cost sink with real `BudgetGovernor`
and `MoneyDurability`: admission/cumulative spend remains safe, but the realized row never starts.
Neither issue was introduced by the earlier tool-notification corrections.

Parent correction `e7973031` carries canonical known usage and engagement in a package-internal
outcome, consumed by `AgentSession` before terminal settlement. Public `runAgentTurn` rethrows the
exact original host/money/pause error; its classified error metadata remains available. Non-error
provider chunks mark engagement before readiness. Valid observed stop usage is consumed exactly once
by an attempt record or retained on an interrupted failure. Failed raw turns consume their engaged
slot; a successful turn already counted before a failing flush is not counted twice. Terminal cancel
continues to own its sole cancellation event. Public unexpected-error messages stay fixed and safe.

Realized recording starts in the cost emission's `finally`, after the host's authoritative cumulative
fold. Ordinary notification identity remains intact; a synchronous record/snapshot fault takes
precedence if both synchronous operations fail. A durable sink rejection remains a separately owned
`LedgerDurabilityError` at the shared join. No stale cumulative total, invented attempt number, released
actual charge or widened provider seam is introduced. Existing B1/B2/B3 ordering remains intact.

## Independent evidence and limits

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Both review the complete
initial repair, prior corrections, tests, documentation and relevant downstream callers. Final
restored runtime HEAD has **612 passing / 23 failing** tests across 14 files; all 23 failures are
private real-session probes for this one High family. Contracts has **270 passing** permanent
checks and **54 passing / 18 failing** independent checks. All 36 contracts tool-observer cases pass;
runtime expands those with hostile values, multi-round and zero-use controls. Strict private checks pass.

Narrow diagnostic notification wrappers restore accounting but violate two established raw-error
identity contracts, so they are causal evidence, not accepted implementations. The final parent
carrier preserves both original expectations. Real later-round budget fail/pause controls pass and
must not be recast as another defect. Actual approved default retry/fallback, typed cap refusal before
admission/credentials, native JSON compatibility and settled effect/privacy controls remain clean.
First-stop readiness usage was a review coverage bound; the permanent correction explicitly tests it.

No live provider, SDK wire ownership, whole-root CI, whole-W7 or PR acceptance is claimed by these
reviewer runs. The separate measured-request ownership High and Proposed ADR-0102 remain open.

## Parent verification

Three permanent regression files run against unchanged Original production before correction:
**40 failing / 13 passing**. After correction, all 53 pass; the broader eight-file run passes 341.
The new 40-case session suite pins raw identity, accumulated/zero usage, EA7, first content/stop,
terminal cancel and once-only successful accounting. Five actual governor/ledger cases cover delivery,
storage, snapshot and combined failures. Actual `WorkflowEngine` loses its transient cost timestamp
and still persists one correctly attributed realized row. Existing consumer/updateCost raw identity,
shared sibling-money barriers and genuine tool recovery remain passing.

Forced root lint/typecheck/test passes **23 tasks**, **331 files**, **7,625 passing tests / 12 skips**.
Forced build passes six tasks; test isolation, append-only ADR, architecture and diff checks pass.
The first root attempt fails only the new fixture's `prefer-const`; corrected full rerun passes.
Private fixture iterations retain wrong chunk shape/kind, governor option, incomplete typecheck scope,
async-assertion and store/terminal-field assumptions, corrected before the meaningful baseline.
Private-field narrowing is repaired through a typed reader, with no cast. Large clipped reads and
incorrect guessed paths are recovered; they are not successful checks. Full prior reviewer reports
retain their own setup, control and recovery qualifications.

## Isolation and integrity

Each fresh reviewer owns 1,097 physical source pins, 79 named literal dependency links/manifests and
11 canonical internal targets. Main and every test worker deny real credentials/network before
execution. Five ordered fresh package builds and the main proof precede tests. Exact source/link
restoration, commands, worker proofs and all logs/variants remain in the exhaustive physical seal.

After both full releases and complete report reads, parent independently verifies **every 3,498
sealed entries**, every source pin, literal link/manifest and internal target against unchanged
`c15c55a7`. A separate static Sonar job extended the freeze; its complete 170-key adjudication and
1,363-entry seal are also read/verified before Original resumes. It is not a fresh acceptance cycle
or certification of the current remote gate. The three complete reports cover 4,861 verified entries;
none of their sealed roots is executed or mutated by parent.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,746 | 47,643 / `7d3f37a4ab9cf529307b7319ed97a829823b9ab83845a34088e17f50bd5c272c` | 416,025 / `1e265befa19423bb5e19f5725bc0cd676c70d15b518cf998a08470d78302b8ec` |
| Contracts | 1,752 | 35,007 / `750b91008732d5133b9e9c2d38126902789049bc62afe9602680c61c86cad7cd` | 357,787 / `1f8e63b54a809d03b5d450322416779f29f22f7b3b5a68bffe3217dd43ed8fdf` |

## Follow-ups

Fresh complete round 4 is required before group closure. No live call occurs.
[Proposed ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
requires explicit maintainer approval before dependent implementation. Ownership, remaining systematic
groups, Steps 7–8, whole Step 12, current Sonar and PR acceptance remain open.
