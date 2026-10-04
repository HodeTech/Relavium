# W7 systematic group 2a, round 8

- **Type**: Code
- **Date**: 2026-10-05
- **Reviewer(s)**: `/root/w7_group2a_round8_contracts` (`gpt-6-astra`, `xhigh`), `/root/w7_group2a_round8_runtime` (`gpt-6.1-sol`, `xhigh`); parent `/root`
- **Subject**: `development`, `90a5eee8..ee1c8e80`, all 29 changed paths
- **Outcome**: Changes requested; both reviews complete, verified corrections committed; fresh complete round 9 required

## Verified findings

Both reviewers independently verify two High families. The grammar verifier retains the provider's
mutable terminal while its confirming read resumes provider code. Revised token/cache/media quantities
can then become a fully-priced zero actual instead of the original charge. Runtime additionally
verifies a changed stop reason and a held fatal auth diagnostic becoming retryable, including two
actual calls when no content was committed. Stable EOF/teardown controls and grammar refusals remain
valid; hard turn capacity remains consumed. The second family is mutable diagnostic copies and locally
synthesized failures exposed before retry classification. Direct attempt observers can rewrite auth
into timeout or install a throwing getter, causing another actual invocation or suppressing a stream
terminal. Cancellation still prevents a second invocation; no cancelled-egress defect is claimed.

Runtime independently verifies a third High family through actual WorkflowEngine/AgentRunner/
Dispatcher/MoneyDurability. After a paid attempt, host clock failure shaped as a genuine retryable
AgentTurnError produces two paid calls and two 73-microcent rows with cumulative totals 73 and 146,
and publishes the synthetic private diagnostic. A genuine BudgetPauseError at the same observer
creates an unauthorised budget pause with one paid call/row and no configured governor. Both generate
and stream reproduce. The fixture cancels a counterfeit pause solely to drain events; it never approves
it. The generated fixture's later media-validation failure does not cause the earlier paid retry.
No actual credential disclosure or live charge is asserted.

## Correction and regressions

`1f778985` commits terminal/diagnostic ownership; `983e7826` commits observer origin and caller handling.

The verifier owns the held stop root and validated usage, or the detached error root/diagnostic,
before the confirming read. Non-terminal chunks and grammar semantics remain intact. Every attempt
diagnostic is frozen before observer delivery, including commitment copies and synthesized failures.
The internal turn outcome carries exact external emit/readiness/record origin separately from core
attempt escape and internal admission settlement. Workflow presentation is fixed, internal and
non-retryable; real money durability errors retain their original writer ownership. Session preserves
classified delivery, raw rejection, exact error identity, canonical quantities, EA7 and the hard cap,
with fixed observer presentation. No class-wide suppression, marker pattern or request ownership policy
is introduced. Canonical contracts and dated Accepted ADR-0055/0077/0082 notes describe these repairs.

The [51 permanent terminal/diagnostic regressions](../../packages/core/src/engine/terminal-observer-boundary.test.ts)
reproduce **31 failing / 20 passing** against unchanged shipping code before correction. The
[actual workflow tests](../../packages/core/src/engine/observer-error-provenance.test.ts) expand to
12 stream/generate/provider/turn/budget controls; their original-code baseline has four failures.
Six additional [session controls](../../packages/core/src/engine/session-callback-boundary.test.ts)
pin classified delivery and private-safe presentation. Existing unsafe-cost settlement tests stay
unchanged rather than weakening their raw-refusal/retention assertions.

## Independent evidence and limits

Contracts passes all 833 permanent tests; its 45 new cases reproduce 11 failures. The combined private
causal correction passes 878 tests; held-only and copied-diagnostic-only factors isolate four and seven
remaining failures respectively. Runtime's expanded 285 new cases reproduce **35 failing / 250 passing**:
15 held-terminal, 16 diagnostic and four workflow failures. Three factors independently remove exactly
those sets; the combined private intervention passes **1,118 tests**. Final exact source restoration,
five fresh ordered builds and strict compilation reproduce **35 failing / 1,083 passing**, with all
833 permanent cases passing. Those experimental source interventions are causal evidence, not accepted
shipping code. Seventy fresh traced builds across 14 cycles, 118 actual workers, 351 denial/resolution
proof rows and all 11 canonical targets are retained and physically verified.

Neither review accepts whole-root CI, current Sonar, SDK measured-request ownership, live captures,
Steps 7–8/12, W7 or PR #90. Proposed ADR-0102 remains unapproved and has no dependent implementation.
Prior passing scopes do not waive these new defects.

## Parent verification

The parent executes inert copies only in an independent unsealed area. The final formatted correction
passes **1,226 checks in 22 files**, including the two copied independent fixtures, permanent focus,
new regressions and the real grammar performance test; overlapping promoted/copied cases are reported
as such. Five fresh ordered builds and private strict compilation pass. After the final origin split,
six focused files pass **454 tests**, including both independent fixtures and the unchanged actual
allowance settlement suite; five incremental ordered builds and strict compilation pass.

The first full Original run detects an invalid actual-cost settlement being incorrectly presented as
an observer error. Separating internal admission failure from external origin corrects it without
changing the existing test. Its aborted CLI worker is secondary to Turbo cancellation, not an
independent product finding. The next run identifies two unused imports in the promoted test; they are
removed without suppression. Final forced Original lint/typecheck/test passes **23 tasks**, **336 test
files**, **7,831 tests / 12 existing skips**; forced build passes six tasks and test isolation passes.
Earlier failed preparations remain retained and are excluded from passing evidence. Initial Parent
prototypes also expose classified-session delivery and hostile-proxy presentation regressions; the
final correction preserves delivery and fixed presentation, and their controls pass.

## Integrity and qualification

The parent reads both complete reports, losslessly reconstructs and reads their complete available
registers, and verifies every **4,175 physical entry**, all 1,107 source byte/mode/independent-inode pins
per Own, 79 literal links/manifests, 11 internal targets and exact bootstraps against clean unchanged
`ee1c8e80` before Original resumes. Runtime's 322 register objects and 350 helper/fixture/variant/log
registry entries match retained physical evidence. Sealed trees are never executed, mutated or cleaned.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Contracts | 1,980 | 236,127 / `12cbed861db645afc4bc6167971ce235828bb338585600ed4ffbb7816b637968` | 862,194 / `4e13680640583dedc6b4daab07ee033c6298a65aca6b80068986c4f5651b6295` |
| Runtime | 2,195 | 633,380 / `b642b21e95ee848abc40096e6bffee7a4425560f722ba7ed725bf967bfa98fc7` | 863,470 / `a1b614beeffd57ea17839cd60faecf17ffae1b36b1190e3777ff70f9b5c82554` |

Early default-zsh startup and outer Python read/driver environments were not observed; clean Node
children and later `/bin/sh`, `login:false`, explicit clean-environment launches do not certify those
earlier gaps retroactively. Main and actual worker network/keyring/native-credential denials and
canonical resolutions remain independently proven. Runtime's initial seal environment assertion fails
before report/inventory writes; five observed interpreter/compiler/locale key names are subsequently
admitted explicitly and its failed preparation remains preserved. Missing timestamps and environment
fields remain qualified rather than invented. No automatic execution-risk rejection occurs in this round.

## Disposition

Fresh complete round 9 must challenge the whole corrected group and its callers. Group 2a, ADR-0102
approval, remaining systematic groups, Steps 7–8/12, current Sonar and PR #90 remain open. All seven
authorised live generation slots remain exhausted; no additional paid call is authorised.
