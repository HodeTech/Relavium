# Shared core engine (`packages/core`)

`packages/core` is the pure-TypeScript execution engine that every surface drives.
It parses a workflow YAML file, compiles it into a directed acyclic graph (DAG),
runs the nodes in dependency order, streams events as it goes, and checkpoints
state so a run can be resumed or retried. It has **zero platform-specific
imports**, which is the property that lets the desktop app, the VS Code extension,
the CLI, and (Phase 2) a cloud worker all behave identically. This document
explains how the engine is structured and why; the concrete contracts it consumes
and emits live in [../reference/](../reference/).

```mermaid
flowchart LR
    YAML[".relavium.yaml<br/>workflow file"] --> Parser["WorkflowYAMLParser<br/>(Zod validate)"]
    Parser --> Plan["RunPlan builder<br/>(topological sort)"]
    Plan --> Runner["WorkflowEngine<br/>run loop"]
    Chat["chat turn<br/>(CLI / desktop / VS Code)"] --> Session["AgentSession<br/>(conversational entry)"]
    Runner --> AR["AgentRunner<br/>(per node)"]
    Session --> AR
    AR --> LLM["packages/llm<br/>ProviderAdapter"]
    AR --> Tools["ToolRegistry"]
    Runner --> CP["Checkpointer<br/>(SQLite)"]
    Session --> CP
    Runner --> Bus["RunEventBus"]
    Session -->|session:* events| Bus
    Bus --> Surfaces["surfaces<br/>(IPC / postMessage / ink)"]
    Orchestrator["Orchestrator node<br/>(LLM-as-router)"] -.->|invoke_agent| AR
    Runner --> Orchestrator
```

> Status: this document describes the engine design from the synthesis and
> master-plan sources. Implementation-level interface signatures are the
> canonical property of [../reference/](../reference/); see the cross-links below.

## Context

The engine choice is settled by [../tech-stack.md](../tech-stack.md): a
**pure-TypeScript** engine, **not** a Python/LangGraph service and **not** a
Next.js/Hono request handler acting as an executor. The adversarial review behind
that decision found two things: (1) a long-running agent run (minutes to tens of
minutes) does not fit a serverless/HTTP request lifecycle, and (2) LangGraph adds
more failure surface than it removes for this workload — a plain topological
plan plus a dispatch table covers the great majority of cases, with durable
execution deferred to Phase 2. The result is one library that any host process
can call directly.

The build order reflects how central this package is: `packages/shared` +
`packages/llm` + `packages/core` are built first, then the CLI proves the engine
end-to-end before any UI is added (see
[../project-structure.md](../project-structure.md)).

## What the engine exports

`packages/core` exposes a small, surface-agnostic API surface — summarized here as
its canonical home. It has **two** entry points: every surface binds either to
`WorkflowEngine.start` / `resume` / `cancel` (the DAG runner) or to
`AgentSession.start` / `resume` / `cancel` (the conversational entry point). Both
drive the *same* substrate — see [Why one engine, shared by all surfaces](#why-one-engine-shared-by-all-surfaces).
The artifact contracts it consumes and produces live in
[../reference/contracts/](../reference/contracts/): the
[workflow YAML spec](../reference/contracts/workflow-yaml-spec.md), the
[run-event schema](../reference/contracts/sse-event-schema.md), the
[IPC contract](../reference/contracts/ipc-contract.md), and the
[AgentSession spec](../reference/contracts/agent-session-spec.md).

- **`WorkflowEngine`** — `start(workflowId, input)` / resume / cancel. Parses the
  workflow, builds the run plan, executes nodes, and owns checkpointing.
- **`AgentSession`** — the second, co-equal entry point: `start` / `resume` /
  `cancel` for a multi-turn conversation. It wraps the same `AgentRunner` and reuses
  `ToolRegistry`, the `packages/llm` seam, and `RunEventBus` (on a separate
  `session:*` namespace), auto-persisting to `history.db` and resumable from it. Its
  runtime contract — including `SessionMessage` and the one-way export-to-workflow
  scaffold — is canonical in the
  [AgentSession spec](../reference/contracts/agent-session-spec.md) (see also
  [ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md)).
- **`WorkflowYAMLParser`** — parses and validates a `.relavium.yaml` file against
  the Zod schema from `packages/shared`. The accepted shape is the
  [workflow YAML spec](../reference/contracts/workflow-yaml-spec.md).
- **`AgentRunner`** — executes a single agent node: assembles the prompt, calls
  the provider via `packages/llm`, handles tool calls, and applies retry/fallback.
- **`ToolRegistry`** — the engine-side registry and dispatcher for built-in and MCP
  tools. (The canonical-tool ↔ provider-wire reshape is the **`ToolNormalizer`**, which
  lives in `packages/llm` behind the seam, not in the engine — see
  [multi-llm-providers.md](multi-llm-providers.md) and
  [../standards/architectural-principles.md](../standards/architectural-principles.md).) See
  [../reference/shared-core/built-in-tools.md](../reference/shared-core/built-in-tools.md)
  and [../reference/shared-core/mcp-integration.md](../reference/shared-core/mcp-integration.md).
- **`RunEventBus`** — an in-house, **platform-free** typed event bus (pub/sub) over the `RunEvent`
  union that surfaces subscribe to. It is built in `packages/core`, **not** Node's `node:events` (the
  engine has zero platform imports — [ADR-0036](../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)).
  The event contract is the [SSE event schema](../reference/contracts/sse-event-schema.md).

## YAML → DAG compilation

A run begins by turning a declarative workflow file into an executable plan:

1. **Parse + validate.** `WorkflowYAMLParser` loads the file and validates it with
   the Zod `WorkflowSchema`. Validation failures are surfaced before any LLM call
   is made — this is also what powers the VS Code language-server diagnostics.
2. **Build the DAG.** Nodes declare dependencies (`dependsOn` / edges). The
   builder resolves them into a DAG and computes a topological order
   (Kahn's algorithm). Cycles are a hard error.
3. **Build the RunPlan.** The plan records, for each node, its inputs (resolved
   from `{{ node.output }}` interpolation against upstream results), its type, and
   its retry/fallback config.

The node-type catalog the DAG is built from is canonical in
[../reference/shared-core/node-types.md](../reference/shared-core/node-types.md),
which reconciles the authored YAML `type`s, the canvas components, and the engine
enum (this doc does not re-enumerate them). Note that `loop` and `subworkflow`
are **reserved (forward-compat; not executable/authorable in v1.0)** — they exist
in the engine enum as forward-compat slots but have no v1.0 YAML `type` and no
Phase-1 engine handler.

## The run loop

The `WorkflowEngine` walks the plan, dispatching every node whose dependencies are
satisfied. Independent branches run concurrently; the engine fans out parallel
nodes and joins them at aggregator/merge points. Each node type maps to a handler:

- **Agent nodes** delegate to `AgentRunner`, which streams from `packages/llm`.
- **Condition nodes** evaluate their expression and select the live branch.
- **FanOut / Aggregator** spread one input across N branches and merge the results
  (with strategies such as all-required / first-wins / quorum).
- **HumanGate** suspends the run and waits for an external decision (below).
- **Tool / Input / Output** run built-in tools and bind workflow I/O.

How a single run progresses node-by-node — including streaming and the human gate
— is covered in [execution-model.md](execution-model.md).

## The orchestrator-as-node concept

Relavium supports two complementary control styles in the *same* engine:

- **Static DAG** — the author wires nodes explicitly. Execution order is fixed by
  the edges. This is the default and is fully deterministic.
- **Orchestrator node** — a special agent node that acts as an LLM-driven router.
  Instead of (or alongside) static edges, it decides at runtime which agent to
  invoke next, using an `invoke_agent` tool to dispatch sub-tasks dynamically.
  Agents are registered to the orchestrator as tools (each with a structured
  "use this agent when / do NOT use for" description) so the model can pick the
  right one.

The reconciled design is **hybrid**: a static topological pre-plan handles the
linear and unconditional-parallel spine of a workflow, and dynamic LLM
re-evaluation happens only at conditional, fan-out, and human-gate boundaries.
This keeps most of a run cheap and deterministic while still allowing dynamic
delegation where it adds value. The orchestrator's prompt structure, agent-as-tool
schema, and selection rules are reference material;
the engine treats the orchestrator as just another node type that happens to emit
`invoke_agent` tool calls.

## Checkpoint and resume

State is persisted at every node boundary, not just at the end of a run. After
each node completes, the engine writes a checkpoint capturing run status, per-node
states, completed/pending node IDs, and (for an orchestrator) its message history.
This is what enables:

- **Resume after crash** — on startup the host reconciles in-flight runs from the
  last checkpoint instead of losing them.
- **Retry-from-node** — a user can re-run from any node without replaying the
  whole workflow.
- **Idempotency** — re-executing a node uses a stable idempotency key derived from
  `runId + nodeId + retryCount`, so a retry never double-applies side effects.

In Phase 1 there is **no separate checkpoint table**: the checkpoint is **reconstructed** by a
`Checkpointer` (`load(runId) → CheckpointState`) from the per-node `step_executions` rows
(`status` / `attempt_number` / `output_json` / `error_json`) and the ordered, replayable `run_events`
log, with the orchestrator's message history in `messages` (schema in
[../reference/desktop/database-schema.md](../reference/desktop/database-schema.md)).
`CheckpointState` is **derived**, never a stored blob: a pure fold over the ordered event stream
(`reconstructCheckpointState(events)`) captures run status, the surrogate `workflowId`, per-node
settled/paused states (with a `condition`'s selected branch from `node:completed.selected` and dimmed
branches from `node:skipped`), pending and already-resolved gate ids, the last `sequenceNumber`, and the
running token/cost tallies. The exact field set is the `CheckpointState` interface in
[`packages/core/src/engine/checkpoint.ts`](../../packages/core/src/engine/checkpoint.ts) — the one
authoritative shape; this section does not restate it. The same derivation is what the Phase-2 cloud
layer uses for durable execution — see [cloud-phase-2.md](cloud-phase-2.md).

**Reconstruction is total and deterministic** (same events → same state — the basis of idempotent
resume). A node that emitted `node:started` but no terminal event (it was running when the process
died) is simply **absent** from `nodeStates`, so the rehydrating engine seeds it `pending` and re-runs
it — bounded by the `runId + nodeId + retryCount` idempotency key, never by silently skipping it. What is
**not** in the checkpoint: the eager-once resolved `context` (`ctx.*`) is **re-resolved at run start**,
not reconstructed — and if a later change makes it part of a transported checkpoint it MUST cross that
boundary via `structuredClone`, never `JSON.stringify`→`parse` (which would re-materialise a `__proto__`
key as a real setter; the standing note lives at
[`interpolation/resolve.ts`](../../packages/core/src/interpolation/resolve.ts)).

A run suspended at a gate resumes in **two ways**: in the same process, `engine.resume(runId, gateId,
decision)`; across a restart, `engine.resumeFromCheckpoint({ runId, workflow, gateId, decision })`
rehydrates a fresh `RunExecution` from the reconstructed state (seeding node states, pending gates,
tallies, and the `sequenceNumber` so post-resume events continue gap-free — no `run:started` is
re-emitted) and returns a `RunHandle` for the rest of the run. An **identity guard** refuses a resume
whose workflow is not the one the run started on: the Phase-1 in-memory reference compares the surrogate
`workflowId` reconstructed from `run:started` (a different workflow → a typed `workflow_mismatch`). The
stronger guard that also catches a *same-slug, edited-content* workflow rides on the frozen
`runs.workflow_definition_snapshot` column ([../reference/desktop/database-schema.md](../reference/desktop/database-schema.md))
— a Phase-2 persistence concern wired with the real `RunStore`, not the event-derived in-memory state. **Idempotent re-delivery** never advances a run twice: re-delivering a decision to an
already-terminal run is a no-op (a closed handle, nothing re-emitted or re-persisted); re-delivering an
already-resolved gate on a still-running run drives the remaining work without re-applying the decision.
This holds within a process, and across processes once the prior process's `human_gate:resumed` is
persisted; the residual concurrent window (two processes loading the *same* still-pending gate before
either persists) is closed by a Phase-2 store-level uniqueness constraint on `human_gate:resumed` per
gate, not by the in-memory reference.

## Retry and fallback

Reliability is layered:

- **Node-level retry** — each node carries a retry budget; on a transient failure
  the engine retries with backoff, optionally adjusting inputs, and never silently
  skips a failed required node.
- **Provider fallback chains** — an agent can declare an ordered list of models
  (e.g. a primary Claude model, then GPT, then Gemini). If the primary provider
  errors or is rate-limited, `packages/llm` walks the chain. The fallback
  mechanism and cost accounting live in
  [multi-llm-providers.md](multi-llm-providers.md).

Known failure modes (infinite retry, wrong-agent selection, context overflow,
parallel deadlock, human-gate starvation) and their mitigations are catalogued in
the analysis sources and should be treated as a checklist when extending the
engine.

## Why one engine, shared by all surfaces

The single biggest correctness lever is that there is exactly **one** engine
package. The risk it guards against — surface drift, where the CLI behaves
differently from the desktop app, or VS Code runs a stale engine — is mitigated by:
zero platform-specific imports in `packages/core`, a single pinned version
imported by every surface, Turborepo rebuilds when core changes, and integration
tests that exercise core directly (not through any UI). Any surface-specific
workaround is a bug in core, not a surface patch.

### One substrate, two entry points

The same lever applies *across* the two entry points. `WorkflowEngine` (the DAG
runner) and `AgentSession` (the conversational entry,
[ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md)) are not two
engines — they are two front doors onto **one** substrate:

- **`AgentRunner`** — the single unit that assembles a prompt, calls a provider, and
  resolves tool calls. A workflow agent node and a chat turn run *the same* runner.
- **`packages/llm` seam** — both entry points reach every model through the one
  `LLMProvider` contract, with the same fallback chain and cost accounting.
- **`ToolRegistry`** — one registry and dispatcher of built-in and MCP tools, shared
  by both. A tool wired for a workflow node behaves identically when a session calls
  it.
- **`RunEventBus`** — one typed bus; the DAG runner emits `run:*`/`node:*` and a
  session emits `session:*` (one events spec, two namespaces — see the
  [SSE event schema](../reference/contracts/sse-event-schema.md)).
- **`Checkpointer`** — one persistence shape; workflow runs checkpoint per node,
  sessions auto-persist per turn and resume the same way.

This is the platform's core economy: **harden the substrate once, and both entry
points inherit it.** Three shared primitives, decided in this pass, sit *inside* the
substrate rather than at either entry point, so neither chat nor a workflow can route
around them:

- **Expression sandbox** ([ADR-0027](../decisions/0027-expression-sandbox.md)) —
  `condition` / `transform` / `merge_fn` expressions execute in a deterministic,
  capped, ambient-globals-free sandbox (no `new Function()`/`eval`), preserving the
  zero-platform-imports purity above.
- **Resource governance** ([ADR-0028](../decisions/0028-workflow-resource-governance.md)) —
  a pre-egress, estimate-and-block budget gate plus a run timeout and a parallel
  concurrency cap, applied before every provider call regardless of which entry point
  triggered it.
- **Tool-policy hardening** ([ADR-0029](../decisions/0029-tool-policy-hardening.md)) —
  command match, node tool-narrowing, secret-interpolation rejection, and SSRF
  defenses live in the shared `ToolRegistry` path, so both a chat turn and a workflow
  node get the same guarantees.

Because the substrate is the single home for execution, the LLM seam, tools, events,
checkpointing, and these three primitives, adding the conversational entry point
*widened the front door without forking the engine*. The narrative of how a session
layers its steering channel and per-surface UI on top of this substrate lives in
[agent-sessions.md](agent-sessions.md), which cites this section rather than
restating it.

## Related documents

- [execution-model.md](execution-model.md) — the run lifecycle in detail.
- [agent-sessions.md](agent-sessions.md) — the conversational entry point on this substrate (steering channel + per-surface UI).
- [multi-llm-providers.md](multi-llm-providers.md) — the provider layer the runner calls.
- [../decisions/0024-agent-first-entry-point-agentsession.md](../decisions/0024-agent-first-entry-point-agentsession.md) — why `AgentSession` is a second engine entry point.
- [../reference/contracts/agent-session-spec.md](../reference/contracts/agent-session-spec.md) — the AgentSession runtime contract.
- [../reference/contracts/workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) — the input format.
- [../reference/contracts/sse-event-schema.md](../reference/contracts/sse-event-schema.md) — the event contract.
- [../reference/shared-core/node-types.md](../reference/shared-core/node-types.md) — the node catalog.
