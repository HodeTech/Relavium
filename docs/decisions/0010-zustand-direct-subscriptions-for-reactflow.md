# ADR-0010: Zustand direct subscriptions for ReactFlow

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0002-vite-react-tanstack-not-nextjs.md](0002-vite-react-tanstack-not-nextjs.md), [tech-stack.md](../tech-stack.md)

## Context

The signature surface of Relavium is a ReactFlow workflow canvas (see [ADR-0002](0002-vite-react-tanstack-not-nextjs.md)). During a run, that canvas is also a *live* view: per-node status, streaming token previews, and running cost all update many times per second while a workflow executes. Two performance characteristics collide here.

First, canvas interaction: ReactFlow re-renders on every drag tick, and a workflow can have many nodes and edges. Second, run streaming: token chunks and node-status changes arrive continuously over the run-event stream (see the [SSE event schema](../reference/contracts/sse-event-schema.md)). If frontend state is wired naively, both of these trigger an **O(n) re-render cascade** — one node's update re-renders *every* node — and the canvas janks exactly when the user is watching it work. How node/edge/run state is held and subscribed to is therefore a real architectural decision, not an implementation detail.

The earlier analysis surfaced the concrete failure mode and its fix, which remain valid and are the basis for this decision: putting ReactFlow nodes/edges in a React Context and reading them through that context undermines per-node selectors entirely and produces the O(n) drag cascade. The store shapes referenced below are documented canonically in [reference/shared-core/store-shapes.md](../reference/shared-core/store-shapes.md).

## Decision

**ReactFlow node, edge, and run state lives in Zustand stores read through fine-grained, memoized selectors — not in React Context.** Each component subscribes only to the slice of state it actually renders, so an update to one node re-renders that node and nothing else.

Concretely:

- Canvas node/edge/viewport state is held in a Zustand store (with `immer` for ergonomic updates). Components subscribe with narrow selectors; for ReactFlow-internal state, ReactFlow v12's own `useStore(selector)` subscription is used directly. React Context is *not* used for nodes/edges — it is reserved for non-hot-path utilities (save, export, undo/redo history API).
- Live run state is a *separate* store (`runStore`) from the canvas store. Crucially, streaming updates never touch the canvas node/edge arrays: per-node run status is kept in a `nodeRunStatuses` map inside `runStore`, and each custom node reads **only its own entry** via a selector like `useRunNodeStatus(id)`, memoized with a shallow-equality check. A status change for one node thus cannot re-render any other node.

Considered options:

1. **Zustand stores with fine-grained selectors; run status in a separate `runStore` keyed by node id** — surgical re-renders, streaming isolated from canvas geometry. *Chosen.*
2. **React Context holding the nodes/edges arrays** — idiomatic-looking, but any change re-renders every consumer.
3. **One monolithic store with coarse selectors / whole-store subscriptions** — simple, but a streaming token re-renders the entire canvas.

Option 1 wins because it makes the two hot paths — dragging and streaming — independently cheap. Selectors give surgical subscriptions, so drag updates and per-node status updates each touch only the affected component. Separating `runStore` from the canvas store is the key move: it keeps high-frequency streaming churn out of the node/edge geometry that ReactFlow lays out and renders, so a flood of token events never forces a canvas relayout. Context (Option 2) is the documented anti-pattern here — it defeats per-node selectors and reintroduces the O(n) cascade. A single coarse store (Option 3) has the same problem at the subscription level.

This builds on the all-client SPA model of [ADR-0002](0002-vite-react-tanstack-not-nextjs.md): all canvas and run state is in client memory, so fine-grained client subscriptions are the natural and only place to control re-render cost. Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- Surgical re-renders: updating one node (drag or streaming status) re-renders only that node, so the canvas stays smooth even with many nodes and a high-frequency event stream.
- Streaming is structurally isolated from canvas geometry — `runStore` churn never forces a node/edge relayout, because run status lives in a separate store keyed by node id (see [reference/shared-core/store-shapes.md](../reference/shared-core/store-shapes.md)).
- The same Zustand-store-plus-selectors pattern serves every frontend surface ([ADR-0002](0002-vite-react-tanstack-not-nextjs.md)), so canvas state management is consistent across the desktop app and the Phase-2 portal.
- A clear, enforceable rule: nodes/edges/run state go in Zustand with per-slice selectors; Context is only for non-hot-path utilities.

### Negative

- Selectors must be written carefully — an over-broad selector or a missing shallow-equality check silently reintroduces the re-render cascade, so this discipline has to be maintained in review.
- State is split across multiple stores (canvas vs `runStore`), which is more moving parts than one monolithic store; accepted because that very separation is what keeps streaming cheap.
- Developers must resist the idiomatic-React reflex to reach for Context for shared canvas state; this ADR exists to make "do not put nodes/edges in Context" a recorded, principled rule rather than a tribal one.
- Custom node components must be memoized and read minimal state, or React will re-render them on unrelated store changes; mitigated by the per-node selector pattern and documented in [reference/shared-core/store-shapes.md](../reference/shared-core/store-shapes.md).
