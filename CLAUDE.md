# Claude agent guide — Relavium

This file is the entry point for Claude-based AI agents (Claude Code, the Claude
API, subagents) working in this repository. Read it fully before taking any
action. Other AI agents should read [AGENTS.md](AGENTS.md), which points back here.

## What this project is

**Relavium** is a multi-surface, **local-first** AI agent workflow platform — a
product of **HodeTech** ([github.com/HodeTech/Relavium](https://github.com/HodeTech/Relavium)).
You design multi-agent, multi-model LLM workflows as **git-committable YAML** and
run them across a Tauri desktop app, a VS Code extension, and a CLI. The workflow
engine is a **pure-TypeScript package shared by every surface**.

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
| `apps/api`, `apps/portal` | **Phase 2 (cloud)** — backend + web portal. |

**Status: pre-implementation.** The documentation, architecture decisions, and
phased roadmap are complete; engineering begins at
[Phase 0 — Foundations](docs/roadmap/phases/phase-0-foundations.md). See
[README.md](README.md) for the public overview.

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
   [docs/standards/security-review.md](docs/standards/security-review.md).
7. **The desktop app is an agent-management center, NOT an IDE** — no code editor,
   file browser, or terminal. See [ADR-0007](docs/decisions/0007-desktop-is-not-an-ide.md).
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
