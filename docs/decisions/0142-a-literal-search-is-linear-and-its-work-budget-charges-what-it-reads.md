# ADR-0142: A literal search is linear in the text it reads, and its work budget charges what it reads

- **Status**: Proposed — 2026-11-23. The implementation is on `development`; the maintainer's acceptance is pending. Acceptance tier: the tool-host bounds are a resource control, so the D64 security sitting applies before this is accepted.
- **Date**: 2026-11-23
- **Amends**: [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md) (the `search_files` bounds clause, in place, dated note).
- **Related**: [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) (the editing and search grant), [ADR-0141](0141-a-table-too-wide-for-its-grid-renders-as-records.md) (the table fallback; both decisions come from one analysis, `docs/analysis/private/2026-11-22-markdown-table-fallback-and-search-work-budget.md`), the tool registry reference ([tool-registry.md](../reference/shared-core/tool-registry.md)).

## Context

`search_files` bounds a call in files scanned, bytes, matches, entries and **work units** (`SCAN_WORK`, 16 Mi). The work budget is shared with the ignore matcher. Before this decision the search charged `(3L + 1)(m + 1)` for each line of length `L` and pattern length `m`, paid before the line was read, and then searched with a native `indexOf` retry loop.

Measured on 2026-11-23:

1. **The charge over-stated the work by roughly the pattern length.** On a synthetic TypeScript-shaped corpus of 300 files (about 12 MB, lines of about 80 characters), the old counter stopped at file 9, after about 0.36 MiB. A 16 MiB pass of a 14-character identifier over typical lines takes about 6.6 ms natively. So a repository-wide question could not complete, while the text it had to read was cheap to read.
2. **A cheaper charge is not a bound.** Charging one unit per retry-line (the review's first suggestion) would drop the pattern term, but native `indexOf` cost does depend on the pattern. On adversarial families, one 16 MiB pass cost 22 ms at pattern length 14 and 290 ms at 200 for one family, and 345 ms at 1000 for another. A per-attempt charge would under-count that by the pattern length, so the ceiling would stop meaning what it says.

## Decision

1. **The literal matcher is Knuth–Morris–Pratt**, in-house (`apps/cli/src/engine/tool-host/literal-search.ts`, no dependency). One pass per line, a failure table built once per search, and every occurrence reported in order including overlaps. A rejected whole-word match continues from the next position with no rescan.
2. **The budget charges the units a line is read in.** A case-insensitive line is folded (the fold reads the line), and the matcher reads the haystack once. A line costs `L + 1` case-sensitively and `L + F + 1` case-insensitively, where `F` is the folded length; the `+ 1` is the loop's overhead. The pattern is read once per file, to build its failure table, and is charged `m` once per file, not per line. The ignore matcher's charge is unchanged.
   - *Corrected 2026-11-23, while this ADR was still Proposed.* The first implementation charged `m + 1` for every line. The pattern is never re-read per line, so that charge was not work. It made a short-line repository stop at the work ceiling before the byte ceiling: on the repository itself, a case-sensitive search stopped at 958 files and 12.4 MB, and after the correction it reaches the 1,000-file cap at 13.1 MB.
3. **The ceilings are hard limits for the whole call, not a per-call budget to spend.** The ignore and glob matchers keep their own ceiling, `SCAN_WORK` (16 Mi units), so an adversarial ignore file cannot buy more work. The literal search has its own ceiling, `SCAN_SEARCH_WORK` (64 Mi units), and the byte ceiling is 64 MiB. The file ceiling is 10,000. The entry and directory caps (10,000 and 1,000) are shared with the directory walk that `list_directory` uses, and they are unchanged here.
   - *Changed 2026-11-23, while this ADR was still Proposed.* The first version kept every ceiling at its earlier value and used the work counter as the search budget, so a typical repository stopped at a file or byte count that was only a budget. The reached ceiling was then reported as a partial result to the person and the model. The change makes a reached ceiling mean that the search really was too large for a single call. The reported limit remains `incomplete` with the ceiling named, so an honest partial result is still possible.
4. **The model is told what a partial result means.** The `search_files` description says that `stats.incomplete` makes the matches a partial answer, to be narrowed before a literal is judged absent.

## Consequences

### Positive

- Measured on the same corpus: the 12 MB absent-needle search completes in about 86 ms with `incomplete: false`, where the old counter stopped at about 0.36 MiB.
- The matcher's cost does not depend on the pattern. On the three adversarial families at pattern lengths 14, 200 and 1000, one 16 MiB pass took 56–85 ms, where native `indexOf` took 22–345 ms.
- The budget now means what it says: a unit is a unit of text read, so the ceiling can be reasoned about without a worst-case estimate.
- The matcher is checked against the retired `indexOf` loop as an oracle on 3,000 seeded random inputs (`literal-search.test.ts`), so the change is semantics-preserving by test.

### Negative

- A typical literal scan is slower per character than the native loop: about 33 ms against 5 ms per 16 MiB at pattern length 14. File I/O dominates in practice, and the case-insensitive path was already slower.
- Reach rises. Which ceiling binds depends on the text. On the repository itself, after the correction: a case-insensitive search stops at the work ceiling (682 files, 8.2 MB), because the fold reads each line twice; a case-sensitive search stops at the 1,000-file cap (13.1 MB). The byte ceiling (16 MiB) binds first only for text with long lines, where the per-line overhead is small. A repository with more than 1,000 searchable files is still incomplete, as the scope contract already said.

### Neutral

- **Not done here: a visible partial-scan notice under the tool line.** A person still does not see `incomplete` unless the model reports it. The fix needs an additive, content-free scan verdict on `agent:tool_result` (a run-event schema change), the chat tool-row projection, and the tool-review view. The run views overlap the MVP-8 work in progress on the Home, so it is parked for a separate decision.
- The ignore matcher's accounting (`work += rel.length + workspaceRel.length + 2`) is measured separately and is unchanged.

## Verification

- `literal-search.test.ts`: the failure table, overlapping occurrences, code-unit matching, early acceptance, and agreement with the `indexOf` oracle over 3,000 seeded inputs.
- `fs-mvp3.test.ts`: a long adversarial line is read once and rejects every non-word occurrence; about 4 MB of ordinary text completes with `incomplete: false`; a case-insensitive search over forty 1 MiB files stops in exactly the file the charge predicts (the thirty-fifth, at the 64 Mi search ceiling), and that count fails when the pattern is charged per line again; a late binary file is refused at the 64 MiB byte ceiling.
- The `fs.test.ts` and `fs-discovery-ignore-work.test.ts` suites pass, which keeps the adversarial ignore-rule ceiling in place.
