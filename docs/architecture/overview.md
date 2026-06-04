# Architecture overview

Relavium is a multi-surface, local-first AI agent workflow platform. Four
surfaces — a Tauri v2 **desktop app**, a **VS Code extension**, a **CLI**, and a
Phase-2 **web portal** — all drive the *same* pure-TypeScript execution engine
(`packages/core`) talking to the *same* multi-LLM provider layer
(`packages/llm`). Workflows and agents are git-committable YAML files; in Phase 1
everything runs on the user's machine with no account, no server, and no cloud
dependency. This document is the system map every other `docs/architecture/`
document elaborates one piece of.

```mermaid
flowchart TB
    subgraph Surfaces["Surfaces (UI / entry points)"]
        Desktop["Desktop app<br/>Tauri v2 (Rust shell + React WebView)<br/>ReactFlow canvas · run monitor · cost"]
        VSCode["VS Code extension<br/>standalone · bundles the engine"]
        CLI["CLI<br/>commander.js + ink"]
        Portal["Web portal<br/>(Phase 2)"]
    end

    subgraph Packages["Shared packages (TypeScript, surface-agnostic)"]
        Core["packages/core<br/>WorkflowEngine · DAG runner ·<br/>checkpoint/resume · RunEventBus"]
        LLM["packages/llm<br/>LLMProvider seam · adapters over official SDKs<br/>fallback chains · cost · tool normalize"]
        Shared["packages/shared<br/>Zod schemas + types"]
        DB["packages/db<br/>Drizzle schema (SQLite + Postgres)"]
        UI["packages/ui<br/>shadcn/ui components"]
    end

    subgraph Local["Local machine (Phase 1)"]
        SQLite["SQLite (SQLCipher)<br/>workflows · agents · runs · costs"]
        Keychain["OS keychain<br/>API keys"]
        FS["Filesystem<br/>.relavium/*.relavium.yaml"]
    end

    Providers["LLM providers<br/>Anthropic · OpenAI · Gemini · DeepSeek"]

    subgraph Cloud["Cloud layer (Phase 2 — optional)"]
        API["apps/api<br/>Hono + BullMQ"]
        Postgres["PostgreSQL 16"]
        Redis["Redis 7 (queues + streams)"]
    end

    Desktop --> Core
    VSCode --> Core
    CLI --> Core
    Portal -.-> API
    Core --> LLM
    Core --> Shared
    LLM --> Shared
    Core --> DB
    DB --> SQLite
    LLM --> Keychain
    Core --> FS
    LLM -->|HTTPS, direct from machine| Providers
    API -.-> Core
    API -.-> Postgres
    API -.-> Redis
    API -.->|HTTPS| Providers
```

> This is a **logical package-dependency** map, not a per-host data flow. On the
> desktop the keychain read and the authenticated provider egress do **not** happen
> in the WebView: `@relavium/llm` hands a request shape + key *reference* to the Rust
> `llm_stream` command, which reads the key and makes the HTTPS call (the raw key
> never enters the WebView). See [local-first-and-security.md](local-first-and-security.md)
> for the desktop trust-boundary diagram and [ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md).

## Context

The shape of Relavium is fixed by a small set of decisions, recorded as ADRs and
summarized in [../tech-stack.md](../tech-stack.md):

- The desktop app is **Tauri v2**, not Electron — see
  [ADR-0001](../decisions/0001-tauri-v2-over-electron.md). It is an agent
  *management* center, not an IDE (see
  [../product-constraints.md](../product-constraints.md)).
- All frontends are **Vite + React 19 + TanStack Router**, not Next.js, because
  SSE streaming and the ReactFlow canvas are incompatible with RSC/edge runtime.
- The workflow engine is a **pure-TypeScript** package (`packages/core`), not a
  Python/LangGraph service and not a Hono/Next.js executor.
- Multi-LLM access goes through Relavium's own **`@relavium/llm`** abstraction in
  `packages/llm` — thin hand-rolled adapters over each provider's official TS SDK
  behind one owned, provider-agnostic seam, with no 3rd-party framework.
- Local data is **SQLite + Drizzle**; API keys live in the **OS keychain**.

These constraints leave a clear structure: one shared engine, several thin
surfaces, local-first storage, and a Phase-2 cloud layer that wraps — never
replaces — the engine.

## The four surfaces

Each surface is a thin client over the shared engine. None of them re-implements
execution logic; a bug in any surface is treated as a bug in `packages/core`.

| Surface | Shell | How it runs the engine | Role |
|---------|-------|------------------------|------|
| **Desktop app** | Tauri v2 (Rust + React WebView) | Engine runs **in the WebView's JS runtime**; run events are produced and consumed WebView-side (no IPC). Only the authenticated LLM egress is delegated to a Rust command, which streams `StreamChunk` frames back — the raw key never enters the WebView ([ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md)) | Primary surface — visual canvas, agent config, run monitoring, cost tracking. See [desktop-architecture.md](desktop-architecture.md). |
| **VS Code extension** | VS Code Extension Host (Node) | Engine bundled in-process; no desktop app required | Inline triggering (right-click a file → run), status-bar monitor, sidebar panels. |
| **CLI** | Node + commander.js + ink | Engine called directly; ink renders the live TUI | `relavium run` / `list` / `create` / `logs` / `gate`; CI/CD and scripting. Doubles as the canonical engine integration-test harness. |
| **Web portal** | Vite + React SPA (browser) | **Phase 2 only** — talks to `apps/api` over HTTPS; engine runs in cloud workers | Usage, quota, team sharing, cloud-triggered runs. Not where local workflows run. |

## The shared packages

The monorepo (Turborepo + pnpm) centers on a few surface-agnostic packages —
canonical definitions and per-package purpose are in
[../project-structure.md](../project-structure.md):

- **`packages/core`** — the single most important package. It parses workflow
  YAML, builds the DAG run plan, executes nodes (including the
  orchestrator-as-node), checkpoints state, and emits run events on a
  `RunEventBus`. It has **zero platform-specific imports**, so it runs identically
  in the Tauri WebView, the VS Code extension host, the Node CLI, and a Bun cloud
  worker. See [shared-core-engine.md](shared-core-engine.md).
- **`packages/llm`** — Relavium's own provider abstraction: a provider-agnostic
  `LLMProvider` seam implemented by thin adapters over each provider's official TS
  SDK (Anthropic and Gemini dedicated; OpenAI and DeepSeek share one
  OpenAI-compatible adapter), giving unified streaming for Anthropic / OpenAI /
  Gemini / DeepSeek plus fallback chains, tool-schema normalization, and cost
  accounting — no 3rd-party framework, and no vendor type crosses the seam. See
  [multi-llm-providers.md](multi-llm-providers.md).
- **`packages/shared`** — the Zod schemas and TypeScript types every package
  imports (workflow, agent, run, node, edge, run-event, cost-event). The schema
  shapes are documented under [../reference/contracts/](../reference/contracts/).
- **`packages/db`** — Drizzle schema and migrations, with one set of table
  definitions that targets SQLite locally and Postgres in the cloud. See
  [../reference/desktop/database-schema.md](../reference/desktop/database-schema.md).
- **`packages/ui`** — the shared shadcn/ui component library.

## Local data (Phase 1)

In Phase 1 the user's machine is the entire backend:

- **SQLite** (via `tauri-plugin-sql`, with SQLCipher) stores workflows, agents,
  run history, run events, and cost records. DDL lives in
  [../reference/desktop/database-schema.md](../reference/desktop/database-schema.md).
- **OS keychain** (macOS Keychain / Windows Credential Manager / libsecret)
  stores provider API keys. They are never written to disk in plaintext and never
  sent to the frontend. See
  [local-first-and-security.md](local-first-and-security.md) and
  [../reference/desktop/keychain-and-secrets.md](../reference/desktop/keychain-and-secrets.md).
- **The filesystem** holds the git-committable `.relavium/*.relavium.yaml`
  workflow files and `*.agent.yaml` agent files — the
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md) and
  [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md) define them.

## End-to-end data flow

A run follows the same path no matter which surface starts it (sourced from the
synthesis `dataFlow` trace):

```mermaid
sequenceDiagram
    participant U as User (canvas / CLI / VS Code)
    participant E as packages/core (WorkflowEngine)
    participant L as packages/llm (LLMProvider seam)
    participant T as injected transport<br/>(direct fetch / Rust llm_stream)
    participant P as LLM provider
    participant DB as SQLite

    U->>E: start(workflowId, input)
    E->>E: WorkflowYAMLParser validates YAML
    E->>E: build DAG RunPlan
    loop per ready node
        E->>L: run agent node (model + messages + tools)
        Note over L,T: Node surfaces: direct fetch (key resolved in-process)<br/>Desktop: Rust llm_stream (request + key ref; Rust reads key, attaches Authorization)
        L->>T: stream request (AbortController-guarded)
        T->>P: streaming HTTPS
        P-->>T: token stream
        T-->>L: StreamChunk frames
        L-->>E: tokens on WebView-side RunEventBus
        E-->>U: surface renderer paints tokens<br/>(WebView-side bus / postMessage / ink)
        E->>DB: checkpoint on node completion
    end
    E->>DB: write final output + cost record
    E-->>U: run complete
```

Key points:

- Surfaces subscribe to the engine's `RunEventBus` and render events the same way;
  the event contract is the [SSE event schema](../reference/contracts/sse-event-schema.md).
  On the desktop the engine runs in the WebView, so its bus is WebView-side and run
  events do **not** cross IPC ([ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md));
  in the cloud they are delivered over HTTP SSE.
- LLM calls go from the user's machine to the provider in Phase 1 with no Relavium
  server in the path. On the Node-style surfaces the adapter calls the provider
  directly; on the **desktop** the authenticated egress is delegated to a Rust
  command that holds the key reference, reads the key from the keychain, and streams
  `StreamChunk` frames back — so the raw key never enters the WebView
  ([ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md)).
- State is checkpointed to SQLite at each node boundary, which is what makes
  resume-after-crash and retry-from-node possible. See
  [execution-model.md](execution-model.md).

## The Phase-2 cloud layer (preview)

> Phase 2 is **not shipped in Phase 1**. It is included here only to show that the
> architecture is designed for it.

Phase 2 adds `apps/api` (Hono on Bun) and `apps/portal` without replacing the
local surfaces. The same `packages/core` engine is invoked through BullMQ jobs on
Redis instead of direct function calls, state moves to PostgreSQL, and run events
stream over HTTP SSE via Redis Streams. A user can link a cloud account and choose
*per workflow* whether to run locally or in the cloud — the engine exposes an
identical interface in both modes. Details and the transparent switch are in
[cloud-phase-2.md](cloud-phase-2.md).

## Where to go next

- [shared-core-engine.md](shared-core-engine.md) — the engine internals.
- [execution-model.md](execution-model.md) — how one run executes locally.
- [local-first-and-security.md](local-first-and-security.md) — the trust model.
- [../project-structure.md](../project-structure.md) — the full monorepo layout.
