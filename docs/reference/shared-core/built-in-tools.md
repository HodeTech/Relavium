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
| `read_file` | Read text file content as UTF-8. Supports glob for reading multiple files. | `{ content, mimeType, sizeBytes, lastModified }`; **binary/media content returns a durable media handle** (`tool_result.media`, [ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md)), never inline base64 | Respects the workflow's FS scope tier. |
| `write_file` | Write or append content to a file. Optionally creates parent directories. | `{ path, bytesWritten }` | Within the allowed scope only. |
| `list_directory` | List directory contents, optional recursive + glob filter. | `{ entries: [{ name, type, sizeBytes, lastModified }] }` | Respects FS scope. |
| `run_command` | Spawn an OS process with **`shell: false`** (no shell interpretation) and return its byte-bounded captured output. | `{ exitCode, stdout, stderr, durationMs }` | **Exact-match allowlist required** — see below. Never runs unlisted commands. |
| `http_request` | Outbound **HTTPS** (GET/POST/PUT/DELETE), custom headers, JSON body, streaming response. | response body / stream | **HTTPS-only**, exact-FQDN `allowedDomains` allowlist (empty/absent ⇒ disabled), private/loopback/link-local/metadata ranges blocked (SSRF) — see below. |
| `web_search` | Web search via the configured provider (e.g. Brave Search / SearXNG). | `{ results: [{ title, url, snippet }] }` | Provider key in the secret store, not the workflow file. |
| `git_status` | Run `git status` / `git log` / `git diff` in the workspace (read-only). | the raw `git` process result | The model picks only the subcommand; any extra flags are **author-pinned via config**, not model-supplied (a model-controlled `--no-index`/`-p --all` would read arbitrary files / dump history). |
| `git_commit` | Create a commit with a message, optionally restricted to given pathspecs (does **not** `git add`/stage). | commit result | **Requires a `human_gate` approval** before executing in automated workflows; pathspecs are `--`-separated so a model cannot smuggle a git option. |
| `read_clipboard` | Read current clipboard text. | `string` | Powers "process what I just copied" triggers. |
| `notify` | Send a native desktop notification (title, body, optional action buttons). | `void` | Lets an agent request attention mid-run without blocking the run. |
| `mcp_call` | Connect to a registered MCP server and invoke one of its tools by name. | the MCP tool result as JSON | Server resolved from config; see [mcp-integration.md](mcp-integration.md). |
| `invoke_agent` | Call another agent node in the same workflow by node id, with explicit input. | that agent's output | The dynamic-dispatch mechanism used by orchestrator agents to delegate. |
| `read_media` | Read a produced/received media asset's bytes by its durable `media://sha256-…` handle (optional byte `Range`), so a media-capable model can consume it inline. | a gated `tool_result` media part (the bytes as an in-flight source under the inline ceiling) | **Scope-set authz** — the requesting `session`/`workspace` must be in the handle's `allowedScopes` ([ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md) §1); knowing a sha256 is **not** authorization; read-only (bypasses the action gate), fail-closed `Range`, secret-free `media_scope_denied`. *(Engine-pure policy landed at 1.AF; the host `MediaReadAccess` mechanism + scope population are wired at 1.AH — see [deferred-tasks.md](../../roadmap/deferred-tasks.md).)* |

> **Mandatory guardrails (security tightenings — [ADR-0029](../../decisions/0029-tool-policy-hardening.md)):** `run_command` only executes commands that **exactly match** the workflow's `allowedCommands` allowlist (opt-in glob via `allowedCommandGlobs`; defined under `spec.tools.allowedCommands` — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools); empty or absent ⇒ disabled). `http_request` is **HTTPS-only**, matches `allowedDomains` by **exact FQDN** (empty/absent ⇒ disabled), and **blocks private/loopback/link-local/metadata IP ranges** — the same vetted SSRF primitive applied to provider base URLs and MCP server URLs ([security-review.md](../../standards/security-review.md)). And `git_commit` is gated behind human approval in automated workflows. All are enforced by the engine, not by convention. `run_command` is the **only** sandboxed shell-exec built-in — there is no separate `run_javascript` tool (sandboxed JS evaluation is the engine's job for `condition`/`transform` expressions, not a callable tool).

> **Return shapes.** The *Returns* column is the **logical** shape. Until a provider-specific normalizer lands, `http_request` / `web_search` / `mcp_call` / `git_status` dispatch the **raw host response** (`EgressResponse` / the MCP tool result / the `git` `ProcessResult`); a downstream `transform` node shapes it. The file tools (`read_file` / `write_file` / `list_directory`) and `run_command` already return the documented shape.

## Tool input/output mapping

A `tool` node (direct tool execution without an LLM) and an agent's tool call both use `input_mapping` / `output_mapping` to wire workflow state into the tool and the result back out. Tool credentials are referenced by id from the secret store and are **never** inlined into the workflow JSON or echoed into event payloads (`agent:tool_call.toolInput` is sanitized; see [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md)).

## Config-only parameters

A built-in tool's parameters split into two tiers. **LLM-visible** parameters form the JSON Schema the `ToolNormalizer` lowers to each provider's wire shape — the only parameters a model may supply. **Config-only** parameters take their **values from the node's `tool_config` / `agent_config` block** ([node-types.md](node-types.md) — `parameters`), are merged at dispatch (config wins), and **never** appear in the LLM-facing schema: a model-supplied argument can never override one. This keeps prompts small and pins safety-relevant values (a root path, a base URL, a timeout) out of the model's reach. The `ToolDef` field shape and the dispatch-time merge are canonical in [tool-registry.md](tool-registry.md); the decision is [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md).

## Tool result bounding

The result a tool hands **back to the model** (which re-enters the next request) is size-bounded — distinct from the `agent:tool_result.outputSummary` *event* field, which is truncated separately for display ([sse-event-schema.md](../contracts/sse-event-schema.md)). The bound is **model-facing only**: `output_mapping` writes the **full** result into workflow state, so a downstream node still gets the real value; only the model-facing copy is replaced by a **bounded preview** (honoring **both** the byte and the line ceiling), an explicit **truncation marker**, and the **path** to the full output spilled to the host's run-scoped **output store** (reclaimed at the run's terminal event). This closes the model-facing context-window cost/DoS surface the pre-egress budget governor ([ADR-0028](../../decisions/0028-workflow-resource-governance.md)) cannot see — an oversized `read_file` / `http_request` / MCP result blows the *next* request's window. *v1.0 caveat:* the bound is over the **in-memory** result the dispatch returns; the stream-and-spill-at-the-source guarantee (the engine never holding the full bytes) is a **host-capability obligation** that lands with the first genuinely-streamed large source (see [tool-registry.md §Result bounding](tool-registry.md#result-bounding-and-spill-to-file)). The output store is its own host capability, so bounding works even on a host with no filesystem (`web_search` / MCP).

| Knob | v1.0 default | Note |
| --- | --- | --- |
| Byte ceiling | 50 KB | over ⇒ spill + preview (model-facing only) |
| Line ceiling | 2000 lines | over ⇒ spill + preview (model-facing only) |
| Preview | head + tail slice within the ceiling | the marker names the omitted span |
| Spill | the host's run-scoped output store; reclaimed at the terminal event | the path is handed to the model; readable via the FS-scope-tiered tools |

The ceiling is a **byte/line** bound — no token count, which would need a provider-specific tokenizer and break engine purity. These defaults are tunable and revisited if real workflows hit them (the [deferred-tasks.md](../../roadmap/deferred-tasks.md) tool-output-gate framing). The dispatch lifecycle that applies them is in [tool-registry.md](tool-registry.md#result-bounding-and-spill-to-file).

## Subprocess environment

A tool that spawns a process (`run_command`, `git_*`) runs with **`shell: false`** under an **explicitly-constructed environment** — **never** a blanket copy of the host environment, which would hand every subprocess the host's secrets and hijack vectors (`PATH`, `NODE_OPTIONS`, …). Because the engine is platform-free it cannot build a platform base env or resolve an executable on `PATH`, so the split is: the **engine** supplies the policy (the allowlist-checked command) plus the declared extra variables; the **host** resolves the executable, supplies the platform-minimal base env, and merges only the declared variables under an audited allowlist. The seam is in [tool-registry.md](tool-registry.md#the-toolhost-capability-seam).

## Filesystem permission tiers

Every file-touching tool runs under a per-workflow filesystem **scope tier**. The tier is enforced by the desktop's scoped filesystem layer and the Tauri v2 capability system — paths are validated before any syscall (see [../desktop/tauri-plugins.md](../desktop/tauri-plugins.md)).

| Tier | Default for | What the agent may touch | How it is granted |
| --- | --- | --- | --- |
| **Sandboxed** | untrusted workflows (default) | the current workspace directory and `~/.relavium/tmp/` only | implicit; no prompt |
| **Project-scoped** | workflows that declare an expanded scope | an explicit path allowlist declared in the workflow | user approves on first run via a native permission dialog |
| **Full access** | power users, per workflow | unrestricted filesystem | granted in the UI; stored as a capability grant in the project config |

The active tier is set in project config (see [../contracts/config-spec.md](../contracts/config-spec.md), `fs_scope`) and can be tightened per workflow. The shell allowlist for `run_command` (`spec.tools.allowedCommands` in the workflow — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools)) is independent of the FS tier — a workflow can be sandboxed *and* still have an empty command allowlist.

> **CLI host (2.5.A, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)) interim posture:** the Node `fs` capability backing the CLI surfaces enforces the tier with a `realpath` + `commonpath` jail (a `..` traversal or a symlinked component/ancestor that escapes the tier is a **fatal `tool_denied`**, never retried). Until a media store is wired into that arm, `read_file` **fail-closes** on a binary/media file (a clear `tool_failed`) rather than returning a durable handle or inline base64 — the durable-handle path (ADR-0031) is a tracked follow-up. The `relavium chat` default profile wires this arm **read-only**, so `write_file` is `tool_unavailable` there until [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)/2.5.E lands the per-tool approval floor. The factory does not yet pass an `extraRoots` allowlist, so the **Project-scoped** tier behaves as **workspace-only** here (it can only narrow the jail, never open a hole — `project` == `sandboxed`-minus-tmp); the path-allowlist arrives with the approval-gated surface in 2.5.E. For the read-only chat surface a declared **Full access** tier is **clamped to Project-scoped** (an unjailed read could exfiltrate `~/.ssh` / `~/.aws/credentials` back to the model); `full` stays intact only for the author-trusted workflow-run profile.

## Where tools run

Built-in tools execute inside `@relavium/core`. On the desktop the engine and its tool dispatch run in the **WebView's JS runtime** (a Tauri WebView has no backing Node context); privileged side-effects are delegated to the Rust core through explicit Tauri commands — the authenticated LLM HTTPS egress goes through the `llm_stream` command ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), and `run_command` and similar shell executions spawn real OS child processes through the shell plugin under the allowlist. In the CLI and VS Code surfaces the same tools run in the Node.js host process. What is identical across surfaces is the **engine-level tool contract** — the dispatch semantics and the documented result shapes — because the engine is shared. What varies is the **execution location** (above) and **which host capabilities are wired, and their posture** — e.g. the CLI's read-only `relavium chat` profile, the `read_file` binary/media fail-close until a media store is wired, and the active fs-scope tier. Those are host- and phase-specific and are governed by their authoritative ADRs (the [CLI-host note](#filesystem-permission-tiers) above, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](../../decisions/0057-cli-chat-modes-and-per-tool-approval.md)), **not** restated as a cross-surface guarantee here: a tool that is *available* behaves and returns identically everywhere, while its *availability* is never promised to be uniform. See [../../architecture/execution-model.md](../../architecture/execution-model.md) and [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md).

Because `@relavium/core` has **zero platform-specific imports**, the engine cannot itself touch the filesystem, spawn a process, or open a socket. It owns the tool **policy and dispatch** (registration, exact-match resolution, argument validation, the guardrails below, result bounding, untrusted-data tainting) and performs every side effect through a host-injected **`ToolHost`** capability seam — the same purity seam as the `read_file` interpolation filter ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)'s injected transport, generalized). The seam, the dispatch lifecycle, and the `ToolDef` shape are canonical in [tool-registry.md](tool-registry.md); the decision is [ADR-0037](../../decisions/0037-engine-tool-execution-boundary.md).
