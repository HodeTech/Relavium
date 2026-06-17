# Claude agent guide — Relavium

This file is the entry point for Claude-based AI agents (Claude Code, the Claude
API, subagents) working in this repository. Read it fully before taking any
action. Other AI agents should read [AGENTS.md](AGENTS.md), which points back here.

## What this project is

**Relavium** is a multi-surface, **local-first** AI agent platform — a
product of **HodeTech** ([github.com/HodeTech/Relavium](https://github.com/HodeTech/Relavium)).
*Start as an agent. Ship the workflow. Own every run.* You begin in a conversational
**agent session** — a first-class engine entry point on every surface (CLI `relavium chat`,
a desktop chat tab, a VS Code coding-assistant) — and graduate that session into a
multi-agent, multi-model **workflow** authored as **git-committable YAML**, run across a
Tauri desktop app, a VS Code extension, and a CLI. Both entry points — `AgentSession` and
`WorkflowEngine` — sit on one **pure-TypeScript engine shared by every surface**, reusing the
same tool registry, `@relavium/llm` seam, and event bus. See
[ADR-0024](docs/decisions/0024-agent-first-entry-point-agentsession.md) and
[ADR-0026](docs/decisions/0026-session-export-to-workflow.md).

It is a **Turborepo + pnpm monorepo**:

| Package / App | What it is |
|---------------|-----------|
| `packages/shared` (`@relavium/shared`) | Zod schemas + inferred types — the single source of truth (workflow/agent/run-event/config). |
| `packages/llm` (`@relavium/llm`) | Relavium's **own** multi-LLM abstraction: the `LLMProvider` seam + thin hand-rolled adapters over the official provider SDKs. No Vercel AI SDK, no LangChain. |
| `packages/core` (`@relavium/core`) | **The engine** — YAML→DAG parse, runner, checkpoint/resume, retry. **Zero platform-specific imports.** The most important package. |
| `packages/db` (`@relavium/db`) | Drizzle schema + migrations — same schema for SQLite (local) and Postgres (cloud). |
| `packages/ui` (`@relavium/ui`) | Shared React components: ReactFlow node types + shadcn/ui. |
| `apps/desktop` | Tauri v2 desktop app — the agent-management center (canvas, run monitoring). |
| `apps/cli` | Terminal CLI (`commander.js` + `ink`). The engine's first real consumer + regression harness. |
| `apps/vscode-extension` | Standalone VS Code extension (bundles the engine). |
| `apps/api`, `apps/portal` | **Phase 2** — backend + **control-plane** web portal (not a second canvas). |

A run executes in one of **three execution modes** behind the one `LLMProvider` seam —
**local** (BYOK, the Phase-1 default), **cloud** (BYOK-central, Phase 2), and **managed**
(Relavium's own keys via a metered egress gateway; engine still runs locally, Phase 2). The
engine is identical across all three. See [ADR-0012](docs/decisions/0012-managed-inference-dual-mode.md) to [ADR-0015](docs/decisions/0015-managed-mode-data-handling-and-compliance.md)
and [docs/architecture/managed-inference.md](docs/architecture/managed-inference.md).

**Status:** Phase 1 in progress — milestone M1 (LLM seam proven) reached (PR #9, 2026-06-07); the `FallbackChain` runner (1.K) landed, completing 1.m2 with the cost tracker (PR #13, 2026-06-11); the run loop (1.N — `WorkflowEngine` + `RunEventBus`) landed (PR #17, 2026-06-13) **completing 1.m3** (parse → DAG → run loop emits the canonical event stream), with the built-in `ToolRegistry` (1.T, a 1.m4 component) landing alongside it as the other `AgentRunner` (1.O) join prerequisite; the **`AgentRunner` (1.O) — per-node LLM execution behind the seam — landed (PR #18, 2026-06-14)**; and the **node-type handlers (1.P) — the six non-agent `NodeExecutor` arms (condition / transform / fan_out / fan_in / input / output) behind a dispatching executor — landed (PR #20, 2026-06-14)**; and **checkpoint/resume (1.R) + the human gate (1.Q) landed (PR #22, 2026-06-15)** — the derived `Checkpointer` + cross-process `resumeFromCheckpoint`, and the `human_in_the_loop` gate with the one-shot timeout port; and **node retry (1.S) — the above-chain whole-node retry budget ([ADR-0040](docs/decisions/0040-node-retry-budget-above-the-chain.md), amending ADR-0038) — landed (PR #24, 2026-06-15)**, re-dispatching a whole node on a retryable failure up to `retry.max` attempts (with `node:retrying`, abort-aware backoff, and `retry_on` filtering), with retry-from-node (ADR-0040 Part B) deferred to Phase-2; and the **pre-egress budget governor (1.AC, [ADR-0028](docs/decisions/0028-workflow-resource-governance.md)) + the `AgentSession` agent-first entry point (1.V, [ADR-0024](docs/decisions/0024-agent-first-entry-point-agentsession.md)) landed together (PR #26, 2026-06-16)** — 1.AC was the last 1.m4 component, so **1.m4 is complete** (the full engine stack: node handlers, gate, checkpoint/resume, retry, tools, sandbox, budget governor), and 1.V opens the Lane-C agent-first sub-spine (1.m5); then the **end-to-end Node harness (1.U) landed (PR #27, 2026-06-16), reaching 🎯 M2** — the engine runs end-to-end (live streaming + per-node-boundary checkpointing + cross-process resume + node retry + provider failover, gap-free), **completing the Phase-1 engine critical path**. The remaining Phase-1 work is additive and off the critical path (Lane C: the **`session:*` namespace (1.W) landed (PR #28, 2026-06-17)** — the `SessionEventSink`→`RunEventBus` adapter + per-session `sequenceNumber`, the `SessionHandle`, and the combined `RunOrSessionEventSchema` gate — and **session persistence (1.X) landed (PR #29, 2026-06-17)** — the `agent_sessions`/`session_messages` tables + migration, `SessionMessageSchema`/`AgentSessionSchema`, and the `SessionStore` + domain↔row mappers (data-layer only); then **session checkpoint/resume (1.Y) + export-to-workflow (1.Z) landed (PR #30, 2026-06-17)** — `reconstructSessionState`/`AgentSession.resume` (reload-not-replay; preload the text-only transcript, re-seed turnCount/cost, no `session:started` re-emit) + the `serializeWorkflow`/`sessionToWorkflow` pair (one agent node per completed turn, transcript in `metadata`, secret/signature exclusion structural) — leaving only the **1.AA** chat-regression harness ‖ the 1.m6 multimodal sub-spine; **Phase 2 (CLI, M3) is unblocked**.
Phase 0 (M0, 2026-06-04) landed the monorepo, strict toolchain + CI, `@relavium/shared` (the
full Zod contract set), the no-vendor-type seam fence, and `@relavium/db`. Phase 1 has since
landed `@relavium/llm` — the `LLMProvider` seam + all three adapters (Anthropic, OpenAI/DeepSeek,
Gemini), green on one shared conformance suite with no vendor type crossing the seam, plus the
ADR-0030 seam-shape amendment — and the **ADR-0031 multimodal seam-shape amendment (1.AD, PR #11,
2026-06-10)**: the media content/stream union members, the per-modality capability matrix, and the
reserved generator methods, shape-only, landed before the seam's exhaustive consumers. The
`FallbackChain` runner (1.K, PR #13) is now landed and fully covered. The
[`@relavium/core` engine](docs/roadmap/phases/phase-1-engine-and-llm.md) lane has since landed the
**`WorkflowYAMLParser` (1.L, PR #14)**, the **`{{ … }}` interpolation engine + parse-time secret-taint
gate (1.L2, PR #15)**, the **DAG builder + `RunPlan` (1.M)** plus the **QuickJS-wasm expression
sandbox (1.AB)** (PR #16, 2026-06-13), and the **run loop — `WorkflowEngine` + `RunEventBus` (1.N)**
together with the **built-in `ToolRegistry` (1.T)** (PR #17, 2026-06-13), the **`AgentRunner` (1.O)**
join (PR #18, 2026-06-14 — host-injected provider resolution behind the seam, the correlation-agnostic
turn core, the tool-call loop, and the same-provider reasoning replay), and the **node-type handlers
(1.P)** (PR #20, 2026-06-14 — the six non-agent `NodeExecutor` arms behind a dispatching executor,
executor-only with a `secretInputNames` masking gate on `NodeExecContext`), and **checkpoint/resume
(1.R) + the human gate (1.Q)** (PR #22, 2026-06-15 — the derived `Checkpointer` (state folded from the
`run_events` log, no checkpoint table — ADR-0003) + cross-process `resumeFromCheckpoint` with idempotent
re-delivery and a `workflow_mismatch` identity guard, and the `human_in_the_loop` gate's suspend/resume
plus the one-shot `setTimer` timeout port — `approve` auto-resolves, `reject` fails with `run_timeout`).
The pre-egress budget governor (1.AC) + the agent-first `AgentSession` (1.V) landed together (PR #26)
**completing 1.m4**; then the end-to-end Node harness (1.U) landed (PR #27, 2026-06-16) **reaching M2** —
the Phase-1 engine critical path is complete. The additive Lane-C agent-first sub-spine is now **complete**
(session events **1.W ✅ (PR #28)** + persistence **1.X ✅ (PR #29)** + checkpoint/resume **1.Y** & export **1.Z ✅ (PR #30, 2026-06-17)** + the **1.AA** chat-regression harness ✅ (2026-06-17), closing **1.m5**);
remaining Phase-1 work is the 1.m6 multimodal sub-spine; Phase 2 (CLI) is unblocked. See
[docs/roadmap/current.md](docs/roadmap/current.md). See [README.md](README.md) for the public overview.

## Non-negotiable rules for AI agents

These apply to every AI agent in this repo, regardless of model, runner, or tool.

1. **TypeScript-first, strict.** All source is TypeScript. Strict mode; no `any`,
   no unsafe `as`. Prefer type guards. See [docs/standards/code-style-typescript.md](docs/standards/code-style-typescript.md).
2. **Build in-house; minimize dependencies.** Write our own better implementations
   for the core. **No new runtime dependency without an ADR.** Never adopt the
   Vercel AI SDK or LangChain for the LLM layer — Relavium owns `@relavium/llm`.
   See [docs/standards/architectural-principles.md](docs/standards/architectural-principles.md)
   and [ADR-0011](docs/decisions/0011-internal-llm-abstraction.md).
3. **Never reinvent security-critical primitives.** Use vetted crypto, TLS, and the
   OS keychain — wrap them, never hand-roll them.
4. **No vendor SDK type crosses the `@relavium/llm` seam.** The `LLMProvider`
   contract is expressed only in Relavium/Zod types. See
   [ADR-0011](docs/decisions/0011-internal-llm-abstraction.md) and
   [docs/reference/shared-core/llm-provider-seam.md](docs/reference/shared-core/llm-provider-seam.md).
5. **The engine (`packages/core`) has ZERO platform-specific imports** — it runs
   identically in Node, the Tauri WebView, the VS Code extension host, and (Phase 2)
   the Bun API.
6. **Local-first, secure by default.** API keys live in the OS keychain — never in
   plaintext, never in logs, never sent to the frontend or into a job payload. See
   [ADR-0006](docs/decisions/0006-os-keychain-for-api-keys.md) and
   [docs/standards/security-review.md](docs/standards/security-review.md). *(Phase-2
   managed mode)* Relavium's own provider keys live in a KMS-backed master-key vault and
   per-provider key pools, attached only inside the gateway on the outbound request — they
   never cross the `LLMProvider` seam either ([ADR-0013](docs/decisions/0013-managed-key-vault-and-pools.md)).
7. **The desktop app is an agent-management center, NOT an IDE.** A conversational
   chat tab — an agent *capability* — is allowed and co-equal with the canvas; the
   forbidden boundary is the **IDE shell**: no code editor, no file-tree browser, no
   terminal. See [ADR-0007](docs/decisions/0007-desktop-is-not-an-ide.md), refined (not
   reversed) by [ADR-0025](docs/decisions/0025-agent-surface-refines-desktop-scope.md).
8. **One canonical home per artifact.** Concrete specs (workflow/agent YAML,
   run-event schema, IPC, config, node types, DB schema) live only in their
   [docs/reference/](docs/reference/) file; everything else links to it, never
   restates it.
9. **Record non-trivial decisions as ADRs** in [docs/decisions/](docs/decisions/)
   using the condensed MADR form. ADRs are **append-only** — to change one, write a
   new ADR that supersedes it; never rewrite history.
10. **English, kebab-case files, relative doc links, Mermaid diagrams,
    Conventional Commits** (scope per package, reference the ADR/task). See
    [docs/standards/commit-style.md](docs/standards/commit-style.md) and
    [docs/standards/documentation-style.md](docs/standards/documentation-style.md).

## Where to find things

| Need | Path |
|------|------|
| What & why (product) | [docs/vision.md](docs/vision.md) · [docs/product-constraints.md](docs/product-constraints.md) · [docs/uvp.md](docs/uvp.md) |
| The pinned stack | [docs/tech-stack.md](docs/tech-stack.md) |
| Monorepo layout | [docs/project-structure.md](docs/project-structure.md) |
| How it's built | [docs/architecture/](docs/architecture/) |
| Why it's built this way (ADRs) | [docs/decisions/](docs/decisions/) |
| Exact contracts/specs | [docs/reference/](docs/reference/) |
| Binding rules (code/test/security/commits) | [docs/standards/](docs/standards/) |
| What's active + the phase plan | [docs/roadmap/current.md](docs/roadmap/current.md) · [docs/roadmap/phases/](docs/roadmap/phases/) |
| Recurring agent procedures | [.claude/skills/](.claude/skills/) |
| Project terms | [docs/glossary.md](docs/glossary.md) |

## Reading order

1. [README.md](README.md) — what Relavium is.
2. **This file (CLAUDE.md).**
3. [docs/glossary.md](docs/glossary.md) — the vocabulary used everywhere.
4. [docs/roadmap/current.md](docs/roadmap/current.md) — what's active now.
5. The ADRs in [docs/decisions/](docs/decisions/) in numerical order.
6. The [docs/standards/](docs/standards/) relevant to your task.
7. The skill at [.claude/skills/&lt;slug&gt;/SKILL.md](.claude/skills/) matching your task.

## Build, test, lint

Once Phase 0 lands the monorepo, all work goes through pnpm + Turborepo:

```bash
pnpm install
pnpm turbo run lint typecheck test    # across all workspaces, in dependency order
pnpm turbo run build
```

Never use `npm` or `yarn`. Respect `pnpm-workspace.yaml` and the `workspace:*`
protocol for inter-package dependencies. No circular dependencies.

## Skills

When the maintainer asks for a recurring task — write an ADR, scaffold a package,
add an LLM adapter, review a diff — there is usually a **skill** at
`.claude/skills/<slug>/SKILL.md` describing the correct procedure step by step.
Read the skill in full and check its done-criteria before finishing. Skills are how
the project keeps recurring work consistent; they cite the standards and ADRs,
never duplicate them. See [.claude/skills/README.md](.claude/skills/README.md) for
the index.

A project-aware reviewer subagent lives at
[.claude/agents/relavium-reviewer.md](.claude/agents/relavium-reviewer.md).

## Before starting work

1. Read the ADRs in numerical order — they are the design language of the project.
2. Read the [docs/standards/](docs/standards/) relevant to your change before editing.
3. If a task spans more than two or three files, propose a plan first.
4. If a change touches security-relevant code (keys, crypto, the keychain, custom
   provider base URLs, the JS sandbox), flag it for explicit review.
5. Respect package boundaries and the `@relavium/llm` seam.

## Escalation

If a requested change would violate any non-negotiable rule above, **stop and ask**
before proceeding. It is better to pause than to silently weaken a guarantee.
