# ADR-0144: Fenced code is highlighted by an in-house lexical scanner

- **Status**: Accepted — 2026-11-23, by the maintainer, after an independent adversarial review and a documentation review whose findings are corrected in this text. Acceptance tier: D64 "other UX and rendering" (per milestone review), with the scanner tests, the linearity checks and the reference update as the evidence. The scanner reads text that is already sanitized and only classes it, so it adds no terminal sink and does not meet the security-sitting triggers.
- **Date**: 2026-11-23
- **Amends**: [ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md), in place (dated note at the top of that ADR). The highlighter decision it deferred ("its own ADR") is this one.
- **Related**: [markdown-rendering.md](../reference/cli/markdown-rendering.md) (the canonical contract), [accessibility.md](../reference/cli/accessibility.md) ("color is never required for meaning"), [ADR-0068](0068-full-screen-tui-renderer-ink7-harness.md), [ADR-0143](0143-a-wide-table-keeps-its-grid-and-records-are-the-last-resort.md), the maintainer's D50 ruling in [current.md](../roadmap/current.md) (decline the highlighting dependency, per CLAUDE.md rule 2).

## Context

[ADR-0114](0114-in-house-markdown-rendering-for-the-chat-transcript.md) split Phase 2.6's row 11 on 2026-11-04. Part 1, an in-house markdown renderer with no dependency, shipped. Part 2, syntax highlighting, was left to "its own ADR", and until this ADR the reference said "code bodies get no inline processing or syntax highlighting". Today a fenced block is one colour (cyan) whatever its language, so a diff, a shell command and a TypeScript function look alike. Models answer with code constantly, and this is the most visible gap left in the chat.

What the answer has to respect:

1. **No dependency.** CLAUDE.md rule 2 says build in-house, and D50 (2026-11-04) declined the highlighting dependency for the CLI.
2. **The text is untrusted.** A model wrote it. The scanner must be linear in the text on any input, must never change a character, and must not be a new way to put control characters on a terminal.
3. **The text arrives in pieces.** An unfinished fence is code through the end of the turn, so the scanner sees partial code again and again, and a string or comment may be open at the end of what has arrived.
4. **The terminal's colours are unknown.** The product reads no terminal background and has one colour switch (on or off). Whatever it draws has to be legible on a light and on a dark theme.
5. **Colour carries no meaning on its own.** [accessibility.md](../reference/cli/accessibility.md) requires it. Highlighting is decoration.

Measured on 2026-11-23, on Node 22, by installing each package alone with `npm install --omit=dev --ignore-scripts` and bundling it with esbuild:

| Candidate | Installed | Notes |
|---|---|---|
| highlight.js 11.12 | 5.5 MB unpacked, 9.4 MB on disk; 164 KB minified (54 KB gzip) for 36 languages | Regex grammars. Open reports describe quadratic regexes: one lists 17 regexes in 15 grammars, with 11 s for a 40 KB input in the worst, and another 20 s at 64 KB. Those are single reporters' measurements, not reproduced here. An earlier advisory (GHSA-7wwv-vh3v-89cq) was a ReDoS in 2020. |
| lowlight 3.3 | 6 packages, 9.6 MB | A wrapper over highlight.js; same grammars. |
| Prism 1.30 | 3.7 MB | Two advisories since 2022 (CVE-2022-23647, CVE-2024-53382); no 2.x release. |
| shiki 4.6, starry-night 3.11 | 45 packages and 22 MB; 6 packages and 24 MB | TextMate grammars on a WASM engine. |
| tree-sitter 0.25 | a native addon built with node-gyp | A real parser, but native code for a pure-TypeScript CLI; the WASM binding ships grammars separately. |

Other terminal agents differ. Some highlight each line on its own and lose multi-line state, so a docstring continuation is coloured as code. One keeps parser state across chunks, and gives up on a fence above 512 KiB, 10,000 lines or a 4 KiB line. Most use truecolor themes and detect a light or dark background. Contrast complaints about fixed palettes are common: a blue on a dark theme and a yellow on a light one are the usual ones.

## Decision

1. **An in-house lexical scanner, no dependency.** One hand-written scanner per language family classes the text of a fenced block into token classes. It does not parse, it never edits text, and it reads forward. A scanner says only where the next run ends, so the runs are contiguous by construction: no character can be dropped, repeated or reordered, and a test joins the runs back to the text on random and adversarial input. Every lookahead goes through one remembered, charged search per delimiter (`Segments.find`): asking again past a search that found nothing reads nothing, and the work counter sees every character a search reads. The counter is held to 8 per character plus 256, and a scanner that exceeds it throws, which the caller turns into "not highlighted". A loop that consumes what it reads is linear by construction; a lookahead is the only way to read the same text twice, and a guard test keeps any scanner from searching the whole text with its own `indexOf`.
2. **A class travels in the span, a colour does not.** `MarkdownSpan` gains an optional `token`, so the layout still describes semantic styling only. The palette is one record in the TUI layer, and the type makes it complete: a new class cannot be left without a style.
3. **Nineteen language families, chosen by the info string's first word.** TypeScript, JavaScript, JSON, Python, shell, YAML, TOML, INI, diff, SQL, Go, Rust, Java, C, C++, C#, HTML and XML (one scanner), CSS and Dockerfile. `ts title="a.ts"`, `{.ts}`, `typescript{1,3}`, `language-ts` and `ts:src/a.ts` all name TypeScript. There is no content sniffing: a block with no info string, or one the scanner does not know, keeps today's single cyan code span. The reference lists every alias.
4. **Fourteen classes, five named colours, bold and dim.** The reference holds the class-to-colour table. The principle is here: only the colours the product's status palette already holds (green, red, yellow, cyan, magenta), a function name bold and a comment dim. Blue and the bright shades are left out on purpose, and a comment is dim and not a grey, because the terminal draws some greys as its background. Only named ANSI colours are used, so the terminal's own palette picks the shade and no light/dark detection is needed. Code in a highlighted block that has no class of its own (identifiers, punctuation) is drawn in the default colour; a block that is not highlighted keeps cyan.
5. **Limits are whole-block.** A block over 65,536 UTF-16 code units, or with a line over 4,096, is not highlighted at all, and neither is one whose scanner throws. A partly coloured block would look broken; a plain one looks like it always did. The line limit also keeps minified and generated text out.
6. **Streaming costs no more than it did.** The scanner is a pure function of the block text. The live tail already lays out at most 4,000 characters of an open fence, so each tick scans at most that much, and a closed block is laid out once and cached by width. The window drops the fence's label when the block is long, but it keeps the language (`highlightInfo`), so a long block is coloured while it streams. A construct that opened before the window, such as a block comment, is read as code until the turn ends and the whole text is laid out. Only a colour changes at that moment: no character and no row does. An unfinished multiline construct (a block comment, a template literal, a triple-quoted or raw string) colours the rest of the block until it closes, which is what an editor does too; an unfinished single-line string ends at its line.
7. **Colour off is unchanged.** With colour disabled the source keeps its markers and the spans are not drawn. `/copy`, `/edit` and `/scrollback` read the source projection, which highlighting never touches.
8. **The approximation is stated.** The scanners are lexical. Known misreads change a colour and nothing else: a regular-expression literal after a `)` in JavaScript, an apostrophe in JSX text, a heredoc body in shell, a TypeScript contextual keyword used as a name, a template literal nested more than 32 deep. The reference lists them.
9. **No setting yet.** `--no-color` and `NO_COLOR` turn it off. A setting, and a palette chosen by the terminal's background, are follow-ups; neither needs a change to this contract.

## Consequences

### Positive

- A diff shows what was added and removed, a shell command shows its command and options, and a TypeScript or Python answer reads like code, in every chat, in both renderers.
- No dependency, no bundle growth beyond the scanner's own source, no grammar regexes. A scan cannot be made quadratic without the work counter showing it, and a test fails when four times the text costs more than about four times the work.
- The text, the rows and the geometry are identical with and without highlighting. A test lays out the same answer both ways and compares the rows.
- One palette, and only colours the product's own status palette already holds (green, red, yellow, cyan and magenta), so no new colour family is introduced.

### Negative

- About 2,100 lines of scanner code and a keyword table per language to keep current. Adding a language to the C-like family is one profile, but it is still a table to get right.
- Lexical scanning is approximate. It cannot tell a function name from a variable or a type from a value, so a call is shown bold and nothing finer is distinguished.
- Colour shades depend on the terminal. Yellow is the weakest on a light theme and a terminal with a minimum-contrast setting repairs it; this ADR does not.
- A block over 65,536 code units, a language not listed, and a block with no info string are not highlighted. The last is the most common surprise: a model that writes a bare fence gets no colour.
- A construct that opens before the 4,000-character live window is mis-coloured until the turn ends.
- The approval card's diff and the tool previews are drawn by other renderers and are unchanged.

### Neutral

- The parser and the layout geometry are unchanged. The layout's code branch asks the scanner for spans, and two spans merge only when their class is equal too. The stream passes the language of a fence whose label the live window clips to the layout, in a new optional `MarkdownBlock` field, `highlightInfo`; it changes no row.

## Alternatives considered

- **highlight.js or lowlight.** Rejected. A dependency against rule 2 and D50; megabytes installed; regex grammars with reported quadratic cases, which for model-written text means a hostile input is also an ordinary one.
- **Prism.** Rejected: two advisories since 2022 and no maintained successor; regex-based as well.
- **shiki or starry-night.** Rejected: 22 to 24 MB, dozens of packages, a WASM engine, for a feature that needs a lexer.
- **tree-sitter.** Rejected: native code for a pure-TypeScript CLI (the WASM form ships grammars separately), and a parser is more than colours need.
- **Truecolor themes with light/dark detection.** Deferred. It asks the terminal for its background, which many terminals, multiplexers and the Windows console answer badly or not at all; the named-colour palette needs none of it. It can be added later as a setting.
- **Highlight each line on its own.** Rejected: it loses multi-line state, and a docstring, a template literal or a block comment is then coloured wrongly line by line.
- **Keep plain code.** Rejected: it is the gap this ADR exists to close.

## Verification

- `highlight.test.ts` and `highlight-review.test.ts` pin each language's classes on small, reasoned inputs, the info-string forms, and both size limits apart from each other. The second file holds the misreads an independent review found, each as the input that showed it.
- `highlight-invariants.test.ts` runs every scanner on 300 seeded random texts and on every prefix of one, as a streamed answer shows it. It checks that the runs join to the text, are non-empty and merged, use only palette classes, never split a surrogate pair, and cost at most four steps a character. It also runs 28 adversarial patterns of 64 KiB through every scanner. The proof of linearity is a count, not a clock: the work counter includes every character a lookahead reads, so four times the text must cost no more than about four times the work, and a repeated failing search would show as a ratio near sixteen. A one-second wall limit stays only as a coarse net.
- `segments.test.ts` pins the run collector: clamping, a non-number end, merging, gap filling, the step budget, and the charged and remembered search.
- `highlight-layout.test.ts` pins the layout: classed spans through wrapping, quotes and lists, the limits, an unfinished fence, a long fence in the live tail (open, and closed then followed by text), and the live tail against the finished layout at every line boundary and in small pieces. It lays out the same answer with and without a language and compares the row text.
- `syntax-palette.test.ts` and `markdown-text-highlight.test.tsx` pin the palette (named colours only, no blue, bright or grey) and the SGR sequences a real ink frame carries for each of the fourteen classes, with colour on and off. `highlight-reference.test.ts` compares the reference's language and class tables, and its two limits, with the code in both directions. `highlight-lookahead.test.ts` fails when a scanner searches the whole text with its own `indexOf`, so the work counter keeps seeing every lookahead.
- A sweep of 46 single-rule mutants (a limit, a clamp, a memo, a lookahead's charge, the class of a keyword after a dot, a block scalar's indentation, the language kept in the live tail, and others) is fully killed. The first sweep left a mutant alive for a comment that ran past its line, a `#` after a quote, a broken table header and a size limit tested only through the line limit; each became a test.
- An independent adversarial review (about 63,000 fuzz cases over every scanner and 1,248 layouts) found no wrong text, hang or crash. It found six lookaheads that read the rest of the text again and again, which made the first draft's "single pass" claim false (now `Segments.find`, and the scaling test above); the live tail dropping the language of a block over 4,000 characters (now `highlightInfo`); and a set of colour misreads, now fixed or listed in the reference.
- Measured on 2026-11-23 on the development machine, a block of 64 KiB of realistic text scans in 1 to 2.5 ms (25 to 80 MiB/s). Wrapping the block costs more than scanning it.
- Documents updated with this ADR: [markdown-rendering.md](../reference/cli/markdown-rendering.md), [accessibility.md](../reference/cli/accessibility.md), the note at the top of ADR-0114, the index row in the decision README and the status line in [current.md](../roadmap/current.md).
