# `@relavium/core` — the engine

YAML→DAG parse, runner, checkpoint/resume, retry. **Zero platform-specific imports**
— runs identically in Node, the Tauri WebView, the VS Code extension host, and (Phase 2)
the Bun API. The most important package.

The whole package is the platform-free zone: `tsconfig.json` sets `types: []`, so a stray
`process`/`Buffer`/`node:*` is a type error (CLAUDE.md rule 5,
[ADR-0011](../../docs/decisions/0011-internal-llm-abstraction.md)). Runtime dependencies are
confined to `@relavium/shared`, `zod`, and the pure-JS `yaml` loader
([ADR-0035](../../docs/decisions/0035-yaml-parser-dependency.md)) — enforced by the engine-deps
guard (`tools/engine-deps/check.mjs`).

## Built so far

- **`parseWorkflow` (1.L)** — load a `.relavium.yaml` **string** and validate it against the
  `@relavium/shared` `WorkflowSchema` (strict, [ADR-0023](../../docs/decisions/0023-strict-authored-yaml-validation.md)),
  with typed, field-named, secret-free errors. Pure: it takes text, never reads the filesystem.
  Plus the structured (un-evaluated) interpolation-reference extractor the DAG builder (1.M) consumes.

Built out in [Phase 1 — engine and LLM](../../docs/roadmap/phases/phase-1-engine-and-llm.md).
Architecture: [shared-core-engine.md](../../docs/architecture/shared-core-engine.md).
