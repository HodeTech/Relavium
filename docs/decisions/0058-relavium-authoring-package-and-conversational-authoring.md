# ADR-0058: `@relavium/authoring` package and the conversational-authoring pre-flight contract

- **Status**: Proposed
- **Date**: 2026-06-28
- **Related**: [ADR-0026](0026-session-export-to-workflow.md), [ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md), [ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md), [phase-2.6-conversational-authoring.md](../roadmap/phases/phase-2.6-conversational-authoring.md) (2.6.A/2.6.B), [product-constraints.md](../product-constraints.md), [architectural-principles.md](../standards/architectural-principles.md), [CLAUDE.md](../../CLAUDE.md) (#8 one-canonical-home)

> **Draft.** Proposed alongside the Phase 2.6 plan; to be reviewed and finalized (→ Accepted) when workstream 2.6.A begins. **Security review of the write surface is mandatory before Accept.**

## Context

Phase 2 (workstream 2.J) landed an authoring core in `apps/cli/src/authoring/authoring.ts`: it wraps
`parseWorkflow` / `serializeWorkflow` / `parseAgent` / `buildAuthored` / `detectAndParse` from
`@relavium/core` and drives the `create` / `import` / `export` commands. We now want a `relavium chat`
conversation to **author** a standards-valid `.relavium.yaml` from a free-text request (the terminal
realization of *"Start as an agent. Ship the workflow."*), and the maintainer has decided the authoring
core should be reusable beyond the CLI — the desktop ([phase-3-desktop.md](../roadmap/phases/phase-3-desktop.md))
and VS Code ([phase-4-vscode.md](../roadmap/phases/phase-4-vscode.md)) surfaces should consume the same
core. Two constraints frame it: the existing `create`/`import`/`export` pre-flight is **parse-only** (it
does not run the catalog-aware validator — only the run path does), so a wizard could accept a
model/modality the run path rejects; and the Relavium **product** agent (`relavium chat`) never reads
`.claude/`, so the repo-development skills there cannot serve as its authoring knowledge.

## Decision

**We will promote the in-tree authoring core to a new shared package `@relavium/authoring`, expose a
single catalog-aware `validateAuthoredWorkflow` pre-flight used by every authoring path, and drive a
conversational authoring agent from a product-side knowledge pack derived from the canonical specs.**

- **Package promotion is an extract-and-decouple, not a move.** The in-tree core
  (`apps/cli/src/authoring/authoring.ts`) currently imports three **`apps/cli` internal** modules —
  `findProjectConfigDir` (`../config/paths`), `CliError` (`../process/errors`, exit-code-coupled), and
  `discoverCatalog` (`../workflows/catalog`). A new `packages/authoring` must **not** import from
  `apps/cli` (a forbidden `packages → apps` back-edge that fails `pnpm turbo build`), so promotion **decouples**
  those three: (a) replace `CliError` throws with a platform-free `Result`/typed error the CLI maps to its
  own exit codes at the boundary; (b) keep catalog **discovery** CLI-side and pass the catalog **in** —
  `validateAuthoredWorkflow(yaml, catalog)` already takes it as a parameter; (c) keep `findProjectConfigDir`
  CLI-side (path discovery is a surface concern). The resulting package is pure TS / platform-free (engine
  purity holds) and depends **only** on `@relavium/core` + `@relavium/shared` — a one-direction edge
  (`authoring → core`; `core`/`shared` never import `authoring`). It adds **no new third-party dependency**;
  the add-package ADR records the multi-surface decision (architectural-principles §9). An import-zone lint
  fence (the Phase-0 seam-fence pattern) enforces the `packages/authoring → apps/cli` ban.
- **One pre-flight.** Expose `validateAuthoredWorkflow(yaml, catalog)` = `parseWorkflow` +
  `validateWorkflowWithCatalog`, and back-port it into `create`/`import`/`export` so wizard-authored and
  conversationally-authored artifacts share one front end — a `create` can never accept what the run path
  rejects. The self-correct loop (model → YAML → pre-flight → field-named, secret-free error → fix)
  reuses the same `detectAndParse`. This is the sibling of session export
  ([ADR-0026](0026-session-export-to-workflow.md)): export replays a transcript; authoring generates.
- **Knowledge, derived not restated.** The conversational agent's knowledge is a product-side pack
  **derived** from [node-types.md](../reference/shared-core/node-types.md),
  [workflow-yaml-spec.md](../reference/contracts/workflow-yaml-spec.md),
  [agent-yaml-spec.md](../reference/contracts/agent-yaml-spec.md), and the Zod schemas, plus one minimal
  valid example per node type — never a second copy ([CLAUDE.md](../../CLAUDE.md) #8). It does **not** live
  under `.claude/skills/`. Artifacts are written only under accept-edits/auto
  ([ADR-0057](0057-cli-chat-modes-and-per-tool-approval.md)) with the scope-tiered host
  ([ADR-0055](0055-cli-host-capability-seam-tool-environment-factory.md)).

Considered building a new authoring package from scratch (rejected: the core already exists from 2.J —
promote, do not duplicate); keeping authoring CLI-only (rejected: the maintainer wants desktop/VS Code to
consume it); restating the schema in the knowledge pack (rejected: one-canonical-home — derive instead);
and placing the knowledge under `.claude/skills/` (rejected: the product agent never reads `.claude/`).

## Consequences

### Positive

- One authoring core, reusable by every surface; one catalog-aware pre-flight shared by wizard and
  conversational authoring; no parse-vs-catalog drift between `create` and `run`.
- The conversational author reuses the proven validator as its self-correct oracle, lowering cost and
  guaranteeing run-validity.

### Negative

- A new workspace package **plus an extract-and-decouple refactor** (three `apps/cli` couplings —
  `CliError`, `discoverCatalog`, `findProjectConfigDir` — must be cut), not a free move; the CLI commands
  re-wire to the package and the boundary maps the package's typed errors to exit codes. The `create` /
  `import` / `export` behaviour must round-trip unchanged (regression-tested), and an import-zone lint
  fence guards the `packages/authoring → apps/cli` ban.
- A knowledge-derivation discipline with a no-restate check to prevent drift from the canonical specs.
- A new write surface (the model writing files) — gated by accept-edits approval, the scope-tier host,
  and the existing secret-taint gate in `parseWorkflow`, plus a mandatory security review.
