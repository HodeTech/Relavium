# `relavium` — Bare-invocation interactive Home

> Last updated: 2026-06-29

- **Status**: Reference — the Home surface is delivered by **2.5.B** (the bare-invocation Home, the read-only management strip over `history.db`, the single-ink-tree mode machine, one SIGINT/SIGTERM lifecycle, and bracketed paste). The in-app slash palette / `/help` / `/doctor` (2.5.C), the reseat-less mode keymap + per-tool approval (2.5.E), and the Home-side `/models` picker land in later 2.5 workstreams and **extend** this same canonical home.
- **Surface**: CLI (a bare `relavium` with no subcommand, on a TTY)
- **Scope**: Phase 2.5, local-first. The Home is a thin surface over the **same** `@relavium/core` engine + `AgentSession` as `relavium chat` — it is a management + chat shell, never an IDE.
- **Related**: [commands.md](commands.md), [chat-session.md](chat-session.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../../decisions/0054-cli-bare-invocation-interactive-home.md](../../decisions/0054-cli-bare-invocation-interactive-home.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0047-cli-framework-commander-ink-clack.md](../../decisions/0047-cli-framework-commander-ink-clack.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0007-desktop-is-not-an-ide.md](../../decisions/0007-desktop-is-not-an-ide.md)

A bare `relavium` (no subcommand) on an interactive terminal opens a **branded, conversation-first Home**: a read-only **management strip** — recent sessions / runs / agents, with an *"Attention required"* section above a neutral *"Continue"* list — sitting over a live prompt. Type a message and the Home **graduates into a chat** in the same process; end the chat and you return to a freshly-read Home. The Home is the agent-first *"type the name → start talking"* entry ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) that every terminal-native agent CLI offers, added **without** breaking the CLI's CI/automation contract. See [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) for the decision and rationale.

## The TTY gate (when the Home opens)

The Home opens **only** when the process is genuinely interactive. The gate, evaluated in the existing bare-invocation branch of `run.ts` (**not** a `commander` default action, which would swallow unknown-command errors), is:

```
stdoutIsTty && stdinIsTty && !json && !isCiEnv(env)
```

- Both `stdout` **and** `stdin` must be TTYs (the `stdinIsTty` seam is the one the `create` wizard already uses). A pipe or redirect on either end keeps the meta-op.
- `--json` never opens the Home (the machine contract wins).
- The CI guard reuses the existing `isCiEnv` helper ([output-mode.ts](../../../apps/cli/src/process/output-mode.ts)), which treats `CI=true`, `CI=1`, or any truthy `CI` as CI — so a runner that sets `CI=1` or allocates a pseudo-TTY cannot accidentally open an interactive Home and stall the pipeline.

**Every non-interactive path is byte-for-byte unchanged**: a piped, `--json`, or CI bare invocation prints `program.helpInformation()` and exits `0`, exactly as before ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md) — `--help` / `--version` / a bare no-command invocation are exit-`0` meta-operations). The Home adds a TTY-gated branch and **no** new IO surface. A Home build/config fault renders like any command fault (a config/invocation `CliError` → exit `2`; any unexpected throw, or an `internal` fault, → exit `1` with a generic message, no raw leak).

## The management strip

The strip is a **read-only display** (the no-IDE-shell principle of [ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md) applied to the CLI by analogy: management + chat only — no file tree, editor, or embedded terminal). It is a bounded, indexed aggregation over the durable `history.db` ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)), re-read on every return-to-Home — never a live subscription.

```
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
- The aggregation is **indexed, not full-scan** (partial indexes on `updated_at`/`created_at` with the soft-delete predicate) and over-fetches just enough to backfill *Continue* past the entries lifted into *Attention* — see the 2.5.I performance budget.

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
| Backspace / Delete | erase one char | erase one char (idle) / ignored mid-turn | ignored |
| **Ctrl-C** | **clean exit (`0`)** | **`/cancel`** → end the chat, return to Home | **bail out** (exit) |
| **Ctrl-D** (EOF) | **clean exit (`0`)** on an **empty** prompt (a non-empty buffer keeps it — no data loss) | — | **clean exit (`0`)** (the prompt is empty while building, so EOF bails the build like Ctrl-C) |

Ctrl-C is **always** an escape — it is honored even in the `loading` state (so a hung build is never an unkillable wedge) and even mid-bracketed-paste (so a dropped paste-end marker can never trap the user). The richer slash palette, `@`-mention, `!`-shell, `Ctrl+J` multiline, history recall, and the ask/plan/accept-edits/auto **mode keymap** with per-tool approval are forthcoming (2.5.C / 2.5.E) and extend this table.

The **footer hint-bar** in 2.5.B is the single fixed line under the prompt — `type a message to start a new chat · Ctrl-C to exit` — plus the `Ctrl-C to exit` line on the degrade frame. The context-aware hint-bar (the two or three most-relevant keys per context/mode) lands in 2.5.C and extends this fixed footer.

## Bracketed paste (DECSET 2004)

The Home enables **bracketed paste** (`ESC[?2004h`) on mount and disables it (`ESC[?2004l`) on every exit path, so a pasted multi-line block is taken **literally** instead of an embedded newline submitting it early. The terminal wraps a paste in `ESC[200~ … ESC[201~`; the controller recognizes those markers (ink 6.8 surfaces them with the leading ESC stripped, so `[200~` / `[201~`), suppresses them, and appends the bracketed content verbatim (newlines preserved) with no key interpretation. Robustness:

- **Ctrl-C always escapes** a paste — even if the terminal drops the closing `ESC[201~` marker, Ctrl-C breaks out of paste mode and runs the normal exit/cancel, so the user is never wedged. The latch is also reset on every transition out (a chat ending, a build failure), so a lost marker cannot leak past the screen it began on.
- Paste content is **dropped while the buffer is not editable** — while a session **builds** (`loading`) or a chat turn **streams** (`running`) — matching the keystroke gate exactly, so paste never diverges from typing (a type-ahead message queue while a turn runs is deferred — see the phase deferred list).

## Minimum terminal size

Below **80×24** the Home **degrades** to a single line — `Terminal too small (WxH) — resize to at least 80×24.` plus a `Ctrl-C to exit` affordance — and **suspends** the strip render until a terminal **resize** arrives, rather than drawing a broken/garbled TUI. The resize is observed on `process.stdout`'s cross-platform `'resize'` event (backed by `SIGWINCH` on POSIX), not a bare `SIGWINCH` binding (unreliable on Windows). Every dynamic strip row and the prompt are truncated at the terminal edge (`truncate-end`), never soft-wrapped.

## Signal lifecycle & exit codes

The Home owns **one signal lifecycle (SIGINT/SIGTERM)** covering the Home, the in-Home chat, and MCP teardown (`closeMcp`):

| Outcome | How | Exit code |
| --- | --- | --- |
| **Clean Home exit** | Ctrl-C / EOF in `home` mode | `0` |
| **Signal-driven** | an external SIGINT / SIGTERM (`kill -INT` / a parent's signal) | `128 + signo` — **`130`** (SIGINT) / **`143`** (SIGTERM) |

On an external signal the handler restores the terminal (unmount ink, disable bracketed paste), tears the live chat — or an in-flight build — down **bounded** (a stuck MCP teardown can't hang the exit; a second signal force-exits immediately), closes the db once, and exits `128+signo` so a shell pipeline still detects the interruption. A keyboard Ctrl-C does **not** reach the process as SIGINT (raw mode), so the controller handles it (Home → `0`, chat → `/cancel`) and the `process.on('SIGINT')` handler covers only **out-of-band** signals.

A chat launched from the Home has its **own** exit code `4` ([chat-session.md](chat-session.md)) — but inside the Home that `4` is **consumed by the mode loop** (a chat ending returns to Home), **never leaked**. The Home's own exit code is `0` on a clean exit. See the canonical [Exit codes](commands.md#exit-codes) table.

## Recorded decisions / deferred surface

Settled in 2.5.B, recorded here as the canonical home (not re-litigated elsewhere):

- **In-flight build surface** — a slow `buildChatSession` shows a static `Starting chat…` loading state that echoes the pending message (the typed text never visually vanishes). A richer spinner + an in-build abort ride the 2.5.E mid-turn-abort work.
- **Attention ordering is a recency proxy, not a deadline sort** — gates are ordered by the paused run's `created_at DESC` (a glanceable proxy); true gate-recency / soonest-expiry-first would need the pending-gate read to carry the raise time. The renderer escalates an *expired* gate to red regardless of position.
- **Continue excludes lifted runs by status** — a failed or human-gated run lives only in *Attention*, never duplicated in *Continue*; the strip over-fetches to backfill *Continue* to its limit.
- **Forthcoming, extending this doc** — the slash command/palette taxonomy + manifest shape, `@`-mention semantics, and the ask/plan/accept-edits/auto mode keymap (2.5.C / 2.5.E); the Home-side `/models` picker over a connected-provider catalog; and an in-app message-queue/type-ahead while a turn runs (deferred, see [../../roadmap/deferred-tasks.md](../../roadmap/deferred-tasks.md)).
