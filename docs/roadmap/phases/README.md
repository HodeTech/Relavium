# Roadmap — Phases

> Status: Living

One file per **build phase**. Each is a self-contained unit of work — an H1, a
`> Status:` line, a goal, scope (in / explicitly out), an ordered work breakdown
with per-workstream acceptance, in-phase milestones, dependencies, an exit gate,
and risks.

This index only **maps** the phase files; it never restates them. The central
roadmap — the phase dependency graph, the global milestone spine, the critical
path, and the cross-phase invariants — and the canonical **product-phase vs
build-phase** disambiguation live one level up in
[../README.md](../README.md). What is active *right now* is in
[../current.md](../current.md).

A phase begins only when the prior phase's exit gate passes; milestones are
phase-relative, never calendar dates.

| Build phase | File | Product phase | Goal |
|-------------|------|---------------|------|
| 0 | [phase-0-foundations.md](phase-0-foundations.md) | Phase 1 | Turborepo + pnpm monorepo, tooling, CI, and the `@relavium/shared` Zod schemas — the foundation every package builds on. |
| 1 | [phase-1-engine-and-llm.md](phase-1-engine-and-llm.md) | Phase 1 | The pure-TS engine (`@relavium/core`) and `@relavium/llm` — YAML→DAG parse, run loop, checkpoint/resume, retry, the provider seam + adapters. The most important phase. |
| 2 | [phase-2-cli.md](phase-2-cli.md) | Phase 1 | The terminal CLI (`relavium`) — the engine's first real consumer and its regression harness, proving the engine end-to-end before any UI. |
| 3 | [phase-3-desktop.md](phase-3-desktop.md) | Phase 1 | The Tauri v2 desktop **agent-management center** — canvas, run monitoring, keychain, Rust-delegated LLM egress (not an IDE). |
| 4 | [phase-4-vscode.md](phase-4-vscode.md) | Phase 1 | The standalone VS Code extension — inline triggering and gate handling, bundling the engine in-process. |
| 5 | [phase-5-managed-inference.md](phase-5-managed-inference.md) | **Phase 2** | Managed inference — the revenue beachhead: a thin metered gateway where the engine stays local and only LLM egress is proxied. Ships ahead of cloud execution. |
| 6 | [phase-6-cloud-execution-portal.md](phase-6-cloud-execution-portal.md) | **Phase 2** | Cloud execution workers running the engine server-side, the control-plane web portal, and team/RBAC/enterprise. |

Part of [roadmap/](../README.md).
