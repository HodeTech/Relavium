# Reference — Shared Core

Canonical shapes, catalogs, and contracts exported by the two engine packages —
`packages/core` (the pure-TypeScript `@relavium/core` workflow engine: store
shapes, node types, built-in tools, MCP) and `packages/llm` (the `@relavium/llm`
provider-agnostic LLM seam) — the internals that every surface consumes.
Explanation lives in
[architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)
and [architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md);
these files are the dry reference.

Part of [reference/](../README.md).

| File | Reference |
|------|-----------|
| [llm-provider-seam.md](llm-provider-seam.md) | The provider-agnostic `LLMProvider` seam in `@relavium/llm` — the immovable contract no vendor SDK type may cross (request/result/stream types, normalization rules). |
| [store-shapes.md](store-shapes.md) | The five Zustand store shapes (provider, agent, workflow, ui, run). |
| [node-types.md](node-types.md) | The nine canvas node types plus the engine node-type enum and their props. |
| [expression-sandbox-spec.md](expression-sandbox-spec.md) | The deterministic, resource-capped QuickJS-wasm sandbox contract for `condition` / `transform` / `merge_fn` — scope, allow-list, determinism, caps, and the `sandbox_error` taxonomy (1.AB / [ADR-0027](../../decisions/0027-expression-sandbox.md)). |
| [run-plan.md](run-plan.md) | The `RunPlan` the DAG builder (1.M) compiles from a validated workflow — engine vertices, topological order, dependency edges, per-type config. |
| [built-in-tools.md](built-in-tools.md) | Built-in tools available to local agents (read_file, run_command, web_search, git, …). |
| [mcp-integration.md](mcp-integration.md) | MCP: agents as MCP servers, and agents consuming MCP tools. |
