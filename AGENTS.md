# AI agents guide — Relavium

All AI agents working on this repository should read this file first.

The canonical agent guide is **[CLAUDE.md](CLAUDE.md)** — written with Claude-based
tooling in mind, but its rules apply to **every** AI agent regardless of model or
runner. This file is the open-standard (`AGENTS.md`) entry point and a condensed
mirror; CLAUDE.md is the source of truth.

**Relavium** is a multi-surface, local-first AI agent workflow platform (a HodeTech
product): a pure-TypeScript workflow engine shared by a Tauri desktop app, a VS Code
extension, and a CLI, with workflows authored as git-committable YAML. It is a
Turborepo + pnpm monorepo (`packages/shared`, `packages/llm`, `packages/core`,
`packages/db`, `packages/ui`; `apps/desktop`, `apps/cli`, `apps/vscode-extension`;
`apps/api` + `apps/portal` are Phase 2). **Status: pre-implementation** — engineering
begins at [Phase 0](docs/roadmap/phases/phase-0-foundations.md).

## The non-negotiable rules

1. **TypeScript-first, strict.** No `any`, no unsafe `as`.
2. **Build in-house; minimize deps.** No new runtime dependency without an ADR.
   Never the Vercel AI SDK or LangChain — Relavium owns `@relavium/llm`. Never
   reinvent security-critical primitives (crypto/TLS/keychain).
3. **No vendor SDK type crosses the `@relavium/llm` `LLMProvider` seam** (ADR-0011).
4. **The engine (`packages/core`) has zero platform-specific imports.**
5. **Local-first, secure by default.** API keys live in the OS keychain — never
   plaintext, never in logs, never sent to the frontend (ADR-0006).
6. **The desktop app is an agent-management center, not an IDE** (ADR-0007).
7. **One canonical home per artifact** — specs live in [docs/reference/](docs/reference/); link, don't restate.
8. **Decisions are ADRs** in [docs/decisions/](docs/decisions/), condensed MADR,
   **append-only** (supersede, never rewrite).
9. **English, kebab-case, relative links, Mermaid, Conventional Commits.**

## Before you start

1. Read [README.md](README.md), then **[CLAUDE.md](CLAUDE.md) in full**.
2. Read [docs/glossary.md](docs/glossary.md) and [docs/roadmap/current.md](docs/roadmap/current.md).
3. Read the ADRs in [docs/decisions/](docs/decisions/) in numerical order.
4. Read the [docs/standards/](docs/standards/) relevant to your task.
5. If the task matches a skill in [.claude/skills/](.claude/skills/), follow that
   skill's procedure step by step.

## Build, test, lint

```bash
pnpm install
pnpm turbo run lint typecheck test
pnpm turbo run build
```

Never `npm` or `yarn`. `workspace:*` for inter-package deps; no circular deps.

## Git workflow

- Trunk-based on `main`; short-lived feature branches via PR.
- Conventional Commits with a per-package scope (`feat(core):`, `fix(llm):`,
  `docs(decisions):`). Reference the ADR or task the change advances. See
  [docs/standards/commit-style.md](docs/standards/commit-style.md).

## Escalation

If a requested change would violate any rule above, stop and ask before proceeding.
