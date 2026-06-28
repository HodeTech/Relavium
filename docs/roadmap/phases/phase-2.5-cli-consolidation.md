# Phase 2.5 — CLI Consolidation and Conversational Home

> Status: In progress. **2.5.A** (shared tool-environment factory + capability-gap root-cause fix) is
> ✅ **Done (PR #60, 2026-06-28)**, behind [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)
> — **milestone M2.5-1 (secure base) reached**. Spine continues: **2.5.B** (Home, next) → 2.5.C (slash) →
> 2.5.E (modes + per-tool approval). Experience arm (off the spine, depends on B/C): 2.5.D / F / G. Additive
> lanes (no dependency chain): 2.5.H / I / J.

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
- `/compact` model-summarised compaction (the engine has no summarisation primitive — Phase 2.5 ships
  only deterministic `/trim`), `read_media` input (D12), full-fidelity reseat tool-context, in-app
  scrollback/pager, a **type-ahead message queue while a turn runs** (the in-flight key-swallow is handled
  for approval input in 2.5.E, but queuing the *next* message is deferred), live provider `/v1/models`
  fetch, and a multi-pane dashboard — Phase 3 / later (tracked in [../deferred-tasks.md](../deferred-tasks.md)).

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

### 2.5.B — Bare-invocation Home (single ink tree, HomeStore, bracketed paste)

Today the bare invocation prints help and exits `0` (`apps/cli/src/run.ts`); `commander` deliberately
has no default action (`apps/cli/src/program.ts`). This workstream adds a branded Home at that one
extension point — a read-only management strip (recent sessions / runs / agents over the durable
`history.db`) above a live prompt, where typing drops straight into chat.

**Tasks:**

- Gate the bare-invocation branch in `run.ts`: open the Home only when `stdoutIsTty && stdinIsTty &&
  global.json !== true && !isCiEnv(io.env)`; otherwise keep `helpInformation()` + exit `0`. Use the
  **existing** `isCiEnv` helper (`apps/cli/src/process/output-mode.ts`, which already treats `CI=1`/any
  truthy `CI` as CI — not a bare `env.CI !== 'true'` that would miss `CI=1`) and the **existing**
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

A single shared dispatch table behind `commander`, the palette, and the in-REPL slash commands — a
small, canonical, **alias-free** set (avoiding the 40–100-command sprawl of other agent CLIs).

**Tasks:**

- Extract the per-command wiring currently inside the `register*` bodies (`apps/cli/src/commands/specs.ts`)
  into a shared dispatch module a `commander` action, the palette, and a slash command all call.
- Implement a filterable `/` palette and the Home/chat slash taxonomy (canonically homed in
  `docs/reference/cli/home.md`, authored in 2.5.B); a command manifest
  (`{ id, label, canonical, effect, modeScope }`) is the single source for the palette, slash help,
  and `relavium --help --json`.
- `/doctor` — a staged health check (fast: keychain / config / wired tool capabilities; `--deep`:
  provider-key validation + MCP connectivity), rendered incrementally as each check settles.
- `/workflows` — the disk-discovery catalog (`apps/cli/src/workflows/catalog.ts`); `/help` — the
  palette; an unknown slash prints a sanitized, secret-free hint.
- **Discoverability:** a `/shortcuts` command (derived from the manifest — zero extra source) and a
  persistent footer hint-bar surfacing the 2–3 most relevant keys per context (so the mode/`@`/`!`/`Esc`
  ergonomics of 2.5.D/E are findable, not hidden); `/cost` — the session-cumulative spend (an
  `effect: read` manifest entry; the per-model breakdown is 2.6.C).

**Acceptance:** every existing subcommand also reachable through the palette/slash with no behaviour
change; `/doctor` reports the real health (and would have explained the original root-cause symptom);
`/workflows` lists discovered workflows; `/shortcuts` and the footer hint-bar make the keymap discoverable;
the palette filters; an unknown slash is safe. **Required ADR: in-app slash command system + command
manifest.**

### 2.5.D — Chat input ergonomics

Today the ink editor is single-line only, with no history or cursor movement
(`apps/cli/src/render/tui/chat-ink.tsx`). REPL-only; no engine/seam change.

**Tasks:** `Ctrl+J` newline (canonical; `Shift+Enter` optional, never relied on); `↑/↓` history +
`Ctrl+R` reverse search; readline cursor/word motions; `@`-mention (Tab-completion, `.gitignore`/
`.relavium`-respecting, binary detection, token-limit warning) to inject file context explicitly;
`!`-shell bounded by `ToolPolicy.allowedCommands` (off in ask/plan, gated in accept-edits). **Esc
per-turn abort is NOT here** — it requires an engine state and lives in 2.5.E (EA7).

**Acceptance:** multi-line input, history recall/search, and `@`/`!` work; the raw-mode owner is
preserved; zero engine/seam change.

### 2.5.E — Chat modes (reseat-less) + per-tool approval + mid-turn abort

The capability workstream. Claude-Code-style modes — but a mode is a **policy layer on the same
session instance**, not a reseat: the `ToolHost` is bound full-capability for the session lifetime,
and the mode controls only (a) the model-advertised tool subset (a per-turn `buildLlmTools` filter)
and (b) the per-dispatch approval policy. This is lossless (no tool-context loss), cheap (no new
instance), and two-layer safe: the advertise-filter (best-effort) plus the **fail-closed `confirmAction`
approval policy** (authoritative — `enforcePolicy` is mode-agnostic and inert for `write_file`).

**Tasks:**

- Add a mutable `#mode` to `AgentSession`, snapshotted per turn; the four modes
  (ask / plan / accept-edits / auto) map to an advertised-tool subset + an approval policy.
  `Shift+Tab` cycles `ask → plan → accept-edits`; `auto` is explicit-only (`/mode auto`); **no
  one-key bypass valve** ([ADR-0029](../../decisions/0029-tool-policy-hardening.md)).
- **Protected paths:** `.git/`, `.relavium/`, shell rc files are never auto-written in any mode.
- **Per-tool approval (new vertical — not the workflow gate), fail-closed:** a registry pre-dispatch hook
  (**EA3** — `confirmAction?`, host-injected like `ToolHost` so the engine boundary (ADR-0037) holds; runs
  between the `enforcePolicy` check and the side-effect in `packages/core/src/tools/registry.ts`). **Note:**
  `enforcePolicy` is **inert for `write_file`** (its `FS_POLICY` has `requiresGateApproval:false` and no
  command/domain allowlist applies), so `confirmAction` is the **authoritative** mode gate and must be
  **fail-closed** — when a write/process/egress arm is wired, a write-/exec-/egress-class dispatch **requires**
  a decision; **absent hook ⇒ deny** (so an advertise-filter or wiring bug can never let `ask` mode write).
  Plus: an `agent:approval_requested` event (**EA5**), an `AgentSession` pause/resume state (**EA4**), a REPL
  `[approve]/[reject]/[comment]` intercept that bypasses the in-flight key-swallow gate (no deadlock), a
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
read-only tools; accept-edits prompts before each write with `[a]/[r]/[c]` and an once/always memory;
a rejection is a clean `tool_denied`, not a retry; `Esc` aborts a turn and the session continues; auto
is sandbox-bounded with protected paths honoured. A security review of the reseat-less mode model
(defense-in-depth trade-off) passes. **Required ADR: per-tool approval + reseat-less chat mode system
(incl. mid-turn abort).**

### 2.5.F — `/clear` and `/trim`

`/clear` starts a new conversation (the old session stays persisted and resumable). `/trim` is a
**deterministic** history trim that finally consumes the dead `max_messages` config field
(`packages/shared/src/config.ts` — plumbed but never read). `/compact` (model-summarised) is **Phase
3** (the engine has no summarisation primitive); a no-op stub is forbidden — instead the slash registry
carries a **recognized-but-deferred** entry so `/compact` prints *"not yet available — use `/trim` for a
deterministic trim; model-summarised compaction is planned"*, distinct from the generic unknown-slash hint.

**Acceptance:** `/clear` opens a fresh session, the prior one resumable; `/trim` bounds history by
`max_messages` with no LLM call; `max_messages` is no longer dead.

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
  and the chat must surface actionably — context-overflow (a `bad_request`/fatal → suggest `/trim`),
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

EA6 (the new `agent:reasoning` event) is an additive event in the shared event union; it does not need a new
top-level ADR — it **amends** [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)
(the event substrate) with a dated note and updates
[sse-event-schema.md](../../reference/contracts/sse-event-schema.md) when 2.5.H lands.

## Engine amendments appendix (EA1–EA7)

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
