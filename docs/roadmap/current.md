# Current state

> Status: Living

> Last updated: 2026-06-25

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

> **Live maintainer obligations:** (1) mark the CI `ci` job a **required check** in GitHub branch
> protection (carried from Phase 0; optionally add `TURBO_TOKEN`/`TURBO_TEAM` secrets for the
> cross-runner remote cache); (2) now that **2.L** has landed (PR #49), add the **`NPM_TOKEN`** repo secret + npm 2FA
> so the tag-triggered `Release CLI` workflow can publish (the actual `npm publish` is maintainer-gated,
> [ADR-0051](../decisions/0051-cli-distribution-thin-bundle-private-engine.md) /
> [release-a-surface.md](../runbooks/release-a-surface.md)).

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
(no new ADR — `read_media` input access deferred to 2.M).
**Next pickup:** **2.R** (the inbound MCP client, [ADR-0034](../decisions/0034-mcp-client-sdk-dependency.md) — off
the M3 critical path and the Phase-3 go/no-go, so it completes in-phase without blocking Phase 3); the full
status-aware order is the [Remaining build order](phases/phase-2-cli.md#remaining-build-order) queue. See the
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
