# Current state

> Status: Living

> Last updated: 2026-06-03

- **Related**: [README.md](README.md), [phases/phase-0-foundations.md](phases/phase-0-foundations.md), [phases/phase-1-engine-and-llm.md](phases/phase-1-engine-and-llm.md), [../project-structure.md](../project-structure.md), [../tech-stack.md](../tech-stack.md)

This page tracks what is active **right now** and the immediate next concrete
actions. The full phase plan and the global milestone spine are in
[README.md](README.md); the granular work breakdown for the active phase is in
[phases/phase-0-foundations.md](phases/phase-0-foundations.md).

## Where we are

**Documentation and design: complete. No code written yet.** The repository
(`github.com/HodeTech/Relavium`) holds the `docs/` tree only. The foundation is
settled and recorded:

- Product vision, UVP, and hard constraints (desktop is agent-management, not an
  IDE; local-first Product Phase 1; git-native workflow YAML).
- The full architecture set (overview, shared core engine, execution model, state
  management, local-first security, desktop architecture, multi-LLM providers, the
  Phase-2 cloud design, and the Phase-2 managed-inference design).
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
- The full seven-phase roadmap: the [phase index](README.md#phase-index), the
  [global milestone spine](README.md#global-milestone-spine) (M0–M7), and the
  [cross-phase invariants](README.md#cross-phase-invariants). Per Option B, Product
  Phase 2 is split into **build phase 5 (managed inference)** and **build phase 6
  (cloud execution + portal)**.

## What is active now

The project is at the **start of build-order step 1: scaffolding the monorepo.**
This is **[Phase 0 — foundations](phases/phase-0-foundations.md)** (Product Phase 1).
Phase 0 ships **types and tooling, not features**; its job is to make
[Phase 1 — the engine critical path](phases/phase-1-engine-and-llm.md) safe to start
against a frozen contract and a green CI gate. Until Phase 0's
[exit criteria](phases/phase-0-foundations.md#exit-criteria-go--no-go) pass, no
engine or surface code begins.

The next checkpoint is global milestone **M0 — Foundations green** (see the
[milestone spine](README.md#global-milestone-spine)).

## Immediate next steps

The first workstreams of Phase 0, in order. `0.A → 0.B → 0.C → 0.D` are sequential
(each needs the prior); `0.E` is the critical-path schema work that feeds M0. Full
task lists and acceptance criteria are in
[phase-0-foundations.md](phases/phase-0-foundations.md#work-breakdown).

1. **[0.A] Scaffold the Turborepo + pnpm workspace** per
   [../project-structure.md](../project-structure.md): a `private` root
   `package.json` (tooling only) with a pinned `packageManager`, `pnpm-workspace.yaml`
   declaring `packages/*` + `apps/*`, `turbo.json` with `build/lint/typecheck/test`
   pipelines, `.npmrc`, Node/pnpm pins, and the `packages/{shared,llm,core,db,ui}` +
   `apps/{cli,desktop,vscode-extension}` directory skeleton — building out **only
   `packages/shared`** now and leaving the rest as minimal placeholders.
   *Done when:* `pnpm install` succeeds from a clean checkout and the workspace graph
   resolves with no peer-dep errors.

2. **[0.B] Add the shared strict `tsconfig` bases.** A root `tsconfig.base.json`
   with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`, and
   `moduleResolution: "bundler"` that every package extends and none loosens without
   a justified comment ([code-style-typescript.md](../standards/code-style-typescript.md)).
   *Done when:* `pnpm turbo run typecheck` is green and deleting a strict flag in a
   package produces a real type error.

3. **[0.C] Wire the tooling spine once at the root.** A single ESLint flat config
   (`no-explicit-any` as an **error**, `no-floating-promises`, plus the import-zone
   plugin used by 0.F), root Prettier, and a workspace-aware Vitest config with
   branch coverage — all wired into `turbo.json`.
   *Done when:* `pnpm turbo run lint typecheck test` is green on the scaffold and an
   introduced `any` or floating promise fails lint.

4. **[0.D → 0.E] Land `packages/shared` (`@relavium/shared`) — the source of truth.**
   Scaffold the package with **zod as the only runtime dependency**, then author the
   Zod schemas straight from the frozen reference contracts: `WorkflowSchema`,
   `AgentSchema`, `NodeSchema`, `EdgeSchema`, `RunSchema`, the **`RunEvent` union**
   with the `BaseEvent` envelope, and `CostUpdatedEvent` / `HumanGateEvent`. Align
   every event name to the canonical **colon-namespaced** schema
   (`node:started`, `agent:token`, `cost:updated`, …) with `sequenceNumber` — never
   the legacy dotted names, never `seqNo`
   ([sse-event-schema.md](../reference/contracts/sse-event-schema.md)). Add Vitest
   accept/reject suites plus a round-trip test of the reference workflow/agent YAML
   and a type-level + runtime test pinning the event names and the `cost:updated`
   shape. **This is the critical-path schema half of M0.**
   *Done when:* all schema tests pass, the reference YAML round-trips with no drift,
   and the event names + `cost:updated` payload are pinned by test.

5. **[0.F → 0.H] Close out the gate: seam fence, CI, and docs.** Scaffold the
   no-vendor-type-across-the-seam ESLint zone (with a quarantined forbidden-import
   fixture proving it actively fails), stand up the GitHub Actions CI that runs
   `pnpm turbo run lint typecheck test` on every push/PR with the Turborepo remote
   cache, and confirm the `docs/` tree ships in-repo with resolving links and the
   binding standards enforced.
   *Done when:* CI is green on push, the seam fence is demonstrably live, and the
   [Phase 0 exit criteria](phases/phase-0-foundations.md#exit-criteria-go--no-go) all
   pass — achieving **M0**. Then update this page and move work to
   [Phase 1 — engine and LLM](phases/phase-1-engine-and-llm.md).

## Not started yet

Everything from Phase 1 onward: `@relavium/llm`, `@relavium/core`, the CLI, the
desktop app, the VS Code extension, and **Product Phase 2** — first **managed
inference** ([phase-5-managed-inference.md](phases/phase-5-managed-inference.md), the
opt-in `managed` gateway, engine still local), then the **cloud execution layer and
web portal** ([phase-6-cloud-execution-portal.md](phases/phase-6-cloud-execution-portal.md)),
the two decoupled per Option B. See the [phase index](README.md#phase-index) and the
[milestone spine](README.md#global-milestone-spine) (M1 onward).
