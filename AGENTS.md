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
**Status: Phase 1 is complete; Phase 2 (CLI) is feature-complete (published as v0.1.1);
Phase 2.5 (CLI Consolidation) is complete (M2.5-4, 2026-07-08); Phase 2.6
(Conversational Authoring and the First-Class CLI) is in progress, with an interlude —
Phase 2.6.5 (Core reliability remediation) — completed between remediation Waves 1 and 2:
49 of 51 items closed on `main`, with approved deferrals retained; W8 merged 2026-10-11 in PR #92 (`CR-96` and `CR-97` were opened 2026-09-14, `CR-98` on 2026-09-18; `W7` merged to `main` on 2026-10-10 (PR #90), with ADR-0095–ADR-0103
accepted) — all eight P0 blockers (ADR-0078–ADR-0084, merged 2026-08-24), the `W2`
liveness-and-deadlines wave (ADR-0085, merged 2026-08-28 as PR #85), `W3` resource governance and bounds (ADR-0086), merged 2026-08-30 as PR #86 **with a live blocker and nine open findings at that merge** — the blocker is now closed by W8/PR #92; scoped residuals remain in docs/roadmap/deferred-tasks.md — and `W4`, the hostile MCP boundary (ADR-0088), merged 2026-09-01 as PR #87 — a systematic review of the branch found five merge blockers, all reproduced and fixed before it merged. `W5`, media correctness (ADR-0089 + ADR-0090), **merged 2026-09-02 as PR #88** — a systematic review of that branch returned six merge blockers, all reproduced and fixed before the merge. `W6`, authoring correctness (ADR-0091–ADR-0094), **MERGED 2026-09-04 as PR #89** — `merge_strategy: first` means first DECLARED, a widened tool grant is refused when the plan is BUILT, an expression sees only its transitive closure with a literal out-of-closure read refused at parse, and an `output_schema` is compiled at parse and enforced at run time with **no new dependency**. Seven internal review rounds found that most defects were in the FIXES rather than the code they repaired; a systematic maintainer review then returned two merge blockers, both breaking a headline claim of the wave, plus eight further High findings — all reproduced and fixed before the merge. Each is a dated correction inside its own ADR.
**W7 merged to `main` on 2026-10-10 as PR #90, including final whole-wave Step 12.**
Steps 1–11, all five genuine overflow records, ADR-0102 request ownership and consolidated ADR-0103
host integration have independent acceptance. ADR-0095–ADR-0103 are Accepted. All six W7 register
items are closed (47/51 at the W7 merge); PR #90 is merged (`46a6a701`); W7 has no open implementation or review gate. The
[closing register](docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10)
joins evidence and every submitted review disposition. W8 subsequently merged in PR #92; approved deferrals remain.
No user decision, billing setup, credential or provider capture is pending.
**W8 merged to `main` on 2026-10-11 as PR #92 (`ef0ffa54`); Phase 2.6.5 is complete with approved deferrals.**
All seven steps, CR-81/82 and ADR-0087 §1 are complete on `main`; the register is **49/51**.
The [merge checkpoint](docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-merge-checkpoint--2026-10-11)
joins original whole-wave acceptance, maintainer corrections and final reviewed-head `3d4491df`
PR/push CI and SonarCloud success. Published ordinary/enforced coverage records 511 files /
11,026 passing tests / 12 established skips; all four wire and 23 usage mechanisms pass.
CR-70/93, CR-95's long continuation and exact-capacity/scoped residuals remain approved deferrals.
The joint [Wave 2 — Shut the doors](docs/roadmap/current.md#next-work--wave-2--shut-the-doors) is now accepted on `development`;
next is [Wave 3 — Clear the ground](docs/roadmap/current.md#wave-3--clear-the-ground).
Phase 2.5.5 and Phase 2.6 remain in progress. No W8 implementation or landing gate remains.
**Post-closure corrections are independently accepted, 2026-10-10:** core, CLI/DB and tooling/docs
each have two NEW clean complete cumulative review rounds. The supplemental publication-tool
correction also has two NEW complete clean rounds. The [post-closure register](docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#post-closure-systematic-review--2026-10-10)
joins every report disposition, new permanent/causal evidence and current gates. Published-head checks
passed at reviewed head `69ac80b0` before PR #90 merged. No W7 implementation, provider,
billing, key or user decision is pending. The [merge checkpoint](docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-merge-checkpoint--2026-10-10)
records W7 closure. W8 subsequently merged in PR #92; the register is 49/51 on `main`.
Existing approved limits are unchanged.

**PR #92 maintainer corrections:** the [correction register](docs/roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-pr-92-systematic-review-corrections--2026-10-11)
records all four increments and the subsequent publication correction accepted after two NEW
clean complete cumulative rounds each. Fresh full CI and bare/enforced coverage pass at `6139563e`,
including four wire and 23 usage controls.
Final reviewed head `3d4491df` passed PR/push CI and SonarCloud before PR #92 merged.
No merge-commit execution or new whole-PR review is inferred. Two nonblocking Sonar complexity
suggestions remain visible; no new deferral or decision is added.

**Joint Wave 2 accepted on `development` — 2026-10-13:** all eight implementation
steps are complete under approved ADR-0105–0109. The [closing register](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-closing-register--2026-10-13)
joins forty individual dispositions, four new security sittings plus W4 revalidation,
two NEW complete clean cumulative whole-wave rounds, broad author/coverage gates
and exact-source published causal/platform evidence. Exit criteria 1–3 and the D
half of M2.5.5-2 are accepted; the I half and full phases remain open. Publication
is separate from merge. No ADR approval, provider capture, key, billing or user
decision is pending for Wave 2. Next engineering work is
[Wave 3 — Clear the ground](docs/roadmap/current.md#wave-3--clear-the-ground),
starting with its serialized multi-file queue and a fresh decision preflight.
Full M/N lifecycle and existing approved deferrals retain their canonical homes.

**PR #94 maintainer source corrections accepted — 2026-10-13:** runner-level
unhandled-error rejection, legal OpusTags tails and FLAC nonfinal block consistency
each have two NEW independent clean complete cumulative correction rounds. Final
source rounds at `f4ca3c53` cover all 28 correction paths / 72 hunks; these are not a
new review of all original PR paths. The [correction register](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#pr-94-systematic-review-corrections--2026-10-13)
joins source acceptance; [PR #94](https://github.com/HodeTech/Relavium/pull/94)
records current corrected-head full CI/coverage/platform and complete physical
controls separately. Their actual success is required before merge. Original
`395fbf95` artifacts retain their historical scope. Wave 3 is subsequent work.

**PR #94 lower-priority corrections — 2026-10-13:** all twelve verified Low
items from the subsequent 305-path review are implemented in three increments.
The [lower-priority correction register](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#pr-94-lower-priority-review-corrections--2026-10-13)
records every disposition and separately attributes selected controls, broad gates
and historical captures. Each increment requires two NEW complete clean cumulative
source rounds after its final fix; PR #94 owns the actual final reviewed-head
acceptance and refreshed CI/coverage/platform/physical-evidence publication.
No new ADR, deferral, provider request, key, billing action or user decision is
introduced. Wave 3 follows these corrections; publication remains separate from merge.

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
