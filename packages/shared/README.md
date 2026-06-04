# `@relavium/shared`

Zod schemas + inferred TypeScript types — the **single source of truth** for the
workflow/agent YAML, the run-event union, and config. Every other package depends on
this one; its only runtime dependency is `zod` (added with the schemas in 0.E).

## Status

**Phase 0 scaffold.** The package builds, type-checks, lints, and tests as the
dependency root of the graph, exporting `SCHEMA_VERSION` for now. The full schema set
(`WorkflowSchema`, `AgentSchema`, `NodeSchema`, `EdgeSchema`, the colon-namespaced
`RunEvent` union, `CostUpdatedEvent`, the human-gate events, `RunSchema`, config) lands
in [Phase 0 workstream 0.E](../../docs/roadmap/phases/phase-0-foundations.md), driven
from the frozen contracts in [docs/reference/contracts/](../../docs/reference/contracts/README.md).

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
