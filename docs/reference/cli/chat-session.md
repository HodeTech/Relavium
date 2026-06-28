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

A small set of slash commands drives the REPL itself (not the agent):

| Command | Effect |
| --- | --- |
| `/exit` | End the session cleanly and quit the REPL (**exit code 4**, below). |
| `/cancel` | End the session (aborting any in-flight turn — relevant when entered as **Ctrl-C** mid-turn in TTY mode; a typed `/cancel` runs between turns). In Phase 1 the engine has no per-turn abort that keeps a session alive, so `/cancel` terminates it — but the session is **persisted and resumable** via `relavium chat-resume <sessionId>` (2.N). Exits with code 4. |
| `/export` | Export the session-so-far to a `.relavium.yaml` scaffold (same ADR-0026 contract as `relavium chat-export`). Writes the file (named `<sessionId>.relavium.yaml`) and reports the path; under `--json` it emits a `session:exported` event on the stream. It does **not** mark the session row `exported` (a later turn's persist would clobber that) — use `relavium chat-export` for the durable provenance mark. **Live (2.P / 2.Q).** |

An unrecognized `/…` command prints a one-line, secret-free notice and the prompt returns. In a TTY, **Ctrl-C** is equivalent to `/cancel` (the `ink` REPL runs in raw mode, so the kernel does not raise SIGINT — the REPL handles it).

## Streaming

In interactive mode the REPL renders the assistant turn live: streaming token output, tool-call/tool-result lines, and a per-turn cost/duration summary — the same `agent:token` / `agent:tool_call` / `agent:tool_result` / `cost:updated` event shapes a workflow run renders, carried on the session envelope (see [sse-event-schema.md](../contracts/sse-event-schema.md#session-event-namespace)).

## Tool availability

A chat session uses the **same** built-in `ToolRegistry` as a workflow agent ([built-in-tools.md](../shared-core/built-in-tools.md)): the same tools, the same filesystem **scope tiers**, and the same mandatory guardrails (`run_command` only ever runs commands on the `allowedCommands` allowlist — empty/absent ⇒ disabled; `git_commit` behind approval). Per [ADR-0029](../../decisions/0029-tool-policy-hardening.md), a session may only **narrow** the agent's `tools:`, never escalate; a `secret`-typed value is never interpolated into a prompt or tool text; and `http_request` / MCP egress is subject to the same SSRF policy as a workflow. The tool surface, FS tier, and command allowlist for chat all resolve from the `[chat]` block of [config-spec.md](../contracts/config-spec.md), which points back to those canonical homes.

## `--json` session-event stream

> **Implementation status (2.Q).** Live: `selectChatDriver` routes a `--json` invocation (`--json` wins
> over a TTY) to the headless `driveJson` driver, which emits the `SessionEvent` NDJSON stream on stdout —
> all diagnostics (the unknown-slash notice, the `/export` confirmation) go to stderr, so stdout is a pure
> `SessionEvent` stream. `/export` under `--json` emits a `session:exported` event on the stream (routed
> through the session bus, so its `sequenceNumber` stays monotonic with the surrounding events).

For scripting and non-interactive use, `--json` switches the REPL to a machine-readable [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace) stream — one JSON object per line (NDJSON), the chat analogue of `relavium run --json`. Messages are read from stdin (one user turn per line) and the `session:*` events (`session:started`, `session:turn_started`, `session:turn_completed`, `session:cancelled`, `session:exported`) plus the per-turn `agent:*` / `cost:updated` events are emitted on stdout, each carrying the `sessionId`; an input-stream EOF ends the session with the `session:cancelled` terminal and exit code 4:

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
