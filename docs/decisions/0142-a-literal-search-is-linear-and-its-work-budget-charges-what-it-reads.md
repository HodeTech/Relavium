# ADR-0142: A literal search is linear in the text it reads, and its work budget charges what it reads

- **Status**: Proposed — 2026-11-23. The implementation is on `development`; the maintainer's acceptance is pending. Acceptance tier: the tool-host bounds are a resource control, so the D64 security sitting applies before this is accepted.
- **Date**: 2026-11-23
- **Amends**: [ADR-0120](0120-the-toolbelt-grows-and-a-tool-call-shows-what-it-does.md) (the `search_files` bounds clause, in place, dated note).
- **Related**: [ADR-0116](0116-the-built-in-chat-agent-can-edit-and-the-starting-mode-is-configurable.md) (the editing and search grant), [ADR-0143](0143-a-wide-table-keeps-its-grid-and-records-are-the-last-resort.md) (the table side of the same analysis), the tool registry reference ([tool-registry.md](../reference/shared-core/tool-registry.md)), and the built-in tool bounds ([built-in-tools.md](../reference/shared-core/built-in-tools.md)). The analysis behind both records is a private, gitignored note and is not linked.

## Context

`search_files` bounds a call in files scanned, bytes, matches, entries and **work units** (`SCAN_WORK`, 16 Mi). The work budget is shared with the ignore matcher. Before this decision the search charged `(3L + 1)(m + 1)` for each line of length `L` and pattern length `m`, paid before the line was read, and then searched with a native `indexOf` retry loop.

Observed on 2026-11-23. Two of these figures are not measurements of the repository, and the text says which:

1. **The charge over-stated the work by roughly the pattern length.** This is a computed result, not a run: the old formula, applied to a synthetic TypeScript-shaped corpus of 300 files (about 12 MB, lines of about 80 characters), stops at file 9, after about 0.36 MiB. A reviewer later reproduced the stop by running the old code on a synthetic corpus. The 6.6 ms figure for a native pass over typical text came from a scratch benchmark, not from the repository.
2. **A cheaper charge is not a bound.** Charging one unit per retry-line would drop the pattern term, but native `indexOf` cost does depend on the pattern. Scratch benchmarks (not committed) on three adversarial families gave 22 ms at pattern length 14 and 290 ms at 200 for one family, and 345 ms at 1000 for another. A per-attempt charge would under-count that by the pattern length, so the ceiling would stop meaning what it says.

## Decision

1. **The literal matcher is Knuth–Morris–Pratt**, in-house (`apps/cli/src/engine/tool-host/literal-search.ts`, no dependency). One pass per line, a failure table built once per file (the search runs per file), and every occurrence reported in order including overlaps. A rejected whole-word match continues from the next position with no rescan.
2. **The budget charges the units a line is read in.** A case-insensitive line is folded (the fold reads the line), and the matcher reads the haystack once. A line costs `L + 1` case-sensitively and `L + F + 1` case-insensitively, where `F` is the folded length; the `+ 1` is the loop's overhead. The pattern is read once per file, to build its failure table, and is charged `m` once per file, not per line. The ignore matcher's charge is unchanged.
   - *Corrected 2026-11-23, while this ADR was still Proposed.* The first implementation charged `m + 1` for every line. The pattern is never re-read per line, so that charge was not work. It made a short-line repository stop at the work ceiling before the byte ceiling: on the repository itself, a case-sensitive search stopped at 958 files and 12.4 MB, and after the correction it reaches the 1,000-file cap at 13.1 MB.
3. **The ceilings are hard limits for the whole call, not a per-call budget to spend.** The ignore and glob matchers keep their own ceiling, `SCAN_WORK` (16 Mi units), so an adversarial ignore file cannot buy more work. The literal search has its own ceiling, `SCAN_SEARCH_WORK` (64 Mi units), and the byte ceiling is 64 MiB. The file ceiling is 10,000 for the search, but the entry cap (10,000, which counts directories too) binds first, so in practice the entry cap is the limit. `find_files` keeps its own 1,000-file ceiling (`FIND_FILES`): it opens every candidate, and a hard link is counted and then skipped, so widening the search ceiling must not widen find. The entry and directory caps (10,000 and 1,000) are shared with the directory walk that `list_directory` uses, and they are unchanged here.
   - *Changed 2026-11-23, while this ADR was still Proposed.* The first version kept every ceiling at its earlier value and used the work counter as the search budget, so a typical repository stopped at a file or byte count that was only a budget. The reached ceiling was then reported as a partial result to the person and the model. The change makes a reached ceiling mean that the search really was too large for a single call. The reported limit remains `incomplete` with the ceiling named, so an honest partial result is still possible.
4. **The model is told what a partial result means.** The `search_files` description says that `stats.incomplete` makes the matches a partial answer, to be narrowed before a literal is judged absent.

## Consequences

### Positive

- A scratch run (not committed) completed the 12 MB absent-needle search in about 86 ms with `incomplete: false`, where the old formula stopped at about 0.36 MiB.
- The matcher's cost does not depend on the pattern. Scratch benchmarks (not committed) on three adversarial families: the first is a run of `a` searched for `a` repeated `m - 1` times then `b`; the second is `b` then `a` repeated `m - 1` times, searched in a run of `ba`; the third is `ab` repeated `k` times then `c`, searched in a run of `ab`. At pattern lengths 14, 200 and 1000 one 16 MiB pass took 56–85 ms for KMP, and native `indexOf` took 22–345 ms.
- The budget now means what it says: a unit is a unit of text read. Cost per unit still varies with input shape (see Negative), so the bound is asymptotic and the constant is wide.
- The matcher is checked against the retired `indexOf` loop: on 3,000 seeded random inputs, and exhaustively on every binary haystack up to length ten against every binary needle up to length six. The exhaustive check is the one that catches failure-table bugs; the random inputs alone did not.

### Negative

- A typical literal scan is slower per character than the native loop: about 33 ms against 5 ms per 16 MiB at pattern length 14. File I/O dominates in practice, and the case-insensitive path was already slower.
- Reach rises, and so does the worst case per call. A scratch run on the repository tree at the time of the review (2,385 files, 63 MB; not committed) gave: a case-sensitive search completes (2,384 files, 38.7 MB); a case-insensitive search stops on `work` (2,068 files, 34.1 MB), because the fold reads each line twice. Which ceiling binds depends on the text.
- The worst case is measured, not bounded tightly. A scratch run of 64 files of 1 MiB, each a run of newlines, took about 4.7 s case-insensitive, against about 0.5 s under the old ceilings. The charge is one unit per line, but the real cost of a unit varies about 20× by input shape (roughly 3 ns per unit case-sensitive on text, about 70 ns case-insensitive on empty lines), so the per-line overhead is under-priced. Raising the per-line charge would tighten the worst case at the cost of reach for ordinary text. This is a recorded trade-off, not a fixed decision.
- A single search can hold one folded line of up to 1 MiB in memory, and a case-insensitive file of such lines multiplies the live set across calls. Concurrent searches multiply it further; this was not measured.

### Neutral

- **Not done here: a visible partial-scan notice under the tool line.** A person still does not see `incomplete` unless the model reports it. The fix needs an additive, content-free scan verdict on `agent:tool_result` (a run-event schema change), the chat tool-row projection, and the tool-review view. The run views overlap the MVP-8 work in progress on the Home, so it is parked for a separate decision.
- The ignore matcher's accounting (`work += rel.length + workspaceRel.length + 2`) is measured separately and is unchanged.

## Verification

- `literal-search.test.ts`: the failure table, overlapping occurrences, code-unit matching, early acceptance, the exhaustive binary check, and agreement with the `indexOf` oracle over 3,000 seeded inputs. Mutants that break the failure fallback (a `while` turned into an `if`, a reset to zero in the scan, a reset to zero in the table) are killed.
- `fs-mvp3.test.ts`: a long adversarial line is read once and rejects every non-word occurrence; about 4 MB of ordinary text completes with `incomplete: false`; a case-insensitive search over forty 1 MiB files stops in exactly the file the charge predicts, and that count fails when the pattern is charged per line again; a late binary file is refused at the 64 MiB byte ceiling; a match after a character that folds to two units maps back to its source span (an identity fold map is killed); `find_files` stops at its own 1,000 files when it meets 1,000 hard links, and a find that used the search ceiling is killed.
- Linearity itself is not pinned by a test: a quadratic `indexOf` loop substituted for the matcher still passes the suite. The evidence for linearity is the scratch benchmark above, not a regression test.
- The `fs.test.ts` and `fs-discovery-ignore-work.test.ts` suites pass, which keeps the adversarial ignore-rule ceiling in place.
