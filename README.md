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

**Phase 1 — engine and LLM in progress; milestone M1 (LLM seam proven) reached (PR #9,
2026-06-07).** Phase 0 — Foundations (milestone M0, 2026-06-04) landed the Turborepo + pnpm
monorepo, the strict toolchain + GitHub Actions CI, `@relavium/shared` (the full Zod contract
set), the no-vendor-type seam fence, and `@relavium/db`. Phase 1 then landed
[`@relavium/llm`](docs/roadmap/phases/phase-1-engine-and-llm.md): the provider-agnostic
`LLMProvider` seam and **all three adapters** (Anthropic; the OpenAI-compatible adapter serving
OpenAI + DeepSeek; Gemini), passing one shared conformance suite behind the frozen seam with no
vendor type crossing it (PR #7–#9), followed by the **ADR-0031 multimodal seam-shape amendment
(1.AD)** — the media content/stream union members, the per-modality capability matrix, and the
reserved generator methods, landed **shape-only** before the seam's exhaustive consumers exist
(PR #11, 2026-06-10). The seam's last policy layer — the `FallbackChain` runner (1.K) — then landed
(PR #13, 2026-06-11), completing the LLM lane. The `@relavium/core` engine lane has since landed the
**`WorkflowYAMLParser`** (1.L, PR #14), the **`{{ … }}` interpolation engine + parse-time
secret-taint gate** (1.L2, PR #15), and the **DAG builder + `RunPlan`** (1.M) together with the
**QuickJS-wasm expression sandbox** (1.AB) (PR #16, 2026-06-13) — all with zero platform imports.
The **run loop** (1.N — `WorkflowEngine` + `RunEventBus`) landed (PR #17, 2026-06-13), **completing
milestone 1.m3** (parse → DAG → run loop emits the canonical event stream); the **built-in
`ToolRegistry`** (1.T, a 1.m4 component) landed alongside it as the other 1.O prerequisite. Next on the
critical path: the **`AgentRunner` join** (1.O), then checkpoint/resume and retry, plus the
**AgentSession** runtime + export-to-workflow sub-spine. See
[docs/roadmap/current.md](docs/roadmap/current.md) for live status.
