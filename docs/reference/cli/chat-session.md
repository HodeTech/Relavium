# `relavium chat` — Agent Session REPL

> Last updated: 2026-06-29

- **Status**: Reference — the whole chat family is live: the interactive REPL + `--agent`, `/exit`/`/cancel`, exit code 4, durable persistence (**2.M**); `chat-resume` (**2.N**); `chat-list` (**2.O**); `chat-export` + the in-REPL `/export` (**2.P**); `chat --json` + `agent run` (+ `--fixture`) (**2.Q**)
- **Surface**: CLI (`relavium chat`)
- **Scope**: Phase 1 design, local-first. Same `@relavium/core` engine as every other surface.
- **Related**: [commands.md](commands.md), [home.md](home.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md), [../../runbooks/add-a-provider-key.md](../../runbooks/add-a-provider-key.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0026-session-export-to-workflow.md](../../decisions/0026-session-export-to-workflow.md)

`relavium chat` is the CLI's **agent-first entry point** — a multi-turn conversational REPL with a single agent, sitting beside `relavium run` on the **same** engine. Both are entry points into `@relavium/core`: `run` drives a workflow DAG, `chat` drives an [agent session](../contracts/agent-session-spec.md), and they reuse the same `ToolRegistry`, the `@relavium/llm` seam, and the event bus (see [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)). This document is the command-surface reference for the chat REPL; it **cites** the session contract rather than restating it.

## Entry

```bash
# start a session with the default chat agent/model
relavium chat

# bind a specific agent for the whole conversation
relavium chat --agent ./agents/coder.agent.yaml
relavium chat --agent code-reviewer            # resolved inside .relavium/
```

`relavium chat` opens an `ink`-rendered interactive REPL when a TTY is attached. The session is **auto-persisted and resumable** from the moment it starts — there is no separate save step (see [agent-session-spec.md](../contracts/agent-session-spec.md#validation-and-persistence)). Resume a prior conversation with `relavium chat-resume <sessionId>` and list past sessions with `relavium chat-list` (see [commands.md](commands.md)).

The REPL renders in the default **inline** mode or the full-screen **alternate-screen** mode opted into with **`[preferences].alt_screen`** / forced off with **`--no-alt-screen`** ([ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md) §e; the resolution is shared verbatim with the [Home](home.md)). A non-TTY / `--json` path is always inline (byte-identical). At 2.6.F Step 4a the alt screen is an opt-in preview — see [config-spec.md](../contracts/config-spec.md)'s `alt_screen` caveat.

A chat also starts from the bare-invocation **Home** (2.5.B): typing a message at a bare `relavium` on a TTY graduates the Home into a chat in the **same** process — bound to the built-in default chat agent (the zero-config first run) — and returns to a freshly-read Home when the chat ends (the chat's exit code `4` is consumed by the Home loop, never leaked). The in-Home chat is the same REPL described here; see [home.md](home.md) for the Home shell, its TTY gate, and the signal/exit-code lifecycle.

## Agent and model selection

A session **binds one agent and one model for its whole lifetime** — there is no mid-session agent switching in Phase 1 ([agent-session-spec.md](../contracts/agent-session-spec.md#what-a-session-is-and-is-not)):

- `--agent <ref>` names the `.agent.yaml` (path or `.relavium/` id). If omitted, the chat-mode default applies.
- the model and `fallback_chain` come from that agent, exactly as a workflow `agent` node resolves them; the same fallback chain a workflow uses applies to a chat turn.
- when no agent names a model, the `[chat].default_model` from project config is used — the chat-mode **defaults** (`default_model`, `fs_scope`, the command allowlist, `max_turns` (the hard turn cap → `SessionDeps.maxTurns`), `max_messages`) live in the `[chat]` block of [config-spec.md](../contracts/config-spec.md), which references the workflow canonical homes rather than forking them.
- when **no** `--agent` is given, 2.M binds a **built-in default chat agent** over `[chat].default_model` (a conservative, read-only tool grant — write/exec/egress need an explicit `--agent`), so `relavium chat` is a zero-config first run.

## The multi-turn loop

Each prompt you type is one user turn; the assistant turn that follows may include tool-call round-trips before it completes, then control returns to the prompt:

1. you type a message → it is appended as a `user` [`SessionMessage`](../contracts/agent-session-spec.md#session-messages);
2. the `AgentRunner` streams the assistant turn (tokens, tool calls, tool results);
3. the assistant + any tool messages are appended; the prompt returns for your next turn.

Messages are **append-only** and persisted per turn; the loop is the same code path a workflow `agent` node uses — the difference is the entry point and lifetime, not the execution.

A small, **alias-free**, curated set of slash commands drives the REPL itself (not the agent) — the in-REPL surface of the command system ([ADR-0056](../../decisions/0056-cli-in-app-slash-command-system-and-manifest.md), 2.5.C; the curated REPL set is `apps/cli/src/commands/repl-commands.ts`, distinct from the shell command surface). The `/help` list, the unknown-slash hint, and the `/` palette all derive from that one registry, so they cannot disagree. Heavy shell commands (`run`, `chat`, `provider`, …) stay shell-only — they are not in-REPL slashes.

| Command | Effect |
| --- | --- |
| `/help` | List the available slash commands (**2.5.C**). Typing `/` at an idle prompt instead opens the interactive, filterable **`/` palette** over these commands (in both the chat and the bare Home). |
| `/exit` | End the session cleanly and quit the REPL (**exit code 4**, below). |
| `/cancel` | End the session **terminally** (aborting any in-flight turn — also entered as **Ctrl-C**). The session is **persisted and resumable** via `relavium chat-resume <sessionId>` (2.N). Exits with code 4. For a mid-turn abort that KEEPS the session alive, press **Esc** (2.5.E, below) — that is distinct from `/cancel`. |
| `/export` | Export the session-so-far to a `.relavium.yaml` scaffold (same ADR-0026 contract as `relavium chat-export`). Writes the file (named `<sessionId>.relavium.yaml`) and reports the path; under `--json` it emits a `session:exported` event on the stream. It does **not** mark the session row `exported` (a later turn's persist would clobber that) — use `relavium chat-export` for the durable provenance mark. **Live (2.P / 2.Q).** |
| `/workflows` | List the project's discovered workflows + agents (the disk catalog) as an in-view **notice** (**2.5.C S4**). A project-less cwd is reported, not an error. Chat-only today. |
| `/cost` | Show the session's cumulative spend as an in-view **notice** (**2.5.C S4**); the per-model breakdown is Phase 2.6.C. Chat-only. |
| `/mode [name]` | Switch the chat **mode** — `ask` / `plan` / `accept-edits` / `auto` (**2.5.E**, below); bare `/mode` shows the current mode + explains each. `Shift+Tab` cycles them. Chat-only. |
| `/thinking` | Show / hide the collapsible **reasoning ("thinking") panel** (**2.5.H**; also `Ctrl+T`). A pure UI-view toggle (no session/engine effect); the panel is only rendered while the model is actually streaming reasoning. Default collapsed. Chat-only. |
| `/doctor` | Run a setup health check as a **notice** (**2.5.C S5**). Fast tier: OS keychain reachable · config valid · wired tool capabilities. `--deep` adds provider-key validation (a bounded, **redacted** live ping per configured key — the key never reaches the output) + the live session's MCP status (the bound agent's connected servers + any tools the manager dropped). The `--deep` MCP tier is **read-only** — it reports the already-connected session, never a fresh connect/spawn (a security-review decision). Available in **both** the chat and the bare Home (pre-chat diagnostics); the Home palette runs the fast tier, `--deep` is typed in a chat. |
| `/compact` | **Model-summarise** the conversation so far into a compact preamble to reclaim context — an LLM call ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md), **2.5.F**; see § Context compaction below). Reports the token deltas + spend + the summary as a **notice**. Effect `write` (spends tokens). Chat-only. |
| `/trim [n]` | **Deterministically** drop older messages down to the last `n` (default `[chat].max_messages`), **no LLM call** (ADR-0062, 2.5.F). A bare `/trim` with no config bound prints an actionable notice; a bound larger than the history is a reported no-op. Chat-only. |
| `/clear` | Start a **fresh conversation** — end the current session (**persisted + resumable** via `relavium chat-resume <sessionId>`) and swap in a new one under a new `sessionId` ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §7, **2.5.F**). Effect `destructive`; the fresh session resets the mode to `ask` and the budget/turn/cost totals to zero (the old totals stay on the resumable row). Its notice names the prior session + the exact resume command. **Interactive-only** — rejected under `--json` / plain non-TTY, where one machine stream is one session lifecycle ([ADR-0049](../../decisions/0049-cli-machine-output-contract.md)). Works in `relavium chat`, `chat-resume`, and the in-Home chat (swap in place, staying in chat); in the **bare** Home (no live session) it is an honest "nothing to clear" notice. |

An unrecognized `/…` command — or an **undeclared argument** on a known one (`/exit now`) — prints a one-line, secret-free notice and the prompt returns. A command may accept flags (`/doctor --deep`) or a single positional value (`/mode plan`); the `/` palette runs the bare form, so a flag/value is opt-in by typing it. The idle footer surfaces `/ for commands` at an empty prompt (2.5.C S6). In a TTY, **Ctrl-C** is equivalent to `/cancel` (the `ink` REPL runs in raw mode, so the kernel does not raise SIGINT — the REPL handles it).

## Chat modes + per-tool approval (2.5.E, [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md))

The session's `ToolHost` is bound **full-capability** for its lifetime (fs read+write, process, egress, os); a **mode** is a policy layer on that one instance — **no reseat**, so switching never loses tool context. `Shift+Tab` cycles **`ask → plan → accept-edits → auto`** and `/mode <name>` jumps directly; the active mode is always shown in the footer. The default is read-only **`ask`**. Two layers enforce it: a best-effort per-turn **advertise-filter** (a governed tool is not offered to the model) and the **authoritative, fail-closed `confirmAction` floor** — so even if the model names a hidden tool, the mode still decides.

| Mode | Advertised tools | A governed action (write / command / network / clipboard) |
| --- | --- | --- |
| `ask` (default) | read-only (`read_file`, `list_directory`, `git_status`) | **denied** |
| `plan` | read-only | **denied** |
| `accept-edits` | all granted | **prompts** each time — `[y]` yes (once) · `[a]` always (this tool, this session) · `[n]` no · `[esc]` abort |
| `auto` | all granted | **auto-approved** — EXCEPT a **protected-path** write, which still prompts |

**Governed classes** (what the floor gates): a write (`fsWrite`), any egress (`http_request` / `web_search` / `mcp_call` / a discovered MCP tool), an `os` action (`read_clipboard` — an un-jailed read of ambient, secret-bearing OS state — and `notify`), and a `run_command` with a model-chosen command. Read-only fs reads + `git_status` are never gated. **Protected paths** (`.git/`, `.relavium/`, `.ssh/`, shell-startup files) are refused in **every** mode including `auto` (there is no bypass valve), and no mode escapes the `fs` jail / scope tier. An **`Esc`** mid-turn aborts the in-flight turn but **keeps the session alive** (distinct from `/cancel`): it settles one `session:turn_completed` (an `aborted` stop-reason), rolls back the pending message, and returns to idle. The once/always memory is **in-memory** and per-session — a `chat-resume` re-prompts. The one-shot `relavium agent run` (non-interactive) runs `ask` (governed actions denied — no approver). On the interactive surface a host tool EXECUTION failure to an **idempotent read** (e.g. a file-not-found `read_file` — the #1 cause is launching `chat` from a directory that does not contain the path) is **fed back to the model** so it can adapt / explain rather than ending the turn (`recoverToolFailures`, scoped via `ToolExecutionError.recoverable`); a **governed / side-effecting** failure stays fail-fast. When a turn does die on `tool_failed`, its one-line summary shows a **static, secret-free hint** ("a path may be outside this session's workspace, or the target was unavailable") — never the raw error message (which may carry model / MCP context).

## Context compaction (2.5.F, [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md))

A long conversation grows its transcript every turn until it approaches the model's context window. Three
mechanisms bound it — all **append-only** (nothing is deleted; the full transcript always survives for
`/export` and audit) and **resume/reseat-preserving**:

- **`/compact`** — model-summarises the earlier conversation into a **session-level preamble** (prepended to
  the agent's system prompt each turn) and keeps the **last exchange verbatim**. An LLM call: it reports the
  token deltas + spend and shows the summary (a lossy, paid operation is inspectable). The summary is produced
  by the session's **own bound model** (no second binding — [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)).
- **Automatic compaction** — after a turn whose **real** input tokens exceed `[chat].compact_threshold`
  (default `0.8`) × the serving model's context window, the session auto-compacts **before the next turn**
  (`[chat].auto_compact`, default on). Guarded so it never thrashes (skipped when compaction can't reduce
  below the budget) and its cost is accounted + surfaced as an inline `⟳ Context auto-compacted …` notice —
  never a silent context swap. A model with no known window (a custom base-URL id) skips auto-compaction; a
  summarisation failure degrades to a deterministic `/trim`.
- **`/trim [n]`** — a deterministic drop to the last `n` messages (default `[chat].max_messages`), **no LLM
  call, no cost**. Also the auto-compaction failure fallback.

**The durable boundary.** Each compaction/trim appends one `role: 'system'` **marker** row carrying the summary
(empty for a trim) + a `compaction_dropped_through_sequence`; original rows are never edited or deleted. On
resume, the preamble is the summary of the **newest marker that carries one** (a `/compact` — a summary-less
`/trim` marker advances the boundary but never blanks a prior summary), and only rows past the boundary re-enter
the working context — so a compacted session stays compacted across `chat-resume` and a model reseat.

**The summary prompt invariant (the product surface of `/compact`).** The summariser prompt (a fixed, authored
`COMPACTION_SYSTEM_PROMPT` in the engine — the conversation to summarise rides an untrusted user message, never
the authored system prompt) MUST preserve: **open tasks and their state; decisions taken and why; concrete code
identifiers / file paths / commands / values in play; and the user's stated preferences**. A summary that loses
these fails the feature. Under `--json` each compaction rides the stream as a `session:compacting` (the moment
START) then a terminal `session:compacted` / `session:trimmed` event — **except** a manual `/compact` that
**fails**, which emits `session:compacting` with **no** terminal (the host clears the moment when `compact()`
settles). A machine consumer must not assume every `session:compacting` is followed by a terminal.

**The compaction moment.** The engine emits a `session:compacting` event at the start of every compaction
(`/compact` or automatic). The interactive surface gates input and shows a **labeled** "⟳ Summarizing
conversation… · Esc to cancel" spinner off it while the summariser runs (so a keystroke can never race the busy
engine), and **`Esc` aborts it** (the session survives). The moment ends on the terminal `session:compacted` /
`session:trimmed`; a manual `/compact` that fails clears it when the command settles (the busy-gated render never
shows a stale label). A **context-fullness** indicator on the session footer (the LAST turn's input tokens ÷ the
model's context window, e.g. `62% ctx`) makes an impending auto-compaction anticipated; it is omitted for a custom
base-URL model whose window is unknown (the same models that skip auto-compaction) and until the first turn
completes.

## Input ergonomics (2.5.D, [ADR-0061](../../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))

The TTY prompt is a first-class line editor. All of these are **interactive-only** — a plain non-TTY / `--json` driver has no cursor UI, and the two data-moving affordances (`@` / `!`) are treated as a **literal leading character** there (no completion, no shell escape):

| Key | Effect |
|-----|--------|
| `Ctrl+J` | Insert a newline (compose a multi-line message); `Enter` sends. |
| `↑` / `↓` | Recall the previous / next submitted line (at the top/bottom edge of a multi-line buffer); mid-buffer they move the cursor by line. History is per-session (not persisted; a `chat-resume` starts fresh). |
| `Ctrl+R` | Reverse-incremental search of the session history — type to match, `Ctrl+R` steps older, `Enter` accepts, `Esc` cancels. |
| `Ctrl+T` | Toggle the collapsible **reasoning ("thinking") panel** (**2.5.H**; same as `/thinking`) — works mid-turn, so you can expand the model's thinking while it streams. |
| `Ctrl+A`/`Ctrl+E`, `Ctrl+←`/`Ctrl+→`, `Ctrl+W`, `Ctrl+U`/`Ctrl+K` | readline cursor / word / line motions + kills (word-back, to-line-start, to-line-end). |
| `Backspace` / `Delete` | erase the char **before** the cursor. (ink 7 reports the physical Backspace as `key.backspace` and the forward-Delete key as `key.delete`; both fold to a backward delete.) |

**Bracketed paste.** A multi-line paste is received on **ink 7's native `usePaste` channel** (2.6.F, [ADR-0068](../../decisions/0068-full-screen-tui-renderer-ink7-harness.md)) and appended to the compose buffer as **one block** (embedded newlines kept, CRLF/CR → LF), so it never submits early. A paste is **dropped** while a turn / `!`-shell / submit is in flight or any keyboard-owning overlay/submode is open, and — the fail-closed floor ([ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)) — while a **per-tool approval is pending**, so a pasted approval token can never answer it (paste never reaches the approval key reducer). The gate is the shared `pasteIsEditable` predicate the [Home](home.md) also uses, so the two surfaces can never diverge.

Both data-moving affordances use a **pending-attachment (chip) model** (ADR-0061, refined in PR #64): instead of splicing framed bytes into the editor, `@`/`!` content is queued as a compact **chip** shown in a bar above the prompt, and expanded into the shared **UNTRUSTED, nonce-fenced** frame **only at submit** — so the model receives byte-identical framed context while your prompt stays clean. **`Esc` at an idle prompt discards all pending chips.**

**`@`-mention (file-context).** Typing `@` at a word boundary opens a **dir-navigable completion** overlay — arrow/type to filter, `Enter`/`Tab` to descend a directory or accept a file, `..` (or backspace past the filter) to ascend, `Esc` to cancel (restoring the literal keystrokes). Accepting a file inserts a compact **`@path` marker** at the cursor and queues the file as a chip; at submit the file expands into **UNTRUSTED, user-position context** (nonce-fenced `<file>` framing, byte+line bounded so a large file can't freeze the editor) **only if its `@path` marker is still present** — deleting the marker drops the file. The read goes through the **same** `FsCapability` the session's tools use — the workspace **jail**, the sensitive-read **confidentiality floor** (`.ssh` / `.env` / `.aws` / … are never listed nor read), the binary fail-close, and the size cap all apply; a user typing `@path` replaces the `confirmAction` prompt (a stronger consent signal), **never** the floor.

**`!`-shell (command escape).** A message starting with `!` runs the rest as a shell command instead of sending it to the model — through the **one** `run_command` boundary: the `[chat].allowed_commands` allowlist (**exact full-command-string match**, enforced BEFORE approval) → the mode-aware `confirmAction` (denied in `ask`/`plan`, prompted in `accept-edits`, auto in `auto`) → the hardened process arm (`spawn`, `shell:false` — no metachar/glob/`$var` expansion; the command is tokenized to literal argv). While a command runs the busy indicator names it, with **`Esc` to cancel** (Esc aborts the command, keeping the session). The allowlist **defaults empty ⇒ `!`-shell is disabled**; a non-allowlisted command gets an **actionable, secret-free hint** naming the exact `[chat].allowed_commands` line to add (or the mode-switch to make). The command's output is shown **read-only** as a bounded preview and queued as a chip carrying the **UNTRUSTED, nonce-fenced, doubly-bounded** output (the process-arm buffer cap + the injection bound) that rides your next message. See [config-spec.md](../contracts/config-spec.md) `[chat].allowed_commands` + [built-in-tools.md](../shared-core/built-in-tools.md).

## Streaming

In interactive mode the REPL renders the assistant turn live: streaming token output, tool-call/tool-result lines, and a per-turn cost/duration summary — the same `agent:token` / `agent:reasoning` / `agent:tool_call` / `agent:tool_result` / `cost:updated` event shapes a workflow run renders, carried on the session envelope (see [sse-event-schema.md](../contracts/sse-event-schema.md#session-event-namespace)).

### Reasoning & live-turn feedback (2.5.H)

A reasoning model streams its "thinking" over the `agent:reasoning` event (EA6, host-emit — the `@relavium/llm` seam already carries the reasoning chunks). The REPL renders it as a **collapsible "thinking" panel** (default **collapsed** — a dim `✻ Reasoning · Ctrl+T show` header; **`/thinking`** or **`Ctrl+T`** expands it, works mid-turn). While a turn is in flight the busy line shows **live-turn feedback** — `Thinking… {elapsed}s · Esc to stop` (or `Working…` when there is no reasoning, or while a tool call is still executing) — a whole-second timer + the abort affordance, so a running turn never reads as a frozen spinner. When the bounded live buffer's head scrolls out (the answer or the reasoning) a leading **`…` elision marker** makes the drop **visible**, not silent (the durable session record via the persister keeps the full text — only the live terminal echo is bounded). The completed-turn summary attributes the tokens to the **producing model** (`via {model}`) when a within-turn failover committed a different model than the bound one. The redacted-reasoning case (a provider-withheld block) streams no `agent:reasoning` and shows no panel content (there is nothing to render).

### Actionable error recovery (2.5.H)

A **failed** turn is never a terminal (only `session:cancelled` ends a session), so a failure always leaves the REPL live. Beyond showing the closed `ErrorCode`, the chat renders a **one-line, secret-free recovery hint** for each operational class that makes the next step + **"the session is still active"** explicit — extending the "say so plainly" philosophy from the 2.5.A capability gap to the transport / quota / limit classes:

- `provider_rate_limit` (429) / `provider_unavailable` — Relavium already retried with backoff + fallback-chain failover; resend.
- `provider_auth` — check the key or **unlock the OS keychain** if it locked mid-session, then resend.
- **context-overflow** — surfaces as `validation` (a provider `bad_request`); a keyword heuristic on the (never-displayed) provider message distinguishes it from a shape error and suggests **`/compact` or `/trim`**. This is a *secondary* net — 2.5.F auto-compaction ([ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md)) pre-empts most overflows; it fires for a model with no known window or `auto_compact = false`.
- `tool_failed` (incl. an **unreachable MCP server**) — the summary names the likely cause (a path / an unavailable target); fix it and resend (no blind retry — a side-effecting tool failure is fail-fast by design).
- `tool_denied` — switch the `/mode` if that was intended; `tool_unavailable` — a host/config gap (the capability arm isn't wired for the session): rephrase to avoid the tool, or wire it and start a fresh session.
- `budget_exceeded` / `turn_limit` / `content_filter` / `internal` — each renders its own actionable one-liner. (`cancelled` settles as `aborted` with no error, and `sandbox_error` / `run_timeout` are WorkflowEngine-only, so none is chat-reachable and none carries a hint.)

The hint is **always a static host string** — the provider message is read only to pick the right hint (the context-overflow heuristic), **never echoed**, so no provider text or secret reaches the terminal. The hint renders on the interactive TUI (a yellow line under the summary) and the plain chat driver (`drivePlain`, under `[turn failed: <code>]`); a **one-shot `relavium agent run`** suppresses the hint (its session ends immediately after, so a session-continuity hint would be false), and `--json` stays the structured stream (the consumer branches on `error.code`).

## Tool availability

A chat session uses the **same** built-in `ToolRegistry` as a workflow agent ([built-in-tools.md](../shared-core/built-in-tools.md)): the same tools, the same filesystem **scope tiers**, and the same mandatory guardrails (`run_command` only ever runs commands on the `allowedCommands` allowlist — empty/absent ⇒ disabled; `git_commit` behind approval). Per [ADR-0029](../../decisions/0029-tool-policy-hardening.md), a session may only **narrow** the agent's `tools:`, never escalate; a `secret`-typed value is never interpolated into a prompt or tool text; and `http_request` / MCP egress is subject to the same SSRF policy as a workflow. The tool surface, FS tier, and command allowlist for chat all resolve from the `[chat]` block of [config-spec.md](../contracts/config-spec.md), which points back to those canonical homes.

## `--json` session-event stream

> **Implementation status (2.Q).** Live: `selectChatDriver` routes a `--json` invocation (`--json` wins
> over a TTY) to the headless `driveJson` driver, which emits the `SessionEvent` NDJSON stream on stdout —
> all diagnostics (the unknown-slash notice, the `/export` confirmation) go to stderr, so stdout is a pure
> `SessionEvent` stream. `/export` under `--json` emits a `session:exported` event on the stream (routed
> through the session bus, so its `sequenceNumber` stays monotonic with the surrounding events).

For scripting and non-interactive use, `--json` switches the REPL to a machine-readable [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace) stream — one JSON object per line (NDJSON), the chat analogue of `relavium run --json`. Messages are read from stdin (one user turn per line) and the `session:*` events (`session:started`, `session:turn_started`, `session:turn_completed`, `session:cancelled`, `session:exported`, and — ADR-0062 — `session:compacting` / `session:compacted` / `session:trimmed`) plus the per-turn `agent:*` / `cost:updated` events are emitted on stdout, each carrying the `sessionId`; an input-stream EOF ends the session with the `session:cancelled` terminal and exit code 4:

```bash
echo "summarize ./README.md" | relavium chat --agent code-reviewer --json
```

The session namespace is **disjoint** from the run namespace (keyed by `sessionId`, not `runId`); consumers route purely on the `type` discriminant (see [sse-event-schema.md](../contracts/sse-event-schema.md#session-event-namespace)).

## Exit code 4

A `relavium chat` REPL ends with code **`4`** — the canonical **chat-session-ended** code defined in [commands.md](commands.md#exit-codes) — on any of: `/exit`, `/cancel` (or **Ctrl-C** in TTY mode), or an **input-stream EOF** (the user closes stdin — in plain non-TTY mode, or under `--json`). It is deliberately distinct from a successful workflow run (`0`) and a hard failure (`1`) so a wrapper script can tell "the user ended the chat" apart from either. A crash or an unrecoverable provider error still exits `1`; bad arguments still exit `2`. (The one-shot `relavium agent run` is **not** a REPL — it exits with the turn's outcome, `0`/`1`, never `4`.)

## API keys

Provider keys are read from the **OS keychain** exactly as for `relavium run` — via `@napi-rs/keyring`, never plaintext, never in a session row, a message, or an event payload ([ADR-0019](../../decisions/0019-cli-node-keychain-library.md), [add-a-provider-key.md](../../runbooks/add-a-provider-key.md)). The user's own conversational content typed into a session is the user's data and is persisted in the CLI `history.db` (**unencrypted at rest**, guarded by `0600`/`0700` OS permissions per [ADR-0050](../../decisions/0050-cli-history-db-at-rest-posture.md); the desktop surface uses SQLCipher); it is not a managed secret (see [agent-session-spec.md](../contracts/agent-session-spec.md#tools-secrets-and-security-scope)). No key ever crosses the `@relavium/llm` seam into message history. _`read_media` input access (the in-chat media read tool, D12) is a separate, security-reviewed follow-up — it is not yet wired in 2.M._

## Export to workflow

`/export` (interactive) and `relavium chat-export <sessionId>` drive the **one** export contract: the session's assistant turns become a linear chain of `agent` nodes and the full transcript is preserved as YAML metadata, for review before commit ([ADR-0026](../../decisions/0026-session-export-to-workflow.md)). The two differ only in their provenance side-effect: `relavium chat-export` additionally marks the session row `status: exported` and records the written path (a durable provenance mark surfaced by `chat-list`); the in-REPL `/export` writes the scaffold but does **not** mark the row, since a later turn's persist would clobber the marker. The mapping is owned by [agent-session-spec.md](../contracts/agent-session-spec.md#export-to-workflow); it **produces** the format owned by [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md). Parallel / conditional / loop structure is not auto-inferred — the export is a **scaffold**.
