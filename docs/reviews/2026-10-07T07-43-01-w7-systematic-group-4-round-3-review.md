# W7 systematic group 4, round 3 — validate before streaming exclusion

- **Type**: Code
- **Date**: 2026-10-07
- **Reviewer(s)**: `/root/w7_group4_contracts_r3` (gpt-6-astra, xhigh), `/root/w7_group4_runtime_r3` (gpt-6.1-sol, high); parent `/root`
- **Subject**: All 32 changed paths `7e79f366..58849a9e`, followed by the narrow streaming-filter correction
- **Outcome**: Changes requested; one verified High corrected, fresh complete round 4 required

## Verified finding and correction

Both independent reviewers identify the same High. Two pre-parser streaming exclusions trust the
SQL event discriminator before the sole stored-row validator: interruption discovery's early skip
and the state reader's SQL predicate. Changing only a genuine human or budget suspension's stored
type to a streaming label hides the pause while leaving its JSON payload unchanged. Actual native
reconciliation appends an invented `run:failed{internal}` at sequence 2 and changes paused to failed.
Full display and strict replay correctly refuse the same mismatch.

The correction validates every persisted row through existing `readStoredEventRow` before omitting
genuinely parsed streaming events from the returned state fold or suspension reducer. It covers all
four excluded streaming types. Known rows retain schema, run-id and sequence checks; matching
genuinely unknown rows retain display/discovery tolerance and strict replay refusal. Discovery
remains aggregate fail-closed before any lease, terminal or materialized-state mutation.

The returned state fold still excludes streaming events and Home retains its bounded run fan-out.
Persisted-history validation now includes streaming JSON/schema cost; unchanged parse cost or a
fixed upper bound on history work is not claimed. Canonical documentation and source comments
record that tradeoff; ADR-0100 receives an appended dated correction. No second validator, migration,
event, error code, approval rule or artificial SQL-column fixture in the reference store is added.

## Runtime and causal evidence

The runtime reviewer completes fresh ordered shared/LLM/core/DB/MCP builds and the supplied 28-file
focus: **636 passing tests, zero skips**. A 16-case independently authored extension passes after
two explicitly corrected fixture-selection/schema errors. Strict compilation and actual compiler
inclusion pass before its final diagnostic extension. Raw-guard removal yields **13 failures /
16 passing controls**; sweep-preservation removal yields **seven failures / nine passing controls**.
Exact production restoration and a fresh ordered build follow.

Its initial genuine SQLite/engine streaming-label probe establishes **two required-refusal
failures / one genuine streaming control**. The later all-four-label extension still corroborates
eight actual invented terminals, but incorrectly calls the reader-only API on a writer store; its
nine failing tests and TypeError are **not** state-reader refusal evidence. The agent's turn was
interrupted by a platform content filter. Parent requests factual closure, and the reviewer
performs no further application run. No final clean strict/focus rerun or completed runtime
acceptance is claimed.

Parent independently reproduces the original SQL-label mutation with **four failures / nine
controls**, using actual file-backed SQLite and WorkflowEngine. It authors permanent regressions
using the actual `createRunHistoryReader` API: all four read surfaces; unknown payload/SQL-type and
all four streaming-label mutations; genuine streaming exclusion, pause and high-water controls;
malformed JSON, wrong run-id and wrong sequence in genuine streaming rows; repeated native
reconciliation refusal without run/event/lease/dispatch changes and genuine healthy neighbours.

The two expanded permanent files contain **81 passing cases**. With the existing run-history file,
**164 tests pass**. Parent's restored configured focus passes **669 tests in 28 files**, and final
strict compilation passes. Restoring only discovery's pre-parser exclusion yields **19 failures /
62 controls**; restoring only the state-reader SQL exclusion yields **11 failures / 70 controls**.
Each causal check uses freshly built JavaScript. Exact restoration, fresh builds and the successful
164-case run establish the correction; earlier preparations guessed the wrong reader API before
execution and are retained as qualifications.

Original passes **23 forced lint/typecheck/test tasks**, **373 test files**, **8,397 passing tests /\n12 existing skips**, **six forced builds**, isolation, formatting and diff checks. The later source\nedit only wraps an explanatory comment; build and formatting cover it. These are local checks,\nnot current coverage/Sonar, real terminal, Windows, provider or whole-wave acceptance.

## Independent evidence audit and qualifications

Parent fully reads both sealed reports and all 32 dispositions from each reviewer. Independent
no-follow inspection validates **3,126 physical entries / 2,763 regular artifacts**, all directory
children and actual stable metadata, complete regular unions including inventory/table self
artifacts, all four full external self bindings per reviewer, and all 1,162 source pins and Original
receipts per reviewer. All 79 runtime links, including 11 Own edges, match. Both sealed Own trees
remain permanently retired.

The runtime register audit validates **31 actual commands**, their argv/cwd/environment/exits/logs,
160 reviewer proof rows, 2,128 guard records, 78 independent preload proofs, 36 actual source-worker
records and four actual native children. Actual child PID/argv/environment/parent and guard/source
ordering are corroborated. Child-body reading occurred after the first focus; that preparation
miss remains qualified. The read register has 74 rows and 73 valid source intervals, but does not
carry every file hash or every separately logged complete test-body interval. Its claimed ten
complete changed bodies total 4,999 lines; this is not a new Parent full semantic reread of them.

The static audit independently validates all **184 bounded read intervals**, **2,095 patch lines**,
source mappings and complete coverage of the ten changed test bodies. It records 194 Python
commands: 193 numerical zero exits and one externally bound successful final seal. Early embedded
bootstrap Python strings were not contemporaneously copied to the on-disk register; exact missing
strings are not invented. No static reviewer JS/TS or application runtime occurred.

Runtime initial oversized/truncated guide/patch displays, later bounded replacements, pre-pin
Python helper reading, uninstrumented preparation commands and the interrupted final extension
remain explicit. Parent audit preparation corrected tuple-list display, register/env aliases,
JSONC handling and glob/setup assumptions before acceptance; no sealed evidence was modified.
JavaScript/process-seam guards do not establish a kernel/native-code sandbox. No paid provider call,
key read, full CI, coverage, Windows or W7 acceptance is inferred from these records.

## Remaining gates

**Group 4 remains changes requested.** A fresh complete independent round 4 must inspect this
correction and the whole group. Group 3's paused-departure High remains open; ADR-0102 remains
Proposed and ADR-0103 unapproved. Groups 5–6, live-gated Steps 7–8, Step 12, final CI/coverage/Sonar,
W7 and draft PR #90 acceptance remain open. No additional paid generation is authorised.
