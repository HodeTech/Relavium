# `relavium` — Bare-invocation interactive Home

> Last updated: 2026-11-10

- **Status**: Reference — the Home surface is delivered by **2.5.B** (the bare-invocation Home, the read-only management strip over `history.db`, the single-ink-tree mode machine, one SIGINT/SIGTERM lifecycle, and bracketed paste); the in-app slash palette / `/help` / `/doctor` + the context-aware footer landed in **2.5.C**; and the reseat-less mode keymap (`Shift+Tab` / `/mode`) + the fail-closed per-tool approval + the `Esc` mid-turn abort landed in **2.5.E** ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — all **extend** this same canonical home. The Home-side **`/models` picker** landed in **2.5.G**: in the bare Home an accepted pick writes the global `[preferences].default_model` (+ the effort tier) for the *next* session ([ADR-0063](../../decisions/0063-cli-config-write-contract.md) §1, [ADR-0064](../../decisions/0064-live-model-catalog.md)); in the in-Home **chat** the same picker **reseats** the live session instead ([chat-session.md](chat-session.md#model-reseat-models)).
- **Surface**: CLI (a bare `relavium` with no subcommand, on a TTY)
- **Scope**: Phase 2.5, local-first. The Home is a thin surface over the **same** `@relavium/core` engine + `AgentSession` as `relavium chat` — it is a management + chat shell, never an IDE.
- **Related**: [commands.md](commands.md), [chat-session.md](chat-session.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../../decisions/0054-cli-bare-invocation-interactive-home.md](../../decisions/0054-cli-bare-invocation-interactive-home.md), [../../decisions/0049-cli-machine-output-contract.md](../../decisions/0049-cli-machine-output-contract.md), [../../decisions/0047-cli-framework-commander-ink-clack.md](../../decisions/0047-cli-framework-commander-ink-clack.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0007-desktop-is-not-an-ide.md](../../decisions/0007-desktop-is-not-an-ide.md)

A bare `relavium` (no subcommand) on an interactive terminal opens a **branded, conversation-first Home**: a read-only **management strip** — recent sessions / runs / agents, with an *"Attention required"* section above a neutral *"Continue"* list — sitting over a live prompt. Type a message and the Home **graduates into a chat** in the same process; end the chat and you return to a freshly-read Home. The Home is the agent-first *"type the name → start talking"* entry ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) that every terminal-native agent CLI offers, added **without** breaking the CLI's CI/automation contract. See [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) for the decision and rationale.

Bare Home uses the same [invocation filesystem-root contract](commands.md#global-options) and forwards its process-local authority into chat/resume. The [session reference](chat-session.md#filesystem-authority-and-resume) owns original-workspace resume and policy reuse.

## The TTY gate (when the Home opens)

The Home opens **only** when the process is genuinely interactive. The gate, evaluated in the existing bare-invocation branch of `run.ts` (**not** a `commander` default action, which would swallow unknown-command errors), is:

```text
stdoutIsTty && stdinIsTty && !json && !isCiEnv(env)
```

- Both `stdout` **and** `stdin` must be TTYs (the `stdinIsTty` seam is the one the `create` wizard already uses). A pipe or redirect on either end keeps the meta-op.
- `--json` never opens the Home (the machine contract wins).
- The CI guard reuses the existing `isCiEnv` helper ([output-mode.ts](../../../apps/cli/src/process/output-mode.ts)), which treats any **non-empty** `CI` other than `false`/`0` as CI (`CI=true`/`CI=1` count; `CI=false`/`CI=0`/empty opt out) — so a runner that sets `CI=1` or allocates a pseudo-TTY cannot accidentally open an interactive Home and stall the pipeline.

**Every non-interactive path is byte-for-byte unchanged**: a piped, `--json`, or CI bare invocation prints `program.helpInformation()` and exits `0`, exactly as before ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md) — `--help` / `--version` / a bare no-command invocation are exit-`0` meta-operations). The Home adds a TTY-gated branch and **no** new IO surface.

A Home build/config fault uses the same [CLI failure classification](commands.md#failure-classification-and-remedies)
as a command: invalid config/invocation remains exit `2`, known operational faults
retain exit `1`, and an unexpected escaping throw uses the fixed `cli_internal`
projection and exit `9`, without its incoming message, cause or stack in that
projection. The legacy broad `internal` code is not remapped wholesale. Step 8d
implements caught Home/session fault integration and the complete fatal coordinator;
it is [independently accepted on `development`](../../roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17). This does not turn a
classified failed chat turn into a fatal CLI failure.

## Resume and Continue

`/resume` is available in the landing and the idle in-Home chat. It opens the
[native session picker](chat-session.md#finding-a-saved-session) while retaining
the current chat view. An empty landing prompt accepts Down to focus Continue's
recent sessions; Up/Down move, Enter resumes, and Esc returns to the prompt.
Typing or pasting into the prompt clears Continue focus before editing, so Enter
submits that draft rather than opening a previously focused session.
Only sessions are actionable in this increment. Session rows include a separate
sanitized directory line; management lists trim/scroll before the focused row,
keyless action and prompt can leave an 80×24 screen. No key/DB reads happen during
rendering or focus movement.

A saved session in another directory has a fixed open-Home-there/shell-picker
remedy; Home never reanchors its workspace. Safe restored history is prepared
before model/MCP build and activation, and a failed read offers retry/return.
Esc during restoration cancels the pending replacement host and its MCP startup,
preventing new credential/connection work. The existing Home or chat stays in place;
already-entered work and actual cleanup still join before the action returns.
An independent failure retains its original classification during cancellation.
Once a picker editor has been visibly mounted, filter typing, editing and paste
continue while its read-only results repaint under output backpressure. Enter,
result navigation, paging and scope changes still require the current result
card to be measured and flushed. A resize or new prompt invalidates editing
evidence too; suspension or loss of input custody blocks edits, and unseen input
is never buffered.
After selection the existing render-acknowledged effect disclosure remains the
activation boundary. The detailed projection, memory and hatch rules live in the
[chat reference](chat-session.md#proposed-restored-transcript-display--mvp-2).

## First-run onboarding wizard (2.5.G S8)

**Accepted on development — MVP-2 step 2 (2026-11-10).**
The Home mounts one Ink tree, then offers setup when no provider has a usable
source. Select, confirm, text and masked fields use the same native input owner;
existing chat history stays mounted while a setup card owns input. Native cards
require finite integer geometry of at least 80×24 and a fully visible current
card. Input and preference publication wait through resize until that card is
measured and flushed; a new snapshot or geometry change invalidates old evidence.
Esc/Ctrl-C closes the flow without leaving Home. Skipping leaves a persistent setup row;
Enter on an empty prompt or `/providers` opens it again. `/providers` is also
available in the in-Home chat, with connect/login/key discovery terms. Standalone
chat keeps its own palette and runs the shared setup before its normal host.
Native recovery messages name `/providers` in Home; standalone setup names
restarting `relavium chat`, where that shared setup is available.

The [credential-source contract](../contracts/config-spec.md#proposed-standard-environment-key-consent--mvp-2)
owns exact names, precedence, consent, backend-health distinctions and recovery.
Home samples availability on opening, after setup changes and on return from a
chat; rendering never probes the keychain. A usable source suppresses automatic
setup. An eligible standard source awaiting consent opens its named-source card;
a custom endpoint gets manual-key guidance instead. The `unavailable` state gets explicit acknowledgement/retry guidance. Backend
health remains independent of source status; a usable source still suppresses
automatic setup, and reminder state never grants credential authority.

Manual setup keeps the existing provider → masked key → validation/retry or
explicit save-anyway → OS-keychain flow. Native cards contain neither the key nor
its suffix, and validation copy comes from typed reasons. Before validation, both
Home and standalone chat show the safe origin (scheme, host and any non-default
port), without path, query or credentials, captured with the actual provider
adapter. A registry edit in another process cannot change that card's recipient
independently of its validation request. Restart Home/chat to use an externally
changed endpoint; the existing resolver keeps its original destination. An
invalid stored endpoint refuses validation and shows fixed recovery copy.
Private input is bounded, oversized paste is
rejected without truncation, and input after submit/cancel in the same dispatch
cannot become chat text or answer the next card. Actual validation work remains
owned until settlement even if its observation is cancelled.

First usable-source setup selects the provider's existing starter model through
the shared typed global writer. Existing-file rewrites display their comment/order
loss notice before publication. A saved preference with unconfirmed directory
sync says so; failure offers safe recovery, with a separately selected invocation
model where applicable. Explicit invocation defaults remain below project/workspace
model preferences. Connecting or replacing a key, or adding consent for another
provider, when one is already usable does not itself switch the default.
Provider cards name the currently usable source (OS keychain or the exact
environment-variable name), never its value or suffix. Resume keeps its saved agent/model.

Keys are never written to a config, transcript or plaintext fallback. A keychain
failure names the environment remedy; a later store failure does not falsely claim
that an already saved key vanished. Likewise, cancellation after a completed
key/default publication preserves its fixed committed outcome. The legacy injected
prompter remains a test/embedding seam; production Home and TTY chat setup use the
native host. Other shell scaffolding/gate prompts retain their existing contracts.

## Project initialization

**Accepted on development, MVP-2 step 3 (2026-11-10).**
`/init` is available in the landing and Home-chat palettes. Its card lists the
exact three directories before writing and defaults to **No**. Only an explicit
Yes creates them; Esc/Ctrl-C closes the card and keeps Home/chat. The existing
native input owner, complete-card visibility and resize/cancellation checks apply,
including at each directory publication. Existing chat history stays mounted.

The [shared init contract](commands.md#relavium-init) owns directory creation,
existing/nested projects, link refusal, cleanup and global-state exclusion. An
already initialized project produces a notice without a write confirmation or
repair. Global workflows/agents remain untouched; `/doctor` names the move/import
remedy. No unsolicited initialization prompt is shown.

## The management strip

The strip is a bounded, indexed aggregation over the durable `history.db` ([ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md)), re-read on every return-to-Home — never a live subscription. Under [ADR-0122](../../decisions/0122-the-home-is-the-interactive-product.md), MVP-2 makes its recent sessions keyboard-openable (MVP-A24); the other rows remain displays until their management milestone lands. It never mutates anything on its own (the no-IDE-shell principle of [ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md) applied to the CLI by analogy: management + chat only — no file tree, editor, or embedded terminal).

Before its first read the Home **reconciles** (2.6.G liveness): a run a dead process left `running` is settled and shows under *Attention required*, and a terminal held in the outbox is written. What is settled, how, and which runs are left alone are the rules `run` and `gate` follow, stated once with [exit code `5`](commands.md#exit-codes). The Home waits for this after the signal and exit nets are registered and before it mounts, so a crashed run whose lease has expired is settled before the first frame. A dead process's lease stays live for up to a minute after it died, and until it expires the run still shows as `running`; a later open settles it. Reconciling is best-effort and never keeps the Home from opening.

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

Both inline and full-screen interactive modes use the CLI's resolved output policy when mounting Ink.
An inline reseat keeps the existing terminal scrollback and displays the new store's entries once;
the root input owner stays mounted. The resume/reseat notice and retention ordering is defined in
[effect-journal.md](../shared-core/effect-journal.md#8-needs_attention).

## Minimum terminal size

Below **80×24** the landing shows `Terminal too small (WxH) — resize to at least 80×24.`
and a `Ctrl-C to exit` affordance. It suspends the management strip, prompt and overlays,
and refuses hidden typing, paste, Continue and palette activation using the live terminal
geometry. Esc and Ctrl-C/Ctrl-D cancellation remain available. A resize restores the
existing input and selection. The resize is observed on stdout's cross-platform `resize`
event (backed by SIGWINCH on POSIX).

At or above the minimum, management lists use the remaining row budget after the full
prompt, keyless action, errors and notices. The focused Continue session stays visible.
Strip labels truncate at the terminal edge; diagnostic notices and recovery instructions
wrap without dropping their source. Long notices show a range and **PgUp/PgDn** affordance
in both renderers. A new report or resize returns to its first page. Notice paging does
not submit input or change Continue focus, and yields to a keyboard-owning overlay.

## Signal lifecycle & exit codes

The invocation-backed Home shares **one signal lifecycle (SIGINT/SIGTERM/SIGHUP/SIGQUIT)** across the Home, pending/replaced chat hosts and MCP teardown. Its actual owners follow the [canonical invocation ordering](commands.md#invocation-owners-and-fatal-ordering); the synchronous native exit reap is a last-resort request, not a cleanup acknowledgement:

| Outcome | How | Exit code |
| --- | --- | --- |
| **Clean Home exit** | Ctrl-C / EOF in `home` mode | `0` |
| **Signal-driven, without a stronger infrastructure fault** | an external SIGINT / SIGTERM / SIGHUP / SIGQUIT (`kill -INT`, closing the terminal window, a parent's signal) | `128 + signo` — **`130`** (SIGINT) / **`143`** (SIGTERM) / **`129`** (SIGHUP) / **`131`** (SIGQUIT); infrastructure faults follow the [canonical precedence](commands.md#failure-classification-and-remedies) |

An external signal stops admission and requests terminal restoration and cleanup of every actual host, including an in-flight build. Repeated signals share the original finite deadline and cannot restart cleanup or force an immediate second-signal exit. The physical exit backstop bounds the invocation; it does not certify terminal, MCP or database release. The shared database closes only after actual host/work settlement, and failed or held cleanup retains its owners and signal custody. Infrastructure faults may strengthen the final disposition; read the [canonical remedies](commands.md#failure-classification-and-remedies) before repeating uncertain work. The ownerless library compatibility path is not this product invocation lifecycle.

A keyboard Ctrl-C does **not** normally reach the process as SIGINT (raw mode), so the controller handles it (Home → `0`, chat → `/cancel`). There is **one exception**: while a `/scrollback` or `/edit` suspension owns the terminal, ink has turned raw mode off and the kernel delivers a real SIGINT. That signal belongs to the hatch — the Home's handler drops it (`suspendPort.isSuspended()`), the hatch's own listener resumes the renderer, and the session survives. An external SIGTERM/SIGHUP/SIGQUIT still tears down, suspended or not.

A chat launched from the Home has its **own** exit code `4` ([chat-session.md](chat-session.md)) — but inside the Home that `4` is **consumed by the mode loop** (a chat ending returns to Home), **never leaked**. The Home's own exit code is `0` on a clean exit. See the canonical [Exit codes](commands.md#exit-codes) table.

## Recorded decisions / deferred surface

Settled in 2.5.B, recorded here as the canonical home (not re-litigated elsewhere):

- **In-flight build surface** — a slow `buildChatSession` shows a static `Starting chat…` loading state that echoes the pending message (the typed text never visually vanishes). A richer spinner is deferred; the `Esc` mid-turn abort (once a chat is built) landed in 2.5.E.
- **Attention ordering is a recency proxy, not a deadline sort** — gates are ordered by the paused run's `created_at DESC` (a glanceable proxy); true gate-recency / soonest-expiry-first would need the pending-gate read to carry the raise time. The renderer escalates an *expired* gate to red regardless of position.
- **Continue excludes lifted runs by status** — a failed or human-gated run lives only in *Attention*, never duplicated in *Continue*; the strip over-fetches to backfill *Continue* to its limit.
- **Landed since 2.5.B** — the interactive `/` palette UI (filterable, keyboard-navigable — 2.5.C S3b; the curated slash command set + the command-manifest shape are homed in [commands.md](commands.md)); the ask/plan/accept-edits/auto mode keymap + per-tool approval + `Esc` abort (2.5.E, [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)); the input ergonomics + `@`-mention + `!`-shell (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)); the Home-side `/models` picker over the merged live/static catalog (2.5.G S7, [ADR-0064](../../decisions/0064-live-model-catalog.md) §10 — detailed in [commands.md](commands.md)); and the first-run onboarding wizard (2.5.G S8 — above).
- **Forthcoming, extending this doc** — an in-app message-queue/type-ahead while a turn runs (deferred, see [../../roadmap/deferred-tasks.md](../../roadmap/deferred-tasks.md)).
