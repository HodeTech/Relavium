# VS Code Extension API (`relavium.*`)

> Last updated: 2026-06-05

- **Status**: Reference (partial — surface defined, exact contribution points to be finalized as the extension is built)
- **Surface**: VS Code extension (`relavium`)
- **Scope**: Phase 1, local-first. Standalone — bundles the same `@relavium/core` engine in-process; no desktop app required.
- **Related**: [../cli/commands.md](../cli/commands.md), [../desktop/routes-and-screens.md](../desktop/routes-and-screens.md), [../desktop/keychain-and-secrets.md](../desktop/keychain-and-secrets.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md), [../contracts/agent-session-spec.md](../contracts/agent-session-spec.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../contracts/ipc-contract.md](../contracts/ipc-contract.md), [../contracts/config-spec.md](../contracts/config-spec.md), [../shared-core/built-in-tools.md](../shared-core/built-in-tools.md), [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md), [../../architecture/agent-sessions.md](../../architecture/agent-sessions.md), [../../decisions/0024-agent-first-entry-point-agentsession.md](../../decisions/0024-agent-first-entry-point-agentsession.md), [../../decisions/0025-agent-surface-refines-desktop-scope.md](../../decisions/0025-agent-surface-refines-desktop-scope.md), [../../tutorials/vscode/trigger-from-vscode.md](../../tutorials/vscode/trigger-from-vscode.md)

The VS Code extension is the editor surface of the platform — both a **conversational coding assistant** (a multi-turn [agent session](../contracts/agent-session-spec.md) in the editor) and the zero-friction path for triggering a workflow on the file you are already looking at. Both entry points run **in-process** against the same bundled `@relavium/core` engine in the VS Code extension host's Node.js process, so a developer can install it and chat with an agent or run their first workflow without any other Relavium software (see [the shared-core engine design](../../architecture/shared-core-engine.md) and [ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)). Because the engine is pure TypeScript with no native bindings, it runs safely inside the extension host.

This page is the canonical reference for the extension's **public surface**: the commands, events, and settings it contributes. The wire/file contracts it consumes (workflow YAML, agent YAML, the `RunEvent` stream) are owned by their [contract docs](../contracts/) and only referenced here.

## Connection model — standalone, desktop-enhanced

```mermaid
flowchart LR
  subgraph Host["VS Code extension host"]
    EXT[relavium extension]
    ENG["@relavium/core engine (bundled, in-process)"]
    EXT --> ENG
  end
  ENG -->|direct HTTPS| LLM[LLM provider APIs]
  EXT -.optional, if running.->|loopback IPC| DESK[Relavium desktop app]
```

The extension follows a **hybrid** model: standalone for all execution, with the desktop app as an optional enhancement.

- **Standalone (default):** the bundled engine executes workflows entirely in the extension host. LLM calls go **directly** from the extension host to provider APIs — the desktop app is never a proxy or a single point of failure.
- **Desktop-enhanced (optional):** at activation the extension discovers a running desktop app via the loopback handshake (it reads the desktop-written `~/.relavium/ipc.json` for the dynamic port and bearer token — canonical in [ipc-contract.md](../contracts/ipc-contract.md#vs-code-mirror-loopback-http)) and runs a short health check. If present, enhanced features unlock — `relavium.openWorkflowInDesktop` jumps to the visual canvas, and run status can sync. If the desktop app is not detected, the extension silently continues in standalone mode with no user-visible degradation. No raw key ever transits this channel (see [Security model](#security-model)).

The engine, workflow files, and run-event stream are shared verbatim across surfaces, so a run behaves identically whether launched from the editor, the [CLI](../cli/commands.md), or the [desktop canvas](../desktop/routes-and-screens.md).

## Activation

The extension declares a minimal `activationEvents` set — it activates only when a `.relavium/` folder is present in the workspace (`workspaceContains:.relavium`) — so it consumes no memory in unrelated projects.

## Core capabilities

| Capability | What it does | Primitive |
|------------|--------------|-----------|
| **Right-click run** | Run a workflow on the active file (editor/explorer context menu, plus a keybinding). Compatible workflows are filtered by their input schema and shown in a QuickPick. | `contributes.menus` (`editor/context`, `explorer/context`) → `relavium.runWorkflowOnFile` |
| **Status-bar run monitor** | Passive awareness of background runs: idle (hidden), running (`$(loading~spin) N runs active`), awaiting-human (`$(bell)` amber), completed/failed. Clicking opens the Active Runs view. | `vscode.StatusBarItem` (right, priority 100) |
| **Sidebar** | A `relavium` view container with three TreeViews: **Workflows** (from `.relavium/*.relavium.yaml`, grouped by tag, last-run status), **Agents** (from `.relavium/agents/*.agent.yaml`), and **Active Runs** (live, expandable to per-node status with inline `[Approve]`/`[Reject]`). | `contributes.views` + `TreeDataProvider` |
| **Command palette** | All commands grouped under the "Relavium" category for discovery and keyboard-driven use. | `contributes.commands` |
| **Chat panel (agent session)** | A full conversational coding assistant in a `WebviewPanel` (React/Preact UI, **not** the Copilot-specific `vscode.chat` API): a multi-turn [agent session](../contracts/agent-session-spec.md) bound to one agent + its fallback chain, driven by the bundled engine. Auto-detects the active file, selection, workspace root, and git branch as the session [`SessionContext`](../contracts/agent-session-spec.md#session-context). Conversations **auto-persist and resume** from the local `history.db` (no separate store), and any session can be exported to a `.relavium.yaml` scaffold for review — the **same** persistence + export contract as the [CLI `relavium chat`](../cli/commands.md) and the [desktop Chat tab](../desktop/routes-and-screens.md), so a session started in any surface continues in the editor. From the same panel a user can also invoke a workflow in natural language. | `WebviewPanel` + bundled `AgentSession` |
| **Inline diff review** | Agent-proposed file changes (`file_patch` output) open in VS Code's native diff editor with per-hunk `[Accept]`/`[Reject]` CodeLens. **No file is written until explicitly accepted.** | `vscode.diff` + CodeLens + `WorkspaceEdit` |
| **Workflow YAML IntelliSense** | Completion, hover, diagnostics, and go-to-definition for `.relavium/` config files, via a dedicated language server. | LSP (see below) |

### Inline diff review flow

This is the extension's core trust boundary. When a workflow emits an output of type `file_patch`:

1. A `filePatchProposed` event fires with `{ runId, nodeId, patches: FilePatch[] }` where `FilePatch = { uri, unifiedDiff }`.
2. The proposed content is built in an in-memory document by applying the unified diff to the current file (the `diff` package is already in the engine).
3. `vscode.diff(original, proposed, 'Agent Proposal: <file>', { preview: true })` opens the native diff editor.
4. A CodeLens provider injects `[Accept] [Reject]` (and `[Open in Designer]` when the desktop app is present) above each changed hunk.
5. **Accept** applies a `WorkspaceEdit`; **Reject** discards the proposed document.
6. Multi-file changes are summarized in a sidebar TreeView with per-file accept/reject and a global `[Accept All]`.

Agent-proposed writes are **never** applied automatically — they always go through this accept flow.

### Chat-session persistence and export parity

The chat panel is the editor projection of an `AgentSession`; the persistence and export behavior is not invented per-surface — it is **inherited** from the one shared engine entry point, so the editor, CLI, and desktop share identical session semantics. For *why* sessions auto-persist, resume, and export to a reviewable scaffold rather than living in volatile webview state, see [agent-sessions.md](../../architecture/agent-sessions.md); the exact runtime contract (lifecycle, message shape, context, export mapping) is canonical in [agent-session-spec.md](../contracts/agent-session-spec.md).

- **Persist + resume.** Every turn is written to the global encrypted `history.db` (`agent_sessions` / `session_messages`, canonical in [database-schema.md](../desktop/database-schema.md)) as it happens. Re-opening the panel resumes the active session; `relavium.resumeChatSession` reloads any past one by id. There is no separate `sessions.db` and no extension-host session store — the panel is a thin view over the durable session.
- **Export to a scaffold.** `relavium.exportChatSession` serializes the session to a `.relavium.yaml` **scaffold** — a linear chain of `agent` nodes plus the transcript as metadata — opened for review (via the [inline diff review flow](#inline-diff-review-flow)) before it is written into `.relavium/`. This is the exact contract owned by [ADR-0026](../../decisions/0026-session-export-to-workflow.md) and produced identically by the [CLI `relavium chat-export`](../cli/commands.md). Parallel/condition/loop topologies are **not** auto-extracted.
- **One agent per session.** A chat session binds a single agent and its fallback chain for the whole conversation; there is no mid-session agent switching in Phase 1 (matching every surface).

## Commands (`relavium.*`)

| Command | Purpose |
|---------|---------|
| `relavium.openChat` | Open the [chat panel](#core-capabilities) and start (or focus) an interactive [agent session](../contracts/agent-session-spec.md), optionally for a given `agentRef`. Auto-detects the editor [`SessionContext`](../contracts/agent-session-spec.md#session-context). |
| `relavium.resumeChatSession` | Reload a persisted session from `history.db` by `sessionId` into the chat panel and continue the conversation. |
| `relavium.exportChatSession` | Export the current (or a given) chat session to a `.relavium.yaml` scaffold for review before writing — the [ADR-0026](../../decisions/0026-session-export-to-workflow.md) export contract. |
| `relavium.runWorkflow` | Fuzzy-search and run a workflow with optional input payload. Returns a `RunHandle` (with `.on()` for [events](../contracts/sse-event-schema.md) and `.cancel()`). |
| `relavium.resumeBudget` | Resume a run suspended at a budget cap (`budget:paused`) — the VS Code operator path for [ADR-0028](../../decisions/0028-workflow-resource-governance.md)'s `resume_budget`, surfaced from the Active Runs view. |
| `relavium.runWorkflowOnFile` | Run a workflow on a specific file URI; auto-selects compatible workflows. Backs the right-click action. |
| `relavium.createAgent` | Open the agent-creation wizard (multi-step input); returns the new agent config. |
| `relavium.openWorkflowInDesktop` | Open a workflow by id in the desktop canvas. No-op (gracefully) if the desktop app is not running. |
| `relavium.showRunHistory` | Open the run-history panel for a workflow id. |
| `relavium.cancelRun` | Cancel a running workflow by run id. |
| `relavium.approveHumanGate` | Approve or reject a pending human gate, with an optional note. |
| `relavium.getActiveRuns` | Return an array of active-run objects for programmatic consumers. |
| `relavium.refreshWorkflows` | Force-reload workflow/agent definitions from disk (after external edits). |
| `relavium.exportRunTrace` | Export a run's full execution trace as JSON (secret references stripped). |

## Events

The extension exposes an **open event API** so other extensions can subscribe to runs, intercept proposed changes, or trigger workflows programmatically. All events are namespaced `relavium.*`.

| Event | Payload |
|-------|---------|
| `relavium.onRunStarted` | `{ runId, workflowId, workflowName, input }` |
| `relavium.onRunCompleted` | `{ runId, workflowId, output, durationMs, costMicrocents }` |
| `relavium.onRunFailed` | `{ runId, workflowId, error, nodeId }` |
| `relavium.onHumanGatePending` | `{ runId, nodeId, promptText, timeoutMs }` |
| `relavium.onFilePatchProposed` | `{ runId, nodeId, patches: FilePatch[] }` — fires **before** any diff is applied; consumers can intercept and cancel |
| `relavium.onAgentTokenStream` | `{ runId, nodeId, agentId, token }` — high-frequency; subscribe sparingly |
| `relavium.onWorkflowsChanged` | Fires when `.relavium/` files change on disk |
| `relavium.onChatSessionStarted` | `{ sessionId, agentRef, model, context }` — a chat agent session opened (projects `session:started`) |
| `relavium.onChatMessageReceived` | `{ sessionId, sequenceNumber, role, durationMs, costMicrocents }` — an assistant turn completed (projects `session:turn_completed`); transcript content stays in the panel/`history.db`, not the event payload |
| `relavium.onChatSessionExported` | `{ sessionId, workflowPath }` — a session was exported to a `.relavium.yaml` scaffold (projects `session:exported`) |

> These events are a thin, VS Code-friendly projection of the canonical [`RunEvent`](../contracts/sse-event-schema.md) / [`SessionEvent`](../contracts/sse-event-schema.md#session-event-namespace) streams — same data, surfaced through `vscode.EventEmitter`. The `relavium.onChat*` events project the engine's disjoint `session:*` namespace (keyed by `sessionId`); the `relavium.onRun*` events project the `run:*`/`node:*`/`agent:*` namespaces (keyed by `runId`). Cost is reported in integer micro-cents, consistent with the [local database](../desktop/database-schema.md).

## Settings (`relavium.*`)

Configured in VS Code settings (`settings.json`); all namespaced `relavium.*`.

| Setting | Default | Purpose |
|---------|---------|---------|
| `relavium.workflowsPath` | `.relavium` | Path to the workflow folder, relative to the workspace root. |
| `relavium.desktopAppPort` | `57210` | Optional override for the desktop app's loopback port; normally the port is discovered automatically from `~/.relavium/ipc.json` (see [ipc-contract.md](../contracts/ipc-contract.md#vs-code-mirror-loopback-http)). |
| `relavium.autoShowOutputOnRun` | `true` | Auto-focus the run output channel when a run starts. |
| `relavium.maxConcurrentRuns` | `3` | Max simultaneous workflow runs in the extension host. |
| `relavium.humanGateNotificationSound` | `true` | Play a sound when a human gate opens. |
| `relavium.diffAutoOpen` | `true` | Automatically open the diff view when an agent proposes file changes. |
| `relavium.streamingBatchIntervalMs` | `100` | How often to flush streamed tokens to the output channel. |
| `relavium.telemetry` | `false` | Opt-in usage telemetry. Off by default. |
| `relavium.logLevel` | `warn` | Extension-host log verbosity: `error` \| `warn` \| `info` \| `debug`. |
| `relavium.providerTimeout` | `120` | Per-LLM-call timeout, in seconds. |
| `relavium.chat.defaultAgent` | _(unset)_ | Agent ref a new chat session binds when none is named; falls back to the workspace `[chat]` default. |
| `relavium.chat.defaultModel` | _(unset)_ | Model a chat session uses when its agent names none; overrides the workspace `[chat].default_model` ([config-spec.md](../contracts/config-spec.md)). |
| `relavium.chat.maxMessages` | `200` | Session-history cap before older turns are trimmed/summarized; mirrors `[chat].max_messages`. |
| `relavium.chat.autoOpenPanel` | `false` | Whether to open the chat panel on activation. Off by default — Chat is one-click reachable, never force-opened. |

> Chat-session settings override the workspace `[chat]` block whose canonical home is [config-spec.md](../contracts/config-spec.md); they do **not** redefine the filesystem-scope tier enum or a command allowlist — a chat session reuses `[defaults].fs_scope` and the workflow `allowedCommands` policy, exactly as the [config-spec `[chat]` block](../contracts/config-spec.md) documents. API keys are **never** stored in `settings.json` (it is readable by every extension). See [Security model](#security-model).

## Language server

Editing `.relavium/` YAML by hand is a first-class experience, powered by a dedicated language server. The server runs as a **separate** Node.js process (spawned via `vscode-languageclient/node`) so CPU-intensive YAML + schema validation never blocks the extension-host event loop. It builds on `yaml-language-server` extended with a schema provider that generates live JSON Schema from the actual agents and workflows in the workspace's `.relavium/` folder (regenerated on file-watcher events).

`DocumentSelector`: `{ scheme: 'file', pattern: '**/.relavium/**/*.{yaml,yml,json}' }`.

| LSP capability | Behavior |
|----------------|----------|
| **Completion** | Agent-id completions (from the agent registry), model-id completions (with provider prefix + context window in the detail), and node-reference completions inside interpolation expressions. Trigger chars: `:`, `$`, `{`. |
| **Hover** | Hovering an `agentId` shows the agent's model/system-prompt preview/tools; a `modelId` shows provider, context window, and per-token cost; a node reference shows its type and label. |
| **Diagnostics** | Missing required fields (Error), unknown `agentId` references (Error), cyclic graphs via DFS with a path trace (Error), unreachable nodes (Warning), `human_gate` with no timeout (Warning), deprecated model ids (Information). Refresh on save and on a 250 ms debounced keystroke. |
| **Go-to-definition** | `F12` on an `agentId` opens its `.agent.yaml`; on a `modelId` opens the provider's models section; on a node reference jumps to that node in the same file. |
| **Code actions** | Quick-fixes: *Create missing agent*, *Remove unreachable node*, *Add default human-gate timeout*. |
| **Rename** | Renaming an `agentId` updates every workflow that references it via a cross-file `WorkspaceEdit`. |
| **Folding** | Collapses node definitions, edge lists, and long `system_prompt` multiline strings. |
| **Semantic tokens** | Distinct colors for `agentId` values, node references, and interpolation expressions. |

The canonical schema these capabilities validate against is [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md) and [agent-yaml-spec.md](../contracts/agent-yaml-spec.md).

## Run visualization

While a run executes, the active agent is shown through three simultaneous channels: a spinning codicon on the Active Runs tree node (auto-revealed), a gutter decoration on the file being processed, and a truncated status-bar label. Streaming output goes to a per-run `OutputChannel` for non-interactive runs and renders in the chat panel's React UI for interactive ones (tokens batched on a flush interval — `relavium.streamingBatchIntervalMs` — to avoid UI jank).

A pending [`human_gate:paused`](../contracts/sse-event-schema.md) surfaces in up to three places depending on context: inline `[Approve]`/`[Reject]` buttons on the Active Runs tree node, an amber status-bar item that opens an approval QuickPick, and (for chat-triggered runs) an inline approval card. All three dispatch to the same resume action; if the gate has a timeout, a draining progress indicator is shown and the node's `timeout_action` applies on expiry.

## Security model

The extension operates under a three-tier permission model.

1. **File access** — the extension only reads and writes within the open workspace (`vscode.workspace.workspaceFolders` is the boundary). All file I/O goes through `vscode.workspace.fs` (not Node `fs` directly) so it works in remote workspaces (SSH/WSL/Codespaces). The engine is initialized with a sandboxed root, and every tool path is validated against it before execution. Agent-proposed writes always go through the [diff-and-accept flow](#inline-diff-review-flow).
2. **Terminal command execution** — shell-tool commands run in a **visible** `vscode.Terminal` (no hidden process spawning). The allowlist is the **canonical** `workflow.tools.allowedCommands` (exact-match; opt-in glob via `allowedCommandGlobs`) governed by [ADR-0029](../../decisions/0029-tool-policy-hardening.md) and [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#tool-policy-spectools) — **not** a separate per-extension `permissions.yaml`. A non-matching command prompts a modal `[Allow Once] [Allow Always] [Deny]`; *Allow Always* appends the command to that workflow's `allowedCommands` (or `allowedCommandGlobs` for a pattern), keeping **one** allowlist home across surfaces.
3. **API keys** — keys are stored via `vscode.SecretStorage` (which delegates to the OS keychain: macOS Keychain / Windows Credential Manager / Linux libsecret), **never** in `settings.json`. They are read only when a run starts, passed to the engine's in-memory provider registry, and cleared on completion. Keys are never written into workflow YAML, never included in run-trace exports, and never sent over IPC. The extension is **standalone for key custody**: it holds its own keys in `vscode.SecretStorage` and never requests, receives, or proxies a key over the desktop loopback channel in either direction. The desktop-enhanced loopback link carries only run/status data; its handshake is canonical in [ipc-contract.md](../contracts/ipc-contract.md#vs-code-mirror-loopback-http) (see also [keychain-and-secrets.md](../desktop/keychain-and-secrets.md)).

## Phase 2 note

> In Phase 2 the extension can target cloud execution by setting `relavium.executionMode = 'cloud'` (after authenticating via the portal). The engine interface is identical in both modes, so the extension requires no code changes — `RunEvent` objects arrive over HTTP SSE instead of the in-process bus. See [../portal/api-reference.md](../portal/api-reference.md) and [../../architecture/cloud-phase-2.md](../../architecture/cloud-phase-2.md).
