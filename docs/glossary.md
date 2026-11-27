# Glossary

> Status: draft — to be expanded as reference specs are finalized.
> Last updated: 2026-11-27

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

- **Sheet** — a question the *system* asks, docked where the prompt is with the conversation visible above it: the approval card (a file edit or a command), the agent's question, the continue checkpoint and, on the Home, the run gate, the budget gate and the exit guard. They wear one frame: a heavy rule carrying the label and the *wait clock*, a title line, the body and two key lines; while one is open the prompt, the status line and the hint are not drawn. Every answer is a Ctrl chord and `Esc` and `Ctrl+C` never approve. A sheet is for what the system asks and a *popup* for what the user starts; it is not a modal in the middle of the screen. (Until MVP-11 the `/permissions`, `/models` and `/effort` overlays were called sheets too; they are popups now.) See [ADR-0147](decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md) and [chat-session.md](reference/cli/chat-session.md#the-sheet-frame-and-the-wait-clock-mvp-11-unit-8-2026-11-27).
- **Popup** — what the *user* starts: a keyboard-owning box centred over the screen in the alternate screen (as wide as the *content column* up to 76 columns: 68 at 80×24, where it stands exactly over it; a framed block that replaces the body inline) opened by a command such as `/mode`, `/doctor`, `/permissions` or, on the Home, `/workflows`, `/agents` and `/help`. It is what you do in at most three keys and then return to what you were doing; what you browse and work in for a while is a screen (the *Runs screen*). `Esc` steps back one step and closes it on the first; `Ctrl+C` closes it; neither confirms anything, and a closed popup leaves nothing in the transcript. A popup never opens by itself (the first-run setup is the one exception) and never asks for a decision that changes nothing. See [ADR-0148](decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) and [home.md](reference/cli/home.md#the-homes-management-popups-mvp-11-unit-8-2026-11-27).
- **Wait clock** — the display on a *sheet*'s rule of how long it has waited for the person: `waiting 0:41`, then `waiting 2m`, `waiting 1h 07m`, in the alternate screen, and a static `waiting since 14:05` inline (with the day when the wait began on an earlier one). It is display state: it is in no snapshot and no guard reads it, so a gate parked an hour ago still waits out its dwell. See [ADR-0147](decisions/0147-a-system-started-question-is-a-sheet-with-a-frame-and-a-wait-clock.md).
- **Runs screen** — the Home's one screen for browsing runs and working in them, with two tabs, **Active** and **History**, both listing this directory's runs by default (`[a] all` for every project's, `[a] here` to narrow again). It opens from `[h]` in the `/workflows` popup, from a run row of the work page and from a last run in a workflow's detail; there is no `/runs` command. It was the tab host (Defined, Active, History, Permissions) until MVP-11 unit 8. See [home.md](reference/cli/home.md#the-runs-screen-active-and-history-mvp-8-step-4-2026-11-23-narrowed-in-mvp-11-unit-8-2026-11-27).
- **Inspection popup** — the large popup (the terminal's size less two columns and one row, 78 × 23 at 80×24) that the approval *sheet* owns: `[v]` shows the full diff or command in it and `/details` the tool calls. `Esc` and `[b]` step back to the approval and never reject; Allow stays locked until the whole target has been on screen and every masked value revealed, and the sheet stays pending underneath. See [ADR-0148](decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §7 and [chat-session.md](reference/cli/chat-session.md#the-full-view-and-the-tool-details).
- **Grid** — the layout the Home's landing and the chat share: a *margin* on the left that belongs to the host and a *content column* that holds every word a person or a model wrote. The margin is 6 columns from 80 to 99 columns and 8 from 100; the content column is `min(96, columns − 2 × margin)` wide (68 at 80, 84 at 100, 96 from 112) and left-hung, so a wider terminal leaves its room on the right. See [chat-session.md](reference/cli/chat-session.md#the-transcript-grid-mvp-11-unit-9-2026-11-27) and [ADR-0146](decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4.
- **Margin** — the columns to the left of the *content column* in which only the host draws: the *speaker marker*, a tool call's `▸` and, in the inline renderer, the role words `you`, `agent`, `tool` and `note`. A margin cell is drawn from a role of a closed set and takes no text, so nothing a model or a person wrote can stand in it. See [chat-session.md](reference/cli/chat-session.md#the-speaker-marker).
- **Content column** — the column of the *grid* that holds every word a person or a model wrote: the transcript's rows, the streamed answer, the prompt's text. Rows wrap inside it and a wrapped row hangs under the text of the first. At 80 columns it is 68 wide. See [chat-session.md](reference/cli/chat-session.md#the-margin-and-the-content-column).
- **Speaker marker** — the host's mark in the *margin* that says who spoke: `›` (`>` without colour) on the first row of the person's turn, `▸` (`->`) on a tool call's row, `⇄` (`<->`) on the model-switch notice; a reply has none. The inline renderer, the accessible mode, writes a word instead. It is data the host sets on a row, never a character of the row's text. See [ADR-0145](decisions/0145-the-cli-has-one-surface-language.md#6-the-speaker-marker) §6 and [accessibility.md](reference/cli/accessibility.md#the-escape-hatch--the-inline-renderer).
- **Prompt block** — the chat's bottom block, in the Home's order: a leading row, the prompt, a thin rule, the status line and the hint (five rows at rest). While a turn runs the in-flight turn stands where the prompt would, a docked *sheet* takes the block's place, and while the `/` palette is open its list stands above the prompt. See [ADR-0146](decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md) §4.
- **Withdraw** — to take back a permission a person gave: a remembered command (a grant kept for the project) or a session approval. The user-facing verb of the `/permissions` sheet (`d`, then `Enter`); the command that does the same from a script is `relavium permissions revoke`. Withdrawing only ever makes the chat ask **more**. See [command-permissions.md](reference/cli/command-permissions.md).
- **Remember** — the command card's answer (`Ctrl+O`, then `Enter`) that stores a grant (a keyed digest, never the command) for one exact command under the project's root, in an operator-owned file on this machine and never in the repository, and also approves it for the chat it is made in. In `auto` a remembered command runs without a card until a file write outdates it. See [command-permissions.md](reference/cli/command-permissions.md).
- **Session approval** — an exact command the person approved for the rest of one chat (*Allow this session*, `Ctrl+G` then `Enter`, or a *Remember*, which also leaves one). Kept in memory, keyed by the exact argv and never by the tool; it removes the card in every mode that asks, and it is gone when the chat ends. See [command-permissions.md](reference/cli/command-permissions.md#the-command-card).
- **Write mark** — the record, per project root, of when a chat of this machine last applied a file write there ([ADR-0138](decisions/0138-a-file-write-is-remembered-for-the-project-and-outdates-older-grants.md)). A remembered command whose grant is older than the mark is *stale* and asks again in `auto` until *Remember* renews it. See [command-permissions.md](reference/cli/command-permissions.md#the-write-marks).
- **Continue checkpoint** — the card a chat turn shows after `[chat].checkpoint_tool_turns` tool rounds, asking whether to continue instead of stopping at a fixed ceiling ([ADR-0136](decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md)). Not the engine's *Checkpoint* (saved state at a node boundary). See [chat-session.md](reference/cli/chat-session.md#the-continue-checkpoint--mvp-4-adr-0136).

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
  (approve / reject / provide input) before continuing. Supports a timeout that
  either auto-approves or fails the run (an `escalate` action is **reserved** for a
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
