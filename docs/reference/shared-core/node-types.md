# Node Types

- **Status**: Stable
- **Canonical home**: the node-type catalog shared by the canvas, the YAML file format, and the engine
- **Related**: [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md), [built-in-tools.md](built-in-tools.md), [store-shapes.md](store-shapes.md), [../../architecture/execution-model.md](../../architecture/execution-model.md)

A node is one vertex of a workflow's directed graph. The same conceptual node shows up in three places, and they do **not** have identical names, so this page is the one reconciliation table everything else links to:

1. **Canvas components** — the visual React node a user drags onto the desktop canvas.
2. **YAML `type`** — the value written into a `.relavium.yaml` file (see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).
3. **Engine node-type enum** — the internal type the engine executes.

## Reconciliation table

| Concept | Canvas component | YAML `type` | Engine enum | Purpose |
| --- | --- | --- | --- | --- |
| Entry | `InputNode` | `input` | `input` | Workflow entry point; emits resolved inputs. |
| Agent | `AgentNode` | `agent` | `agent` | LLM call with tools (the core execution node). |
| Condition | `ConditionNode` | `condition` | `condition` | Branch on an expression over run outputs. |
| Tool | `ToolNode` | *(via agent `tools:`)* | `tool` | Direct tool/API call without an LLM. |
| Transform | *(via `ConditionNode`/inline)* | `transform` | `transform` | Reshape state with a JS expression, no LLM. |
| Fan-out | `FanOutNode` | `parallel` | `fan_out` | Split one input into N concurrent branches. |
| Fan-in | `AggregatorNode` | `merge` | `fan_in` | Combine (aggregate) N parallel branches into one output. |
| Loop | `LoopNode` | *(reserved)* | `loop` | Iterate a subgraph over a collection. |
| Human gate | `HumanGateNode` | `human_gate` | `human_in_the_loop` | Pause for human approval / input / review. |
| Output | `OutputNode` | `output` | `output` | Terminal node capturing the final result. |
| Subworkflow | *(reserved)* | *(reserved)* | `subworkflow` | Execute another workflow as a sub-graph. |

> **Why the names differ.** The canvas favors visual clarity (`FanOutNode` / `AggregatorNode` read better on a diagram), the YAML favors author ergonomics (`parallel` / `merge`), and the engine enum is the superset that also carries internal-only types (`tool`, `loop`, `subworkflow`). The **YAML `type` is the authoritative authored value**; the canvas and engine map onto it. Note that the single authored `parallel` construct expands into **two distinct engine node types** — `fan_out` (the split) and `fan_in` (the aggregating join) — because the engine executes the split and the join as separate vertices with separate config. The full engine enum is `agent | condition | tool | transform | input | output | loop | fan_out | fan_in | human_in_the_loop | subworkflow`.

### Three layers, three counts (intentional, not drift)

This page is the **single source of truth** for the node-type taxonomy; every other doc must defer to it, use the count appropriate to the layer it describes, and link here rather than re-enumerate or rename node types. The three layers legitimately have three different counts:

- **8 authored YAML `type` values** — `input`, `agent`, `human_gate`, `condition`, `transform`, `parallel`, `merge`, `output`. This is the user contract (see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)). A **Tool** is authored via an agent node's `tools:` list, *not* as its own YAML type; `loop` and `subworkflow` are **not** authorable in v1.0 (reserved — see below).
- **9 canvas components** — `AgentNode`, `ConditionNode`, `FanOutNode`, `AggregatorNode`, `LoopNode`, `HumanGateNode`, `InputNode`, `OutputNode`, `ToolNode`. (9 because the canvas adds a visual `ToolNode` and a `LoopNode`; `ToolNode` serializes into an agent's `tools:`, and `LoopNode` is reserved/non-authorable in v1.0.)
- **11 engine enum members** — `agent | condition | tool | transform | input | output | loop | fan_out | fan_in | human_in_the_loop | subworkflow`. The single authored `parallel` expands into **two** engine vertices (`fan_out` + `fan_in`); `human_gate` maps to `human_in_the_loop`; `loop` and `subworkflow` exist in the enum but have no v1.0 YAML `type`.

The canonical name mappings are stated **only here**: `parallel` (YAML) → `FanOutNode` (canvas) → `fan_out` + `fan_in` (engine); `merge` (YAML) → `AggregatorNode` (canvas) → `fan_in` (engine); `human_gate` (YAML) → `HumanGateNode` (canvas) → `human_in_the_loop` (engine); `tool` → `ToolNode` (canvas) / agent `tools:` (YAML) → `tool` (engine).

> **How the `fan_out`/`fan_in` pair is realized.** The conceptual split-join pair spans **two authored nodes**, not one: in YAML v1.0 the `fan_out` is the authored `parallel` node and the `fan_in` of the pair is a paired authored **`merge`** node, with the branches bracketed by explicit edges (`parallel → branches → merge`; see [../contracts/workflow-yaml-spec.md#complete-example](../contracts/workflow-yaml-spec.md#complete-example)). The DAG builder maps `parallel → fan_out` and `merge → fan_in` and **synthesizes no extra join vertex** — a `parallel` whose branches do not converge on a `merge` simply has no fan-in. The compiled plan is specified in [run-plan.md](run-plan.md).

### Reserved types (forward-compat; not executable/authorable in v1.0)

`loop` and `subworkflow` are **forward-compat engine-enum slots only**. In the first increment they are:

- **not authorable in YAML v1.0** — there is no `loop` or `subworkflow` YAML `type` (the authored set is the 8 above);
- **not executable in Phase 1** — Phase 1 scopes engine handlers for `condition`/`fan_out`/`fan_in`/`transform`/`input`/`output` (plus `agent` and `human_in_the_loop`); no `loop`/`subworkflow` handler ships;
- **not user-functional on the canvas in the first increment** — `LoopNode` is rendered as a reserved/forward-compat palette slot, not a runnable or serializable node.

They remain in the engine enum (and `LoopNode` in the canvas component set) purely as honest forward-compat placeholders for a post-v1.0 schema increment; this is the canonical statement of that decision and every other doc should link here rather than restate it.

## Canvas node components

The desktop canvas renders nine custom ReactFlow node components. Each subscribes to its own slice of `runStore` for live status (never the canvas store — see [store-shapes.md](store-shapes.md)).

### `AgentNode`

The core execution node. Renders the agent name, a model badge (e.g. `claude-sonnet-4-6`), and the provider icon. During a run it shows streaming token output (scrollable monospace, ~10 lines visible with expand), an animated status-ring border (idle / queued / running / done / error), and token count + estimated cost in the footer. One default input and one default output handle.

- **Key props**: `agentId`, `label`, `nodeRunStatus`, `streamingText`, `tokenCount`, `costMicrocents`, `isSelected`

### `ConditionNode`

Branching node with one input and two labeled output handles (`true` / `false`). The condition is a JS expression over the run scope, evaluated in the expression sandbox ([ADR-0027](../../decisions/0027-expression-sandbox.md)) — e.g. `run.outputs["classify"].sentiment === 'positive'` (upstream outputs are keyed by node id; never a bare `output`). Rendered as a diamond (CSS `clip-path`). During a run the taken branch is highlighted and the untaken branch dimmed.

- **Key props**: `conditionExpression`, `trueLabel`, `falseLabel`, `nodeRunStatus`, `evaluatedBranch`

### `FanOutNode`

Splits one input into N parallel branches (2–8 output handles, each optionally labeled). Rendered as a horizontal bar with emanating lines. During a run, output edges animate simultaneously with staggered particle delay to convey true parallelism.

- **Key props**: `branchCount`, `branchLabels`, `nodeRunStatus`, `activeBranches`

### `AggregatorNode`

Collects N parallel branch results into one output. Strategy is configurable; the canvas `strategy` prop carries the **authored YAML `merge_strategy` value** verbatim (`concat` | `object_merge` | `first` | `custom`) so the three layers agree — see the [merge-strategy reconciliation table](#merge-strategy-reconciliation) below. (`best_of_n` — a secondary-LLM picker — is **reserved, not v1.0**; see that table.) Shows a progress bar of completed branches; visually blocked (greyed border) until all expected inputs arrive.

- **Key props**: `strategy`, `expectedInputCount`, `completedInputCount`, `nodeRunStatus`, `aggregatedOutput`

### `LoopNode`

> **Reserved (forward-compat; not executable/authorable in v1.0).** `LoopNode` is rendered for forward-compatibility but is **not** runnable, serializable, or authorable in YAML v1.0, and is not user-functional on the canvas in the first increment. The props below describe its eventual shape, not Phase-1 behavior — see [Reserved types](#reserved-types-forward-compat-not-executableauthorable-in-v10) above.

Intended to wrap a subgraph in a loop with a curved loop-back edge to its own input, where the loop condition is evaluated after each iteration with a hard `maxIterations` cap and the current iteration shows as a badge during a run.

- **Key props (forward-compat)**: `maxIterations`, `loopCondition`, `currentIteration`, `nodeRunStatus`

### `HumanGateNode`

Pause point requiring a human. Rendered with a lock icon and amber color; pulses with an amber ring while awaiting input. During a run it triggers the human-gate overlay that blocks further execution and records the decision + optional reviewer note in the run trace. See the gate lifecycle in [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md).

- **Key props**: `promptText`, `approveLabel`, `rejectLabel`, `nodeRunStatus`, `gateDecision`, `reviewerNote`

### `InputNode`

Entry point. Accepts the initial payload as JSON or text; no input handle, one output handle. Shows the declared input schema; starting a run prompts the user to fill values matching it. The schema maps to the workflow's `inputs:` declarations (see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md)).

- **Key props**: `inputSchema`, `inputLabel`, `sampleValue`, `nodeRunStatus`

### `OutputNode`

Terminal node capturing the final output (one input, no output handle). Renders the result inline with syntax highlighting (JSON or markdown); after completion it can be copied or downloaded. Multiple `OutputNode`s are allowed for workflows with parallel terminal branches.

- **Key props**: `outputFormat`, `capturedOutput`, `nodeRunStatus`, `renderMode`

### `ToolNode`

Calls an external tool or API directly (web search, code execution, HTTP, file read/write) without an LLM. Configured with tool type, endpoint, auth-header **reference** (stored in `providerStore` by id — never inlined into the workflow JSON), and input/output mapping. Shows HTTP status and response time during a run. The available built-in tools are catalogued in [built-in-tools.md](built-in-tools.md).

- **Key props**: `toolType`, `toolName`, `endpointRef`, `inputMapping`, `outputMapping`, `nodeRunStatus`, `lastHttpStatus`, `lastResponseTimeMs`

## Per-type engine config

In the engine's `WorkflowDefinition`, a node carries `id`, `type`, `label`, optional `position` (canvas x/y), and exactly one per-type config block. The blocks recognized by the engine:

| Engine config block | Present when `type =` | Notable fields |
| --- | --- | --- |
| `agent_config` | `agent` | `agent_ref` (resolves to the agent definition), `system_prompt_append`, `prompt_template`, `tools` (**narrows** the agent's grant — never widens, [ADR-0029](../../decisions/0029-tool-policy-hardening.md)), `model`, `temperature`, `max_tokens`, `output_schema` (optional; node override wins over the agent default; validated **node-side** on completion — Phase-1 is **parse-as-JSON only**, deep schema conformance deferred — [ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md), [agent-runner.md](agent-runner.md)), `timeout_ms`, `retry` (fields are inline on the `agent` node — `AgentNodeSchema`; there is no nested `agent_config` object) |
| `condition_config` | `condition` | `expression_type` (`js` in v1.0; `jmespath`/`jsonlogic` reserved — [ADR-0027](../../decisions/0027-expression-sandbox.md)), `expression` (evaluated once), `branches[]` (each `{ when, target_node_id }` — `when` is **strictly** matched, `===`, against the result), `default_target_node_id` (taken when no `when` matches) |
| `tool_config` | `tool` | `tool_name`, `tool_source` (`builtin`/`mcp`), `mcp_server`, `parameters`, `input_mapping`, `output_mapping` |
| `transform_config` | `transform` | `expression_type` (`js` in v1.0; `jmespath`/`jsonlogic` reserved — [ADR-0027](../../decisions/0027-expression-sandbox.md)), `transform` (a **single** `js` expression whose result becomes the node's output — `TransformNodeSchema`), `output_schema` (optional, validated node-side; Phase-1 is parse-as-JSON only, deep conformance deferred) |
| `loop_config` | `loop` | `iterate_over`, `item_key`, `body_entry_node_id`, `body_exit_node_id`, `max_iterations`, `collect_results_key` |
| `fan_out_config` | `fan_out` | `branch_node_ids[]`, the split fan-out half of an authored `parallel` block |
| `fan_in_config` | `fan_in` | `join_strategy` (`wait_all`/`wait_first`/`wait_n`) — *when* to fire — plus `wait_n`; and `merge_strategy` (`concat`/`object_merge`/`first`/`custom`) — *how* to combine, named identically to the authored YAML value (see the [merge-strategy reconciliation table](#merge-strategy-reconciliation)); the aggregating join half |
| `human_in_the_loop_config` | `human_in_the_loop` | `prompt_template`, `timeout_ms`, `on_timeout` (`reject`/`approve`; `escalate` is **reserved** in v1.0 — see [workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#human_gate-node)), `input_schema` |
| `subworkflow_config` | `subworkflow` | `workflow_id`, `input_mapping`, `output_mapping` |
| `retry_config` | any | `max_attempts`, `backoff_ms` (base delay), `backoff_strategy` (`linear`/`exponential`, from the authored YAML `retry.backoff`), `retry_on[]` (error types) |

> The authored YAML uses friendlier field names (e.g. `parallel_of`, `merge_strategy`, `timeout_action`) that map onto the engine config blocks above. The YAML is the user contract — see [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md). **Durations are milliseconds on both sides** (`timeout_ms`, `backoff_ms`) — the mapping renames fields but never converts units, so there is no hidden ms↔s boundary. The mapping itself is owned by `@relavium/core` and is exercised on parse against the `WorkflowSchema` Zod definition.
>
> **Expression languages (condition / transform).** In v1.0 the only `expression_type` is **`js`** — a **sandboxed JavaScript expression** evaluated in a deterministic, resource-capped sandbox (no I/O, no ambient globals, no wall-clock/RNG; [ADR-0027](../../decisions/0027-expression-sandbox.md)). `jmespath` and `jsonlogic` are **reserved** (each would add an undeclared runtime dependency) and deferred to a future ADR. **There is no Python evaluator** — per [ADR-0003](../../decisions/0003-pure-ts-engine-not-langgraph-python.md) the engine is pure TypeScript and ships no Python runtime. `workflow-yaml-spec.md` exposes the same set; its bare `condition:` / `transform:` strings are `js` expressions. The full sandbox contract — scope, allow-list, determinism, caps, and the `sandbox_error` taxonomy — is owned by [expression-sandbox-spec.md](expression-sandbox-spec.md).

### Merge-strategy reconciliation

A fan-in / aggregator node combines N branch results with **one** named strategy. As with node types, the three layers historically drifted; the **authored YAML `merge_strategy` value is canonical**, and the canvas (`AggregatorNode.strategy`) and engine (`fan_in_config.merge_strategy`) carry that same value verbatim:

| YAML `merge_strategy` (authoritative) | Canvas `AggregatorNode.strategy` | Engine `fan_in_config.merge_strategy` | Behavior |
| --- | --- | --- | --- |
| `concat` | `concat` | `concat` | Concatenate branch outputs into an ordered array. |
| `object_merge` | `object_merge` | `object_merge` | Shallow-merge branch objects into one object (later branches win on key collision). |
| `first` | `first` | `first` | Take the first branch to resolve; ignore the rest. Pairs with `join_strategy: wait_first`. |
| `custom` | `custom` | `custom` | Apply the author-supplied `merge_fn` (a `js` expression that receives `branches` — the branch outputs in the **stable `FanInPlanConfig.branchNodeIds` order** the DAG builder computes (the paired `parallel`'s `parallel_of` order when the merge joins exactly one parallel's branches, else the merge's own incoming branches in authored order — see [run-plan.md §fan-in branch order](run-plan.md)) — plus `run.outputs`; see [expression-sandbox-spec.md](expression-sandbox-spec.md#the-expression-scope-the-one-canonical-binding)). |
| `best_of_n` *(reserved — not v1.0)* | `best_of_n` *(reserved)* | `best_of_n` *(reserved)* | A secondary-LLM picker selects the "best" branch. **Not in the v1.0 YAML contract** — it carries unaccounted extra-LLM cost and event implications (an additional agent call + `cost:updated` events), so it is held as a reserved/forward-compat slot, in parity with `LoopNode`. |

`join_strategy` (`wait_all` / `wait_first` / `wait_n`) is an **orthogonal** axis — it controls *when* the join fires, not *how* outputs are combined; do not conflate it with `merge_strategy`.

## Edges

Edges connect nodes by `from` → `to` (source node id → target node id, per the authored contract), with an optional `label`, an optional `condition` (the edge is followed only when truthy; null means unconditional), and an optional `data_mapping` that remaps state keys as execution traverses the edge. **`data_mapping` is engine-internal / reserved in v1.0** — it is not an authored YAML field; reshape state via a `transform` node or a `merge_fn` instead. An **`on_error` error-routing edge kind is likewise reserved (forward-compat; not authorable in v1.0)** — the same reserved-slot pattern as `LoopNode`/`best_of_n`, applied to an edge kind: the slot is named in the contract, but v1.0 failure semantics remain per-node `retry` + run failure; the canonical reservation note (with the deferral rationale) lives in [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#edges). Branch handles on a `condition`/`fan_out` node are referenced from edges as `nodeId:handleName`. See [../contracts/workflow-yaml-spec.md](../contracts/workflow-yaml-spec.md#edges).
