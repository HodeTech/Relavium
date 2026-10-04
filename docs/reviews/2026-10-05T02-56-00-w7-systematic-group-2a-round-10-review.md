# W7 systematic group 2a, round 10

- **Type**: Code
- **Date**: 2026-10-05
- **Reviewer(s)**: `/root/w7_group2a_round10_contracts` (`gpt-6-astra`, `xhigh`), `/root/w7_group2a_round10_runtime` (`gpt-6.1-sol`, `xhigh`); parent `/root`
- **Subject**: frozen `development`, `90a5eee8..ff295acd`, all 39 changed paths
- **Outcome**: Changes requested; verified corrections committed, fresh complete round 11 required

## Verified findings

Contracts identifies two High lifecycle families. A controller factory or turn-start sink can throw
before the operation's cleanup region and leave the session permanently running; compaction has the
same controller gap. These setup refusals invoke no provider and do not demonstrate a lost paid slot.
Post-success completion or commitment-flush callbacks separately lack observer provenance, allowing
a typed exception to publish its private diagnostic, provider/retry classification or false budget
explanation. Actual Session → session sink → event bus controls reproduce both families. The real
completion-clock case has one provider invocation, one priced 11-microcent cost event, 3/4 tokens and
one consumed cap slot. A recording-before-throw sink sees two terminal drafts; the real clock case
publishes one error terminal. Neither establishes a paid retry or missing realized row.

Runtime identifies one Blocker family: generated content is captured by reference although its root
properties are guarded. Nested typed getters and later provider-owned part mutation re-enter core
classification or downstream node-outcome reflection. Actual Workflow/Dispatcher/Runner/turn/chain/
tracker/store controls demonstrate two paid attempts and two durable 46-microcent rows (46 → 92), a
false pause without a governor, private persisted diagnostics, and counterfeit failure-writer
attribution despite one acknowledged actual row. Four manifestations are not counted as four bugs.
These are offline known-price observations, not live provider charges. Top-level getter containment,
provider-class and plain-content controls distinguish the existing repaired boundaries.

## Corrections and permanent controls

`639d1ace` commits typed generated-content projection. `c6749597` commits lifecycle cleanup/provenance.

The guarded returned-result projection parses content through the existing shared ContentPart schema
and validates stop reason before attempt notification. Schema-defined fields and nested typed media
shapes detach from provider-owned parts; the single accountable usage snapshot and already folded
known price remain intact. A projection fault produces one fixed non-retryable failed record. Opaque
tool argument/result and raw payload deep ownership are not claimed; Proposed ADR-0102 remains
unapproved and unimplemented.

A common controller initializer restores operation state and rethrows the original setup value on
send, compaction and user-command failures. A throwing start notification has equivalent pre-provider
cleanup. Completion/flush failures carry exact local observer provenance into private-safe terminal
presentation, preserving classified delivery, raw/opaque identity, successful canonical quantities,
consumed hard-cap slot and cancellation precedence. A throwing event sink cannot guarantee publication;
recording before throwing is distinct from a published terminal. Canonical contracts and dated
append-only Accepted ADR-0055/0082 notes describe these bounded repairs.

Four new permanent files add **94 controls**:

- [38 lifecycle, real bus, projection and genuine money controls](../../packages/core/src/engine/session-lifecycle-origin.test.ts) promote Contracts' independent fixture.
- [23 actual generated-content/accounting controls](../../packages/core/src/engine/generated-content-ownership.test.ts) promote Runtime's independent workflow fixture.
- [28 actual Session second-tool/compaction/EA7 controls](../../packages/core/src/engine/session-external-origin.test.ts) promote Runtime's other fixture.
- [Five command initialization controls](../../packages/core/src/engine/session-initialization-boundary.test.ts) are additional parent controls, not attributed to either reviewer; they use a synthetic registry and no native process.

Imports, evidence-only filesystem logging, unused imports and async fixture scheduling are adapted
for permanent source. Hostile throwable identity checks remain primitive booleans, avoiding assertion
formatter reflection. Behavioral, money, privacy and authority assertions remain intact. The existing
unsafe actual-cost/conservative-settlement suite is unchanged.

## Independent and parent verification

Contracts' exact restored source passes five fresh ordered builds, strict private compilation and
903 permanent controls in 21 files. Its independent 38-case fixture has 15 failures / 23 passes.
A first causal intervention regresses typed controller delivery; corrected cleanup-and-rethrow makes
all 38 pass, with 256 existing controls also passing. The initial reserve-key oracle is wrong and is
corrected rather than counted as a product defect.

Runtime's exact restored source passes five fresh ordered builds, strict fixtures/setup/config and
1,023 permanent controls in 23 files. Its two fresh independent files have 47 passes / four failures
across 51 cases, including a real shared B1 earlier-writer/zero-egress control. Its Own causal experiment
uses the complete result schema and passes only the original 11 controls; the possible usage-identity
change and absence of broad causal regression coverage are explicit. It is not a shipping candidate.

The unsealed parent instead parses typed content/stop reason while preserving the accountable usage
identity. Existing focus passes 571 controls in nine files; lifecycle focus passes 320 in seven
partially overlapping files. Promoted independent fixtures plus additional command controls pass all
94, with strict compilation. Parent causal substitution of only the pre-correction fallback file
reproduces four failures / 19 passes; substitution of only the pre-correction session file makes all
five new command controls fail because the next command remains wedged. Both experiments restore
exact candidate bytes and ordered builds. They use the otherwise staged Parent graph, not a complete
exact-Original baseline. Parent builds are incremental and not claimed fresh certification.

Final forced Original lint/typecheck/test passes **23 tasks, 343 files, 8,044 tests / 12 existing skips**.
Forced build passes six tasks; isolation passes. The first full check fails solely on a new fixture's
prefer-const declaration; the immutable binding is corrected without suppression, and interrupted
concurrent tasks are not represented as a complete passing run. An initial command fixture calls a
nonexistent snapshot method; its failed preparation is retained and replaced by observable next-command
liveness, with the unrelated API-presence assertion removed. Two read-only patch-path preparations
and two inventory-sample key mistakes are retained as preparation errors, not acceptance evidence.

## Integrity and evidence limits

Both complete reports are read without truncation. The parent independently audits every **3,741 actual
physical entry**, all 1,113 source byte/mode/unique-inode/nlink pins and pre-runtime Original receipt rows
per Own, 79 literal named dependency links/manifests and 11 canonical Own targets, plus exact bootstrap,
report and recorded inventory hashes. Original remains clean at `ff295acd` until both full reports and
actual-entry audits complete. Sealed Own trees are never executed, edited, cleaned or resealed by the
parent; only nofollow static reads and inert copies into another unsealed area are used.

**Contracts seal qualification:** its reported inventory contains 1,879 entries, but the release process
calls datetime.strptime after its final audit, lazily producing three Python cache files and changing
one cache-directory record. The parent rejects the exhaustive-at-release claim, retains every mismatch
and independently records all 1,882 actual entries in a separate Control audit. The reviewer withdraws
that claim in an external static addendum; the original report/inventory remain unchanged. Runtime's
1,859-entry seal matches every field; its timestamp/import preparation precedes the final no-bytecode
walk. Recorded hashes identify artifacts and do not themselves establish semantic completeness.

| Reviewer | Recorded / actual entries | Report bytes / SHA256 | Recorded inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Contracts | 1,879 / 1,882 | 14,816 / `77c88cb4d539d4370a98f9d1ed759b3332350eee7449bf1a5c37d76e691cabd4` | 753,255 / `f5d2ba010f9d34babcab3e7b93365c49ef184b962b758b056d7410abf53fa098` |
| Runtime | 1,859 / 1,859 | 16,803 / `251529c324dccc6d0d152691dec705c6d7fc9f7f26faf15cb1858cec6268d13c` | 717,060 / `7d61695b8765cbddbaf53c84727b28ab13b972e9559a0819b77e1226d2b59315` |

Complete reports separately name command/read/change/proof/preparation/runtime and actual workflow
observation registers. All retained physical bytes are audited; no full semantic reread of every
unchanged historical ADR/test/register is claimed. Early Apple shim/environment refusals, reconstructed
static command history, unmeasured first-read timestamps and fixture preparation mistakes remain
qualified. Later clean launches do not certify earlier startup gaps retrospectively. Independently
written main and actual worker proofs establish exercised credential/network denials and canonical Own
resolutions before source imports, not a kernel sandbox certificate. No automatic execution-risk
rejection occurs. A separate narrow Sonar formatter experiment is not either complete R10 review.

## Disposition

Fresh complete round 11 must review the entire corrected group and its callers. Group 2a, remaining
systematic groups, Proposed ADR-0102 approval, Steps 7–8/12, Sonar, W7 and draft PR #90 remain open.
All seven authorised live-generation slots remain exhausted; no additional paid call is authorised.
