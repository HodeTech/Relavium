# Runbooks

Runbooks are **task-oriented how-tos** for operating and developing Relavium. They
answer "how do I do X?" with a concrete, ordered procedure. They differ from
[tutorials/](../tutorials/README.md) — which teach a concept by building something
end-to-end — in that a runbook assumes you already know *why* and just need the steps.

Each runbook operationalizes one or more canonical [reference](../reference/README.md)
specs and links to them rather than restating them (see
[documentation-style.md](../standards/documentation-style.md) §6).

## Runbooks

| Runbook | Task |
|---------|------|
| [local-dev-setup.md](local-dev-setup.md) | Set up the Turborepo monorepo locally: pnpm, the Tauri/Rust toolchain, and the engine-first build order. |
| [add-a-provider.md](add-a-provider.md) | End-to-end CLI provider lifecycle: register (incl. a custom OpenAI-compatible endpoint), store + verify a key, discover models, and price an unknown model. |
| [add-a-provider-key.md](add-a-provider-key.md) | Add or rotate an LLM provider API key into the OS keychain from the desktop app. |
| [release-a-surface.md](release-a-surface.md) | Cut a release for the desktop (`.dmg`), CLI (npm), or VS Code extension (Marketplace). |

## Conventions

- Runbooks are written for the **current** vision: TypeScript engine, local-first
  Phase 1, no cloud dependency.
- Phase-2 (cloud/portal) steps, where they appear, are explicitly marked.
- Commands are copy-pasteable; placeholders use `<angle-brackets>`.
