# Current state

> Status: Living

> Last updated: 2026-06-21

- **Related**: [README.md](README.md), [phases/phase-2-cli.md](phases/phase-2-cli.md), [deferred-tasks.md](deferred-tasks.md), [../project-structure.md](../project-structure.md), [../tech-stack.md](../tech-stack.md)

This page tracks what is active **right now** and the immediate next concrete actions.
The full phase plan and the global milestone spine are in [README.md](README.md); the
granular work breakdown for the active phase is in
[phases/phase-2-cli.md](phases/phase-2-cli.md).

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

> **One live maintainer obligation (carried from Phase 0):** mark the CI `ci` job a
> **required check** in GitHub branch protection (optionally add `TURBO_TOKEN`/
> `TURBO_TEAM` secrets for the cross-runner remote cache).

## What is active now

**Phase 2 — CLI (milestone M3) is in progress.** The CLI is the first real
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
(PR #43, 2026-06-23) — **reaching global milestone M3**.
**Next pickup:** **2.H** (durable run history — the highest-leverage feeder, unblocking
2.I / 2.G / 2.M / 2.S), with the **2.E** (ink TUI) feeder also open; the full status-aware order
is the [Remaining build order](phases/phase-2-cli.md#remaining-build-order) queue. The CLI also lands the inbound MCP client (2.R,
[ADR-0034](../decisions/0034-mcp-client-sdk-dependency.md)) off the M3 critical path. See the
[Phase 2 workstreams](phases/phase-2-cli.md) and the
[sequencing plan](phases/phase-2-cli.md#sequencing--parallelization).

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
