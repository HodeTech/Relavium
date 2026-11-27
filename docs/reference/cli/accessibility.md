# CLI accessibility — the full-screen renderer and its escape hatch

The interactive surfaces (the bare-invocation [Home](home.md) and [`relavium chat`](chat-session.md))
render in one of two modes ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e).
This note documents the accessibility trade-off between them and the explicit, always-available
path back to the accessible one — an escape hatch, never a trap.

## The trade-off

| | Full-screen (alternate-screen) | Inline |
|---|---|---|
| Default | **on a TTY** (since 2.6.F Step 4b-3) | the fallback / opt-out |
| Terminal buffer | the **alternate screen** (DECSET 1049) — a fresh buffer with **no scrollback** | the **primary** buffer + its native **scrollback** |
| Scroll-back | in-app only (**PgUp/PgDn**, **Ctrl+Home/Ctrl+End**, auto-follow) | the terminal emulator's own scrollback |
| Screen readers | **inherently inaccessible** — a raw-mode, full-screen redraw loop carries no live-region / document semantics for assistive tech to follow | the emulator's own accessibility support applies (it is ordinary line output) |
| Mouse text-selection | **in-app** click-drag + copy-on-select (2.6.F Step 6); the emulator's **bypass modifier** still reaches its own selection | native click-drag selection |

The full-screen mode is a keyboard-driven, `ink`-redrawn viewport: it takes over the whole
terminal, runs in **raw mode**, and repaints frames in place. That is what makes long responses
scrollable in-app, but it is also **inherently inaccessible to screen readers** — there is no
DOM/live-region model for assistive technology to track, and the alternate buffer discards the
scrollback a screen reader would otherwise read. This limitation is intrinsic to a full-screen TUI,
not specific to Relavium.

Full-screen mode also enables terminal **mouse reporting** (DECSET 1002 + 1006) so the wheel scrolls the
transcript. The emulator then forwards clicks to Relavium instead of running its own selection — so Relavium
runs the selection itself (2.6.F Step 6): **drag to select, release to copy**. The highlight shows exactly
what will be copied, and that is the content a person sees: the speaker marker in the margin and the
text form's leading `> ` are not part of it, and a press in the margin starts at the first column of the
text ([the transcript grid](chat-session.md#selection-copy-and-the-documents)). The selection extends past a screenful by auto-scrolling at the viewport's edges, and
the copy goes to the system clipboard over **OSC 52**, which works over SSH and inside a container.

Copy-on-select is on by default. Turn it off with **`[preferences].copy_on_select = false`** and the highlight
stays while the clipboard is left alone. On a copy a brief **`Sent to terminal clipboard` toast** flashes above the status footer for
~2 s (a plain `[Sent to terminal clipboard]` under `NO_COLOR` / `--no-color`) — rendered outside the transcript so it never re-wraps the
lines just selected. The toast fires after the **local native write completes**; enqueueing alone is not
delivery. This is *not* the same as the terminal accepting the clipboard request (see below). A local write failure shows a fixed failure notice without the native error text; a selection too large for the OSC 52 payload shows a transcript note instead.

**OSC 52 has no acknowledgement**, so a copy can be *emitted* — and the `Sent to terminal clipboard` toast shown — but never
independently *confirmed* to have reached the clipboard:

- **tmux** honours an application's OSC 52 only under `set-clipboard on`, and the DCS passthrough only under
  `allow-passthrough on`. Relavium emits both forms, so setting *either* option works; stock tmux sets neither.
- **VS Code's Remote SSH terminal** silently drops OSC 52 entirely.

If you would rather keep the emulator's native selection than the wheel, turn mouse reporting off:
**`--no-mouse`** for one invocation, or **`[preferences].mouse = false`** durably
([config-spec.md](../contracts/config-spec.md)). This also turns off in-app selection and copy-on-select — there
is no gesture left to produce them. The keyboard scroll keys (PgUp/PgDn, Ctrl+Home/Ctrl+End) are unaffected.
The inline renderer never enables mouse reporting at all, and the bare **Home landing** does not either — capture is armed only while a chat owns the screen.

Even with mouse reporting on, the emulator's **bypass modifier** still reaches its own selection — commonly
**Shift** (xterm, GNOME Terminal, Konsole, Windows Terminal), **Option (⌥)** on iTerm2. Which modifier applies is
a property of the terminal, not of Relavium.

Three in-app **copy-and-search hatches** exist, in a live chat on either surface:
**`/scrollback`** prints the whole transcript to the primary buffer — where the emulator's own scrollback,
search, selection and copy all work — and waits for Enter before repainting; **`/edit`** opens the transcript
read-only in `$EDITOR`; **`/copy`** puts the whole transcript on the system clipboard over OSC 52 (the unwrapped
document, unlike a mouse selection's visual rows). The three carry the transcript's text form: the person's turn
starts with `> `, and there is no margin and no blank row between turns. None needs the mouse, and all restore every terminal mode on
the way back.

## The escape hatch — the inline renderer

The **inline renderer** is retained, first-class, and keeps the pre-full-screen
output mode. Interactive Markdown now uses the [shared semantic projection](markdown-rendering.md); color-disabled output retains its source markers. It prints to the primary buffer as ordinary lines, so the terminal emulator's **native
scrollback and screen-reader support apply**. Choose it in either of two ways:

- **`--no-alt-screen`** — a per-invocation flag ([commands.md](commands.md#global-options)): `relavium --no-alt-screen`, `relavium chat --no-alt-screen`.
- **`[preferences].alt_screen = false`** — a durable opt-out in `~/.relavium/config.toml` ([config-spec.md](../contracts/config-spec.md)).

The flag overrides the config key. A **non-TTY / `--json` / CI** path is **always** inline
regardless (there is no interactive terminal to take over), so machine output is unaffected by the
default.

**The inline renderer says who spoke in words** ([the transcript grid](chat-session.md#the-inline-renderers-words)). Each row
of the chat is a margin (6 columns from 80 to 99 columns, 8 from 100) and the content: `you` on the first row of the person's turn,
`agent` on the first row of a reply, `tool` on each tool-call row and `note` on the model-switch notice, so a line reads
`you Add the VAT …` and `agent total() now multiplies …`. The words are a closed set of plain ASCII, not a glyph and not
colour, so they are the same with `NO_COLOR` and `--no-color`, under a non-UTF-8 code page and under `LC_ALL=C` (nothing in
the CLI detects the locale; the plain glyph form follows colour, not locale). A wrapped row hangs, with a blank margin and the
text where the first row's text started; it never begins with the space the line broke at; and one blank row separates
the person's turns and the replies. A native selection in the terminal copies the margin with the content, so the words
come with it.

What the words do not do, said plainly:

- A screen reader does not announce indentation, so a hanging row (its margin is blank) reads as the continuation of the
  row above it. A row of a reply, a tool call or a notice that **begins with one of the four words** (any case, a whole
  word) is therefore given its own entry's word: a reply row that begins `you should rerun …` reads `agent you should
  rerun …`. The extra `agent` is a cost, paid so that no model row reads as the person's turn; the person's own turn is
  never given another speaker's word.
- With colour off the speaker is carried by position and bold: the full-screen margin shows a bold `>` for the person's
  turn, and a model line that starts with `> ` stands in the content column, after the blank columns, never in the margin.
- **The flat text forms keep the colour-off residual.** `/copy`, `/edit` and `/scrollback` have no margin and start the
  person's turn with `> `, so a model line `> x` there looks like the person's turn. The grid does not close this: a flat
  text has no place for a mark that the model cannot write ([ADR-0145](../../decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker) §6).

## Other accessibility properties (both renderers)

- **Color is never required for meaning.** `NO_COLOR` / `--no-color` degrade to a legible,
  color-free rendering; status is carried by text, not color alone.
- **Syntax colour is decoration.** A highlighted code block ([ADR-0144](../../decisions/0144-fenced-code-is-highlighted-by-an-in-house-lexical-scanner.md))
  only classes text that is already shown, so `NO_COLOR` / `--no-color` draw the source unchanged. It uses five named ANSI
  colours, bold and dim, so the terminal's own theme sets the shades; a comment is dim, and a diff line also carries its
  `+` or `-`. The class list and the colours are in [markdown-rendering.md](markdown-rendering.md#syntax-highlighting).
- **Keyboard-only.** Core navigation needs no mouse — **PgUp/PgDn** page the transcript,
  **Ctrl+Home/Ctrl+End** jump to the top/tail, and **auto-follow** re-pins to the newest output.
  Mouse-wheel scrolling is an optional convenience, not a requirement.
- **Untrusted text is sanitized at the display boundary** (terminal-escape + bidi/Trojan-Source
  stripping), so model / MCP / pasted content can neither forge the UI nor spoof the reading order. In the chat it is
  also laid out in the content column only, so it cannot stand in the margin where the host draws who spoke
  ([the transcript grid](chat-session.md#the-transcript-grid-mvp-11-unit-9-2026-11-27)).

**MVP-3 Step 2 accepted on development (2026-11-12):** approval and tool details provide the
same keyboard and color-independent inspection in inline and alternate-screen
chat. The [interaction contract](chat-session.md#proposed-mvp-3-interaction-contract)
owns navigation, explicit reveal, escaped invisible characters, full-view
coverage and the 80×24 visibility guard. Approval requires the current measured
frame to have been flushed; resizing or clipped controls require renewed
visibility. Transcript hatches carry conversation text and safe structural
tool summaries, while private preview/reveal buffers remain in the live view.
These properties do not add assistive-technology semantics to the full-screen
renderer.

**MVP-4 step 4 (2026-11-19): the command card** carries the same properties, in words
and not in colour: its standing, directory and warnings are plain rows (`⚠` plus
the sentence; colour only emphasises), a locked answer is missing from the key row
and the lock is explained in a sentence, the open two-step question is the card's
plainest text and says that any other key cancels and allows nothing, a note says
when an Enter came outside its window, and a control character or an empty argument
shows as an escape or `(empty)` instead of nothing. The contract is
[command-permissions.md](command-permissions.md#the-command-card).

**MVP-4 step 5 (2026-11-20): the `/permissions` sheet, a popup since MVP-11 unit 8** ([ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §2, [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §10) works in the inline renderer, which is the accessible mode, and not only in the full-screen one: inline it is a framed block that replaces the body, drawn with rules and no side bars. It reads the same with colour off: the highlighted row is marked `›` (`>` in the plain glyph form), the sections have headings, hidden rows are counted by `▲ n more` / `▼ n more`, and a withdrawal's question is the popup's second step, in words, not a colour. Below 80×24 a note replaces it. `Esc` on the question keeps the row (a second `Esc` closes the popup); `Ctrl+C` closes it from either step; neither ever withdraws. The arming keys are `d`, `Delete` and `Backspace`, and the legend names `[d] / Del` (the Backspace key arms too and is not on the legend). The contract is [command-permissions.md](command-permissions.md#in-the-chat-permissions-a-popup). The same popup opens on the bare Home and from a bare `relavium permissions` on a terminal, with the same words and glyphs and below the same 80×24 floor.

**MVP-4 step 6 (2026-11-21): `Esc` leaves the full view for the card** ([ADR-0137](../../decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md) §4). The keys are named in words on the screen (`Esc back`, `Ctrl+C stops the turn`), not by colour, in the inline renderer as in the full-screen one; stepping back answers nothing and needs no visible frame, so a screen too small to read still says `[Ctrl+N] denies · Esc back · Ctrl+C stops the turn.` and `Esc` still leaves it.

**MVP-8 (2026-11-23): the Home's new screens** (the run view and its cards, the Runs screen, the `/import`, `/pricing` and export cards and, since MVP-11 unit 8, the `/workflows`, `/agents`, `/help` and `/mode` popups; see [home.md](home.md)) carry the properties above and add these, all in words and glyphs and none in colour alone:

- **Every screen names its keys.** A legend under each screen and popup lists what it answers to, the way out last (`Esc back to Home`, `Esc back`, `Ctrl+Y writes`); the Runs screen's list legend names `Esc / [Ctrl+C] back to Home` where both fit 80 columns; nothing needs a mouse. A legend leaves out only keys it has no room for, and [home.md](home.md#the-runs-screen-active-and-history-mvp-8-step-4-2026-11-23-narrowed-in-mvp-11-unit-8-2026-11-27) lists them.
- **State is a glyph and a word.** A run reads `✓ completed`, `✗ failed`, `‖ paused` on the Runs screen and `✓ done 3h ago`, `‖ waiting 5m` in the `/workflows` popup; an agent file or a workflow file `✓ ready` or `✗ invalid`; a pin `★ pinned` or the word `pinned`, and `? other project`; colour only emphasises. An absence has a sentence, never a bare dash.
- **Nothing is hidden without a marker, and every screen fits 80×24.** A list longer than its screen is windowed with `▲ N more` and `▼ N more` (the Runs screen's lists, the palette, a select prompt, the popups' lists), the highlighted row is always on a drawn row, and below 80×24 a screen says to enlarge the terminal and answers only the keys that leave it (a popup is replaced by a note).
- **A card is answered only once it is on screen.** A card answered by a Ctrl chord (a gate, a budget abort, an MCP consent, and the `/import`, `/pricing` and export cards) counts its chord after the frame that shows the card has been painted, after its dwell and quiet gap, and a held key cannot answer the next card; a card that cannot be seen cannot be answered by accident. Two questions are lighter on purpose: the exit guard's `Ctrl+Y` needs the painted frame and the lockout but no dwell or gap, since a key opened it and it is read before it is answered, and the question whether to continue a run parked on media jobs is a Yes/No with No as its default, so an `Enter` typed ahead, `Esc` and `Ctrl+C` all answer No and nothing starts.
- **Text from files and models stays inside its row.** A gate's message is drawn behind a gutter with host glyphs and answer-chord spellings replaced, an agent's prompt is shown as a scrubbed head, and every line passes the display-boundary sanitizer.

**MVP-11 unit 8 (2026-11-27): sheets, the wait clock, the inspection popup and the Home's popups** ([ADR-0147](../../decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md), [ADR-0148](../../decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md); [chat-session.md](chat-session.md#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27), [home.md](home.md#the-homes-management-popups-mvp-11-unit-8-2026-11-27)) add these, in words and shapes and none in colour alone:

- **A sheet's rule is told from a thin rule without colour.** The cards that ask for a decision (the approval, the agent's question, the checkpoint, and on the Home the gate and budget cards and the exit guard) open with a heavy rule, `━━ Approval needed ━━━ waiting 0:41 ━━`. With `NO_COLOR` or `--no-color` the heavy glyph is `=` and a thin rule is `-` (`== Approval needed ===== waiting 0:41 ==`), so the two stay apart by shape, and the label and the clock are words. The sides are open: no border glyph is read on every line.
- **The wait clock is words, and it is still where the person reads.** In the full-screen renderer it reads `waiting 0:41`, then `waiting 2m`, `waiting 1h 07m` and `waiting 1d 03h`; **inline, the accessible mode, it is a static `waiting since 14:05`** (with the day, `Nov 25 14:05`, when the wait began on an earlier day) and **nothing repaints on a timer**, because a live region rewritten every second is hostile to assistive tools and costly over SSH. A locked key says `(wait)` in words, not only dim.
- **A popup draws no more than the accessible mode can read.** Inline, a popup is a framed block that replaces the body, with rules and no side bars, no spinner and no ticking text, its lists windowed to ten rows or fewer, and never taller than `rows − 1` lines. With colour off its glyphs are their ASCII forms. The effect of a mode that approves without a card (`accept-edits`, `auto` in `/mode`) is amber, and where colour is off it leads with `! ` (the plain form of the warning glyph), so it reads as a warning before the key that applies it.
- **The inspection popup names its keys and never answers by accident.** `[v]` and `/details` open one popup that fits the terminal's own size (`columns − 2` by `rows − 1`); `Esc` and `[b]` step back to the approval and never reject, a mashed `Esc` right after a step back is ignored for 400 ms, and the legend says `[Ctrl+C] stops the turn`. A page that did not fit its popup cannot be acknowledged, so Allow stays locked rather than unlock for content the person could not see.

These properties do not add assistive-technology semantics to the full-screen renderer.

## See also

- [home.md](home.md) · [chat-session.md](chat-session.md) — the two interactive surfaces.
- [config-spec.md](../contracts/config-spec.md) — `[preferences].alt_screen`.
- [commands.md](commands.md#global-options) — `--no-alt-screen`, `--no-color`.
- [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) — the full-screen renderer decision.
