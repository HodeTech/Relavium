# AgentRunner (1.O) — the agent-node executor

> Status: Living

> Last updated: 2026-06-14

- **Related**: [llm-provider-seam.md](llm-provider-seam.md), [tool-registry.md](tool-registry.md), [run-plan.md](run-plan.md), [built-in-tools.md](built-in-tools.md), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md), [../../decisions/0038-agentrunner-llm-call-boundary.md](../../decisions/0038-agentrunner-llm-call-boundary.md), [../../decisions/0039-same-provider-reasoning-replay.md](../../decisions/0039-same-provider-reasoning-replay.md), [../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md), [../../decisions/0037-engine-tool-execution-boundary.md](../../decisions/0037-engine-tool-execution-boundary.md), [../../standards/error-handling.md](../../standards/error-handling.md)

The **AgentRunner** is the single dispatching `NodeExecutor` ([ADR-0036](../../decisions/0036-run-loop-substrate-event-bus-and-execution-host.md)) the run loop holds. It runs an `agent` vertex's LLM turn(s) end to end against the [`@relavium/llm` seam](llm-provider-seam.md), through the [`ToolRegistry`](tool-registry.md), and returns one `NodeOutcome`. This page is the canonical home for its injection boundary and turn contract; the decision is [ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md).

## The two layers

| Layer | Where | Concern |
|-------|-------|---------|
| **Turn core** | internal (`engine/agent-turn.ts`) | A **correlation-key-agnostic** driver: assemble → `chain.stream` → fold the stream into `agent:*` events → tool-call loop → settle. It takes `messages` + `tools` + the fallback plan + `emit` + `signal` + `nodeId` + the registry + `limits`, and emits **envelope-less** event bodies. No `NodeExecContext`, no `runId`/`sessionId`. `AgentSession` (1.V) reuses it unchanged ([ADR-0024](../../decisions/0024-agent-first-entry-point-agentsession.md)/0025/0026) — its parameter shape is a **frozen internal contract**, not on the public surface. |
| **Dispatching adapter** | exported (`engine/agent-runner.ts`) | `createAgentNodeExecutor(deps)` → the `NodeExecutor`. Switches on `ctx.vertex.type`: an `agent` vertex runs the turn core; every non-agent type is a **loud, typed `failed`** stub (`internal`) until the 1.P handlers land. Owns the run-path concerns the core excludes (below). |

## `AgentRunnerDeps` — platform capabilities only

The host injects only platform capabilities; the credential is threaded **opaquely** and is never stored, inspected, logged, persisted, or sent to the frontend by `@relavium/core` ([ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md), rule 6).

- `resolveProvider(providerId): LlmProvider | undefined` — the one genuinely-new capability: the authored `Agent.provider` / `fallback_chain[].provider` are provider-**id** strings, but a `FallbackPlanEntry.provider` is a concrete adapter instance, which the engine cannot construct (vendor SDK + `@types/node` break engine purity). `undefined` ⇒ a host-wiring gap → a `NodeFailure{ code: 'internal' }`.
- `registry` + `tools` — the shared [`ToolRegistry`](tool-registry.md) (for dispatch) and its `ToolDef`s (the source of the LLM-visible schema + descriptions for the granted tools).
- `keyFor` / `sleep` / `now?` / `onAuthError?` — **forwarded** into the per-node `FallbackChain` (the existing `FallbackChainOptions` seam — **not** re-declared as a parallel credential surface). `onAuthError` (the single out-of-band credential refresh) is host-owned.
- `resolverCapabilities?` (the `read_file` filter for a prompt), `fsScope?` (default `'sandboxed'`), `limits?`, `preEgress?`.

The runner owns the **cost path** itself — one `CostTracker` per node execution and its own `onAttempt`→`cost:updated` — never a host-supplied (shared) tracker, because the executor is shared across concurrent runs.

## What the adapter does for an `agent` vertex

1. **Resolve the agent.** An absent `resolvedAgent` ([run-plan.md §AgentPlanConfig](run-plan.md)) ⇒ `NodeFailure{ code: 'validation' }` naming the `agent_ref` (an authoring error — distinct from an unresolved provider id, which is `internal`). Never a raw throw.
2. **Build the fallback plan.** Primary `{ provider, model: node.model ?? agent.model, maxAttempts: agent.retry.max ?? 1 }` + each `fallback_chain` entry. **One `FallbackChain` per node execution**, reused across the tool loop so per-provider cooldown and the [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md) strip-latch survive.
3. **Narrow the tool grant.** `node.tools` must be a **subset** of `agent.tools` — a widening attempt ⇒ `validation` ([ADR-0029](../../decisions/0029-tool-policy-hardening.md)).
4. **Assemble messages.** `system` = **authored text ONLY** (`agent.system_prompt` + `node.system_prompt_append`). The resolved `prompt_template` — which may draw on untrusted `run.outputs` / `read_file` — lands in a **`user`** position, never `system` ([security-review.md §Prompt-injection](../../standards/security-review.md#prompt-injection-posture), the structural placement guarantee — no value-level taint carrier needed for an agent node, which cannot launder a secret into `run.outputs`).
5. **`output_schema` (node override wins over the agent default).** Lowered to `LlmRequest.responseFormat` (a **request-side hint**), **and** validated **node-side**: the seam's `responseFormat` does not guarantee a schema-conformant response (DeepSeek degrades to bare `json_object`), so the runner parses the output and a non-JSON result ⇒ `validation` ([ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md), [error-handling.md](../../standards/error-handling.md)). *Phase-1 scope: parse-as-JSON; deep JSON-Schema conformance is a recorded follow-up (needs a validator dependency/ADR).*
6. **Run the turn core**, map its result to `NodeOutcome.completed` (`output` = the parsed structured value or the assistant text; `tokensUsed = { input, output, model }`), or map a classified `AgentTurnError` to `NodeOutcome.failed`.

## The turn loop + the failure ladder

The core streams one turn (emitting `agent:token` per text delta, accumulating text / tool-call / reasoning parts), and on a `tool_use` stop appends the assistant turn (**including its reasoning `ContentPart`** for the same-provider replay, [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md)), dispatches each tool call, appends the results, and continues — bounded by a **runner-default max-tool-turns cap** (a DoS guard; the authored hard cap + the loud `turn_limit` surfacing is the 1.V session knob).

The error mapping to the closed `ErrorCode` ([error-handling.md](../../standards/error-handling.md)) — **cancel wins** over all others:

| Source | `ErrorCode` | Retryable | Note |
|--------|-------------|-----------|------|
| abort (`ctx.signal`) / `ToolCancelledError` / chain `cancelled` | `cancelled` | false | precedence over every other classification |
| `ToolPolicyError` | `tool_denied` | false | **not** fed back as a correctable result (re-asking a denied tool burns budget) |
| `UnknownToolError` / `ToolArgsInvalidError` | (model-correctable) | — | converted to an `isError` tool result fed back, within a bounded correction budget; after it ⇒ `tool_failed` |
| `ToolExecutionError` | `tool_failed` | true | |
| absent host capability | `internal` | false | |
| chain-exhausted `LlmError` | `provider_auth` / `provider_rate_limit` / `provider_unavailable` / `validation` (content_filter, bad_request) / `internal` (unknown) | per `LlmError.retryable` | classified from `error.kind`, never `error.message` |
| max-tool-turns hit | `turn_limit` | false | |

## Events

The runner emits, per [sse-event-schema.md](../contracts/sse-event-schema.md) (envelope-less; the bus stamps `runId`/`timestamp`/`sequenceNumber`):

- `agent:token` `{ nodeId, token, model }` — `model` is the active attempt's model (see the model-attribution note in `agent-turn.ts`; the accurate per-attempt model is always on `cost:updated`).
- `agent:tool_call` `{ nodeId, model, toolId, toolInput, attemptNumber? }` and `agent:tool_result` `{ nodeId, toolId, success, outputSummary, attemptNumber? }` — **assembled** from the registry's partial `events.call`/`events.result` (the runner adds `type` + `nodeId` + `model`); the registry does not carry them.
- `cost:updated` `{ nodeId, model, inputTokens, outputTokens, costMicrocents, cumulativeCostMicrocents, attemptNumber? }` — one per **non-skipped** attempt; `attemptNumber` counts non-skipped records. `cumulativeCostMicrocents` is a **placeholder** the engine overwrites authoritatively (it owns the run-wide total).

The runner emits **no** `budget:*` / `run_timeout` (run-level, not in the in-node set). A pure **always-pass pre-egress hook** runs before each **tool-loop turn's** seam call — the coarse [ADR-0028](../../decisions/0028-workflow-resource-governance.md) insertion point **1.AC** fills; the precise *per-attempt* budget gate (a `FallbackChain` makes several egresses per turn) is a chain pre-attempt hook 1.AC adds.
