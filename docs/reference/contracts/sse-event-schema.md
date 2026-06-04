# Run Event Schema

- **Status**: Stable
- **Canonical type**: `RunEvent` (discriminated union) in `@relavium/core` / re-exported from `@relavium/shared`
- **Transport**: Phase 1 — in-process `RunEventBus` (the engine runs in-process on **every** surface, including the desktop WebView). Phase 2 — HTTP `text/event-stream` (SSE) from the cloud API.
- **Related**: [ipc-contract.md](ipc-contract.md), [workflow-yaml-spec.md](workflow-yaml-spec.md), [../shared-core/store-shapes.md](../shared-core/store-shapes.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md) (canonical `costMicrocents` unit + the `cost:updated` figures), [../../architecture/execution-model.md](../../architecture/execution-model.md), [../../architecture/state-management.md](../../architecture/state-management.md), [ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)

Every workflow run produces a single ordered stream of `RunEvent` objects. This stream is the **one contract** that all surfaces consume to render live progress — streaming tokens on a node face, per-node status rings, cost waterfalls, and human-gate prompts. The events are emitted by `@relavium/core` and are identical regardless of where the engine runs.

The **transport** differs by surface and phase, but the **event shape does not**:

```mermaid
flowchart LR
  E["@relavium/core\nRunEventBus\n(runs in-process on every surface)"] -->|in-process, WebView-side| D[Desktop WebView stores]
  E -->|in-process EventEmitter| C[CLI ink renderer]
  E -->|in-process EventEmitter| V[VS Code extension host]
  E -. Phase 2 .->|HTTP SSE| P[Cloud Portal]
```

On the desktop the engine runs in the WebView's JS runtime ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), so its `RunEventBus` and the consuming stores share one runtime — most run events **never cross IPC**. The only Rust→WebView channel on the LLM hot path is the delegated egress's `Channel<StreamChunk>` (the WebView adapter folds those chunks into `agent:token` run events locally); see [ipc-contract.md](ipc-contract.md#run-events-are-webview-side). The cross-surface `RunEvent` union below is the same one HTTP SSE carries in Phase 2.

## Event envelope

Every event extends a common base:

```ts
interface BaseEvent {
  type: string;             // discriminator (see table below)
  runId: string;
  timestamp: string;        // ISO 8601
  sequenceNumber: number;   // monotonically increasing per run
}
```

`sequenceNumber` is monotonic per run and is the basis for **gap detection**: if a consumer sees a jump in `sequenceNumber`, it triggers a full state resync (re-read the durable run state) rather than trusting a partial view. This is what makes reconnection lossless.

## The `RunEvent` union

```ts
export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | AgentTokenEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | CostUpdatedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | HumanGatePausedEvent
  | HumanGateResumedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;
```

| `type` | Meaning | Key payload fields |
| --- | --- | --- |
| `run:started` | A run began. | `workflowId`, `inputs` (secret-typed inputs **masked** — see [Security](#security-event-payloads-never-carry-secrets)), `executionMode: 'local' \| 'cloud' \| 'managed'` |
| `node:started` | A node began executing. | `nodeId`, `nodeType` |
| `agent:token` | A streaming LLM token from an agent node. | `nodeId`, `token`, `model` |
| `agent:tool_call` | An agent invoked a tool. | `nodeId`, `model` (the invoking model — so a tool call is attributable across a failover), `toolId`, `toolInput` (sanitized — no secrets) |
| `agent:tool_result` | A tool returned. | `nodeId`, `toolId`, `success`, `outputSummary` (truncated for UI) |
| `cost:updated` | A node's token cost was tallied (drives the cost waterfall). | `nodeId`, `model`, `inputTokens`, `outputTokens`, `costMicrocents`, `cumulativeCostMicrocents` (integer micro-cents — canonical unit in [llm-provider-seam.md](../shared-core/llm-provider-seam.md#6-usage)), `attemptNumber?` (1-based retry attempt this cost belongs to, so per-attempt cost is reconstructable) |
| `node:completed` | A node finished successfully. | `nodeId`, `output`, `tokensUsed: {input, output, model}`, `durationMs` |
| `node:failed` | A node failed. | `nodeId`, `error: {code, message, retryable}` |
| `human_gate:paused` | Execution suspended at a human gate. | `nodeId`, `gateId`, `gateType: 'approval' \| 'input' \| 'review'`, `message`, `assignee?`, `timeoutMs?`, `expiresAt?` |
| `human_gate:resumed` | A gate decision was applied; execution continues. | `nodeId`, `decision: 'approved' \| 'rejected' \| 'input_provided'`, `decidedBy`, `payload?` |
| `run:completed` | The run finished. | `outputs`, `totalTokensUsed`, `totalCostMicrocents` (integer micro-cents closing total for the whole run), `durationMs` |
| `run:failed` | The run failed. | `error: {code, message, nodeId?}`, `partialOutputs` |
| `run:cancelled` | The run was cancelled. | (base only) |

### Selected definitions

```ts
export interface AgentTokenEvent extends BaseEvent {
  type: 'agent:token';
  nodeId: string;
  token: string;            // streaming LLM token
  model: string;
}

export interface CostUpdatedEvent extends BaseEvent {
  type: 'cost:updated';
  nodeId: string;
  model: string;                  // canonical model id the cost was priced against
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;         // integer micro-cents (canonical unit defined in llm-provider-seam.md); this attempt, from Relavium's pricing table (never the provider)
  cumulativeCostMicrocents: number; // integer micro-cents running total for the whole run
  attemptNumber?: number;         // 1-based retry attempt this cost belongs to (per-attempt cost attribution)
}

export interface NodeCompletedEvent extends BaseEvent {
  type: 'node:completed';
  nodeId: string;
  output: unknown;
  tokensUsed: { input: number; output: number; model: string };
  durationMs: number;
}

export interface HumanGatePausedEvent extends BaseEvent {
  type: 'human_gate:paused';
  nodeId: string;
  gateId: string;           // stable id of this gate instance; required by the resume path — engine.resume(runId, gateId, decision)
  gateType: 'approval' | 'input' | 'review';
  message: string;
  assignee?: string;
  timeoutMs?: number;
  expiresAt?: string;
}
```

### Security: event payloads never carry secrets

`agent:tool_call.toolInput` is sanitized (no secrets) and `agent:tool_result.outputSummary` is truncated. `run:started.inputs` carries workflow inputs, but any **secret-typed** input is **masked** — the value is replaced with `{ secret: true, ref }` (the keychain/env reference), never the raw value. API keys and other secrets never appear in any event payload — this holds across the in-process bus, HTTP SSE, and any persisted run log. (On the desktop the raw provider key never even reaches the WebView: egress is Rust-delegated, [ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md).)

## Consuming the stream

The consumer pattern is identical for every surface, local or cloud:

```ts
const handle = engine.start(workflowId, inputs);
for await (const event of handle.events) {
  switch (event.type) {
    case 'agent:token':        renderStreamingToken(event.nodeId, event.token); break;
    case 'node:completed':     markNodeDone(event.nodeId, event.tokensUsed);    break;
    case 'human_gate:paused':  showApprovalUI(event);                           break;
    case 'run:completed':      showResult(event.outputs);                       break;
  }
}
```

On the desktop the same events are produced and consumed WebView-side over the engine's in-process `RunEventBus` (they do not cross IPC) — see [ipc-contract.md](ipc-contract.md#run-events-are-webview-side). On the cloud portal (Phase 2) they arrive over HTTP SSE. In all cases the consumer routes by `nodeId` into the per-node status map in `runStore` (kept deliberately separate from the canvas store to avoid re-rendering ReactFlow on every token — see [../shared-core/store-shapes.md](../shared-core/store-shapes.md)).

## Human-gate suspend/resume across the stream

A human gate threads two events through the stream around a suspension:

1. Engine reaches a `human_gate` node, persists full run state, emits `human_gate:paused` **carrying the `gateId`**, and suspends — the process may even exit.
2. A surface renders the approval UI and the user acts; the surface calls `engine.resume(runId, gateId, decision)`, passing back the `gateId` it received on the paused event (it identifies *which* gate is being resolved).
3. The engine reloads state, emits `human_gate:resumed`, and the run continues.

The gate decision object:

```ts
export interface GateDecision {
  decision: 'approved' | 'rejected' | 'input_provided';
  decidedBy: string;        // user id or 'timeout_escalation'
  payload?: unknown;        // for gate_type = input
  comment?: string;
}
```

Timeout behavior (`timeout_action` on the node) maps to `decidedBy: 'timeout_escalation'` when a gate auto-resolves. See [workflow-yaml-spec.md](workflow-yaml-spec.md#human_gate-node).

## Transport notes

### Phase 1 — local (in-process on every surface)

- **Desktop**: the engine runs in the WebView's JS runtime ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), so run events are delivered **WebView-side** over the engine's in-process `RunEventBus` — they do **not** cross IPC as `RunEvent`s. The one Rust→WebView channel on the hot path is the delegated LLM egress's typed, backpressure-aware `Channel<StreamChunk>`: if the WebView consumer lags, the Rust sender awaits, throttling the egress without dropping chunks; the adapter folds those chunks into `agent:token` events on the WebView-side bus. See [ipc-contract.md](ipc-contract.md#run-events-are-webview-side).
- **CLI / VS Code**: the engine runs in-process; events are delivered via the engine's `RunEventBus` (`EventEmitter`) or the `RunHandle.events` async iterable.

### Phase 2 — cloud (HTTP SSE)

The cloud API exposes the same stream as Server-Sent Events. Reconnection uses `sequenceNumber` (and SSE `Last-Event-ID`) for gap detection and resync against durable run state. A singleton `SseManager` owns the `EventSource` lifecycle with exponential-backoff reconnect (500ms → 1s → 2s → 4s, cap 30s) and a `GET /runs/:id/state` resync on reconnect.

> **Legacy event-name note.** Earlier design drafts used dotted event names (`node.started`, `node.token`, `node.completed`, `node.error`, `run.complete`, `human_gate.pending`, `cost.update`) with a `{ type, nodeId, payload, seqNo }` envelope. The canonical contract going forward is the colon-namespaced `RunEvent` union above with `sequenceNumber`. New code targets the union; the dotted names are recorded here only to disambiguate older references.
