# ADR-0068: Full-screen TUI renderer, `ink` 7, and the CLI component test harness (refines ADR-0047)

- **Status**: Accepted
- **Date**: 2026-07-09
- **Related**: [ADR-0047](0047-cli-framework-commander-ink-clack.md) (**refines** — the `ink` major bump), [ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md) (the `>=22` floor `ink` 7 needs), [ADR-0049](0049-cli-machine-output-contract.md) (the `--json`/CI contract this must not regress), [ADR-0054](0054-cli-bare-invocation-interactive-home.md) (the Home this renders), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) (the approval floor the auto-follow override serves), [ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md) (the bracketed-paste hand-roll → native `usePaste`), [ADR-0063](0063-cli-config-write-contract.md) (the new `[preferences]` keys), [node-runtime-upgrade.md](../roadmap/phases/node-runtime-upgrade.md), [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) (workstream 2.6.F)

## Context

Workstream 2.6.F turns the bare `relavium` Home and the interactive `chat` REPL into a **full-screen**
surface and is the substrate that gates the 2.6 experience arms (browsers 2.6.G, settings 2.6.L,
tool-render-v2 2.6.M, child-session chat UX 2.6.N). It must structurally fix a real defect, which has
**two distinct forms** in today's inline renderer:

- **Chat** (`session-view-model.ts`): live output is capped at 4000 chars *and* `reduceTurnCompleted`
  **bakes the finalized `<Static>` transcript entry from that capped buffer**, so a long response is
  clipped and its full text survives only in SQLite — unreachable by scrolling.
- **Run** (`run-view-model.ts` / `RunApp.tsx`): the defect is the **absence of any retained token
  history** (no `<Static>`, just a bounded live tail + a final summary) — a different problem.

The inline renderer also runs into `ink`'s inline-overflow scrollback-wipe bug class (upstream issues
around `clearTerminal` CSI 3J and unclamped `cursorUp`) that has affected other ink-based full-screen
CLIs. The pinned `ink` 6.8 has no alternate-screen buffer, no window-size hook, and no native
bracketed paste; those primitives arrive in `ink` 7, which hard-requires Node `>=22` (delivered by
[ADR-0067](0067-node-supported-floor-22-reaffirm-better-sqlite3.md)) and React `>=19.2` (already
pinned). Constraints: the change must **not** regress the `--json` / CI / non-TTY machine contract
([ADR-0049](0049-cli-machine-output-contract.md)); the renderer is a surface concern in `apps/cli` —
the engine stays platform-free (CLAUDE.md #5 / [ADR-0047](0047-cli-framework-commander-ink-clack.md));
and a full-screen (alternate-screen) surface is **inherently screen-reader-hostile**, so accessibility
is a hard acceptance gate, not a nicety.

**Scope.** The full-screen renderer targets the **Home + `chat`** (the interactive REPL surfaces where
scroll matters most). The `relavium run` TUI (`RunApp`) — a largely non-interactive streaming monitor
that deliberately uses **no `useInput`** so the kernel keeps `Ctrl-C → SIGINT` for cooperative cancel —
**stays inline for 2.6.F**; giving it a retained, scrollable run-history (and, with it, the
COOKED→RAW cancel rework) is a tracked follow-up, not this workstream. This keeps the riskiest cancel
change out of 2.6.F.

## Decision

**We adopt `ink` 7, hand-build the full-screen renderer for the Home + chat on its native
`alternateScreen`, add `ink-testing-library` as the CLI's first component-render test harness, and —
as the final increment — add mouse-wheel scroll behind an opt-out.** This **refines**
[ADR-0047](0047-cli-framework-commander-ink-clack.md) — `ink` remains the TUI framework; only its major
moves — so ADR-0047 gets an in-place dated amendment note pointing here rather than a supersession.
The `ink`-7 facts below are per its release notes / migration guide (`vadimdemedes/ink`, verified
2026-07-09), since the repo still pins `ink` 6.8.

**(a) Adopt `ink` 7 (a version bump within the ADR-0047 decision).** It hard-requires Node `>=22`
(ADR-0067) + React `>=19.2` (already pinned). Per the 7.0.0 release notes its breaking surface is only
three items — Backspace now reports `key.backspace` (was `key.delete`), plain Escape no longer sets
`key.meta` (only `key.escape`), and the platform bumps — and the CLI's input reducers already
**dual-fold `key.backspace || key.delete`** (`chat-input.ts` `reduceEditorMotion` and the 5 submode
reducers), so backspace survives; the approval reducer checks `key.escape` **before** its `key.meta`-based
Alt+digit subversion guard (`reduceApprovalKey`), so that load-bearing guard survives too. The genuine
regression targets — the `Alt`-word-motions (`reduceLineMotion`/`reduceCursorMotion`, which read
`key.meta`) and the Alt+digit guard's dependence on `ESC`-prefixed `key.meta` — get an explicit
`ink`-7 regression pass. The Home's hand-rolled DECSET-2004 bracketed-paste
([ADR-0061](0061-cli-input-layer-file-injection-and-shell-escape.md)) migrates to `ink` 7's native
`usePaste`, which removes the hand-roll **and** closes the standalone-`relavium chat` paste gap. **Pin
`ink` to 7.1.0** (not a `>=7.0.6` caret): 7.1.0 is the release that adds `suspendTerminal` — which the
`v`-open-in-`$EDITOR` hatch below depends on — and 7.0.x carries fixed regressions. Verify the upstream
"content == rows appends a newline" (#752) fix is present before adopting a pin-to-`rows` layout.

**(b) Hand-build the full-screen renderer in `ink` 7 — not OpenTUI.** `ink` 7 gives alt-screen
enter/exit (`render(..., { alternateScreen: true })`) + `useWindowSize()` for free, but **no** viewport
virtualization, scroll region, or auto-follow — those are hand-built React over the existing ink-free
stores. Rendering exactly the visible `rows` into the alt buffer also structurally **sidesteps** `ink`'s
inline-overflow scrollback-wipe bug class. *Considered:* adopting **`@opentui/react`** (its `ScrollBox`
is an off-the-shelf virtualized viewport with declarative sticky-bottom auto-follow) — **rejected**: it
is a native-Zig runtime dependency carrying its **own** React reconciler, i.e. leaving `ink`, plus a
new-runtime-dependency ADR (CLAUDE.md #2) and a native-binary provenance concern — disproportionate to a
need `ink` 7 + a hand-built scroll state machine already meets.

**(c) The renderer contract.** A fourth mount-wrapper over the same ink-free stores/view-models
(`chat-store`, `home-controller`, the projections) — the ADR-0047 "framework-free cores" discipline
means those transfer unchanged.
- **Full-response visibility.** The 4000-char chat live cap and `reduceTurnCompleted`'s capped-transcript
  bake are **lifted for the full-screen renderer**. Because that cap lives in the *shared*
  `session-view-model`, it is made a **renderer-injected bound** (not a constant): the full-screen
  renderer supplies an effectively-unbounded transcript that its viewport manages, while the inline
  fallback keeps a trailing-tail bound (it has no viewport). The `--json` / CI / plain **machine** paths
  do not project the ink view-model at all, so their byte-identical guarantee (below) is untouched by
  this change.
- **Row measurement.** The viewport scroll math must count **rendered terminal rows**, not logical
  lines — lines wrap at the live width, wide/emoji chars are double-width, and 2.6.M will render
  syntax-highlighted, ANSI-colored, multi-line code blocks into the same transcript. A width-aware,
  wrap-aware measurement (or `ink`'s own measured box metrics) is required; mis-counting rows corrupts
  the scroll position. This is a named implementation risk with harness coverage.
- **Scroll + auto-follow.** A single `following` boolean (default true): any upward scroll pauses it and
  freezes the offset; `Ctrl+End` or reaching bottom resumes; while following, every append pins to the
  tail. Keyboard scroll: PgUp/PgDn, Ctrl+Home/Ctrl+End. **Hard override:** an approval / human-gate
  prompt force-scrolls into view **even while paused** (wired to the
  [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md) `confirmAction` + the human-gate surfaces) so
  a decision is never hidden.
- **Resize.** On a `useWindowSize()` change: re-measure wrapped-row heights, re-clamp the frozen offset
  to the new content height, and re-pin the tail when `following` — a stale offset or dropped auto-follow
  on resize is a visible defect.
- **`<Static>` → viewport.** `<Static>` writes to native scrollback the alt buffer does not have, so the
  chat transcript moves into the viewport scroll region.
- **Unmount order.** The renderer exits the alt screen **before** writing any persistent plain-text
  summary, so it lands on the primary buffer.

**(d) Mouse-wheel scroll (the final increment) — wheel only, behind an opt-out.** Achievable in `ink` 7
without leaving it, via the **same augment-`ink` pattern the app already uses for DECSET 2004**: a
dedicated `process.stdin.on('data')` SGR listener (NOT `useInput`, which is keyboard-oriented and
mangles a mouse byte-stream) enables `\x1b[?1000h\x1b[?1006h` (button-report + SGR-extended; **never**
1002/1003 motion), parses only wheel codes 64/65 (+ modifier variants), and feeds the **same** viewport
scroll + auto-follow-pause/resume actions PgUp/PgDn drive — no new state machine. A one-line `useInput`
swallow-filter drops stray `\x1b[<…[Mm]` reports so a click never injects junk. Obligations: disable
`1006l 1000l` on **every** teardown path (extend the existing DECSET-2004 exit plumbing) and **suspend
mouse around any TTY-inheriting subprocess** (the `!`-shell escape, `[chat]` allowlisted commands, the
`run_command` host arm) — leaving 1000 on floods/corrupts the terminal. It is enabled **only** in the
alt-screen renderer, only on a TTY, only when not opted out — **never** in the inline renderer (which
relies on native scrollback mouse capture would break). Opt-out ships as both a `--no-mouse` flag and a
`[preferences].mouse` key; the **first release defaults OFF** (opt-in) — keyboard PgUp/PgDn already
delivers the core need, mouse capture is the field's #1 friction point (it disables native
copy-on-select, worst over SSH/tmux) and Relavium has no in-app copy-on-select yet to compensate — then
flips to on-with-opt-out after real-terminal validation (a tracked follow-up). Mouse **click / drag /
text-selection / copy-on-select / hover / URL-open** and per-terminal scroll-speed normalization are
**deferred to Phase 3**.

**(e) Accessibility, escape hatches, flicker, and the copy regression.** The alt screen is
screen-reader-hostile, so: a `--no-alt-screen` flag + a `[preferences].alt_screen` config key
([ADR-0063](0063-cli-config-write-contract.md)) fall back to the **byte-identical inline renderer** (which
keeps native scrollback + the emulator's own a11y); a `[`-dump-the-conversation-into-native-scrollback
and a `v`-open-in-`$EDITOR` (via `ink` 7 `suspendTerminal`) give search / copy / SR access to the
transcript. **Copy regression, stated plainly:** on the alt screen the terminal's native click-drag
selection can grab only the *visible* rows (there is no scrollback) — a regression from the inline
renderer where the whole `<Static>` transcript is natively selectable; the mitigations are the mouse
opt-out (restores native selection), the `[` / `v` hatches, and (Phase 3) in-app copy-on-select. The
`--json` / CI / non-TTY paths stay on the inline/plain renderer and are **byte-identical** to today
(regression-harness proven). `NO_COLOR`/`--color` (resolved in 2.5.J) and `--json` (ADR-0049) remain the
color-free / machine accessible paths. Flicker is avoided with terminal **synchronized output** (DEC
2026, `\x1b[?2026h/l`) framing, since `ink` does not emit it. The **branded Home banner** (2.6.F —
shown on the first few Home opens, `[preferences].show_banner`, width-adaptive, plain-ASCII under
`NO_COLOR`) is a cosmetic substrate element of this renderer; it gates no feature. The new global
`--no-alt-screen` / `--no-mouse` flags and the `[preferences]` keys (`alt_screen`, `mouse`, `show_banner`)
are documented in their canonical homes ([cli/commands.md](../reference/cli/commands.md) /
[config-spec.md](../reference/contracts/config-spec.md)).

**(f) The CLI component test harness.** Adopt **`ink-testing-library`** (dev-only; its major tracks
`ink`'s, so it rides this bump) as the repo's **first** `.test.tsx` render harness — `render()` →
`{ lastFrame(), stdin, rerender, frames }` enables key/paste injection + frame-snapshot assertions.
*Considered:* extending the repo's existing injected-`mount` seam + pure-reducer suites (home-grown, no
new dependency) — **rejected** as the primary harness: it cannot exercise the actual React prop-plumbing
/ render-cadence layer (the 2.5.H frozen-clock class of bug lives exactly there), which is the gap the
harness must close. The harness pins the 2.5.H frozen-clock regression (a fake clock ticked across two
`store.tick()`-driven renders asserting the displayed elapsed advances) and frame-time / render-count
perf thresholds for the full-screen frame loop.

> **Amended 2026-07-09 (Step 3 landed).** The harness shipped in
> `apps/cli/src/render/tui/{harness-smoke,chat-app,home-app}.test.tsx` pins **both** frozen-clock paths — the
> `ChatApp` inline `Date.now()` one AND the Home's per-frame `now()`-function-prop one — plus the ADR-0057
> paste-cannot-answer-the-floor security property (both surfaces), CRLF→LF normalization, the ink-7 `key.backspace`
> labelling, and a **render-COUNT** perf guard (`frames.length` equality across a tick burst). A wall-clock
> **frame-time** threshold is **deferred** to when the Step-4/5 viewport/scroll math makes the frame loop
> render-heavy — a per-frame wall-clock budget is notoriously CI-flaky on shared runners, so asserting it now would
> buy flakiness, not signal. Frame assertions poll (`waitFor`) rather than assume a single macrotask yield, because
> React 19's commit can be deferred past one yield under parallel-file CPU contention.

> **Amended 2026-07-09 (Step 4a landed).** The alt-screen renderer's **lifecycle substrate** shipped:
> `resolveRenderMode` (`apps/cli/src/render/render-mode.ts`) resolving `alt | inline` with precedence
> machine/non-TTY → `--no-alt-screen` flag → `[preferences].alt_screen` → phase default (`DEFAULT_ALT_SCREEN`, the
> **single** flip-point for §b); the `--no-alt-screen` global flag + the `[preferences].alt_screen` config key; ink 7's
> native `alternateScreen` wired into **both** mount sites (the bare Home's `driveHome` + `relavium chat`'s `driveInk`);
> the §c unmount-before-summary order (extracted to the unit-tested `finalizeInkExit`); and the byte-identical
> machine/non-TTY inline guarantee. **`DEFAULT_ALT_SCREEN` is `false` at 4a — alt-screen is OPT-IN** (via the config
> key) until the viewport lands. **Deferred to Step 4b/5** (§b–§e): the hand-built transcript **viewport + scroll +
> auto-follow**, the **caps-lift** (renderer-injected bound), **row measurement**, the approval **force-scroll
> override**, resize re-clamp, the `[`-dump / `v`-open-in-`$EDITOR` **escape hatches**, **DEC-2026 synchronized
> output**, the **branded banner**, and **mouse-wheel** scroll — after which `DEFAULT_ALT_SCREEN` flips to `true`
> (alt-on with the `--no-alt-screen` opt-out). Until then, enabling `alt_screen` is a preview (no scrollback, no
> hatches — see config-spec.md's caveat).

> **Amended 2026-07-09 (Step 4b-1 landed).** The transcript **viewport** shipped for BOTH surfaces (the bare Home +
> `relavium chat`): ink's `<Static>` is replaced on the alt screen by a `TranscriptViewport` that width-wraps the
> transcript to display lines (`viewport.ts` `displayWidth`/`wrapText` — the row-measurement §c requires), renders
> only the visible window via `measureElement`, **follows the tail** (an append pins to the bottom), and
> **resize-tracks** (ink 7 `useWindowSize` on `relavium chat`, the resize-tracked size on the Home) so a SIGWINCH
> re-wraps + re-measures. The inline renderer keeps `<Static>` + native scrollback unchanged. **Deferred to Step
> 4b-2**: the scroll/auto-follow **keymap** (PgUp/PgDn/Ctrl+Home/End), the upward-scroll-pauses-follow state machine,
> the approval/gate **force-scroll override**, and hardening `displayWidth` to never under-count vs ink (grapheme-
> aware — load-bearing once a persisted scroll offset exists). **Deferred to Step 4b-3**: the **caps-lift** (the
> renderer-injected unbounded transcript + true virtualization) + `DEFAULT_ALT_SCREEN`→`true`. **Deferred to Step 5**:
> DEC-2026 synchronized output, the branded banner, the `[`/`v` escape hatches, and mouse-wheel. A known 4b-1 limit:
> a live region taller than the terminal has no scrollback (deferred-tasks.md).

> **Amended 2026-07-09 (Step 4b-2 landed).** The **scroll / auto-follow** state machine shipped for both surfaces:
> a single `following` boolean (default true) pinned to the tail; **PgUp/PgDn** page + **Ctrl+Home/Ctrl+End** jump
> to top/bottom (`scroll.ts` `reduceScroll`/`scrollMotionForKey`, shared by both surfaces); any upward scroll pauses
> follow + freezes the offset, and a downward scroll landing at the bottom (or Ctrl+End) resumes. The viewport's
> measured geometry is lifted to the input owner (`onMeasure` → a ref) so a scroll key reduces against the same
> geometry the viewport windows with. `displayWidth`/`wrapLogicalLine` are now **grapheme-aware** (`Intl.Segmenter`)
> and never UNDER-count vs ink — incl. the BMP default-emoji-presentation singletons (✅⭐⚡…). **The §c approval /
> gate FORCE-SCROLL override is intentionally NOT wired**: the approval prompt renders in the FIXED live region below
> the flex-grow viewport, so a paused transcript scroll can never hide a decision — the override's goal is met by the
> layout, and a force-follow would only yank the user off history they are reading. **Deferred to Step 4b-3**: the
> caps-lift + true virtualization + `DEFAULT_ALT_SCREEN`→`true`; **Step 5**: mouse-wheel scroll (reuses this same
> viewport scroll + follow actions). Resolves the §e force-scroll deferred item by design.

> **Amended 2026-07-09 (Step 4b-2 Sonnet-review fold).** Three verified fixes on top of the 4b-2 landing: **(a)** the
> Home's scroll-reset effect now keys on the **session OBJECT identity** (`state.session`), not the durable `sessionId`
> string — a `/models` reseat deliberately PRESERVES the id across the swap, so an id-keyed effect missed it and left a
> scrolled-away transcript frozen after a live model switch; **(b)** the scroll keymap now reduces against **live
> geometry read at the keypress** (`liveScrollGeometry` wraps the store's current transcript for a fresh `totalLines`)
> instead of the `onMeasure` ref, which lags by up to a commit — a mid-stream burst landing between a commit and its
> measure effect would let `settle` resume-follow against a stale (undercounted) bottom and yank a paused reader to the
> tail on a single PgDn (the height lag stays benign — it changes only on resize, which re-renders + re-measures);
> **(c)** `graphemeWidth`'s VS16/keycap width-2 override is now gated on a **base** (`base > 0`) so a DEGENERATE lone
> variation-selector / keycap cluster counts 0 cells (as ink renders it), not an over-counting 2. Added the mounted
> regression coverage the fold-round flagged as missing: a **`/models` reseat re-follow** pin (object-identity
> discriminator), the **overlay scroll-gate** on both surfaces (a scroll key behind an open `/` palette reaches the
> overlay, never the transcript), and the **paused-mid-page boundary** at the mount (a partial page-down does not
> resume follow). The canonical render-mode docs (home.md / chat-session.md / config-spec.md `alt_screen` caveat) were
> reconciled to reflect that scroll-back + auto-follow shipped at 4b-2.

> **Amended 2026-07-09 (Step 4b-3 landed — caps-lift, flicker hoist, DEFAULT flip).** The full-screen renderer became
> first-class and is now the **default on a TTY** (`DEFAULT_ALT_SCREEN = true`): a bare `relavium` / `relavium chat`
> opens full-screen; `--no-alt-screen` (per invocation) or `[preferences].alt_screen = false` (durable) opts back into
> the inline renderer, and a machine / non-TTY / `--json` / CI path stays inline + byte-identical. Three pieces landed:
> **(a) caps-lift** — a bounded LRU per-logical-line wrap cache (`viewport.ts`) keyed on `(cols, line)`, so re-wrapping
> the unbounded append-only transcript on each append is O(history) cheap map lookups + ONE segmentation instead of
> re-running `Intl.Segmenter` over all of history; the resize re-clamp of a paused offset is pinned (already correct via
> `effectiveOffset`). **(b) inter-session flicker HOIST** — `driveInk` mounts+unmounts ink per session and ink 7 tied
> DECSET-1049 to mount/unmount, so a `/clear` / `/models` re-drive flipped the terminal primary↔alt (a flicker, and the
> intro/clearedNotice on the primary buffer). A parallel investigation of ink 7.1.0's compiled build confirmed ink
> renders full-screen via **log-update (relative cursor moves), fully decoupled from the `alternateScreen` option**, so
> `driveInk` now passes the ink render OPTION `alternateScreen:false` (ink toggles nothing) while KEEPING the `ChatApp`
> PROP (viewport vs `<Static>`), and the hoisted `runReplLoop` (`withHoistedAltScreen`) enters the alt buffer ONCE above
> the loop, clears between re-drives, and exits ONCE. **(c) exit-safety** — since ink's own 1049-exit is now inert,
> `restore()` (idempotent) runs on every path: the `finally`, a `process.on('exit')` net (the second-SIGINT force
> `process.exit` that bypasses the finally), and explicit SIGTERM/SIGHUP handlers that restore the full terminal state
> (buffer + cursor + bracketed paste + raw mode) then exit `128+signo`. The end-of-session summary is lifted onto the
> `ChatDriveOutcome` and printed AFTER the single alt-exit (primary buffer, §c ordering preserved). The **Home needs no
> hoist** — `driveHome` is a single long-lived mount, flicker-free by construction (the reference for the pattern). The
> exit paths are unit-tested (`withHoistedAltScreen`, 6 cases) around injected write/lifecycle seams; the real-TTY
> signal paths (double-Ctrl-C, `kill -TERM`/`-HUP`) are a manual PR-time check. **Still pending (Step 5):** the `[`-dump
> / `v`-open-in-`$EDITOR` copy-and-search hatches, mouse-wheel scroll, the branded banner, and the a11y note.

> **Amended 2026-07-09 (Step 4b-3 Opus + Sonnet review folds).** SUPERSEDES the caps-lift mechanism in the note above:
> the bounded per-logical-line LRU (keyed on `(cols, line)`) thrashed to a 0% hit rate once a session exceeded the
> cache size (a sequential re-scan from the head evicts the very lines it is about to re-read), so it was replaced by a
> **`WeakMap<TranscriptEntry, { cols, lines }>` in `chat-projection.ts`** keyed on the immutable, append-only entry
> object — an append is O(history) map lookups + ONE `wrapEntry`, a resize replaces each entry's single cached wrap,
> and it NEVER thrashes (it holds exactly the live entries, GC-reclaimable); `viewport.ts` `wrapText` is pure again.
> Other verified folds: the `/clear`/reseat rebuild-FAILURE hint (the resumable `chat-resume <id>`) is now lifted onto
> `HoistedLoopResult.errorText` + printed AFTER the alt-exit (it was written into the still-entered alt buffer and
> discarded once alt became the default); **SIGQUIT** joined the SIGTERM/SIGHUP net (an external `kill -QUIT` stranded
> the terminal); the interactive-TTY tests inject an inert hoist (the flip drove them into the real alt buffer / real
> signal handlers), and a recording-hoist test pins the `runReplLoop` `altActive` derivation. **Known limitations
> (tracked in deferred-tasks.md):** a SIGTERM/SIGHUP/SIGQUIT dumps ink's final frame onto the primary buffer (cosmetic;
> needs threading the instance unmount before the alt-exit), and session-side raw-`io` notices that fire mid-session —
> the budget-cap **warning** and the `/clear`/reseat **MCP-skipped** diagnostic — still land on the alt buffer and are
> lost in alt mode (they must route through the CURRENT session's view-store `notice`, an architectural follow-up).

> **Amended 2026-07-10 (Step 5 landed — a11y note, mouse-wheel, the copy-and-search hatches, the mouse opt-out).**
> Step 5 is complete. Four clarifications; §e's *mechanisms* are unchanged, one of its *defaults* is not.
>
> **(a) The `[` / `v` escape hatches ship as PALETTE COMMANDS, not bare keys** — **`/scrollback`** (dump the transcript
> into the terminal's native scrollback; press Enter to return) and **`/edit`** (open it read-only in `$EDITOR`;
> edits are never read back). A bare `[` or `v` collides with the text prompt, where they are far commoner than `/`.
> Both are `availableIn: ['chat']` — the bare Home has no transcript. They are ONE implementation shared by the
> standalone chat and the in-Home chat, dispatched through the existing slash path with no render-layer interception:
> unlike `/models` they open no React overlay, so a `SuspendPort` (the repo's first React→core capability bridge)
> carries ink's `suspendTerminal` out of the tree to the command context.
>
> **(b) ink 7's `suspendTerminal` contract, read from its source, drives the design and is documented in
> `apps/cli/src/render/suspend.ts`.** `beginSuspend()` erases ink's frame and turns raw mode AND bracketed paste off
> (so we must touch neither); it toggles DECSET-1049 only when ink's `alternateScreen` **render option** is on — which
> is `true` for the bare Home but hard-`false` for `relavium chat`, whose hoisted controller owns 1049 (§c). The
> suspension is therefore surface-divergent. ink writes no mouse escapes anywhere, so 1000/1006 is entirely ours. And
> because raw mode is off for the whole window, a keyboard **Ctrl-C arrives as a real SIGINT** — the chat's signal
> handler must yield while a hatch owns the terminal, or it tears the session down behind the suspension's back and
> the pending reclaim re-enters the alt buffer on the user's shell.
>
> **(c) §e's "the first release defaults OFF (opt-in)" for mouse reporting is SUPERSEDED: it ships ON, with the
> mandatory opt-out.** Maintainer decision (2026-07-09). The wheel is what users expect of a full-screen TUI, and
> PgUp/PgDn-only surprised them. §e's *reason* for defaulting off stands unchanged and is exactly why the opt-out is
> no longer a follow-up but a shipped, tested part of this step: mouse capture disables the emulator's native
> copy-on-select (worst over SSH/tmux) and Relavium still has no in-app copy-on-select. The mitigations are now all
> live — **`--no-mouse`** / **`[preferences].mouse = false`**, the emulator's bypass modifier (Shift; Option on
> iTerm2), and the `/scrollback` + `/edit` hatches above. Read §e's "(default off first release)" in Consequences,
> and its "then flips to on-with-opt-out after real-terminal validation (a tracked follow-up)", as satisfied here:
> the flip happened together with the opt-out rather than after it. `resolveMouseMode` (render-mode.ts) makes one
> §e guarantee structural rather than conventional — it takes the ALREADY-RESOLVED render mode, so the inline
> renderer can never enable the mouse whatever the flag or the key say.
>
> **(d) §e's "suspend mouse around any TTY-inheriting subprocess" was, until Step 5d, vacuous.** Every other spawn in
> the repo (`run_command`, `git_*`, the `!`-shell) runs behind the tool sandbox with piped stdio and never touches the
> terminal. `$EDITOR` is the first TTY-inheriting child, and `suspendFullScreen` discharges the obligation for it.
>
> **Still pending from §e:** **DEC-2026 synchronized output** framing and the **branded Home banner** (+
> `[preferences].show_banner`). The banner's "evaluated against the three themes" acceptance criterion in
> [phase-2.6](../roadmap/phases/phase-2.6-conversational-authoring.md) cannot be met here — the renderer has no theme
> system at all (`[preferences].theme` exists in the config schema and nothing reads it); theming is 2.6.L, so the
> banner ships with colour / `NO_COLOR` variants and its theme variants move there.

> **Amended 2026-07-10 (Step 6 — in-app text selection + copy-on-select; §e's mouse deferrals are WITHDRAWN).**
> Maintainer decision, taken after using the shipped renderer. §e twice constrains this area and both constraints are
> superseded here; the §e text is left verbatim (append-only).
>
> **(a) "never 1002/1003" → we enable DECSET 1002.** §e admits only button reporting (1000) so the wheel scrolls. But
> a terminal either reports mouse events to the application or performs its own click-drag selection — never both, and
> there is no mode in between. (DECSET 1007 "alternate scroll" converts the wheel into cursor keys, which collide
> irrecoverably with the prompt's Up/Down history keys.) §e therefore forced a choice between a scrolling wheel and
> native selection, and Step 5e's `--no-mouse` only lets the user pick which one to lose. Enabling **1002**
> (button-event tracking: press, release, wheel, and motion *only while a button is held*) gives the app the drag it
> needs to implement selection itself. **1003** (any-motion) stays forbidden — it reports every pointer move.
>
> **(b) "Mouse click / drag / text-selection / copy-on-select … deferred to Phase 3" → shipped now.** The alt screen's
> copy regression is the renderer's single worst ergonomic cost, and §e's own mitigations (the bypass modifier, the
> `/scrollback` + `/edit` hatches, `--no-mouse`) are workarounds, not the affordance users expect. Competing agent
> CLIs (e.g. OpenCode) implement exactly this — the TUI captures the mouse, renders its own highlight, and writes the
> selection to the system clipboard with **OSC 52** on release. Their published issues also map the hazards we must
> design for up front rather than patch later: inside `tmux`/Zellij both the multiplexer and the app handle OSC 52
> (the escape needs DCS passthrough); OSC 52 is silently dropped over VS Code Remote SSH; and users want the behaviour
> switchable. So: `$TMUX`/`$ZELLIJ` detection, a `[preferences].copy_on_select` key, and `--no-mouse` continuing to
> disable the whole subsystem and hand native selection back.
>
> **Coordinate mapping — measured, not assumed.** A mouse report carries an absolute 1-based terminal row; the
> viewport needs a wrapped-transcript line index. Summing `yogaNode.getComputedTop()` up the `DOMElement.parentNode`
> chain yields the box's frame row, which was verified against the rendered frame's own line index across three
> layouts (with and without a header strip, with the live region grown). Both surfaces bind their ink root to
> `height: terminal rows` and ink's `log-update` writes a frame without a trailing newline, so the frame is anchored
> at terminal row 1. Hence `displayLine = scrollOffset + (mouseRow - 1 - viewportTop)`. The real-TTY confirmation of
> that anchor is a PR-time check.
>
> **Selection copies the VISUAL rows** the user highlighted — a wrapped paragraph comes back with those wraps as
> newlines, exactly as the terminal's own selection would have given, and exactly what the highlight showed. `/edit`
> and (Step 6) `/copy` hand over the UNWRAPPED document when fidelity matters more than the visual.

> ### Amendment — 2026-07-10 (2.6.F Steps 6e/6f, after the Step-6 adversarial review)
>
> Four claims made above, or in the Step-6 code, were **wrong**, and are corrected here rather than quietly patched.
> Append-only: the text above is left verbatim.
>
> **(a) The tmux plan was backwards.** The Step-6 amendment says "inside `tmux`/Zellij both the multiplexer and the app
> handle OSC 52 (the escape needs DCS passthrough)", and Step 6c shipped the DCS passthrough alone. Read from tmux's
> source: `input_osc_52_parse()` returns early unless `set-clipboard` is `on`, whose **default is `external`**; and
> `input_dcs_dispatch()` returns early unless `allow-passthrough` is on, whose **default is `off`**. Stock tmux honours
> **neither** form. Relavium therefore emits **both** (Step 6f-2), so setting either option suffices. The ESC-doubling
> inside the passthrough is confirmed correct by tmux's DCS state table.
>
> **(b) `$TMUX`/`$ZELLIJ` detection does NOT gate `copy_on_select`.** The plan was to auto-disable it inside a
> multiplexer. That rested on (a), and (a) was false. A copy inside tmux may silently do nothing — but that is
> indistinguishable from VS Code Remote SSH dropping the escape, which the design already accepts and reports honestly
> (`'written'`, never `'copied'`). Guessing at a multiplexer's configuration and silently disabling a feature is worse
> than attempting it. `copy_on_select` defaults ON whenever the mouse is on, and is a plain preference.
>
> **(c) "SGR does not encode which button was released"** — a comment in Step 6a's `mouse.ts`, on which the reducer was
> built. xterm's `ctlseqs` says the opposite of the `m` final byte: *"A different final character is used for button
> release to resolve the X10 ambiguity regarding which button was released."* Resolving that ambiguity is the reason
> the byte exists. Until Step 6f-3, any button coming up while a selection was live re-emitted the whole selection over
> OSC 52 — so every right-click re-copied.
>
> **(d) The coordinate mapping needed one more rule.** `cellAt` clamps a mouse row into the viewport, which is right for
> a DRAG (the pointer leaves it constantly) and wrong for a PRESS: a press on the prompt or the status strip anchored
> the selection to the viewport's last visible line. And because the focus is clamped, a drag could never select more
> than one screenful. Step 6f-5 adds `containsRow` (a press outside the viewport starts nothing) and `dragScrollMotion`
> (a drag on the viewport's first or last row scrolls a line **before** the focus is mapped). The boundary rows are
> inside the edge zone deliberately: `relavium chat` binds its viewport to frame row 0, so the pointer can never go
> above it and there would otherwise be no signal to scroll up at all — which is why vim and tmux copy-mode scroll on
> the boundary row too.
>
> **Also settled here.** A press freezes auto-follow for the gesture (a completing turn would otherwise slide the
> transcript out from under the pointer) and a plain click restores it. `Esc` dismisses a live selection while the chat
> is idle, never mid-turn, where `Esc` is the abort. `/copy` (Step 6e) copies the UNWRAPPED transcript document and
> suspends nothing — OSC 52 is one control write.

> ### Amendment — 2026-07-10 (2.6.F Step 5f: there was nothing to build)
>
> The Decision above says flicker "is avoided with terminal **synchronized output** (DEC 2026, `\x1b[?2026h/l`)
> framing, **since `ink` does not emit it**", and Step 5f was scheduled to build it — a `Proxy` over `process.stdout`
> wrapping every write. **That claim is false for `ink` 7.** It ships `build/write-synchronized.js`
> (`bsu` = `\x1b[?2026h`, `esu` = `\x1b[?2026l`) and frames every write in it, gated on
> `shouldSynchronize(stream, interactive)` = `stream.isTTY && (interactive ?? !isInCi)`.
>
> Measured against a real mount with Relavium's own render options: a TTY stdout receives one balanced BSU/ESU pair per
> frame; a piped stdout, an `interactive: false` mount, and a `debug: true` mount receive none. The `--json` / CI /
> non-TTY byte-identical guarantee is therefore already honoured by ink itself.
>
> Worse, the planned Proxy would have been actively wrong: ink writes `bsu` as its **own separate `write()` call**, so
> wrapping every write would have nested the escapes. Step 5f therefore implements nothing and instead PINS the
> behaviour (`synchronized-output.test.tsx`), so an ink bump that drops the framing fails loudly rather than silently
> restoring the flicker this ADR set out to remove.

## Consequences

### Positive

- The long-response clipping defect is **structurally** fixed for chat — the viewport shows the full
  response and scrolls (keyboard + wheel); going full-screen also sidesteps `ink`'s inline-overflow
  scrollback-wipe bugs.
- The ADR-0047 framework-free stores/view-models/projections transfer to the new renderer **unchanged**;
  the `RunRenderer` seam already cycles mount/unmount, so the full-screen renderer is the same shape.
- `usePaste` removes the hand-rolled bracketed-paste and **unifies** paste across the Home and standalone
  chat (closing a real gap); the harness closes the render-cadence test blind spot the whole CLI has had.

### Negative

- The full-screen renderer is a **substantial, novel hand-built subsystem** (viewport + row-measurement +
  scroll state machine + caps-lift + `<Static>`→viewport + resize + sync-output framing + the mouse-wheel
  slice). Mitigated: staged steps with per-step adversarial review, the inline renderer retained as a
  **first-class** fallback, and the new harness pinning render behavior.
- `ink` 7's input-semantics change needs a regression pass. Mitigated: the reducers' existing dual-fold +
  the approval reducer's escape-before-meta ordering absorb most of it; the Alt-motions + the Alt+digit
  guard are explicitly tested.
- Mouse **capture disables native copy-on-select** while enabled — mitigated by the opt-out (default off
  first release), the `[` / `v` hatches, and deferred in-app copy-on-select; and mouse cleanup on every
  teardown + subprocess-suspend is the highest-risk part (harness + e2e covered).
- Alt-screen is SR-hostile and its native selection is visible-rows-only. Mitigated: the `--no-alt-screen`
  / config fallback to the inline renderer, the `[` / `v` escape hatches, and `--json` as the structured
  non-TUI path — accessibility is an acceptance gate, documented in the user-facing docs.
- The `relavium run` TUI is **not** made full-screen here (a deliberate scope cut that avoids its
  SIGINT-cancel rework); its retained-scrollable-history is a tracked follow-up.
- New `[preferences]` keys (`alt_screen`, `mouse`, `show_banner`) extend the ADR-0063 config-write
  surface — small, typed, non-secret additions.
