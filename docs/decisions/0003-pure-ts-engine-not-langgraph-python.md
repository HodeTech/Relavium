# ADR-0003: Pure TypeScript workflow engine, not LangGraph-Python

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [tech-stack.md](../tech-stack.md)

## Context

The workflow engine is the critical path of the whole product: it parses a workflow definition, executes nodes (agent calls, conditionals, loops, parallel branches, human gates, sub-workflows — the catalog lives in [reference/shared-core/node-types.md](../reference/shared-core/node-types.md)), streams [run events](../reference/contracts/sse-event-schema.md), and persists run state for resumption.

The decisive constraint is that **the same engine must run in four different hosts**: the Tauri desktop app, the CLI (Node.js), the VS Code extension (the extension host has Node.js but no arbitrary native modules), and — in Phase 2 — cloud workers (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)). It lives in `packages/core` and is consumed by all of them through one `WorkflowEngine` interface (see [architecture/shared-core-engine.md](../architecture/shared-core-engine.md) and the [store shapes](../reference/shared-core/store-shapes.md)).

A natural temptation is to reach for LangGraph-Python as the orchestrator. That would force a Python runtime alongside the TypeScript surfaces and a language boundary on the hottest path in the system.

## Decision

**We build a pure TypeScript workflow engine in `packages/core`**, with no Python runtime and no Python sidecar. There is no LangGraph-Python in the architecture.

Considered options:

1. **Pure TypeScript engine in `packages/core`** — one language across engine and surfaces; runs anywhere Node/V8 runs. *Chosen.*
2. **LangGraph-Python orchestrator behind a sidecar/IPC boundary** — reuse a mature graph framework.
3. **A heavyweight durable-execution engine (e.g. Temporal)** — framework-managed durability and resumption.

A pure TypeScript engine wins for two reasons. First, **portability**: it has no native bindings, so it runs identically in the VS Code extension host (which cannot load arbitrary native modules), the CLI, the Tauri WebView's backing Node context, and Phase-2 cloud workers. A Python engine would require shipping and managing a Python runtime inside every surface — a non-starter for the VS Code extension and a heavy burden for a 2–5 MB Tauri app (see [ADR-0001](0001-tauri-v2-over-electron.md)).

Second, **LangGraph adds failure surface rather than removing it for this design**. The adversarial review found that LangGraph's value is durable, cyclic, checkpointed agent graphs — but Relavium already defines its own run-state model, its own execution plan (topological sort + segment detection), its own retry budget, its own human-gate state, and its own context-compression strategy. LangGraph would add a *second* state machine (its `StateGraph` + checkpointer) that must be kept synchronized with ours, forcing us to debug two state machines and to express the graph topology twice (once as the user's YAML, once as LangGraph node/edge declarations). A plain async orchestrator — a loop over the static execution plan, `Promise.all` for parallel branches, a dispatch table keyed by node type, conditional edges as plain branching on structured node output, and run state written to the store after each node — covers the use cases in well under the complexity of a framework, and is testable without mocking one. The same concepts (graph, state, checkpoints) are implementable directly in TypeScript.

The engine pairs with the multi-LLM layer in [ADR-0011](0011-internal-llm-abstraction.md), which is also pure TypeScript, so the entire execution path is one language. We would only revisit a framework if workflows must survive mid-node process crashes and resume durably, or if topology becomes genuinely dynamic at run time — at which point durable-execution engines (Temporal-class) are a stronger fit than LangGraph and would be evaluated directly. None of those are current requirements. Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- One engine, one language: `packages/core` runs unchanged in the desktop app, CLI, VS Code extension, and (Phase 2) cloud workers — the central goal of the shared-core design (see [architecture/shared-core-engine.md](../architecture/shared-core-engine.md)).
- No native bindings, so it loads cleanly in the VS Code extension host and keeps the Tauri bundle tiny.
- A single authoritative run-state model and execution plan — no second framework state machine to keep in sync, and no need to express the graph topology twice.
- The orchestration core stays small, dependency-light, and unit-testable without framework mocking.
- Full control over streaming, retry, and human-gate semantics, matching the [SSE event schema](../reference/contracts/sse-event-schema.md) and [node-types](../reference/shared-core/node-types.md) exactly.

### Negative

- We own and maintain orchestration logic (scheduling, retries, parallel join, compression) that LangGraph would otherwise provide — more code to write and test up front.
- No framework-provided durable checkpointing; resumption across process crashes is something we implement explicitly (run state persisted per node), and if hard durability becomes a requirement we may need to adopt a durable-execution engine later.
- We forgo LangGraph's ecosystem (prebuilt graph patterns, integrations); we accept this because those patterns do not map cleanly onto a user-authored YAML topology.
- TypeScript's agent/LLM tooling ecosystem is younger than Python's; mitigated by the internal `@relavium/llm` abstraction in [ADR-0011](0011-internal-llm-abstraction.md).
