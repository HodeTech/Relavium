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

**Status: Phase 1 is complete** (2026-06-21) — the engine runs end-to-end behind the
`LLMProvider` seam with all three adapters, `AgentSession`, multimodal I/O, and the full
run-loop. **Phase 2 (CLI) is feature-complete** (v0.1.1 release cut, publish pending):
`relavium chat` / `chat-resume` / `agent run`, `relavium run` with `--json`, the
inbound MCP client, and the full YAML lifecycle (`create`/`import`/`export`).
**Phase 2.5 (CLI Consolidation) is complete** (M2.5-4, PR #69, 2026-07-08): the bare-invocation
Home, the two-registry command system (`/` palette + shell commands), per-tool
approval/modes (ask/plan/accept-edits/auto), `@`-mention file injection, context
compaction, the onboarding wizard + live model catalog, reasoning rendering, and regression
hardening. **Phase 2.6 (Conversational Authoring and the First-Class CLI) is in progress** — two
workstreams are merged to `main`: **2.6.F** (the platform floor + the full-screen TUI renderer,
PR #74, 2026-07-11) and **2.6.C** (the reseat transcript-carry + the `/cost` per-model breakdown,
PR #75, 2026-07-13). The phase is a full-screen Home-managed CLI with conversational workflow authoring, management
browsers, competitor-breadth tools, settings/theming/`en`+`tr` localization, and the
run-ops resume follow-up.

**An interlude is running between Wave 1 and Wave 2 of the remediation: Phase 2.6.5 (Core reliability),
41 of 51 items closed; two shipping defects found on 2026-09-14 (`CR-96`, `CR-97`) reopened the non-deferrable
list** — `W0` (PR #82, 2026-08-11), `W1`, the eight P0 blockers plus `CR-92`, merged
2026-08-24 (PR #83) behind [ADR-0078](docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md)–[ADR-0084](docs/decisions/0084-consent-before-a-local-mcp-spawn.md):
ordered durable append, cross-process run ownership, the durable effect journal, untrusted compaction summaries,
the stream-grammar seam obligation, engine-side input admission and resume identity, and consent before a local
MCP spawn. **`W2` — liveness and deadlines — merged 2026-08-28 (PR #85)** behind
[ADR-0085](docs/decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md): the authored
agent `timeout_ms` now bounds the node, every media call is bounded, a resume re-arms the run cap and a
pending gate at their REMAINING time rather than renewing them (the node bound is the deliberate exception —
ADR-0085 §2 records why), and an executor that ignores its signal can no longer leave a run without a
terminal. **`W3` — resource governance and bounds — merged 2026-08-30 (PR #86) behind
[ADR-0086](docs/decisions/0086-absolute-admission-ceilings-on-authored-values.md)**: authored values carry
absolute admission ceilings, node output / workflow state / durable events are size-bounded, and a long-lived
engine no longer retains every finished run. **It merged with a live blocker** — an un-pulled event stream
drops the terminal event, breaching ADR-0036's gap-free contract — plus nine verified findings, all recorded
in the `W3` residuals of [deferred-tasks.md](docs/roadmap/deferred-tasks.md).
[ADR-0087](docs/decisions/0087-consumed-streams-size-bounds-and-run-retention.md) records the fix and, after a
review that refused acceptance until nine dated corrections existed, is **Accepted (2026-09-04) with its §1
unimplemented** — so the blocker stands. Its §3 turned out to be implemented already, in `W5`. **`W4` — the hostile MCP boundary — merged 2026-09-01 (PR #87)
behind [ADR-0088](docs/decisions/0088-the-mcp-boundary-is-hostile.md)**: every MCP call is bounded and
cancellable, `http`/`sse` connect by validated pinned IP, a redirect is refused, a remote `websocket` is
refused at admission, a server's ingress is bounded at two levels, and its tool DEFINITIONS are treated as
untrusted. No new product surface in either wave — only the invariants an existing surface already claims.
A systematic review of PR #87 found **five merge blockers** in `W4` — all reproduced and fixed before it
merged; the phase doc's `W4` section records what they were and what the pattern says. **`W5` — media correctness — MERGED 2026-09-02 (PR #88)** behind
[ADR-0089](docs/decisions/0089-media-correctness-four-boundaries.md) and
[ADR-0090](docs/decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md): `read_media` delivers
over the media-input rail on a marked, fenced synthesized message; tool and attachment capability is gated on
the MODEL; Gemini's function-call continuation token rides the part it belongs to; a media body streams from
the network into the store under a size ceiling, an idle deadline and the run signal; a `url` output is pinned
to a content-addressed handle at first resolution; and a missing media rate is unpriced rather than a price of
zero. A systematic maintainer review of the branch returned **six merge blockers**, all reproduced and fixed
before it merged. Two items closed one half of a two-part obligation and say so; every residual is written out
rather than left inside a checked box. **`W6` — authoring correctness — MERGED 2026-09-04 (PR #89)** behind [ADR-0091](docs/decisions/0091-first-means-first-declared-not-first-to-finish.md)–[ADR-0094](docs/decisions/0094-a-tool-grant-is-checked-when-the-plan-is-built.md):
`merge_strategy: first` means first DECLARED and the plan field no longer claims otherwise; a widened tool grant
is refused when the plan is BUILT rather than mid-run; an expression sees only its transitive dependency closure
and a literal out-of-closure `run.outputs` read is refused at parse (as is `edges[].condition`, which nothing
ever read); and an authored `output_schema` is compiled at parse in an allowlist-strict mode and enforced at run
time — with **no new dependency**, because the JSON-Schema→Zod compiler the deferral claimed we needed already
existed in `packages/mcp` and simply moved to `@relavium/shared`. Seven internal review rounds found that **most defects
were in the FIXES rather than the code they repaired** — the branch-order search was wrong three times, the
expression scan's no-false-refusal claim was false in eight ways, and a stand-down gate silently removed the
check it was added to protect; each is a dated correction inside its own ADR. A systematic maintainer review
then returned **two merge blockers**, both breaking a headline claim of the wave — `required` was not enforced
when a property's schema constrained nothing, and the expression scanner's regex was quadratic and synchronous
on a parser that accepts 2 MiB — plus eight further High findings, all reproduced and fixed before the merge.


**Between `W6` and `W7`, the two remaining non-deferrable items closed (2026-09-06)**: `CR-73` — `invoke_agent`
was advertised to every model granted it while `ctx.invokeAgent` is wired nowhere in the tree, so the
advertise-filter now checks a tool's declared dispatch DELEGATE and not only its `ToolHost` arm (`read_media`
rides along, for the same reason and by `CR-50`'s own argument) — and `CR-80` — a rejected custom provider
`base_url` was caught and the DEFAULT adapter left standing, which is the official API, so a drifted config
silently sent prompts and keys to `api.openai.com`; it now installs a refusing adapter naming the URL's shape,
never its credentials. The test that was supposed to pin `CR-80` asserted only `toBeDefined()`, which a
refusing adapter satisfies too, so it passed either way — the finding under the defect was the test.
[ADR-0087](docs/decisions/0087-consumed-streams-size-bounds-and-run-retention.md) was also **accepted
(2026-09-04) with nine dated corrections** after a review refused it as written; its §1 remains unimplemented
and the `W3` live blocker with it, while its §3 turned out to have shipped in `W5` under a different item
number.

**`W7` is unblocked (2026-09-14).** The maintainer settled its open decisions, and four ADRs record them, all
**Accepted**. Implementation is in progress on `development`; the complete step/review status is
[recorded in the roadmap](docs/roadmap/current.md):

- [ADR-0095](docs/decisions/0095-what-an-agent-session-remembers-across-turns.md) decides that a session
  persists the *structure* of its tool history and never its content, defers carrying tool history into the
  model's context, and implements the authored `memory` policy. Structural transcript/export, policy
  projection and session effect privacy are implemented in accepted Steps 2–5; carrying stays deferred.
- [ADR-0096](docs/decisions/0096-a-request-is-measured-before-it-is-sent.md) decides that a request is measured
  before it is sent, that a context overflow is classified and recovered only before any tool runs, and that input
  is priced. Step 6 implements per-request input/output admission under the accepted shared reservation
  rules. Step 7's fixture-pinned overflow classification is accepted after four cumulative review
  rounds; production request ownership and Step 8's measured/recovery compaction remain open.
- [ADR-0097](docs/decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md) decides that a budget
  approval grants a dispatch-owned, shown, durable allowance. Steps 9–10 implement and accept the
  governor/debit and strict replay barrier; Step 11's CLI surface is accepted after three independent review rounds.
- [ADR-0098](docs/decisions/0098-a-session-effect-row-holds-no-result-and-never-replays.md) decides that a session's
  effect row holds no tool result and never replays. Accepted Steps 2–4 implement durable identities,
  disclosure/retention and qualified physical clearing; the canonical at-rest security sitting states
  the busy-WAL and pre-upgrade freed-page limits.

Supplemental [ADR-0099](docs/decisions/0099-compaction-has-an-idle-budget-outcome-and-an-unknown-window-policy.md),
[ADR-0100](docs/decisions/0100-budget-authorization-is-durable-state-with-a-replay-barrier.md) and
[ADR-0101](docs/decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md)
were accepted on 2026-10-02 after maintainer review. Acceptance of completed steps does not close the
six W7 register items. All five required live provider records are complete as of 2026-10-08;
[Step 7 round 4](docs/reviews/2026-10-08T22-30-10-w7-step-7-round-4-review.md) accepts its complete
46-path scope. The maintainer approved the latest
[ADR-0102](docs/decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md) and
[ADR-0103](docs/decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md)
clarifications on 2026-10-08. Their internal foundations and controlled adapter/chain increment
are accepted; exact core measured rounds are accepted after two fresh cumulative review rounds.
ADR-0103 append/receipt integration is accepted after two fresh cumulative review rounds.
Shipping provider/native integration is accepted after two fresh cumulative review rounds,
including the confirmed public-return correction and 28 permanent cases. HTTP descendants
are implemented with 23 new permanent cases and passing root CI, awaiting two fresh review
rounds. Transitive MCP/custom-provider, host departure, Step 8 and final Step 12 remain open. Systematic review's
ownership/lifecycle obligations remain
open until that integration is independently verified.

The first six review rounds shaped these ADRs, and they surfaced two shipping defects, opened as `CR-96` and
`CR-97`, both open, non-deferrable and scheduled into `W7`.

A **seventh round on 2026-09-18** then reviewed the four ADRs against the tree before any code was written — eight
dimensions, each finding adversarially verified — and returned 113 findings plus seventeen maintainer decisions.
Each ADR carries a dated note of that date, and `W7` gained `CR-98` (ADR-0096's three prerequisites, which had no
register item), `relavium budget resume` (moved from 2.6.K, so an approval has a non-TTY surface) and a fifth
security sitting, `history.db` at rest. ADR-0087 §1, the `W3` live blocker that belonged to no wave, is scheduled
into `W8`. `CR-96`: a crash after a budget decision resumes the agent as complete,
with an invented output. `CR-97`: session effect rows keep tool output at rest and can replay a stale result. After the fifth round, the maintainer
had the ADRs restated as decisions, invariants and acceptance tests, because every round's defects were in the
previous round's fixes.

For live status, per-PR history, milestone dates, and open obligations, see the canonical
home [docs/roadmap/current.md](docs/roadmap/current.md);
[README.md](README.md) is the public overview;
[docs/roadmap/phases/phase-2.6-conversational-authoring.md](docs/roadmap/phases/phase-2.6-conversational-authoring.md)
has the full Phase 2.6 plan.

## Non-negotiable rules for AI agents

These apply to every AI agent in this repo, regardless of model, runner, or tool.

1. **TypeScript-first, strict.** All source is TypeScript. Strict mode; no `any`,
   no unsafe `as`. Prefer type guards. See [docs/standards/code-style-typescript.md](docs/standards/code-style-typescript.md).
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
