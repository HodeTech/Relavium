# Reference — Contracts

The wire- and file-level contracts that every surface (desktop, CLI, VS Code,
portal) must agree on. Each file here is the single canonical home for its
artifact; explanation and tutorials cite these specs rather than restating them.

Part of [reference/](../README.md).

| File | Contract |
|------|----------|
| [workflow-yaml-spec.md](workflow-yaml-spec.md) | The canonical `.relavium.yaml` workflow file format (v1.0) — nodes, edges, triggers, inputs. |
| [agent-yaml-spec.md](agent-yaml-spec.md) | The `.agent.yaml` agent definition — model, provider, system prompt, retry, fallback chain. |
| [sse-event-schema.md](sse-event-schema.md) | The run event stream schema (HTTP SSE in Phase 2; same events over a Tauri channel in Phase 1). |
| [ipc-contract.md](ipc-contract.md) | Tauri IPC commands + event channel between the Rust backend and the React WebView. |
| [config-spec.md](config-spec.md) | Global `~/.relavium/` and per-project `.relavium/` configuration resolution. |
