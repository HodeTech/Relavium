# Reference

This quadrant is the **single source of truth** for every Relavium contract, schema, and shape. It answers one question: *What exactly is the contract?*

Reference docs are deliberately DRY. Each artifact (workflow file format, agent file format, event schema, IPC commands, config resolution, store shapes, node types, tools, MCP wiring) has **one canonical home here**. Architecture docs, tutorials, and runbooks link to these pages by relative path rather than restating them. If you change a contract, change it here and let everything else point at it.

For pinned versions of the libraries referenced below, see [tech-stack.md](../tech-stack.md). For the rationale behind these contracts, see the [architecture/](../architecture/README.md) docs and the [decisions/](../decisions/README.md) ADRs.

## Contracts

The wire- and file-level agreements between surfaces, the engine, and the user's git repo.

| Doc | Purpose |
| --- | --- |
| [contracts/workflow-yaml-spec.md](contracts/workflow-yaml-spec.md) | The canonical `.relavium.yaml` workflow file format (v1.0) — fields, node types, edges, triggers, interpolation, full example. |
| [contracts/agent-yaml-spec.md](contracts/agent-yaml-spec.md) | The `.agent.yaml` / inline agent schema — model, provider, system prompt, retry, fallback chain. |
| [contracts/agent-session-spec.md](contracts/agent-session-spec.md) | The `AgentSession` runtime contract — the agent-first entry point: lifecycle, message shape, context, and export-to-workflow contract. |
| [contracts/sse-event-schema.md](contracts/sse-event-schema.md) | The run event stream contract (`RunEvent`) — every surface consumes the same events; Phase 1 over IPC, Phase 2 over HTTP SSE. |
| [contracts/ipc-contract.md](contracts/ipc-contract.md) | Tauri IPC surface between the Rust backend and the React WebView — commands, channels, events. |
| [contracts/config-spec.md](contracts/config-spec.md) | Global `~/.relavium/` and per-project `.relavium/` config files and their resolution order. |

## Shared core (`@relavium/core`)

The engine internals that every surface shares. See [architecture/shared-core-engine.md](../architecture/shared-core-engine.md) for the design narrative.

| Doc | Purpose |
| --- | --- |
| [shared-core/store-shapes.md](shared-core/store-shapes.md) | The five Zustand stores and their TypeScript shapes; the canvas/run store separation that protects streaming performance. |
| [shared-core/node-types.md](shared-core/node-types.md) | The canvas + engine node-type catalog — visual node components and the engine node-type enum. |
| [shared-core/built-in-tools.md](shared-core/built-in-tools.md) | Tools available to local agents out of the box (`read_file`, `run_command`, `git_*`, `mcp_call`, `invoke_agent`, …). |
| [shared-core/mcp-integration.md](shared-core/mcp-integration.md) | MCP in both directions — agents as MCP servers, and agents consuming MCP tools. |

## Per-surface reference

| Area | Doc | Purpose |
| --- | --- | --- |
| Desktop | [desktop/database-schema.md](desktop/database-schema.md) | Local SQLite run-history schema (Drizzle). |
| Desktop | [desktop/keychain-and-secrets.md](desktop/keychain-and-secrets.md) | OS keychain usage and the encrypted-file fallback. |
| Desktop | [desktop/tauri-plugins.md](desktop/tauri-plugins.md) | Tauri v2 plugins and capability manifest. |
| Desktop | [desktop/routes-and-screens.md](desktop/routes-and-screens.md) | TanStack Router routes and screens. |
| CLI | [cli/commands.md](cli/commands.md) | `relavium` subcommands and flags. |
| VS Code | [vscode/extension-api.md](vscode/extension-api.md) | Extension commands, events, and settings (`relavium.*`). |
| Portal (Phase 2) | [portal/api-reference.md](portal/api-reference.md) | Cloud REST API surface. |

> The per-surface files above are owned by other writers; this hub lists them so the reference quadrant reads as one map.
