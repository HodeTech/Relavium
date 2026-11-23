# ADR-0143: A wide table keeps its grid, with each cell wrapped inside its column; records are the last resort

- **Status**: Proposed — 2026-11-23. The implementation is on `development`; the maintainer's acceptance is pending. Acceptance tier: D64 "other UX and rendering" (per milestone review), with the rendering tests and the reference update as the evidence.
- **Date**: 2026-11-23
- **Supersedes**: [ADR-0141](0141-a-table-too-wide-for-its-grid-renders-as-records.md) (never accepted; its default of records is reversed here).
- **Amends**: [ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) §Tables, in place (dated note at the top of that ADR).
- **Related**: [markdown-rendering.md](../reference/cli/markdown-rendering.md) (the canonical contract), [accessibility.md](../reference/cli/accessibility.md) ("color is never required for meaning"), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0069](0069-string-width-for-the-cli-renderer.md), [ADR-0142](0142-a-literal-search-is-linear-and-its-work-budget-charges-what-it-reads.md) (the search side of the same review).

## Context

[ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) draws a GFM table as a bordered grid when the whole grid fits the width. ADR-0141 then drew a table that did not fit as one labelled record per body row. The maintainer asked for tables to stay tables, and this ADR follows that.

The research of 2026-11-23 points the same way:

1. **Stacked key-value records are the approach people complain about.** Claude Code's wide-table fallback is the stacked-card layout, and its issues ask for horizontal scrolling, truncation, raw pipe tables, or a way to switch the fallback off. The Codex CLI behaviour that matches records (grid when wide, records when narrow) comes from one third-party post and is not confirmed by a release note.
2. **The text-grid approach ships in opencode's beta.** OpenTUI's post of 2026-02-26 describes a text-only table with wrapping cells that fills the width. It does not describe the wrapping rules, and its performance figures are the author's own. I could not confirm the stable behaviour of opencode.
3. **A mature table fitter has a clear rule set.** termimad gives every column a minimum, shrinks the widest columns first, makes each row as tall as its tallest cell, and breaks at spaces. It also drops trailing columns when the width is too small, which silently loses data. This ADR keeps the first three and rejects the last.

Two fallbacks are kept for the reasons the reference already gives: the fixed limits (32 columns, 128 body rows, 65,536 units) bound interpretation work, and colour-off output keeps its markers.

## Decision

1. **A table that does not fit on one line keeps its grid.** The single-line grid is unchanged when it fits; the new path runs only when it does not.
2. **Each cell wraps inside its column.** A row is as tall as its tallest cell. Cell text keeps its inline styling. Alignment applies to every wrapped line. The header row is bold and ruled off.
3. **Columns share the excess by a floor.** A column's floor is the smaller of its natural width and the larger of 8 and its longest word, capped at 24. The excess above the floors is shared in proportion to how far each column sits above its floor. So no column drops below its floor, the widest columns give up the most, and the grid fills the available width exactly. A word wider than its column breaks inside the word.
4. **Body rows are ruled apart only when a cell wraps,** so a compact table stays compact.
5. **Records are the last resort.** When even the floors do not fit the width, the table renders as records, as ADR-0141 specified: one dim notice, then for each body row a blank line and, per column, the header as a bold label with the cell text indented below. Records are not drawn at any width where the grid fits or the floors fit.
6. **Nothing is dropped.** No column is removed to make room, unlike termimad. Every header and every cell appears in full, wrapped.
7. **Still literal.** A table over a fixed limit, a table with a hard break inside a cell, a header-only table, and a width with no room for the frame stay sanitized source, word-wrapped as prose. A wrapped line of a table kept literal starts at its text, not at the space that broke the line; the prose wrap keeps the old rule, so the no-colour path and the existing geometry tests are unchanged.
8. **Colour off is unchanged.** With colour disabled the source keeps its markers.
9. **The tab-stop rule changes for the wrapped grid only.** A single-line grid still aligns its tabs to the global column stops. The wrapped grid expands a tab from the start of its own cell. That is the only way to make the wrapped cells independent of each other, and it is the trade-off this ADR accepts.

## Consequences

### Positive

- A wide table reads as a table at any width the floors fit, which is the common case at 80 or more columns.
- The rule is deterministic: a floor, a share, a height. Work is linear in the admitted table, as the caps already required.
- Nothing is lost at narrow widths. Records carry every cell.
- The fallback is visible and explained: the notice says why the shape changed.

### Negative

- A long token (a path, a URL) can break inside a word when it is wider than its column. The floor follows the longest word up to 24 columns, so most identifiers stay whole.
- The wrapped grid takes more lines than a single-line grid would have, and a tall row is less scannable than a short one. Rules between rows keep it readable.
- Tab stops no longer align across rows in the wrapped grid. Tabs inside table cells are rare, and the single-line grid keeps the old alignment.
- A capped table (over 32 columns, 128 body rows or 64 KiB) still renders as literal source.
- A wrap quirk remains in prose: a line break that lands exactly on a space leaves that space at the start of the next line. The table wrapper strips it, but the prose wrapper does not, because the same wrapper draws code, where leading spaces are content.

### Neutral

- The grid rules, the single-line tab-stop geometry, and the parser's limits are unchanged. No dependency, no run event, no persisted field.
- The copy, edit and scrollback hatches still return sanitized source.

## Verification

- `table-record-fallback.test.ts`: the grid at 40 columns fits its width line by line; the widest column gives up the excess and every column keeps its floor (24 and 9 for the sample); every header and cell is kept; a row is as tall as its tallest cell; inline styling survives wrapping; right alignment holds on every wrapped line; body rows are ruled apart only when a cell wraps; records appear only below the floors, with the notice, the labels, the dash, the quote bar, and every line within the width from 5 to 60 columns; the literal cases stay literal.
- `table-tab-geometry.test.ts`: the tab-phase case draws the wrapped grid, with each tab expanded inside its own cell, and the expected lines are checked by hand.
- The 327-column sample: a grid at 80, 120 and 400 columns, and records only at 40, where the floors do not fit.
