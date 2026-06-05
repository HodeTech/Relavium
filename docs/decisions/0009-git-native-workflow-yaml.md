# ADR-0009: Git-native workflow and agent YAML

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0007-desktop-is-not-an-ide.md](0007-desktop-is-not-an-ide.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0024-agent-first-entry-point-agentsession.md](0024-agent-first-entry-point-agentsession.md), [0026-session-export-to-workflow.md](0026-session-export-to-workflow.md), [product-constraints.md](../product-constraints.md), [tech-stack.md](../tech-stack.md)

## Context

A workflow and the agents inside it have to be *stored* somewhere. The choice of storage format is also a choice about whether workflows are first-class, shareable, reviewable artifacts or opaque rows in a private database. For a developer tool whose differentiator over chat-style competitors is **reusable, version-controllable, team-shareable workflows** (see the competitive analysis in [analysis/competitive-landscape-2026-06-03.md](../analysis/competitive-landscape-2026-06-03.md)), this is a defining decision.

Two facts constrain it. First, the desktop app is an agent-management center with a *visual* canvas (see [ADR-0007](0007-desktop-is-not-an-ide.md)), while the VS Code extension edits the *same* definitions as text — so the format must be editable cleanly in both modalities without one corrupting the other. Second, the product is local-first with no database-of-record in the cloud (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)); the files on disk *are* the source of truth, and teams must be able to share them the way they share code — by committing, branching, and reviewing in a PR.

## Decision

**Workflows and agents are git-native YAML files**, designed to be committed, branched, code-reviewed, and version-controlled like any other source artifact. Workflows are `*.relavium.yaml` and agents are `*.agent.yaml`; they live in a per-project, git-committed `.relavium/` directory, while user-global config and secrets live outside the repo in `~/.relavium/`. The concrete schema is the canonical [workflow YAML spec](../reference/contracts/workflow-yaml-spec.md) and [agent YAML spec](../reference/contracts/agent-yaml-spec.md); this ADR records the decision and its drivers, not the schema.

Considered options:

1. **Git-native YAML files in a per-project `.relavium/` directory** — human-readable, diff-friendly, version-controllable as code. *Chosen.*
2. **JSON files** — also file-based and committable, but worse for the human-authoring case.
3. **A database-backed store** (workflows as rows, edited only through the app) — opaque to git, not shareable as files.

YAML wins as the file format because the things it does better than JSON are exactly what workflow authoring needs: multi-line system prompts are readable without escape sequences, comments are legal (so authors can annotate intent and version history inline), and it produces clean line-by-line diffs in a PR. A database store (Option 3) would make workflows invisible to git — no diffs, no PR review, no branch-per-experiment, no sharing without exporting — which directly undercuts the product's reason to exist and would also reintroduce a server dependency that [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md) rules out of Phase 1.

The split between a project-local, committed `.relavium/` and a user-global `~/.relavium/` mirrors the well-understood VS Code workspace-vs-user-settings model: workflow and agent definitions are shared with the team, while secrets and personal preferences stay on the machine (and out of the repo — secrets are in the OS keychain per [ADR-0006](0006-os-keychain-for-api-keys.md), never in a committed file). Because the same files back both the visual canvas and the VS Code text editor, there is one source of truth with two editing modalities and no conflict (see [ADR-0007](0007-desktop-is-not-an-ide.md)).

Critically, **the YAML schema is treated as a public API from day one**. Because users commit these files, a breaking schema change would invalidate their version-controlled work. The schema therefore carries an explicit version field, ships a JSON Schema for editor validation, and any breaking change must be paired with a migration path *before* it lands — the same discipline applied to any published interface. The versioning and migration rules are part of the [workflow YAML spec](../reference/contracts/workflow-yaml-spec.md). Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Workflows and agents are first-class source artifacts: committable, branchable, diff-able, and reviewable in a PR — the core differentiator over chat/CLI-only competitors (see [analysis/competitive-landscape-2026-06-03.md](../analysis/competitive-landscape-2026-06-03.md)).
- Human-friendly authoring: multi-line prompts read naturally, comments capture intent, and diffs are clean and reviewable.
- One source of truth for two editing modalities — the visual canvas ([ADR-0007](0007-desktop-is-not-an-ide.md)) and the VS Code text editor edit the very same files.
- No database-of-record and no server needed to define or share a workflow, reinforcing the local-first model of [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md).
- A clean separation of shared definitions (committed `.relavium/`) from machine-local secrets and preferences (`~/.relavium/`, keychain per [ADR-0006](0006-os-keychain-for-api-keys.md)).

> Amended 2026-06-05: the git-native model now extends to interactive conversations — an `AgentSession` ([ADR-0024](0024-agent-first-entry-point-agentsession.md)) can be **exported** to a committed `.relavium.yaml` ([ADR-0026](0026-session-export-to-workflow.md)), so a chat graduates into the same reviewable, diffable, PR-able artifact as any authored workflow. This is an additive consequence; the decision text above is unchanged.

### Negative

- The schema is now a versioned public contract: breaking changes require a versioned migration path and a published JSON Schema, which is real, ongoing maintenance cost. This is accepted deliberately and is enforced by the [workflow YAML spec](../reference/contracts/workflow-yaml-spec.md).
- Visual edits (canvas) and text edits (VS Code) of the same file must round-trip without one modality reordering or reformatting the other's output destructively; keeping that seam clean is a standing requirement and a reason the format is spec-pinned.
- YAML has well-known authoring footguns (significant whitespace, surprising implicit typing); mitigated by editor schema validation and diagnostics from the VS Code extension (see [reference/vscode/extension-api.md](../reference/vscode/extension-api.md)).
- Large or generated workflows can produce noisy diffs; mitigated by a stable, canonical serialization order so two equivalent workflows serialize identically.
