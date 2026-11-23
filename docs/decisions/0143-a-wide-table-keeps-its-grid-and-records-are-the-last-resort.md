# ADR-0143: A wide table keeps its grid, with each cell wrapped inside its column; records are the last resort

- **Status**: Accepted — 2026-11-23, by the maintainer, after an independent review of the ADR, the code and the reference whose findings are corrected in this text. Acceptance tier: D64 "other UX and rendering" (per milestone review), with the rendering tests and the reference update as the evidence.
- **Date**: 2026-11-23
- **Supersedes**: [ADR-0141](0141-a-table-too-wide-for-its-grid-renders-as-records.md) (never accepted; its default of records is reversed here).
- **Amends**: [ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) §Tables, in place (dated note at the top of that ADR).
- **Related**: [markdown-rendering.md](../reference/cli/markdown-rendering.md) (the canonical contract), [accessibility.md](../reference/cli/accessibility.md) ("color is never required for meaning"), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0069](0069-string-width-for-the-cli-renderer.md), [ADR-0142](0142-a-literal-search-is-linear-and-its-work-budget-charges-what-it-reads.md) (the search side of the same analysis). The analysis behind both records is a private, gitignored note and is not linked; the observations below are the ones this text relies on.

## Context

[ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) draws a GFM table as a bordered grid when the whole grid fits the width. ADR-0141 then drew a table that did not fit as one labelled record per body row. The maintainer asked for tables to stay tables, and this ADR follows that.

The research of 2026-11-23 points the same way:

1. **Stacked key-value records are the approach that users of terminal coding agents complain about.** The issue trackers of two such tools ask for horizontal scrolling, truncation, raw pipe tables, or a way to switch the record fallback off. One tool's narrow-width behaviour matches records but is documented only in a third-party write-up, and it could not be confirmed.
2. **A text-grid approach ships in a terminal UI library's beta.** Its write-up of 2026-02-26 describes a text-only table with wrapping cells that fills the width. It does not describe the wrapping rules, and its performance figures are its author's own. The stable behaviour of the product that uses it could not be confirmed.
3. **A mature Rust table-fitting library has a clear rule set.** It gives every column a minimum width, shrinks the columns above their average first, makes each row as tall as its tallest cell, and breaks at spaces. It also drops trailing columns when the width is too small, which silently loses data. This ADR keeps the minimum width, the row height and the breaking at spaces, replaces the shrinking above the average with a share in proportion to the room above each floor, and rejects the dropping of columns.

Two fallbacks are kept for the reasons the reference already gives: the fixed limits (32 columns, 128 body rows, 65,536 units) bound interpretation work, and colour-off output keeps its markers.

## Decision

1. **A table that does not fit on one line keeps its grid.** The single-line grid is unchanged when it fits; the new path runs only when it does not.
2. **Each cell wraps inside its column.** A row is as tall as its tallest cell. Cell text keeps its inline styling. Alignment applies to every wrapped line, measured without the space that broke the line. The header row is bold and ruled off.
3. **Columns share the excess above a floor.** A column's floor is the largest of 8, its longest word (capped at 24) and its widest grapheme cluster, and never more than its natural width. The excess above the floors is shared in proportion to the room each column has above its floor. So no column drops below its floor, and no grapheme is cut. When the grid must shrink, it fills the available width exactly. A word wider than its column breaks inside the word.
4. **Body rows are ruled apart only when some cell in the table wraps,** so a compact table stays compact.
5. **Records are the last resort.** When even the floors do not fit the width, the table renders as records, as ADR-0141 specified: one dim notice, then for each body row a blank line and, per column, the header as a bold label with the cell text indented below. Each record repeats every label, so records are used only while the repeated labels stay within four times the size of the source; beyond that the table stays literal.
6. **Nothing is dropped.** No column is removed to make room, unlike a fitter that drops trailing columns. Every header and every cell appears in full, wrapped. In a grid or in records, a grapheme that is wider than its line is never replaced with a question mark: the table stays literal instead. A literal table is then drawn by the general geometry rule, which does replace a grapheme wider than the whole width with `?`; that is the one place a grapheme can still be lost, at a width narrower than the grapheme itself (one column, for a double-width glyph).
7. **Still literal.** A table over a fixed limit, a table with a hard break inside a cell, a header-only table that does not fit its grid (one that fits is drawn as a grid, by decision 1), and a width past which not even one value fits (a width of two columns or fewer, or a label or value whose widest grapheme does not fit its line) stay sanitized source, word-wrapped. A wrapped line of a table kept literal starts at its text, not at the space that broke it; the prose wrap keeps the old rule, so the no-colour path and the existing geometry tests are unchanged.
8. **Colour off is unchanged.** With colour disabled the source keeps its markers.
9. **The tab-stop rule changes for the wrapped grid only.** A single-line grid still aligns its tabs to the global column stops. The wrapped grid expands a tab from the start of its own cell. That is the only way to make the wrapped cells independent of each other, and it is the trade-off this ADR accepts.
10. **A pending table over a fixed limit streams as it will finally draw.** While such a table is still arriving, it is laid out as literal source with the same wrapping rule as the finished table, so the transcript does not reflow when the stream ends. This holds for a table outside a container. Inside a quote the pending lines are wrapped to the full width and carry the raw `>` marks, so the table is re-wrapped inside its quote bar at the end of the turn. A table that finishes as a grid is literal while it arrives and a grid afterwards, because its column widths depend on every row ([ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) §4 holds a streaming table back for that reason).

## Consequences

### Positive

- A wide table reads as a table at any width the floors fit, which is the common case at 80 or more columns.
- The rule is deterministic: a floor, a share, a height. Work is linear in the admitted table, as the caps already required.
- Nothing is lost at narrow widths. Records carry every cell, and a grapheme that cannot fit keeps the table literal rather than being replaced.
- The records fallback is visible and explained: the notice says why the shape changed. The literal fallback is silent, and is rare.

### Negative

- A long token (a path, a URL) can break inside a word when it is wider than its column. The floor follows the longest word up to 24 columns, so most identifiers stay whole.
- The wrapped grid takes more lines than a single-line grid would have, and a tall row is less scannable than a short one. Rules between rows keep it readable.
- Tab stops no longer align across rows in the wrapped grid. Tabs inside table cells are rare, and the single-line grid keeps the old alignment.
- A capped table (over 32 columns, 128 body rows or 65,536 UTF-16 code units) still renders as literal source.
- Records repeat their labels, so a table with a long header and many rows stays literal once the repeated labels alone would exceed four times the length of its source. The amplification bound is a choice, not a measurement.
- A wrap quirk remains in prose: a line break that lands exactly on a space leaves that space at the start of the next line. The table wrappers strip it, but the prose wrapper does not, because the same wrapper draws code, where leading spaces are content.

### Neutral

- The grid rules, the single-line tab-stop geometry, and the parser's limits are unchanged. No dependency, no run event, no persisted field.
- The copy, edit and scrollback hatches still return sanitized source.

## Verification

- `table-record-fallback.test.ts`: the grid at 40 columns fits its width line by line; the columns above their floors share the excess (24 and 9 for the sample); every header and cell is kept; a row is as tall as its tallest cell; inline styling survives wrapping; right and centre alignment are checked line by line against exact output; a run of spaces inside a cell makes no blank grid row; a wide grapheme is kept whole; records appear only where the floors do not fit, with the notice, the labels, the dash, the quote bar, and every line within the width from 5 to 60 columns; records do not amplify a long header; the literal cases stay literal.
- `table-record-fallback.test.ts` also pins the header-only cases (a header-only table that fits is a grid; one that does not fit is literal) and the width-one case, where the literal table is drawn by the geometry rule.
- `stream-table-parity.test.ts`: a pending table over the row limit, outside a container, has the same wrapped lines while it streams as the finished table. A quoted one is re-wrapped inside its bar when it finishes, with nothing lost, and a table that finishes as a grid is literal while it arrives; both are pinned as what they are.
- `table-tab-geometry.test.ts`: the tab-phase case draws the wrapped grid, with each tab expanded inside its own cell.
- The 327-column sample: a grid at 80, 120 and 400 columns, and records only at 40, where the floors do not fit. The sample's text is not in the repository, so this is checked by the probe run, not by a committed test.
