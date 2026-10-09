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
**Status: Phase 1 is complete; Phase 2 (CLI) is feature-complete (v0.1.1 release cut, publish
pending); Phase 2.5 (CLI Consolidation) is complete (M2.5-4, 2026-07-08); Phase 2.6
(Conversational Authoring and the First-Class CLI) is in progress, with an interlude —
Phase 2.6.5 (Core reliability remediation) — running between remediation Waves 1 and 2:
41 of 51 items closed (`CR-96` and `CR-97` were opened 2026-09-14, `CR-98` on 2026-09-18; `W7` is unblocked, with ADR-0095–ADR-0098
accepted) — all eight P0 blockers (ADR-0078–ADR-0084, merged 2026-08-24), the `W2`
liveness-and-deadlines wave (ADR-0085, merged 2026-08-28 as PR #85), `W3` resource governance and bounds (ADR-0086), merged 2026-08-30 as PR #86 **with a live blocker and nine open findings** — see the `W3` residuals in docs/roadmap/deferred-tasks.md — and `W4`, the hostile MCP boundary (ADR-0088), merged 2026-09-01 as PR #87 — a systematic review of the branch found five merge blockers, all reproduced and fixed before it merged. `W5`, media correctness (ADR-0089 + ADR-0090), **merged 2026-09-02 as PR #88** — a systematic review of that branch returned six merge blockers, all reproduced and fixed before the merge. `W6`, authoring correctness (ADR-0091–ADR-0094), **MERGED 2026-09-04 as PR #89** — `merge_strategy: first` means first DECLARED, a widened tool grant is refused when the plan is BUILT, an expression sees only its transitive closure with a literal out-of-closure read refused at parse, and an `output_schema` is compiled at parse and enforced at run time with **no new dependency**. Seven internal review rounds found that most defects were in the FIXES rather than the code they repaired; a systematic maintainer review then returned two merge blockers, both breaking a headline claim of the wave, plus eight further High findings — all reproduced and fixed before the merge. Each is a dated correction inside its own ADR.
**W7 implementation is in progress on `development`**: Steps 1–6 and 9–11 have scoped
independent acceptance; systematic review reopened production request ownership and paused-host
lifecycle obligations. All five live overflow records are complete. Step 7 is accepted after
[four cumulative review rounds](docs/reviews/2026-10-08T22-30-10-w7-step-7-round-4-review.md).
ADR-0102 controlled adapters/chain are accepted after three cumulative rounds; exact core
measured-round reuse is accepted after two fresh cumulative review rounds. ADR-0103
append/receipt integration is accepted after two fresh cumulative review rounds; shipping
provider/native integration is accepted after two fresh cumulative review rounds, including
the confirmed public-return correction and 28 permanent cases. HTTP descendants are implemented
with 23 new permanent cases and passing root CI; two fresh complete cumulative review rounds
and Parent artifact/freeze audits accept this scoped HTTP increment. Invocation-local provider/raw-poll
lifetimes are accepted after three cumulative rounds, including getter/receiver corrections and 57
permanent cases; [round 3](docs/reviews/2026-10-09T07-06-28-w7-provider-invocation-round-3-review.md)
includes Parent's artifact and whole-shared-tree audits. MCP transport/handler/fetch lifetimes
are accepted after five cumulative rounds and 77 permanent cases; [round 5](docs/reviews/2026-10-09T13-37-00-w7-mcp-lifetime-round-5-review.md)
includes Parent's complete artifact audit and qualified shared-tree comparison. Fresh-start
and interpolation lifetimes are accepted after two cumulative rounds and fourteen permanent
additions; [round 2](docs/reviews/2026-10-09T14-55-12-w7-startup-lifetime-round-2-review.md)
includes Parent's complete artifact and unchanged shared-tree audits. Complete MCP
startup/all-actor ownership, custom-provider descendants and host departure remain open, as do
Step 8 compaction/recovery
and final whole-wave Step 12. Supplemental ADR-0099–ADR-0103 are Accepted.
See [docs/roadmap/current.md](docs/roadmap/current.md) for live status.

## The non-negotiable rules

1. **TypeScript-first, strict.** No `any`, no unsafe `as`.
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

- Trunk-based on `main`; short-lived feature branches via PR.
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
