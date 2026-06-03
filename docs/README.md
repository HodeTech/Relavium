# Relavium documentation

> Repository: [github.com/HodeTech/Relavium](https://github.com/HodeTech/Relavium) · a product under the **HodeTech** org.

This is the canonical documentation tree for **Relavium**, a local-first platform for building, running, and monitoring multi-agent LLM workflows across several surfaces: a Tauri desktop agent-management center, a VS Code extension, a CLI, and (Phase 2) a cloud web portal. The workflow engine is a pure-TypeScript package shared by every surface, workflows and agents are git-committable YAML files, and multi-provider LLM access runs through Relavium's own `@relavium/llm` abstraction over the official provider SDKs.

The tree is organized by the *kind of question each section answers*, not by which subsystem the answer touches. When you have a question, you should know which folder to open before you know which part of the system is involved.

## Layout

| Folder / File | Answers the question |
|---------------|----------------------|
| [vision.md](vision.md) | **What are we building, and why?** The product vision and the problem Relavium solves. |
| [product-constraints.md](product-constraints.md) | **What are the hard rules?** Non-negotiable scope and behavior — desktop is agent-management (not an IDE), local-first in Phase 1, cloud in Phase 2. |
| [uvp.md](uvp.md) | **Why this over the alternatives?** The unique value proposition and positioning. |
| [deployment-models.md](deployment-models.md) | **How does each customer segment adopt it?** End-to-end deployment per segment (individual / small team / enterprise): execution mode, key model, tier, who pays for tokens, onboarding, governance, and the upgrade path. |
| [tech-stack.md](tech-stack.md) | **What is it built with?** The pinned, canonical technology choices and versions. |
| [project-structure.md](project-structure.md) | **Where does code live?** The monorepo layout, packages, and surface boundaries. |
| [roadmap/README.md](roadmap/README.md) | **What is shipping, and when?** Phase plan and milestones. |
| [glossary.md](glossary.md) | Project-specific terminology used throughout the tree. |
| [architecture/](architecture/) | **How is Relavium built?** High-level design, the shared core engine, the execution and state models, the local-first security model, desktop architecture, multi-LLM providers, and the Phase-2 cloud design. |
| [reference/](reference/) | **What exactly is the contract?** The single canonical home for concrete specs: workflow/agent YAML, the SSE event schema, the IPC contract, config, store shapes, node types, built-in tools, MCP, desktop DB schema and keychain, CLI commands, the VS Code extension API, and the Phase-2 portal API. |
| [tutorials/](tutorials/) | **How do I get something working end-to-end?** Task-oriented walkthroughs per surface — build a first workflow, run one in CI, trigger from VS Code. |
| [runbooks/](runbooks/) | **How do I operate it?** Step-by-step operational procedures: local dev setup, adding a provider key, releasing a surface. |
| [decisions/](decisions/) | **Why is it built this way?** Architecture Decision Records (ADRs) in MADR format. One ADR per non-trivial choice. |
| [standards/](standards/) | **How should things be written?** Documentation style, the ADR template, and architectural principles. |
| [compliance/](compliance/) | **What must we satisfy legally and contractually?** *(Phase 2, managed inference)* Provider-ToS posture, data-handling (DPA / sub-processors / KVKK + GDPR / data-residency), and merchant-of-record / tax obligations that apply once Relavium sits in the data path and bills for usage. |
| [analysis/](analysis/) | **What is the landscape, and where do we sit in it?** Competitive analysis, decision analyses (e.g. the managed-inference business model), and archived raw research. |
| [ideas/](ideas/) | **What might we build later?** Proposals not yet committed to the roadmap. |
| [reviews/](reviews/) | **What did we learn from looking back?** Retrospectives and review notes. |

## Reading order for newcomers

1. [glossary.md](glossary.md) — the terms used throughout the project; read this first so the rest makes sense.
2. [vision.md](vision.md) — what Relavium is and the problem it solves.
3. [product-constraints.md](product-constraints.md) — the hard rules that shape every decision.
4. [tech-stack.md](tech-stack.md) — the canonical technology choices and pinned versions.
5. [decisions/](decisions/) — the numbered ADRs, in order. These capture the reasoning behind the design and are the fastest way to get oriented on *why* things are the way they are.
6. [architecture/overview.md](architecture/overview.md) — the system topology, then dive into whichever subsystem interests you.
7. [reference/](reference/) — once you understand the shape of the system, the exact contracts and specs live here.

## Conventions in this tree

- **Language:** English only.
- **File names:** `kebab-case.md`. ADRs are `NNNN-short-slug.md` with a 4-digit number.
- **No front-matter:** every file starts with a single H1 title; metadata goes in bold key lines directly under the H1. Living docs add a `> Last updated: YYYY-MM-DD` blockquote under the H1.
- **Links:** relative markdown paths within this tree (e.g. `[tech-stack.md](tech-stack.md)`) so they resolve on GitHub. External resources may be absolute inline.
- **Diagrams:** Mermaid, embedded as inline fenced code blocks. No binary diagram formats. Architecture docs lead with a diagram where a topology or flow exists.
- **ADRs:** English MADR format with `## Context`, `## Decision`, and `## Consequences` (split into `### Positive` and `### Negative`). See [standards/adr-template.md](standards/adr-template.md).
- **One canonical home per artifact:** concrete specs live only in their `reference/` file; everything else cites them by relative link rather than copying.
- **Phasing:** Phase-2 (cloud and web portal) content is marked explicitly so it is never mistaken for shipped Phase-1 behavior.

For the full rules, see [standards/documentation-style.md](standards/documentation-style.md).
