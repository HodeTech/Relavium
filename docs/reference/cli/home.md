# `relavium` — Bare-invocation interactive Home

> Last updated: 2026-07-02

- **Status**: Reference — the Home surface is delivered by **2.5.B** (the bare-invocation Home, the read-only management strip over `history.db`, the single-ink-tree mode machine, one SIGINT/SIGTERM lifecycle, and bracketed paste); the in-app slash palette / `/help` / `/doctor` + the context-aware footer landed in **2.5.C**; and the reseat-less mode keymap (`Shift+Tab` / `/mode`) + the fail-closed per-tool approval + the `Esc` mid-turn abort landed in **2.5.E** ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — all **extend** this same canonical home. The Home-side `/models` picker is a later 2.5 workstream.
- **Surface**: CLI (a bare `relavium` with no subcommand, on a TTY)
- **Scope**: Phase 2.5, local-first. The Home is a thin surface over the **same** `@relavium/core` engine + `AgentSession` as `relavium chat` — it is a management + chat shell, never an IDE.
- **Related**: [commands.md](commands.md), [chat-session.md](chat-session.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../../decisions/0054-cli-bare-invocation-interactive-home.md](../../decisions/0054-cli-bare-invocation-interactive-home.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0047-cli-framework-commander-ink-clack.md](../../decisions/0047-cli-framework-commander-ink-clack.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0007-desktop-is-not-an-ide.md](../../decisions/0007-desktop-is-not-an-ide.md)

A bare `relavium` (no subcommand) on an interactive terminal opens a **branded, conversation-first Home**: a read-only **management strip** — recent sessions / runs / agents, with an *"Attention required"* section above a neutral *"Continue"* list — sitting over a live prompt. Type a message and the Home **graduates into a chat** in the same process; end the chat and you return to a freshly-read Home. The Home is the agent-first *"type the name → start talking"* entry ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) that every terminal-native agent CLI offers, added **without** breaking the CLI's CI/automation contract. See [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) for the decision and rationale.

## The TTY gate (when the Home opens)

The Home opens **only** when the process is genuinely interactive. The gate, evaluated in the existing bare-invocation branch of `run.ts` (**not** a `commander` default action, which would swallow unknown-command errors), is:

```text
stdoutIsTty && stdinIsTty && !json && !isCiEnv(env)
```

- Both `stdout` **and** `stdin` must be TTYs (the `stdinIsTty` seam is the one the `create` wizard already uses). A pipe or redirect on either end keeps the meta-op.
- `--json` never opens the Home (the machine contract wins).
- The CI guard reuses the existing `isCiEnv` helper ([output-mode.ts](../../../apps/cli/src/process/output-mode.ts)), which treats any **non-empty** `CI` other than `false`/`0` as CI (`CI=true`/`CI=1` count; `CI=false`/`CI=0`/empty opt out) — so a runner that sets `CI=1` or allocates a pseudo-TTY cannot accidentally open an interactive Home and stall the pipeline.

**Every non-interactive path is byte-for-byte unchanged**: a piped, `--json`, or CI bare invocation prints `program.helpInformation()` and exits `0`, exactly as before ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md) — `--help` / `--version` / a bare no-command invocation are exit-`0` meta-operations). The Home adds a TTY-gated branch and **no** new IO surface. A Home build/config fault renders like any command fault (a config/invocation `CliError` → exit `2`; any unexpected throw, or an `internal` fault, → exit `1` with a generic message, no raw leak).

## First-run onboarding wizard (2.5.G S8)

When a bare `relavium` opens the Home on a **truly key-less** run — **no** known provider has a resolvable key (the resolver finds neither an OS-keychain key **nor** a `RELAVIUM_<PROVIDER>_API_KEY` env var) — a `@clack/prompts` **onboarding wizard** runs **before** the ink Home mounts (clack + ink both take the terminal's raw mode, so the wizard fully settles first). It is already behind the TTY gate above, so it never runs piped / `--json` / in CI. A run with **either** a keychain key or an env key is not key-less — no wizard, so a working user (including an env-key user) is never prompted.

The flow: **pick a provider → paste a hidden (masked) API key → store it in the OS keychain** — riding the same tested `provider set-key` path (keychain write + the provider row + the keychain-ref, secret-free by construction; the key is captured via clack's masked `password`, whitespace-trimmed, never echoed, never written to disk, never logged beyond its last-4 hint). On a successful store the wizard also sets **`[preferences].default_model` to the chosen provider's cheap/fast starter model** (`KNOWN_PROVIDERS[provider].testModel`, via the same global config-write target as `/models` — `[chat].default_model` is only the read-time fallback that resolves down to it, ADR-0063 §1) — so the very next chat binds a model **whose key was just stored**, not the built-in `claude-sonnet-4-6` (which would error for a user who picked a non-Anthropic provider). Richer **model selection** is not part of the wizard — the user upgrades via the `/models` picker. Three fallbacks keep a first run unblocked:

- **Keychain-write failure** (a locked keychain / no Secret Service / a headless box) → the wizard **never** persists the key to disk; it prints the `RELAVIUM_<PROVIDER>_API_KEY` env-var to set instead (the resolver imports an env key at call time), then hands off to the Home.
- **Any other store fault** (e.g. a db write failure *after* the keychain write succeeded) → a **generic** "setup could not be completed" note (never mislabeled a keychain failure, and the raw error is never rendered — the key may well be in the keychain, so the copy must not claim otherwise); the underlying issue resurfaces at the Home, which reads the same store.
- **Cancel** (Ctrl-C / Esc at any step) → a friendly pointer to `relavium provider add` / `/doctor`, then the Home mounts key-less (retry next launch, or add a key manually).

`@clack/prompts` is confined to one module behind an injectable seam (mirroring the `create` wizard + the gate prompter — [ADR-0047](../../decisions/0047-cli-framework-commander-ink-clack.md)), so the flow unit-tests without a TTY. No new ADR: the wizard composes the config-write ([ADR-0063](../../decisions/0063-cli-config-write-contract.md)), keychain ([ADR-0006](../../decisions/0006-os-keychain-for-api-keys.md)/[ADR-0019](../../decisions/0019-cli-node-keychain-library.md)), and clack ([ADR-0047](../../decisions/0047-cli-framework-commander-ink-clack.md)) decisions already accepted.

## The management strip

The strip is a **read-only display** (the no-IDE-shell principle of [ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md) applied to the CLI by analogy: management + chat only — no file tree, editor, or embedded terminal). It is a bounded, indexed aggregation over the durable `history.db` ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)), re-read on every return-to-Home — never a live subscription.

```text
relavium                                          ← branded header (bold)

  Attention required
    ⚠ deploy        · approval     · "Ship it?"  · expires in 5m
    ⚠ migrate       · review       · "LGTM?"     · expired          ← overdue ⇒ red
    ✗ nightly-build · failed       · 3h ago      · $0.0210

  Continue
  Sessions
    Plan the launch · planner · 5m ago · $1.2000
    chatter         · 12m ago · free                                ← untitled ⇒ agent slug once
  Runs
    deploy · completed · 2h ago · free
  Agents
    coder · 3d ago

> █                                                                 ← live prompt + cursor
type a message to start a new chat · Ctrl-C to exit                 ← footer hint
```

- **Attention required** — pending **human gates first** (ordered by their paused run's `created_at DESC`, a glanceable proxy for start time), then **failed runs** (most-recent first). An **overdue** (expired) gate is escalated yellow → red. A run that is failed or human-gated is **lifted** into this section and **never repeated** in *Continue*.
- **Continue** — the neutral recency lists: recent **sessions** (title or agent slug · agent · when · cost), **runs** (workflow or short id · status · when · cost), and **agents** (slug · last used), each bounded to a small limit.
- **First run** — when there is nothing to show, a welcome (value framing + an example prompt) replaces the empty strips.
- Every free-form label (a session title, a gate message) is sanitized at the display boundary (control sequences stripped, newlines/tabs collapsed) so it cannot forge a row or inject an escape; kebab slugs and closed enums are safe by construction. Cost reuses the canonical micro-cents → USD conversion (`free` for zero-cost).
- The aggregation is **indexed, not full-scan** (partial indexes on `updated_at`/`created_at` with the soft-delete predicate), and the pending-gate check reads only the gate-relevant events (the per-token streaming firehose is excluded), so the whole snapshot is a handful of bounded top-N reads — it over-fetches just enough to backfill *Continue* past the entries lifted into *Attention*.

A **session title** is derived from the first user message (~40 chars, truncated by code point so an emoji never splits) so the *Sessions* list is readable; an LLM-summarised title is a later phase.

## The mode machine (Home ↔ chat in one ink tree)

The Home and the chat render as **one ink tree with conditional rendering** — a single `useInput` owner — never two mounted apps, so the raw-mode owner never conflicts. The session state machine lives in a plain external store (`home-controller.ts`, unit-tested without ink); the ink component is a thin view that subscribes to it and forwards every key.

| Mode | What renders | Transition |
| --- | --- | --- |
| `home` | the management strip + the live prompt | a non-empty submit → `loading`; Ctrl-C → clean exit (`0`) |
| `loading` | the pending message echoed under `Starting chat…` | the deferred `buildChatSession` resolves → `chat`; it rejects → back to `home` with a banner |
| `chat` | the live chat region ([chat-session.md](chat-session.md)) | the chat ends (`/exit` / `/cancel` / Ctrl-C) → back to a freshly-read `home` |

The chat session is built **after** the ink mount (an explicit loading state), so the strip shows instantly and a slow or failed build degrades to the loading state / a Home banner rather than blocking the entry. A built chat reuses the **built-in default chat agent** over `[chat].default_model` (a zero-config, read-only first run — see [chat-session.md](chat-session.md)); the Home does not bind a custom agent (`relavium chat --agent <ref>` is the path for that).

### Keymap (2.5.B)

| Key | `home` | `chat` | `loading` |
| --- | --- | --- | --- |
| printable | append to the prompt buffer | append (idle) / ignored mid-turn | ignored |
| Return | submit → start a chat | submit the turn (idle) / ignored mid-turn | ignored |
| Backspace / Delete | erase the char **before** the cursor | erase before the cursor (idle) / ignored mid-turn | ignored |
| **Shift+Tab** (2.5.E) | — | **cycle the chat mode** (ask → plan → accept-edits → auto), ADR-0057 | — |
| **Esc** (2.5.E) | — | **abort the in-flight turn** (mid-turn, EA7 — keeps the session; distinct from `/cancel`) | — |
| **`[y]`/`[a]`/`[n]`/`[esc]`** (2.5.E) | — | **answer a pending per-tool approval** — `[y]` once · `[a]` always · `[n]` no · `[esc]` abort (the prompt owns the keyboard) | — |
| **Ctrl+J** (2.5.D) | insert a newline (multi-line prompt) | insert a newline (idle) | ignored |
| **↑ / ↓** (2.5.D) | — | recall prev/next submitted line (buffer edge) / move by line (mid-buffer) | — |
| **Ctrl+R** (2.5.D) | — | reverse-incremental history search (chat only) | — |
| **`@`** (2.5.D) | append (no completion in the bare Home) | at a word boundary, open dir-navigable **file completion** → insert a `@path` marker + queue a **chip** that expands to UNTRUSTED context at submit ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) | — |
| **`!`** (2.5.D) | append | a leading `!` runs a **shell command** via the `[chat].allowed_commands` allowlist → mode-aware `confirmAction` → `spawn` (`shell:false`); output shown read-only + queued as a **chip** carrying UNTRUSTED context to the next message ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) | — |
| **`Esc`** (2.5.D) | — | at an **idle** prompt with pending `@`/`!` chips, **discard them** (else mid-turn abort) | — |
| **Ctrl-C** | **clean exit (`0`)** | **`/cancel`** → end the chat, return to Home | **bail out** (exit) |
| **Ctrl-D** (EOF) | **clean exit (`0`)** on an **empty** prompt (a non-empty buffer keeps it — no data loss) | — | **clean exit (`0`)** (the prompt is empty while building, so EOF bails the build like Ctrl-C) |

Ctrl-C is **always** an escape — it is honored even in the `loading` state (so a hung build is never an unkillable wedge). The reseat-less **mode keymap** (`Shift+Tab` + `/mode`) and the fail-closed **per-tool approval** landed in **2.5.E** ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md); wired into the Home via the same `home-controller.ts` key routing — see [chat-session.md](chat-session.md)); the interactive `/` command palette landed in **2.5.C**. The **input ergonomics** (`Ctrl+J` multiline, `↑/↓` history + `Ctrl+R` search, readline motions) and the two data-moving affordances (`@`-mention file injection, `!`-shell command escape) landed in **2.5.D** ([ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)) — the `@`/`!` semantics are the SAME as the standalone chat (see [chat-session.md](chat-session.md#input-ergonomics-25d-adr-0061)).

The **footer hint-bar** in 2.5.B was the single fixed line; the context-aware hint-bar (the two or three most-relevant keys per context) landed in **2.5.C**, and the always-visible **active-mode footer indicator** (`formatSessionFooterWithMode`) arrived with **2.5.E** (ADR-0057) — together they extend that fixed footer.

## Bracketed paste (ink 7 native `usePaste`)

The Home receives a bracketed paste on **ink 7's native `usePaste` channel** (separate from `useInput`; adopted in 2.6.F, [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)): ink enables/disables bracketed-paste mode (`ESC[?2004h`/`l`) automatically on mount/unmount and delivers the **whole paste as one event** (the `ESC[200~ … ESC[201~` markers stripped, and split stdin chunks reassembled). It is routed to `HomeController.handlePaste`, which appends the block **verbatim** — embedded newlines kept, CRLF/CR → LF — so a pasted multi-line block never submits early. A defensive `ESC[?2004l` is also written on the signal/exit teardown as belt-and-suspenders over ink's own unmount cleanup. Gate:

- **A paste appends ONLY when the main prompt is the active editable target** — dropped while a session **builds** (`loading`), a chat turn **streams** (`running`), a `!`-shell / submit is in flight, or any keyboard-owning overlay/submode is open (the `/` palette, `Ctrl+R` reverse-search, `@`-mention, `/models`, `/effort`, the `[c]` reason capture). The gate is the shared `pasteIsEditable` predicate, so the Home and the standalone [chat](chat-session.md) can never diverge (a type-ahead queue while a turn runs is deferred — see the phase deferred list).
- **Security ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)):** a paste is dropped while a per-tool **approval is pending**, so a pasted approval token (`y` / `a` / `n` / …) can **never** answer the fail-closed approval floor — paste arrives on the `usePaste` channel and is never routed to the approval key reducer.

## Render mode (inline / alt-screen)

A **branded banner** — a wordmark + tagline plaque — is drawn where the plain `relavium` heading otherwise sits, on a
fresh install: `[preferences].show_banner` is `true` (always) / `false` (never), and **absent** means *shown only while
the Home is empty*, so it greets a first run and auto-dismisses once there is anything to continue. It degrades to
plain ASCII under `NO_COLOR` / `--no-color`, and a forced banner stands down on a terminal too short to hold it beside
the strip. It is cosmetic and gates no feature.

The Home renders in one of two modes ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e): since Step 4b-3 the **default on a TTY is the full-screen alternate-screen renderer**, with the **inline** renderer (native scrollback, the screen-reader-friendly fallback) as the opt-out — **`--no-alt-screen`** ([commands.md](commands.md#global-options)) for one invocation, or **`[preferences].alt_screen = false`** ([config-spec.md](../contracts/config-spec.md)) durably. A non-TTY / `--json` / CI path is **always** inline (byte-identical). The alt screen renders the transcript through a resize-tracked **viewport** with **scroll-back + auto-follow** — **PgUp/PgDn** page, **Ctrl+Home/Ctrl+End** jump to top/tail, an upward scroll pauses the tail-follow and reaching the bottom resumes it (the scroll keymap is gated behind any keyboard-owning overlay) — and a per-entry wrap cache (keyed on the immutable transcript entry) keeps even a very large transcript cheap (Step 4b-3). The in-Home chat also carries the mouse **selection + copy-on-select** and the **`/scrollback`**, **`/edit`** and **`/copy`** copy-and-search hatches — the same code as `relavium chat` ([chat-session.md](chat-session.md)); the hatches are chat-only, so they never appear in the bare Home's palette. **Mouse reporting is armed only while the chat owns the screen**: the Home landing has no viewport to wheel-scroll and no in-app selection, so it keeps the emulator's own click-drag selection instead. The full-screen mode is inherently inaccessible to screen readers — see [accessibility.md](accessibility.md) for the trade-off and the inline-renderer escape hatch.

## Minimum terminal size

Below **80×24** the Home **degrades** to a single line — `Terminal too small (WxH) — resize to at least 80×24.` plus a `Ctrl-C to exit` affordance — and **suspends** the strip render until a terminal **resize** arrives, rather than drawing a broken/garbled TUI. The resize is observed on `process.stdout`'s cross-platform `'resize'` event (backed by `SIGWINCH` on POSIX), not a bare `SIGWINCH` binding (unreliable on Windows). Every dynamic strip row and the prompt are truncated at the terminal edge (`truncate-end`), never soft-wrapped.

> **Known limitation (tracked).** *At or above* 80×24, a very tall landing — a populated **Attention required** section (many pending gates) plus the Continue lists — can still exceed the terminal's rows, and the alt buffer has no scrollback to recover the top. This predates 2.6.F (the strip is 2.5.B) and is resolved by **2.6.G**'s management browsers, which replace the strip wholesale. See [docs/roadmap/current.md](../../roadmap/current.md).

## Signal lifecycle & exit codes

The Home owns **one signal lifecycle (SIGINT/SIGTERM/SIGHUP/SIGQUIT)** covering the Home, the in-Home chat, and MCP teardown (`closeMcp`), plus a synchronous `process.on('exit')` net behind all of them:

| Outcome | How | Exit code |
| --- | --- | --- |
| **Clean Home exit** | Ctrl-C / EOF in `home` mode | `0` |
| **Signal-driven** | an external SIGINT / SIGTERM / SIGHUP / SIGQUIT (`kill -INT`, closing the terminal window, a parent's signal) | `128 + signo` — **`130`** (SIGINT) / **`143`** (SIGTERM) / **`129`** (SIGHUP) / **`131`** (SIGQUIT) |

On an external signal the handler restores the terminal (unmount ink, disable bracketed paste, disable mouse reporting), tears the live chat — or an in-flight build — down **bounded** (a stuck MCP teardown can't hang the exit; a second signal force-exits immediately), closes the db once, and exits `128+signo` so a shell pipeline still detects the interruption.

A keyboard Ctrl-C does **not** normally reach the process as SIGINT (raw mode), so the controller handles it (Home → `0`, chat → `/cancel`). There is **one exception**: while a `/scrollback` or `/edit` suspension owns the terminal, ink has turned raw mode off and the kernel delivers a real SIGINT. That signal belongs to the hatch — the Home's handler drops it (`suspendPort.isSuspended()`), the hatch's own listener resumes the renderer, and the session survives. An external SIGTERM/SIGHUP/SIGQUIT still tears down, suspended or not.

A chat launched from the Home has its **own** exit code `4` ([chat-session.md](chat-session.md)) — but inside the Home that `4` is **consumed by the mode loop** (a chat ending returns to Home), **never leaked**. The Home's own exit code is `0` on a clean exit. See the canonical [Exit codes](commands.md#exit-codes) table.

## Recorded decisions / deferred surface

Settled in 2.5.B, recorded here as the canonical home (not re-litigated elsewhere):

- **In-flight build surface** — a slow `buildChatSession` shows a static `Starting chat…` loading state that echoes the pending message (the typed text never visually vanishes). A richer spinner is deferred; the `Esc` mid-turn abort (once a chat is built) landed in 2.5.E.
- **Attention ordering is a recency proxy, not a deadline sort** — gates are ordered by the paused run's `created_at DESC` (a glanceable proxy); true gate-recency / soonest-expiry-first would need the pending-gate read to carry the raise time. The renderer escalates an *expired* gate to red regardless of position.
- **Continue excludes lifted runs by status** — a failed or human-gated run lives only in *Attention*, never duplicated in *Continue*; the strip over-fetches to backfill *Continue* to its limit.
- **Landed since 2.5.B** — the interactive `/` palette UI (filterable, keyboard-navigable — 2.5.C S3b; the curated slash command set + the command-manifest shape are homed in [commands.md](commands.md)); the ask/plan/accept-edits/auto mode keymap + per-tool approval + `Esc` abort (2.5.E, [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)); the input ergonomics + `@`-mention + `!`-shell (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)); the Home-side `/models` picker over the merged live/static catalog (2.5.G S7, [ADR-0064](../../decisions/0064-live-model-catalog.md) §10 — detailed in [commands.md](commands.md)); and the first-run onboarding wizard (2.5.G S8 — above).
- **Forthcoming, extending this doc** — an in-app message-queue/type-ahead while a turn runs (deferred, see [../../roadmap/deferred-tasks.md](../../roadmap/deferred-tasks.md)).
