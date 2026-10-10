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
| `ancestors` | The **transitive dependency closure** — every vertex this one is ordered after, in code-unit order. A **different, larger set** than `dependencies` and deliberately not unified with it: `dependencies` answers *what must settle before this dispatches*, `ancestors` answers *what this node is ordered after*, which is what an expression's `run.outputs` visibility is defined by ([ADR-0093](../../decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md) §1). |
| `inputSites` | The vertex's own **un-evaluated** `{{ … }}` template sites — *what to resolve*, never resolved values (see below). |
| `config` | The per-type config block, discriminated on `kind` (the engine vertex type), mirroring the [per-type engine config](node-types.md#per-type-engine-config). |

### A plan carries *what to resolve*, never *resolved values*

Planning is pure and runs **once, before any node executes**, so upstream node outputs do not exist yet. A vertex's `inputSites` are therefore the structured, un-evaluated `{{ … }}` templates (1.L/1.L2) — the run loop and `AgentRunner` resolve them at **dispatch** against settled upstream results (`run.outputs`). The plan never holds an evaluated input.

## `parallel` / `merge` → `fan_out` / `fan_in` (the split-join pair)

The conceptual fan-out/fan-in pair is realized across **two authored nodes**, not synthesized by the builder:

- an authored **`parallel`** node → a **`fan_out`** vertex (`config.branchNodeIds` = the authored `parallel_of`, authoritative for branch membership);
- an authored **`merge`** node → a **`fan_in`** vertex (`config.mergeStrategy` = the authored `merge_strategy`; `config.requestedJoinStrategy` is **derived and read by nothing** — `wait_first` for `merge_strategy: first`, else `wait_all` — it records what the strategy *asked* for, never what the engine does; [ADR-0091](../../decisions/0091-first-means-first-declared-not-first-to-finish.md)).

> **The plan is compile-time-only.** A `RunPlan` is built from the workflow and never serialized — not into a checkpoint, not into a durable event, not into a snapshot. A resume rebuilds it from the same authored YAML. That is why renaming a plan field is not a data migration, and it is the property to check before any future change makes a plan persistent.

The author brackets the branches with explicit edges (`parallel → branches → merge`), exactly as in [workflow-yaml-spec.md §Complete example](../contracts/workflow-yaml-spec.md#complete-example). The builder synthesizes **no** extra join vertex — a `parallel` whose branches do not converge on a `merge` simply has no fan-in. (This is the precise reading of [node-types.md](node-types.md)'s `parallel → fan_out + fan_in` reconciliation: the pair spans the authored `parallel` *and* `merge` nodes.) `join_strategy: wait_n` and `merge_strategy: best_of_n` are reserved engine slots with no v1.0 authored surface and are never produced.

### Fan-in branch order

A `fan_in` vertex carries `config.branchNodeIds` — the branch ids in the **stable order** the run loop must surface them to a `custom` `merge_fn` (the sandbox's `ExpressionScope.branches`) and to a `concat` result. The order is the **paired `parallel`'s `parallel_of` order**, with any incoming branch that parallel does not list appended in authored order; with no pairing, it is the merge's incoming branches in authored order.

**Which parallel pairs is decided by COVERAGE, not by uniqueness or authored position.** Among the parallels all of whose `parallel_of` members are predecessors of this merge (the merge's own id counts as satisfied — a `parallel_of` may name it), the one covering the MOST value-producing predecessors wins; ties go to the authored-first. A candidate covering none never pairs. Earlier wordings said "exactly that parallel's branches" and "no unique paired parallel", which described a different rule: with two parallels over the same branches, or one whose `parallel_of` is a subset of another's, the exact-match/first-match reading gives a different order than the code — and branch order changes the result of `first`, `concat` and a `custom` `merge_fn`. See [ADR-0091](../../decisions/0091-first-means-first-declared-not-first-to-finish.md)'s corrections for why the search is ranked. **Only value-producing predecessors are branches.** A `condition` that routes into the merge (via `branches[].target_node` or `default`), or a `parallel` that names the merge in its `parallel_of`, is a **control edge**: it still gates the join — the merge waits for it, and skip-propagation applies — but it contributes no branch value and is omitted from `branchNodeIds`. A condition produces no output and a `parallel` completes with a control `null`, so counting either as a branch made `first` return a phantom and discard the real branch ([ADR-0091](../../decisions/0091-first-means-first-declared-not-first-to-finish.md), amended 2026-09-03). A merge whose *only* predecessors are non-producing therefore has **zero** branches: `first` → `null`, `concat` → `[]`, `custom` → an empty `branches`, `object_merge` → `{}`.

The same rule governs an `output` vertex: `config.feederNodeIds` carries its **value-producing** dependencies, so a condition routed straight at an `output` does not turn the single-feeder verbatim capture into a keyed wrapper. Producer-ness is decided by the builder, where node types are known, and is a **different set** from the vertex's `dependencies` — do not unify them: `dependencies` answers *what must settle first*, `branchNodeIds`/`feederNodeIds` answer *what carries a value*.

This ordering is needed because a vertex's `dependencies` are sorted by **authored index**, which is *not* `parallel_of` order — so neither the run loop nor the sandbox could reconstruct the contract order from the vertex alone. Pinning it on the plan keeps the merge **deterministic** (a reproducible `merge_fn`/`concat` is required for checkpoint/resume, ADR-0027).

A branch a `condition` routed away from is **skipped** by the run loop's skip-propagation ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)). A skipped branch **counts as settled** against the join — so a `wait_all` fan-in fires instead of hanging on it — and is **omitted** from the `branches` array surfaced to `merge_fn` / `concat`, preserving the *relative order* of the surviving branches; a fan-in all of whose branches were skipped is itself skipped.

### How the merge is realized (1.P fan-in handler)

The run loop owns *when* the join fires (it dispatches the `fan_in` only once every branch has settled) and hands the rest to the `fan_in` node handler (1.P), which performs the **merge**: it reads `config.branchNodeIds` in order, projects those outputs out of the completed-output map (omitting any absent/skipped branch, per the rule above), and combines them per `config.mergeStrategy` — `concat` → an ordered array; `object_merge` → a shallow merge with later-in-order branches winning (built on a null-prototype accumulator, so a `__proto__` branch key cannot hijack the result); `first` → the first surviving branch by declaration order; `custom` → the `config.mergeFn` expression evaluated in the sandbox with `ExpressionScope.branches` in `branchNodeIds` order. `config.mergeFn` is the authored `merge_fn` lifted onto the config (present only for `merge_strategy: custom`), mirroring the derived `requestedJoinStrategy`.

**`wait_first` is unread in v1.0 — by the engine *and* by the executor.** `merge_strategy: first` derives `requestedJoinStrategy: wait_first`, but nothing consults it: the engine waits for all branches to settle before dispatching the fan-in, and the handler then selects the **first by `branchNodeIds` declaration order** among the survivors, switching on `mergeStrategy` alone. (An earlier wording here said "executor-only", which reads as though the executor branches on it. It does not.) True early-cancellation of the losing branches (cancel them the moment the first settles) needs engine-owned cross-vertex cancellation and is a deferred refinement — see [deferred-tasks.md](../../roadmap/deferred-tasks.md).

### How an `output` vertex captures (1.P output handler)

An `output` vertex is terminal: the run loop gathers `run:completed.outputs` as a record **keyed by each `output`-type vertex's node id**, the value being what this handler returns ([sse-event-schema.md](../contracts/sse-event-schema.md)). (`run:failed.partialOutputs` is a *different* projection — there the engine collects **every** vertex that had `completed` at failure time, regardless of node type, so the partial snapshot may include intermediate `input` / `transform` / `agent` / `fan_in` outputs alongside any captured `output` nodes.) The handler **captures its feeders** — the settled, *value-producing* upstream nodes it depends on (`config.feederNodeIds`; a `condition`/`parallel` dependency is a control edge and never a feeder): a **single** live feeder (the canonical one-input-handle shape, including a `condition`'s one taken branch converging here) is captured **verbatim**; **several** live feeders are captured as an object keyed by feeder node id in **sorted** order (deterministic for resume); **no** live feeder yields `null`. `output_format` is a render hint for the surface, never applied to the captured value.

> **Retry is not lifted onto the plan.** Unlike an agent's `fallbackChain` (lifted onto `AgentPlanConfig` for the run loop's convenience), a node's `retry_config` is **not** copied onto the vertex. The run loop (1.N) makes no retry decision: a node failure is terminal only for that **attempt**, which — *without 1.S* — fails the run. Node-level retry above the provider fallback chain is layered by **1.S**, which reads `retry_config` from the authored node (`config.node`) and re-attempts before a node is considered finally failed.

## The dependency graph

The builder unions three edge sources into one DAG over node ids:

1. **Structural edges** — `workflow.edges[]` (the base node id of a `nodeId:handle` `from` is recovered by splitting on the first `:`).
2. **Materialized routing edges** — one `parallel → member` edge per `parallel_of` entry, and one `condition → target` edge per `branches[].target_node` and `default`. Authored routing carries a real dependency even when the redundant explicit `nodeId:handle` edge is omitted, so a cycle through a branch is caught and a `condition`'s `dependents` are populated for the run loop's skip-propagation.
3. **Data edges** — every `{{run.outputs["<id>"]}}` reference in a **template** field (an agent's `prompt_template`/`system_prompt_append`, a gate's `assignee`/`message_template`, and a resolved agent's `system_prompt`) makes the referencing node depend on the producer, so a consumer is ordered after its referenced producer **even without an explicit edge**. A *template* reference to a non-existent producer adds no edge and no build error — the runtime resolver raises `unresolved_reference` at dispatch. The builder *likewise* does not order `run.outputs` reads in the **JS-expression** fields (`condition`/`transform`/`merge_fn`, sandbox-owned, 1.AB) — but the symmetry is builder-non-validation only: those are not templates and never produce `unresolved_reference`. **Two rules close the hazard this used to record** ([ADR-0093](../../decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md)). (1) The scope builder narrows `run.outputs` for a `condition`/`transform`/`merge_fn` to the reading node's **transitive dependency closure**. (2) The builder additionally **scans the expression text** for literal `run.outputs["id"]` / `run.outputs.id` accesses and refuses one naming a non-ancestor node at parse, before a run id exists. The scan is deliberately conservative — it reads only literal accesses and **says nothing where it cannot tell** — a computed key, an aliased binding, an identifier escape, or any text whose literals it cannot lex; it never synthesizes an edge, so being incomplete is safe rather than wrong. What it cannot see still falls back to the narrowed scope, where a non-dereferencing comparison against `undefined` remains possible: that residue is stated in ADR-0093's Negative section rather than implied closed. The builder validates the authored *graph*, not data-reference targets.

The order is computed by **Kahn's algorithm** with an **authored-order tie-break**, so the plan is fully deterministic (reproducible byte-for-byte — required for checkpoint/resume and retry-from-node, ADR-0027). A graph that does not fully linearize has a **cycle**.

## What the builder validates

The builder owns the structural checks the pure parser defers (it has the full node graph; the parser sees one file). Each fault becomes a field-named, secret-free `GraphIssue` (`kind`: `cycle` | `unknown_edge_target` | `invalid_handle` | `mismatched_branch_target` | `dangling_ref` | `ceiling_exceeded` | `tool_grant_widened` | `unordered_output_read` | `invalid_output_schema`), collected and thrown together as a **`WorkflowGraphError`** (code `invalid_graph`) — a sibling of `WorkflowValidationError`, so an unrunnable graph is rejected before a run starts:

- **Invalid output schema** — an authored `output_schema` (on an `agent` node, a `transform` node, or the resolved agent an agent node falls back to) is outside the supported JSON-Schema subset, or gives a malformed value for a supported keyword. Compiled in `strict` mode at parse so the refusal precedes any model call — see [json-schema-subset.md](json-schema-subset.md).
- **Unordered output read** — a `condition` / `transform` / `custom` `merge_fn` expression **literally** reads `run.outputs` of a node that exists in the workflow but is not among the reading node's `ancestors` (or is the node itself). Only a literal access naming an existing node is refused: a computed key, a rebound `run`, or any expression the scan cannot confidently lex is passed over in silence, and a read of a node not in the workflow is never reported by anything. The check stands down entirely when the graph is over an admission ceiling, has a cycle, or has an unresolved `agent_ref` — in each case the closure would be computed from a partial graph, and a refusal from a partial graph points the wrong way.
- **Cycle** — the dependency graph has a directed cycle; the message names it (`a → b → c → a`).
- **Unknown edge target** — an `edges[]` endpoint, a `condition` `branches[].target_node` / `default`, or a `parallel_of` member names a node that does not exist.
- **Invalid handle** — a `nodeId:handle` edge whose source is not a `condition`, or whose handle matches no branch `when` value (the only named output handles in v1.0; `fan_out` uses plain edges); **also** a *plain* (handle-less) edge whose `from` is a `condition` node — a condition routes only via `branches[].target_node` + the `nodeId:when` handle form, so a handle-less edge from it is rejected (redundant with a branch target, or a node the branch selection never activates).
- **Mismatched branch target** — a `condition:handle` edge whose `to` contradicts that branch's
  `target_node`. (This kind shipped with the builder and was missing from this list until 2026-08-28; the
  code has always been the authority, and this document is now what it says.)
- **Ceiling exceeded** — an authored value or graph shape is over an absolute admission ceiling
  ([ADR-0086](../../decisions/0086-absolute-admission-ceilings-on-authored-values.md) §2). The issue names the
  field, the authored value and the ceiling; nothing is clamped. Counted on the **authored** file, where "authored" includes every place the
  author wrote an edge: `edges[]` **and** each `parallel_of` member (which the builder materialises as a
  fan-out edge). A `condition`'s branches are routing alternatives and do not count toward fan-out.
- **Dangling ref** — an `agent_ref` resolves to no agent. Only checked when a **resolved-agent registry** is supplied (`agent_ref` resolution against the workspace registry is a host concern — the pure builder never reads files); otherwise resolution is deferred. When resolution was deferred and an `agent` vertex reaches dispatch with **no** `resolvedAgent`, the `AgentRunner` (1.O) fails the node with `code: 'validation'` naming the unresolved `agent_ref` — never a crash ([agent-runner.md](agent-runner.md)).
- **Tool grant widened** — a node's `tools:` names a tool its resolved agent was not granted ([ADR-0094](../../decisions/0094-a-tool-grant-is-checked-when-the-plan-is-built.md); a node may only NARROW). The locator is **positional** — ``node `n`.tools[2]`` — and the authored tool value is never echoed, because `node.tools` carries no charset or length bound and a `GraphIssue` reaches an event and a log. An agent whose grant depends on **unconnected MCP servers** is skipped unless the host sets `BuildRunPlanOptions.toolGrantsFinal` (a grant that is not knowable from the document must not be refused against); `relavium run` sets it, having connected and augmented first. An agent with **no `tools:` at all** has granted nothing, so any node `tools:` widens it. The runtime `resolveGrant` check remains the floor for a host that builds no plan.

Separately, a resolved `$ref`/registry agent's `system_prompt` is re-run through the secret-taint gate (a `$ref` agent's prompt lives in another file the pure parser never reads): a secret reaching it throws **`WorkflowSecretLeakError`** (ADR-0029(c)), exactly as for an inline agent.

## Purity

Like the parser, `buildRunPlan` is **pure and synchronous** — it reads structure only, touches no filesystem, no environment, and holds no state, so it runs identically in Node, the Tauri WebView, the VS Code host, and Bun (CLAUDE.md rule 5). File-bound work (resolving a `$ref` agent) is the host's: it reads and validates the agent, then passes the resolved data in.
