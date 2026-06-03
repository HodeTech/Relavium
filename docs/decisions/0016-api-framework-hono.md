# ADR-0016: Hono as the `apps/api` framework

- **Status**: Accepted
- **Date**: 2026-06-04
- **Related**: [0017-cloud-runtime-bun.md](0017-cloud-runtime-bun.md), [0008-local-first-phase-1-cloud-phase-2.md](0008-local-first-phase-1-cloud-phase-2.md), [0012-managed-inference-dual-mode.md](0012-managed-inference-dual-mode.md), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0005-sqlite-drizzle-local-postgres-cloud.md](0005-sqlite-drizzle-local-postgres-cloud.md), [../analysis/managed-inference-business-model-2026-06-03.md](../analysis/managed-inference-business-model-2026-06-03.md), [../tech-stack.md](../tech-stack.md), [../project-structure.md](../project-structure.md)

## Context

Product Phase 2 introduces a server-side HTTP layer (`apps/api`) for the two Phase-2 deliverables — the managed-inference gateway (build phase 5, [ADR-0012](0012-managed-inference-dual-mode.md)) and cloud execution + portal (build phase 6, [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)). This layer terminates HTTP, authenticates requests, streams SSE/run-events, and wraps `@relavium/core` with BullMQ dispatch and Postgres-via-Drizzle ([ADR-0005](0005-sqlite-drizzle-local-postgres-cloud.md), [project-structure.md](../project-structure.md)). It already appears as "Hono on Bun" in the architecture diagrams, but no decision record exists; per the engineering principle that **a new runtime dependency requires an ADR**, this records it.

The constraints: the API must stream LLM tokens and run-events (SSE) without buffering, stay lightweight (the managed gateway is deliberately a *thin* proxy, not a heavyweight app server — [business-model analysis §4](../analysis/managed-inference-business-model-2026-06-03.md)), and run on **Bun** ([ADR-0017](0017-cloud-runtime-bun.md)) while remaining portable to Node for tests/CI. It also must add **no heavy framework conventions** that leak into `@relavium/core`, which stays platform-free ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)).

## Decision

**`apps/api` uses Hono as its HTTP framework.** Hono is a small, dependency-light router built on the **web-standard `Request`/`Response`** primitives, with first-class streaming, and it runs unchanged on Bun, Node, and edge runtimes.

- **Web-standard `Request`/`Response`.** Handlers speak the standard Fetch types, so the same code runs on Bun (the [ADR-0017](0017-cloud-runtime-bun.md) target) and on Node for tests/CI without a runtime-specific server shim — matching the engine's "runs identically everywhere" property.
- **Streaming-first.** Hono's streaming helpers carry SSE/run-events and LLM token streams without buffering — the load-bearing requirement for the gateway and the portal's live run view ([sse-event-schema.md](../reference/contracts/sse-event-schema.md)).
- **Lightweight, owns nothing the engine owns.** Hono is routing + middleware only; it wraps `@relavium/core` and never reaches into it, keeping the engine framework-agnostic ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md)).

Considered options:

1. **Express** — *rejected.* Node-`http`-coupled (not web-standard `Request`/`Response`), weaker first-class streaming, heavier middleware ecosystem than this thin layer needs; does not run web-standard-portably on Bun/edge.
2. **Fastify** — *rejected.* Capable and fast, but Node-stream-centric and schema/plugin-heavy for what is mostly a streaming proxy + a handful of control-plane routes; more surface than the thin gateway warrants.
3. **Elysia** — *rejected.* Excellent on Bun, but **Bun-first** in a way that weakens the Node portability we want for tests/CI and keeps options open if [ADR-0017](0017-cloud-runtime-bun.md) is ever revisited.
4. **Hono** — *chosen.* Smallest viable surface, web-standard primitives, strong streaming, and runtime-portable across Bun and Node.

This is a **Phase-2-only** dependency on the cloud/managed surface; it does not touch the BYOK-local Phase-1 stack. Pinned version lives in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Web-standard `Request`/`Response` keep `apps/api` portable across Bun and Node, so the API is testable on Node in CI even though it ships on Bun ([ADR-0017](0017-cloud-runtime-bun.md)).
- First-class streaming carries SSE/run-events and LLM tokens without buffering — exactly what the gateway and portal need.
- A small, dependency-light framework keeps the thin gateway thin and adds minimal attack/maintenance surface, consistent with the minimal-third-party-deps principle.
- Hono wraps `@relavium/core` without coupling to it, preserving the one-engine-no-fork and platform-free-engine invariants ([ADR-0003](0003-pure-ts-engine-not-langgraph-python.md), [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)).

### Negative

- A smaller ecosystem than Express/Fastify: some middleware (auth, rate-limit, observability) may need adapting or hand-rolling rather than dropping in.
- Hono and Bun are co-adopted ([ADR-0017](0017-cloud-runtime-bun.md)); the web-standard-`Request`/`Response` discipline must be held so the API does not accidentally take a Bun- or Node-only dependency and lose portability.
- Another framework for contributors to learn, though its surface is deliberately small; mitigated by confining it to `apps/api` (it never appears in the engine or surfaces).
