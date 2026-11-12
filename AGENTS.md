# AI agents guide — Relavium

All AI agents working on this repository should read this file first.

The canonical agent guide is **[CLAUDE.md](CLAUDE.md)** — written with Claude-based
tooling in mind, but its rules apply to **every** AI agent regardless of model or
runner. This file is the open-standard (`AGENTS.md`) entry point and a condensed
mirror; CLAUDE.md is the source of truth.

**Relavium** is a multi-surface, local-first AI agent platform (a HodeTech product):
*start as an agent, ship the workflow, own every run.* You begin in a conversational
**agent session** — a first-class engine entry point on every surface (CLI `relavium chat`,
a desktop chat tab, a VS Code coding-assistant) — and graduate it into a multi-agent,
multi-model **workflow** authored as git-committable YAML. Both entry points (`AgentSession`
and `WorkflowEngine`) sit on one pure-TypeScript engine shared by a Tauri desktop app, a VS
Code extension, and a CLI ([ADR-0024](docs/decisions/0024-agent-first-entry-point-agentsession.md),
[ADR-0026](docs/decisions/0026-session-export-to-workflow.md)). It is a
Turborepo + pnpm monorepo (`packages/shared`, `packages/llm`, `packages/core`,
`packages/db`, `packages/ui`; `apps/desktop`, `apps/cli`, `apps/vscode-extension`;
`apps/api` + the control-plane `apps/portal` are Phase 2). A run executes in one of three
**execution modes** behind the one `LLMProvider` seam — **local** (BYOK, Phase-1 default),
**cloud** (BYOK-central, Phase 2), and **managed** (Relavium's own keys via a metered egress
gateway; engine stays local, Phase 2) — split across build phase 5 (managed inference) and
phase 6 (cloud execution + portal); the engine is identical across all three (ADR-0012..0015).
**Status (2026-11-12): the CLI MVP comes first.** Phases 1, 2 and 2.5 are complete (`relavium@0.1.1` is
published); Phase 2.6.5 is complete with approved deferrals (49/51, PR #92). Phase 2.5.5's Waves 0–2 and Wave 3
Steps 1–8 are merged (PR #94, PR #95), and Steps 9a.1–9b.2 and NI are accepted and on `main` since the
`development`→`main` checkpoint (PR #96, 2026-11-04). On 2026-10-26
the maintainer paused Wave 3 (Steps 9c–19 pending, not declined) and put the CLI MVP first: `relavium` v0.2.0
(milestone M3.5), ordered as MVP-1…MVP-10 under decisions D58–D72 in
[current.md](docs/roadmap/current.md#next-work--the-cli-mvp). Phase 2.6 is in progress (2.6.C and 2.6.F done,
2.6.Q P1–P5 landed). MVP-1 is accepted and on `main` (PR #97, 2026-11-07).
MVP-2 is complete and on `main` through PR #98 (`0db4c940`, 2026-11-11), including all four steps,
review corrections, separate security sittings and passing combined CI
([merge checkpoint](docs/roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-merge-checkpoint-2026-11-11)).
MVP-3's three steps are implemented and independently accepted on `development`,
with clean cumulative reviews and separate security sittings. Sonar remediation
through `3240fb88` passes 18,543 workspace tests and 1,093 acceptance-tool cases,
with two fresh clean review rounds and a separate security sitting. All 207
baseline Sonar reports have source actions or verified remote dispositions;
PR #99 requires final-head scanner/platform checks and maintainer review. The
[implementation checkpoint](docs/roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-development-implementation-checkpoint-2026-11-12)
owns evidence and limits. MVP-4 is next, with its pending ADR approvals preserved.
**PR #99 review follow-up (2026-11-13) is active.** New verified runtime/UX,
native lifetime and delivery findings require correction and fresh acceptance.
[ADR-0126](docs/decisions/0126-native-write-admission-and-recovery-keep-explicit-lifetime-proof.md)
is Proposed; its source-admission and recovery changes require maintainer
approval before implementation. Earlier clean review/CI receipts retain their
scoped historical meaning; they do not close this new correction increment.
The Home is the interactive product (ADR-0122). The interim release guard blocks npm publication until the pre-1.0 release ADR (D59) is
Accepted; the acceptance bar is tiered (D64), with security-touching increments keeping a full review round and
a separate security sitting. CLAUDE.md carries the full summary.

See [docs/roadmap/current.md](docs/roadmap/current.md) for live status.

## The non-negotiable rules

1. **TypeScript-first, strict.** No `any`, no unsafe `as`.
   [ADR-0125](docs/decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md)
   permits a narrow Rust/Node-API CLI filesystem metadata adapter; shared/core
   and the LLM seam remain platform-pure TypeScript.
2. **Build in-house; minimize deps.** No new runtime dependency without an ADR.
   Never the Vercel AI SDK or LangChain — Relavium owns `@relavium/llm`. Never
   reinvent security-critical primitives (crypto/TLS/keychain).
3. **No vendor SDK type crosses the `@relavium/llm` `LLMProvider` seam** (ADR-0011).
4. **The engine (`packages/core`) has zero platform-specific imports.**
5. **Local-first, secure by default.** API keys live in the OS keychain — never
   plaintext, never in logs, never sent to the frontend (ADR-0006). *(Phase-2 managed
   mode)* Relavium's own keys live in a KMS-backed master-key vault + key pools, attached
   only inside the gateway and never crossing the seam (ADR-0013).
6. **The desktop app is an agent-management center, not an IDE.** A conversational
   chat tab (an agent *capability*) is allowed and co-equal with the canvas; the
   forbidden boundary is the IDE shell — no code editor, file-tree, or terminal
   (ADR-0007, refined not reversed by ADR-0025).
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

- Work lands on the long-lived `development` branch and reaches the protected `main` (required CI
  checks) through a PR from `development`. Do not create other branches unless the maintainer asks.
- Conventional Commits with a per-package scope (`feat(core):`, `fix(llm):`,
  `docs(decisions):`). Reference the ADR or task the change advances. See
  [docs/standards/commit-style.md](docs/standards/commit-style.md).

## Escalation

If a requested change would violate any rule above, stop and ask before proceeding.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
