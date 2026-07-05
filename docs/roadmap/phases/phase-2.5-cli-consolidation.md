# Phase 2.5 — CLI Consolidation and Conversational Home

> Status: In progress. **2.5.A** (shared tool-environment factory + capability-gap root-cause fix) is
> ✅ **Done (PR #60, 2026-06-28)**, behind [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)
> — **milestone M2.5-1 (secure base) reached**. Spine continues: **2.5.B** (Home) ✅ → **2.5.C** (slash registry
> + palette + `/help`/`/doctor`/`/workflows`/`/cost` + footer hint-bar) ✅ **Done (PR #62, 2026-06-30)**
> → **2.5.E** (modes + per-tool approval + mid-turn abort) ✅ **Done (PR #63, 2026-07-03)** (ADR-0057 Accepted)
> — **the spine is complete**. Experience arm: **2.5.D** (chat input ergonomics + `@`/`!` chip model) ✅ **Done
> (PR #64, 2026-07-03)** behind [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md).
> **2.5.F** (`/clear` + the `session:compacting` "Summarizing…" moment + the context-fullness footer, completing
> the ADR-0062 compaction story) ✅ **Done (PR #65, merged 2026-07-05)**. **Next: 2.5.G** (onboarding wizard +
> Home `/models`). Additive lanes (no dependency chain): 2.5.H / I / J.

- **Related**: [../README.md](../README.md), [phase-2-cli.md](phase-2-cli.md), [phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md), [phase-3-desktop.md](phase-3-desktop.md), [../../reference/cli/commands.md](../../reference/cli/commands.md), [../../reference/cli/chat-session.md](../../reference/cli/chat-session.md), [../../reference/cli/regression-harness.md](../../reference/cli/regression-harness.md), [../../decisions/README.md](../../decisions/README.md) (ADR-0054–0057)

A consolidation phase between Phase 2 (CLI) and Phase 3 (desktop). It is **not only a CLI
surface phase**: it also discharges a set of bounded, pure engine amendments, a reasoning-render
lane, a regression-harness extension, and a documentation-debt cleanup that accumulated across
Phase 2. Phase 2.6 ([phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md))
carries the heavier authoring and parity work that depends on this spine.

## Goal

Turn the bare `relavium` invocation into a branded, conversation-first **Home**, give it a
first-class slash-command palette and modern chat ergonomics, and **structurally fix the
capability-gap root cause** — all without breaking the `--json` / CI / non-TTY contract
([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)) or any existing subcommand.
Along the way, close the bounded engine amendments and docs-debt that Phase 2 deferred.

## Outcomes (Definition of Done)

- `relavium` in a TTY opens a branded Home; under `--json` / `CI=true` / non-TTY it keeps the
  current `helpInformation()` + exit `0` behaviour (regression-harness proven).
- The built-in chat agent's advertised tools (`read_file` / `list_directory` / `git_status`)
  **actually work** (read-only host wired); `capability_unavailable` **never** surfaces as a bare
  `internal`; a failed turn reports **real** token usage.
- A `/` palette + `/help` + `/doctor` + `/workflows` + `/clear`; chat modes
  (ask / plan / accept-edits / auto) with **per-tool approval** and **mid-turn abort**, all on the
  same session instance (no reseat for mode changes); `Ctrl+J` multiline, history recall, `@`-mention,
  `!`-shell, bracketed paste.
- An onboarding wizard (hidden-prompt key → keychain) and `/models` (Home) over a connected-provider
  model catalog; reasoning is visible in the TUI with live-turn latency feedback.
- The regression harness covers `Home → chat → resume → export`; the docs-debt is closed.

## Scope

### In scope

- The bare-invocation Home, the in-app slash system, chat input ergonomics, the reseat-less mode
  system with per-tool approval and mid-turn abort, onboarding, the Home-side `/models` picker,
  reasoning rendering, the regression-harness extension, and docs reconciliation.
- **Bounded, pure engine amendments** (each behind a new ADR; the engine's architecture and the
  platform boundary do **not** change — [CLAUDE.md](../../../CLAUDE.md) #5 holds): a `tool_unavailable`
  error code, real-usage reporting on failed turns, a registry pre-dispatch approval hook, an
  `AgentSession` pause/resume + mid-turn-abort state, an `agent:approval_requested` event, and a
  reasoning host-emit event.
- The shared `read-only`/`read-write` tool-environment factory wired into **both** the chat path
  and the workflow-run path (the host-side SSRF egress arm reuses the Phase-2 `EgressCapability`).

### Explicitly out of scope (→ Phase 2.6 or Phase 3)

- Conversational (model-generated) authoring, the `@relavium/authoring` package promotion, mid-session
  **model** reseat, session `{{ctx.*}}` interpolation, and competitor-parity polish — all
  [phase-2.6-conversational-authoring.md](phase-2.6-conversational-authoring.md).
- `read_media` input (D12), full-fidelity reseat tool-context, in-app scrollback/pager, a **type-ahead
  message queue while a turn runs** (the in-flight key-swallow is handled for approval input in 2.5.E, but
  queuing the *next* message is deferred), live provider `/v1/models` fetch, and a multi-pane dashboard —
  Phase 3 / later (tracked in [../deferred-tasks.md](../deferred-tasks.md)). (`/compact` model-summarised
  compaction was originally listed here as Phase 3; it is now **built in 2.5.F** per [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md).)

## Work breakdown

### 2.5.A — Shared tool-environment factory and capability-gap root-cause fix — ✅ **Done (PR #60, 2026-06-28)**

> **Status:** ✅ **Done (PR #60, 2026-06-28)** — behind [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)
> (Accepted after the security-review gate). Shipped: one shared `assembleToolEnv({ profile, fsScopeTier,
> workspaceDir })` factory wired into **both** `chat/session-host.ts` (read-only chat) and `engine/build-engine.ts`
> (read-write run), deleting the two inline host expressions and keeping the MCP arm a true **merge**, not a
> replace; the host-side **`fs`** (`realpath` + `commonpath` jail, symlink-safe, read-only fail-close, single-fd
> `O_NOFOLLOW`/`O_NONBLOCK` reads that reject directories/FIFOs/devices and close the read TOCTOU) and **`process`**
> arms (shell-`false`, ambient-PATH resolution, declared-env denylist, process-group SIGKILL) so the built-in
> agent's three tools work; the **advertise-filter** (an unwired tool is never offered); **EA1** (`tool_unavailable`
> `ErrorCode`, replacing the bare `internal` for a missing capability); and **EA2** (real accumulated usage on a
> failed turn via `AgentTurnError.usage`, with the turn-cap gated on a provider-engaged signal). **Deferred to
> 2.5.E/[ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)** (recorded in
> [../deferred-tasks.md](../deferred-tasks.md)): the `egress`/`os` arms, the `project`-tier `extraRoots` allowlist
> (so `project` is workspace-only for now), and a write-capable / `full`-tier chat behind the per-tool approval
> floor. The parent-directory TOCTOU residual is a Node `openat` limitation (also recorded).

The spine. The built-in chat agent advertises `read_file` / `list_directory` / `git_status`
(`apps/cli/src/chat/default-agent.ts`) and its system prompt already tells the model to *"say so
plainly"* when a tool is unavailable — a **designed** graceful path. But the CLI wires a fail-closed
`ToolHost` on both the chat path (`apps/cli/src/chat/session-host.ts`) and the workflow-run path
(`apps/cli/src/engine/build-engine.ts`), so the first tool call throws `capability_unavailable`,
which `codeForToolError` (`packages/core/src/engine/agent-turn.ts`) maps to a bare `internal`. This
workstream restores and completes that path with a single shared factory.

**Tasks:**

- Add a shared `assembleToolEnv(mode, fsScopeTier)` factory returning `{ host: ToolHost, policy:
  ToolPolicy }` — keeping the three concepts separate: `ToolHost` capability arms
  (`fs`/`process`/`egress`/`os`/`mcp`/`outputStore`, [tool-registry.md](../../reference/shared-core/tool-registry.md)),
  `ToolPolicy` allowlists (`allowedCommands`/`allowedDomains`,
  [workflow-yaml-spec.md](../../reference/contracts/workflow-yaml-spec.md)), and the
  `ToolDispatchContext` (`fsScope`). Wire it into **both** `session-host.ts` and `build-engine.ts`,
  deleting the two inline host expressions; always use conditional spread (`exactOptionalPropertyTypes`)
  so the existing MCP-merge stays a true **merge**, not a replace (the run path currently *replaces*
  — a latent bug once a sibling arm is added).
- Wire the host-side `fs` (read-only by default) **and the `process` arm** so the chat agent's three
  tools work — `read_file` / `list_directory` use `fs`, but `git_status` spawns `git` through
  `requireProcess`, so `fs` alone would still fail it (the same root cause). `run_command` stays
  unadvertised (advertise-filter) and denied by an empty `allowedCommands`, so the `process` arm only
  serves the pre-approved `git_status` in the default profile. Add the `fs`-read-write and `egress`
  tiers for the higher modes (egress reuses the Phase-2 SSRF-validated `EgressCapability.fetch`), with a
  dedicated security review.
- **Engine amendment (EA1):** map the existing dispatch-layer `capability_unavailable`
  (`ToolUnavailableError`) to a new portable `ErrorCode` (proposed `tool_unavailable`) in `constants.ts`
  instead of `internal` — `codeForToolError` (`agent-turn.ts`) is the single change point — so a missing
  capability is surfaced with the tool name and an actionable message.
- **Engine amendment (EA2):** report **real** accumulated usage on a failed turn. The usage source is the
  turn-core tracker; EA2 adds a `usage` field to `AgentTurnError` (a new public surface) which the catch
  then emits. Touch **only** the two locations where a provider actually engaged (the `AgentTurnError`
  and unclassified branches in `agent-session.ts`; the unclassified branch still re-raises); the turn-cap
  and budget-pause branches are zero **by design** and must not be changed.
- Filter the model-advertised tool set by the wired capabilities (advertise-filter): an unwired tool
  is never offered, so the model cannot call it and the designed "say so plainly" path applies.

**Acceptance:** one shared factory feeds both paths; the built-in agent's `read_file` works in a TTY
chat; an unwired tool is not advertised; a capability gap surfaces as a named, actionable
`tool_unavailable` (never `internal`); a failed turn reports real usage; an MCP-plus-`fs` run keeps
both arms (merge, not replace). A security review of the host capability seam passes. **Required ADR:
host-capability seam.**

### 2.5.B — Bare-invocation Home (single ink tree, HomeStore, bracketed paste) — ✅ **Done (PR #61, 2026-06-29)**

> **Status:** ✅ **Done (PR #61, 2026-06-29)**, behind
> [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) (Accepted). Shipped: the bare-invocation
> TTY gate in `run.ts` (`shouldOpenHome` = `stdoutIsTty && stdinIsTty && !json && !isCiEnv`, the help + exit-`0`
> meta-op preserved byte-for-byte on every non-interactive path); the bounded, **indexed** `history.db` read seam +
> the `HomeStore` aggregator (the "Attention required" gates/failed section above the "Continue" recency lists,
> status-based exclusion, the §2.I partial-index performance debt discharged here); the **single ink tree**
> (`RootApp` over a `home|loading|chat` mode machine, the session lifecycle extracted to a unit-tested
> `HomeController`, the deferred `buildChatSession` with a loading state + build-failure recovery); **one
> SIGINT/SIGTERM lifecycle** (clean Home exit `0`; an external signal → `128+signo` 130/143 with bounded MCP
> teardown; the in-Home chat's exit-`4` consumed by the loop); **bracketed paste** (DECSET 2004, the marker
> handling + the Ctrl-C escape + the editable-buffer gate); the first-user-message session title; and the
> `docs/reference/cli/home.md` canonical contract. Each step landed through an opus + sonnet review loop, and
> PR #61 merged 2026-06-29. The richer slash palette / `@`-mention / mode keymap remain forthcoming
> (2.5.C / 2.5.E).

Today the bare invocation prints help and exits `0` (`apps/cli/src/run.ts`); `commander` deliberately
has no default action (`apps/cli/src/program.ts`). This workstream adds a branded Home at that one
extension point — a read-only management strip (recent sessions / runs / agents over the durable
`history.db`) above a live prompt, where typing drops straight into chat.

**Tasks:**

- Gate the bare-invocation branch in `run.ts`: open the Home only when `stdoutIsTty && stdinIsTty &&
  global.json !== true && !isCiEnv(io.env)`; otherwise keep `helpInformation()` + exit `0`. Use the
  **existing** `isCiEnv` helper (`apps/cli/src/process/output-mode.ts`, which treats any non-empty `CI`
  other than `false`/`0` as CI — not a bare `env.CI !== 'true'` that would miss `CI=1`) and the **existing**
  `stdinIsTty` field on the `io` seam (`apps/cli/src/process/io.ts` — already wired for the `create`
  wizard), so this adds only a TTY-gate branch, no new IO surface. Do **not** add a `commander` default
  action.
- Render Home and Chat as **one ink tree with conditional rendering** (a single `useInput` owner) —
  not two mounted apps — so the raw-mode owner never conflicts; trigger the async `buildChatSession`
  **after** the ink mount with an explicit loading state, and route a build failure back to Home.
- Add a `HomeStore` that reads the durable `history.db` (recent sessions/runs/agents) with an
  "Attention required" section (pending gates / failed runs first, most-recent within a group) above the
  neutral "Continue" list; below **80×24**, degrade by rendering a single "Terminal too small (WxH) —
  resize to at least 80×24" message and suspending the Home render until a terminal **resize** arrives —
  listen on `process.stdout`'s cross-platform `'resize'` event (backed by `SIGWINCH` on POSIX) rather than a
  bare `SIGWINCH` binding, which is unreliable on Windows — never a broken/garbled TUI. The `history.db` aggregation must stay fast at scale (see the 2.5.I performance
  budget) — index the read query, do not full-scan.
- **Author `docs/reference/cli/home.md`** as the canonical contract for the Home surface — an exit-criterion
  deliverable, not a parenthetical: the TTY/CI gate, the command/slash taxonomy + manifest shape, `@`-mention
  semantics, the mode keymap, the footer hint-bar layout, and the min-terminal-size degrade.
- Wire a single signal lifecycle (SIGINT/SIGTERM) covering Home, the in-Home chat, and MCP teardown
  (`closeMcp`): a **clean** Home exit (e.g. `/exit`) returns `0`, while a **signal-driven** termination runs
  teardown then exits with the conventional `128+signo` (`130` SIGINT / `143` SIGTERM) so shell pipelines
  can still detect the interruption; a chat's exit-code-`4` is consumed by the Home loop, never leaked.
- Add **bracketed paste** (DECSET 2004) to the chat input so a pasted multi-line block is taken
  literally instead of submitting early.
- Derive a session title from the first user message (first ~40 chars) so the Home list is readable
  (an LLM-summarised title is Phase 3).

**Acceptance:** `relavium` in a TTY opens Home; `--json` / piped / CI (`CI=true` **and** `CI=1`) keep help
+ exit `0`; Home → chat → Home transitions never corrupt the terminal; a slow/failed `buildChatSession`
shows a loading state and recovers to Home; pasting a multi-line YAML block produces one message; below
80×24 a resize prompt shows instead of a broken TUI; `docs/reference/cli/home.md` is published. **Required
ADR: bare-invocation interactive-entry contract.**

### 2.5.C — In-app slash registry, command palette, `/help`, `/doctor`, `/workflows`

> **Status:** ✅ **Done (PR #62, 2026-06-30).**
> [ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md) is **Accepted (2026-06-29)**;
> the command-manifest + in-REPL-slash contracts are canonically homed in
> [commands.md](../../reference/cli/commands.md) and [chat-session.md](../../reference/cli/chat-session.md).
> Delivered across S1–S6, each behind the per-step **opus + sonnet** review loop, with a **dedicated adversarial
> security pass** on the security-sensitive S5 (`/doctor --deep`), then a comprehensive multi-dimensional
> first-class review of the whole PR. **Decided design:** the `/` palette is the discovery entry point in **both
> Home and chat** — a curated **two-registry** model (the shell `COMMAND_MANIFEST` vs the in-REPL `REPL_COMMANDS`;
> no command in both, so no cross-surface divergence).
>
> **Per-step ledger** (branch `development`):
> - **S1** the command manifest (drift-guarded against the commander tree) · **S2** the shared `executeCommand`
>   dispatch table · **S3** the curated `REPL_COMMANDS` registry + `/help` + the filterable `/` palette (chat **and**
>   Home, one ink tree, a single `useInput` owner) · **S4** the `notice` output channel + `/workflows` + `/cost`.
> - **S5** `/doctor` (fast + `--deep`, **both** surfaces) + the slash `name + args` dispatch upgrade + a new Home
>   output surface. The dedicated security pass found a **HIGH, exploitable** issue — `/doctor --deep` connected
>   *every* config `[[mcp_servers]]` registration (an arbitrary-spawn primitive from an imported `project.toml`),
>   and could orphan a child on a timeout+exit window — and drove a root-cause redesign: the `--deep` MCP tier is
>   now **read-only**, reporting the live session's already-connected status, never a fresh connect/spawn.
> - **S6** the context-aware footer hint-bar surfacing `/ for commands` at an empty prompt. **`/shortcuts` was
>   dropped** — its discoverability intent is folded into the footer + the palette's own nav hints (the palette
>   IS the interactive command reference), avoiding a redundant static-reference command.

**Two** purpose-built, canonical, **alias-free** registries (the [ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md)
amendment — avoiding the 40–100-command sprawl of other agent CLIs; no command appears in both): a **shell**
`COMMAND_MANIFEST` behind `commander` + the `executeCommand` dispatch table + `relavium --help --json`, and a
**curated in-REPL** `REPL_COMMANDS` behind the `/` palette + the slash commands.

**Tasks:**

- Extract the per-command wiring currently inside the `register*` bodies (`apps/cli/src/commands/specs.ts`)
  into a shared `executeCommand` dispatch table that a `commander` action and a `--help --json` consumer call.
- Implement a filterable `/` palette + the curated in-REPL slash registry (`REPL_COMMANDS`) for Home/chat
  (canonically homed in `docs/reference/cli/commands.md`). The **shell** command manifest
  (`{ id, label, description, args?, effect, modeScope? }`, [ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md))
  is the single source for `commander`, the `executeCommand` dispatch, and `relavium --help --json`; the palette,
  `/help`, and the unknown-slash hint derive from `REPL_COMMANDS` — NOT the manifest (no cross-surface divergence).
- `/doctor` — a staged health check (fast: keychain / config / wired tool capabilities; `--deep`:
  provider-key validation + the live session's MCP status). **Security note:** the `--deep` MCP tier is
  **read-only** — it reports the bound agent's already-connected servers, it does NOT connect/spawn (a
  security-review decision — re-connecting would spawn unreferenced registrations from an imported config).
- `/workflows` — the disk-discovery catalog (`apps/cli/src/workflows/catalog.ts`); `/help` — the
  palette; an unknown slash (or an undeclared arg on a known command) prints a sanitized, secret-free hint.
- **Discoverability:** a context-aware footer hint-bar surfacing `/ for commands` at an empty prompt (where
  `/` opens the palette) and the palette's own nav hints (`↑/↓ · Enter · Esc`). **`/shortcuts` was dropped** —
  the footer + palette cover keymap discoverability in context, so a separate static-reference command is
  redundant. `/cost` — the session-cumulative spend (`effect: read`; the per-model breakdown is 2.6.C).

**Acceptance:** every existing subcommand also reachable through the palette/slash with no behaviour
change; `/doctor` reports the real health (and would have explained the original root-cause symptom);
`/workflows` lists discovered workflows; the footer hint-bar + the palette's nav hints make the keymap
discoverable (no separate `/shortcuts`); the palette filters; an unknown slash / undeclared arg is safe;
`/doctor --deep` never connects/spawns an unreferenced MCP server. **Required ADR: in-app slash command
system + command manifest (ADR-0056).**

### 2.5.D — Chat input ergonomics — ✅ **Done (PR #64, 2026-07-03)**

> **Status:** ✅ **Done (PR #64, merged 2026-07-03)** across both interactive surfaces (`relavium chat` + the 2.5.B
> Home). The two data-moving affordances (`@`/`!`) are behind
> [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md) (**Accepted** after a
> two-round maintainer security review + the mandatory adversarial security pass folded into the step-4/5 opus +
> sonnet review loops). A post-implementation comprehensive review then **refined the `@`/`!` presentation to a
> pending-attachment (chip) model** — the accepted file / command output is queued as a compact chip (an inline
> `@path` marker for a file; a read-only preview for a command) and expanded into the SAME UNTRUSTED nonce-fenced
> frame only at submit, so the model receives byte-identical context while the prompt stays clean (ADR-0061
> "Refined at implementation" append). Two further review passes hardened the `[chat]` allowlist resolution (the
> exact + glob arrays are now a **coupled unit** — a project setting either owns the whole allowlist) and fixed a
> Backspace regression (ink reports the Unix physical Backspace as `key.delete`). Shipped:
>
> - **Ergonomics (no security surface):** `Ctrl+J` newline + multi-line render, `↑/↓` history + `Ctrl+R`
>   reverse-search, readline cursor/word/line motions — a shared `reduceEditorMotion` + a cursor-bearing
>   `EditorState` across both surfaces (one raw-mode owner preserved).
> - **`@`-mention:** dir-navigable file completion (a `..` ascend row + backspace-to-parent) that reads through
>   the **same** `FsCapability` `read_file` uses (jail + the sensitive-read confidentiality floor, expanded to
>   `.env*`/`.aws`/`.docker`/`.envrc`/`.dockercfg` + `.env/` as a dir; the listing-gate; binary/size guards). The
>   accepted file becomes a compact `@path`-marker **chip**; at submit it expands into **UNTRUSTED, nonce-fenced,
>   byte+line-bounded** context (only while its marker survives). The `.gitignore`/`.relaviumignore` advisory trim
>   ships as a fixed `NOISE_DIRS` set (the matcher is a deferred follow-up).
> - **`!`-shell:** the additive **`AgentSession.runUserCommand`** (the documented engine exception below) routes a
>   `!command` through the **one** `run_command` boundary — `enforcePolicy([chat].allowed_commands)` **before** the
>   mode-aware `confirmAction` → `spawn`/`shell:false`. **Empty-default allowlist ⇒ `!` inert** (secure-by-default;
>   the reversal of an earlier curated-default, per the maintainer security review); a non-allowlisted `!cmd` gets
>   an actionable, secret-free hint. Output is shown read-only and rides the next message as a **chip** carrying
>   UNTRUSTED, doubly-bounded context. `@`/`!` are TTY-only.
>
> **Documented engine exception:** the "no engine/seam change" acceptance line below is amended by ADR-0061 —
> `AgentSession.runUserCommand` is one additive, pure method reusing `#runTurn`'s dispatch-context construction
> verbatim (no platform import, no vendor type; the `LLMProvider` seam + engine purity hold).

Originally scoped as REPL-only with no engine/seam change; the `!`-shell's `runUserCommand` is the ADR-0061
exception (above). `Ctrl+J` newline (canonical; `Shift+Enter` optional, never relied on); `↑/↓` history +
`Ctrl+R` reverse search; readline cursor/word motions; `@`-mention to inject file context explicitly; `!`-shell
bounded by `[chat].allowed_commands` (off in ask/plan, gated in accept-edits). **Esc per-turn abort is NOT here**
— it requires an engine state and lives in 2.5.E (EA7).

**Acceptance:** multi-line input, history recall/search, and `@`/`!` work; the raw-mode owner is
preserved; the only engine change is the ADR-0061-sanctioned `runUserCommand`.

### 2.5.E — Chat modes (reseat-less) + per-tool approval + mid-turn abort — ✅ **Done (PR #63, 2026-07-03)**

> **Status:** ✅ **Done (PR #63, 2026-07-03)** (behind
> [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md), **Accepted** after the
> mandatory security review). Shipped: the full reseat-less mode system (ask / plan / accept-edits / auto on
> the `Shift+Tab` cycle + `/mode`), per-tool approval (the fail-closed `confirmAction` floor — `[y]/[a]/[n]`
> with a session once/always cache), mid-turn `Esc` abort (EA7), and the host capability arms that close the
> 2.5.A deferral — a write-capable `fs` tier + **protected paths** (`.git/`/`.relavium/`/`.ssh/` + shell-rc,
> refused in EVERY mode incl. `auto`, Win32-fold / NTFS-ADS / 8.3 / symlink hardened), the SSRF-hardened
> `egress` arm (one shared connect-by-validated-IP mechanism with media; Host-header-strip), and the `os` arm
> (`read_clipboard`/`notify`) — **now a governed action class** so the clipboard exfiltration sink rides the
> approval floor. Wired LIVE into `relavium chat`, the one-shot `agent run`, and the 2.5.B Home (each activates
> the regime before its first turn — no path runs a governed action ungated). Engine amendments EA3/EA4/EA5/EA7
> landed. A post-review chat-UX follow-up landed in the same PR: a host tool EXECUTION failure on the interactive
> surface (a file-not-found READ) is now fed back to the model to recover (`AgentTurnLimits.recoverToolFailures`,
> scoped to IDEMPOTENT tools via a stamped `ToolExecutionError.recoverable`) while a governed / side-effecting
> failure stays fail-fast, plus a static secret-free `tool_failed` hint in the chat turn summary. Each step went
> through the mandated loop (opus + Sonnet 5 adversarial review, ~50 findings fixed incl. 4 HIGH security bugs)
> plus the dedicated holistic security review (the Accept gate). **Deferred follow-ups**
> ([../deferred-tasks.md](../deferred-tasks.md)): the `[c]` reject-with-typed-reason prompt, a plain/non-TTY
> non-interactive approval policy, a live `web_search`/http egress credential resolver, and the session-level
> budget pause/resume (rides the EA4 machine).

The capability workstream. Claude-Code-style modes — but a mode is a **policy layer on the same
session instance**, not a reseat: the `ToolHost` is bound full-capability for the session lifetime,
and the mode controls only (a) the model-advertised tool subset (a per-turn `buildLlmTools` filter)
and (b) the per-dispatch approval policy. This is lossless (no tool-context loss), cheap (no new
instance), and two-layer safe: the advertise-filter (best-effort) plus the **fail-closed `confirmAction`
approval policy** (authoritative — `enforcePolicy` is mode-agnostic and inert for `write_file`).

**Tasks:**

- Add a mutable `#mode` to `AgentSession`, snapshotted per turn; the four modes
  (ask / plan / accept-edits / auto) map to an advertised-tool subset + an approval policy.
  `Shift+Tab` cycles **`ask → plan → accept-edits → auto`** (auto-approve is a mainstream expectation, so
  it is reachable in the cycle, not hidden behind a typed command); `/mode <name>` jumps directly. The
  **default is read-only `ask`**, the active mode is **always shown in the footer**, and there is **no
  hidden "bypass all permissions" valve**: no mode (auto included) writes a protected path or escapes the
  fs jail ([ADR-0029](../../decisions/0029-tool-policy-hardening.md) secure-by-default).
- **Protected paths:** `.git/`, `.relavium/`, shell rc files are never auto-written in any mode — in
  `auto` a protected-path write falls back to an explicit prompt rather than auto-approving.
- **Host arms (closes the 2.5.A deferral):** the write-capable `fs` tier, the SSRF-hardened `egress` arm,
  and the `os` arm are wired in the CLI host this workstream — reusing the existing connect-by-validated-IP
  media-egress mechanism ([ADR-0043](../../decisions/0043-media-egress-failover-rematerialization-ssrf.md))
  over the one shared `isPrivateOrLocalHost` range-block (extracted so tool + media egress share one
  implementation, never a second SSRF parser). `egress` is a governed class and always rides the
  fail-closed `confirmAction` floor. A **dedicated adversarial security review** covers the fs-write jail +
  protected paths, the egress mechanism, and the `os` arm.
- **Per-tool approval (new vertical — not the workflow gate), fail-closed:** a registry pre-dispatch hook
  (**EA3** — `confirmAction?`, host-injected like `ToolHost` so the engine boundary (ADR-0037) holds; runs
  between the `enforcePolicy` check and the side-effect in `packages/core/src/tools/registry.ts`). **Note:**
  `enforcePolicy` is **inert for `write_file`** (its `FS_POLICY` has `requiresGateApproval:false` and no
  command/domain allowlist applies), so `confirmAction` is the **authoritative** mode gate and must be
  **fail-closed** — when a write/process/egress arm is wired, a write-/exec-/egress-class dispatch **requires**
  a decision; **absent hook ⇒ deny** (so an advertise-filter or wiring bug can never let `ask` mode write).
  Plus: an `agent:approval_requested` event (**EA5**), an `AgentSession` pause/resume state (**EA4**), a REPL
  `[y]`/`[a]`/`[n]`/`[esc]` intercept (approve-once / always / reject / abort; `[c]` reject-with-reason
  deferred) that bypasses the in-flight key-swallow gate (no deadlock), a
  typed `ToolDeniedByUserError` (the existing `tool_denied` `ErrorCode`, already non-retryable), and a
  session-scoped, **in-memory** once/always cache (not persisted across resume; **once** = this invocation
  (tool+args), **always** = this tool id for this session instance). The existing `gateApproved` flag is a
  one-way static deny and is **not** reused.
- **Mid-turn abort (EA7):** an `Esc` that aborts the in-flight turn but keeps the session alive (today
  `cancel()` is terminal). It emits **one** `session:turn_completed` (abort stop-reason), rolls back the
  pending user message, and returns `#status` to `idle` — there is **no** new `aborted` status and it is
  **not** `cancel()`/`session:cancelled` (which kills the session). Shares the EA4 pause/resume + `AbortSignal`
  machinery; the session-level budget pause/resume deferred from Phase 2 rides the same machine.

**Acceptance:** `Shift+Tab` switches modes instantly with **no** tool-context loss; ask mode advertises
read-only tools; accept-edits prompts before each write with `[y]/[a]/[n]` and an once/always memory;
a rejection is a clean `tool_denied`, not a retry; `Esc` aborts a turn and the session continues; auto
is sandbox-bounded with protected paths honoured. A security review of the reseat-less mode model
(defense-in-depth trade-off) passes. **Required ADR: per-tool approval + reseat-less chat mode system
(incl. mid-turn abort).**

### 2.5.F — `/clear`, `/trim`, and `/compact` (context compaction) — ✅ **Done (PR #65, merged 2026-07-05)**

> **Scope expanded (2026-07-04, [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)).**
> The maintainer removed the Phase-3 deferral of `/compact`: we build the **full** context-compaction
> story now — a model-summarised **engine primitive** (`AgentSession.compact()`), plus **automatic**
> threshold-triggered compaction — not merely the deterministic commands. The earlier
> "recognized-but-deferred `/compact` stub" plan is superseded by ADR-0062.

`/clear` starts a new conversation (the old session stays persisted and resumable). `/trim` is a
**deterministic** history trim (`/trim [n]`, default `[chat].max_messages`) that finally consumes the
dead `max_messages` config field (`packages/shared/src/config.ts` — plumbed but never read); it is also
the zero-cost fallback if a summarization fails. `/compact` is **model-summarised** compaction: the
summary becomes a session-level system-prompt preamble, the last exchange stays verbatim, and an
**append-only** boundary marker (no destructive delete; resume-preserving; reseat-safe) records it. The
same primitive runs **automatically** past `[chat].compact_threshold` of the serving model's context
window (`[chat].auto_compact`, default on). Every summarization token is accounted to the session budget
and surfaced. Delivered in three reviewed steps (shared/seam/db foundations → engine primitive → CLI
host + docs), each with an Opus + Sonnet review round.

**Acceptance:** `/clear` opens a fresh session, the prior one resumable; `/trim` bounds history by
`max_messages`/`n` with no LLM call; `max_messages` is no longer dead; `/compact` summarises the working
context (append-only, resume-preserving, cost-accounted); auto-compaction bounds a long chat before it
overflows the context window; the summary is inspectable and the moment is a designed state.

> **Landed & merged (PR #65 for ADR-0062, three reviewed steps — shared/seam/db, engine primitive, CLI host —
> each with an Opus + Sonnet review round):** the compaction engine primitive, automatic compaction, append-only
> resume/reseat-preserving persistence, `/compact`, and `/trim [n]` are **complete**. The final 2.5.F items then
> landed: **`/clear`** — the fresh-session lifecycle swap (ADR-0062 §7) across `relavium chat`,
> `chat-resume`, and the in-Home chat: a host-level re-drive (standalone) / build-first `clearChat` (Home) that ends
> the current session (persisted + resumable) and rebinds the same agent under a new `sessionId`, TTY-interactive-only
> (rejected under `--json`/plain), zero engine change; and the two compaction-moment UX polishes — the **labeled**
> "Summarizing…" spinner off a new additive `session:compacting` engine event (amends ADR-0036's event substrate) and
> the footer **context-fullness** indicator (last input ÷ the model's context window, via the new pure
> `@relavium/llm` `contextWindowForModel` helper). **With these 2.5.F is ✅ Done (PR #65, merged 2026-07-05); the
> merged PR also carried a parallel Opus + Sonnet review round — the compacting-latch spinner fix, the 0%-ctx
> footer guard, the Home double-clear MCP-leak guard, best-effort auto-compaction, and the shared adapter
> `CONTEXT_SEAM_DEFAULTS`.**

### 2.5.G — Onboarding wizard and `/models` (Home model catalog)

**Tasks:** a `@clack` first-run wizard from the key-less Home (provider → **hidden** stdin key →
keychain, with a write-failure fallback and an env-key import offer) — reusing the two existing
ink↔clack custody patterns (the gate prompter and the 2.J create wizard); a shared `modelCatalog`
helper deriving available models from the `@relavium/llm` pricing registry filtered to
connected providers, with a staleness/deprecation guard; `/models` in Home sets the next session's
model (writing `[chat].default_model`); `provider list` shows verification state; the `[chat].max_turns`
surface wiring deferred from Phase 2 lands here.

**Acceptance:** a key-less first run reaches a working chat via the wizard (key in the keychain, never
on disk); `/models` lists connected-provider models and sets the default; a deprecated catalog entry is
flagged. (Mid-chat model switch via reseat is Phase 2.6.)

### 2.5.H — Reasoning rendering and live-turn feedback

The `@relavium/llm` seam already carries reasoning chunks (`StreamChunk` reasoning deltas, folded in
`packages/core/src/engine/agent-turn.ts`); the gap is purely the host-emit + TUI render. Additive.

**Tasks:** **engine amendment (EA6):** emit reasoning over a new `agent:reasoning` event (today `foldChunk`
emits `agent:token` on a `text_delta` chunk and only **accumulates** reasoning deltas with no event of
their own) — the `@relavium/llm` seam is untouched (it already carries the reasoning chunks); EA6 is a new
event in the shared event union (canonical home [sse-event-schema.md](../../reference/contracts/sse-event-schema.md),
amending the [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) event
substrate — **not** ADR-0030, which is the seam shape). Plus a collapsible "thinking" panel in the
TUI (default collapsed, toggle); live-turn latency feedback ("thinking… {elapsed}s · Esc to stop",
the turn-start timestamp already exists in the view-model); a visible elision marker when the live
buffer truncates (today a silent loss); per-attempt model attribution for the token line (the Phase-2
follow-up) lands with EA2's accuracy surface.
- **Actionable error taxonomy:** extend the error surface beyond the capability gap (2.5.A). Two classes
  the engine **already** marks retryable in `RETRYABLE_ERROR_CODES` (`@relavium/shared/constants.ts`) but
  the chat renders opaquely — `provider_rate_limit` (`429` → backoff + visible failover) and
  `provider_unavailable` (→ visible failover); plus three classes the engine does **not** map as retryable
  and the chat must surface actionably — context-overflow (a `bad_request`/fatal → suggest `/trim` or
  `/compact`; note 2.5.F auto-compaction (ADR-0062) now **pre-empts** most context-overflows, so this hint
  is the secondary net for a model with no known window or `auto_compact = false`),
  keychain-locked mid-session, and MCP-server timeout. Each renders a one-line recovery hint and makes
  explicit that **the session survives** (the "say so plainly" philosophy, extended from tools to
  transport/quota).

**Acceptance:** reasoning is visible and toggleable; the user sees elapsed time and the abort hint;
truncation is visible; each operational error class renders an actionable recovery hint with the session
intact; the seam is not modified.

### 2.5.I — Regression harness and concurrency hardening

**Tasks:** extend the regression harness ([regression-harness.md](../../reference/cli/regression-harness.md))
to cover `Home → chat → resume → export` with an agent/chat replay cassette (the recorded-LLM replay
infrastructure is the prerequisite, and the deferred multimodal conformance fixtures reuse the same
mechanism); a concurrent-writer e2e (`relavium chat` + `relavium run` against the shared `history.db`),
evaluating `BEGIN IMMEDIATE` + `SQLITE_BUSY` retry (WAL + `busy_timeout` already exist) and wrapping
`loadFull` in a single read transaction (torn-read guard); cross-platform ink/raw-mode verification on
Windows.

- **Performance budgets:** assert measurable targets so "first-class" is verifiable — Home cold-open
  ≤ a defined budget at 1000 sessions (the indexed `history.db` query, not a full scan), a first-token
  latency feedback within the live-turn render, and the 80×24 minimum-terminal-size degrade. Capture them
  as harness checks, not prose.

**Acceptance:** the new e2e chain is green in CI; a concurrent chat+run does not corrupt history; the
performance budgets (Home cold-open at 1000 sessions; 80×24 minimum) hold; the harness gates the
backward-compatibility exit criterion.

### 2.5.J — Documentation reconciliation and dead-code cleanup

**Tasks:** correct the surface-blind "encrypted history" wording (`docs/uvp.md`, `docs/vision.md`,
`docs/tutorials/cli/start-a-chat-session.md`) to the accurate CLI posture — **unencrypted**, protected
by `0700`/`0600` + keychain (no credentials at rest), per
[ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md) (the canonical references are already
correct); reconcile the roadmap status surfaces (`docs/roadmap/current.md`,
[phase-2-cli.md](phase-2-cli.md), [CLAUDE.md](../../../CLAUDE.md)) now that **2.R and 2.J have both
landed**, and complete the central roadmap narrative for 2.5/2.6 ([../README.md](../README.md) — the phase
index and the dependency graph already include them; reconcile the milestone-spine prose); handle the
`NO_COLOR` / `FORCE_COLOR` env standards (today only the `--no-color` flag is honoured).

**Acceptance:** no tracked doc claims the CLI `history.db` is encrypted; the roadmap reflects the landed
state; `NO_COLOR` is honoured.

## Milestones

| In-phase | Completed by | Outcome |
|----------|--------------|---------|
| M2.5-1 Secure base ✅ **(PR #60, 2026-06-28)** | 2.5.A | Root-cause closed (capability gap + merge asymmetry); host seam reviewed |
| M2.5-2 Home + entry + onboarding | 2.5.B + 2.5.C + 2.5.D + 2.5.F + 2.5.G | First-class entry + ergonomics + onboarding |
| M2.5-3 Modes + observability | 2.5.E + 2.5.H | Safe reseat-less mode system + per-tool approval + reasoning |
| M2.5-4 Consolidation | 2.5.I + 2.5.J | Harness + concurrency + docs-debt |

## Sequencing & parallelization

**2.5.A is absolute-first** — without the wired tool-environment the Home re-creates the same root-cause
("inspect this doc" → fails). Then two parallel arms: (i) experience: 2.5.B → 2.5.C → 2.5.D / 2.5.F /
2.5.G; (ii) capability: 2.5.E. The additive lanes (2.5.H / I / J) are not on the spine and run in
parallel at any point.

## Dependencies

- **Phase 2** complete (chat REPL, history, providers, MCP, the 2.J authoring core that 2.5.A's tool
  host and Phase 2.6 build on).
- The pure engine amendments EA1–EA7 are filed back against `@relavium/core` / `@relavium/shared` as
  Phase-1 amendments, each behind the ADR mapped in the [Engine amendments appendix](#engine-amendments-appendix-ea1ea7)
  (EA1/EA2 → ADR-0055; EA3/EA4/EA5/EA7 → ADR-0057; EA6 amends ADR-0036); the engine architecture and the
  platform boundary are unchanged.

## Exit criteria (go / no-go → Phase 2.6)

1. `relavium` opens Home in a TTY; the `--json` / CI / non-TTY backward-compatibility is proven by the
   extended regression harness.
2. The capability-gap root cause is closed (`tool_unavailable`, real usage, advertise-filter, merge
   asymmetry); the host-capability and mode-system security reviews pass.
3. All existing subcommands and the `--json` contract ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md))
   are unbroken.
4. Modes, per-tool approval, mid-turn abort, reasoning rendering, onboarding, and `/models` (Home) ship;
   the docs-debt is closed.
5. The required ADRs are Accepted; `docs/reference/cli/home.md` is the canonical Home reference.

## Required ADRs

Drafted as **Proposed** alongside this plan; each is reviewed and finalized (→ Accepted) when its
workstream begins.

1. [ADR-0054](../../decisions/0054-cli-bare-invocation-interactive-home.md) — bare-invocation interactive
   Home (TTY only), preserving the meta-op contract (2.5.B).
2. [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md) — shared
   tool-environment factory (`ToolHost` / `ToolPolicy` / ctx as separate channels); a new security surface
   (2.5.A).
3. [ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md) — in-app slash command
   system + command manifest (2.5.C).
4. [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md) — reseat-less chat modes +
   per-tool approval + mid-turn abort (2.5.E).
5. [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md) — CLI input-layer
   file-injection (`@`-mention) + shell-escape (`!`-shell) security model (2.5.D); the pure-ergonomics half
   (`Ctrl+J` / history / `Ctrl+R` / motions) needs no ADR. **Accepted** (after a two-round maintainer security
   review; the mandatory adversarial security pass ran inside the step-4/5 review loops). Adds the one documented
   engine exception, `AgentSession.runUserCommand` (EA8, appendix below).

EA6 (the new `agent:reasoning` event) is an additive event in the shared event union; it does not need a new
top-level ADR — it **amends** [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)
(the event substrate) with a dated note and updates
[sse-event-schema.md](../../reference/contracts/sse-event-schema.md) when 2.5.H lands.

## Engine amendments appendix (EA1–EA8)

Each amendment is pure and platform-free (the engine architecture and the `LLMProvider` seam are unchanged);
each ships behind the ADR below and updates its canonical-home spec + the drift-pin test where it touches a
shared contract.

| EA | What | Where | ADR / canonical home |
|----|------|-------|----------------------|
| EA1 | `tool_unavailable` portable `ErrorCode` + `codeForToolError` remap (was `→ internal`) | `@relavium/shared/constants.ts` (`ERROR_CODES`) + `agent-turn.ts` | ADR-0055; `sse-event-schema.md` (error code) + drift-pin |
| EA2 | real usage on a failed turn — `usage` field on `AgentTurnError`, emitted (only the provider-engaged branches) | `agent-turn.ts` + `agent-session.ts` | ADR-0055 |
| EA3 | pre-dispatch, **fail-closed** `confirmAction` hook (host-injected, ADR-0037-clean) | `tools/registry.ts` + `tools/types.ts` (`ToolDispatchContext`) | ADR-0057 |
| EA4 | `AgentSession` pause/resume state (also carries EA7 + the deferred budget pause) | `agent-session.ts` | ADR-0057; `agent-session-spec.md` |
| EA5 | `agent:approval_requested` stream event (in the `agent:*` namespace) | shared event union | ADR-0057; `sse-event-schema.md` + drift-pin |
| EA6 | `agent:reasoning` stream event (host-emit; seam already carries reasoning) | `agent-turn.ts` + shared event union | **amends ADR-0036**; `sse-event-schema.md` + drift-pin |
| EA7 | mid-turn abort (`Esc` → one `session:turn_completed`/abort → `idle`; no new status) | `agent-session.ts` | ADR-0057; `agent-session-spec.md` |
| EA8 | `AgentSession.runUserCommand` — the user `!`-shell escape through the one `run_command` boundary (reuses `#runTurn`'s dispatch context verbatim; the documented 2.5.D engine exception) | `agent-session.ts` (`#buildDispatchContext` + `runUserCommand` + `UserCommandOutcome`) | ADR-0061; `agent-session-spec.md` |

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| 2.5.A skipped → Home is an empty promise | Spine strict; until then Home shows a read-only badge and `/tools`/`/doctor` stay honest |
| Scope drifts toward an IDE (Home + agent panel) | Home is management + chat only; **no** file tree / editor / terminal; the strip is read-only ([ADR-0007](../../decisions/0007-desktop-is-not-an-ide.md) boundary) |
| Engine-purity leak | All Home/ink/palette code stays in `apps/cli`; Home is a consumer of existing seams; engine amendments are pure ([CLAUDE.md](../../../CLAUDE.md) #5) |
| Per-tool approval scope explosion | Isolated in 2.5.E behind its own ADR; 2.5.D / F are independent of it |
| Reseat-less mode weakens defense-in-depth | `ask` keeps fs-write physically bound but advertise-filtered + guarded by the **fail-closed `confirmAction` floor** (absent hook ⇒ deny; `enforcePolicy` is inert for `write_file`) + protected-paths; called out in the mode-system ADR + security review |
| Two raw-mode owners (Home↔Chat / ink↔clack) collide | Single ink tree conditional render; clack custody handoff (existing gate pattern) |

Part of [roadmap/](../README.md). Carry-over hardening lives in [../deferred-tasks.md](../deferred-tasks.md).
