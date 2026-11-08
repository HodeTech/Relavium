# ADR-0114: In-house markdown rendering for the chat transcript

- **Status**: Accepted
- **Date**: 2026-11-05
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md), [ADR-0049](0049-cli-machine-output-contract.md), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0069](0069-string-width-for-the-cli-renderer.md), [ADR-0088](0088-the-mcp-boundary-is-hostile.md), [phase 2.6 · 2.6.E](../roadmap/phases/phase-2.6-conversational-authoring.md#26e--chat--input-parity-polish), [phase 2.6 ADR row 11](../roadmap/phases/phase-2.6-conversational-authoring.md), [MVP-2](../roadmap/current.md#next-work--the-cli-mvp)

> **Revised and accepted 2026-11-08.** The [terminal agent CLI UX benchmark](../analysis/cli-ux-benchmark-2026-11-08.md)
> found that every major product renders markdown tables. §2 now renders GFM tables as an aligned grid when it fits,
> and §4 holds a streaming table back until its block ends. The rest of the decision is unchanged. The maintainer
> accepted the revised text on 2026-11-08 (D76 sets its acceptance tier).

## Context

Assistant text reaches both chat renderers as plain text. Models answer in
markdown, so the user reads `**`, backticks, `#` and fence lines instead of
emphasis, code and structure. MVP-2 ("a readable chat") needs this fixed.

Phase 2.6 ADR row 11 bundled two decisions: a markdown rendering architecture
and a syntax-highlighting dependency. On 2026-11-04 the maintainer split it.
Part 1, this ADR, is an in-house renderer with **no dependency**. The
highlighter decision follows the MVP and will be its own ADR.

The renderer has to fit what already exists:

- **Two transcript renderers.** The inline renderer prints entries through
  ink's `<Static>` and lets ink word-wrap. The full-screen renderer wraps
  entries itself into `DisplayLine`s ([ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md) §c), because
  its scroll and mouse math rely on **one `DisplayLine` per terminal row**,
  measured with the same `string-width` ink uses
  ([ADR-0069](0069-string-width-for-the-cli-renderer.md)).
- **One sanitization boundary.** `entryLines` applies `stripTerminalControls`
  once, for every consumer: the viewport and the `/copy`, `/edit` and
  `/scrollback` hatches. It removes ANSI, OSC, C0/C1 and bidi controls but
  keeps newlines and tabs.
- **Streaming.** The answer streams token by token into a live region bounded
  by `liveAnswerRowBudget`. A markdown construct can be half-written at any
  frame: an open fence, or `**` with no closer yet.
- **Machine and plain surfaces.** `--json`, plain and non-TTY output keep the
  [ADR-0049](0049-cli-machine-output-contract.md) contract byte for byte.

The off-the-shelf terminal markdown renderers (`marked-terminal`,
`ink-markdown`, which wraps it) emit pre-styled ANSI strings. Feeding ANSI into
the transcript breaks the one-row invariant, because the widths are computed on
text ink re-measures. It also bypasses the control-stripping floor. Some of them
emit OSC 8 hyperlinks, whose visible label can hide the real target. Rule 2 of
[CLAUDE.md](../../CLAUDE.md) also requires an ADR for any runtime dependency.

## Decision

**Relavium renders assistant markdown with its own pure, two-stage pipeline in
the CLI. The pipeline emits styled text spans, never escape sequences.**

### 1. Pipeline

- **Parse.** `parse` turns sanitized text into a small block tree, then parses
  inline spans in each block. It is pure TypeScript with no ink import.
  - Block parsing is line-oriented. The state at each newline is all that
    carries forward, so a prefix that ends at a newline parses the same way
    whatever follows it.
  - Inline delimiters are matched with one linear scan and a delimiter stack.
    The parser uses no regular expression that can backtrack over unbounded
    input. Parsing is O(n) in the text length.
- **Layout.** Layout turns blocks into lines of styled spans. A span is text
  plus semantic flags: strong, emphasis, code, strike, heading level, quote,
  link URL, dim. Prefixes are spans too: the list marker, the quote bar and the
  code-block gutter. Each line also has a hanging indent for its wrapped
  continuation rows.
- **Draw.** Each renderer draws those lines its own way.
  - The full-screen renderer wraps them into `DisplayLine` rows. `DisplayLine`
    gains a `spans` field alongside `text`. `text` stays the plain
    concatenation, so the selection and copy-on-select code and the width math
    are unchanged.
  - Wrapping is by words, with a character-wrap fallback for a token wider than
    the row. It uses the hanging indent and measures every span and prefix with
    `displayWidth`, so the one-row invariant holds.
  - The inline renderer maps the same lines to nested ink `<Text>` elements and
    lets ink wrap, as it does today.

The two renderers can still break long lines at different points. This is the
same accepted difference ADR-0068 §c records, and only one renderer is active at
a time.

### 2. The supported subset

The pipeline renders a documented subset suited to model output:

- **Blocks:** ATX headings; fenced code blocks (backtick or tilde fences, with
  the info string shown as a dim label); bullet and ordered lists, nested by
  indentation; blockquotes; thematic breaks; paragraphs.
- **Inline:** code spans; strong and emphasis, with CommonMark's intraword rule
  for `_`; strikethrough; links and autolinks; images; backslash escapes; hard
  line breaks.
- **Tables (revised 2026-11-08):** GFM pipe tables render as an aligned grid
  with a border, when the grid fits the available width.
  - Cell text gets inline processing.
  - Column widths are measured with `displayWidth`, so wide and combining
    characters do not misalign the grid.
  - A table whose grid does not fit renders verbatim, as the sanitized source,
    with no inline processing. Removing markers there would misalign the
    columns the model laid out.
  - Rows past a fixed cap render verbatim too, so one table cannot cost
    unbounded layout work.

**Anything outside the subset renders literally, as sanitized text.** That
covers setext headings, indented code blocks, HTML, link reference definitions,
footnotes and lazy continuation.

The pipeline is not a CommonMark implementation. The goal is predictability:
markdown it does not understand stays readable as the plain text it was written
as.

The exact subset, glyphs, colors and fallbacks are specified in
`docs/reference/cli/markdown-rendering.md`, written with the implementation.
This ADR does not restate them.

### 3. Security floor

- **Sanitize first.** The parser only sees text that `stripTerminalControls` has
  already sanitized, at the existing `entryLines` boundary. No stage adds a
  control byte. Styling exists only as ink props, so the SGR escapes ink itself
  writes are the only escapes on screen.
- **Links show their target.** A link renders as its label followed by its URL.
  When the label is the URL, it renders once. An image renders as a dim
  `[image: alt]` followed by its URL. The pipeline never emits an OSC 8
  hyperlink, so a label cannot hide where it points.
- **Inline text is collapsed.** An info string, a link label and a URL are
  inline values. They get `sanitizeInline` treatment and cannot span or forge
  rows.
- **Bounded work.**
  - Parsing is linear in the text length.
  - Nesting of lists and quotes is capped. Deeper nesting renders literally.
  - Tabs expand to 8-cell stops before measuring, the rule #65 adopts, so a
    tab-indented code block keeps the one-row invariant.

### 4. Streaming

The live answer goes through the same pipeline, with one rule for half-written
constructs:

- An open fence renders as a code block until its closer arrives.
- An unclosed inline delimiter stays literal until it is closed. That is
  CommonMark's rule.
- A table renders verbatim until its block ends, then as a grid (revised
  2026-11-08). A grid's column widths depend on every row. Drawing it early
  would re-layout the rows above it on every new row. Codex CLI and
  Antigravity CLI hold tables back for the same reason
  ([benchmark](../analysis/cli-ux-benchmark-2026-11-08.md)).

Because block parsing is line-oriented, the rendering of every completed block
in the live answer is the same as its final rendering. Only the in-progress last
line can change when the turn ends.

To keep the per-frame cost flat, the block state at the last completed newline
is cached. Each frame re-parses only the text after that newline.

### 5. Scope and fallbacks

- **Rendered:** only `assistant` entries, in both chat renderers, which also
  covers the in-Home chat. User echoes, notices, the reasoning panel and tool
  rows stay plain. Tool-call rendering belongs to phase 2.6 ADR row 9.
- **Hatches get the source.** `/copy`, `/edit` and `/scrollback` receive the
  sanitized **markdown source**, not the rendered form. The user pastes what
  the model wrote, and nothing is lost to a style the destination cannot show.
  Copy-on-select copies the rendered rows the highlight covers, because the
  highlight shows exactly what is copied.
- **Color disabled renders the source.** When color is disabled (`--no-color`
  or `NO_COLOR`, resolved as the global options define), the transcript shows the sanitized source
  unchanged. Emphasis that cannot be styled should not silently lose its
  markers, and raw markdown is designed to read as plain text.
- **Machine and plain surfaces are unchanged.** `--json`, plain, non-TTY, the
  run renderers and `chat-export` are not affected.

### 6. Placement

The parser and layout live in `apps/cli/src/render/markdown/`, beside the
other display boundaries. Only the draw step imports ink.

A second consumer would be a reason to move the parser into a shared package,
as a refactor rather than a new decision. That move must not cover the desktop
and VS Code webviews. They render HTML, where the threat model is DOM injection
rather than terminal control, and their rendering is a separate decision.

### Alternatives considered

- **`marked` or `markdown-it` with `marked-terminal`, or `ink-markdown`.**
  Rejected. Each is a new dependency chain. They return ANSI strings that break
  the one-row invariant and bypass the sanitization boundary. Some emit OSC 8
  links.
- **Full CommonMark compliance in-house.** Rejected. The spec's hard edges
  (lazy continuation, reference definitions, HTML blocks, setext headings,
  emphasis tie-breaking) cost more than they return for model output. A
  documented subset with a literal fallback is cheaper and easier to predict.
- **Keep plain text.** Rejected. It is the readability gap MVP-2 exists to
  close.
- **Highlight code now.** Deferred to part 2's ADR, per the 2026-11-04 split.
  The layout already tags a code block's language, so highlighting can be added
  later without changing the pipeline.

## Consequences

### Positive

- The transcript becomes readable for the common markdown models emit, with no
  new dependency.
- The control-stripping floor and the one-row invariant are untouched, because
  styling exists only as ink props on already-sanitized text.
- Links always show their real target.
- The `/copy`, `/edit` and `/scrollback` hatches keep returning faithful source
  text.
- The streamed rendering never rewrites a completed block.

### Negative

- Some valid markdown renders literally: setext headings, HTML, reference
  links, and tables too wide or too long for the grid. Wrapping cell text inside
  a narrow grid (Gemini CLI does it) is a candidate for a follow-up.
- Relavium now owns a parser and its edge cases, and needs tests for every
  construct in the subset, including adversarial and pathological input.
- The two renderers may break long lines at different points, as they already
  do.
- With color disabled, the user sees raw markdown rather than a degraded
  rendering.
