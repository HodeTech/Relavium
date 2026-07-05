# Run Event Schema

- **Status**: Stable
- **Canonical type**: the `RunEvent` discriminated-union Zod schema lives in `@relavium/shared` (`run-event.ts`) and is **consumed / re-exported** by `@relavium/core`. **This document is the authoritative contract**; the schema is its runtime-validated implementation — if the two ever diverge, the doc wins and the schema is corrected to it (see the note under [Selected definitions](#selected-definitions))
- **Transport**: Phase 1 — in-process `RunEventBus` (the engine runs in-process on **every** surface, including the desktop WebView). Phase 2 — HTTP `text/event-stream` (SSE) from the cloud API.
- **Related**: [ipc-contract.md](ipc-contract.md), [workflow-yaml-spec.md](workflow-yaml-spec.md), [../shared-core/store-shapes.md](../shared-core/store-shapes.md), [../shared-core/llm-provider-seam.md](../shared-core/llm-provider-seam.md) (canonical `costMicrocents` unit + the `cost:updated` figures), [../../architecture/execution-model.md](../../architecture/execution-model.md), [../../architecture/state-management.md](../../architecture/state-management.md), [ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)

Every workflow run produces a single ordered stream of `RunEvent` objects. This stream is the **one contract** that all surfaces consume to render live progress — streaming tokens on a node face, per-node status rings, cost waterfalls, and human-gate prompts. The events are emitted by `@relavium/core` and are identical regardless of where the engine runs.

The **transport** differs by surface and phase, but the **event shape does not**:

```mermaid
flowchart LR
  E["@relavium/core\nRunEventBus\n(runs in-process on every surface)"] -->|in-process, WebView-side| D[Desktop WebView stores]
  E -->|in-process bus| C[CLI ink renderer]
  E -->|in-process bus| V[VS Code extension host]
  E -. Phase 2 .->|HTTP SSE| P[Cloud Portal]
```

On the desktop the engine runs in the WebView's JS runtime ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), so its `RunEventBus` and the consuming stores share one runtime — most run events **never cross IPC**. The only Rust→WebView channel on the LLM hot path is the delegated egress's `Channel<StreamChunk>` (the WebView adapter folds those chunks into `agent:token` run events locally); see [ipc-contract.md](ipc-contract.md#run-events-are-webview-side). The cross-surface `RunEvent` union below is the same one HTTP SSE carries in Phase 2.

## Event envelope

Every event extends a common base:

```ts
interface BaseEvent {
  type: string;             // discriminator (see table below)
  runId?: string;           // correlation key on a workflow RUN (omitted on a session)
  sessionId?: string;       // correlation key on an agent SESSION (omitted on a run)
  timestamp: string;        // ISO 8601
  sequenceNumber: number;   // monotonic per run OR per session
}
```

> **Correlation key.** Exactly one of `runId` / `sessionId` is present — `runId` on a workflow run, `sessionId` on an agent session. The reused `agent:token` / `agent:tool_call` / `agent:tool_result` / `cost:updated` events carry `runId` on a run and `sessionId` on a session; `agent:approval_requested` (ADR-0057) is also dual-envelope but **session-only-emitted** in Phase 2.5. Consumers route on whichever is present.

`sequenceNumber` is monotonic per run and is the basis for **gap detection**: if a consumer sees a jump in `sequenceNumber`, it triggers a full state resync (re-read the durable run state) rather than trusting a partial view. This is what makes reconnection lossless. The **envelope** fields (`sessionId` / `runId`, `sequenceNumber`, `timestamp`) are stamped by the bus, not the producer: `WorkflowEngine` emits through the `RunEventBus`, and `AgentSession` (1.V) emits *envelope-free payload drafts* through an injected `SessionEventSink` — wiring that sink onto the bus, where the per-session `sequenceNumber` (and its same gap/resync rule) is assigned, is **1.W**. So a session's monotonic numbering is the bus's responsibility, not the session core's.

## The `RunEvent` union

```ts
export type RunEvent =
  | RunStartedEvent
  | NodeStartedEvent
  | AgentTokenEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentApprovalRequestedEvent // dual-envelope; session-only-emitted in Phase 2.5 (ADR-0057)
  | AgentFilePatchProposedEvent
  | CostUpdatedEvent
  | NodeCompletedEvent
  | NodeFailedEvent
  | NodeSkippedEvent
  | NodeRetryingEvent
  | MediaJobSubmittedEvent
  | HumanGatePausedEvent
  | HumanGateResumedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | RunPausedEvent
  | RunTimeoutEvent
  | BudgetWarningEvent
  | BudgetPausedEvent;
```

> `RunPausedEvent` is the multi-gate aggregate (below); `RunTimeoutEvent` / `BudgetWarningEvent` / `BudgetPausedEvent` are the resource-governance events defined in [Workflow governance and reserved events](#workflow-governance-and-reserved-events).

| `type` | Meaning | Key payload fields |
| --- | --- | --- |
| `run:started` | A run began. | `workflowId` (the `workflows.id` **UUID** FK, not the authored slug — [ADR-0022](../../decisions/0022-run-references-workflow-by-uuid.md)), `inputs` (secret-typed inputs **masked** — see [Security](#security-event-payloads-never-carry-secrets)), `executionMode: 'local' \| 'cloud' \| 'managed'` |
| `node:started` | A node began executing. | `nodeId`, `nodeType`, `attemptNumber?` (1-based; absent ⇒ attempt 1, present + >1 ⇒ a node-retry re-dispatch — 1.S) |
| `agent:token` | A streaming LLM token from an agent node. | `nodeId`, `token`, `model` |
| `agent:tool_call` | An agent invoked a tool. | `nodeId`, `model` (the invoking model — so a tool call is attributable across a failover), `toolId`, `toolInput` (sanitized — no secrets), `attemptNumber?` (1-based, matches `cost:updated`) |
| `agent:tool_result` | A tool returned. | `nodeId`, `toolId`, `success`, `outputSummary` (truncated for UI), `attemptNumber?` |
| `agent:approval_requested` | A side-effecting tool dispatch is awaiting an **interactive per-tool approval** decision (ADR-0057 EA3/EA5). The engine's `confirmDispatch` emits it — for **every** governed dispatch reaching the gate, whether the host then prompts a human or auto-decides — just before invoking the host's `ConfirmActionHook`; the registry then awaits the verdict (approve ⇒ dispatch, reject ⇒ a fatal `tool_denied`). A **dual-envelope** event (`runId`/`sessionId`), like `agent:tool_call` — in Phase 2.5 emitted only on the chat session path (the approval regime), and **carried on the session stream** (not run-only — it is **not** dropped like `agent:file_patch_proposed`). | `nodeId`, `toolId`, `action: 'fs_write' \| 'process' \| 'egress' \| 'os'` (the governed side-effect class — [tool-registry.md](../shared-core/tool-registry.md)), `preview` (**secret-free, display-only**: `{ path? }` for a write, `{ command? }` for a process, `{ host? }` for egress, `{}` for an `os` action like `read_clipboard`/`notify` — never a full URL/query, never a secret), `attemptNumber?` |
| `agent:file_patch_proposed` | An agent proposed a file change (**gated — no write until the user accepts**; e.g. the VS Code inline-diff review). | `nodeId`, `patches: [{ uri, unifiedDiff }]` (≥1 — an empty proposal is meaningless), `attemptNumber?` |
| `cost:updated` | A node's token cost was tallied (drives the cost waterfall). | `nodeId`, `model`, `inputTokens`, `outputTokens`, `costMicrocents`, `cumulativeCostMicrocents` (integer micro-cents — canonical unit in [llm-provider-seam.md](../shared-core/llm-provider-seam.md#6-usage); **includes realized media spend**, folded as a disjoint addend per [ADR-0044](../../decisions/0044-media-access-governance-read-media-save-to-cost.md) §3 — the per-unit `Usage.mediaUnits` axis is **not yet a field on this event**, deferred, see [deferred-tasks.md](../../roadmap/deferred-tasks.md)), `attemptNumber?` (1-based **within-chain** FallbackChain attempt — resets per node-retry re-dispatch; **distinct** from `node:*.attemptNumber`, see the [two attemptNumber families](#two-attemptnumber-families) note). **Generative-node variant (1.AG Section C, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §5):** a `media_surface: 'generative'` agent node emits **exactly one** `cost:updated` with `inputTokens` / `outputTokens` **= 0** (no token billing — the spend rides entirely in `costMicrocents` as the per-modality media addend) and **no `attemptNumber`** (no FallbackChain on the generative path — one provider, no failover). |
| `node:completed` | A node finished successfully. | `nodeId`, `output`, `tokensUsed: {input, output, model?}` (`model` only for LLM nodes), `durationMs`, `selected?` (a `condition`'s chosen target ids — the authoritative branch record checkpoint/resume restores from, 1.R; **may be an empty array** when the condition routes to no branch, dimming all downstream), `attemptNumber?` (1-based **node-retry** dispatch attempt — 1.S; absent ⇒ attempt 1), `cumulativeCostMicrocents?` (the run-wide running total snapshotted at this node boundary — the durable cost source checkpoint/resume restores from, since `cost:updated` is streamed-only; the engine always populates it. `node:failed` mirrors this field, 2.S/D-GC) |
| `node:failed` | A node failed (TERMINAL — exactly one per node; emitted when the node-retry budget is exhausted, on a fatal / `retry_on`-excluded failure, **or** when a pending retry is abandoned by a cancel or a sibling abort — see 1.S). | `nodeId`, `error: {code, message, retryable, correlationId?}` (`code` is an [`ErrorCode`](#error-code-taxonomy); `correlationId` is a secret-free id joined to the internal log — ADR-0036), `attemptNumber?` (the last attempt, when a retry budget was spent — 1.S), `cumulativeCostMicrocents?` (the run-wide running total snapshotted AT this node boundary — the durable fail-cost so a billed-but-failed **paid media job**'s realized spend survives the transient `cost:updated`, 2.S/D-GC [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §5; mirrors `node:completed`) |
| `node:retrying` | A retryable node attempt failed and the engine will re-dispatch the whole node (1.S, [ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md)) — **non-terminal** (the node continues; `node:failed` is the terminal). | `nodeId`, `attemptNumber` (the attempt that just failed, 1-based), `error: {code, message, retryable}` (the `NodeFailure` shape — **no** `correlationId`; that anchors the terminal failure), `delayMs` (backoff before the next attempt) |
| `node:skipped` | A node was skip-propagated (never ran). | `nodeId`, `reason: 'branch_not_taken' \| 'upstream_unreachable'` (`branch_not_taken` = a `condition` routed away from it; `upstream_unreachable` = every in-edge is dead because an upstream was skipped/failed). Emitted so the event log is a **complete, replayable** record — checkpoint/resume reconstructs a skipped vertex from it ([run-plan.md](../shared-core/run-plan.md)) and a surface can render the dimmed path instead of the node silently vanishing. |
| `media_job:submitted` | An async media-generation job was submitted; the engine owns its poll/checkpoint/resume/cancel loop (1.AG, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)) — **non-terminal** (the node parks until its `node:completed`/`node:failed`). **Durable** so a crash-resume re-attaches (re-polls the opaque `jobId`) instead of re-submitting; per-poll progress is **transient** (off this durable stream). | `nodeId`, `jobId` (Relavium-opaque — never the vendor op-name), `provider`, `model`, `modality: 'image' \| 'audio' \| 'video'`, `startedAt`, `deadlineAt` |
| `human_gate:paused` | Execution suspended at a human gate. | `nodeId`, `gateId`, `gateType: 'approval' \| 'input' \| 'review'`, `message`, `assignee?`, `timeoutMs?`, `timeoutAction?: 'approve' \| 'reject'` (on-timeout policy, present only with `timeoutMs`), `expiresAt?` |
| `human_gate:resumed` | A gate decision was applied; execution continues. | `nodeId`, `decision: 'approved' \| 'rejected' \| 'input_provided'`, `decidedBy`, `payload?` |
| `run:paused` | The run is suspended on **≥1 gate AND/OR ≥1 async media job** — the multi-suspension aggregate (parallel branches may each reach a gate or a media job). `pendingGateCount` is the count of `gateIds[]` (they must agree) and both are `0`/empty for a media-only park; `pendingMediaJobNodeIds` lists nodes parked on the engine-owned `pollMediaJob` loop (1.AG Section D, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §2). At least one suspension reason (a gate or a media job) always holds. A resume disambiguates by registry: a gate by `gateId` (a decision), a media job by `nodeId` (a re-attach). | `pendingGateCount`, `gateIds[]`, `pendingMediaJobNodeIds[]?` |
| `run:completed` | The run finished. | `outputs` (a record **keyed by each terminal `output` vertex's node id**, the value being that vertex's captured output — see [run-plan.md §output capture](../shared-core/run-plan.md)), `totalTokensUsed`, `totalCostMicrocents` (integer micro-cents closing total for the whole run), `durationMs` |
| `run:failed` | The run failed. | `error: {code, message, retryable, nodeId?, correlationId?}` (`code` is an [`ErrorCode`](#error-code-taxonomy); `nodeId` is the root-cause node; `correlationId` joins to the internal log — ADR-0036), `partialOutputs`, `cumulativeCostMicrocents?` (the run-wide running total at failure — the durable fail-cost for a **paid media job** a sibling node's failure abandoned, whose lone estimate addend is folded just before this terminal _after_ the root-cause `node:failed` snapshot, 2.S/D-GC [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §5; mirrors `run:cancelled` and the `run:completed` counterpart `totalCostMicrocents`) |
| `run:cancelled` | The run was cancelled. | `cumulativeCostMicrocents?` (the run-wide running total at cancellation — the durable fail-cost for a **paid media job** pending at the cancel, whose lone estimate addend is folded just before this terminal, 2.S/D-GC [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §5; the `run:completed` counterpart is `totalCostMicrocents`) |

### Two attemptNumber families

`attemptNumber` appears on two **independent** counter families that must not be conflated (1.S, [ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md)):

- **Node-retry dispatch attempt** — on `node:started` / `node:completed` / `node:failed` / `node:retrying`. The engine's **above-chain** whole-node re-dispatch index. Absent ⇒ attempt 1; present + >1 ⇒ a re-dispatch (distinguishes "attempt N starting" from a replay).
- **Within-chain attempt** — on `cost:updated` / `agent:tool_call` / `agent:tool_result` / `agent:file_patch_proposed`. The **within-chain** `FallbackChain` attempt index inside a *single* node dispatch; it **resets to 1 on every node-retry re-dispatch** (a fresh chain runs each time).

The two do **not** join: on a node the budget retried, `node:completed.attemptNumber` may be `2` while the accompanying `cost:updated.attemptNumber` is `1`. To attribute cost to a node-retry attempt, **partition the `sequenceNumber`-ordered stream at each `node:started` / `node:retrying` boundary** — do not key by `(nodeId, attemptNumber)` across families. (Run totals are unaffected: `cost:updated.cumulativeCostMicrocents` is the engine's authoritative running total.)

### Selected definitions

> These TypeScript shapes are **illustrative**. The enforced, runtime-validated
> implementation is the Zod schema set in `@relavium/shared` (`run-event.ts`), from which
> the TS types are inferred ([ADR-0020](../../decisions/0020-zod-runtime-schema-library.md)).
> This document remains the canonical **contract** (the human-readable spec the schema
> implements); if the two ever diverge, this spec wins and the schema is corrected to it.

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
  cumulativeCostMicrocents: number; // integer micro-cents running total for the whole run — INCLUDES realized media spend, folded as a disjoint addend (ADR-0044 §3)
  // NOTE (1.AF): the per-unit `Usage.mediaUnits` axis (image per-count, audio/video per-second; a token-based
  // provider's audio rides as unit:'count') is NOT yet a field on this event. Realized media spend already
  // folds into `cumulativeCostMicrocents`; surfacing the disjoint per-unit counts here needs `MediaUnitsEntry`
  // relocated to `@relavium/shared` first (run-event.ts cannot import the `@relavium/llm` seam type). Deferred —
  // see deferred-tasks.md.
  attemptNumber?: number;         // 1-based WITHIN-CHAIN attempt; resets per node-retry re-dispatch — distinct from node:*.attemptNumber (see "Two attemptNumber families")
}

export interface NodeCompletedEvent extends BaseEvent {
  type: 'node:completed';
  nodeId: string;
  output: unknown;
  // `model` is present only when an LLM produced the tokens. A non-agent node (condition,
  // transform, merge, parallel, input, output, human_gate) completes with input/output 0 and
  // no model — so `model` is optional.
  tokensUsed: { input: number; output: number; model?: string };
  durationMs: number;
  selected?: string[];      // a `condition` node only: the immediate target ids it routed to (the live branches); MAY be empty when it routes to no branch (all downstream skip-propagated). The authoritative record checkpoint/resume restores `selectedTargets` from (1.R).
  attemptNumber?: number;   // 1-based NODE-RETRY dispatch attempt (1.S); absent ⇒ attempt 1 — distinct from cost:updated.attemptNumber (see "Two attemptNumber families")
  cumulativeCostMicrocents?: number; // run-wide running total at this node boundary — the durable cost source checkpoint/resume restores (cost:updated is streamed-only); engine always populates. node:failed mirrors it (2.S/D-GC)
}

export interface NodeSkippedEvent extends BaseEvent {
  type: 'node:skipped';
  nodeId: string;
  reason: 'branch_not_taken' | 'upstream_unreachable';
}

export interface NodeRetryingEvent extends BaseEvent {
  type: 'node:retrying';        // 1.S — a retryable attempt failed; the engine will re-dispatch the whole node. NON-TERMINAL.
  nodeId: string;
  attemptNumber: number;        // the attempt that just failed (1-based); the next attempt is attemptNumber + 1
  error: { code: ErrorCode; message: string; retryable: boolean }; // the NodeFailure shape — no correlationId (that anchors the terminal node:failed)
  delayMs: number;              // backoff before the next attempt
}

export interface MediaJobSubmittedEvent extends BaseEvent {
  type: 'media_job:submitted'; // 1.AG/ADR-0045 §2 — an async media job was submitted; the node PARKS (non-terminal suspension). DURABLE (resume re-attaches).
  nodeId: string;
  jobId: string;               // the Relavium-opaque job id the engine re-polls — never the vendor operation-name (ADR-0011 I1)
  provider: 'anthropic' | 'openai' | 'gemini' | 'deepseek'; // the bound LlmProviderId (closed z.enum(LLM_PROVIDERS); failover does not apply to an in-flight job)
  model: string;               // canonical model id
  modality: 'image' | 'audio' | 'video';
  startedAt: string;           // ISO-8601 submit time
  deadlineAt: string;          // ISO-8601 = startedAt + [defaults].media_job_deadline_ms; on resume now > deadlineAt short-circuits a doomed re-poll
}

export interface HumanGatePausedEvent extends BaseEvent {
  type: 'human_gate:paused';
  nodeId: string;
  gateId: string;           // stable id of this gate instance; required by the resume path — engine.resume(runId, gateId, decision)
  gateType: 'approval' | 'input' | 'review';
  message: string;
  assignee?: string;
  timeoutMs?: number;
  timeoutAction?: 'approve' | 'reject';  // on-timeout policy (present only with timeoutMs); lets a surface show how the gate auto-resolves and a Phase-2 crash-resume re-arm the timer from the log
  expiresAt?: string;
}

export interface BudgetWarningEvent extends BaseEvent {
  type: 'budget:warning';
  spentMicrocents: number;
  limitMicrocents: number;
  thresholdPct: number;     // 0–100, rounded from spent/limit at the pre-egress check point
}

export interface BudgetPausedEvent extends BaseEvent {
  type: 'budget:paused';
  nodeId: string;           // the agent node whose next LLM call would exceed the cap
  spentMicrocents: number;
  limitMicrocents: number;
  gateId: string;           // stable id of the budget gate; required by engine.resume(runId, gateId, decision)
}

export interface RunTimeoutEvent extends BaseEvent {
  type: 'run:timeout';
  elapsedMs: number;
  timeoutMs: number;
}
```

### Security: event payloads never carry secrets

`agent:tool_call.toolInput` is sanitized (no secrets) and `agent:tool_result.outputSummary` is truncated. `run:started.inputs` carries workflow inputs, but any **secret-typed** input is **masked** — the value is replaced with `{ secret: true, ref }` (the keychain/env reference), never the raw value. API keys and other secrets never appear in any event payload — this holds across the in-process bus, HTTP SSE, and any persisted run log. (On the desktop the raw provider key never even reaches the WebView: egress is Rust-delegated, [ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md).)

The same `{ secret: true, ref }` **`MaskedSecret`** marker can also appear in **`node:completed.output`** (for an `input` node, which emits the masked inputs) and therefore in **`run:completed.outputs`** / **`run:failed.partialOutputs`** wherever a `secret`-typed input would otherwise surface — the engine masks `secret` inputs at the ingress so a raw secret never reaches an output payload (see [run-plan.md §output capture](../shared-core/run-plan.md)). **Any surface rendering of node/run outputs must treat a `MaskedSecret` object as a redacted placeholder, not displayable data.**

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
  decidedBy: string;        // user id, or 'timeout' when a gate auto-resolves on timeout
  payload?: unknown;        // for gate_type = input
  comment?: string;
}
```

Timeout behavior (`timeout_action` on the node) maps to `decidedBy: 'timeout'` when a gate auto-resolves. The `timeout_action: escalate` value is **reserved** in v1.0 (a timeout resolves only as `approve` or `reject`); see [workflow-yaml-spec.md](workflow-yaml-spec.md#human_gate-node).

## Session event namespace

An [agent session](agent-session-spec.md) ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)) is driven on the **same** `RunEventBus`, but emits a **disjoint `session:*` namespace** keyed by `sessionId` instead of `runId`. Consumers route purely on the `type` discriminant, so the two namespaces never collide.

```ts
interface BaseSessionEvent {
  type: string;             // 'session:*' (see below)
  sessionId: string;
  timestamp: string;        // ISO 8601
  sequenceNumber: number;   // monotonic per session — same gap-detection/resync rule as a run
}

export type SessionEvent =
  | SessionStartedEvent       // 'session:started'   — { agentRef, model, context }
  | SessionTurnStartedEvent   // 'session:turn_started'   — a user message began an assistant turn
  | SessionTurnCompletedEvent // 'session:turn_completed' — { stopReason, tokensUsed, error? }; stopReason is the SESSION superset (the 5 LLM StopReasons + 'aborted' — the EA7 mid-turn abort, ADR-0057)
  | SessionCancelledEvent     // 'session:cancelled' — cancel() was called; the session ends (terminal). NOT a mid-turn abort (EA7), which keeps the session alive — see session:turn_completed{stopReason:'aborted'}.
  | SessionExportedEvent      // 'session:exported'  — { workflowPath } (chat-to-workflow export)
  | SessionCompactingEvent    // 'session:compacting' — { reason:'manual'|'auto-threshold' } (ADR-0062 §7: compaction STARTED — the "Summarizing…" moment; carries no counts, they ride the terminal below)
  | SessionCompactedEvent     // 'session:compacted' — { reason:'manual'|'auto-threshold', summary, keptMessageCount, tokensBefore, tokensAfter, tokensUsed } (ADR-0062: model-summarised compaction; tokensUsed is the summarization spend, accounted to the session budget)
  | SessionTrimmedEvent;      // 'session:trimmed'   — { reason:'manual'|'auto-fallback', keptMessageCount, droppedMessageCount } (ADR-0062: deterministic history trim, no LLM call, no cost; the view surfaces the auto-fallback trim)
```

`session:compacting`, `session:compacted`, and `session:trimmed` are **side events** (like `session:exported`), never a stream terminal. `session:compacting` is the paired **START** of a compaction moment (a `/compact` or an auto-threshold trigger — amending the [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md) event substrate per [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) §7): the host drives a labeled "Summarizing…" indicator off it, and the moment ends on the terminal `session:compacted` (success) / `session:trimmed` `auto-fallback` (the summariser failed → deterministic trim) — or, for a manual `/compact` failure, when `compact()` settles (no terminal event). The host writes the append-only boundary marker row (`session_messages.compaction_dropped_through_sequence`) on `session:compacted` / `session:trimmed` (never on `session:compacting`) — see [ADR-0062](../../decisions/0062-context-compaction-and-cli-history-commands.md) and [agent-session-spec.md](agent-session-spec.md).

A turn that **fails** (a provider error, a rate limit, an exhausted budget cap) still emits `session:turn_completed` with an `error?: { code, message, retryable, correlationId? }` — the same closed [`ErrorCode`](#error-code-taxonomy) taxonomy and secret-free correlation id as run events (ADR-0036) — so a surface can render the failure rather than a silent stall. On such a failure `tokensUsed` carries the turn's **real accumulated usage** — non-zero when a provider had already engaged before the failure (e.g. a tool round or a later turn that then failed), and zero when the failure was pre-egress (a no-plan-entries / budget-pause / hard-cap block engaged no provider); EA2, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md). A **cancellation** is distinct: it emits `session:cancelled` (not `turn_completed`) and the in-flight user message is rolled back from the transcript, so a cancelled turn leaves no partial assistant turn behind (see [agent-session-spec.md](agent-session-spec.md)). A **mid-turn abort** (ADR-0057 EA7, the `Esc` interrupt) is distinct from BOTH: it settles **one** `session:turn_completed` with `stopReason: 'aborted'` and **no** `error` (it is user-initiated, not a failure), rolls the pending user message back, and **keeps the session alive** (→ idle) — it is **not** `session:cancelled` (the session continues). `'aborted'` is a session-only stop-reason (the `@relavium/llm` `StopReason` stays its five values).

Within a turn, the conversational work reuses the **same** `agent:token` / `agent:tool_call` / `agent:tool_result` / `cost:updated` event shapes the `AgentRunner` already emits — carried on the session envelope (`sessionId`). The per-turn append of user/assistant/tool messages is persisted as `session_messages` (see [database-schema.md](../desktop/database-schema.md)); the contract is owned by [agent-session-spec.md](agent-session-spec.md). On every surface session events are produced and consumed **in-process** exactly like run events — only `llm_stream` crosses IPC on the desktop ([ipc-contract.md](ipc-contract.md#run-events-are-webview-side)). So the **complete typed event stream for a session** is the eight `session:*` lifecycle/side events (the `SessionEvent` union above — started / turn_started / turn_completed / cancelled / exported / compacting / compacted / trimmed) **plus** `agent:token` / `agent:tool_call` / `agent:tool_result` / `cost:updated` (and, on the chat approval path, `agent:approval_requested` — ADR-0057) carrying `sessionId` — this full set is exactly what `relavium chat --json` emits.

**The session stream (`SessionHandle`, 1.W).** A session is **long-lived across turns**, so — unlike a run's exactly-one-terminal `RunHandle` — the `SessionHandle.events` async-iterable stays **open across turns**: `session:turn_completed` is a per-turn boundary, **not** a stream terminal. The stream closes **only** on `session:cancelled` (the session's sole terminal); `session:exported` is a side event (1.Z), never a terminal. The bus assigns the **per-session** `sequenceNumber` — a monotonic counter keyed on `sessionId`, independent of any run's `runId` counter on the same shared bus (ADR-0036 "one bus, two namespaces") — with the **same** gap-detection / resync rule as a run. `AgentSession` (1.V) emits *envelope-free* drafts through its injected `SessionEventSink`; 1.W's `createSessionEventSink` attaches the `sessionId` and the bus stamps the `sequenceNumber` + `timestamp` at the one authoritative translation point. The bus's validation gate accepts both families via the combined `RunOrSessionEventSchema` (`@relavium/shared`). `agent:file_patch_proposed` is **run-only** (it carries `runId`, emitted by the `AgentRunner` workflow adapter — not the shared turn core), so it is **not** part of a session stream; `createSessionEventSink` drops it defensively at the seam. By contrast, `agent:approval_requested` (ADR-0057 EA3/EA5) is a dual-envelope event the chat session path emits, so the sink **carries** it (it is not run-only).

## Workflow governance and reserved events

`@relavium/core` resource governance ([ADR-0028](../../decisions/0028-workflow-resource-governance.md)) adds three run events:

| `type` | Meaning | Key payload fields |
| --- | --- | --- |
| `budget:warning` | Pre-egress worst-case cost estimate would exceed the configured cap, and `on_exceed: warn` is set. Emitted once per run before the capped egress; execution continues. `thresholdPct` is `clamp(round(spent / limit * 100), 0, 100)` observed at the pre-egress check point. | `spentMicrocents`, `limitMicrocents`, `thresholdPct` |
| `budget:paused` | Pre-egress estimate would exceed the cap with `on_exceed: pause_for_approval`; the run suspends like a human gate and is resumed via `engine.resume(runId, gateId, decision)`. `decision: approved` continues; `rejected` closes the run with `run:failed{code: budget_exceeded}`. | `nodeId`, `spentMicrocents`, `limitMicrocents`, `gateId` |
| `run:timeout` | The run hit its `timeout_ms`. | `elapsedMs`, `timeoutMs` |

These three (and `run:paused` / `human_gate:paused`) are **non-terminal** — they signal a governance/suspension state, not the run's end. A run that cannot continue past a timeout or budget cap still closes with **exactly one** `run:failed` carrying `code: run_timeout` / `budget_exceeded`. The exactly-one-terminal-event invariant (`run:completed | run:failed | run:cancelled`) and its precedence are owned by [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md).

**Reserved (declared, but emitted by no Phase-1 code):**

- **Loops** ([loops ADR, 0030+](../../decisions/README.md)): `iteration:started` / `iteration:completed`, and an optional `iterationIndex?` / `iterationTotal?` on node-level events. Reserved so the schema is future-proof without Phase-1 bloat.
- **Steering** ([agent-sessions.md](../../architecture/agent-sessions.md)): `agent:directive_injected` (`mode: 'non_blocking' | 'blocking'`, **`directiveLength` — not the content**, so no secret/PII enters the stream), `agent:context_compacted`, `agent:context_cleared`. Security envelope: a directive applies **only** to a running or paused agent; completed nodes are immutable.

## Error-code taxonomy

`node:failed.error.code` and `run:failed.error.code` are a closed **`ErrorCode`** enum (not a free string), so surfaces can branch on cause and `retryable` is unambiguous:

`validation` · `content_filter` · `provider_auth` · `provider_rate_limit` · `provider_unavailable` · `tool_denied` · `tool_failed` · `tool_unavailable` · `budget_exceeded` · `run_timeout` · `turn_limit` · `cancelled` · `sandbox_error` · `internal`

The retryable/fatal mapping is owned by [error-handling.md](../../standards/error-handling.md) (e.g. `provider_rate_limit`/`provider_unavailable` retryable; `provider_auth`/`validation`/`content_filter`/`tool_denied`/`tool_unavailable`/`turn_limit`/`cancelled` fatal). `tool_unavailable` is a required `ToolHost` capability arm (`fs`/`process`/`egress`/…) not being wired — a host/config gap, not the model's fault — so a surface names the missing capability + the tool actionably instead of an opaque `internal` (EA1, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)); it is distinct from `tool_denied` (a policy/grant denial of a *present* capability). `content_filter` is a provider content-policy rejection (text or media generation) — a fatal cause distinct from `validation` (an authoring/shape error), so a surface shows the right reason; the `content_filter` `LlmErrorKind` maps here (1.AG, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §6). `turn_limit` is the limit-family code for a **hard** agent/session turn/round cap (the exact knob is settled with `AgentSession`, 1.V) — distinct from `run_timeout`/`budget_exceeded` so a capped conversation surfaces its own cause rather than a silent stop; continuing past it is an explicit user action, never a retry. It is **not** the `[chat].max_messages` knob, which is a session-history **trim** threshold ([config-spec.md](config-spec.md)) — trimming continues the session and emits no error. Messages remain user-safe and secret-free.

## Forward-compatibility

This schema is **versioned by additive evolution**, not a version field. The following are always v1.0-legal and never a breaking change, provided consumers **ignore unknown `type`s and unknown fields** and treat an **absent optional field as omitted (not `null`)**:

- adding a **new optional field** to an existing event;
- adding a **new event `type`** (including activating any reserved type above).

Removing or repurposing an existing field/type is a breaking change and is not done within the contract.

## Transport notes

### Phase 1 — local (in-process on every surface)

- **Desktop**: the engine runs in the WebView's JS runtime ([ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md)), so run events are delivered **WebView-side** over the engine's in-process `RunEventBus` — they do **not** cross IPC as `RunEvent`s. The one Rust→WebView channel on the hot path is the delegated LLM egress's typed, backpressure-aware `Channel<StreamChunk>`: if the WebView consumer lags, the Rust sender awaits, throttling the egress without dropping chunks; the adapter folds those chunks into `agent:token` events on the WebView-side bus. See [ipc-contract.md](ipc-contract.md#run-events-are-webview-side).
- **CLI / VS Code**: the engine runs in-process; events are delivered via the engine's `RunEventBus` (a platform-free, in-house typed event bus — **not** Node's `node:events`; [ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) or the co-equal `RunHandle.events` async iterable.

### Phase 2 — cloud (HTTP SSE)

The cloud API exposes the same stream as Server-Sent Events. Reconnection uses `sequenceNumber` (and SSE `Last-Event-ID`) for gap detection and resync against durable run state. A singleton `SseManager` owns the `EventSource` lifecycle with exponential-backoff reconnect (500ms → 1s → 2s → 4s, cap 30s) and a `GET /runs/:id/state` resync on reconnect.

> **Legacy event-name note.** Earlier design drafts used dotted event names (`node.started`, `node.token`, `node.completed`, `node.error`, `run.complete`, `human_gate.pending`, `cost.update`) with a `{ type, nodeId, payload, seqNo }` envelope. The canonical contract going forward is the colon-namespaced `RunEvent` union above with `sequenceNumber`. New code targets the union; the dotted names are recorded here only to disambiguate older references.
