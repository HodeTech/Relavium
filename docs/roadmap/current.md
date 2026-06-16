# Current state

> Status: Living

> Last updated: 2026-06-16

- **Related**: [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md), [phases/phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md), [../project-structure.md](../project-structure.md), [../tech-stack.md](../tech-stack.md)

This page tracks what is active **right now** and the immediate next concrete
actions. The full phase plan and the global milestone spine are in
[README.md](README.md); the granular work breakdown for the active phase is in
[phases/phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md).

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
**M2 — engine end-to-end**, now gated **only** by the **1.U** end-to-end Node harness — the rest
of the engine (milestone **1.m4**) completed with the pre-egress budget governor in PR #26 (see the
[milestone spine](README.md#global-milestone-spine)).

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
`LLMProvider` seam — **🎯 M1 achieved**. The **ADR-0031 multimodal seam-shape amendment — 1.AD**
(the `media` `ContentPart` arm + handle-only durable fork, the `media_start/delta/end` `StreamChunk`
triad, the `CapabilityFlags.media` matrix with `vision` as its derived alias, `Usage.mediaUnits`,
`LlmRequest.outputModalities`, and the reserved `generateMedia?`/`pollMediaJob?` methods — **shape
only**, with honest all-false adapter matrices and a fail-fast media guard until 1.AE) — merged in
**PR #11** (2026-06-10), landing the union members **before the seam's exhaustive consumers** exist.
Per the [sequencing plan](phases/phase-1-engine-and-llm.md#sequencing--parallelization), the **seam
policy lane is now complete**: **1.K — `FallbackChain` runner** (retryable/fatal routing on `LlmError`,
per-attempt usage → `CostTracker`, the ADR-0030 strip-the-reasoning-signature-on-failover obligation,
plus the no-blind-auth-retry / rate-limit-cooldown / no-failover-after-first-content-chunk nuances) —
merged in **PR #13** (2026-06-11) as a `FallbackChain` class + `withFallback` façade in `@relavium/llm`,
the seam's last Phase-1 policy layer, **completing 1.m2** with the cost tracker
([ADR-0011](../decisions/0011-internal-llm-abstraction.md),
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md)). *(PR #13 also refreshed the
model-pricing table to current provider models and added Claude Fable 5.)* The active work is now the
**engine lane**: **1.L (`WorkflowYAMLParser`) ✅ Done (PR #14, 2026-06-12)** — `@relavium/core` is
scaffolded with a pure-TypeScript `WorkflowYAMLParser` that parses and validates `.relavium.yaml`
against the reconciled `WorkflowSchema`, with typed, field-named errors (**zero platform imports**)
and a hardened YAML decode profile ([ADR-0035](../decisions/0035-yaml-parser-dependency.md)) — and
**1.L2 (the `{{ … }}` interpolation engine) ✅ Done (PR #15, 2026-06-12)**: the runtime resolver +
pipe-filter registry (`json`/`length`/`default`/host-injected `read_file`) and the **parse-time
transitive secret-taint gate** ([ADR-0029(c)](../decisions/0029-tool-policy-hardening.md)), still
zero platform imports. **1.M (DAG builder + `RunPlan`) and 1.AB (the QuickJS-wasm expression sandbox)
are ✅ Done (PR #16, 2026-06-13)** — the plan layer (a deterministic topological `RunPlan`) and the
deterministic, resource-capped `condition`/`transform`/`merge_fn` evaluator ([ADR-0027](../decisions/0027-expression-sandbox.md)),
both pure-engine (zero platform imports). The engine lane has since landed **1.N (`WorkflowEngine` +
`RunEventBus` — the run loop) and 1.T (the built-in `ToolRegistry`) ✅ Done (PR #17, merged
2026-06-13)** — the serialized, completion-driven scheduler emitting the canonical, gap-free `RunEvent`
stream with the exactly-one-terminal-event invariant (through the in-house platform-free `RunEventBus`
behind the injected `ExecutionHost`/`NodeExecutor` seams), and the SSRF/allowlist/taint-aware tool
registry behind the `ToolHost` seam ([ADR-0036](../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)/[ADR-0037](../decisions/0037-engine-tool-execution-boundary.md)).
**1.N completes milestone 1.m3** (parse → DAG → run loop emits the canonical event stream) — its last
component (1.L.0/1.L/1.L2/1.M/1.N). **1.T is a 1.m4 component** that landed alongside it and is a
separate `AgentRunner` (1.O) join prerequisite — it does **not** close 1.m3. The engine lane has since
landed the **1.O `AgentRunner` join ✅ Done (PR #18, 2026-06-14)** — per-node LLM execution behind the
`@relavium/llm` seam: the host-injected provider-resolution boundary ([ADR-0038](../decisions/0038-agentrunner-llm-call-boundary.md)),
the correlation-agnostic turn core (reused by 1.V), the tool-call loop + classified failure ladder, and
the same-provider signed-reasoning replay ([ADR-0039](../decisions/0039-same-provider-reasoning-replay.md)) —
and the **node-type handlers (1.P) ✅ Done (PR #20, 2026-06-14)**: the six non-agent `NodeExecutor` arms
(condition / transform / fan_out / fan_in / input / output) composed by a `createDispatchingNodeExecutor`
alongside the 1.O agent arm — executor-only, no `engine.ts` change (the run loop already owns readiness,
skip-propagation, fan-in join scheduling, events, cancellation), `wait_first` executor-only (true
loser-cancel deferred), and a pre-merge BLOCKER secret-leak (the `input` handler emitting raw
`secret`-typed inputs into events) fixed via a `secretInputNames` masking gate on `NodeExecContext`.
**Checkpoint/resume (1.R) and the human gate (1.Q) then landed together — ✅ Done (PR #22, 2026-06-15)**:
the derived `Checkpointer` (state folded from the `run_events` log; no checkpoint table — ADR-0003) +
cross-process `resumeFromCheckpoint` (idempotent re-delivery, `workflow_mismatch` identity guard), and the
`human_in_the_loop` gate (suspend → notify → resume, plus the one-shot `setTimer` timeout port — `approve`
auto-resolves, `reject` fails with `run_timeout`). **Node retry (1.S) is ✅ Done (PR #24, 2026-06-15)** — the above-chain whole-node retry budget
([ADR-0040](../decisions/0040-node-retry-budget-above-the-chain.md) Part A: re-dispatch a whole node on a
retryable, `retry_on`-admitted failure up to `retry.max` attempts with abort-aware backoff and the non-terminal
`node:retrying`, `node:failed` staying the single terminal; the user-triggered retry-from-node Part B is
deferred to Phase-2). The last **1.m4** workstream — the **pre-egress budget governor (1.AC)** ([ADR-0028](../decisions/0028-workflow-resource-governance.md):
the `BudgetGovernor` pre-egress cost gate, `on_exceed` warn/fail/pause_for_approval, `budget:warning`/`budget:paused`/`run:timeout`,
the H3 approve-continues bypass, the per-attempt `FallbackChain` enforcement) — and the agent-first **`AgentSession`
(1.V)** entry point ([ADR-0024](../decisions/0024-agent-first-entry-point-agentsession.md): multi-turn
`start`/`sendMessage`/`cancel` over the shared `runAgentTurn` core, the hard turn cap → `turn_limit`, cost +
emission via an injected `SessionEventSink`) **then landed together — ✅ Done (PR #26, 2026-06-16)**. 1.AC closed
**1.m4** (the full engine stack), so the critical path now reaches **1.U — the end-to-end Node harness (the M2
milestone)**, now unblocked; in parallel, **Lane C** (the 1.m5 sub-spine) continues from 1.V at **1.W** (wire the
`SessionEventSink` onto the `RunEventBus` + per-session `sequenceNumber`/`SessionHandle`) and **1.X** (session
persistence), with cost-event persistence still a tracked deferral.

> **Multimodal I/O — the shape is landed (1.AD ✅ Done, PR #11, 2026-06-10).** First-class
> image/audio/video I/O (input **and** output, incl. generate-media-by-rule) was decided on 2026-06-08:
> [ADR-0031](../decisions/0031-llm-seam-shape-amendment-multimodal-io.md) (the seam amendment) +
> [ADR-0032](../decisions/0032-desktop-rust-media-de-inline-amends-0018.md) (desktop Rust-side
> de-inline), from [multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md)
> (nine maintainer decisions A1–A9), as the **1.AD–1.AH** sub-spine (1.m6,
> [phase-1](phases/phase-1-engine-and-llm.md)). **1.AD landed the seam shape before the exhaustive
> consumers 1.K/1.O** (the same cheap-window move as ADR-0030), so the media union members are
> non-breaking; the seam doc carries the full amendment section. **1.AE–1.AH (media
> input/engine/output + surfaces) are additive and do NOT gate M2** — the seam lane ran straight to
> **1.K** (✅ Done, PR #13), which closed it.

> **Review-pass follow-ups landed (PR #12, merged 2026-06-11).** The 2026-06-10 engine/tooling
> review pass landed as docs/decisions only — no Phase-1 workstream changed: **MCP client scheduling**
> ([ADR-0034](../decisions/0034-mcp-client-sdk-dependency.md) pins the official TypeScript MCP SDK and
> binds the inbound client to **workstream 2.R** at the start of [build phase 2](phases/phase-2-cli.md),
> off the M3 critical path); the **`turn_limit` `ErrorCode`** (a hard session turn cap, distinct from
> the `[chat].max_messages` trim threshold); the **reserved `on_error` edge kind**
> (workflow-yaml-spec.md, not authorable in v1.0); and a CI **engine dependency-allowlist guard** + the
> pnpm install-script allowlist. No Phase-1 work changed; **1.K has since landed (PR #13)**, and
> **1.L has since landed (PR #14, 2026-06-12)** and **1.L2 (the `{{ … }}` interpolation engine + the
> parse-time secret-taint gate) is ✅ Done (PR #15, merged 2026-06-12)**; **1.M (DAG builder +
> `RunPlan`) and 1.AB (the expression sandbox) have since landed (PR #16, merged 2026-06-13)**; and
> **1.N (`WorkflowEngine` + `RunEventBus`) and 1.T (the built-in `ToolRegistry`) are ✅ Done (PR #17,
> merged 2026-06-13)** — **1.N closes 1.m3** (its last component); **1.T** (a 1.m4 component) is the
> other 1.O join prerequisite; **the `AgentRunner` join (1.O) is ✅ Done (PR #18, 2026-06-14)**; and the
> **node-type handlers (1.P) are ✅ Done (PR #20, 2026-06-14)**; **checkpoint/resume (1.R) + the
> human gate (1.Q) are ✅ Done (PR #22, 2026-06-15)**; and **node retry (1.S) is ✅ Done (PR #24, 2026-06-15)**
> (ADR-0040 Part A; the user-triggered retry-from-node Part B is deferred to Phase-2); and the **pre-egress budget
> governor (1.AC) + the `AgentSession` (1.V) entry point are ✅ Done (PR #26, 2026-06-16)** — 1.AC closed **1.m4**.
> The next workstream is **1.U** (the end-to-end Node harness, the M2 milestone), with Lane C continuing at 1.W/1.X.

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
