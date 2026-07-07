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

**Status:** Phase 1 is **complete** (2026-06-21). The engine runs end-to-end behind
the `LLMProvider` seam: YAML→DAG parse, the multi-model run loop (agent + the six
non-agent node handlers) with live streaming, per-node-boundary checkpoint/resume
(cross-process), node retry, provider failover, cost governance, the human gate, and
multimodal media I/O (input, inline output, and the async generation job loop). All
three adapters (Anthropic, OpenAI/DeepSeek, Gemini) and the agent-first `AgentSession`
entry point (multi-turn sessions, persistence, export-to-workflow) are shipped.
**Phase 2 (CLI) is underway and milestone M3 is reached** — the CLI skeleton (2.A) and config
resolution (2.B) landed (PR #40), `relavium run` is wired to the engine
(2.D, the M3 keystone — PR #41), the `--json` CI machine-output contract
landed (2.F — PR #42, ADR-0049), the engine regression harness (2.K — PR #43)
completes M3, and durable run history landed (2.H — PR #44, ADR-0050); the provider/key
commands with OS-keychain storage landed (2.C — PR #45, behind ADR-0019 + ADR-0006); the `ink`
streaming TUI landed (2.E — PR #46, behind ADR-0047); the interactive human-gate prompt + the
out-of-band `relavium gate` cross-process resume landed (2.G — PR #47, behind ADR-0047), **fully closing
2.K's deferred gate-resume half**; and the read commands `list` / `logs` / `status` / `gate list` over durable
history landed (2.I — PR #48, no new ADR); and CLI packaging, distribution & install verification landed
(2.L — PR #49, behind ADR-0051) — the last gate-closing spine PR, **closing go/no-go #7 so all seven Phase-3
exit criteria now hold and Phase 3 may start**; and media host-wiring landed (2.S — PR #52, behind ADR-0042–0046,
no new ADR), **the first additive lane done**; and the agent-first `relavium chat` REPL landed (2.M — PR #54,
2026-06-26, no new ADR — covered by ADR-0024/0047/0028/0050/0029; `read_media` **input** access split into a
dedicated, security-reviewed follow-up, so 2.M's REPL shipped without it); and the rest of the agent-first chat
family landed — `relavium chat-resume` (2.N), `chat-list` (2.O), `chat-export` + the in-REPL `/export` (2.P),
and `chat --json` + one-shot `agent run` (with `--fixture` cassette replay) (2.Q) — **PR #55, no new ADR**,
completing the agent-first CLI lane; and **2.R (the inbound MCP client) is ✅ Done** — the `@relavium/mcp`
foundation (the SDK-fenced package, the dependency-free JSON-Schema→Zod compiler, the fail-loud connect-all
manager) landed **PR #56**, and the host wiring (chat + run + one-shot `agent run`), the network transports
(`http`/`sse`/`websocket`) behind the SSRF floor, named secrets via the isolated `mcp-secret:*` keychain
namespace, the by-name `ref` form, and the real-spawn e2e landed **PR #57 (2026-06-27)** — behind
[ADR-0034](docs/decisions/0034-mcp-client-sdk-dependency.md) + [ADR-0052](docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md)
+ [ADR-0053](docs/decisions/0053-mcp-network-transport-egress-security.md). 2.R was off the M3 critical path and
the Phase-3 go/no-go, so it adds capability without gating; and **2.J** (the `create`/`import`/`export` YAML
lifecycle) landed **PR #58 (2026-06-28)** — **with it every Phase-2 workstream is complete and the CLI is
feature-complete (published v0.1.1)**. **Phase 2.5 (CLI Consolidation) is now underway:** its spine's secure
base **2.5.A** — the shared `assembleToolEnv` tool-environment factory (host `fs`+`process` arms, the
advertise-filter, **EA1** `tool_unavailable`, **EA2** real failed-turn usage) wired into both the chat and
run paths — landed **PR #60 (2026-06-28)**, behind [ADR-0055](docs/decisions/0055-cli-host-capability-seam-tool-environment-factory.md),
**reaching milestone M2.5-1**; the `egress`/`os` arms + write-capable chat are deferred to 2.5.E/ADR-0057; and
**2.5.B** (the bare-invocation interactive Home — the TTY-gated bare `relavium` → a read-only management strip
over `history.db` that graduates into in-process chat, one ink tree + one SIGINT/SIGTERM lifecycle + bracketed
paste) landed **PR #61 (2026-06-29)**, behind [ADR-0054](docs/decisions/0054-cli-bare-invocation-interactive-home.md);
and **2.5.C** (the in-app command system — a curated **two-registry** model: the shell `COMMAND_MANIFEST`
(`commander` + `--help --json` + the `executeCommand` dispatch) vs the in-REPL `REPL_COMMANDS` (a filterable `/`
palette + slash commands in **both** chat and the bare Home, no command in both); `/help`, the `notice` channel,
`/workflows`, `/cost`, and `/doctor` — fast tier plus a `--deep` tier with a **redacted** provider-key probe + a
**read-only** MCP-status report that never connects/spawns (a security-review decision); the `name + args` slash
dispatch + a context-aware footer hint-bar) landed **PR #62 (2026-06-30)**, behind [ADR-0056](docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md);
and **2.5.E** (the reseat-less chat mode system — ask / plan / accept-edits / auto on `Shift+Tab` + `/mode` — the
fail-closed per-tool `confirmAction` floor (`[y]/[a]/[n]` + a session once/always cache), the `Esc` mid-turn abort
(EA7), and the host arms closing the 2.5.A deferral: a write-capable `fs` tier + **protected paths** refused in
every mode incl. `auto`, the SSRF-hardened `egress` arm shared with media, and the `os` arm as a governed action
class — wired live into `relavium chat`, one-shot `agent run`, and the Home, each activating the regime before its
first turn) is ✅ **Done (PR #63, 2026-07-03)**, behind [ADR-0057](docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)
(**Accepted** after the mandatory holistic security review); a same-PR chat-UX follow-up also landed — a host tool
EXECUTION failure on the interactive surface (a file-not-found READ) is fed back to the model to recover
(`recoverToolFailures`, scoped to IDEMPOTENT tools via a stamped `ToolExecutionError.recoverable`; a governed /
side-effecting failure stays fail-fast) plus a static secret-free `tool_failed` chat hint. **With 2.5.E the CLI
Consolidation spine (2.5.A/B/C/E) is complete.** The first experience-arm workstream **2.5.D** (chat input
ergonomics + the `@`-mention / `!`-shell **pending-attachment "chip" model**) is ✅ **Done (PR #64, 2026-07-03)**,
behind [ADR-0061](docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md) (**Accepted** after a
two-round maintainer security review): the accepted file / command output is queued as a compact chip and expanded
into the shared UNTRUSTED nonce-fenced frame only at submit (byte-identical model context, a clean prompt); the
`[chat]` command allowlist resolves as a **coupled unit** (a project setting either the exact or glob array owns
the whole allowlist); and **2.5.F** (the ADR-0062 context-history commands) is ✅ **Done (PR #65, merged 2026-07-05)**,
behind [ADR-0062](docs/decisions/0062-context-compaction-and-cli-history-commands.md): **`/clear`** — a host-level
fresh-session lifecycle swap across `relavium chat`, `chat-resume`, and the in-Home chat, rebinding the same agent
under a new `sessionId` (TTY-interactive only, rejected under `--json`/plain per ADR-0049) — plus the two
compaction-moment UX polishes (a `session:compacting` "Summarizing…" event amending ADR-0036, and the footer
context-fullness indicator via a pure `@relavium/llm` `contextWindowForModel` helper), completing the ADR-0062
compaction story alongside the earlier-landed model-summarised `/compact` + deterministic `/trim` + automatic
compaction. **2.5.G is now underway** — its scope expanded to **Option A** (a **live** model catalog + a complete
model-pricing story that governs cost) behind three new ADRs ([ADR-0063](docs/decisions/0063-cli-config-write-contract.md)
config-write, [ADR-0064](docs/decisions/0064-live-model-catalog.md) live catalog,
[ADR-0065](docs/decisions/0065-provider-economics-and-extensibility.md) provider economics), across 12 reviewed
steps. The additive lane **2.5.H** (reasoning render + live-turn feedback + an actionable error taxonomy — behind
**EA6**, a dual-envelope `agent:reasoning` stream event that *amends* [ADR-0036](docs/decisions/0036-run-loop-substrate-event-bus-and-execution-host.md);
no new top-level ADR) is ✅ **Done (2026-07-07)**, reaching milestone **M2.5-3** with 2.5.E; the remaining additive
lanes 2.5.I / J run in parallel.
For live status, per-PR history, milestone dates, and open obligations, see the canonical home
[docs/roadmap/current.md](docs/roadmap/current.md); [README.md](README.md) is the public overview.

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

Once Phase 0 lands the monorepo, all work goes through pnpm + Turborepo:

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
