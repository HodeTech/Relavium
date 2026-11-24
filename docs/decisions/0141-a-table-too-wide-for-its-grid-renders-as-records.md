# ADR-0141: A table too wide for its grid renders as records, not as its source

- **Status**: Superseded by [ADR-0143](0143-a-wide-table-keeps-its-grid-and-records-are-the-last-resort.md) — 2026-11-23, before acceptance. The maintainer asked for tables to stay tables, so records are no longer the default. They remain the fallback below the floors, as ADR-0143 describes. The text below is the reasoning as it stood before that change. Acceptance tier: D64 "other UX and rendering" (per milestone review), with the rendering tests and the reference update as the evidence.
- **Date**: 2026-11-23
- **Amends**: nothing in the end. The note this ADR once planned for [ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) §Tables now points at [ADR-0143](0143-a-wide-table-keeps-its-grid-and-records-are-the-last-resort.md), which supersedes this record.
- **Related**: [markdown-rendering.md](../reference/cli/markdown-rendering.md) (the canonical contract), [accessibility.md](../reference/cli/accessibility.md) ("color is never required for meaning"), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0069](0069-string-width-for-the-cli-renderer.md).

## Context

[ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) draws a GFM table as a bordered grid when the whole grid fits the width. A table whose grid does not fit "renders verbatim, as the sanitized source", and ADR-0114 names wrapping cell text inside a narrow grid as a candidate follow-up.

Checked on 2026-11-23 against the renderer itself, not a model's transcript:

1. **The width gate is what a person sees as raw pipes.** A two-column table with short cells draws a grid at 40, 80 and 120 columns. A table whose grid needs 327 columns (two cells of 115 and 205 characters) renders as source at 80 and 120 columns, and as a grid at 400. The color-off path is a separate gate and was not the cause.
2. **"Verbatim" is not what the code does.** The fallback passes the source through the prose word-wrapper, so each line breaks where the words do, and the pipes detach from the cells they bounded. The alignment that the fallback was meant to protect is lost by the same wrap. The literal source is neither a table nor readable markdown, and the ADR's stated reason for the fallback is defeated by its own mechanism.

Two other fallbacks are kept for the reasons the reference already gives: the fixed limits (32 columns, 128 body rows, 65,536 units) bound interpretation work, and colour-off output keeps its markers.

## Decision

1. **Records.** A table whose grid does not fit its width, or whose aligned cells need tab stops that cannot agree, renders as records:
   - one dim notice line, `table shown as records: its grid does not fit this width`;
   - then, for each body row, a blank line and, for each column, the header as a bold label line with the cell text on the lines below, indented two columns and wrapped to the width;
   - an empty cell shows a dim `—`, and a blank header shows a dim `column N`;
   - cell inline styling is kept, and alignment is not drawn;
   - no gutter is added, so a record inside a quote shows only the quote bar.
2. **Still literal.** Sanitized source, word-wrapped to the width like prose, for: a table over a fixed limit (the caps are unchanged, because they bound interpretation work); a table with a hard break inside a cell; a header-only table, which has no record to draw; and a width with no room past the two-column indent.
3. **Colour off is unchanged.** With colour disabled the source keeps its markers, as [markdown-rendering.md](../reference/cli/markdown-rendering.md) requires. Records would drop the pipes that carry the structure without colour.
4. **The contract says what the code does.** The reference no longer calls the fallback verbatim, and this ADR is the driving record for the amendment.

## Consequences

### Positive

- Every header and every cell is shown once, whole, at every width the layout is drawn at. The layout test checks that no record exceeds its width from 5 to 60 columns.
- A wide table reads top to bottom, one labelled block per row, where before it was a run of wrapped pipe fragments.
- The rule is one deterministic threshold on the grid's width, with no search over column widths.
- No dependency, no run event, no persisted field, and no change to the copy, edit or scrollback hatches, which still return sanitized source.

### Negative

- A wide table no longer looks like a table, so comparing values across columns is harder. The grid still draws whenever it fits, which is the common case for narrow tables at 80 or more columns, and the notice says why the shape changed.
- Records take more rows than the grid does.
- A capped table (over 32 columns, 128 body rows or 64 KiB) still renders as literal source. This is a deliberate, visible limit; a later decision can give capped tables records once their interpretation cost is measured.
- Alignment markers have no meaning in records and are dropped.
- A wrap quirk stays: a line break that lands exactly on a space leaves that space at the start of the next line. It is pre-existing in prose and not changed here, because the same wrapper draws code, where leading spaces are content.

### Neutral

- The grid rules, the tab-stop geometry and the parser's limits are unchanged. Only the path taken when the grid does not fit has changed.

## Verification

- `apps/cli/src/render/markdown/table-record-fallback.test.ts`: structure, notice, no information loss, inline styling, empty cells and blank headers, the width invariant from 5 to 60 columns, the quote case, and each literal fallback.
- `table-tab-geometry.test.ts` and `markdown.test.ts` were updated where they pinned the old literal fallback, and the new expectations are stated in the tests.
- The renderer was run on the 327-column case: records at 40, 80 and 120 columns, and the grid is still drawn at 400.
