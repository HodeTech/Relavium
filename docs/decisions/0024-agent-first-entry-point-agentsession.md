# ADR-0024: Agent-first entry point — `AgentSession` alongside `WorkflowEngine`

- **Status**: Accepted
- **Date**: 2026-06-05
- **Related**: [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0009-git-native-workflow-yaml.md](0009-git-native-workflow-yaml.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md), [0025-agent-surface-refines-desktop-scope.md](0025-agent-surface-refines-desktop-scope.md), [0026-session-export-to-workflow.md](0026-session-export-to-workflow.md), [0059-cli-mid-session-model-reseat.md](0059-cli-mid-session-model-reseat.md), [../reference/contracts/agent-session-spec.md](../reference/contracts/agent-session-spec.md), [../reference/contracts/sse-event-schema.md](../reference/contracts/sse-event-schema.md), [../reference/desktop/database-schema.md](../reference/desktop/database-schema.md), [0050-cli-history-db-at-rest-posture.md](0050-cli-history-db-at-rest-posture.md)

> Amended 2026-06-28: the `history.db` is **not** encrypted at rest on the **CLI** surface — it is
> guarded by `0700`/`0600` OS file permissions with API keys in the keychain only (see
> [ADR-0050](0050-cli-history-db-at-rest-posture.md)). Only the **desktop** surface uses a SQLCipher-encrypted
> store. The Context below originally said "encrypted" without that surface distinction; read it as
> surface-specific.
>
> Amended 2026-07-06: the "one agent + one model bound for the session lifetime" rule is **refined** (not
> reversed) by [ADR-0059](0059-cli-mid-session-model-reseat.md) — a mid-session `/models` **model switch** is a
> host-side **reseat** (a new `AgentSession.resume` instance bound to the new model, carrying the text-only
> transcript + cumulative cost/turns), so each instance still binds exactly one model for its lifetime; the
> switch is a new instance, never an in-place rebind of the memoized fallback plan.

## Context

Relavium was originally framed as **workflow-first**: the unit of value is a git-committable
`.relavium.yaml`, the LLM is a node inside a workflow, and chat is only a helper for "which
workflow do I trigger?". The product owner has decided to pivot to **agent-first + workflow**: a
conversational AI coding assistant must be a **first-class entry point on every surface** (CLI,
desktop, VS Code), *alongside* the workflow runner, so users can start in chat and **graduate** a
high-value conversation into a committed workflow.

The risk is doing this in a way that forks the engine or weakens a non-negotiable. The engine
(`@relavium/core`) has **zero platform-specific imports** ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md))
and already plans an `AgentRunner` (per-node LLM execution), a `ToolRegistry`, the `@relavium/llm`
seam, and a `RunEventBus`. Phase 1 has not started, so the entry point can be designed into the
engine before any engine code exists — the cheapest possible moment.

## Decision

**Add `AgentSession` as a second first-class engine entry point in `@relavium/core`, alongside
`WorkflowEngine`.** It is an ongoing multi-turn conversation between a user and one agent that:

- **reuses the same substrate** — `AgentRunner`, the `ToolRegistry`, the `@relavium/llm` seam, and
  the event bus — rather than a parallel implementation;
- emits on a **`session:*` event namespace**, disjoint from the workflow `run:*` namespace, on the
  same bus (the canonical event home is [sse-event-schema.md](../reference/contracts/sse-event-schema.md));
- **auto-persists and is resumable** — sessions and their messages live in the existing
  `history.db` (CLI: unencrypted at rest, `0700`/`0600`-guarded per [ADR-0050](0050-cli-history-db-at-rest-posture.md);
  desktop: SQLCipher-encrypted) (new `agent_sessions` + `session_messages` tables; see
  [database-schema.md](../reference/desktop/database-schema.md));
- binds **one agent (and its `fallback_chain`) per session** in Phase 1 — no mid-session agent
  switching; multi-agent orchestration remains a workflow concern;
- can be **exported to a `.relavium.yaml` workflow** ([ADR-0026](0026-session-export-to-workflow.md)),
  the technical form of the "graduation path".

The runtime contract (lifecycle, message shape, context, export) has its single canonical home in
[agent-session-spec.md](../reference/contracts/agent-session-spec.md); this ADR records the decision,
not the spec.

Considered: **(A)** model chat as a thin wrapper over a one-node workflow — *rejected*: forces a
workflow file for every conversation, loses native multi-turn session semantics, and pollutes run
history. **(B)** a separate chat engine/package — *rejected*: forks the substrate, duplicating tool
dispatch, the seam, and the event bus, which is exactly the surface-drift risk the one-engine rule
guards against. **(C, chosen)** a second entry point on the *one* engine, sharing the substrate.

`SessionMessage` is a **persistence/transcript** type owned by the spec; it is **mapped** to the
seam's `LlmMessage` at call time, never copied — **no vendor SDK type crosses the seam**
([ADR-0011](0011-internal-llm-abstraction.md)). The engine stays zero-platform-import ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)), so sessions
run identically in Node, the Tauri WebView ([ADR-0018](0018-desktop-execution-and-rust-egress.md)),
the VS Code host, and (Phase 2) the cloud worker. Local/managed/cloud modes are **inherited** through
the existing `LLMProvider`/`ExecutionHost` seams — no new seam work.

## Consequences

### Positive

- One substrate, hardened once (sandbox / tool-policy / resource governance — ADR-0027/0028/0029),
  benefits **both** entry points; no second engine to keep in sync.
- The chat → workflow continuum becomes real: Relavium is the start *and* the destination.
- Local-first and keychain guarantees ([ADR-0006](0006-os-keychain-for-api-keys.md)) are unchanged —
  sessions reuse the same key handling and FS-scope tiers as workflows.

### Negative

- A session lifecycle and two new tables to design and maintain; the relationship between
  `session_messages` and the existing run `messages` table must be documented to avoid shape-drift
  (see [agent-session-spec.md](../reference/contracts/agent-session-spec.md)).
- The shared event bus now carries two namespaces; consumers must route purely on the `type`
  discriminant (mitigated by the disjoint `session:*` / `run:*` split).
- Two mental models (a *run* vs a *session*) in one product; mitigated by the export continuum and
  consistent vocabulary in [glossary.md](../glossary.md).
