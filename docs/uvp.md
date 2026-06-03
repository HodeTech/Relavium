# Unique Value Proposition

- **Status**: Accepted
- **Related**: [vision.md](vision.md), [product-constraints.md](product-constraints.md), [analysis/competitive-landscape-2026-06-03.md](analysis/competitive-landscape-2026-06-03.md)

## Statement

> The only platform that lets any developer visually design, locally execute, and
> git-commit multi-model multi-agent workflows that run identically in their IDE,
> terminal, desktop canvas, and CI/CD pipeline — no cloud dependency, no vendor
> lock-in, no framework expertise required.

## Proof Points

1. **Every competitor owns at most two surfaces; Relavium owns all four**
   (desktop, VS Code, CLI, web) with a single workflow runtime.
2. **No competitor produces version-controllable workflow artifacts.** Relavium
   workflows are first-class git objects (`.relavium.yaml` in `.relavium/`).
3. **No competitor combines visual design + local execution + multi-model routing
   + multi-agent orchestration** in a single product.
4. **Workflow portability** means a workflow built by one developer runs unchanged
   in CI/CD — closing the gap between local AI use and automated pipelines that
   every other tool leaves open.
5. **Local-first execution** means zero data leaves the machine until the user
   chooses cloud — a trust and compliance advantage no SaaS-first competitor can
   claim in Phase 1.

## Positioning

Relavium is a **workflow-orchestration layer above the editor**, not another
editor. The four properties that, taken together, no one else offers:

| Property | What it means | Who lacks it |
|----------|---------------|--------------|
| **Visual** | Drag-and-drop canvas with live execution on the node face | CrewAI/AutoGen (code only), Claude Code/Cursor/Cline (chat only) |
| **Git-native** | Workflows are diffable, PR-able YAML files | n8n (proprietary JSON), Claude Code/Cursor (no persistence) |
| **Multi-model** | Per-agent model choice + fallback chains across providers | Claude Code (Claude only), Copilot Agent (MS/OpenAI only) |
| **No lock-in** | Runs in standard VS Code, any terminal, any git host, locally | Cursor (fork lock-in), Copilot Agent (GitHub lock-in) |

## Competitive Framing

A condensed read; the full matrix with per-competitor strengths and gaps lives in
[analysis/competitive-landscape-2026-06-03.md](analysis/competitive-landscape-2026-06-03.md).

| Competitor | Their strength | The gap Relavium fills |
|-----------|----------------|------------------------|
| **Claude Code** | Deep Claude integration, strong CLI + editor UX | Single-model, single-agent, no visual canvas, no version-controllable workflows, no CI/CD path. Relavium is the graduation path when users outgrow single-agent/single-model. |
| **Cursor** | Best-in-class AI-native editor | Editor-only, fork lock-in, no workflow abstraction, no reuse/sharing. Relavium sits above any editor, keeping the user's preferred tools. |
| **Continue.dev** | Open-source, multi-model, BYO keys | Stops at chat/autocomplete — no orchestration, no workflow files, no CLI, no desktop. Natural upgrade for users who want to chain and persist agents. |
| **Cline / Roo-code** | Aggressive agentic execution (fs, shell, browser) | Every run is ephemeral and manual; no reuse, no team sharing, no canvas. Relavium makes agentic runs reusable and composable. |
| **GitHub Copilot Agent Mode** | Massive GitHub distribution, enterprise trust | GitHub/MS ecosystem lock-in, no multi-model, no local-first, no portable workflow files. Relavium is VCS-, model-, and surface-agnostic. |
| **n8n / Zapier** | Mature visual builders, huge connector libraries | Not AI-native, no developer surfaces (no VS Code/CLI), no local-first, no code/repo context. Relavium is the developer-native, AI-first equivalent. |
| **CrewAI / AutoGen** | Powerful programmable multi-agent topologies | Python-only, no IDE/canvas, requires code to define agents, no visual artifact. Relavium delivers the same power via a canvas + readable YAML, no framework expertise. |

## The Workflow File Is the Wedge

Because a workflow is a portable, readable YAML file, the workflow file itself
becomes the viral mechanic: a developer shares a `.relavium.yaml`, a teammate
runs it unchanged in their own editor, terminal, or CI. Value scales with team
size — the workflow file is team infrastructure, not a personal preference. This
positioning underpins the go-to-market and pricing strategy (gate on
collaboration and scale, not on capability).
