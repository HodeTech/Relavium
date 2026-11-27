# MVP-11 unit 9 — the transcript grid (plan Step 7b): the resume point

> Last updated: 2026-11-27. Status: **built 2026-11-27** (units 1–9 are built; see [the implementation log](implementation-log.md), "Unit 9", for what was built, what differs from this plan and what is owed; **the rulings of §6 were revised by the review rounds: the table keeps the original text and the revisions are marked below**). This file is the **resume point** for unit 9: the code map, the design, the rulings and the split, so that the work can continue from the repository alone. The spec is [mvp-11.md](../mvp-11.md) §4.8 (the chat, the speaker marker, the grid), §4.10 (the glyph table), §5.5 rule 7, Step 7 and OD-18; [ADR-0145](../../../decisions/0145-the-cli-has-one-surface-language.md) §6 is the decision. Where this file and the plan differ, this file is newer and the plan gets a dated note.

**What the unit is.** Step 7a (unit 7) put the speaker marker in the existing layout as *data* with an interim guard; the chat still lives at column 0 everywhere. Step 7b moves the chat onto the **grid the Home already uses**: a margin that belongs to the host (the speaker marker, the tool glyph, the inline renderer's role words) and a content column that holds every word a person or a model wrote, with a hanging wrap. It lays out untrusted model text, so it is a **milestone with a scoped security sitting** (a reply row that starts with `›` stays in the content column and can never occupy the marker's place). One increment, one review cycle (the maintainer's rule of 2026-11-26: do not slice small).

## 1. Today (verified on the built CLI, 2026-11-27)

- **Everything is at column 0.** The header, the transcript rows, the prompt, the rule, the status line and the hint all start at column 0 and span the terminal: at 80×24 the rule is 80 columns, at 100×30 it is 100. The frames (`chat-idle-80x24.png`, `palette-chat-80x24.png`, `sheet-file-approval-80x24.png`) draw them on the Home's grid instead.
- **There is no blank row between turns** (the frame has one).
- **The marker is a prefix of the row's text** (`DisplayLine.marker`, `UserRowText` in `transcript-row.tsx`); `guardEntryRows` (`transcript-guard.ts`) blanks `›`, `▸` and `⇄` in model rows after markdown and wrapping. **On the colour-off path a model line `> quote` is indistinguishable from the person's turn** (`>` cannot be blanked): that path is not protected until the grid lands.
- **Tool calls**: `entryLines` joins up to four calls with ` · ` per row; the live region and the docked turn already draw one call per row. `formatToolCall` has the `▸` inside its string and the plain driver reuses it (`commands/chat.ts`).
- **The inline renderer** prints `› text` for the person's turn (`> text` with `--no-color`), plain replies, `▸ read_file …` tool rows, plain notices, a ` stop · …` summary; ADR-0145 §6 says it keeps the words `you` and `agent`: it does not yet.

## 2. The grid

**The content column starts where the Home's wordmark starts and is as wide as the Home's rail** (`apps/cli/src/render/tui/home-layout.ts`: `homeMargin(columns)` = 6 for 80 to 99 columns and 8 from 100; `homeRailWidth` = `min(96, columns − 2 × margin)`). The contract module is **`render/tui/chat-grid.ts`** (a fenced data module; built in the contract commit of this unit): `chatGrid(columns)` → `{ columns, margin, content, text, markerEnd }`, `MarginRole` (`yourTurn | toolCall | modelSwitch | agent`, closed), `marginCell(role, grid, form)` (exactly `margin` columns, composed from product constants only), `MARGIN_WORDS` (`you`, `tool`, `model`, `agent`).

| Terminal | margin | content (W) | text (columns − margin) | marker ends at | frame rows | transcript at rest | sheet budget | transcript with a sheet |
|---|---|---|---|---|---|---|---|---|
| 80×24 | 6 | 68 | 74 | col 3 | 23 | 16 | 12 | 9 |
| 100×30 | 8 | 84 | 92 | col 5 | 29 | 22 | 18 | 9 |
| 120×40 | 8 | 96 | 112 | col 5 | 39 | 32 | 24 | 13 |

The row budgets are row-based and do not move (§4.8's 16 and unit 8's 9 hold). **What changes is the text width**: 80 → 68 columns (−15 %), 100 → 84, 120 → 96, 200 → 96 (left-hung, as the Home). A narrow terminal gives the margin up before the text its room (`margin = min(homeMargin, floor((columns − 16) / 2))`: 0 at 17 columns and fewer, 1 at 18–19, 2 at 20–21, 3 at 22–23, 4 at 24–25, 5 at 26–27, 6 from 28; the marker glyph needs a margin of 3, so it appears from 22 columns; without a marker column the person's turn is bold only). *(Corrected 2026-11-27, review round 1, C-8: the earlier text said "2 below 20, 0 below 16".)*

**The frame's measurement:** the marker is the **third** column left of the content (column 3 at 80 columns, 5 from 100), with two blank columns before the text.

## 3. The design

### 3.1 The transcript model (part A)

`DisplayLine` (`viewport.ts`) becomes `{ text (CONTENT ONLY, never a marker), style, spans?, margin?: MarginRole }` (a `copyLead` was planned and not built: OQ9 chose a content-only drag-copy): the marker leaves the row's text and becomes a typed role that only the host sets. The viewport draws `[margin cell][content]` per row through one shared `TranscriptRow` (used by `TranscriptViewport` and the inline `TranscriptLine`); the viewport's Box stays full width and unmargined, so the measured width stays `columns` (the measured-frame acknowledgement requires it), and the viewport reports `left = frameLeft + margin` as the left edge of the *text*, which keeps `cellAt` and all of `selection.ts` unchanged: a press in the margin clamps to content column 0 and the highlight and a drag-copy cover content only.

- **Wrapping**: every entry wraps at `W` (`wrapTranscript(transcript, content, …)` keeps its low-level meaning); a wrapped line **hangs** (blank margin). A new `transcriptRows(transcript, grid, color, displays)` is the one function that feeds the memo, `liveScrollGeometry`, copy and the acknowledgement; **a source-pin test fails when any other non-test file calls `wrapTranscript(` or `liveScrollGeometry(`** (the width semantic is used at eight call sites: `chat-ink.tsx` 262/967/1923/1974, `home-app.tsx` 777/838, `transcript-acknowledgement.ts` 88/94).
- **Tool calls**: one call per row, `▸` in the margin, the words in the content (`toolCallText`, `formatToolCall` is the two joined, so the plain driver and the documents are byte-stable); the `N omitted calls` tail is its own dim content row.
- **Replies**: the summary and hint rows are drawn at the content column without their leading space (the documents keep it).
- **Notices with a host lead** (the question record `›`, the model switch `⇄`): the first row of each logical line carries the margin role; the text is stripped of the lead.
- **Blank rows**: one blank row before each `user` and `assistant` entry except the first; `tools` and `notices` hug the entry above (the frame). It is added in the `wrapTranscript` loop (not cached); the inline `<Static>` gets the previous entry.
- **Documents stay byte-identical by construction**: `entryLines`, `transcriptDocument`, `/copy`, `/edit`, `/scrollback` keep today's `> ` text form for the person's turn (`TEXT_FORM_YOUR_TURN`); a differential test pins it (`restored-transcript.test.ts:89` and `chat-projection.test.ts:1017-1120` stay green).
- **Selection and drag-copy** copy the content a person sees, without the margin and without a `> ` lead (the documents are the text forms).

### 3.2 The chat's chrome on the grid (part B)

| Element | Target |
|---|---|
| Header | a Box at `marginLeft = margin`; `headerRow(title, W)`: the wordmark at the content column, the title ending at the content column's last column |
| Prompt editor | a Box of exactly `W`; `columns = W` (the editor's hard wrap must equal the width Ink wraps at), as the Home's landing does |
| Rule | `thinRule(W)` |
| Status line | budget `columns − margin` (Home parity; `chatStatusLine` already takes `leftMargin`, `chat-status.ts:26`); `W` would drop `used`/turns at 80 columns |
| Hint, notification, lead row | the content column, `columns − margin` |
| Palette above the prompt | the content column; rows truncated inside it; the row budget is unchanged |
| Live region | tool rows through a `MarginRow` (`▸` in the margin), the streamed answer at `W` (it must wrap exactly as the finished reply will, or it reflows at completion), the busy line and the legend rows at the content column; the spinner stays in the content string |
| Docked turn above a sheet (unit 8) | rows at `W`, tool rows through `MarginRow`; the row budget is unchanged |
| Attachment bar | `columns` passed explicitly (it fits to `stdout.columns` today and would be cut by Ink) |
| Inline pre-mount writes | `emitChatHeader`, `emitIntro`/`wrapIntro` move to the content column and wrap at `W` (they need a `columns` argument) |
| **Sheets and popups** | **unchanged**: the sheets' rules span the terminal and their key rows start at column 2 (the frame), popups are centred; nothing in them depends on the transcript's column 0 or width; only rows are shared |

`ChatView` is rendered by the stand-alone chat and by the Home-hosted `ChatRegion`: both compute `chatGrid(viewport?.cols ?? columns ?? 80)` once in `ChatView` and pass it down; the geometry, selection and copy code is duplicated in `chat-ink.tsx` and `home-app.tsx` (one shared `transcriptSelectionText` replaces the two copies).

### 3.3 The inline renderer (the accessible mode)

Inline rows are `[margin cell][content]` printed through `<Static>` with the same `TranscriptRow`, with the margin in its **word** form: `you` on the first row of the person's turn (bold, accent with colour), `agent` on the first row of each reply block, `tool` on each tool row (the `▸` leaves the content), `model` on the model-switch notice, none on ordinary notices; the question record leads with `you`. Words are ASCII (they read the same under `LC_ALL=C`, which is not detected anywhere), left-aligned at column 0 with a blank column before the content (`agent` + 1 = 6 fits the 80-column margin). A wrapped row hangs. A screen reader hears `you Add VAT…` and `agent total() multiplies…`. Native terminal selection copies the margin spaces and the words (acceptable: the speaker survives).

## 4. Security (the scoped sitting)

**What retires.** The row-level blanking of `›`, `▸`, `⇄` in `guardEntryRows` for user, assistant and notice rows, `guardMarkdownLine` on the live tail and the blanking in `formatBusyLine` and `formatReasoningPanel`: the marker is data in a closed union and model text is laid out in the content column only, so a reply that starts with `›` stays in the content column ("kept in the content column", mvp-11.md Step 7 acceptance); blanking it would damage ordinary output. **What stays:** `stripTerminalControls`/`sanitizeInline`; `blankMarkerGlyphs` where a host word and a model word are composed into ONE string that other consumers reuse (`toolCallText`'s id and target, `repl-info.ts`, `resume-intro.ts`); `TEXT_FORM_YOUR_TURN` and the documents. **Residual (accepted, as 7a accepted `❯`/`˃`):** the text forms are flat text, and a model line `> x` still looks like the person's turn there; on the screen a reply row that begins `› ` sits in the content column, two columns right of the real marker, not bold, with no margin mark.

**Where untrusted text can still reach a column that is not the content column** (each must be drawn at the content column): the header title (scrubbed by `flowLine`) and the status line values; the live stream, the reasoning body, the docked reasoning, the busy and abort lines, the warnings and the notification text; tool ids and targets; markdown quote gutters, list markers, code gutters and rules (inside `W`); notices (command output, the question record, the resume banner); error text; the reverse-search and `@` views (moved into the content column in both hosts and filtered at their drawing sites).

**Invariants and tests.** (1) *Margin ownership*: in the alternate-screen frame, for every row of the header, the transcript, the live region, the docked turn and the prompt block, columns `[0, margin)` are blank unless the row is host-marked (a role of the closed union, a host spinner or a live tool row). (2) *Typing*: `margin` is `MarginRole | undefined`; a `@ts-expect-error` test that `{ margin: '›' }` does not compile; `marginCell` takes no content string. (3) *Width*: `margin + displayWidth(content) ≤ columns` for every row of every role at every width 1 to 300. (4) *Documents byte-stable* over a corpus of every entry kind. (5) *Live/final stability*: the stream and the finished reply wrap identically. (6) *Inline*: the word set is closed; row text is word + padding + content. (7) *The measured-frame acknowledgement* (`transcript-acknowledgement.ts`, a fail-closed consent-adjacent path: `visible()` must count the separator rows in ONE pass over the prefix including the entry): true for a notice at the end of a seeded transcript with separator rows, false when clipped, fail-closed when `measuredWidth < columns`. **Hostile corpus × paths × forms**: a reply first row beginning `›`, `>`, `▸`, `⇄`, `you`, `agent`; a zero-width character or a combining mark before the glyph; a bidi override; `\r` and ANSI; wide characters at the wrap boundary; paths: first row, wrapped row, after `\n`, markdown heading/list/quote/code/table, tool id and target, notice, question record, session title, error text, live tail, reasoning (expanded and docked), the interrupt and busy rows; forms: alternate and inline × colour on and off × columns {1, 2, 5, 10, 16, 19, 20, 29, 30, 40, 80, 100, 120}; a **negative control** that puts `line.text` into the margin and must fail (run the mutation).

## 5. Pins that move and pins that stay

**Move** (the test churn is the cost of the unit; each moved pin is listed with its reason, none is rewritten to pass): the speaker-marker set (`speaker-marker-guard`, `-type`, `-render`, `-host-lead`, `transcript-row-selection-start`, `host-glyphs`), `chat-projection.test.ts` (the `wrapTranscript` block), `restored-transcript`, `transcript-viewport.test.tsx` (frame offset), the mouse coordinates in `chat-app.test.tsx` and `home-app.test.tsx` (columns add the margin), the chat's chrome at column 0 (`chat-prompt-block`, `chat-palette-block`, `chat-palette-direction`, `chat-header-frame`, `chat-long-draft`, `chat-drive-redrive`, `chat-status-drawn-rows`, `chat-overlay-rows`, `sheet-docked-turn`, `docked-turn-rows*`, `chat-hint-under-card`, the status-line tests), the inline set (`chat-intro-*`, `chat-ink.test.ts`, `static-rows-properties`, `commands/chat.test.ts`), the legend golden's chat producers (`chat-view-hints`: rows shift right by the margin; a proof that old = new after stripping the left offset keeps the golden sensitive to wording) and the chat surface-matrix cells. **Stay green**: `selection.test.ts`, `viewport.test.ts`, the `entryLines`/`transcriptDocument`/`/scrollback` tests, `chat-projection-tool-call-strip.test.ts` (the `formatToolCall` strings), the plain driver's tests.

## 6. Rulings (the lead, 2026-11-27, as the code map recommended; the maintainer to confirm)

| # | Question | Ruling |
|---|---|---|
| OQ1 | The marker's column | the frame's: the third column left of the content, two blank columns before the text |
| OQ2 | Tool-call batches | one call per row with `▸` on each; the documents keep the four-per-row join |
| OQ3 | Blank rows between turns | one before each `user` and `assistant` entry except the first; tools and notices hug the entry above (about 40 % more rows per exchange; the frame draws them) |
| OQ4 | A model row that begins `›`, `▸` or `⇄` | ~~no longer blanked in the transcript~~ **REVISED after the security sitting (2026-11-27):** blanked again on every model-written row (the person's own turn on every row too) as defence in depth, because the margin guarantee is exact in Ink's layout but not on a terminal that draws a character wider than the layout library measures; a pure screen filter (`screen-text.ts`) drops the fillers and rewrites the width-unsafe classes at the display boundary; the documents keep every byte |
| OQ5 | Maximum width | 96, left-hung (Home parity) |
| OQ6 | Right margin | the transcript, editor, rule, live stream and palette at `W`; the status line, hint and notification at `columns − margin` (Home parity) |
| OQ7 | Inline words | `you`, `agent`, `tool`, `note` (the model-switch word is `note`: the sentence itself begins `model changed`); a row of a reply, tool call or notice that BEGINS with one of these words (after a folded head: NFKC, no invisible or combining characters) gets its entry's own word (`agent` / `note`) so a speech reader never hears a forged label; `you` for the question record |
| OQ8 | Summary and hint rows | at the content column without the leading space (the documents keep it) |
| OQ9 | Drag-copy of the person's turn | the content only (the `/copy` document is the text form with `> `) |
| OQ10 | Narrow terminals | the degrade rule of §2 |
| OQ11 | The spinner | stays in the content string (the margin holds roles only; the busy goldens do not move) |
| OQ12 | The tool glyph's ASCII form | keep `->` (the code) and correct the table of §4.10 (`-`) (done in mvp-11.md) |
| (new) | The status line at 80–81 columns | the 74-column budget (OQ6) drops `turns` where the frame's own session fit at 80 before; the frame draws shorter words (`ask`, `ctx 18%`) than the shipped `ask mode`, `ctx 18% used`: **recorded deviation**, pinned by a test, the maintainer to decide whether the frame or the wording wins |
| (new) | The cost of the blanking | `›`, `▸`, `⇄` in ordinary reply text (a breadcrumb `Settings › Privacy`) draw as a space, and a drag-copy copies the space; `/copy`, `/edit` and `/scrollback` keep the glyph: **accepted cost**, the maintainer to confirm |
| (new) | The filter changes ordinary text | **round 3 (2026-11-27), accepted cost, the maintainer to confirm:** so that a row is never wider on a terminal than the layout counted, the screen filter runs before every layout that wraps and a full-screen cell clips to one row; it does not draw every skin tone, writes U+FE0F after nine text-default emoji bases (☝ ⛹ ✌ ✍ 🏋 🏌 🕴 🕵 🖐), draws Thai and Lao decomposed (a drag-copy copies that form), drops U+0600 and U+06DD, and puts a ZWNJ after a lone regional indicator; the documents keep every byte; the approval card escapes these classes visibly and the question card escapes all labels of a set when two would draw alike. The widths were measured on tmux 3.7b only |
| OQ13 | Notices with a host lead | margin roles (`yourTurn`, `modelSwitch`) |

## 7. The split and the order

**The contract commit** (done first, by the lead): `chat-grid.ts` and its test, `toolCallText` split out of `formatToolCall`, the data-module fence entry (59 modules).

**Part A (opus): the transcript.** `viewport.ts`, `chat-projection.ts` (`wrapEntry`, `wrapTranscript`, the new `transcriptRows`/geometry/selection helpers, `entryGap`, per-call tool rows), `transcript-guard.ts`, `transcript-row.tsx`, `transcript-viewport.tsx`, `selection.ts`, `transcript-acknowledgement.ts`, the inline `TranscriptLine`/`InlineScrollback`/words in `chat-ink.tsx`, the mouse/copy/geometry call sites in `chat-ink.tsx` and `home-app.tsx`, and the security tests of §4. **Part B (sonnet): the chrome.** `chat-layout.ts`, the header, prompt block, rule, status/hint fit, palette, attachment bar, live region and docked turn (`chat-ink.tsx` 606–632, 692–821, 830–1167; `chat-projection.ts` 460–810), the inline pre-mount writes, `ChatRegion` props in `home-app.tsx`, and their pins. They edit disjoint functions of the same files; the lead integrates, runs the whole suite and the controls on a committed tree, then ONE combined review (security sitting scoped to §4) and fix waves.

**Acceptance.** The Home-hosted chat and the stand-alone chat match each other and the frames at 80×24 and 100×30, alternate and inline, colour on and off; selection and copy suites green; the 80×24 row budget proved; a reply that starts with `›` (and `>`, `▸`, `you`, `agent`) cannot pass for the person's turn in either renderer or form; documents byte-stable; the legend golden and the matrix regenerated with the proof; the real binary driven with `SCRIPT:chev|tri|swap|nl|gt|wide|long|edit|write` of `fake-anthropic.mjs`.

## 8. Documents to update

`chat-session.md` (the speaker marker, the grid, the margin and the inline words), `accessibility.md` (the inline words, the `LC_ALL=C` line), the glossary (margin, content column), ADR-0145 §6 and ADR-0146 dated notes (the grid is built; the interim guard retired; the inline words), `mvp-11.md` (§4.8, §4.10's tool ASCII form, §5.5 rule 7, Step 7b status), the Windows runbook rows for the grid, the implementation log ("Unit 9"), `current.md`, `CLAUDE.md`, `AGENTS.md`.

## 9. Not verified when this plan was written

The impact counts are greps, not runs; Ink's composition (`marginLeft` with `truncate-end`, a `MarginRow` over multi-row children, an editor Box exactly `W` wide) is taken from the Home's precedent and not prototyped; Windows and other real terminals; the narrow-terminal numbers; whether the golden regeneration is purely a left-offset change (reasoned from `frames.tsx`, not diffed).
