# W7 systematic group 2a, round 5

- **Type**: Code
- **Date**: 2026-10-04
- **Reviewer(s)**: `/root/w7_group2a_round5_runtime`, `/root/w7_group2a_round5_contracts`; parent `/root`
- **Subject**: `development`, `90a5eee8..7bcdd70d`, all 22 changed paths
- **Outcome**: Changes requested; verified corrections committed, fresh complete round 6 required

## Findings and correction

The two fresh complete reviews verify the previous accounting correction, then reproduce three
remaining High implementation gaps:

1. Session presentation performs unguarded `instanceof` on a raw throwable. A proxy whose prototype
   inspection throws replaces the original error and suppresses the session terminal. The canonical
   engaged hard-cap slot remains consumed; neither reviewer claims a refund in this case.
2. Provider-method lookup happens after the invocation stamp. A throwing `generate` or `stream`
   getter is therefore reported as invoked even though no provider method ran. Actual-session retry
   controls reproduce the consumed slot with and without a governor.
3. Valid generated token usage disappears when the real cost tracker consults a throwing pricing
   overlay. Streaming retains observed valid stop quantities; the generated path loses them. This
   does not establish a priced amount, undercharging or a refundable admission.

Correction `902737eb` guards throwable prototype/diagnostic presentation after canonical accounting,
then emits a fixed raw terminal and rethrows the original value if classification cannot complete.
Provider methods are resolved and receiver-bound before invocation is stamped. A generation's usage
property is read once; a detached schema-valid copy also passes the existing cost tracker's
safe-integer arithmetic guard before it can be retained on pricing failure. No cost or invalid usage
is invented. Related parent controls reproduce hostile reflection in chain error normalization and
throwing/repeated usage accessors; normalization preserves the original non-public cause and records
the actual attempt. Consumer observers remain outside provider and accounting guards.

Canonical session and LLM contracts are updated, with an append-only ADR-0055 implementation note.
The arithmetic validator is shared internally rather than exported through the package's public
index. These repair existing EA2, invocation and diagnostic contracts without new financial policy,
capability policy, runtime dependency or vendor seam change.

## Independent evidence and limits

Runtime uses `gpt-6-astra`, `ultra`; contracts uses `gpt-6.1-sol`, `xhigh`. Both examine all 22 paths.
Restored runtime has **748 passing / 4 failing** tests across 16 files; all 653 permanent cases pass,
and 95 of 99 independent cases pass. Contracts has **694 passing / 5 failing** across 14 files;
all 619 permanent cases and 75 of 80 independent cases pass. Each completes strict checks and five
ordered fresh package builds. Runtime's additional read-only challenge is fully released too.

Narrow causal patches make runtime's 68 relevant cases and contracts' 80 controls pass, then are
restored exactly. They are diagnostic evidence rather than accepted production implementations:
blindly forwarding usage would accept invalid quantities, and guarding only `instanceof` would not
protect diagnostic getters. Ledger-finally, provider-invocation, known-prior-usage, typed prepared-cap
and all four tool-observer negative controls break the corresponding tests and are restored.
Actual Session/Registry/EffectJournal, Governor/MoneyDurability and WorkflowEngine controls retain
real implementation boundaries; key-resolution failures deliberately strip credential causes.

No whole-root CI, current Sonar certification, live capture, measured-request ownership, Steps 7–8/12,
W7 or PR acceptance is supplied by these reviewer runs. Adjacent parent DB/replay prototypes remain
unshipped and are not acceptance evidence for this group. Historical records are not rewritten.

## Parent validation

The permanent regressions first run on unchanged Original production code at `7bcdd70d`:
**19 failing / 287 passing** across three files. Eleven new session cases cover raw prototype and
classified diagnostic traps, ordinary/EA7 terminals and repaired method lookup. Sixteen chain cases
cover generate/stream lookup versus invocation, receiver identity, hostile original causes,
valid/zero/cache quantities, invalid token/media amounts, single-read result usage and pricing
mutation. Two real generated agent-turn cases distinguish paid and explicit zero-use accounting.

The corrected Original eight-file run passes **417 tests**. Final forced root lint/typecheck/test
passes **23 tasks**, **332 files**, **7,694 tests / 12 skips**; forced build passes six tasks.
Test isolation, added-source architecture, canonical relative file links and append-only ADR checks
pass. The full root run includes the final fixture lint corrections.

Preparation failures are retained and qualified: the first parent candidate trusts schema integer
acceptance beyond JavaScript's safe-integer limit; the permanent negative control catches this and
the correction shares the existing arithmetic guard. Two interrupted full-root runs expose test
method-binding and `Reflect.get` unsafe-return lint errors; these are corrected without suppression
or changing receiver assertions. Reviewer fixture import/constructor/key/turn-key/matcher mistakes
are corrected before their meaningful causal probes, not asserted as product defects. The initial
round-5 factory guesses a path count before the actual 22-path inventory; that unassigned tree never
executes source. No failed preparation result is presented as passing evidence.

## Isolation and integrity

Each reviewer independently verifies 1,101 physical source pins, 79 literal dependency links with
manifest hashes, 11 canonical internal targets and its exact bootstrap. Main and every-worker
credential/native-keyring/network denials and dependency resolutions precede source execution.
Every log, variant, fixture, distribution and physical directory/file/link entry is sealed. The
parent reads both complete reports and independently verifies **every 3,589 sealed entry** plus
all Original/source/link/bootstrap pins at unchanged `7bcdd70d` before Original resumes. No sealed
reviewer root is executed, mutated, reused or cleaned.

| Reviewer | Sealed entries | Report bytes / SHA256 | Inventory bytes / SHA256 |
| --- | ---: | --- | --- |
| Runtime | 1,786 | 43,617 / `d9b675a3dbc3fccd096c6e23b4bab5092d7ec21c4814c433a97ac6e40567d883` | 436,598 / `fe176cb577345c2259ee7bbfa991b8fe8aa36fcc4a230f9dc4be36a44877bda8` |
| Contracts | 1,803 | 52,285 / `3e94011818db19d27665574ff712740b6d8ee592987485463d2d02f85fc12179` | 486,779 / `43f1b2df06fdecd83d7656cd0d2496a9936d748e35d4b5e88f6ed1820f4f42da` |

The first runtime full-report output clips; its missing segment is fully recovered. The unsealed
parent verifier initially rejects runtime's additional resolved-target field and contracts' new
inventory header. It is expanded to check every released field, literal link and computed target;
no sealed artifact changes. Both full-release and every-entry receipts precede Original correction.

## Follow-ups

Fresh complete round 6 is required before group closure. No live call occurs.
[Proposed ADR-0102](../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
requires explicit maintainer approval before dependent implementation. Remaining systematic groups,
measured-request ownership, Steps 7–8, whole Step 12, current Sonar and PR acceptance remain open.
