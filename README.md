# Relavium

> Multi-surface AI agent workflow platform — a product of [HodeTech](https://github.com/HodeTech).

With Relavium you can **start as a conversational agent, graduate to workflows, or
author workflows directly** — a chat session and a git-committable multi-agent,
multi-model `.relavium.yaml` workflow are two entry points to the **same** engine.
Run them across a Tauri desktop app, a VS Code extension, and a CLI —
**local-first** in Phase 1, with cloud execution and a control-plane portal in
Phase 2. The engine is a pure-TypeScript package shared by every surface,
and multi-provider LLM access goes through Relavium's own `@relavium/llm`
abstraction over the official provider SDKs (no Vercel, no LangChain).

## Documentation

The canonical documentation lives in [`docs/`](docs/) — start at
[docs/README.md](docs/README.md), which is organized by *the kind of question each
section answers*.

| Start here | |
|------------|---|
| [Vision](docs/vision.md) · [Product constraints](docs/product-constraints.md) · [UVP](docs/uvp.md) | What and why |
| [Tech stack](docs/tech-stack.md) · [Project structure](docs/project-structure.md) | What it's built with |
| [Architecture](docs/architecture/) · [Decisions (ADRs)](docs/decisions/) · [Reference](docs/reference/) | How it works |
| [Roadmap](docs/roadmap/README.md) · [Standards](docs/standards/) | Where it's going, and the rules |

## Status

**Phase 0 — Foundations complete (milestone M0, 2026-06-04).** The Turborepo + pnpm
monorepo, the strict toolchain + GitHub Actions CI, `@relavium/shared` (the full Zod
contract set), the no-vendor-type seam fence, and `@relavium/db` (Drizzle schema +
migrations + SQLite client) are all in place and green. Work is now on
[Phase 1 — engine and LLM](docs/roadmap/phases/phase-1-engine-and-llm.md): the
`@relavium/llm` provider seam and the `@relavium/core` engine — which now also adds
the **AgentSession** runtime, persistence, and export-to-workflow workstream
alongside the workflow runner. See
[docs/roadmap/current.md](docs/roadmap/current.md) for live status.
