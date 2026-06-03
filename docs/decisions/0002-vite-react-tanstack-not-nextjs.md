# ADR-0002: Vite + React 19 + TanStack Router, not Next.js

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0001-tauri-v2-over-electron.md](0001-tauri-v2-over-electron.md), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md), [0010-zustand-direct-subscriptions-for-reactflow.md](0010-zustand-direct-subscriptions-for-reactflow.md), [tech-stack.md](../tech-stack.md)

## Context

Every Relavium frontend surface — the Tauri desktop app today (see [ADR-0001](0001-tauri-v2-over-electron.md)) and the Phase-2 web portal later (see [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)) — is a canvas-heavy, realtime-streaming, client-centric application. The dominant UI is a ReactFlow workflow canvas whose entire model (nodes, edges, viewport, selection) lives in client memory, and a live run view that consumes a long-lived stream of run events (token chunks, node status, cost updates) defined by the [SSE event schema](../reference/contracts/sse-event-schema.md).

This is the opposite of a content or SEO-driven site. There are roughly 8 routes total (see [reference/desktop/routes-and-screens.md](../reference/desktop/routes-and-screens.md)), no public pages, and nothing meaningful renders before authentication/setup. The choice of React framework determines whether the streaming and canvas models are natural or fought against.

## Decision

**We use Vite + React 19 + TanStack Router**, building each surface as a single-page application. We do **not** use Next.js (nor Remix or any other SSR/RSC framework).

Considered options:

1. **Vite + React 19 SPA + TanStack Router** — all-client, no server runtime, typed routing. *Chosen.*
2. **Next.js (App Router, RSC)** — server-first React with file-system routing and edge runtime.
3. **Remix** — loader-based SSR React.

The SPA is the clear winner for three structural reasons:

- **Streaming.** Run events arrive over a persistent stream that must be opened on the client and kept alive across navigation (see the [SSE event schema](../reference/contracts/sse-event-schema.md)). RSC re-renders on route changes interfere with persistent connections, and Next.js's own streaming model (Suspense + fetch streaming) is a different mechanism from event-stream-based agent token streaming. A pure SPA holds one long-lived connection per run with no server teardown. In the Tauri shell these events arrive over a Tauri channel rather than HTTP, which has no server tier at all.
- **Canvas state.** ReactFlow requires all node/edge/viewport state in client memory with zero server round-trips. RSC forces a hard server/client split: every node, hook, and store would need explicit `'use client'`, adding friction and hydration-mismatch risk for zero benefit. A Vite SPA is natively all-client.
- **Routing is trivial.** With ~8 routes, no SEO, and no pre-rendering, Next.js's App Router power adds complexity (server/client boundary bugs, edge-runtime limits for long-lived connections, opaque build output) with no upside. TanStack Router gives explicit, type-safe routes without it.

Crucially, Next.js's edge/RSC runtime is also a poor host for the multi-LLM streaming layer chosen in [ADR-0011](0011-internal-llm-abstraction.md): in Phase 1 there is no server at all (the engine runs locally per [ADR-0008](0008-local-first-phase-1-cloud-phase-2.md)), so an SSR framework would be dead weight. Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- One long-lived stream per run with no SSR teardown, and a canvas that is all-client by default — the two hardest UI requirements become natural rather than fought.
- The same Vite + React 19 + TanStack Router stack serves the Tauri WebView and the Phase-2 portal, so UI components and patterns are shared across surfaces.
- No server/client boundary to reason about, no `'use client'` annotations, no hydration mismatches on complex canvas state.
- Sub-100 ms HMR and a tree-shaken bundle; the WebView (see [ADR-0001](0001-tauri-v2-over-electron.md)) loads a plain SPA with no framework runtime assumptions.
- A clean break from the historical Next.js-based framing; the SPA boundary is uniform across local and (Phase 2) cloud modes.

### Negative

- No built-in SSR means the initial HTML is a blank shell — acceptable, because no surface renders meaningful content before setup/auth, so SSR/SEO has zero value here.
- Code-splitting is manual via `React.lazy`; mitigated by route-level lazy loading, which Vite's Rollup config handles cleanly.
- No file-system routing; TanStack Router's typed, explicit routes are the deliberate replacement, and with ~8 routes the overhead is negligible.
- In Phase 2, the portal's API must be a separately deployed, CORS-configured service rather than colocated Next.js route handlers; this is an explicit Phase-2 concern, called out in [architecture/cloud-phase-2.md](../architecture/cloud-phase-2.md).
