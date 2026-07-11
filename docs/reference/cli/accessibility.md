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
what will be copied, the selection extends past a screenful by auto-scrolling at the viewport's edges, and
the copy goes to the system clipboard over **OSC 52**, which works over SSH and inside a container.

Copy-on-select is on by default. Turn it off with **`[preferences].copy_on_select = false`** and the highlight
stays while the clipboard is left alone. On a copy a brief **`✓ Copied` toast** flashes above the status footer for
~2 s (a plain `[Copied]` under `NO_COLOR` / `--no-color`) — rendered outside the transcript so it never re-wraps the
lines just selected. The toast fires when Relavium **emits** the OSC 52 write, which is *not* the same as the
terminal accepting it (see below); a selection too large for the OSC 52 payload shows a transcript note instead.

**OSC 52 has no acknowledgement**, so a copy can be *emitted* — and the `✓ Copied` toast shown — but never
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
document, unlike a mouse selection's visual rows). None needs the mouse, and all restore every terminal mode on
the way back.

## The escape hatch — the inline renderer

The **inline renderer** is retained, first-class, and **byte-identical** to the pre-full-screen
output. It prints to the primary buffer as ordinary lines, so the terminal emulator's **native
scrollback and screen-reader support apply**. Choose it in either of two ways:

- **`--no-alt-screen`** — a per-invocation flag ([commands.md](commands.md#global-options)): `relavium --no-alt-screen`, `relavium chat --no-alt-screen`.
- **`[preferences].alt_screen = false`** — a durable opt-out in `~/.relavium/config.toml` ([config-spec.md](../contracts/config-spec.md)).

The flag overrides the config key. A **non-TTY / `--json` / CI** path is **always** inline
regardless (there is no interactive terminal to take over), so machine output is unaffected by the
default.

## Other accessibility properties (both renderers)

- **Color is never required for meaning.** `NO_COLOR` / `--no-color` degrade to a legible,
  color-free rendering; status is carried by text, not color alone.
- **Keyboard-only.** Core navigation needs no mouse — **PgUp/PgDn** page the transcript,
  **Ctrl+Home/Ctrl+End** jump to the top/tail, and **auto-follow** re-pins to the newest output.
  Mouse-wheel scrolling is an optional convenience, not a requirement.
- **Untrusted text is sanitized at the display boundary** (terminal-escape + bidi/Trojan-Source
  stripping), so model / MCP / pasted content can neither forge the UI nor spoof the reading order.

## See also

- [home.md](home.md) · [chat-session.md](chat-session.md) — the two interactive surfaces.
- [config-spec.md](../contracts/config-spec.md) — `[preferences].alt_screen`.
- [commands.md](commands.md#global-options) — `--no-alt-screen`, `--no-color`.
- [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) — the full-screen renderer decision.
