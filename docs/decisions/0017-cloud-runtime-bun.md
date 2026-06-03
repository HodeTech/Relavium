# ADR-0017: Bun as the `apps/api` runtime

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [0016-api-framework-hono.md](0016-api-framework-hono.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0012-managed-inference-dual-mode.md](0012-managed-inference-dual-mode.md), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md), [../project-structure.md](../project-structure.md)

## Context

The Phase-2 `apps/api` server ([ADR-0016](0016-api-framework-hono.md)) needs a JavaScript runtime. It hosts the managed-inference gateway (build phase 5, [ADR-0012](0012-managed-inference-dual-mode.md)) and the cloud execution + portal backend (build phase 6, [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)): a streaming HTTP proxy/SSE layer wrapping `@relavium/core` with BullMQ + Postgres-via-Drizzle ([project-structure.md](../project-structure.md)). The diagrams already say "Hono on Bun", but a runtime is a new runtime dependency and the engineering principles require an ADR for it; this records the choice and its load-bearing constraint.

The hard constraint comes from the cross-phase invariants and [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md): `@relavium/core` (and `@relavium/llm`) have **zero platform-specific imports** and must run **identically** in Node, the Tauri WebView, the VS Code extension host, the Node.js CLI, **and** the Phase-2 Bun API. The whole one-engine-no-fork model depends on the engine never taking a host-specific dependency — so adopting Bun is only safe if that guarantee continues to hold on Bun.

## Decision

**`apps/api` runs on Bun.** Bun is the deployment runtime for the Phase-2 API/gateway; the engine stays runtime-neutral and Bun-specific code is confined to the `apps/api` host boundary.

- **Bun for the API host only.** Bun provides the HTTP server, fast startup, native TypeScript execution, and a built-in test runner for `apps/api`; it pairs with Hono's web-standard handlers ([ADR-0016](0016-api-framework-hono.md)).
- **The engine's platform-free guarantee MUST hold on Bun.** `@relavium/core` and `@relavium/llm` keep their **zero platform-specific imports** ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)) — the *same* TypeScript that runs in Node/WebView/extension host runs on Bun, with **no Bun-only APIs in `packages/core`** (or `packages/llm`). Bun-specific calls live only in `apps/api`. This is enforced as a CI check: the engine packages are exercised on both Node and Bun and must behave identically.
- **Node stays a first-class target for the engine.** Bun is the API *deployment* runtime, not an engine requirement; the engine still runs on Node (CLI, tests/CI) unchanged. Hono's web-standard `Request`/`Response` keep `apps/api` itself runnable on Node where needed ([ADR-0016](0016-api-framework-hono.md)).

Considered options:

1. **Node.js for `apps/api`** — *viable, not chosen.* The safe default and the engine's other host; kept as the portability backstop and the engine's CI target. Bun was chosen for the API for faster cold starts and native TS/test ergonomics on the new server, while the engine remains Node-compatible so nothing is lost.
2. **Bun for `apps/api`, engine stays platform-free** — *chosen.* Captures Bun's server ergonomics at the host boundary **without** letting any Bun-only API leak into `packages/core`/`packages/llm`, so the one-engine-no-fork invariant survives.

This is a **Phase-2-only** runtime on the cloud/managed surface; it does not touch BYOK-local Phase 1. The pinned Bun version lives in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Fast cold starts, native TypeScript, and a built-in test runner suit a thin streaming gateway and keep the managed proxy lightweight ([business-model analysis §4](../analysis/managed-inference-business-model-2026-06-03.md)).
- Confining Bun to `apps/api` keeps `@relavium/core`/`@relavium/llm` runtime-neutral, so the engine still runs identically across Node, WebView, extension host, CLI, and Bun — the one-engine-no-fork invariant holds ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md), [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)).
- Pairs cleanly with Hono's web-standard handlers ([ADR-0016](0016-api-framework-hono.md)), and Node remains a fallback for `apps/api` if needed.

### Negative

- A second JS runtime in the toolchain (Node for Phase-1 surfaces/CLI, Bun for the Phase-2 API) — more to install, pin, and reason about in CI.
- The "no Bun-only APIs in the engine" rule is a live discipline, not a one-time choice: it must be **CI-enforced** (engine packages run green on both Node and Bun) or platform-specific imports could silently creep in and break the cross-host guarantee.
- Bun is younger than Node; an ecosystem/compatibility gap on the server is possible, mitigated by Hono's web-standard portability and Node remaining a first-class fallback for `apps/api`.
