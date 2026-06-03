# Relavium

> Multi-surface AI agent workflow platform — a product of [HodeTech](https://github.com/HodeTech).

Relavium lets you design multi-agent, multi-model LLM workflows as git-committable
YAML and run them across a Tauri desktop app, a VS Code extension, and a CLI —
**local-first** in Phase 1, with cloud execution and a control-plane portal in
Phase 2. The workflow engine is a pure-TypeScript package shared by every surface,
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

Pre-implementation. The documentation, architecture decisions, and phased roadmap
are complete; engineering begins at
[Phase 0 — Foundations](docs/roadmap/phases/phase-0-foundations.md).
