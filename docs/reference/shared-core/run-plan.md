# Run Plan

- **Status**: Stable
- **Canonical home**: the executable plan the DAG builder (1.M) compiles from a validated workflow and the run loop (1.N) / `AgentRunner` (1.O) execute.
- **Related**: [node-types.md](node-types.md), [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [../../architecture/execution-model.md](../../architecture/execution-model.md), [../../architecture/shared-core-engine.md](../../architecture/shared-core-engine.md)

The **`RunPlan`** is the compile step between *parsing* a workflow and *running* it: `buildRunPlan` (in `@relavium/core`) turns the validated `WorkflowDefinition` (the output of `parseWorkflow`, 1.L/1.L2) into a deterministic, topologically ordered plan of **engine vertices**, fully wired and ready to dispatch. Parsing answers *“is this file valid?”*; the plan answers *“in what order, with what dependencies, with what config does each node run?”* — so the run loop can be a thin dispatcher.

```mermaid
flowchart LR
  YAML[".relavium.yaml"] -->|parse + validate + taint gate<br/>(1.L / 1.L2)| DEF["WorkflowDefinition"]
  DEF -->|buildRunPlan<br/>(1.M)| PLAN["RunPlan"]
  PLAN -->|run loop<br/>(1.N / 1.O)| EVENTS["run events"]
```

## Where it lives — core type, not a shared schema

The `RunPlan` is a **core-only TypeScript type** (`@relavium/core`), deliberately **not** a `@relavium/shared` Zod schema. `@relavium/shared` owns the *authored and persisted* contracts (workflow / agent / run-event / config); the plan is an **internal, runtime-derived engine artifact** — a topological order, dependency adjacency, and attached un-evaluated templates. It is never serialized in Phase 1 (checkpoint/resume reconstructs it from the workflow + checkpoint, ADR-0027), so it is not a wire contract and does not belong in the shared schema set (CLAUDE.md rule 8 — one canonical home per artifact; this page is the plan's home). It would be promoted to a shared schema only if a future phase persists the plan itself.

## The vertex model

A plan is a `workflowId`, a topological `order` (vertex ids), a `vertices` map, and the run-wide `maxParallel` cap (`workflow.max_parallel`, when declared). Each **`PlanVertex`** carries:

| Field | Purpose |
|-------|---------|
| `id` | The authored node id — also the vertex id (no synthetic vertices are created). |
| `type` | The **engine** node type ([node-types.md §engine enum](node-types.md)) — `parallel`→`fan_out`, `merge`→`fan_in`, `human_gate`→`human_in_the_loop`; the rest keep their authored type. |
| `dependencies` | Vertex ids this vertex depends on (its in-edges) — drives the run loop's completion-gated readiness. |
| `dependents` | Vertex ids that depend on this one (its out-edges) — drives skip-propagation past an untaken `condition` branch. |
| `inputSites` | The vertex's own **un-evaluated** `{{ … }}` template sites — *what to resolve*, never resolved values (see below). |
| `config` | The per-type config block, discriminated on `kind` (the engine vertex type), mirroring the [per-type engine config](node-types.md#per-type-engine-config). |

### A plan carries *what to resolve*, never *resolved values*

Planning is pure and runs **once, before any node executes**, so upstream node outputs do not exist yet. A vertex's `inputSites` are therefore the structured, un-evaluated `{{ … }}` templates (1.L/1.L2) — the run loop and `AgentRunner` resolve them at **dispatch** against settled upstream results (`run.outputs`). The plan never holds an evaluated input.

## `parallel` / `merge` → `fan_out` / `fan_in` (the split-join pair)

The conceptual fan-out/fan-in pair is realized across **two authored nodes**, not synthesized by the builder:

- an authored **`parallel`** node → a **`fan_out`** vertex (`config.branchNodeIds` = the authored `parallel_of`, authoritative for branch membership);
- an authored **`merge`** node → a **`fan_in`** vertex (`config.mergeStrategy` = the authored `merge_strategy`; `config.joinStrategy` is **derived** — `wait_first` for `merge_strategy: first`, else `wait_all`).

The author brackets the branches with explicit edges (`parallel → branches → merge`), exactly as in [workflow-yaml-spec.md §Complete example](../contracts/workflow-yaml-spec.md#complete-example). The builder synthesizes **no** extra join vertex — a `parallel` whose branches do not converge on a `merge` simply has no fan-in. (This is the precise reading of [node-types.md](node-types.md)'s `parallel → fan_out + fan_in` reconciliation: the pair spans the authored `parallel` *and* `merge` nodes.) `join_strategy: wait_n` and `merge_strategy: best_of_n` are reserved engine slots with no v1.0 authored surface and are never produced.

### Fan-in branch order

A `fan_in` vertex carries `config.branchNodeIds` — the branch ids in the **stable order** the run loop must surface them to a `custom` `merge_fn` (the sandbox's `ExpressionScope.branches`) and to a `concat` result. It is the paired `parallel`'s **`parallel_of` declaration order** when the merge joins exactly that parallel's branches (the common authored shape), with any extra non-parallel incoming branches appended in authored order; with no unique paired parallel, it is the merge's incoming branches in authored order. This is needed because a vertex's `dependencies` are sorted by **authored index**, which is *not* `parallel_of` order — so neither the run loop nor the sandbox could reconstruct the contract order from the vertex alone. Pinning it on the plan keeps the merge **deterministic** (a reproducible `merge_fn`/`concat` is required for checkpoint/resume, ADR-0027).

A branch a `condition` routed away from is **skipped** by the run loop's skip-propagation ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)). A skipped branch **counts as settled** against the join — so a `wait_all` fan-in fires instead of hanging on it — and is **omitted** from the `branches` array surfaced to `merge_fn` / `concat`, preserving the *relative order* of the surviving branches; a fan-in all of whose branches were skipped is itself skipped.

> **Retry is not lifted onto the plan.** Unlike an agent's `fallbackChain` (lifted onto `AgentPlanConfig` for the run loop's convenience), a node's `retry_config` is **not** copied onto the vertex. The run loop (1.N) makes no retry decision: a node failure is terminal only for that **attempt**, which — *without 1.S* — fails the run. Node-level retry above the provider fallback chain is layered by **1.S**, which reads `retry_config` from the authored node (`config.node`) and re-attempts before a node is considered finally failed.

## The dependency graph

The builder unions three edge sources into one DAG over node ids:

1. **Structural edges** — `workflow.edges[]` (the base node id of a `nodeId:handle` `from` is recovered by splitting on the first `:`).
2. **Materialized routing edges** — one `parallel → member` edge per `parallel_of` entry, and one `condition → target` edge per `branches[].target_node` and `default`. Authored routing carries a real dependency even when the redundant explicit `nodeId:handle` edge is omitted, so a cycle through a branch is caught and a `condition`'s `dependents` are populated for the run loop's skip-propagation.
3. **Data edges** — every `{{run.outputs["<id>"]}}` reference in a **template** field (an agent's `prompt_template`/`system_prompt_append`, a gate's `assignee`/`message_template`, and a resolved agent's `system_prompt`) makes the referencing node depend on the producer, so a consumer is ordered after its referenced producer **even without an explicit edge**. A *template* reference to a non-existent producer adds no edge and no build error — the runtime resolver raises `unresolved_reference` at dispatch. The builder *likewise* does not order `run.outputs` reads in the **JS-expression** fields (`condition`/`transform`/`merge_fn`, sandbox-owned, 1.AB) — but the symmetry is builder-non-validation only: those are not templates and never produce `unresolved_reference`. **Hazard:** because a JS-expression `run.outputs` read is *not* ordered, a `condition`/`transform`/`merge_fn` that reads a producer it is not transitively ordered after (via structural/materialized/template edges) sees `undefined` — a *dereferencing* read throws (a loud `runtime` `sandbox_error`), but a *non-dereferencing* comparison (`run.outputs["x"] === "ready"`) silently evaluates against `undefined` and can mis-route. v1.0 relies on the author ordering such producers with an explicit edge; the 1.P handler may later fail closed on an unsettled reference. The builder validates the authored *graph*, not data-reference targets.

The order is computed by **Kahn's algorithm** with an **authored-order tie-break**, so the plan is fully deterministic (reproducible byte-for-byte — required for checkpoint/resume and retry-from-node, ADR-0027). A graph that does not fully linearize has a **cycle**.

## What the builder validates

The builder owns the structural checks the pure parser defers (it has the full node graph; the parser sees one file). Each fault becomes a field-named, secret-free `GraphIssue` (`kind`: `cycle` | `unknown_edge_target` | `invalid_handle` | `dangling_ref`), collected and thrown together as a **`WorkflowGraphError`** (code `invalid_graph`) — a sibling of `WorkflowValidationError`, so an unrunnable graph is rejected before a run starts:

- **Cycle** — the dependency graph has a directed cycle; the message names it (`a → b → c → a`).
- **Unknown edge target** — an `edges[]` endpoint, a `condition` `branches[].target_node` / `default`, or a `parallel_of` member names a node that does not exist.
- **Invalid handle** — a `nodeId:handle` edge whose source is not a `condition`, or whose handle matches no branch `when` value (the only named output handles in v1.0; `fan_out` uses plain edges).
- **Dangling ref** — an `agent_ref` resolves to no agent. Only checked when a **resolved-agent registry** is supplied (`agent_ref` resolution against the workspace registry is a host concern — the pure builder never reads files); otherwise resolution is deferred.

Separately, a resolved `$ref`/registry agent's `system_prompt` is re-run through the secret-taint gate (a `$ref` agent's prompt lives in another file the pure parser never reads): a secret reaching it throws **`WorkflowSecretLeakError`** (ADR-0029(c)), exactly as for an inline agent.

## Purity

Like the parser, `buildRunPlan` is **pure and synchronous** — it reads structure only, touches no filesystem, no environment, and holds no state, so it runs identically in Node, the Tauri WebView, the VS Code host, and Bun (CLAUDE.md rule 5). File-bound work (resolving a `$ref` agent) is the host's: it reads and validates the agent, then passes the resolved data in.
