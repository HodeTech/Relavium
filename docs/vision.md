# Relavium — Product Vision

- **Status**: Authoritative
- **Tagline**: Design agents. Ship workflows. Own every run.
- **Related**: [product-constraints.md](product-constraints.md), [uvp.md](uvp.md), [roadmap/README.md](roadmap/README.md)

Relavium is the multi-surface AI agent workflow platform that lets developers
and teams visually design, version-control, and execute multi-model agent
pipelines — from a desktop canvas, VS Code, the CLI, or the cloud — with every
run debuggable, every cost tracked, and every workflow exportable as a
git-friendly YAML file.

## The Problem

Today's AI coding and agent tools force a choice the developer should never have
to make. Chat-driven assistants (Claude Code, Cursor, Cline) are powerful but
every run is ephemeral, single-model, single-agent, and impossible to share or
re-run in CI. Multi-agent frameworks (CrewAI, AutoGen) require Python expertise
and produce no visual or reviewable artifact. General automation builders (n8n,
Zapier) have a visual canvas but no developer-native surfaces and no real
multi-agent AI orchestration. No single tool lets a developer **visually design,
locally execute, and git-commit** a multi-model multi-agent workflow that then
runs identically in their editor, their terminal, and their pipeline.

## The Product

A workflow is the unit of value in Relavium: a directed graph of agent nodes,
control-flow nodes, and human gates, defined as a git-committable YAML file
(`.relavium.yaml`). Agents are likewise YAML files (`.agent.yaml`). The same
pure-TypeScript engine ([packages/core](project-structure.md)) executes that
workflow on whichever surface the user reaches for, so behavior is identical
everywhere. See [tech-stack.md](tech-stack.md) for the engineering decisions
that make this possible.

## The Four Surfaces

```mermaid
flowchart TD
    Core["packages/core<br/>(pure-TS workflow engine)"]
    Desktop["Desktop app (Tauri v2)<br/>visual canvas + agent management"]
    VSCode["VS Code extension<br/>inline triggering, standalone"]
    CLI["CLI (relavium)<br/>scripting + CI/CD"]
    Portal["Web portal (Phase 2)<br/>usage, quota, governance"]

    Core --> Desktop
    Core --> VSCode
    Core --> CLI
    Core --> Portal

    Files[".relavium.yaml<br/>.agent.yaml<br/>(git-committable)"]
    Files -.read/write.-> Desktop
    Files -.read/write.-> VSCode
    Files -.read/write.-> CLI
```

| Surface | What it is | What it is *not* |
|---------|-----------|------------------|
| **Desktop app** | Visual workflow canvas and **agent-management center**: design workflows, configure agents, monitor runs, track cost. Built on Tauri v2. | NOT an IDE, NOT a code editor, NOT a terminal. |
| **VS Code extension** | Inline workflow triggering inside the editor (right-click a file → run a workflow), status-bar run monitor, sidebar panels. Bundles the engine — works standalone with no desktop app required. | NOT a replacement for the desktop canvas; code-adjacent work lives here. |
| **CLI** | `relavium run`, `relavium list`, and friends for scripting and CI/CD integration. Fastest path to a first run and the engine's integration-test harness. | NOT a long-running daemon in Phase 1. |
| **Web portal** *(Phase 2)* | Usage metrics, quota, licensing, team governance, enterprise features. A control plane. | NOT where workflows execute — it is not an execution plane. |

The desktop app's scope boundary (management center, not IDE) is a hard
constraint; see [product-constraints.md](product-constraints.md).

## Execution Model

- **Phase 1 — local-first.** Agents run on the user's machine. LLM API calls go
  directly from the user's machine to the providers (Anthropic, OpenAI, Gemini,
  DeepSeek). No cloud dependency, no account required, no server to run. Privacy
  is a feature, not an add-on.
- **Phase 2 — cloud.** *(Explicitly Phase 2.)* Cloud execution workers for 24/7
  automation, team sharing, scheduled and webhook triggers, and mobile-triggered
  runs. Phase 1 is never designed to *require* the cloud; the engine architecture
  supports both modes behind a clean interface switch. See [roadmap/README.md](roadmap/README.md).

## Why It Wins

- **Own all four surfaces with one runtime.** Every competitor owns at most two;
  Relavium runs the identical engine across desktop, VS Code, CLI, and (Phase 2)
  the cloud.
- **Workflows are git objects.** Reviewable, diffable, PR-able, revertable — the
  workflow file is team infrastructure, and it is also the invite: sharing a
  `.relavium.yaml` is how Relavium spreads through a team.
- **Multi-model, multi-agent, visual, local — together.** No competitor combines
  visual design, local execution, multi-model routing, and multi-agent
  orchestration in one product.

The full positioning and competitor matrix lives in [uvp.md](uvp.md).

## Killer Features (Phase 1)

- **Live canvas execution theater** — tokens stream inside individual node faces
  on the canvas as the workflow runs; parallel branches stream simultaneously.
- **Git-native YAML workflows** — the graduation path from chat-driven tools.
- **Retry from node** — replay from a checkpoint using already-completed upstream
  outputs; debugging becomes surgical, not destructive.
- **Multi-model fallback chains per agent** — `[claude → gpt-4o → gemini]`; runs
  survive provider outages.
- **Human gate with timeout and escalation** — pause any workflow for a real
  human decision; makes Relavium viable for compliance-sensitive work.
- **Per-node cost waterfall** — token and dollar attribution per node, per model.
- **Zero-install VS Code right-click trigger** — install-to-value under 3 minutes.
