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
| Mouse text-selection | needs the terminal's **bypass modifier** — mouse reporting is on so the wheel scrolls | native click-drag selection |

The full-screen mode is a keyboard-driven, `ink`-redrawn viewport: it takes over the whole
terminal, runs in **raw mode**, and repaints frames in place. That is what makes long responses
scrollable in-app, but it is also **inherently inaccessible to screen readers** — there is no
DOM/live-region model for assistive technology to track, and the alternate buffer discards the
scrollback a screen reader would otherwise read. This limitation is intrinsic to a full-screen TUI,
not specific to Relavium.

Full-screen mode also enables terminal **mouse reporting** (DECSET 1000 + 1006) so the wheel scrolls the
transcript. The cost is that the emulator forwards clicks to Relavium instead of running its own
selection, so **click-drag select-and-copy needs the emulator's bypass modifier** — commonly **Shift**
(xterm, GNOME Terminal, Konsole, Windows Terminal), **Option (⌥)** on iTerm2. Which modifier applies is a
property of the terminal, not of Relavium. The inline renderer never enables mouse reporting, so selection
there is untouched.

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
