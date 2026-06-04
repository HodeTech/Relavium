# Built-in Tools

- **Status**: Stable
- **Canonical home**: the catalog of tools every local agent can call out of the box
- **Related**: [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [mcp-integration.md](mcp-integration.md), [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [../../architecture/local-first-and-security.md](../../architecture/local-first-and-security.md)

Tools are the capabilities an agent can invoke beyond pure text generation. Relavium ships a fixed set of **built-in tools**; an agent or `tool` node opts in by listing tool ids in `tools:` (see [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md) and [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)). Beyond these, agents can call **MCP** tools and user **plugins** — see [mcp-integration.md](mcp-integration.md).

A tool declaration in YAML has a `type` discriminator:

| `type` | Source | Examples |
| --- | --- | --- |
| `builtin` | shipped with `@relavium/core` | the table below |
| `mcp` | a registered MCP server tool | see [mcp-integration.md](mcp-integration.md) |
| `plugin` | a user-supplied npm package | see [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md) |
| `http` | an arbitrary REST endpoint | configured per call |

## The built-in tools

| Tool id | Purpose | Returns (shape) | Notes |
| --- | --- | --- | --- |
| `read_file` | Read file content as UTF-8 (or base64 for binary). Supports glob for reading multiple files. | `{ content, mimeType, sizeBytes, lastModified }` | Respects the workflow's FS scope tier. |
| `write_file` | Write or append content to a file. Optionally creates parent directories. | `{ path, bytesWritten }` | Within the allowed scope only. |
| `list_directory` | List directory contents, optional recursive + glob filter. | `{ entries: [{ name, type, sizeBytes, lastModified }] }` | Respects FS scope. |
| `run_command` | Spawn a shell command via the shell plugin. Streams stdout/stderr as events. | `{ exitCode, stdout, stderr, durationMs }` | **Allowlist required** — see below. Never runs unlisted commands. |
| `http_request` | Outbound HTTP/HTTPS (GET/POST/PUT/DELETE), custom headers, JSON body, streaming response. | response body / stream | Domain allowlist configurable per workflow. |
| `web_search` | Web search via the configured provider (e.g. Brave Search / SearXNG). | `{ results: [{ title, url, snippet }] }` | Provider key in the secret store, not the workflow file. |
| `git_status` | Run `git status` / `git log` / `git diff` in the workspace. | structured JSON parsed from git output | Pre-approved in the default git allowlist. |
| `git_commit` | Stage files and create a commit with a message. | commit result | **Requires a `human_gate` approval** before executing in automated workflows. |
| `read_clipboard` | Read current clipboard text. | `string` | Powers "process what I just copied" triggers. |
| `notify` | Send a native desktop notification (title, body, optional action buttons). | `void` | Lets an agent request attention mid-run without blocking the run. |
| `mcp_call` | Connect to a registered MCP server and invoke one of its tools by name. | the MCP tool result as JSON | Server resolved from config; see [mcp-integration.md](mcp-integration.md). |
| `invoke_agent` | Call another agent node in the same workflow by node id, with explicit input. | that agent's output | The dynamic-dispatch mechanism used by orchestrator agents to delegate. |

> Two tools have **mandatory guardrails**: `run_command` only ever executes commands on the workflow's `allowedCommands` allowlist (defined under `spec.tools.allowedCommands` — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools); empty or absent ⇒ `run_command` is disabled), and `git_commit` is gated behind human approval in automated workflows. Both are enforced by the engine, not by convention. `run_command` is the **only** sandboxed shell-exec built-in — there is no separate `run_javascript` tool (sandboxed JS evaluation is the engine's job for `condition`/`transform` expressions, not a callable tool).

## Tool input/output mapping

A `tool` node (direct tool execution without an LLM) and an agent's tool call both use `input_mapping` / `output_mapping` to wire workflow state into the tool and the result back out. Tool credentials are referenced by id from the secret store and are **never** inlined into the workflow JSON or echoed into event payloads (`agent:tool_call.toolInput` is sanitized; see [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md)).

## Filesystem permission tiers

Every file-touching tool runs under a per-workflow filesystem **scope tier**. The tier is enforced by the desktop's scoped filesystem layer and the Tauri v2 capability system — paths are validated before any syscall (see [../desktop/tauri-plugins.md](../desktop/tauri-plugins.md)).

| Tier | Default for | What the agent may touch | How it is granted |
| --- | --- | --- | --- |
| **Sandboxed** | untrusted workflows (default) | the current workspace directory and `~/.relavium/tmp/` only | implicit; no prompt |
| **Project-scoped** | workflows that declare an expanded scope | an explicit path allowlist declared in the workflow | user approves on first run via a native permission dialog |
| **Full access** | power users, per workflow | unrestricted filesystem | granted in the UI; stored as a capability grant in the project config |

The active tier is set in project config (see [../contracts/config-spec.md](../contracts/config-spec.md), `fs_scope`) and can be tightened per workflow. The shell allowlist for `run_command` (`spec.tools.allowedCommands` in the workflow — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools)) is independent of the FS tier — a workflow can be sandboxed *and* still have an empty command allowlist.

## Where tools run

Built-in tools execute inside `@relavium/core`. On the desktop the engine and its tool dispatch run in the **WebView's JS runtime** (a Tauri WebView has no backing Node context); privileged side-effects are delegated to the Rust core through explicit Tauri commands — the authenticated LLM HTTPS egress goes through the `llm_stream` command ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), and `run_command` and similar shell executions spawn real OS child processes through the shell plugin under the allowlist. In the CLI and VS Code surfaces the same tools run in the Node.js host process. The behavior and the result shapes are identical across surfaces because the engine is shared. See [../../architecture/execution-model.md](../../architecture/execution-model.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md).
