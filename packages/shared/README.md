# `@relavium/shared`

Zod schemas + inferred TypeScript types — the **single source of truth** for the
workflow/agent YAML, the run-event union, and config. Every other package depends on
this one; its only runtime dependency is `zod` ([ADR-0020](../../docs/decisions/0020-zod-runtime-schema-library.md)).

## Status

**Implemented (v1.0 contracts).** The full schema set is in place, driven directly from
the frozen contracts in [docs/reference/contracts/](../../docs/reference/contracts/README.md)
and exercised by accept/reject + reference round-trip tests:

- **Workflow YAML** — `WorkflowSchema` (document + `workflow` body), the 8-type `NodeSchema`
  discriminated union, `EdgeSchema`, `TriggerSchema`, inputs/context/tool-policy.
- **Agent YAML** — `AgentSchema`, `McpServerRefSchema`, `MemorySchema`, `RetrySchema`,
  `FallbackChainEntrySchema`.
- **Run-event stream** — the colon-namespaced `RunEvent` union (incl. `CostUpdatedEvent`,
  the human-gate events, `GateDecision`) and the logical `RunSchema`.
- **Config** — `GlobalConfigSchema` / `ProjectConfigSchema`.

Authored workflow/agent objects are **`.strict()`**: an unknown/typo'd key is rejected, not
silently stripped ([ADR-0023](../../docs/decisions/0023-strict-authored-yaml-validation.md)).
A run references its workflow by the surrogate **UUID** (`workflows.id`), not the authored
slug ([ADR-0022](../../docs/decisions/0022-run-references-workflow-by-uuid.md)).

## Conventions

- Extends the strict root [`tsconfig.base.json`](../../tsconfig.base.json) and **never
  loosens a strict flag** — a relaxation needs a justification comment and review
  ([code-style-typescript.md](../../docs/standards/code-style-typescript.md#strictness)).
- The public surface is a curated `src/index.ts` — never `export *` of internals.
- Run-event names are the canonical **colon-namespaced** form with `sequenceNumber` —
  never the legacy dotted names, never `seqNo`.

## Scripts

| Script | What it does |
|--------|--------------|
| `build` | `tsc -p tsconfig.build.json` → `dist/` (emits `.d.ts`; excludes tests) |
| `typecheck` | `tsc -p tsconfig.json --noEmit` (includes tests) |
| `lint` | `eslint src` |
| `test` | `vitest run` |
