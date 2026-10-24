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
The joint [Wave 2 — Shut the doors](docs/roadmap/current.md#wave-2-merged--shut-the-doors) merged to `main` on 2026-10-15 as PR #94;
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

**Joint Wave 2 merged to `main` — 2026-10-15, PR #94 (`ab08209e`).**
All eight implementation steps and the maintainer corrections are complete on `main`
under Accepted ADR-0105–0109. The [merge checkpoint](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-2-merge-checkpoint--2026-10-15)
joins forty item dispositions, security sittings, the final reviewed source `4cdfe011`,
two NEW clean complete cumulative correction rounds and successful PR/push CI,
coverage, native-platform and independently inspected physical controls. Earlier
whole-wave and correction reviews retain their exact source scopes; no new whole-PR
review or merge-commit execution is inferred. Detailed review records remain local
and Git-ignored.

Exit criteria 1–3 and the D half of M2.5.5-2 are satisfied on `main`. The I half,
whole Phase 2.5.5/2.6, full M/N production lifecycle, future live provider headers
and existing approved deferrals remain open in their canonical homes. No Wave 2
implementation, review, publication, ADR approval, provider capture, credential,
billing or user-decision gate remains. Next is [Wave 3 — Clear the ground](docs/roadmap/current.md#wave-3--clear-the-ground),
whose ADR-0110–0113/contracts/nineteen-increment plan were approved on 2026-10-16.
Its serialized multi-file Step 1 is independently accepted on `development`
(2026-10-16); Step 2 is also accepted after two NEW clean complete cumulative rounds
following its historical-reader corrections. Step 3 (ADR-0113 secret provenance)
is independently accepted after two NEW complete cumulative clean rounds and a
separate clean security sitting. Step 4 (error/envelope substrate) is independently
accepted after two NEW complete cumulative clean rounds. Step 5 (tools and engine
tails) is independently accepted after two NEW complete cumulative clean rounds
following its registry-documentation correction and a separate clean security
sitting. Step 6 (pure process/discovery substrate) is independently accepted after
two NEW complete cumulative clean rounds and a separate clean security sitting.
Step 7a (lazy runtime and finite compiled graph) is independently accepted after
two NEW complete cumulative clean rounds and a separate clean security sitting.
Step 7b and whole Step 7 are independently accepted at `c836ffe6` after two NEW
complete cumulative clean rounds, a clean security sitting and successful exact-tarball
Linux/macOS/Windows plus Node 22.0.0 consumers. Broader CI retains its separately
attributed status. Step 8a implements origin adapters and an inert native foundation;
it is independently accepted at `e0a5ae19` after two NEW complete cumulative
clean rounds and a separate clean security sitting.
Step 8b (creation-owned native processes) is independently accepted at
`e16a7659` after two NEW complete cumulative clean rounds and a separate clean
security sitting following its canonical-reference correction. Its unchanged
runtime/control evidence and successful full CI plus all four same-tarball
platform consumers remain attributed to `ab50be11`, with independently verified
source/dependency equivalence. Step 8c workflow/preparation/terminal integration
is independently accepted at `dbab25d8` after two NEW complete cumulative clean
rounds, a separate clean security sitting and successful full CI. All four
same-tarball platform consumers pass at that reviewed source.
**Step 8d and whole Step 8 are independently accepted on `development` at
`c83c8575` — 2026-10-17.** Two NEW complete cumulative CLEAN rounds (R25/R26)
each cover all 342 paths / 1,842 ordered hunks after the final fixture correction.
A NEW separate clean security sitting and all fifteen full-CI jobs pass at that
reviewed source, as do all four actual same-tarball platform consumers. Original
failed reviewer-preparation records and source/native/platform limits remain
explicit; source CI does not certify later documentation commits. The
[acceptance register](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-8d-and-whole-step-8-acceptance--2026-10-17)
joins exact evidence and historical corrections. Steps 1–8 are accepted;
**Steps 1–8 merged to `main` on 2026-10-18 as PR #95 (merge commit `6d2a7372`).** Wave 3
itself is NOT complete: Steps 9–19 had not started at that merge (Step 9a.1, the first, is now
accepted on `development`, below, as are Steps 9a.2a and 9a.2b; the native-identity increment NI and Steps 9b–19 have not started) and whole-wave acceptance remains Step 19.
The [merge checkpoint](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-18-merge-checkpoint--2026-10-18)
records what merged and its review attributions. The final head `a3e164b5` (corrections from a
further independent review, including a secret-scrubbing rule) merged with author verification
only and was then independently reviewed (four rounds and a security sitting, with follow-up
fixes on `development`, not yet on `main`); CI for it and the merge commit finished green, and SonarCloud's `main`
gate (red since at least PR #90) was cleared on 2026-10-19. A pre-implementation review of Steps 9–19
and the maintainer's [2026-10-19 rulings](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-steps-919-preflight-review-and-maintainer-rulings--2026-10-19)
give every open PR #95 finding an owner and record 29 increments (no new ADR). The PR95 increment
(the scrubber residuals, including both security residuals) is closed on `development` under the
maintainer's 2026-10-21 masker acceptance bar and round cap ([checkpoint](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-pr95-increment-implementation-checkpoint-and-review-round-corrections--2026-10-20)): rounds 1–10 were
NONCLEAN; the high and medium findings through round 9 are corrected, and after round 10, the last
round, only GEN-R10-1, which the maintainer counted as high on 2026-10-22, is corrected (in the summary,
by the author alone). The other findings are recorded in deferred-tasks.md. Step 9a.1 (the candidate build and finalizer, the first increment of the release map/custody substrate, #46/ADR-0111) is independently accepted on `development` at `cf97b7f1` (2026-10-24): after twelve NONCLEAN rounds and an internal rigor pass, its round 13 reported no blocker, high or medium finding and its security sitting was clean; the round's low findings are recorded in deferred-tasks.md ([acceptance](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a1-acceptance--2026-10-24)). Step 9a.2 is split into 9a.2a and 9a.2b ([preflight decisions](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2-preflight-decisions--2026-10-24)); Step 9a.2a (the strict decoder, private manifest and packed-frame symbolication) is independently accepted on `development` at `a92a7602` (2026-10-24): rounds 1 and 2 were not accepted (a medium, then a regression from round 1's correction), and round 3 reported no blocker, high or medium finding and no regression, with a clean security sitting; its low findings are recorded in deferred-tasks.md ([acceptance](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2a-acceptance--2026-10-24)). Step 9a.2b (the product map controls, the post-receipt rebuild refusals and the `package_test` receipt) is independently accepted on `development` at `0f73c253` (2026-10-24): round 1 was not accepted (a regression in the author's own deferral record and an untested exit code), and round 2 reported no blocker, high or medium finding and no regression; its low findings are recorded in deferred-tasks.md ([acceptance](docs/roadmap/phases/phase-2.5.5-hardening-and-remediation.md#wave-3-step-9a2b-acceptance--2026-10-24)). The native-identity increment NI (a Windows file-identity security fix the maintainer approved on 2026-10-24, register row NI) is next, before Step 9b. `development` is pushed after each accepted increment. No provider,
credential, billing or new ADR approval is pending for the approved implementation plan.

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
