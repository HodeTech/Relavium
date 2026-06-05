# Start a Chat Session (CLI)

> Status: planned (build phase 2 — Product Phase 1; the first user-facing `AgentSession` surface) — to be expanded

This is the **fastest** way into Relavium: open a conversation with an agent, watch it use
tools on your machine, and get useful work done — **no YAML up front**. It is the
agent-first entry point of the product arc: *start as an agent, ship the workflow, own
every run.* Later you can export the conversation to a committed workflow, but here you
just talk.

`relavium chat` sits beside `relavium run` on the **same** `@relavium/core` engine: `run`
drives a workflow DAG, `chat` drives an [agent session](../../reference/contracts/agent-session-spec.md).
This walkthrough teaches the chat REPL by using it end-to-end. For the exact command
surface, flags, and exit codes, see the canonical
[chat-session reference](../../reference/cli/chat-session.md) — this tutorial links to it
rather than restating it.

## What you will accomplish

- Launch an interactive agent session with `relavium chat`.
- Pick the agent the session runs as.
- Hold a multi-turn conversation, with each turn persisted automatically.
- Watch the agent call a built-in tool and see the result stream back.
- Understand the filesystem scope the agent is confined to.
- End the session cleanly — and know it is resumable.

## Prerequisites

- The CLI installed: `npm install -g relavium`. It bundles the same `@relavium/core`
  engine as every other surface.
- At least one LLM provider key in the OS keychain — see
  [add-a-provider-key.md](../../runbooks/add-a-provider-key.md). The key is read from the
  keychain exactly as for `relavium run`; it never appears in a session row, a message, or
  an event payload.
- *(optional)* An `.agent.yaml` if you want to bind a specific agent. With none, the
  chat-mode default agent/model from project config applies — the `[chat]` defaults live in
  [config-spec.md](../../reference/contracts/config-spec.md).

You do **not** need a `.relavium.yaml` workflow to start a chat — that is the point.

## Steps (to be expanded)

1. **Launch the session.** With a TTY attached, `relavium chat` opens an `ink`-rendered
   interactive REPL. The session is **auto-persisted and resumable** from the moment it
   starts — there is no separate save step:

   ```bash
   relavium chat
   ```

2. **Pick an agent.** A session binds **one agent and one model for its whole lifetime**
   (no mid-session switching in Phase 1). Name the agent at launch — a path or a
   `.relavium/` id:

   ```bash
   relavium chat --agent ./agents/coder.agent.yaml
   relavium chat --agent code-reviewer            # resolved inside .relavium/
   ```

   The model and its fallback chain come from that agent — the same fallback chain a
   workflow `agent` node uses.

3. **Have a multi-turn conversation.** Type a message; the assistant turn streams back
   (tokens live), then the prompt returns for your next turn. Each prompt is one user
   turn, appended **append-only** and persisted before the next turn begins:

   ```text
   › what does this repo's build script do?
   › now add a --watch flag and explain the change
   ```

4. **Watch the agent use a tool.** When the agent needs to act on your machine — read a
   file, run an allowlisted command — it issues a tool call and the result streams back
   inline. Chat uses the **same** built-in `ToolRegistry` as a workflow agent (the same
   tools, the same result shapes), catalogued in
   [built-in-tools.md](../../reference/shared-core/built-in-tools.md):

   ```text
   › summarize ./README.md
   [tool] read_file ./README.md → 4.1 KB
   The README describes …
   ```

5. **Notice the filesystem scope.** Every file-touching tool runs under the session's
   filesystem **scope tier** — by default the agent may only touch the current workspace
   and `~/.relavium/tmp/`. Ask it to read a file outside that scope and it is refused, not
   silently allowed. The active tier resolves from the `[chat]` block of
   [config-spec.md](../../reference/contracts/config-spec.md), which references the same
   `fs_scope` the workflow side uses (see the scope tiers in
   [built-in-tools.md](../../reference/shared-core/built-in-tools.md#filesystem-permission-tiers)).
   The same guardrails apply: `run_command` only ever runs commands on the
   `allowedCommands` allowlist (empty/absent ⇒ disabled), and `git_commit` is behind
   approval.

6. **End the session.** Type `/exit` to close the REPL cleanly. The process exits with the
   distinct **chat-session-ended** code `4`, so a wrapper script can tell "the user quit
   the chat" apart from a successful workflow run (`0`) or a hard failure (`1`):

   ```text
   › /exit
   ```

   The conversation is already persisted — resume it later with
   `relavium chat-resume <sessionId>`, or list past sessions with `relavium chat-list`
   (see the [chat-session reference](../../reference/cli/chat-session.md)).

## What just happened

To be expanded. This section will connect the chat run to the engine model: `relavium
chat` opened an [agent session](../../reference/contracts/agent-session-spec.md) on the
same `@relavium/core` engine `relavium run` uses, each turn drove the agent loop through
the shared `ToolRegistry` and the `@relavium/llm` seam, every tool call ran under the same
filesystem scope and command allowlist a workflow would enforce, and the whole transcript
was checkpointed to the encrypted `history.db` — so it is resumable and, when you are
ready, exportable. Harden once, both entry points inherit (see
[shared-core-engine.md](../../architecture/shared-core-engine.md)).

## Next steps

- Turn this conversation into a committed, reviewable workflow scaffold — export it to a
  `.relavium.yaml` (linear agent-node chain + transcript metadata), reviewed before commit
  (see [ADR-0026](../../decisions/0026-session-export-to-workflow.md) and the
  [chat-session reference](../../reference/cli/chat-session.md#export-to-workflow)).
- See the full chat command surface and flags:
  [chat-session reference](../../reference/cli/chat-session.md).
- Build a workflow visually instead: [Build your first workflow (desktop)](../desktop/build-your-first-workflow.md).
- Run a committed workflow headless in CI: [Run a workflow in CI (CLI)](run-a-workflow-in-ci.md).
