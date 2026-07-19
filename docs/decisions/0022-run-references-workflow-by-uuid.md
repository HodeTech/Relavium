# ADR-0022: Run records reference the workflow by surrogate UUID, not the authored slug

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md), [ADR-0009](0009-git-native-workflow-yaml.md), [database-schema.md](../reference/shared-core/database-schema.md), [sse-event-schema.md](../reference/contracts/sse-event-schema.md)

## Context

A workflow has **two identities**. In the git-committed YAML it is authored with a
kebab-case `workflow.id` (e.g. `code-review-pipeline`) — the human-facing id
([ADR-0009](0009-git-native-workflow-yaml.md)). When the desktop/CLI caches that workflow,
the database gives it a **surrogate UUID primary key**: `workflows.id` (UUID) with the
authored kebab id stored in `workflows.slug` (NOT NULL UNIQUE). Run history then references
the workflow via `runs.workflow_id TEXT NOT NULL REFERENCES workflows(id)` — i.e. the
surrogate UUID, so renaming a workflow's slug never breaks historical runs.

`@relavium/shared`'s logical `RunSchema` (and the `run:started` event) carry a `workflowId`
field. During Phase 0 this was typed `kebabIdSchema` (the authored slug), while the row it
mirrors keys on the UUID — two different identities for the same field name. A
comprehensive review flagged this as a frozen-contract ambiguity: a surface joining
`RunSchema.workflowId` against `workflows.id` would get zero rows when the value is actually
a slug. Phase 1 (engine checkpoint/resume) is the first consumer, so it must be resolved
before the run shape freezes.

## Decision

**`RunSchema.workflowId` and the `run:started` event's `workflowId` are a
`z.string().uuid()` — the surrogate `workflows.id` FK, not the authored slug.** The authored
kebab id lives in `workflows.slug`; the engine resolves slug → UUID when it materializes the
`workflows` catalog row, and the run references that UUID thereafter.

Considered alternatives:

1. **`workflowId` = surrogate UUID (FK), document the slug lives in `workflows.slug`.** The
   logical run and the persisted row use one identity; surfaces join `workflowId` directly
   against `workflows.id`. *Chosen.*
2. **Keep `workflowId` = authored slug, rename or document a slug↔UUID boundary.** Closer to
   the git-native authored id, but every surface that joins run → workflow must first resolve
   slug → UUID, and the field name `workflowId` would not mean `workflows.id`. *Rejected* —
   more friction and a more surprising contract than option 1.
3. **Defer to Phase 1.** *Rejected* — freezing the contract with the ambiguity unresolved is
   exactly the cross-seam drift Phase 0 exists to prevent.

The authored `workflow.id` in the YAML (`WorkflowSpecSchema.id`) is unchanged and remains
kebab-case — this decision is only about how a **run** refers to a workflow.

## Consequences

### Positive

- One identity for `workflowId` across `@relavium/shared`, the `run:started` event, and the
  `runs` row — a surface joins it straight against `workflows.id`, no slug resolution.
- Referential integrity holds across a workflow rename (the slug can change; the UUID FK and
  all historical runs do not).
- The ambiguity is closed before Phase 1 freezes the engine's run shape.

### Negative

- The engine must resolve the authored slug → `workflows.id` UUID (upserting the catalog row)
  before creating a run — a small, explicit step rather than passing the slug straight through.
- `workflowId` is no longer human-readable on its own; showing the workflow name/slug requires
  a join to `workflows` (acceptable — that table is the catalog).
- The kebab id regex did not hard-reject UUIDs, so this is a clarifying tightening, not a
  breaking change to any existing data (there is none yet — pre-implementation).
