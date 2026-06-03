# Architecture documentation

This folder describes **how Relavium is built**. The **why** behind individual
technology choices lives in [../decisions/](../decisions/); concrete specs
(YAML formats, IPC contracts, DB DDL, store shapes, node types) live in
[../reference/](../reference/). The documents here are *explanation*: they
connect the surfaces, packages, and data stores into one mental model and trace
the paths a run takes through them.

Relavium is a multi-surface, local-first AI agent workflow platform. Four
surfaces — a Tauri v2 desktop app, a VS Code extension, a CLI, and (Phase 2) a
web portal — all share one pure-TypeScript execution engine. Workflows and
agents are git-committable YAML files. In Phase 1 everything runs on the user's
machine with no account and no cloud dependency. See [vision.md](../vision.md)
and [product-constraints.md](../product-constraints.md) for product framing, and
[tech-stack.md](../tech-stack.md) for pinned versions.

## Index

| Document | Purpose |
|----------|---------|
| [`overview.md`](overview.md) | Top-level topology: four surfaces, the shared `packages/core` + `packages/llm` engine, local SQLite, and the Phase-2 cloud layer. Start here. |
| [`shared-core-engine.md`](shared-core-engine.md) | `packages/core`: YAML→DAG compilation, the runner, checkpoint/resume, retry/fallback, and the orchestrator-as-node concept. |
| [`execution-model.md`](execution-model.md) | How a single run executes locally: the node DAG, token streaming, the human gate, and per-node checkpointing. |
| [`state-management.md`](state-management.md) | Frontend Zustand stores, the ReactFlow direct-subscription performance model, and the token double-buffer. |
| [`local-first-and-security.md`](local-first-and-security.md) | Local-first data flow, OS keychain secrets, the no-cloud Phase-1 trust model, and the threat boundaries. |
| [`desktop-architecture.md`](desktop-architecture.md) | The Tauri v2 shell: Rust glue vs the React WebView, the IPC primitives, plugins, and why the desktop app is not an IDE. |
| [`multi-llm-providers.md`](multi-llm-providers.md) | The internal `@relavium/llm` abstraction: a provider-agnostic `LLMProvider` seam implemented by thin adapters over each provider's official SDK — fallback chains, tool normalization, and cost tracking. |
| [`cloud-phase-2.md`](cloud-phase-2.md) | **Phase 2.** The optional cloud execution layer (BullMQ/Redis/Postgres), the web portal, and the transparent local→cloud switch. |
| [`managed-inference.md`](managed-inference.md) | **Phase 2.** The third execution mode: a thin Relavium gateway that proxies LLM egress on Relavium's key (engine stays local), with key vault + pools, streaming usage capture, and reserve→settle metering. The first Phase-2 deliverable, distinct from cloud execution. |
| [`key-management.md`](key-management.md) | The single canonical home for **how API keys are managed** across all modes: the three key-custody models — BYOK-local (user's key, OS keychain), BYOK-central / org vault (the enterprise BYOK answer, Phase 2), and managed (Relavium's keys in a KMS, Phase 2) — with the enterprise central-vault design and the security invariants. Answers "for an individual, a small team, and a 300-person enterprise: whose key is it, where does it live, who injects it?" |

## Reading order

Start with [`overview.md`](overview.md) for the system map. Then read
[`shared-core-engine.md`](shared-core-engine.md) and
[`execution-model.md`](execution-model.md) together — they are the heart of the
product. [`local-first-and-security.md`](local-first-and-security.md) cuts across
everything and is worth reading early. The surface-specific docs
([`desktop-architecture.md`](desktop-architecture.md),
[`state-management.md`](state-management.md),
[`multi-llm-providers.md`](multi-llm-providers.md)) elaborate one piece each.
[`cloud-phase-2.md`](cloud-phase-2.md) and
[`managed-inference.md`](managed-inference.md) are forward-looking and clearly
marked as not-yet-shipped Phase-2 behavior; read `cloud-phase-2.md` first, then
`managed-inference.md` for the third (managed) execution mode it cross-links.

## Conventions

- Topology and flow documents lead with a Mermaid diagram right after the H1.
- These are explanation docs. Concrete specs are **cited** by relative link to
  their canonical home in [../reference/](../reference/), never copied here.
- Architectural claims of the form *"Relavium does X because Y"* link to the ADR
  that made the choice, in [../decisions/](../decisions/).
- Phase-2 (cloud / portal) content is marked explicitly so it is never mistaken
  for shipped Phase-1 behavior.
