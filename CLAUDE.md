# Claude agent guide — Relavium

This file is the entry point for Claude-based AI agents (Claude Code, the Claude
API, subagents) working in this repository. Read it fully before taking any
action. Other AI agents should read [AGENTS.md](AGENTS.md), which points back here.

## What this project is

**Relavium** is a multi-surface, **local-first** AI agent platform — a
product of **HodeTech** ([github.com/HodeTech/Relavium](https://github.com/HodeTech/Relavium)).
*Start as an agent. Ship the workflow. Own every run.* You begin in a conversational
**agent session** — a first-class engine entry point on every surface (CLI `relavium chat`,
a desktop chat tab, a VS Code coding-assistant) — and graduate that session into a
multi-agent, multi-model **workflow** authored as **git-committable YAML**, run across a
Tauri desktop app, a VS Code extension, and a CLI. Both entry points — `AgentSession` and
`WorkflowEngine` — sit on one **pure-TypeScript engine shared by every surface**, reusing the
same tool registry, `@relavium/llm` seam, and event bus. See
[ADR-0024](docs/decisions/0024-agent-first-entry-point-agentsession.md) and
[ADR-0026](docs/decisions/0026-session-export-to-workflow.md).

It is a **Turborepo + pnpm monorepo**:

| Package / App | What it is |
|---------------|-----------|
| `packages/shared` (`@relavium/shared`) | Zod schemas + inferred types — the single source of truth (workflow/agent/run-event/config). |
| `packages/llm` (`@relavium/llm`) | Relavium's **own** multi-LLM abstraction: the `LLMProvider` seam + thin hand-rolled adapters over the official provider SDKs. No Vercel AI SDK, no LangChain. |
| `packages/core` (`@relavium/core`) | **The engine** — YAML→DAG parse, runner, checkpoint/resume, retry. **Zero platform-specific imports.** The most important package. |
| `packages/db` (`@relavium/db`) | Drizzle schema + migrations — same schema for SQLite (local) and Postgres (cloud). |
| `packages/mcp` (`@relavium/mcp`) | The inbound MCP client — the SDK-fenced package and the `http`/`sse`/`websocket` transports behind the SSRF floor. (The dependency-free JSON-Schema→Zod compiler moved to `@relavium/shared` — [ADR-0092](docs/decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md) §1.) |
| `packages/ui` (`@relavium/ui`) | Shared React components: ReactFlow node types + shadcn/ui. |
| `apps/desktop` | Tauri v2 desktop app — the agent-management center (canvas, run monitoring). |
| `apps/cli` | Terminal CLI (`commander.js` + `ink`). The engine's first real consumer + regression harness. |
| `apps/vscode-extension` | Standalone VS Code extension (bundles the engine). |
| `apps/api`, `apps/portal` | **Phase 2** — backend + **control-plane** web portal (not a second canvas). |

A run executes in one of **three execution modes** behind the one `LLMProvider` seam —
**local** (BYOK, the Phase-1 default), **cloud** (BYOK-central, Phase 2), and **managed**
(Relavium's own keys via a metered egress gateway; engine still runs locally, Phase 2). The
engine is identical across all three. See [ADR-0012](docs/decisions/0012-managed-inference-dual-mode.md) to [ADR-0015](docs/decisions/0015-managed-mode-data-handling-and-compliance.md)
and [docs/architecture/managed-inference.md](docs/architecture/managed-inference.md).

**Status (2026-11-19): the CLI MVP comes first.** Phase 1 (engine and LLM) is complete; Phase 2
(CLI) is feature-complete and `relavium@0.1.1` is the published version; Phase 2.5 (CLI Consolidation) is
complete (M2.5-4, PR #69, 2026-07-08); Phase 2.6.5 (Core reliability) is complete with approved deferrals
(49/51, PR #92, 2026-10-11). Phase 2.5.5 (Hardening and Remediation): Waves 0–2 are merged (Wave 2: PR #94),
Wave 3 Steps 1–8 are merged (PR #95, 2026-10-18), and PR95, 9a.1, 9a.2a, 9a.2b, NI, 9b.1 and 9b.2 are
accepted and on `main` since the `development`→`main` checkpoint (PR #96, merged 2026-11-04). **On 2026-10-26 the maintainer paused Wave 3 — Steps 9c–19 are pending, not
declined — and put the CLI MVP first:** `relavium` v0.2.0 on npm (milestone M3.5), ordered as MVP-1…MVP-10 in
[current.md](docs/roadmap/current.md#next-work--the-cli-mvp) under decisions D58–D72 (ruled 2026-11-04).
Phase 2.6 (Conversational Authoring and the First-Class CLI) is in progress: 2.6.C and 2.6.F are done
(2.6.F's v0.2.0 release clause closes with the MVP) and 2.6.Q P1–P5 landed; the MVP takes slices of the rest.
**MVP-1 is accepted (2026-11-06) and on `main` with the second checkpoint (PR #97, merged 2026-11-07).
MVP-2 is complete and on `main` through PR #98 (`0db4c940`, merged 2026-11-11), including all four steps,
review corrections, separate security sittings and passing combined CI.**
See the [merge checkpoint](docs/roadmap/phases/phase-2.6-conversational-authoring.md#mvp-2-merge-checkpoint-2026-11-11).
**MVP-3, with MVP-3b, MVP-3c and MVP-3d, is complete and on `main` through PR #99 (`002dda58`, merged
2026-11-18):** editing and search tools, trustworthy approval previews and tool-call rendering v2, native metadata
preservation, the built-in editing grant and startup-mode settings (MVP-3's three steps); the docked approval card,
honest chat modes and refusals that return to the model (MVP-3b: [ADR-0129](docs/decisions/0129-the-approval-card-is-docked-bounded-and-says-only-what-matters.md),
[ADR-0130](docs/decisions/0130-chat-modes-ask-prompts-plan-reads-accept-edits-accepts.md), [ADR-0131](docs/decisions/0131-a-round-that-made-progress-resets-the-correction-budget.md),
[ADR-0117](docs/decisions/0117-a-denied-tool-call-returns-to-the-model.md)); an interrupted turn that stays as a content-free marker (MVP-3c,
[ADR-0119](docs/decisions/0119-an-interrupted-turn-stays-as-a-content-free-marker.md)); `ask_user`, whose question and answer are kept with the
session (MVP-3d, [ADR-0132](docs/decisions/0132-the-model-can-ask-the-user-a-structured-question.md) and
[ADR-0133](docs/decisions/0133-an-ask-user-question-and-its-answer-are-kept-with-the-session.md)); the native write-admission proof
([ADR-0126](docs/decisions/0126-native-write-admission-and-recovery-keep-explicit-lifetime-proof.md)), the macOS write-metadata correction
([ADR-0127](docs/decisions/0127-macos-write-metadata-has-distinct-parent-and-file-profiles.md)) and the content-free tool receipts
([ADR-0128](docs/decisions/0128-content-free-tool-receipts-ground-later-chat-turns.md)); every approval answer key as a Ctrl chord
(`Ctrl+Y`/`Ctrl+G`+Enter/`Ctrl+N`/`Ctrl+R`); and the approval card's full view (`[v]`) and `/details` rebuilt as one readable
screen ([ADR-0134](docs/decisions/0134-the-full-view-and-the-tool-details-are-one-readable-inspection-screen.md)). The independent reviews and separate
security sittings are recorded in the phase register. The [MVP-3 merge checkpoint](docs/roadmap/phases/phase-2.6-conversational-authoring.md#mvp-3-merge-checkpoint-2026-11-18) owns the evidence and its two CI
observations: the required `coverage` job stopped at its 45-minute limit on the final head in both runs, so no green final-head
coverage run exists (the merge commit's identical tree passed it in 41 min 10 s); and one acceptance-tool test hit its 10-second
limit in the first attempt of the merge commit's push run, which a re-run (attempt 2, success) cleared. SonarCloud's gate is OK on
the PR and on `main`. **PR #100 (`1e71f652`, merged 2026-11-18) then put the native adapter's first increment on `main`** (concurrent
processes on one operator home wait for the staging inventory's allocation claim instead of failing a write,
[ADR-0135](docs/decisions/0135-concurrent-processes-on-one-operator-home-wait-for-the-allocation-claim.md)) with CI once per commit and a coverage run narrowed to
`packages/`. Its final-head run `2ce6a252` passed all 29 jobs; the docs-only final head `639134b2` was merged before its own run finished, so no
completed run exists on it, and a separate security sitting on the Linux parent-snapshot change is still owed (the
[PR #100 merge checkpoint](docs/roadmap/phases/phase-2.6-conversational-authoring.md#pr-100-merge-checkpoint-2026-11-18) owns the evidence). **MVP-4 steps 1–7 are implemented on `development`** (steps 1–4 on 2026-11-19; step 5, the `/permissions` sheet, on 2026-11-20 and 21; step 6, `Esc` out of the full view, on 2026-11-21 with two review rounds and two security sittings; step 7, the Home entry points, on 2026-11-21 with its review rounds owed; [ADR-0137](docs/decisions/0137-permissions-is-a-sheet-and-esc-steps-back-out-of-the-full-view.md), Accepted 2026-11-20, steps 5 to 7), with
[ADR-0115](docs/decisions/0115-one-interrupt-keymap-for-the-interactive-cli.md),
[ADR-0118](docs/decisions/0118-a-command-outside-the-allowlist-asks-instead-of-failing.md) and
[ADR-0136](docs/decisions/0136-a-turn-asks-to-continue-at-a-checkpoint-instead-of-dying-at-a-ceiling.md) accepted: all four steps (engine floor, interrupt
keymap and continue checkpoint, command permissions, the command card with `/permissions`) are in with two review rounds each. In `auto` only the operator's
own remembered or session-approved commands skip the card, never the repository's allowlist (the maintainer's ruling on the second round's security
sitting). The pull request is to be opened on request (the
[implementation record](docs/roadmap/phases/phase-2.6-conversational-authoring.md#mvp-4-implementation-record) owns progress). npm still
serves `0.1.1`; no publication is claimed. Exact status lives in [current.md](docs/roadmap/current.md).
On 2026-11-08 the maintainer made the full-screen Home the interactive product: the user types `relavium` and
does everything there, and subcommands stay for scripting ([ADR-0122](docs/decisions/0122-the-home-is-the-interactive-product.md)).
MVP-2 delivers readable replies, native provider setup, project initialization and safe session resume around it.

Two rules shape every MVP increment. Step 9a.1's interim release guard (on `main` since PR #96) refuses any npm
publication until the superseding pre-1.0 release ADR (D59) is Accepted. The acceptance bar is tiered (D64):
an increment touching an approval or consent path, egress, keys or secrets, filesystem writes, a new terminal
sink for untrusted content, the lease or resume paths, or release keeps a rigor pass, one NEW complete
cumulative round with no blocker, high or medium finding, and a separate security sitting; other UX,
rendering and command increments are reviewed per milestone. `development` is pushed after each accepted
increment.

For live status, per-PR history, milestone dates, and open obligations, see the canonical
home [docs/roadmap/current.md](docs/roadmap/current.md);
[README.md](README.md) is the public overview;
[docs/roadmap/phases/phase-2.6-conversational-authoring.md](docs/roadmap/phases/phase-2.6-conversational-authoring.md)
has the full Phase 2.6 plan.

## Non-negotiable rules for AI agents

These apply to every AI agent in this repo, regardless of model, runner, or tool.

1. **TypeScript-first, strict.** Application/engine source is TypeScript. Strict mode; no `any`,
   no unsafe `as`. Prefer type guards. [ADR-0125](docs/decisions/0125-file-writes-preserve-security-metadata-through-a-native-host-adapter.md)
   permits only the CLI filesystem metadata adapter's Rust/Node-API source/build
   boundary; shared/core and the LLM seam remain platform-pure TypeScript.
   See [docs/standards/code-style-typescript.md](docs/standards/code-style-typescript.md).
2. **Build in-house; minimize dependencies.** Write our own better implementations
   for the core. **No new runtime dependency without an ADR.** Never adopt the
   Vercel AI SDK or LangChain for the LLM layer — Relavium owns `@relavium/llm`.
   See [docs/standards/architectural-principles.md](docs/standards/architectural-principles.md)
   and [ADR-0011](docs/decisions/0011-internal-llm-abstraction.md).
3. **Never reinvent security-critical primitives.** Use vetted crypto, TLS, and the
   OS keychain — wrap them, never hand-roll them.
4. **No vendor SDK type crosses the `@relavium/llm` seam.** The `LLMProvider`
   contract is expressed only in Relavium/Zod types. See
   [ADR-0011](docs/decisions/0011-internal-llm-abstraction.md) and
   [docs/reference/shared-core/llm-provider-seam.md](docs/reference/shared-core/llm-provider-seam.md).
5. **The engine (`packages/core`) has ZERO platform-specific imports** — it runs
   identically in Node, the Tauri WebView, the VS Code extension host, and (Phase 2)
   the Bun API.
6. **Local-first, secure by default.** API keys live in the OS keychain — never in
   plaintext, never in logs, never sent to the frontend or into a job payload. See
   [ADR-0006](docs/decisions/0006-os-keychain-for-api-keys.md) and
   [docs/standards/security-review.md](docs/standards/security-review.md). *(Phase-2
   managed mode)* Relavium's own provider keys live in a KMS-backed master-key vault and
   per-provider key pools, attached only inside the gateway on the outbound request — they
   never cross the `LLMProvider` seam either ([ADR-0013](docs/decisions/0013-managed-key-vault-and-pools.md)).
7. **The desktop app is an agent-management center, NOT an IDE.** A conversational
   chat tab — an agent *capability* — is allowed and co-equal with the canvas; the
   forbidden boundary is the **IDE shell**: no code editor, no file-tree browser, no
   terminal. See [ADR-0007](docs/decisions/0007-desktop-is-not-an-ide.md), refined (not
   reversed) by [ADR-0025](docs/decisions/0025-agent-surface-refines-desktop-scope.md).
8. **One canonical home per artifact.** Concrete specs (workflow/agent YAML,
   run-event schema, IPC, config, node types, DB schema) live only in their
   [docs/reference/](docs/reference/) file; everything else links to it, never
   restates it.
9. **Record non-trivial decisions as ADRs** in [docs/decisions/](docs/decisions/)
   using the condensed MADR form. ADRs are **append-only** — to change one, write a
   new ADR that supersedes it; never rewrite history.
10. **English, kebab-case files, relative doc links, Mermaid diagrams,
    Conventional Commits** (scope per package, reference the ADR/task). See
    [docs/standards/commit-style.md](docs/standards/commit-style.md) and
    [docs/standards/documentation-style.md](docs/standards/documentation-style.md).

**Research documentation direction (maintainer, 2026-11-15):** retain technical
findings and Relavium requirements without naming or linking external agent
products. Follow the [documentation direction](docs/analysis/README.md#maintainer-documentation-direction--2026-11-15).
Required dependency/provider provenance and truthful assisting-tool attribution
remain explicit; this instruction does not rewrite published Git history.

## Where to find things

| Need | Path |
|------|------|
| What & why (product) | [docs/vision.md](docs/vision.md) · [docs/product-constraints.md](docs/product-constraints.md) · [docs/uvp.md](docs/uvp.md) |
| The pinned stack | [docs/tech-stack.md](docs/tech-stack.md) |
| Monorepo layout | [docs/project-structure.md](docs/project-structure.md) |
| How it's built | [docs/architecture/](docs/architecture/) |
| Why it's built this way (ADRs) | [docs/decisions/](docs/decisions/) |
| Exact contracts/specs | [docs/reference/](docs/reference/) |
| Binding rules (code/test/security/commits) | [docs/standards/](docs/standards/) |
| What's active + the phase plan | [docs/roadmap/current.md](docs/roadmap/current.md) · [docs/roadmap/phases/](docs/roadmap/phases/) |
| Recurring agent procedures | [.claude/skills/](.claude/skills/) |
| Project terms | [docs/glossary.md](docs/glossary.md) |

## Reading order

1. [README.md](README.md) — what Relavium is.
2. **This file (CLAUDE.md).**
3. [docs/glossary.md](docs/glossary.md) — the vocabulary used everywhere.
4. [docs/roadmap/current.md](docs/roadmap/current.md) — what's active now.
5. The ADRs in [docs/decisions/](docs/decisions/) in numerical order.
6. The [docs/standards/](docs/standards/) relevant to your task.
7. The skill at [.claude/skills/&lt;slug&gt;/SKILL.md](.claude/skills/) matching your task.

## Build, test, lint

All work goes through pnpm + Turborepo:

```bash
pnpm install
pnpm turbo run lint typecheck test    # across all workspaces, in dependency order
pnpm turbo run build
```

Never use `npm` or `yarn`. Respect `pnpm-workspace.yaml` and the `workspace:*`
protocol for inter-package dependencies. No circular dependencies.

## Skills

When the maintainer asks for a recurring task — write an ADR, scaffold a package,
add an LLM adapter, review a diff — there is usually a **skill** at
`.claude/skills/<slug>/SKILL.md` describing the correct procedure step by step.
Read the skill in full and check its done-criteria before finishing. Skills are how
the project keeps recurring work consistent; they cite the standards and ADRs,
never duplicate them. See [.claude/skills/README.md](.claude/skills/README.md) for
the index.

A project-aware reviewer subagent lives at
[.claude/agents/relavium-reviewer.md](.claude/agents/relavium-reviewer.md).

## Before starting work

1. Read the ADRs in numerical order — they are the design language of the project.
2. Read the [docs/standards/](docs/standards/) relevant to your change before editing.
3. If a task spans more than two or three files, propose a plan first.
4. If a change touches security-relevant code (keys, crypto, the keychain, custom
   provider base URLs, the JS sandbox), flag it for explicit review.
5. Respect package boundaries and the `@relavium/llm` seam.

## Escalation

If a requested change would violate any non-negotiable rule above, **stop and ask**
before proceeding. It is better to pause than to silently weaken a guarantee.
