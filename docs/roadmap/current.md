# Current state

> Status: Living

> Last updated: 2026-06-08

- **Related**: [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md), [phases/phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md), [../project-structure.md](../project-structure.md), [../tech-stack.md](../tech-stack.md)

This page tracks what is active **right now** and the immediate next concrete
actions. The full phase plan and the global milestone spine are in
[README.md](README.md); the granular work breakdown for the active phase is in
[phases/phase-0-foundations.md](phases/phase-0-foundations.md).

## Where we are

**Phase 0 — Foundations is complete: all workstreams 0.A–0.I landed and merged (PR #1–#3,
2026-06-04), achieving global milestone M0.** The repository
(`github.com/HodeTech/Relavium`) holds the `docs/` tree **plus** the Turborepo + pnpm
workspace, the strict `tsconfig` bases, the root ESLint/Prettier/Vitest spine,
`@relavium/shared` with the **full Zod schema set** (123 tests, reference round-trip with no
drift, authored YAML `.strict()`, run-event names pinned), the no-vendor-type **seam fence**
(live across 9 import syntaxes, TS + JS, self-checking), **GitHub Actions CI**
(lint/typecheck/test/build + format + a schema↔migration drift gate, SHA-pinned actions),
and **`@relavium/db`** (the Drizzle schema + `drizzle-kit` migrations + a `better-sqlite3`
client, 10 tests). `pnpm install && pnpm turbo run lint typecheck test build` is green,
`format:check` is clean, and CI is green on push. Confirmed-but-deferred review findings are
parked in [deferred-tasks.md](deferred-tasks.md). The foundation is settled and recorded:

- Product vision, UVP, and hard constraints (desktop is agent-management, not an
  IDE; local-first Product Phase 1; git-native workflow YAML).
- The full architecture set (overview, shared core engine, execution model, state
  management, local-first security, desktop architecture, multi-LLM providers, key
  management, the Phase-2 cloud design, and the Phase-2 managed-inference design).
- The canonical reference contracts (workflow/agent YAML specs, the SSE/run-event
  schema, the IPC contract, config, database schema, CLI commands, the VS Code
  extension API).
- The numbered ADRs, including the settled multi-LLM decision: an **internal
  Relavium-owned `@relavium/llm` abstraction** with a single provider-agnostic
  `LLMProvider` seam and thin hand-rolled adapters over the official provider SDKs —
  **not** the Vercel AI SDK, **not** LangChain
  ([ADR-0011](../decisions/0011-internal-llm-abstraction.md), superseding
  [ADR-0004](../decisions/0004-vercel-ai-sdk-multi-llm.md)) — and the **dual-mode
  managed-inference decision (Option B)**: BYOK-local stays first-class and unchanged,
  while managed inference is added as an opt-in `managed` mode shipped as the **first**
  Phase-2 deliverable, decoupled from and ahead of cloud execution
  ([ADR-0012](../decisions/0012-managed-inference-dual-mode.md), with
  [ADR-0013](../decisions/0013-managed-key-vault-and-pools.md)/[0014](../decisions/0014-managed-metering-quota-and-billing.md)/[0015](../decisions/0015-managed-mode-data-handling-and-compliance.md)).
  Later ADRs pin the Phase-2 API stack ([ADR-0016](../decisions/0016-api-framework-hono.md) Hono,
  [ADR-0017](../decisions/0017-cloud-runtime-bun.md) Bun), the **desktop execution model**
  ([ADR-0018](../decisions/0018-desktop-execution-and-rust-egress.md) — engine in the WebView,
  Rust-delegated LLM egress), and the CLI's Node-side keychain library
  ([ADR-0019](../decisions/0019-cli-node-keychain-library.md) — `@napi-rs/keyring`, not the
  archived `keytar`).
- The full seven-phase roadmap: the [phase index](README.md#phase-index), the
  [global milestone spine](README.md#global-milestone-spine) (M0–M7), and the
  [cross-phase invariants](README.md#cross-phase-invariants). Per Option B, Product
  Phase 2 is split into **build phase 5 (managed inference)** and **build phase 6
  (cloud execution + portal)**.

## What is active now

> **Agent-first pivot (2026-06-05).** Relavium has pivoted from workflow-first to **agent-first +
> workflow**: a conversational `AgentSession` becomes a first-class engine entry point alongside
> `WorkflowEngine`, with a chat → workflow export
> ([ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md) /
> [0025](../decisions/0025-agent-surface-refines-desktop-scope.md) /
> [0026](../decisions/0026-session-export-to-workflow.md)). A workflow-system hardening pass adds three
> security/robustness ADRs ([0027](../decisions/0027-expression-sandbox.md) expression sandbox,
> [0028](../decisions/0028-workflow-resource-governance.md) resource governance,
> [0029](../decisions/0029-tool-policy-hardening.md) tool-policy). Phase 1 gains an **additive, parallel**
> agent-first sub-spine (1.V–1.AA), the QuickJS-wasm sandbox (1.AB — on the critical path inside 1.P),
> and the pre-egress budget governor (1.AC). The **agent-first sub-spine (1.V–1.AA) adds no work to the M1/M2 critical path** (it runs in parallel and is proven by its own harness); the hardening sandbox **1.AB *is* new M2-critical-path work** — it folds into 1.P and raises the 1.m4 cost. Phases 2–4 add
> non-critical chat workstreams; phases 5–6 are largely unaffected (sessions inherit managed/cloud via
> the existing seams). All decisions/specs are landed at the docs/ADR layer. **Phase 1 has begun:**
> 1.L.0 — the `@relavium/shared` reconciliation to these agent-first + hardening contracts (the new
> events, `ErrorCode`/`StopReason`, the authored budget/validation/output_schema fields, the `[chat]`
> config) — merged in **PR #6** (2026-06-05). No engine code yet; the seam + parser come next.

**Phase 0 is done (M0 reached); the active phase is now
[Phase 1 — engine and LLM](phases/phase-1-engine-and-llm.md)** (Product Phase 1, the
critical path). With a frozen contract and a green CI gate in place, Phase 1 builds the two
core packages: **`@relavium/llm`** (the `LLMProvider` seam + thin hand-rolled adapters over
the official provider SDKs — the seam fence's first real consumer) and **`@relavium/core`**
(the engine: YAML→DAG parse, runner, checkpoint/resume, retry — zero platform imports,
consuming `@relavium/db` for run persistence).

Global milestone **M1 — LLM seam proven** is reached (PR #9, 2026-06-07): all three
adapters pass the shared conformance suite behind the frozen seam. The next checkpoint is
**M2 — engine end-to-end** (see the [milestone spine](README.md#global-milestone-spine)).

> **One Phase-0 follow-up lives outside the code:** a maintainer should mark the CI `ci`
> job a **required check** in GitHub branch protection (optionally adding `TURBO_TOKEN`/
> `TURBO_TEAM` secrets for the cross-runner remote cache).

## Immediate next steps

Phase 1 is underway and **M1 (LLM seam proven) is reached**. **Wave 0 — 1.L.0** (`@relavium/shared`
reconciliation) merged in **PR #6**; the **Wave-1 seam trio — 1.A** (seam types), **1.B** (CostTracker
+ pricing), **1.E** (ToolNormalizer) — merged in **PR #7**; the first **adapter lane — 1.C**
(`AnthropicAdapter`), **1.I** (`LlmError` classification), **1.F** (conformance harness), **1.D**
(capabilities + `providerOptions`) — merged in **PR #8** (2026-06-06); and the **remaining adapters +
seam amendment — 1.G** (OpenAI/DeepSeek) ‖ **1.H** (Gemini), the **ADR-0030** seam-shape amendment
(reasoning channel + `responseFormat` + `providerExecuted`), and **1.J** (conformance green) — merged
in **PR #9** (2026-06-07). All three adapters now pass the shared conformance spec in fixture mode
(live nightly reserved, pending keys), with classified errors and capability gating, behind the frozen
`LLMProvider` seam — **🎯 M1 achieved**. Per the
[sequencing plan](phases/phase-1-engine-and-llm.md#sequencing--parallelization), the next work runs
two parallel lanes:

1. **Seam policy lane** — **1.K — `FallbackChain` runner** (retryable/fatal routing on `LlmError`,
   per-attempt usage → `CostTracker`, and the ADR-0030 strip-the-reasoning-signature-on-failover
   obligation) — the seam's last Phase-1 policy layer, completing **1.m2** with the cost tracker
   ([ADR-0011](../decisions/0011-internal-llm-abstraction.md),
   [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md)).
2. **Engine lane** — **1.L — `WorkflowYAMLParser`** *(critical path)* — scaffold `packages/core` and
   parse+validate a `.relavium.yaml` against the reconciled `WorkflowSchema`, with typed,
   field-named errors (**zero platform imports**), then 1.L → 1.L2 → 1.M → 1.N → 1.R, converging at the
   **1.O join** (which waits on the fallback runner, 1.K) toward **M2**.

> **Multimodal I/O decided (2026-06-08) — a second pre-freeze seam amendment.** First-class
> image/audio/video I/O (input **and** output, incl. generate-media-by-rule) is now designed and decided:
> [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) (the seam amendment) +
> [ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md) (desktop Rust-side
> de-inline), from [multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md)
> (nine maintainer decisions A1–A9). It adds the **1.AD–1.AH** sub-spine (1.m6,
> [phase-1](phases/phase-1-engine-and-llm.md)): **1.AD lands the seam shape NOW — before the exhaustive
> consumers 1.K/1.O** so the `ContentPart`/`StreamChunk` media union members are non-breaking (the same
> cheap-window move as ADR-0030); **1.AE–1.AH (media input/engine/output + surfaces) are additive and do
> NOT gate M2.** So the immediate seam-lane work is **1.AD → then 1.K**, both before the 1.O join.

Carry-over hardening is tracked in [deferred-tasks.md](deferred-tasks.md) — pick items up as Phase 1
first touches each file.

## Not started yet

The surfaces and the cloud — everything after the engine critical path: the CLI, the
desktop app, and the VS Code extension (Phases 2–4), then **Product Phase 2** — first
**managed inference** ([phase-5-managed-inference.md](phases/phase-5-managed-inference.md),
the opt-in `managed` gateway, engine still local), then the **cloud execution layer and web
portal** ([phase-6-cloud-execution-portal.md](phases/phase-6-cloud-execution-portal.md)),
the two decoupled per Option B. See the [phase index](README.md#phase-index) and the
[milestone spine](README.md#global-milestone-spine) (M3 onward).
