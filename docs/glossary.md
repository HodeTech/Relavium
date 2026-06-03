# Glossary

> Last updated: 2026-06-03

Domain terms used across the Relavium documentation. One canonical definition
each; concrete specs live in their [reference/](reference/README.md) file, which
this glossary links to rather than duplicates.

## Core Concepts

- **Relavium** — the multi-surface, local-first AI agent workflow platform this
  documentation describes. Tagline: *Design agents. Ship workflows. Own every
  run.* See [vision.md](vision.md).
- **Surface** — one of the four ways to reach Relavium: the **desktop app**, the
  **VS Code extension**, the **CLI**, and (Phase 2) the **web portal**. All
  surfaces drive the same engine, so a workflow behaves identically on each.
- **Workflow** — a directed graph of nodes (agents, control flow, human gates)
  defined as a git-committable YAML file (`.relavium.yaml`). The unit of value in
  Relavium. Spec: [reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md).
- **Agent** — a configured LLM caller: a model, a system prompt, a tool set, and
  optional fallback chain, defined as a YAML file (`.agent.yaml`). Spec:
  [reference/contracts/agent-yaml-spec.md](reference/contracts/agent-yaml-spec.md).
- **Orchestrator** — an agent that coordinates other agents, delegating sub-tasks
  to them as tools and deciding the next step at runtime. Used for dynamic
  (non-static) workflow control.
- **Run** — a single execution of a workflow with concrete inputs. Produces a
  stream of events and a final output, both recorded in run history.
- **Run history** — the locally-stored (SQLite, Phase 1) record of past runs:
  status, events, per-node cost, and the data needed to replay or retry.
- **Node** — a single vertex in the workflow graph. See the node-type catalog
  below and [reference/shared-core/node-types.md](reference/shared-core/node-types.md).
- **Edge** — a directed connection between two nodes, optionally guarded by a
  condition expression; defines execution order and data flow.

## Node Types (canvas catalog)

The nine canvas node components. These are **canvas component names**; the value
a YAML author writes differs (e.g. `parallel` → FanOutNode, `merge` →
AggregatorNode, `human_gate` → HumanGateNode). The canonical
canvas ↔ YAML ↔ engine reconciliation table — and the full props per type — lives
in [reference/shared-core/node-types.md](reference/shared-core/node-types.md),
which this glossary defers to rather than re-defines.

- **AgentNode** — invokes a configured agent (LLM call + tools); streams tokens
  on its node face during a run.
- **ConditionNode** — branches the graph based on a boolean expression over prior
  node outputs.
- **FanOutNode** — splits work into parallel branches that execute concurrently.
- **AggregatorNode** — merges the results of parallel branches back into one
  (the join/barrier counterpart to a fan-out).
- **LoopNode** — *reserved (forward-compat; not executable/authorable in v1.0).*
  A canvas/engine-enum slot for repeating a sub-graph, with no v1.0 YAML `type`
  and no Phase-1 engine handler. See node-types.md.
- **HumanGateNode** — see *Human gate* below.
- **InputNode** — the typed entry point that receives the run's inputs.
- **OutputNode** — the terminal node that produces the run's final output.
- **ToolNode** — invokes a non-LLM tool (built-in or MCP) directly in the graph
  (canvas sugar; a tool is authored inside an agent's `tools:` list, not as a
  YAML `type`).

> **Reserved (forward-compat; not executable/authorable in v1.0):** `LoopNode`
> and Subworkflow exist as canvas components / engine-enum members for
> forward-compatibility only. They are not authorable in YAML v1.0 and not
> runnable by the Phase-1 engine. See
> [reference/shared-core/node-types.md](reference/shared-core/node-types.md).

## Triggers

How a workflow run is initiated. Full spec in
[reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md).

- **manual** — started explicitly by a user (canvas Run button, `relavium run`,
  VS Code right-click). Together with `file_change`, one of the two triggers that
  fire automatically in Phase 1.
- **file_change** — fires when files matching a glob change (debounced). Ships in
  Phase 1.
- **webhook** — fires on an inbound HTTP request. Declarable in YAML in Phase 1
  (and honored when the workflow is invoked manually or by a user-run watcher);
  automatic cloud-hosted firing requires an always-on listener and is *(Phase 2)*.
- **schedule** — fires on a cron expression. Declarable in YAML in Phase 1 (and
  honored on manual/watcher invocation); automatic cloud-hosted firing requires a
  cloud scheduler and is *(Phase 2)*.
- **mcp_call** — a workflow invoked as / via an MCP tool. See *MCP*.

## Execution & Runtime

- **Engine** — `@relavium/core`, the pure-TypeScript workflow engine shared by
  every surface. Parses YAML, builds the DAG run plan, executes nodes, and emits
  events. See [architecture/shared-core-engine.md](architecture/shared-core-engine.md).
- **Human gate** — a node that pauses a run and requires a real human decision
  (approve / reject / provide input) before continuing. Supports a timeout with
  an auto-approve, auto-reject, or escalate fallback. Enables compliance-sensitive
  workflows.
- **Fan-out** — splitting execution into multiple branches that run in parallel
  (via a FanOutNode).
- **Aggregator** — the node that joins parallel branches and merges their results.
- **Fallback chain** — an ordered list of `{model, provider, max_attempts}`
  entries for an agent; if the primary model fails or rate-limits, the engine
  automatically tries the next, e.g. `[claude-sonnet-4-6 ×3, gpt-4o ×2,
  gemini-2.5-pro ×1]`. Spec:
  [reference/contracts/agent-yaml-spec.md](reference/contracts/agent-yaml-spec.md).
- **Checkpoint** — saved state at a node boundary that allows resuming or
  *retry-from-node* without re-running already-completed upstream nodes.
- **Channel / IPC stream** — in the desktop app, the typed, backpressure-aware
  Tauri v2 channel used to stream run events from the backend to the canvas.
  Carries the same events that SSE carries in Phase 2.
- **SSE event** — a run event in the streaming event schema, used for HTTP
  streaming in Phase 2 (the desktop app carries the same events over a Tauri
  channel in Phase 1). Every event carries a monotonic `sequenceNumber`. The
  canonical field-by-field schema is the one home:
  [reference/contracts/sse-event-schema.md](reference/contracts/sse-event-schema.md).
- **sequenceNumber** — the monotonic per-run counter on each run event; a gap
  signals a missed event and triggers a full state resync (lossless reconnect).

## Providers & Tools

- **Provider** — an LLM vendor (Anthropic, OpenAI, Gemini, DeepSeek) reached
  through a `@relavium/llm` adapter. Multi-provider routing and fallback are
  first-class. The provider-agnostic contract every adapter implements is the
  `LLMProvider` seam:
  [reference/shared-core/llm-provider-seam.md](reference/shared-core/llm-provider-seam.md).
- **`@relavium/llm` / LLMProvider seam** — Relavium's own multi-LLM abstraction
  (`packages/llm`): thin hand-rolled adapters over each provider's official TS
  SDK, behind a single provider-agnostic seam that **no vendor SDK type may
  cross**. Not a 3rd-party framework. Contract:
  [reference/shared-core/llm-provider-seam.md](reference/shared-core/llm-provider-seam.md).
- **Built-in tool** — a capability an agent can call (e.g. read/write file, run
  command, HTTP request). Catalog:
  [reference/shared-core/built-in-tools.md](reference/shared-core/built-in-tools.md).
- **MCP (Model Context Protocol)** — the protocol Relavium uses to consume tools
  from, and expose agents as, external tool servers. See
  [reference/shared-core/mcp-integration.md](reference/shared-core/mcp-integration.md).
- **McpServerPool** — the engine's pool of live MCP server connections,
  started on demand and kept alive for the session.

## Data, Files & Storage

- **`.relavium.yaml`** — a workflow definition file; git-committable, the unit
  shared between teammates.
- **`.agent.yaml`** — an agent definition file; git-committable.
- **`.relavium/`** — the per-project config directory (committed to git) holding
  a project's workflows and agents.
- **`~/.relavium/`** — the global config directory holding cross-project
  preferences (keys live in the OS keychain, not here in plaintext).
- **Workspace** — a directory opened in the desktop app; the filesystem
  directory *is* the unit of organization (VS Code-style), enabling trivial git
  integration. There is no separate "project" concept.
- **OS keychain** — where API keys are stored (macOS Keychain / Windows
  Credential Manager / libsecret). Keys are never written in plaintext and never
  sent to the frontend. See
  [reference/desktop/keychain-and-secrets.md](reference/desktop/keychain-and-secrets.md).

## Phasing

- **Local-first** — the Phase 1 model: agents run on the user's machine, API
  calls go directly to providers, no cloud and no account required. Privacy is a
  feature. See [product-constraints.md](product-constraints.md).
- **Phase 1** — the local-first product: desktop + VS Code + CLI, no cloud.
- **Phase 2** — *(explicitly later)* the cloud layer: web portal, cloud execution
  workers, team sharing, and automatic cloud-hosted firing of scheduled/webhook
  triggers (whose types are already declarable in Phase 1). See
  [roadmap/README.md](roadmap/README.md).

> Status: draft — to be expanded as reference specs are finalized.
