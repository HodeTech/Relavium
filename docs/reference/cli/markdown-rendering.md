# CLI assistant markdown rendering

- **Status**: Implemented and independently accepted on development
- **Date**: 2026-11-10
- **Surface**: Interactive CLI, full-screen and inline, standalone and in-Home chat
- **Related**: [ADR-0114](../../decisions/0114-in-house-markdown-rendering-for-the-chat-transcript.md), [chat-session.md](chat-session.md), [accessibility.md](accessibility.md), [MVP-2 proposal](../../roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-preflight-and-execution-proposal--2026-11-09)

This is the exact display contract for MVP-2a. Implementation is accepted on
`development` at `b636be5f` after clean cumulative reviews and a separate parser
security sitting; see the [step acceptance record](../../roadmap/phases/phase-2.6-conversational-authoring.md#step-1-acceptance-2026-11-10).
All four MVP-2 steps are implemented and step-reviewed. The
[checkpoint record](../../roadmap/phases/phase-2.6-conversational-authoring.md#step-4-acceptance-2026-11-10)
owns combined validation and maintainer review; publication remains a later release decision.

## Scope and source

Render only assistant entries, including restored assistant answers. User echoes,
notices, reasoning and tool rows remain plain: no markdown interpretation, with
the same terminal sanitization floor. Plain/non-TTY, `--json`, run output
and chat export keep their existing representations.

With color disabled, render sanitized markdown source with its markers intact.
The geometry layer still expands tabs and wraps to fit. Do not interpret markup
and silently remove emphasis markers when it cannot be styled.

Sanitize source once at the existing transcript boundary before parsing. Keep a
source projection for `/copy`, `/edit` and `/scrollback`, and a separate styled
projection for drawing; neither projection bypasses that boundary. Source hatches
retain sanitized markdown and tabs rather than grid borders or display expansion.
Copy-on-select returns the rendered rows actually highlighted. Restored user
entries in all hatches use their
[safe restored display form](chat-session.md#proposed-restored-transcript-display--mvp-2),
never expanded attachments.

## Supported blocks

| Source | Display with color enabled |
|---|---|
| ATX heading, one to six `#` followed by space | Heading text, bold; omit the opening marker and optional space-separated closing markers |
| Backtick or tilde fence of at least three characters | Code text verbatim with a dim `│ ` gutter; nonempty info string shown as a dim label |
| `-`, `+`, `*` followed by space | Bullet `• `, with a hanging continuation indent |
| Decimal digits followed by `.` or `)` and space | Preserve the written ordinal with a hanging continuation indent |
| Nested list indentation | Preserve relative indentation, up to the nesting limit |
| `>` followed by optional space | Dim quote bar `│ `; nested bars up to the nesting limit |
| Thematic break, at least three matching `-`, `*` or `_`, with optional spaces | A dim rule fitting the available columns |
| Paragraph | Inline text; a soft source newline becomes a display space within the paragraph |
| GFM pipe table | Bordered grid when the complete table fits; otherwise sanitized source |

A fence closes only on the same character, at least the opening length, with no
following non-space text. An unfinished fence remains code through end-of-turn.
Code bodies get no inline processing or syntax highlighting. An info string is
sanitized as an inline value and never changes the parser or executes anything.

Setext headings, indented code, HTML, reference definitions/links, footnotes and
lazy continuation render literally. Unsupported structures must not cause
otherwise literal text to disappear. More deeply nested constructs also fall
back to their source; this is a subset, not CommonMark compliance.

### Block precedence and indentation

After identifying the current quote/list container, use this precedence:
an existing open fence, a new fence, a pipe-table header/delimiter pair, an ATX
heading, an unsupported Setext pair kept literally, a thematic break, a list
item, a quote, then a paragraph. A thematic break wins over a list marker, so
`- - -` is a rule. `Title` followed by `---` or `===` is a literal two-line Setext
pair, not a table or a paragraph followed by a rule. A standalone `---` is a rule.
Hold a potential paragraph/header line pending for this one-line lookahead.

Fence openers/closers accept zero to three leading source ASCII spaces relative
to their container. Four or more source ASCII spaces are unsupported indented
code and stay literal. A root-leading source TAB remains paragraph content,
expanded for display; it does not itself select the indented-code fallback.
Tabs consumed as list indentation follow the structural column rules below.
Remove up to the opener's indentation from each code-body line, preserving any
remaining indentation. A closer may have its own zero-to-three-space indentation
and may be followed only by ASCII spaces or TABs.
A backtick fence's info string cannot contain a backtick; such an opener is
literal. Tilde info strings have no corresponding backtick restriction.

For lists, expand source tabs to eight-cell stops for structural column math.
A marker is followed by one to four spaces; its content column is the first
non-space column after that padding. A child marker at or beyond its parent's
content column opens the next depth; a marker at the same column is a sibling,
and dedenting pops containers until the column fits. A non-marker line reaching
the active content column continues that item with a hanging indent equal to
its displayed marker/padding width. Lazy or ambiguous continuation remains
literal. Excess-depth list/quote lines and their over-depth continuations render
literally until they return within the admitted depth; earlier admitted siblings
stay styled. The limit does not turn an already completed list into raw source.

Each `>` consumes one quote depth and at most one following space. Once inline
depth reaches its cap, additional delimiters themselves remain literal; earlier
matched spans remain styled. These are interpretation limits, not truncation.

A whole-line simple opening HTML tag owns literal source through its whole-line
matching closing tag, including same-name nested pairs. Matching is ASCII
case-insensitive; names start with an ASCII letter, followed by ASCII letters,
digits or hyphens. An unclosed region remains literal through EOF; leaving its
quote/list container ends it. Self-closing tags, tags with trailing text and
the [HTML void elements](https://html.spec.whatwg.org/dev/syntax.html#void-elements)
remain one-line literal forms. Attributes and HTML content are never interpreted.
Tag-led HTML comments remain literal through `-->` or EOF, and complete doctype
declarations remain one-line literal forms. Comment terminator lines remain wholly
literal, including trailing text.

## Supported inline constructs

| Source | Display |
|---|---|
| Matching backtick runs | Code text, preserving literal internal markup |
| `**strong**` or `__strong__` | Bold text |
| `*emphasis*` or `_emphasis_` | Italic text; `_` within a word stays literal |
| `~~strike~~` | Struck text |
| `[label](target)` | Label followed by ` (target)`; if label equals target, show it once |
| `<https://example.test>` or an email autolink | Show the complete displayed target once |
| `![alt](target)` | Dim `[image: alt] (target)`; no fetch or image decoding |
| Backslash before ASCII punctuation | Literal escaped punctuation |
| Two trailing spaces or a trailing unescaped backslash before newline | Hard line break |

An unmatched delimiter stays literal. Bound delimiter nesting; unsupported link
forms, including optional titles, stay literal rather than dropping information.
Complete bare bracket groups remain literal as unsupported shortcut-reference
candidates; labels of valid inline links still receive inline styling.
Labels, targets and info strings receive
[`sanitizeInline`](../../../apps/cli/src/render/sanitize.ts) treatment, so they
cannot forge rows. Never emit OSC 8, launch a URL, resolve it or fetch its target.
Do not truncate or conceal a link's real target. A long URL wraps as text.

## Tables and fixed limits

A table begins with a header and a matching delimiter row. Delimiter cells have
at least three hyphens and optional leading/trailing colons. Leading/trailing
pipes are optional, but both the header and delimiter row must contain at least
one unescaped pipe outside a code span. This distinguishes even a one-column
table (`| Title |` / `| --- |`) from the pipe-free literal Setext pair.
Split cells with a linear scanner that respects escaped
pipes and code spans. Header and delimiter column counts must match; unsupported
or ambiguous forms remain literal. A body row may contain one cell without a pipe;
short body rows receive empty trailing cells. A table ends at a blank line, an
unambiguous new block or EOF. An over-wide body row makes the table literal
rather than discarding a cell.

Use `┌┬┐`, `├┼┤`, `└┴┘`, `─` and `│` for the grid, one space of cell padding,
and header emphasis. Colon alignment controls cell alignment. Measure the
displayed inline cell text, including visible link targets. Hard cell breaks or
a grid wider than the available columns cause literal source fallback; cells are
not silently cropped or wrapped into an unreadable narrow grid.

| Limit | Value | Overflow behavior |
|---|---|---|
| List depth | 8 | Deeper structure renders literally |
| Quote depth | 8 | Deeper structure renders literally |
| Inline delimiter nesting | 32 | Excess delimiters remain literal |
| Table body rows | 128, excluding header/delimiter | Entire table renders literally |
| Table columns | 32 | Entire table renders literally |
| Pending table source | 65,536 UTF-16 code units | Entire table renders literally |

Limits bound interpretation work, not source retention. Do not omit overflow
rows or truncate source to satisfy a parser cap. Once a streaming table crosses
a cap, keep that table literal through its end. No later token can reactivate a
grid and force repeated full-table layout. Layout work is linear in the admitted
bounded table; there is no search over alternative column-width combinations.
Alignment padding participates in tab-stop geometry. If aligned cells require
incompatible tab-stop phases, or the compatible grid does not fit, render the
entire table literally.

## Geometry

Expand tabs to the next eight-cell stop on each logical display line before
measuring, including prefixes. Full-screen prose wraps at word boundaries, with
a grapheme-preserving fallback for a token wider than the available columns.
Preserve code indentation and content; wrap code to fit with its gutter retained
when the prefix leaves at least one content cell. Continuation rows inherit the
block's hanging indent under that same condition. If gutters, quote/list prefixes
or hanging indentation exhaust the available columns, render that block's
sanitized source literally with no added prefix/indentation. Literal wrapping
still advances at widths 1 and 2; do not subtract a prefix into a zero/negative
content budget. Source hatches retain original content in either case.

A `DisplayLine` occupies one terminal row. Its `text` equals the concatenated
drawn spans. Measure grapheme clusters across adjacent span boundaries, so a
combining mark or ZWJ sequence split by markup cannot be counted twice. Resolve
style changes inside one grapheme consistently for the whole cluster. Full-line
width must agree with Ink's `string-width` measurement. Selection and clipboard
partition the same displayed text by the existing column primitive.

Both renderers draw the same word-wrapped rows, with semantic spans as nested
Ink text. They share parsed constructs, literal fallbacks and tab geometry. Borders, gutters and prefixes
count toward the live row budget. Spinner, elision line, prompt and abort hint
remain visible at 80×24. For a positive row width smaller than one wide grapheme,
the geometry layer draws `?` for that cluster as a terminating display fallback;
source hatches retain the original cluster. At zero/invalid width, suspend
transcript painting until resize while keeping cancellation available. Do not
assume the Home's minimum-size guard also exists on standalone chat; MVP-3 still
owns the full 80×24 chat guard. Test these narrow-width paths in both hosts,
including code gutters, lists, quotes and deep indentation at widths 1 and 2.

## Streaming and caching

An incremental parser consumes sanitized appended input before the live viewport
tails it. Sanitization must handle terminal-control sequences split between
chunks identically to the existing whole-source boundary. Rendering must not
reveal a control sequence merely because its terminator has not arrived. An
unfinished control sequence exceeding 65,536 UTF-16 units suspends that live
segment with a fixed notice and keeps cancellation available. The retained final
turn is sanitized independently; this live buffer bound never truncates its source.

Retain stable completed blocks and an open-block checkpoint. A potential table
header is pending until its delimiter is known; a table stays verbatim until a
blank line, an unambiguous next block or end-of-turn closes it. Only then build
its grid once. An in-progress fence or inline delimiter retains its own state.
Completed stable blocks do not change when new tokens arrive. The pending block
may change, including source-to-grid conversion at table completion.

Parsing appended input is amortized O(n) over a turn, not O(n) for every token.
Do not repeatedly rescan a long unfinished line, copy the entire accumulated
source, or reparse a completed prefix per frame. Drawing may re-layout the bounded
visible pending region; count that separately from parser work. Reuse parsed
blocks across resize; invalidate layout by width and color policy. Bound live
layout caches and keep immutable entry caches scoped to entries still retained.
Reset stream state on turn, tool-round and host changes according to existing
assistant-text ownership; do not leak a previous fence into the next answer.

## Acceptance evidence

Direct tests cover every subset construct, unmatched syntax, exact/+1 limits,
hostile controls/bidi, split chunks, escaped pipes, long unfinished lines, fences,
tables and Unicode across spans. A structural-work counter or equivalent causal
assertion proves incremental processing; elapsed time alone cannot prove linearity.
Autolink admission uses a single-pass target check. A malformed email candidate
with a long dotted domain and a second `@` must remain literal without regex
backtracking. Native child regressions exercise actual cold wrapping and the live
closing-delimiter append with 200,000 dots, a finite deadline and a process heap
cap; these resource checks supplement the grammar-equivalence and structural tests.
Test `Title\n---`, `- - -`, one-column pipe tables, fence indentation/info strings
and nesting/fallback units both complete and split at every streaming boundary,
through both renderers and both color policies.

Mounted Ink tests exercise both renderers, color on/off, resize and 80×24, source
hatches, rendered selection, failure marks and local clipboard-write failure, including a delayed native callback fault without
premature success or feedback after unmount/reseat.
Cold-wrap evidence uses actual assistant entries with markdown, wide/combining
characters, tables and long tokens, including a 500-entry restore. Keep the
existing cold-wrap guard and report measured results without claiming an
unmeasured maximum-size archive is fast.

MVP-2a also needs the scoped security sitting on parser bounds, target display and
sanitize order. Headless package/Windows smoke proves machine compatibility;
it does not establish native terminal input or clipboard acceptance.
