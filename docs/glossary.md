# Glossary

> Status: draft — to be expanded as reference specs are finalized.
> Last updated: 2026-06-05

Domain terms used across the Relavium documentation. One canonical definition
each; concrete specs live in their [reference/](reference/README.md) file, which
this glossary links to rather than duplicates.

## Core Concepts

- **Relavium** — the multi-surface, local-first AI agent workflow platform this
  documentation describes. Tagline: *Start as an agent. Ship the workflow. Own
  every run.* See [vision.md](vision.md).
- **Surface** — one of the four ways to reach Relavium: the **desktop app**, the
  **VS Code extension**, the **CLI**, and (Phase 2) the **web portal**. The three
  local surfaces each run the same `@relavium/core` engine in-process, so behavior is
  identical on each; the web portal is a **control plane**, not an execution surface — it
  drives runs through the cloud API rather than embedding the engine. Each local surface
  offers **two co-equal entry modes on the one engine** — *Agent mode* and *Workflow mode*
  (below). See [architecture/cloud-phase-2.md](architecture/cloud-phase-2.md).
- **Workflow** — a directed graph of nodes (agents, control flow, human gates)
  defined as a git-committable YAML file (`.relavium.yaml`). Relavium's **automation
  unit**: the reusable, committable artifact a *Run* (below) executes — complemented by the
  conversational *Agent session* (below), the interactive entry point a workflow can be
  exported from. Spec: [reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md).
- **Agent** — a configured LLM caller: a model, a system prompt, a tool set, and
  optional fallback chain, defined as a YAML file (`.agent.yaml`). Spec:
  [reference/contracts/agent-yaml-spec.md](reference/contracts/agent-yaml-spec.md).
- **Agent session (`AgentSession`)** — an ongoing, multi-turn conversation between a
  user and one agent: Relavium's **agent-first entry point** and a first-class peer of a
  *Run* (below). It reuses the same engine substrate (tools, the `LLMProvider` seam, the
  event bus) and is auto-persisted and resumable across restarts (its own tables, beside
  *Run history*). Unlike a run, a session is conversational, not a workflow execution; it
  can be **exported** to a workflow. Spec:
  [reference/contracts/agent-session-spec.md](reference/contracts/agent-session-spec.md);
  decision: [decisions/0024-agent-first-entry-point-agentsession.md](decisions/0024-agent-first-entry-point-agentsession.md).
- **Agent mode / Workflow mode** — the two co-equal entry modes every local surface
  offers on the one engine: **agent mode** is an interactive *Agent session* (chat);
  **workflow mode** is authoring/running a *Workflow*. Both share the engine, tools, the
  seam, and the event bus.
- **Chat-to-workflow export** — the explicit, user-reviewed action that serializes an
  *Agent session* into a `.relavium.yaml` **scaffold** (a linear chain of agent nodes plus
  the transcript as metadata), turning a conversation into a committable workflow. Decision:
  [decisions/0026-session-export-to-workflow.md](decisions/0026-session-export-to-workflow.md).
- **Chat-to-workflow continuum** — Relavium's positioning thesis: the same tool is where
  you **start** (an *Agent session*) and where you **ship** (a committed, CI-runnable
  *Workflow*), connected by *Chat-to-workflow export*. See [vision.md](vision.md).
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
- **Reseat** — a host-side **model switch inside a live agent session** (`/models` in a chat):
  the conversation is reconstructed and a *new* `AgentSession` instance is resumed on the chosen
  model, so the **session id is unchanged but the instance is not**. It rebuilds the fallback chain
  for the new model and carries the text-only transcript — not prior tool calls or file contents.
  Behaviour: [reference/cli/chat-session.md](reference/cli/chat-session.md#model-reseat-models);
  decision: [ADR-0059](decisions/0059-cli-mid-session-model-reseat.md).
- **Human gate** — a node that pauses a run and requires a real human decision
  (approve / reject / provide input) before continuing. Supports a timeout with
  an auto-approve or auto-reject fallback (an `escalate` action is **reserved** for a
  future phase — see [reference/contracts/workflow-yaml-spec.md](reference/contracts/workflow-yaml-spec.md)).
  Enables compliance-sensitive workflows. The same gate seam also backs a workflow
  **budget** pause ([decisions/0028-workflow-resource-governance.md](decisions/0028-workflow-resource-governance.md)).
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
- **Cost (micro-cent)** — costs are tracked as integer **micro-cents**
  (1 micro-cent = 1e-8 USD) to avoid float-rounding error in per-node / per-run
  cost attribution. Canonical home:
  [reference/shared-core/llm-provider-seam.md](reference/shared-core/llm-provider-seam.md).
- **Channel / IPC stream** — in the desktop app, the typed, backpressure-aware
  Tauri v2 `Channel<StreamChunk>` that carries the **Rust-delegated LLM egress**
  (`llm_stream`) back to the WebView adapter as `StreamChunk` frames. The engine's
  `RunEventBus` runs **WebView-side**, so most run events (`node:started`,
  `agent:token`, …) are produced and consumed in the WebView and never cross IPC;
  only the LLM stream chunks do. The cross-surface run-event union those events
  belong to is the same one SSE carries in Phase 2. See
  [decisions/0018-desktop-execution-and-rust-egress.md](decisions/0018-desktop-execution-and-rust-egress.md).
- **Run event (`RunEvent`)** — one item in a run's event stream: the discriminated
  union (`node:started`, `agent:token`, `agent:tool_call`, `agent:tool_result`,
  `node:completed`, `node:failed`, `cost:updated`, `human_gate:paused`,
  `human_gate:resumed`, `run:completed`, `run:failed`) that every surface consumes,
  each carrying a monotonic `sequenceNumber`. One canonical home:
  [reference/contracts/sse-event-schema.md](reference/contracts/sse-event-schema.md).
  Often called an *SSE event* after its Phase-2 cloud transport (below).
- **Session event (`SessionEvent`)** — the `session:*`-namespaced counterpart to a *Run
  event* for an *Agent session* (session lifecycle, a conversational turn, a tool
  round-trip), carried on the same bus and **disjoint** from the `run:*` namespace. One
  canonical home, beside `RunEvent`:
  [reference/contracts/sse-event-schema.md](reference/contracts/sse-event-schema.md).
- **SSE event** — the same `RunEvent` (above) seen through its transport. The schema
  is one canonical union for every surface; **how it travels differs**: on the desktop
  the events are produced and consumed in-process by the WebView-side `RunEventBus` and
  never cross IPC ([ADR-0018](decisions/0018-desktop-execution-and-rust-egress.md) —
  see *Channel / IPC stream* above), while Phase-2 cloud mode delivers them over HTTP
  SSE. Every event carries a monotonic `sequenceNumber`. Canonical schema:
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

## Deployment & Customer Segments

- **Deployment model** — the combination of **execution mode** + **licensing tier**
  a customer adopts: where the LLM key lives, who pays for tokens, and what
  governance is layered on. The per-segment, end-to-end map (individual / small team
  / enterprise) is the one home: [deployment-models.md](deployment-models.md).
- **Customer segment** — the adoption cohort a deployment model is chosen for:
  **individual developer**, **small team (2–20)**, or **large enterprise**. Each maps
  to a recommended mode, key model, and tier in
  [deployment-models.md](deployment-models.md).
- **BYOK-central / org key vault** — the **enterprise key model**: the **`cloud`
  (BYOK-cloud)** execution mode, where the **org's** provider keys live in a
  **central server-side vault** and are **injected server-side** by a cloud worker
  (never issued per-employee; the org still pays its provider directly, so Relavium
  meters nothing). Distinct from the Relavium-held managed key pool. *(Phase 2.)*
  Mechanics: [architecture/key-management.md](architecture/key-management.md) and
  [decisions/0013-managed-key-vault-and-pools.md](decisions/0013-managed-key-vault-and-pools.md);
  segment fit: [deployment-models.md](deployment-models.md).
- **Seat / per-seat licensing** — the billing unit for the paid tiers: one **seat**
  per named user, priced per seat per month (Pro/Team) or per-seat under a custom
  annual contract (Enterprise). In BYOK, the seat fee buys software + governance, not
  tokens. Tiers: [reference/portal/api-reference.md](reference/portal/api-reference.md#licensing-tiers).

## Execution Modes & Managed Inference *(managed = Phase 2)*

- **Execution mode** — how a run's LLM calls are keyed and routed. Three modes
  behind the one `LLMProvider` seam: **local** (BYOK, the Phase-1 default),
  **cloud** (BYOK-cloud / **BYOK-central**, Phase 2), and **managed** (Relavium's
  keys, Phase 2). The engine is identical across all three. Canonical home:
  [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md)
  and [architecture/managed-inference.md](architecture/managed-inference.md).
- **BYOK ("bring your own key")** — the user supplies their own provider API keys
  (kept in the OS keychain); LLM calls go directly to providers under the user's
  account, never through Relavium. The Phase-1 default and a permanently-supported,
  first-class mode (a.k.a. **Private mode**). See
  [product-constraints.md](product-constraints.md).
- **Managed inference** *(Phase 2)* — an opt-in convenience mode in which Relavium
  uses its **own** provider keys and sells metered usage. Only LLM **egress** is
  proxied through Relavium's gateway; **the engine still runs locally** — so managed
  inference is distinct from cloud execution. The first Phase-2 deliverable.
  Canonical home: [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md),
  [architecture/managed-inference.md](architecture/managed-inference.md).
- **Inference gateway** *(Phase 2)* — the thin Relavium-hosted proxy
  (`gateway.relavium.com`) that fronts managed inference: it injects Relavium's
  keys, captures usage, enforces quota, and meters per request. It is *not* an
  execution plane. Spec: [architecture/managed-inference.md](architecture/managed-inference.md).
- **Key pool** *(Phase 2)* — the set of multiple Relavium-held provider keys
  managed per provider (for org rate limits, zero-downtime rotation, 429-cooldown
  and cross-provider fallback), held in a KMS-backed vault. See
  [decisions/0013-managed-key-vault-and-pools.md](decisions/0013-managed-key-vault-and-pools.md).
- **Included usage / quota** *(Phase 2)* — the metered model usage bundled into a
  managed plan, enforced by a **hard cap** (the guardrail that makes managed margins
  viable). See [decisions/0014-managed-metering-quota-and-billing.md](decisions/0014-managed-metering-quota-and-billing.md).
- **Overage** *(Phase 2)* — metered managed usage beyond the included quota,
  charged per unit (at cost plus a markup). See
  [decisions/0014-managed-metering-quota-and-billing.md](decisions/0014-managed-metering-quota-and-billing.md).
- **Prepaid credits** *(Phase 2)* — managed usage paid for up front and drawn down
  as it is consumed, so revenue precedes provider cost (positive float, no fronting
  of COGS). See [decisions/0014-managed-metering-quota-and-billing.md](decisions/0014-managed-metering-quota-and-billing.md).
- **Merchant-of-record** *(Phase 2)* — a third party (e.g. Paddle / Lemon Squeezy)
  that is the legal seller of record for managed billing, absorbing VAT / sales-tax
  across jurisdictions plus chargebacks and disputes. A launch-blocking precondition
  for managed mode. See [decisions/0015-managed-mode-data-handling-and-compliance.md](decisions/0015-managed-mode-data-handling-and-compliance.md)
  and the [compliance/](compliance/) area.

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

- **Local-first** — the Phase 1 model: agents run on the user's machine, and in
  **BYOK-local mode** API calls go directly to providers, no cloud and no account
  required. In that mode privacy is a guarantee; BYOK-local stays a first-class,
  permanently-supported mode in every phase. See
  [product-constraints.md](product-constraints.md).
- **Phase 1** — the local-first **product** phase: desktop + VS Code + CLI, BYOK-local, no cloud.
- **Build phase (0–6)** — the *engineering* phase axis (Phase 0 Foundations …
  Phase 6 Cloud execution + portal), **distinct from** the product Phase 1/2 sense
  above. Product Phase 1 spans build phases 0–4; product Phase 2 spans build phase 5
  (managed inference) and build phase 6 (cloud execution + portal). Never conflate the
  two senses — the canonical disambiguation and the full plan live in
  [roadmap/README.md](roadmap/README.md).
- **Phase 2** — *(explicitly later)* the **product** phase that adds two **independent** capabilities:
  **managed inference** (the first Phase-2 deliverable — a metered LLM gateway;
  engine stays local) and, separately, the **cloud layer** (web portal, cloud
  execution workers, team sharing, automatic cloud-hosted firing of
  scheduled/webhook triggers whose types are already declarable in Phase 1). See
  [decisions/0012-managed-inference-dual-mode.md](decisions/0012-managed-inference-dual-mode.md)
  and [roadmap/README.md](roadmap/README.md).
