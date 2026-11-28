# The CLI surface language

> Last updated: 2026-11-28

- **Status**: Reference — implemented on `development` through MVP-11 unit 9; the close-out (unit 10) is pending.
- **Surface**: the interactive CLI: the [Home](home.md) and [`relavium chat`](chat-session.md), in the full-screen and the inline renderer. The plain, `--json` and one-shot drivers draw none of it ([§7](#7-plain---json-and-one-shot-output)).
- **Decisions**: [ADR-0145](../../decisions/0145-the-cli-has-one-surface-language.md) (the language), [ADR-0146](../../decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) (the Home and the chat), [ADR-0147](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md) (the sheet), [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) (the popup).
- **Code**: the language lives in data modules, five of which this page cites — [`repl-commands.ts`](../../../apps/cli/src/commands/repl-commands.ts), [`legend.ts`](../../../apps/cli/src/render/tui/legend.ts), [`glyphs.ts`](../../../apps/cli/src/render/tui/glyphs.ts), [`sheet-frame.ts`](../../../apps/cli/src/render/tui/sheet-frame.ts) and [`notation.ts`](../../../apps/cli/src/render/notation.ts). None imports `ink`, `react` or `node:` (a lint fence, `CLI_DATA_MODULES` in `eslint.config.mjs`).

This page is the canonical home of the **surface classes**, the **key-hint grammar** and the **glyph table** of the interactive CLI; each is stated once, here. What a particular surface says, guards and keeps is owned by the page named in [See also](#see-also), which this page links and does not copy. Where a table below and an ADR differ, the table is the built behaviour: the ADRs carry dated implementation notes for what the build changed.

## 1. Surfaces, classes and the palette

### 1.1 What a surface is

A **surface** is a place the CLI draws itself and takes the keyboard. **Who started the interaction** picks it ([ADR-0145 §1](../../decisions/0145-the-cli-has-one-surface-language.md#1-who-started-it-picks-the-surface)):

| Surface | Started by | Drawn | Closes with | Declared by |
| --- | --- | --- | --- | --- |
| **Sheet** | The system needs a decision: an approval, the agent's question, the continue checkpoint, a run gate, a budget gate, the exit guard | Docked where the prompt is; the conversation stays above | A decision chord. `Esc` and `Ctrl+C` never approve | The card itself: the registry has no sheet class |
| **Popup** | The user asked, and the result is a report, a setting, a form or a picker | A centred box over a dimmed screen; inline, a framed block that replaces the body | `Esc` | `Placement.surface: 'popup'` |
| **Screen** | The user asked, and the content is long and browsable | Takes the body: the Runs screen, the run view | `Esc` | `'screen'` (no command declares it) |
| **Palette** | The user is choosing a command while typing | Part of the prompt: under it on the Home, above it in a chat | `Esc` | Derived from the registry |
| **Instant** | The user asked, and the result is one line | None | Nothing to close | `Placement.surface: 'instant'` |

A **notification** is the output channel of an instant command and of a closed popup, not a class: one line on the hint row (the last row of the prompt block) for `NOTIFICATION_MS` (3 s), never in the transcript ([`notifications.ts`](../../../apps/cli/src/popups/notifications.ts)).

### 1.2 The rule that picks a class

A command declares a class on **every placement**: `SurfaceClass = 'popup' | 'screen' | 'instant'` is `Placement.surface` in [`repl-commands.ts`](../../../apps/cli/src/commands/repl-commands.ts), and a placement cannot be written without one. The rule:

- a command that produces a **report, a setting, a form or a picker** is a **popup**: what you do in at most three keys and then return to what you were doing;
- a command whose result is **one line** is an **instant**;
- content you **browse and work in for a while** is a **screen**;
- a question the **system** asks is a **sheet**, which is never a command's class.

`Placement.surface` is declared data. The registry test pins the class of every placement, and nothing at run time reads it: each host routes a command to its own popup. No command declares `screen`: the Runs screen and the run view are reached from the work page, from popups and from run rows, and there is no `/runs` command ([home.md](home.md#the-runs-screen-active-and-history-mvp-8-step-4-2026-11-23-narrowed-in-mvp-11-unit-8-2026-11-27)).

### 1.3 Where each command lives

The table holds **27 definitions**, one per name. A name offered on several surfaces is one definition with a **placement** each (`home`, `standalone-chat`, `home-chat`), and the words may differ (`/exit` leaves Relavium, ends a chat or goes back to the Home).

| Placement | Entries | Popup | Screen | Instant |
| --- | --- | --- | --- | --- |
| `home` (the bare Home) | 15 | 13 | 0 | 2 |
| `standalone-chat` (`relavium chat`) | 20 | 11 | 0 | 9 |
| `home-chat` (the chat the Home hosts) | 21 | 12 | 0 | 9 |

| Class and where | Commands |
| --- | --- |
| Popup, on the Home and in both chats | `/help`, `/workflows`, `/doctor`, `/mode`, `/permissions`, `/models` |
| Popup, on the Home only | `/providers`, `/init`, `/import`, `/pricing`, `/run`, `/agents` |
| Popup, on the Home and in the Home-hosted chat | `/resume` |
| Popup, in both chats only | `/export`, `/agent`, `/cost`, `/effort`, `/details` |
| Instant, on the Home and in both chats | `/exit`, `/clear` |
| Instant, in both chats only | `/cancel`, `/thinking`, `/compact`, `/trim`, `/scrollback`, `/edit`, `/copy` |

A command is either `opener: 'home'` (`/providers`, `/init`, `/import`, `/pricing`, `/resume`, `/run`, `/agents`: no handler in the registry) or has a `run` over a chat's capabilities. The Home controller opens its own words, those seven and its `/workflows`, `/permissions` and `/mode`, from one record, `homeWords` in [`home-controller.ts`](../../../apps/cli/src/render/tui/home-controller.ts), and answers `/help`, `/exit`, `/doctor`, `/clear` and `/models` beside it. What a typed word gets at the landing is [home.md](home.md#typed-slash-words-and-help-at-the-landing-mvp-8-step-5-2026-11-23)'s.

### 1.4 The palette's order and rules

The order is **intent order, not alphabet** ([ADR-0145 §7](../../decisions/0145-the-cli-has-one-surface-language.md#7-the-registry-is-one-table-that-orders-the-palette)). A placement has a **group** of its surface and a **rank**, unique inside the group; a surface lists its commands by group order, then rank (`commandDefinitionsOf`).

| Surface | Groups, in order (`CommandGroup`) |
| --- | --- |
| `home` | Work (`work`), Set up (`setup`), Check (`check`), End (`end`) |
| `standalone-chat`, `home-chat` | Model and behaviour (`model`), Context (`context`), Inspect (`inspect`), Take away (`takeaway`), End (`end`) |

The exact order, command by command, is pinned by `HOME_ORDER`, `CHAT_ORDER` and `HOME_CHAT_ORDER` in [`repl-registry.test.ts`](../../../apps/cli/src/commands/repl-registry.test.ts) and is not copied here. The palette draws no group heading, only a blank row between groups where the rows allow; the Home's `/help` popup is the one place that writes the Home's four group names.

- **The first row touches the prompt.** On the Home the list opens under the prompt and reads top to bottom; in a chat it opens above the prompt and reads bottom to top (`↑` is the next entry). `/exit`, last in every order, is the row **farthest** from the prompt. There is no wrap-around, and `Home`/`End` jump to the first and the last entry in list order.
- **`/` then `Enter` never leaves.** The palette opens on the **first enabled row** (`openPalette`): `/resume` on a Home with a saved session, otherwise `/run`; `/providers` leads a Home with no usable key; `/models` in a chat. `/exit` runs only when selected on purpose.
- **`/exit` is last**, and `/clear` (Home) or `/cancel` (chats) stands just above it.
- **A command that cannot act is dim, with its reason, never hidden.** Today that is `/clear` on the bare Home (`no conversation to clear`) and `/resume` with nothing saved (`nothing to resume`). The arrow keys skip a dim row, and `Enter` on one says `/<name> is unavailable: <reason>.` and runs nothing. Availability reads cached state only, and an unknown fact reads as enabled.
- **A typed query** ranks an exact name, a name prefix, a name containing it, then a description containing it, each tier in declared order. `/clear`, `/cancel`, `/compact` and `/exit` come last inside a tier; with `/trim` they are never highlighted unless the query begins their name.
- **A command the surface does not offer** answers one line that names the surface that has it and opens nothing (`homeOnlyPointer`). A stand-alone chat says how to reach it (`/<name> is available from the Home: start Relavium without arguments.`); the Home-hosted chat only names it.
- **One source for the words.** The palette, `/help` and the unknown-slash hint are derived from the same placements (`commandsOf`, `formatReplHelp`, `replCommandList`), so they cannot disagree.

## 2. The key-hint grammar

Every hint line is built by [`legend.ts`](../../../apps/cli/src/render/tui/legend.ts) ([ADR-0145 §3](../../decisions/0145-the-cli-has-one-surface-language.md#3-the-legend-grammar)). A screen builds its legend from the constants its key handler matches, so a hint cannot name a key the handler ignores.

| Rule | Grammar | Example |
| --- | --- | --- |
| Keys | A letter, a digit, a Ctrl chord and an Alt chord are **bracketed**. The universal keys are plain: `Enter`, `Esc`, `Tab`, `Shift+Tab`, `Space`, `Backspace`, `Del`, the arrows, `PgUp`/`PgDn`, `Home`/`End`. One function, `keyToken`, decides, sentences included | `[d] withdraw`, `Enter apply` |
| Several keys, one effect | Joined by ` / `, or by `, ` when a key already holds a slash | `↑/↓, PgUp/PgDn select` |
| Verb | A lower-case imperative that states the effect; no full stop. A key of an approval's answer row keeps the capitalised word of its family ([ADR-0145 §4](../../decisions/0145-the-cli-has-one-surface-language.md#4-approval-words)) | `[Ctrl+Y] Allow once` |
| Count | In parentheses after the verb | `[Ctrl+C] exit (twice)` |
| Separator | One, ` · `, on every row | `Enter apply · Esc close` |
| Text | A status, a reason, a position or live text between the keys is a `LegendText`, dim | `Notice 1–17 of 60 · PgUp/PgDn read` |
| A locked key | The whole item is dim and its verb is followed by `(wait)` in the same text. Set by a surface from its guard only (`waitMark`); nothing reads it back from a label | `[Ctrl+Y] Create them (wait)` |
| The key that leaves | **Last**, with its effect written. `exit` is a required argument of `legend(items, exit)`, built by one of four constructors | below |

Keys are drawn in a role: `strong` by default, `ok` for an answer that allows, `danger` for one that denies or destroys, `warn` for a stop. Verbs, texts and separators are dim.

### 2.1 The required exit label, four classes

The class belongs to the pair (surface, state), not to the surface. `Esc` and `Ctrl+C` never approve.

| Class (`exitKey.`) | Meaning | Words | Used by |
| --- | --- | --- | --- |
| `close` | Nothing changes | `Esc close` | The palette, a picker, a popup's first step |
| `step` | Back one level | `Esc back` | A popup's later step, a detail to its list, the inspection popup to its approval |
| `decide` | Rejects and stops; the consequence is stated as a fact (role `warn`) | `Esc stops the turn` | The approval, the agent's question, the checkpoint |
| `leave` | The surface closes and the work or the state stays | `Esc leaves it running`, `Esc leaves it pending` | The run view, a gate card |

### 2.2 Builders

| Function | Use |
| --- | --- |
| `legend(items, exit)`, `legendSpans` | The text, and where its keys, verbs, texts and separators are, so a view colours a key by role and never by guessing from the text |
| `legendItems`, `keyHint` | Items with no exit: a hint beside a row, a card's first answer row |
| `fitLegend(required, optional, exit, columns, width)` | Drops the optional items of the lowest priority first; the required items and the exit are never dropped |
| `legendRows(items, exit, columns, width)` | For a refusal on a terminal too narrow for one row: cut **between** items, never inside one |
| `inertLegendText(text)` | Untrusted text (a file name, a command) drawn inside a legend: a ` · ` becomes ` - ` and a bracketed key token becomes parenthesised, lookalikes included |

## 3. The glyph table

[`glyphs.ts`](../../../apps/cli/src/render/tui/glyphs.ts) holds **30 roles**: 16 statuses and 14 shapes ([ADR-0145 §5](../../decisions/0145-the-cli-has-one-surface-language.md#5-the-visual-language)). Every status table, selection marker, scroll marker and tool marker reads it, and `glyph-table-only.test.ts` holds the rest of the non-test source to a reasoned allow-list of symbol characters.

- **A status carries a word.** The glyph is never the only carrier of a state (`wordOf`); a shape carries none. A surface with a more exact word keeps it and takes only the glyph.
- **Two forms.** The Unicode glyph is the default; the plain ASCII form is drawn exactly when **colour is off** (`NO_COLOR`, `--no-color`, `FORCE_COLOR=0`). Nothing reads a locale (Phase 2.6.L). A view picks the form with its `color` prop (`glyphOf(role, ascii)`), or runs a pure model inside `withGlyphForm(!color, …)` so the layout is measured on the form drawn. The mapping is by role, never by text.
- **Plain forms** are printable ASCII, at most three columns, distinct from each other except the declared sharing groups, and never a key label (the legend brackets keys). A status list gives its glyph one column, or two in the plain form (`statusCell`).

### 3.1 Statuses

| Role | Glyph | Plain | Word | Tone |
| --- | --- | --- | --- | --- |
| `completed` | `✓` | `ok` | completed | green |
| `failed` | `✗` | `x` | failed | red |
| `paused` | `‖` | `\|\|` | paused | yellow |
| `cancelled` | `⊘` | `/` | cancelled | gray |
| `skipped` | `⊘` | `/` | skipped | gray |
| `running` | `◐` | `~` | running | cyan |
| `starting` | `◌` | `..` | starting | cyan |
| `pending` | `○` | `o` | pending | gray |
| `ended` | `○` | `o` | ended | gray |
| `currentStep` | `◉` | `@` | current | cyan |
| `retrying` | `↻` | `r` | retrying | yellow |
| `held` | `◇` | `<>` | held | yellow |
| `warning` | `⚠` | `!` | warning | yellow |
| `stopping` | `■` | `#` | stopping | yellow |
| `answered` | `●` | `+` | answered | green |
| `pinned` | `★` | `P` | pinned | yellow |

`cancelled`/`skipped`, `pending`/`ended` and `selection`/`yourTurn` share one glyph and one plain form on purpose (`SHARED_GLYPH_ROLES`): they read apart by their words or by their surface. A mark that is its own word is written once (`ok`, not `ok ok`: `markWithWord`). Every status role is blanked in author text (§3.3).

### 3.2 Shapes

| Role | Glyph | Plain | Draws | Blanked in |
| --- | --- | --- | --- | --- |
| `railLine` | `╌` | `.` | The rail of a popup's steps | author text |
| `heavyRule` | `━` | `=` | The sheet's rule | author text |
| `thinRule` | `─` | `-` | A card's, a frame's, a sheet title's and a popup edge's rule | author text |
| `selection` | `›` | `>` | The one selection marker; the selected row is also bold and inverse | author text, transcript rows |
| `yourTurn` | `›` | `>` | The margin mark of the person's turn (bold) | author text, transcript rows |
| `toolCall` | `▸` | `->` | The margin mark of a tool call | author text, transcript rows |
| `modelSwitch` | `⇄` | `<->` | The model-switch marker | author text, transcript rows |
| `moreAbove` | `▲` | `^` | `▲ N more` | never: ordinary text |
| `moreBelow` | `▼` | `v` | `▼ N more` | never: ordinary text |
| `bullet` | `•` | `*` | The chosen dot of a choice, `(•)` | never: ordinary text |
| `caret` | `█` | `_` | The text caret of a field the host draws | author text |
| `activeBar` | `▌` | `\|` | The bar that heads the active step of the run view | author text |
| `media` | `◆` | `&` | The lead of a produced media deliverable's line | author text |
| `pencil` | `✎` | `e` | The question card's own-answer row, a proposed patch's line | author text |

**Not in the table**: the Braille spinner and seven lead-in glyphs (`📎 ✨ ⟳ ✂ ✻ ✎ ⧗`, each beside its own sentence) are allow-listed with a reason and have no plain form until Phase 2.6.L. The pencil's plain form is in the table, but the surfaces that draw `✎` still write it themselves. Retired and still blanked: `⏸` (now `‖`), the Home's `▶` (now `◐`), the native prompt's `❯` (now `›`).

### 3.3 Host glyphs

A glyph the host draws as a status or a marker must not be reproducible by text an author or a model wrote where it is drawn next to the host's own. The core owns its refusal set (`HOST_GLYPH` in `packages/core/src/tools/ask-user.ts`: the box-drawing block `U+2500`–`U+257F`, `›`, `✎`, `█`); the CLI's sets contain it, and `host-glyphs.test.ts` calls the core's refusal and fails when it refuses something the CLI set does not blank. Why, and what each set protects: [ADR-0145 §5](../../decisions/0145-the-cli-has-one-surface-language.md#5-the-visual-language) and [§6](../../decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker); the argument is not restated.

| Function | Blanks (to a space, one column for one) | For |
| --- | --- | --- |
| `blankHostGlyphs` | The box-drawing block, the glyph of every role not marked `hostBlanked: false`, and the retired glyphs | Author text drawn inside a host card (a gate's message, an MCP consent's subject) |
| `blankHostShapes`, `blankHostMarks` | The parentheses of the host's choice marks, `( )` and `(•)` (in the plain form `( )` and `(*)`), and in the plain form a leading `>` before a digit or a space. `blankHostMarks` runs `blankHostGlyphs` first | Model text beside the question card's marks |
| `blankMarkerGlyphs` | Only `›`, `▸` and `⇄` (the roles marked `guarded`) | The chat's drawn rows of text that is not the host's. `/copy`, `/edit` and `/scrollback` keep every byte |

The three `hostBlanked: false` roles (`▲`, `▼`, `•`) are shapes that are also ordinary text, so an author's bullet list and a path holding a triangle are left alone.

## 4. Frames

### 4.1 The sheet frame

A sheet opens with **one rule**, built by `sheetRule(label, clock, width)` in [`sheet-frame.ts`](../../../apps/cli/src/render/tui/sheet-frame.ts): `━━ <label> ━━━━━ waiting 0:41 ━━`. Its sides are open (a tray, not a box). Without colour the heavy rule is `=` and the thin rule `-`, so the two stay apart. The rule is yellow for a decision and cyan for the agent's question. Under it come a title line, the body and two key lines whose `Esc` effect is always written ([ADR-0147 §1](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md#1-the-frame)).

| Card | Rule label | Clock |
| --- | --- | --- |
| Approval (a file edit and a command) | `Approval needed` | yes |
| The agent's question | `Question from the agent · not an approval` | yes |
| The continue checkpoint | `Checkpoint` | yes |
| The run gate and the budget gate (on the Home) | `Waiting for you`, then `Run gate` once nothing waits | only while it waits |
| The exit guard (on the Home) | `Leaving the Home` | none |

**The exception:** the MCP consent card of a hosted leg is drawn by the native chord card and keeps that card's own frame and its `(wait)` marks.

**The wait clock** is display state: it is in **no snapshot** and **no guard reads it**, so the measured-frame acknowledgement and every dwell are untouched by a tick ([ADR-0147 §2](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md#2-the-wait-clock-is-display-state-and-it-is-not-in-any-snapshot)).

| | Alternate screen | Inline |
| --- | --- | --- |
| Text | `waiting 0:41`, then `waiting 2m`, `waiting 1h 07m`, `waiting 1d 03h`, `waiting 99d+` | `waiting since 14:05`; `waiting since Nov 25 14:05` for an earlier day; `waiting since Nov 25 2026` for an earlier year |
| Repaint | One `unref`'d one-second timer owned by the sheet's host, drawn only when the quantised text changed | None: nothing repaints on a timer |
| Width | The rule reserves `WAIT_CLOCK_COLUMNS` (26) for the widest form, so a tick never changes the rule's geometry | The same |

Where a lockout holds a key, the card's legend draws it dim with `(wait)` (§2). The guards, their constants and the answer chords are [chat-session.md](chat-session.md#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27)'s.

### 4.2 The popup

A popup is the surface of a command the user started ([ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)). It is built by [`frame-model.ts`](../../../apps/cli/src/popups/frame-model.ts) and [`geometry.ts`](../../../apps/cli/src/popups/geometry.ts) and drawn in one overlay slot ([`popup-slot.tsx`](../../../apps/cli/src/popups/popup-slot.tsx)).

| Part | Content |
| --- | --- |
| Top edge | A thin rule that carries the command's name on the left and the origin on the right (`from Home`, `from chat`, `first run`, `from /workflows`); a popup of more than one step adds `step 2 of 3` |
| Rail | Only for more than one step: `✓ done ╌╌ ◉ current ╌╌ ○ to come`, each glyph from the table |
| Body | A list, a form or a report, in one of four states: loading, empty, error, overflow ([ADR-0148 §5](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md#5-states-and-stacking)) |
| Legend row | Always ends with the way back (`Esc close` on a first step, `Esc back to Home` on the Home's management popups, `Esc back` and `[Ctrl+C] close` after a first step); a live notification replaces the keys and still ends with the way back |
| Bottom edge | A thin rule |

The sides are open, with one blank column of margin inside each side, so the frame has no border glyph to read on every line.

| | Alternate screen | Inline (the accessible mode) |
| --- | --- | --- |
| Placement | An absolutely positioned box over the body, centred | A framed block that **replaces the body** |
| Size | `min(columns − 2 × margin, 76)` columns, margin 6 for 80 to 99 columns and 8 from 100 (68 at 80); at most 21 rows | The whole live region stays at most `rows − 1` lines; lists windowed to 10 rows |
| Opacity | Every row is padded with spaces to the frame's width | n/a |
| Backdrop | Everything but the slot is dimmed with colour on; the popup's own cells never are | None |
| Floor | Below 80×24 a notice with the way back replaces the popup | The same |

The slot is the last child of a host's root and the **only absolutely positioned node** in the CLI (`popup-absolute-only.test.ts`); `backdrop-dim.test.tsx` checks every cell. Keys: `↑/↓` select; `Enter` goes to the next step or applies; `Esc` goes back one step and closes on the first; `Ctrl+C` closes the whole popup and arms no exit window; neither confirms anything. A popup opens only on the user's command, between turns, with no card or sheet open (the first-run provider setup is the one exception); a sheet that arrives closes it unanswered; it writes nothing into the transcript or the Home's notice, the model-switch marker excepted ([ADR-0148 §2](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md#2-opening-ownership-and-what-a-popup-may-cover) and [§6](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md#6-the-residue-rule-and-its-exception)). What each Home popup shows is [home.md](home.md#the-homes-management-popups-mvp-11-unit-8-2026-11-27)'s; `/mode` is [chat-session.md](chat-session.md#the-mode-popup-mvp-11-unit-8-2026-11-27)'s.

### 4.3 The inspection popup

The approval's full view (`[v]`) and `/details` are one **large popup that belongs to the sheet**: `columns − 2` by `rows − 1` (78 × 23 at 80×24), drawn in the flow in the body's place. `Esc` and `[b]` step back and never reject; the approval stays pending underneath. Its pages, keys, locks and geometry are [chat-session.md](chat-session.md#the-full-view-and-the-tool-details)'s and [ADR-0148 §7](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md#7-the-inspection-popup-the-full-view-and-details)'s.

### 4.4 The Runs screen

The one screen the Home keeps for browsing runs: two tabs, **Active** and **History**, this directory's runs by default (`[a] all`). It is the code's `tab-host`, entered from the landing only, and `Esc` goes back one level or closes it. Its keys, rows and budgets are [home.md](home.md#the-runs-screen-active-and-history-mvp-8-step-4-2026-11-23-narrowed-in-mvp-11-unit-8-2026-11-27)'s.

## 5. The chat grid

The interactive chat draws on the Home's grid: a **margin** on the left that belongs to the host, and a **content column** that holds every word a person or a model wrote. The margin is 6 columns from 80 to 99 and 8 from 100; the content column is `min(96, columns − 2 × margin)` wide, so 68 at 80 ([`chat-grid.ts`](../../../apps/cli/src/render/tui/chat-grid.ts)). A row's mark is data the host sets from a closed set (`MarginRole`: `yourTurn`, `toolCall`, `modelSwitch`, `agent`, `notice`), never a character of its text, so nothing a model or a person wrote can stand where the host's mark does. In the full-screen renderer the person's turn has `›` (`>` without colour) and a tool call has `▸` (`->`); the inline renderer writes the words `you`, `agent`, `tool` and `note` instead.

Because a terminal can draw a character wider than the layout counted, the text of a person and a model is changed on its way to the screen, before the layout, and a full-screen cell clips to one row; the three marker glyphs are blanked in those rows (§3.3). The widths, the wrapping, the blank rows, the screen's treatment of text and the copy documents are [chat-session.md, "The transcript grid"](chat-session.md#the-transcript-grid-mvp-11-unit-9-2026-11-27); the decision and its accepted limits are [ADR-0145 §6](../../decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker) and its note of 2026-11-27.

## 6. Money and number notations

[`notation.ts`](../../../apps/cli/src/render/notation.ts) is the one place human text writes money, time, identifiers and paths; its functions are pure, and a surface that wants a path or a clock passes it in ([ADR-0145 §8](../../decisions/0145-the-cli-has-one-surface-language.md#8-notation)).

| Family | Function | Reads | Rule |
| --- | --- | --- | --- |
| Money: a spent amount | `formatUsd` | `$0.1235` | Four fractional digits, rounded half up on the integer |
| Money: an amount authorised, capped or held | `formatUsdExact` | `$0.0500`, `$0.05000001` | Four to eight digits, **never rounded**: display must not understate what a person authorises |
| Money: a price | `formatPrice`, `formatPricePair`, `pricePhrase` | `$3 per M`, `$3 / $15 per M` | Input first, under a header that says which; units `M`, `image`, `second` |
| Money: raw micro-cents | The integer itself | `300000000` | Machine output and the one flag that takes it (`--approve-amount`); never in human text |
| Time | `formatDuration`, `formatElapsed` | `1m04s`, `1h01m` | A completed span; a live counter in whole seconds |
| Time | `formatAge`, `formatTimeUntil` | `5m ago`, `in 5m` | More than a minute ahead of the clock is `in the future` |
| Time | `formatDate`, `formatClock`, `formatDateTime` | `2026-11-24 09:05 UTC` | UTC, with the zone said |
| Identifier | `shortId` | The first 8 code points | Only where an id is a label; never where a person types or compares it |
| Path | `displayPath` | `src/app.ts`, `~/…` | Project-relative, or from `~`, or as given when it is inside neither |
| Path | `directoryLabel`, `cutPathNames`, `cutPathLead` | `~/acme-web`, `…/app` | The working directory as one short label, cut by names |

Three money notations exist and no more: a USD amount, a per-million price and raw micro-cents. Arithmetic is on the integer, never a float; an amount that cannot be shown exactly reads `unavailable`. A path is never sanitised here: the caller sanitises it after the shortening. The sheet's wait clock (§4.1) is its own, in `sheet-frame.ts`.

## 7. Plain, `--json` and one-shot output

| Driver | What the surface language does there |
| --- | --- |
| `--json` | No change to the NDJSON stream, its events or the exit codes: that is the machine contract ([commands.md](commands.md#the---json-machine-output-contract), [ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Raw micro-cents stay in machine fields |
| Plain (no TTY or `CI=true`), one-shot and `--json` chats | No screen: no popup, sheet, margin, grid or palette. A command that is a popup in a terminal runs the same handler and prints the same text. The `/help` text and the unknown-slash hint these drivers print are derived from the registry and follow its order |
| Shell commands (`Surface = 'shell'`) | May name a subcommand as a remedy. The TUI does not: a remedy there names an action the surface has, bar the reasoned allow-lists of `no-shell-remedy.test.ts` ([ADR-0122 §6](../../decisions/0122-the-home-is-the-interactive-product.md)) |

The human text that changed on scripted paths (glyph retirements, `$3 per M`, `Budget allowance: $0.0420`, the `NO_COLOR` wording of `--help`, the order of `/help`) is listed under **Changed** in [`apps/cli/CHANGELOG.md`](../../../apps/cli/CHANGELOG.md), `[Unreleased]`, "MVP-11". The output modes and the colour precedence are [commands.md](commands.md#output-modes)'s.

## 8. Adding a command, a glyph, a legend or a notation

| You add | Edit | Tests that fail if you forget |
| --- | --- | --- |
| A command | A `CommandDefinition` in `COMMAND_TABLE` ([`repl-commands.ts`](../../../apps/cli/src/commands/repl-commands.ts)): a placement per surface with its group, a rank unique in the group, a one-line description and a class. A `run` over the session, or `opener: 'home'` and an entry in `homeWords` | [`repl-registry.test.ts`](../../../apps/cli/src/commands/repl-registry.test.ts): the fields, a total order, the surface's groups, the pinned order and counts, the pinned class table, the popup bookkeeping (a popup placement is in exactly one of `POPUP_NOT_BUILT_YET` and `POPUP_MODULES`, and its command is in `BUILT_BY`), `/exit` last. [`home-registry-dispatch.test.ts`](../../../apps/cli/src/render/tui/home-registry-dispatch.test.ts): every Home placement has an outcome, and a chat's word is not the Home's. [`palette-entries.test.ts`](../../../apps/cli/src/render/tui/palette-entries.test.ts): the rows. [`no-shell-remedy.test.ts`](../../../apps/cli/src/render/no-shell-remedy.test.ts): no string names a shell command or a `/command` the surface lacks |
| A surface for it | A row in `PRODUCT_SURFACES` and a mounted entry in `surfaces-home.ts` or `surfaces-chat.ts` under [`surface-matrix/`](../../../apps/cli/src/render/tui/surface-matrix/) | [`surface-matrix-completeness.test.ts`](../../../apps/cli/src/render/tui/surface-matrix/surface-matrix-completeness.test.ts): a row that is neither mounted nor listed in `NOT_COVERED_YET` fails. The table is hand-kept and is **not derived from the registry**, so a new command does not fail it by itself |
| A glyph | An entry in `ENTRIES` ([`glyphs.ts`](../../../apps/cli/src/render/tui/glyphs.ts)): one column wide, a plain form of at most three columns, a word and a tone for a status; `hostBlanked: false` only for ordinary text, `guarded` only for a transcript marker | [`glyphs.test.ts`](../../../apps/cli/src/render/tui/glyphs.test.ts): the table is pinned cell by cell, plain forms and glyphs are distinct, widths. [`host-glyphs.test.ts`](../../../apps/cli/src/render/tui/host-glyphs.test.ts): the core's refusal against the CLI set. [`glyph-table-only.test.ts`](../../../apps/cli/src/render/tui/glyph-table-only.test.ts): a symbol character written anywhere else needs an allow-list entry with a reason. [`glyph-form-scope.test.ts`](../../../apps/cli/src/render/tui/glyph-form-scope.test.ts): a read of the form outside `withGlyphForm` |
| A key hint | A call to `legend(items, exit)` with an `exitKey` class | [`legend.test.ts`](../../../apps/cli/src/render/tui/legend.test.ts) and its siblings (`legend-wait`, `legend-rows`, `legend-separator-lookalikes`). [`legend-golden/legend-completeness.test.ts`](../../../apps/cli/src/render/tui/legend-golden/legend-completeness.test.ts): a hint-shaped literal outside the builder fails; list the producer in `producers.ts`. [`legend-golden/legend-golden.test.ts`](../../../apps/cli/src/render/tui/legend-golden/legend-golden.test.ts): a wording change moves the golden, regenerated with `UPDATE_LEGEND_GOLDEN=1`. The key table's own test presses every key it lists |
| A notation | A function in [`notation.ts`](../../../apps/cli/src/render/notation.ts) | [`notation.test.ts`](../../../apps/cli/src/render/notation.test.ts) and [`notation-surfaces.test.ts`](../../../apps/cli/src/render/notation-surfaces.test.ts) |
| A data module | The named list `CLI_DATA_MODULES` in `eslint.config.mjs` and its copy in `tools/lint-fixtures/assert-fence.mjs` | The fence fixture: dropping or adding an entry on one side alone fails |

Also update the page that owns the surface (§ See also), never this page's tables by copying a row there.

## See also

| Page | Owns |
| --- | --- |
| [home.md](home.md) | The Home: the landing and the work page, its popups, the Runs screen, typed slash words, the cards |
| [chat-session.md](chat-session.md) | The chat: the transcript grid, the sheets' guards and the wait clock, the mode popup, the full view and `/details` |
| [commands.md](commands.md) | The shell commands, the output modes, the colour precedence, the `--json` contract |
| [accessibility.md](accessibility.md) | The full-screen renderer's trade-off and the inline renderer, the accessible mode |
| [command-permissions.md](command-permissions.md) | The command card and `/permissions` |
| [markdown-rendering.md](markdown-rendering.md) | How a reply's markdown is laid out in the content column |
