# AgentRunner (1.O) — the agent-node executor

> Status: Living

> Last updated: 2026-10-02

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
- `resolveMediaSurface?(model): MediaSurface | undefined` — the catalog projection of `model_catalog.media_surface` (1.AG Section C, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §1) that selects the **inline-vs-generative** dispatch. `'generative'` routes the node to the separate-endpoint `generateMedia`; `'chat'` — **the default, and the value when this dep is absent or returns `undefined`** — uses the normal turn. The engine is platform-pure (no DB), so the host injects the lookup; the production catalog wiring is deferred to 1.AH (until then every model is `'chat'` — no generative model is runtime-reachable).
- `registry` + `tools` — the shared [`ToolRegistry`](tool-registry.md) (for dispatch) and its `ToolDef`s (the source of the LLM-visible schema + descriptions for the granted tools).
- `keyFor` / `sleep` / `now?` / `onAuthError?` — **forwarded** into the per-node `FallbackChain` (the existing `FallbackChainOptions` seam — **not** re-declared as a parallel credential surface). `onAuthError` (the single out-of-band credential refresh) is host-owned.
- `resolverCapabilities?` (the `read_file` filter for a prompt), `fsScope?` (default `'sandboxed'`), `limits?`, `preEgress?`.

The runner owns the **cost path** itself — one `CostTracker` per node execution and its own `onAttempt`→`cost:updated` — never a host-supplied (shared) tracker, because the executor is shared across concurrent runs.

## What the adapter does for an `agent` vertex

1. **Resolve the agent.** An absent `resolvedAgent` ([run-plan.md §AgentPlanConfig](run-plan.md)) ⇒ `NodeFailure{ code: 'validation' }` naming the `agent_ref` (an authoring error — distinct from an unresolved provider id, which is `internal`). Never a raw throw.
2. **Build the fallback plan.** Primary `{ provider, model: node.model ?? agent.model, maxAttempts: (node.retry ?? agent.retry)?.max ?? 1, backoff: (node.retry ?? agent.retry)?.backoff }` (node-retry overrides the agent default) + each `fallback_chain` entry. **One `FallbackChain` per node execution**, reused across the tool loop so per-provider cooldown and the [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md) strip-latch survive.
   - **Generative fork (1.AG Section C, [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) §1/§6).** After the plan + the resolved prompt, the primary model's surface is read via `resolveMediaSurface?.(primary.model) ?? 'chat'`. A **`'generative'`** result dispatches to the separate-endpoint `generateMedia` (**one** provider, **no** chain failover — a generative call is provider-bound) and returns early: an empty-prompt / multi-modality node fails `validation`; a pre-egress budget gate runs first (gate-only — the [ADR-0028](../../decisions/0028-workflow-resource-governance.md) pre-egress governor; the token estimate is pinned to zero for a token-free generative call, see the code comment); the SYNC `{ media }` becomes the `{ text: '', media: [part] }` node output (de-inlined to a `media://` handle like the inline path); exactly **one** realized `cost:updated` is emitted (request volume × per-model media rate) — **unless a rate is missing**, which since [ADR-0089](../../decisions/0089-media-correctness-four-boundaries.md) §4 is **unpriced, not zero**: under the non-strict default the numeric total may still floor at 0 but the event carries `priced: false` and the modality is counted in `unpriced_calls`, and under the authored `strict_cost_cap` the call is **refused before provider egress**, so no realized event is emitted at all. *(This clause said "degrade-to-0" until 2026-09-02; that behaviour is exactly the `CR-55` defect — a `0` the governor cannot tell from "nothing to charge".)* A `jobId` (async LRO) is Section D. A **`'chat'`** model continues to the turn core below.
3. **Narrow the tool grant.** `node.tools` must be a **subset** of `agent.tools` — a widening attempt ⇒ `validation` ([ADR-0029](../../decisions/0029-tool-policy-hardening.md)).
4. **Assemble messages.** `system` = **authored text ONLY** (`agent.system_prompt` + `node.system_prompt_append`), concatenated **verbatim — 1.O does not interpolate the system role**, so an untrusted `{{ run.outputs }}` / `read_file` reference can never resolve into `system` (it ships as literal authored text). The parser still *collects* a `{{ … }}` reference in `system_prompt_append` for the parse-time **secret-taint** scan (catching a stray `{{ secrets.* }}`), but does not promise dispatch-time resolution of system fields. Only the resolved `prompt_template` — which may draw on untrusted `run.outputs` / `read_file` — lands in a **`user`** position, never `system` ([security-review.md §Prompt-injection](../../standards/security-review.md#prompt-injection-posture), the structural placement guarantee — no value-level taint carrier needed for an agent node, which cannot launder a secret into `run.outputs`). *(A future parse-time gate that admits trusted `{{ inputs }}` / `{{ ctx }}` in system fields while rejecting untrusted sources is a recorded follow-up.)*
5. **`output_schema` (node override wins over the agent default).** Lowered to `LlmRequest.responseFormat` (a **request-side hint**), **and** validated **node-side**: the seam's `responseFormat` does not guarantee a schema-conformant response (DeepSeek degrades to bare `json_object`), so the runner parses the output and a non-JSON result ⇒ `validation` ([ADR-0038](../../decisions/0038-agentrunner-llm-call-boundary.md), [error-handling.md](../../standards/error-handling.md)). The check is **two steps**: the output is parsed as JSON, then validated against the **compiled** `output_schema` — a conformance miss is `validation` (`retryable: false`), exactly as ADR-0038 required. Compilation uses the allowlist-strict JSON-Schema subset ([ADR-0092](../../decisions/0092-output-schema-is-validated-by-the-compiler-we-already-own.md); the subset is a written contract, and a schema outside it is refused at parse rather than silently unenforced). *(This clause read "parse-as-JSON; deep conformance deferred… needs a validator dependency" until 2026-09-02 — the dependency premise was false, the compiler was already in-house.)*
6. **Run the turn core**, map its result to `NodeOutcome.completed` (`output` = the parsed structured value or the assistant text; `tokensUsed = { input, output, model }`), or map a classified `AgentTurnError` to `NodeOutcome.failed`.

## The turn loop + the failure ladder

The core streams one turn (emitting `agent:token` per text delta, accumulating text / tool-call / reasoning parts), and on a `tool_use` stop appends the assistant turn (**including its reasoning `ContentPart`** for the same-provider replay, [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md)), dispatches each tool call, appends the results, and continues — bounded by a **runner-default max-tool-turns cap** (a DoS guard; the authored hard cap + the loud `turn_limit` surfacing is the 1.V session knob).

The error mapping to the closed `ErrorCode` ([error-handling.md](../../standards/error-handling.md)) — **cancel wins** over all others:

| Source | `ErrorCode` | Retryable | Note |
|--------|-------------|-----------|------|
| abort (`ctx.signal`) / `ToolCancelledError` / chain `cancelled` | `cancelled` | false | precedence over every other classification |
| `ToolPolicyError` | `tool_denied` | false | **not** fed back as a correctable result (re-asking a denied tool burns budget) — EXCEPT `media_scope_denied`, a Step-14 `recoverable` SCOPE denial fed back on the `recoverToolFailures` surfaces (chat / Home / one-shot `agent run`); see the `recoverable` note in [tool-registry.md §error taxonomy](tool-registry.md#error-taxonomy) |
| `UnknownToolError` / `ToolArgsInvalidError` | (model-correctable) | — | converted to an `isError` tool result fed back, within a bounded correction budget; after it ⇒ `tool_failed` |
| `ToolExecutionError` | `tool_failed` | true | |
| absent host capability (`ToolUnavailableError`) | `tool_unavailable` | false | a host/config gap — names the unwired arm actionably, never a bare `internal` (EA1, [ADR-0055](../../decisions/0055-cli-host-capability-seam-tool-environment-factory.md)) |
| chain-exhausted `LlmError` | `provider_auth` / `provider_rate_limit` / `provider_unavailable` / `content_filter` (content_filter, 1.AG/ADR-0045 §6) / `validation` (bad_request) / `internal` (unknown) | per `LlmError.retryable` | classified from `error.kind`, never `error.message` |
| max-tool-turns hit | `turn_limit` | false | |

## Events

The runner emits, per [sse-event-schema.md](../contracts/sse-event-schema.md) (envelope-less; the bus stamps `runId`/`timestamp`/`sequenceNumber`):

- `agent:token` `{ nodeId, token, model }` — `model` is the active attempt's model (see the model-attribution note in `agent-turn.ts`; the accurate per-attempt model is always on `cost:updated`).
- `agent:reasoning` `{ nodeId, text, model }` — a streaming reasoning ("thinking") delta (EA6, 2.5.H — the reasoning counterpart of `agent:token`, one per `reasoning_delta`); `model` follows the same mid-stream attribution note. Never carries the ephemeral same-provider `signature` (ADR-0030).
- `agent:tool_call` `{ nodeId, model, toolId, toolInput, attemptNumber? }` and `agent:tool_result` `{ nodeId, toolId, success, outputSummary, attemptNumber? }` — **assembled** from the registry's partial `events.call`/`events.result` (the runner adds `type` + `nodeId` + `model`); the registry does not carry them.
- `cost:updated` `{ nodeId, model, inputTokens, outputTokens, costMicrocents, cumulativeCostMicrocents, attemptNumber? }` — one per **non-skipped** attempt; `attemptNumber` counts non-skipped records. `cumulativeCostMicrocents` is a **placeholder** the engine overwrites authoritatively (it owns the run-wide total).

The runner emits **no** `budget:*` / `run_timeout` (run-level, not in the in-node set). Its
host-owned pre-egress hook gates each actual provider attempt, including retries, failovers and
later tool rounds; it runs before credential resolution and provider invocation.

## Pre-egress injection contract

`PreEgressHook(info)` receives the required `PreEgressInfo` union and may return an admission
lease, synchronously or asynchronously. A refusal prevents that attempt's egress. The hook owns
no message body or credential. The chain's cap projection has its canonical home in the
[LLM seam](llm-provider-seam.md#current-request-estimates-and-bound-output-caps).

| Route | Required fields |
|---|---|
| `text` | The complete `PreAttemptInfo`: `model`, `provider`, actual `endpoint`, `maxTokens`, `providerOptions`, `outputCapPlan`; plus current-round **pre-strip** `inputTokensEstimate` and `maxTokensEstimate` |
| `generative-media` | `model`, `provider`, actual `endpoint`; literal zero `inputTokensEstimate`, `maxTokens` and `outputTokensEstimate` |

Both routes may carry `outputModalities` and disjoint `mediaUnitsEstimate`. Text `maxTokens`,
`providerOptions` and `maxTokensEstimate` have required keys allowing `undefined`. The turn core
computes input from the constructed current request's system text, messages, advertised tools
and JSON response format/output schema before dialect-specific stripping; it recomputes after a
tool round rather than reusing provider usage.

All governor evaluation, admission and commitment-restoration entry points consume the whole
object. The host captures `max_tokens_estimate` once and forwards it through workflow,
fresh/resumed/reseated chat and one-shot session construction, including sessions without a
money governor. `NodeExecContext.maxTokensEstimate` supplies the workflow value; a directly
constructed runner can receive it through `AgentRunnerDeps.maxTokensEstimate`.

The governor inserts an accepted priced reservation synchronously after evaluation and before
any host notice or warning write. A reentrant partial-pricing notice therefore sees that live
reservation. Non-strict fail/pause verdicts reserve nothing and still announce their partial-pricing gap.
Warning admissions await their shared durable warning; a failed write releases each admission.

Before invoking the hook, the turn joins the run's shared realized/conservative money barrier,
including turns without a budget hook. A pending sibling write blocks admission, credential
resolution and provider egress; its failure retains the sibling's attribution. Both chains drain
their current tails, including writes appended during the wait. The shared barrier rechecks the
realized tail after conservative flushing so a cross-chain append also blocks continuation.
Its stable point covers charges already recorded; later charges enter the next barrier. Cancellation is
checked after that join before the no-hook return, and again after any awaited admission; a
newly acquired admission is released before cancellation propagates.

An admission settles from accountable usage. A usage-less failed attempt releases only with
positive pre-provider proof, or an actual **official** endpoint's pre-content HTTP status in
`429, 400, 401, 402, 403, 404, 413, 422`. A returned generation, even empty, and every forwarded
non-stop/non-error stream chunk establish processing evidence. Custom routes and uncertain
failures retain the reserved estimate. Chain-owned facts cannot be replaced by an accounting
or observer exception; observers run once outside provider error normalization.

**W7 step 6, 2026-10-02:** the required hook, current-request financial estimate and cap-plan
handoff foundation are implemented. Automatic session pre-send/summary handoff remains step 8;
bounded approval allowances remain step 9, as tracked in the
[W7 execution plan](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).
