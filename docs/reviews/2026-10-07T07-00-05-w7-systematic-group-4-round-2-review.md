# W7 systematic group 4, round 2 — refuse corrupted forward discriminators

- **Type**: Code
- **Date**: 2026-10-07
- **Reviewer(s)**: `/root/w7_group4_contracts_r2`, `/root/w7_group4_runtime_r2`; parent `/root`
- **Subject**: All 29 changed paths and 47 hunks `7e79f366..8d5b4499`, followed by its narrow correction
- **Outcome**: Changes requested; one verified High corrected, fresh complete round 3 required

## Verified finding and correction

Both independent reviewers identify the same High in SQLite `readStoredEventRow`. Its tolerant parser
returns undefined for an unknown JSON discriminator before comparing the parsed event with its
stored columns. A row whose SQL `event_type` remains `human_gate:paused` or `budget:authorization`
can consequently disappear from the suspension fold. Actual native engine reconciliation appends
an interruption `run:failed{internal}` and changes the damaged run to failed instead of refusing
corruption. The healthy neighbour stays paused and no executor runs; these controls establish a
discovery/trust defect rather than dispatch or a hypothetical unsafe cast in the reference store.

The correction checks the raw JSON discriminator against its stored type before tolerant parsing.
All three read surfaces use the existing structured `CorruptRunEventError`. Aggregate discovery
refuses before reconciliation claims a lease or writes a terminal, retaining both runs and all
evidence. Matching genuinely unknown column/payload types retain display/discovery tolerance and
strict replay refusal. The reference store has no duplicate SQL discriminator column; no artificial
parity fixture, migration, error code, approval rule or skip-and-trust policy is added.

The round-1 preservation correction withstands the fresh review: acknowledged activation preserves
the canonical floor and captured deletion in one transaction, or retains corrupt evidence and blocks
allocation. Native controls also cover held acknowledgement, inactive activation, concurrent
post-snapshot effects, healthy 99-to-100 reservation without reopening, late deletion-chunk rollback,
malformed transcript data, orphan privacy and shared error identity.

## Runtime and causal evidence

The runtime reviewer uses fresh ordered shared/LLM/core/DB/MCP builds. The supplied 26-file focus
passes **623 tests**, and the restored focus with ten independently authored lifecycle cases passes
**633 tests in 27 files**. Its six-case discriminator fixture has **two required-refusal failures**
and **four passing controls**, including the actual unsafe engine consequence. Strict compilation
includes all 26 supplied files, both independent fixtures, setup and configuration and passes.
Expanded checkJs separately reports existing TS7006 in `budget-signal-writer.mjs:14`; it is neither
suppressed nor repaired in this group.

Removing only the preservation invocation in the reviewer's TypeScript and freshly built JavaScript
fails five independent lifecycle controls while five unrelated controls pass. Exact restoration
precedes the successful final 27-file focus. Removing current-producer `keptTurnCount` produces the
expected TS2345; exact restored strict compilation passes.

Parent independently authors permanent native regressions that change **only** the discriminator
of a genuine persisted suspension: six DB refusals across display/discovery/replay, two genuine
suspension controls, and matching-unknown policy control. Four additional actual SQLite/engine cases
require both human and budget corruption to refuse repeatedly without events, materialized-run
changes, leases or dispatch; genuine neighbour controls remain resumable. All **13 tests** pass.
Removing only the new raw guard from Parent TypeScript and fresh JavaScript yields **eight failures
and five passing controls**. Exact byte restoration restores all 13 passes. This is an independent
causal check; the reviewer's fixture replaces the whole payload body and is not misrepresented as a
literal discriminator-only mutation.

Original's correction passes **23 forced lint/typecheck/test tasks**, **373 test files**,
**8,329 passing tests / 12 existing skips**, **six forced builds**, isolation, formatting and diff
checks. These are local checks, not coverage, current remote Sonar or whole-wave acceptance.

## Independent evidence audit and qualifications

Parent fully reads both sealed reports and both independent fixture bodies, all 29 path dispositions
from each reviewer, the claim/preparation registers, and the actual command/read/proof records.
Independent no-follow inspection validates all **3,082 physical entries / 2,719 regular artifacts**,
all directory children and recorded stable metadata, complete regular tuple unions, all 1,159 source
pins and Original receipts per reviewer, and all 79 runtime dependency links including 11 Own edges.
Externally supplied self inode/time/block bindings are checked; additional unavailable external-self
metadata is not inferred. Sealed Own trees remain permanently retired.

The runtime audit verifies 19 actual commands and logs/exits, 186 proof rows with 36 exercised
network/keyring denial checks and 11 Own resolutions each, 3,098 guard records, 90 independent
preload proofs, 57 actual source-worker records and eight actual native children. Actual child PID,
argv, environment, parent identity and before-source ordering are corroborated. The six budget
helpers prove source entry after their actual-main guard; the two disclosure helpers prove their
guard before native SQLite require and do not import Relavium source. Test-framework-derived
environment keys are individually bounded. This is declared JavaScript/process-seam evidence,
not an OS sandbox, real TTY, Windows, live provider or paid-call claim.

Static review covers all 47 hunks, the eight complete changed test bodies (4,732 lines), the full
new 96-line review record, relevant callers and 15 added relative links. Static execution is Python
only. Its first six command summaries are reconstructed, and initial oversized reads and late
numerical ADR ordering remain qualified. Runtime initial background reads also have truncation/order
limits; three early helper hashes precede documented audited Own-only interventions. Parent's audit
preparation corrected ordering/path-prefix, framework-environment and native spawn-versus-fork
schema assumptions before accepting the records. An initial Parent test invocation omitted the new
CLI fixture from the isolated include list; explicit inclusion and the complete 13-case positive,
causal and restored runs supply the actual evidence. Neither a full-file hash nor a truncated
display is counted as a complete semantic read of unchanged background documentation.

## Remaining gates

**Group 4 remains changes requested.** This correction requires fresh complete independent round 3.
Group 3's voluntary paused-departure High remains open. ADR-0102 remains Proposed and ADR-0103 is
an unapproved draft. Groups 5–6, live-gated Steps 7–8, Step 12, final CI/coverage/Sonar, W7 and draft
PR #90 acceptance remain open. No additional paid generation is authorised.
