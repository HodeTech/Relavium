# ADR-0007: The desktop app is not an IDE

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0001-tauri-v2-over-electron.md](0001-tauri-v2-over-electron.md), [0009-git-native-workflow-yaml.md](0009-git-native-workflow-yaml.md), [0024-agent-first-entry-point-agentsession.md](0024-agent-first-entry-point-agentsession.md), [0025-agent-surface-refines-desktop-scope.md](0025-agent-surface-refines-desktop-scope.md), [product-constraints.md](../product-constraints.md), [vision.md](../vision.md)

## Context

Relavium spans four surfaces (desktop app, VS Code extension, CLI, and a Phase-2 web portal — see [vision.md](../vision.md)). The riskiest scope question for the desktop app is what it is *for*. The pull toward turning it into a general "AI coding environment" — adding a code editor, a file browser, an integrated terminal — is strong, because the engine can run tools that touch code.

The product owner has settled this explicitly: the desktop app is an **agent-management center**, not an IDE. Code-adjacent work belongs to the VS Code extension, which already provides the editor, file tree, and terminal. Duplicating those in the desktop app would mean competing with VS Code on its home turf while diluting the desktop app's actual job. This is a product/scope decision, recorded as an ADR because it governs every future desktop feature proposal. The authoritative constraint lives in [product-constraints.md](../product-constraints.md).

## Decision

**The desktop app is a pure agent-management center.** Its scope is exactly:

- Workflow canvas design (the ReactFlow editor for `.relavium.yaml`).
- Agent creation and configuration (`.agent.yaml`).
- Run monitoring and history.
- Provider / API key management.
- Cost tracking.

It does **not** include a code editor, a file browser, or an integrated terminal. Those are the VS Code extension's job (see [vision.md](../vision.md) and the [VS Code extension reference](../reference/vscode/extension-api.md)).

Considered options:

1. **Agent-management center only** — design workflows and agents, manage providers, monitor runs and cost; delegate all code-adjacent work to the VS Code extension. *Chosen.*
2. **Desktop as a full AI IDE** — bundle an editor, file tree, and terminal so the desktop app is a one-stop coding environment.
3. **Desktop as a thin launcher** — minimal UI that only triggers runs, with everything else elsewhere.

The agent-management framing wins because it gives the desktop app a sharp, defensible job — the visual workflow canvas and the run/cost view that no other surface owns — without re-implementing an editor that VS Code already does better. The surfaces compose by responsibility: design and monitor in the desktop app, edit and trigger inline in the editor (the extension), automate in the CLI. Because workflows and agents are git-native YAML files (see [ADR-0009](0009-git-native-workflow-yaml.md)), the desktop app can edit them visually while the VS Code extension edits the same files as text — one source of truth, two editing modalities, no conflict. A full IDE (Option 2) would be a far larger build competing with VS Code; a thin launcher (Option 3) would throw away the canvas, which is the product's signature surface.

This decision also keeps the desktop shell small and focused, which is consistent with the lightweight Tauri choice in [ADR-0001](0001-tauri-v2-over-electron.md).

> Amended 2026-06-05: the agent-first pivot adds a conversational **chat panel** to the desktop. A
> chat panel is an *agent capability*, not an IDE feature, so it is **in scope**; the no-code-editor /
> no-file-browser / no-integrated-terminal boundary above is **unchanged**.
> [ADR-0025](0025-agent-surface-refines-desktop-scope.md) draws the precise
> agent-capability-vs-IDE-shell line and is the record of this refinement, and
> [ADR-0024](0024-agent-first-entry-point-agentsession.md) is the pivot it serves. Chat and Canvas are
> co-equal tabs and the canvas remains the signature surface — this decision is refined, not reversed.

## Consequences

### Positive

- A clear, defensible product identity: the desktop app owns visual workflow design and run/cost monitoring, and nothing else.
- No duplicated editor/terminal/file-tree work — that effort goes into the VS Code extension where the platform already provides those primitives.
- The surfaces compose cleanly by responsibility (design vs edit vs automate), with git-native YAML ([ADR-0009](0009-git-native-workflow-yaml.md)) as the shared substrate.
- A smaller desktop surface keeps the Tauri bundle and maintenance footprint lean ([ADR-0001](0001-tauri-v2-over-electron.md)).
- A concrete rule for triaging feature requests: anything resembling code editing is redirected to the VS Code extension.

### Negative

- Users who expect an all-in-one coding tool will need both the desktop app and the VS Code extension for a code-editing workflow; mitigated by making the extension fully standalone and by tight desktop↔extension integration (see the [IPC contract](../reference/contracts/ipc-contract.md)).
- Some feature requests ("just add a quick editor") will be repeatedly declined; this ADR exists precisely to make that "no" principled rather than ad hoc.
- The seam between visual editing (desktop) and text editing (VS Code) of the same YAML must stay clean so the two modalities never corrupt each other's files; this is why the YAML format is treated as a versioned public API in [ADR-0009](0009-git-native-workflow-yaml.md).
