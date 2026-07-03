# Current state

> Status: Living

> Last updated: 2026-07-03

- **Related**: [README.md](README.md), [phases/phase-2.5-cli-consolidation.md](phases/phase-2.5-cli-consolidation.md), [phases/phase-2-cli.md](phases/phase-2-cli.md), [deferred-tasks.md](deferred-tasks.md), [../project-structure.md](../project-structure.md), [../tech-stack.md](../tech-stack.md)

This page tracks what is active **right now** and the immediate next concrete actions.
The full phase plan and the global milestone spine are in [README.md](README.md); the
granular work breakdown for the active phase (now **Phase 2.5**) is in
[phases/phase-2.5-cli-consolidation.md](phases/phase-2.5-cli-consolidation.md).

## Where we are

**Phase 1 — Engine and LLM is COMPLETE** (milestone **M2** reached, PR #27, 2026-06-16;
all workstreams 1.A–1.AH merged through PR #38, 2026-06-21). The engine runs end-to-end:
YAML parse → DAG → run loop → node execution (agent + the six non-agent handlers) →
checkpoint/resume → node retry → provider failover, with per-attempt cost tracking and a
gap-free `sequenceNumber`. The `@relavium/llm` seam is frozen and proven behind a
provider-agnostic `LLMProvider` interface with all three adapters (Anthropic,
OpenAI/DeepSeek, Gemini) and the `FallbackChain` runner. Two additive sub-spines also
completed: the agent-first entry point (`AgentSession` multi-turn + session persistence +
export-to-workflow, Lane C / 1.m5, 1.V–1.AA) and multimodal I/O (media input + engine
plumbing + inline & async output generation + generative adapters, 1.m6, 1.AD–1.AH). See
[Phase 1 detail](phases/phase-1-engine-and-llm.md), the [decision index](../decisions/),
and the [reference specs](../reference/).

> **Live maintainer obligations:** (1) mark the CI `ci` job a **required check** in GitHub branch
> protection (carried from Phase 0; optionally add `TURBO_TOKEN`/`TURBO_TEAM` secrets for the
> cross-runner remote cache); (2) now that **2.L** has landed (PR #49) and **v0.1.1** has been cut, add the
> **`NPM_TOKEN`** repo secret + npm 2FA so the tag-triggered `Release CLI` workflow can publish — **still pending
> for the v0.1.1 tag** (the actual `npm publish` is maintainer-gated,
> [ADR-0051](../decisions/0051-cli-distribution-thin-bundle-private-engine.md) /
> [release-a-surface.md](../runbooks/release-a-surface.md)).

## What is active now

**Phase 2 — CLI (milestone M3) is feature-complete** (every in-phase workstream 2.A–2.S merged; published as
**v0.1.1**). The CLI is the first real
`@relavium/core` consumer and doubles as the engine's regression harness — validating the
engine API ergonomics before the desktop and VS Code surfaces. **Landed:** the CLI skeleton +
process contract (**2.A**) and the two-level config-resolution loader (**2.B**), both ✅ Done
(PR #40, 2026-06-22) behind [ADR-0047](../decisions/0047-cli-framework-commander-ink-clack.md)
(commander/ink/@clack) and [ADR-0048](../decisions/0048-toml-config-parser.md) (smol-toml); and
**2.D** (`relavium run` wired to `@relavium/core` — the M3 keystone and first real engine
consumer), ✅ Done (PR #41, 2026-06-22), which also adds the `defaultProviders()` seam registry;
and **2.F** (the `--json` CI machine-output contract — pure-NDJSON stdout, diagnostics → stderr),
✅ Done (PR #42, 2026-06-22) behind [ADR-0049](../decisions/0049-cli-machine-output-contract.md);
and **2.K** (the engine regression harness, now the engine's CI regression gate), ✅ Done
(PR #43, 2026-06-23) — **reaching global milestone M3**; and **2.H** (durable local run history via
`@relavium/db` — the `RunStore` writer + read API the gate-resume/list/logs/status surfaces consume),
✅ Done (PR #44, 2026-06-23) behind [ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md);
and **2.C** (the `relavium provider` commands — a provider registry + API keys in the OS keychain via
`@napi-rs/keyring`, resolved keychain → `RELAVIUM_<PROVIDER>_API_KEY` env var → error), ✅ Done
(PR #45, 2026-06-23) behind [ADR-0019](../decisions/0019-cli-node-keychain-library.md) +
[ADR-0006](../decisions/0006-os-keychain-for-api-keys.md) (no new ADR — `secrets.enc` deferred past v1.0);
and **2.E** (the `ink` streaming TUI — the third `RunRenderer` over the one event bus: live per-node status
+ spinners, the active node's streaming tokens, a running cost footer, a persistent final summary; cooperative
Ctrl-C cancel), ✅ Done (PR #46, 2026-06-24) behind [ADR-0047](../decisions/0047-cli-framework-commander-ink-clack.md)
(ink + React 19, confined to `apps/cli`; no new ADR);
and **2.G** (the interactive human-gate prompt — a `@clack/prompts` card during `run` — plus the out-of-band
`relavium gate <runId>` cross-process resume: reload snapshot → reconstruct checkpoint → `resumeFromCheckpoint`,
idempotent, secret-input fail-closed), ✅ Done (PR #47, 2026-06-24) behind
[ADR-0047](../decisions/0047-cli-framework-commander-ink-clack.md) (`@clack/prompts`; Node floor 20.11→20.12;
no new ADR) — **fully closing 2.K's deferred gate-resume half**;
and **2.I** (the read commands `list` / `logs` / `status` / `gate list` over durable history — go/no-go #2, the
read side; surfaces the pending `gateId`s the 2.G `gate` command points at), ✅ Done (PR #48, 2026-06-24)
(no new ADR — an additive workflow-agnostic `@relavium/db` read seam + a `@relavium/core` `parseAgent`);
and **2.L** (packaging, distribution & install verification — go/no-go #7, the last gate-closing spine PR: the
`tsup` engine-inlined ESM bundle, the bundle-closure drift guard, and the tag-triggered cross-OS install-smoke
`Release CLI` workflow), ✅ Done (PR #49, 2026-06-24) behind
[ADR-0051](../decisions/0051-cli-distribution-thin-bundle-private-engine.md) — **closing go/no-go #7, so the
Phase-2 spine is complete and all seven Phase-3 exit criteria now hold (Phase 3 may start)**.
**Also landed — the first additive lane:** **2.S** (media host-wiring — the surface half of the multimodal
sub-spine: the `model_catalog` reader → `resolveMediaSurface` routing + the D15 catalog load-check shared by
`run`/`gate`, the content-addressed `MediaStore` de-inline to a `media://` handle, the SSRF-validated
`EgressCapability.fetch` egress, the containment-checked `save_to` write port, durable fail-cost on the terminal
events, the produced-media render surface, and the best-effort run-end host media GC), ✅ Done (PR #52, 2026-06-25)
behind [ADR-0042](../decisions/0042-engine-media-storage-substrate-mediastore-deinline-retention.md)–[ADR-0046](../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md)
(no new ADR).
**Also landed — the first user-facing `AgentSession` surface:** **2.M** (`relavium chat` — the agent-first
interactive REPL over `AgentSession`: streaming tokens, tool-call annotations, the FS-scope tier + `allowedCommands`
allowlist honored, `git_commit` denied; `/exit` / `/cancel` / an input-stream EOF / raw-mode Ctrl-C all end the
session with **exit code 4** — over ONE framework-free command core driving both an `ink` TTY app and a plain
non-TTY line loop; a built-in default agent over `[chat].default_model` for a zero-config first run; durable
per-turn persistence to the shared `history.db` that round-trips via `reconstructSessionState`; the ADR-0028
cost cap wired; model output + pasted input sanitized of terminal control sequences at the display boundary),
✅ Done (PR #54, 2026-06-26) — **no new ADR** (covered by [ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md),
[ADR-0047](../decisions/0047-cli-framework-commander-ink-clack.md), [ADR-0028](../decisions/0028-workflow-resource-governance.md),
[ADR-0050](../decisions/0050-cli-history-db-at-rest-posture.md), [ADR-0029](../decisions/0029-tool-policy-hardening.md)).
`read_media` **input** access (D12) — which 2.S had pointed at 2.M — was **split into a dedicated,
security-reviewed follow-up** (maintainer-approved); the 2.M REPL shipped without it (tracked in
[deferred-tasks.md](deferred-tasks.md)).
**Also landed — the rest of the agent-first chat family:** **2.N** (`relavium chat-resume` — reload + continue a
persisted session over a shared REPL), **2.O** (`chat-list` — over a new additive `SessionStore.listSessions`
read seam), **2.P** (`chat-export` + the in-REPL `/export` — session → `.relavium.yaml` scaffold, [ADR-0026](../decisions/0026-session-export-to-workflow.md)),
and **2.Q** (`chat --json` — a headless `SessionEvent` NDJSON driver — + the one-shot `relavium agent run` with a
minimal in-house `--fixture` cassette for deterministic offline replay), all ✅ **Done (PR #55, 2026-06-26)** —
**no new ADR** — completing the agent-first CLI lane. (`agent run --input` is reserved/rejected until session
`{{ctx.*}}` prompt interpolation lands — a tracked engine follow-up in [deferred-tasks.md](deferred-tasks.md).)
**Also landed — 2.R (the inbound MCP client):** agents now consume external MCP servers' tools across `chat`,
`run`, and one-shot `agent run`. The **`@relavium/mcp`** foundation (the SDK-fenced package, the dependency-free
JSON-Schema→Zod compiler, the fail-loud connect-all manager, the `mcp_{server}_{tool}` namespacing) is ✅ **Done
(PR #56, 2026-06-26)**, and the **host wiring** (chat/run/agent-run), the **network transports** (`http`/`sse`/
`websocket`) behind the SSRF pre-connect floor + the per-server `allow_local_endpoint` opt-in, **named secrets**
via the isolated `mcp-secret:*` keychain namespace, the by-name `ref` registration form, and the **real-spawn
e2e** are ✅ **Done (PR #57, 2026-06-27)** — behind [ADR-0034](../decisions/0034-mcp-client-sdk-dependency.md),
[ADR-0052](../decisions/0052-inbound-mcp-client-package-lifecycle-registration.md), and
[ADR-0053](../decisions/0053-mcp-network-transport-egress-security.md). It was off the M3 critical path and the
Phase-3 go/no-go (capability without gating). Residual MCP hardening — the connect-by-validated-IP dialer,
network header-auth, tool-list caching, mid-call abort propagation, and the stdio import-trust gate — is tracked
in [deferred-tasks.md](deferred-tasks.md).
**Also landed — 2.J (the YAML-authoring lifecycle), the last in-phase lane:** `relavium create` (a
`@clack/prompts` wizard scaffolding an agent **or** a minimal single-agent workflow, validated against the
kind-appropriate `@relavium/shared` schema before write, dual-TTY-gated), `relavium import <path>` (schema-
validated copy-in with **project-global** id uniqueness), and `relavium export <id>` (a portable copy
**re-serialized from the validated AST** — canonical, comment-free, no provider key by construction), sharing one
`assertSlugAvailable` cross-catalog guard, ✅ **Done (PR #58, 2026-06-28)** — **no new ADR** (covered by
[ADR-0026](../decisions/0026-session-export-to-workflow.md)/[ADR-0047](../decisions/0047-cli-framework-commander-ink-clack.md)).

**Phase 2 — CLI is feature-complete.** Every in-phase workstream (2.A–2.S) is merged and the published CLI is cut
as **v0.1.1**; M3 was reached at 2.K and the Phase-3 go/no-go held from 2.L. See the
[Phase 2 workstreams](phases/phase-2-cli.md) and the
[sequencing plan](phases/phase-2-cli.md#sequencing--parallelization). The full status-aware history is the
[Remaining build order](phases/phase-2-cli.md#remaining-build-order) section (its queue is now empty).

**Phase 2.5 — CLI Consolidation & Conversational Home has started.** **2.5.A** (the spine's secure base — a
shared `assembleToolEnv({ profile, fsScopeTier, workspaceDir })` factory wired into **both** the chat and
workflow-run paths, the host-side `fs` (`realpath`+`commonpath` jail, read-only chat fail-close, single-fd
`O_NOFOLLOW`/`O_NONBLOCK` reads) and `process` arms, the advertise-filter, **EA1** `tool_unavailable`, and **EA2**
real failed-turn usage) is ✅ **Done (PR #60, 2026-06-28)**, behind
[ADR-0055](../decisions/0055-cli-host-capability-seam-tool-environment-factory.md) — **reaching milestone
M2.5-1 (secure base)**. The `egress`/`os` arms, the `project`-tier `extraRoots` allowlist, and a write-capable
chat are deferred to **2.5.E**/[ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md) (tracked in
[deferred-tasks.md](deferred-tasks.md)). **2.5.B** (the bare-invocation Home) is ✅ **Done
(PR #61, 2026-06-29)**, behind [ADR-0054](../decisions/0054-cli-bare-invocation-interactive-home.md) (Accepted): the
TTY-gated bare `relavium` opens a read-only management strip (recent sessions/runs/agents + an "Attention
required" section of pending human gates / failed runs) over a bounded, indexed `history.db` read seam, sitting
above a live prompt that graduates into an in-process chat; rendered as a single ink tree (one `useInput` owner)
with one SIGINT/SIGTERM lifecycle (clean Home exit `0`; an external signal → the conventional `128+signo`, 130/143;
the in-Home chat's exit-`4` consumed, never leaked) and bracketed paste (DECSET 2004), all while every
non-interactive path keeps the byte-for-byte help + exit-`0` meta-op ([ADR-0049](../decisions/0049-cli-machine-output-contract.md)).
Canonically homed in [home.md](../reference/cli/home.md). **2.5.C** (the in-app command system) is ✅ **Done
(PR #62, 2026-06-30)**, behind [ADR-0056](../decisions/0056-cli-in-app-slash-command-system-and-manifest.md)
(Accepted): a curated **two-registry** model (the shell `COMMAND_MANIFEST` driving `commander` + `--help --json`
+ the `executeCommand` dispatch, vs the in-REPL `REPL_COMMANDS` driving a filterable `/` palette + slash commands
in **both** the chat and the bare Home — no command in both); `/help`, the `notice` output channel, `/workflows`,
`/cost`, and `/doctor` (fast tier: keychain/config/wired-tools; `--deep`: a **redacted** provider-key probe + a
**read-only** MCP-status report — a security-review decision: it reports the live session's already-connected
servers, never a fresh connect/spawn); plus the `name + args` slash dispatch and a context-aware footer hint-bar
surfacing `/ for commands`. Canonically homed in [commands.md](../reference/cli/commands.md) +
[chat-session.md](../reference/cli/chat-session.md). **2.5.E** (chat modes + per-tool approval + mid-turn abort)
is ✅ **Done (PR #63, 2026-07-03)**, behind
[ADR-0057](../decisions/0057-cli-chat-modes-and-per-tool-approval.md) (**Accepted** after the mandatory
security review): the reseat-less mode system (ask / plan / accept-edits / auto on `Shift+Tab` + `/mode`), the
fail-closed per-tool `confirmAction` floor (`[y]/[a]/[n]` + a session once/always cache), the `Esc` mid-turn
abort (EA7), and the host arms closing the 2.5.A deferral — a write-capable `fs` tier + **protected paths**
(refused in every mode incl. `auto`), the SSRF-hardened `egress` arm (shared with media), and the `os` arm (now
a governed action class). Wired live into `relavium chat`, one-shot `agent run`, and the Home (each activates
the regime before its first turn). Every step passed the mandated opus + Sonnet 5 loop plus the dedicated
holistic security review (~50 findings fixed, 4 HIGH). A same-PR chat-UX follow-up also landed: a host tool
EXECUTION failure on the interactive surface (a file-not-found READ) is fed back to the model to recover
(`recoverToolFailures`, scoped to IDEMPOTENT tools via a stamped `ToolExecutionError.recoverable`; a governed /
side-effecting failure stays fail-fast) plus a static secret-free `tool_failed` hint. **With 2.5.E the CLI
Consolidation spine (2.5.A → C, E) is complete.** **2.5.D** (chat input ergonomics) is **implemented (PR open,
pending merge, 2026-07-03)** — the first experience-arm workstream: the pure-ergonomics half (`Ctrl+J` multiline,
`↑/↓` history + `Ctrl+R` reverse-search, readline motions, a shared cursor-bearing `EditorState`) plus the two
data-moving affordances behind [ADR-0061](../decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)
(**Accepted** after a two-round maintainer security review): **`@`-mention** (dir-navigable file completion that
reads through the SAME `FsCapability` `read_file` uses — jail + the expanded sensitive-read confidentiality floor
+ listing-gate + binary/size guards — and injects as UNTRUSTED, nonce-fenced, byte+line-bounded context) and
**`!`-shell** (the additive `AgentSession.runUserCommand` — EA8 — routing `!command` through the one `run_command`
boundary: `enforcePolicy([chat].allowed_commands)` BEFORE the mode-aware `confirmAction` → `spawn`/`shell:false`;
**empty-default allowlist ⇒ `!` inert**, secure-by-default, with an actionable deny hint). Each of the 5 steps
passed the mandated opus + sonnet adversarial-review loop, and the ADR-0061 mandatory security pass ran inside the
step-4/5 loops (14 findings fixed across the two `@`-mention rounds; on the `!`-shell the opus + security pass
confirmed 0 defects after adversarial verification, and the sonnet second pass caught a HIGH — a `!`-command in
flight left no host-visible busy signal, so a message typed mid-command could crash the session — now fixed with a
`shellBusy` input gate, plus a LOW type-hygiene fix). **Next in the experience arm: 2.5.F / G.** See the
[Phase 2.5 workstreams](phases/phase-2.5-cli-consolidation.md).

Carry-over hardening is tracked in [deferred-tasks.md](deferred-tasks.md) — Phase 2 picks
items up as it first touches each file. Notable inheritances: 1.AH's host-wiring half
(distributed across Phases 2–6), the media-egress host-side SSRF mechanism, and the
keychain no-raw-key IPC test.

## Not started yet

The surfaces and the cloud — everything after the engine critical path: the desktop app
(Phase 3) and the VS Code extension (Phase 4), then **Product Phase 2** — first **managed
inference** ([phase-5-managed-inference.md](phases/phase-5-managed-inference.md), the opt-in
`managed` gateway, engine still local), then the **cloud execution layer and web portal**
([phase-6-cloud-execution-portal.md](phases/phase-6-cloud-execution-portal.md)), the two
decoupled per Option B. See the [phase index](README.md#phase-index) and the
[milestone spine](README.md#global-milestone-spine) (M3 onward).
