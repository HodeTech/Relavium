# AgentRunner (1.O) — the agent-node executor

> Status: Living

> Last updated: 2026-10-04

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

The engine's execution context supplies `continueReceipt`, from which the runner derives a
call-local producer-lifetime hook. Preparation grants no receipt authority. The chat turn passes
that hook separately from `ChainCapabilities` and request data; the separate-endpoint generative
path uses it before invoking `generateMedia`. Both retain the raw producer before the existing
deadline race. A refused registration preserves host-error identity and engages no provider;
proven pre-egress generative admission is released. Late completion changes lifetime only,
without a second attempt/cost event, media pin, save or ordinary execution restart. See the
[canonical chain lifetime contract](llm-provider-seam.md#the-per-attempt-deadline).
The chain and separate media submission pass that authority through the provider's optional
invocation argument, outside request data. Each engine-owned media poll creates a new retained
raw scope, including its key resolution, and forwards a poll-local invocation hook; it never reuses
the settled submission context. Poll status and binary-download transport children remain owed
through that invocation's independent aggregate. Existing bounded outcomes and once-only media
accounting are preserved. Custom providers also receive invocation-local authority that retires
before bounded completion, fallback or consumer return, while admitted descendants remain joined.
Invocation transfer is itself a synchronous host boundary. The runner/chain recheck caller and
merged-deadline cancellation after it, before marking an attempt invoked or calling the captured
provider method. Proven pre-egress refusal retires the aggregate and refunds unused admission.
The engine's [departure contract](../../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103)
owns the complete actor and final-health barrier; the runner does not certify host closure itself.


The runner owns the **cost path** itself — one `CostTracker` per node execution and its own `onAttempt`→`cost:updated` — never a host-supplied (shared) tracker, because the executor is shared across concurrent runs.

## What the adapter does for an `agent` vertex

1. **Resolve the agent.** An absent `resolvedAgent` ([run-plan.md §AgentPlanConfig](run-plan.md)) ⇒ `NodeFailure{ code: 'validation' }` naming the `agent_ref` (an authoring error — distinct from an unresolved provider id, which is `internal`). Never a raw throw.
2. **Build the fallback plan.** The primary uses `node.model ?? agent.model`. With an authored `node.retry ?? agent.retry` budget it has one within-chain attempt; without one it has the shared runner's unauthored two-attempt default. Above-chain node retry does not multiply within-chain primary attempts ([ADR-0040](../../decisions/0040-node-retry-budget-above-the-chain.md)). Each `fallback_chain` entry keeps its own `max_attempts`. **One `FallbackChain` per node execution**, reused across the tool loop so per-provider cooldown and the [ADR-0039](../../decisions/0039-same-provider-reasoning-replay.md) strip-latch survive.
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
| official `LlmError.context_overflow` | `context_overflow` | no | fixed engine-authored message names the actual attempted model and its authoritative window (or `size unknown`), and whether tools ran; never provider text |
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
lease, synchronously or asynchronously. A refusal prevents that attempt's egress. The hook has
process-local access to the current owned construction through `allowanceQuoteContext`; the request
body and provider options never enter the durable allowance quote or run events, and no credential is
passed to this hook. Controlled request ownership is specified once in the
[LLM seam](llm-provider-seam.md#request-data-ownership). Core prepares its first round before measurement
and quotes and executes that exact factory request with only the live execution signal overlaid.
`prepareAgentTurnRequest` returns `{ request, inputTokensEstimate }`; execution accepts that exact
request through `preparedRequest`, refusing a borrowed spread. Incoming `preparedOutputCaps` remains
supported and is validated by the same ownership/cap authority. The chain's cap projection has its
canonical home in the
[LLM seam](llm-provider-seam.md#current-request-estimates-and-bound-output-caps).

| Route | Required fields |
|---|---|
| `text` | The complete `PreAttemptInfo`: `model`, `provider`, actual `endpoint`, `maxTokens`, `providerOptions`, `outputCapPlan`; plus current-round **pre-strip** `inputTokensEstimate` and `maxTokensEstimate` |
| `generative-media` | `model`, `provider`, actual `endpoint`; literal zero `inputTokensEstimate`, `maxTokens` and `outputTokensEstimate` |

Both routes may carry `outputModalities` and disjoint `mediaUnitsEstimate`. Text `maxTokens`,
`providerOptions` and `maxTokensEstimate` have required keys allowing `undefined`. The turn core
computes input from the owned current request's system text, messages, advertised tools
and JSON response format/output schema before dialect-specific stripping. The pre-attempt hook closes
over that request and estimate before money durability can await; it never rebuilds from caller data
afterward. A real tool result creates a fresh owned round and estimate from owned static fields and
working history rather than provider usage. The current core input surface does not carry native
provider options, tool choice or stop sequences; no heterogeneous native-serializer continuation
guarantee is claimed for its later tool-round reconstruction. Local ownership/cap refusals are fixed,
nonretryable `validation` outcomes; existing observer/money/cancellation provenance remains intact.

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
positive pre-provider proof, or an actual **official** endpoint's classified pre-content
`context_overflow`, or its pre-content HTTP status in
`429, 400, 401, 402, 403, 404, 413, 422`. A returned generation, even empty, and every forwarded
non-stop/non-error stream chunk establish processing evidence. A rejected generated response with
accountable usage also proves processing; its actual quantities settle once and are never refunded. Custom routes and uncertain
failures retain the reserved estimate. Chain-owned facts cannot be replaced by an accounting
or observer exception; observers run once outside provider error normalization.

The turn and generative runner also attach process-local `allowanceQuoteContext`: the paused raw
construction and eligible plan, current input estimate, actual lowered tools, configured output
fallback and turn limit. The generative fork supplies only its primary and authored media volume.
The governor freezes scalar `AllowanceQuoteResult` onto `BudgetPauseError`/`GateRequest`; raw
requests, native options, cap plans, provider objects and closures never enter that quote.

`AgentTurnError.recoverableOverflow` is diagnostic, not recovery authority. Session recovery requires
private evidence joined by exact error identity to the current failed, invoked official provider
attempt, before any tool round or received content. Admission/credential faults and an earlier
capture cannot supply that evidence. It is not an event field; the session owns the once-only
compaction and fresh retry. A later tool-round overflow ends
the turn without redispatching tools. Generative media paths never acquire session recovery;
their overflow mapping also uses fixed facts and preserves custom-endpoint authority.

### Dispatch allowance foundation

[ADR-0097](../../decisions/0097-a-budget-approval-is-an-allowance-not-an-exemption.md) sizes the
frozen amount as **calls × eligible chain attempts × largest current E**. Advertised tools give
`maxToolTurns + 1` calls; no lowered tools or inline media gives one. Generative media has one
primary call/attempt and zero text tokens. Node retry does not multiply A; cooldown remains in
the eligible plan. Capability/streaming skips and unknown pricing are structured exclusions.
Non-strict partial media pricing retains its priced part; strict gaps are excluded/refused.
Priced zero, wholly unpriced and unrepresentable results are distinct. The full price/eligibility
comparison covers quantities, rates, tiers, route, calls, attempts, endpoint and every priced and
excluded candidate; equal A alone is insufficient, including at zero volume.

The trusted governor API activates an opaque, process-local dispatch token with a frozen safe
amount and a host lifetime predicate. Tokens belong to one governor/node/dispatch; stale dispatch
identities cannot replace newer owners. Evaluation, owner debit and global reservation have no
callback or await between them. Owned calls debit under the cap too, including an unbounded
configured cap. One in-flight slot prevents another call before settlement reconciles realized
under-spend/overrun; proven release refunds, uncertain settlement retains. Global money changes
before the settlement's host predicate runs. Late actuals remain global truth but cannot refund or
revive a replacement owner. Lifetime is rechecked after pricing, durability/legacy holds, notices
and warning awaits; failed warning writes release the admission.

A rejected unsafe actual text settlement retains safe E with its attempt attribution before
propagating the accounting error, so the admission cannot remain orphaned in flight. Generative
settlement carries the priced flag: unknown model/modality pricing retains E while publishing
the existing unpriced result; a known zero reconciles as genuinely free. Post-provider
pricing/outcome exceptions retain any still-owned admission. Already settled event-sink failures
do not duplicate conservative spend; proven pre-egress key/cancel failures refund, and async
jobs transfer their held admission. The engine's parked-job consumer applies the same distinction
on done, failed, deadline and cancellation: pricing gaps retain E, and accounting faults finish
the transferred admission before the poll backstop handles them. Its early exactly-once marker
prevents callback reentry from billing twice. Terminal accounting guards each job independently
so one fault cannot skip the remaining jobs or timer/lease/stream cleanup; cancellation and an
earlier failure retain precedence. Conservative commitments remain separate from actual cost.
The exact submitted admission is captured before fallible park-time clock/date work; until
the parked record owns it, failure conserves E. The poll backstop similarly conserves an
unsettled admission before removing its job. Park-time cancellation prevents registration
after terminal cleanup, and timer installation disposes a handle if its callback has already
cleared that job. Immediate cancellation and the early exactly-once marker remain, while
terminal accounting joins any active cost fold before capturing the durable total.

Native generation prices the authored output volume through the existing rate-only
`estimateMediaCost` kernel rather than constructing provider-reported `Usage`. Image counts remain
non-negative safe integers; audio/video seconds may be fractional. The kernel rounds the charge
once to integer micro-cents and refuses malformed volume or unsafe cost before the engine folds it.
Both synchronous completion and parked-job settlement use this path; the integer `Usage` contract
and priced-versus-gap settlement above are unchanged.

A consumed positive allowance, a prospective E larger than the remainder, an unsafe E or a real
overdraw closes later admission with `budget_exceeded`; it cannot produce a new pause or retry.
An originally zero allowance still admits a genuinely free call and ordinary non-strict unpriced
usage until positive actual spend or forced exhaustion closes it. Unknown E has lifecycle ownership
without a fabricated global reservation; a later known actual debits that same owner. A known zero
has an explicit zero reservation and cannot manufacture a positive commitment event. Strict-cost
refusals are never overridden.

### Preparing and resuming a budget dispatch

The optional `NodeExecutor.prepareBudgetDispatch(NodePreparationContext)` capability prepares the
actual next request without events, credentials, provider calls, tool dispatch, monetary admission or
host notices. Its context contains only the vertex, admitted inputs, completed outputs, resolved
context, secret names, tool policy, signal and configured output estimate. The standard runner and
node dispatcher provide it through the same prompt/tool/plan construction used by ordinary execution.
An executor without this capability can reject a frozen gate; it cannot approve its allowance.

A cross-process host may first compare the frozen quote's recorded priced quantities with current
rates before secret input, credential-resolver construction or MCP connection. This price-only
refusal uses the same rate comparison as full validation; a match grants no dispatch authority.
The CLI reads existing catalog/overlay rows without seeding them for this check and reuses the
resume command's database connection when constructing its resolvers. The engine still performs
the complete current request, eligibility, exclusion and price comparison described below.

A successful preparation retains ephemeral `quote(...)` and `execute(ctx)` capabilities. Text retains
the actual request and candidate-specific cap plans; generative media retains its primary request and
authored volume. The current price overlay is read at validation. The full quote must match the frozen
scalar evidence before claiming the gate, and the prepared request is used for the first approved
attempt so a second prompt/file read cannot replace the request just approved. Generation notices
remain deferred until actual execution. Raw options, provider instances and closures stay process-local.

Aggregate pause waits for all in-flight gate pause publications, including each budget authority
and its companions, before handing back a waiting-only run's lease. Parallel budget gates and
ordinary human siblings therefore cannot reacquire and retain ownership after aggregate handoff.
A claimed gate keeps the lease while its decision work is in flight. An ordinary human gate
also stays visible while its payload is pinned, until its vertex can be completed; that
preparation is not a stalled run. Media-job polling keeps its existing ownership.

The engine observes durable authority and companion acknowledgements before handing the approved
safe amount to a new dispatch token. The pre-egress hook remains installed on **every** attempt,
fallback, tool round and above-chain node retry. One dispatch token spans that node's retry/backoff
lifetime and closes when it completes, fails, parks, is cancelled, abandoned or loses ownership.
Exhaustion is fatal `budget_exceeded`; it neither retries nor creates a fresh budget pause.

A cancellation request for a known cross-process resume also covers passive context, quote and
effect admission before execution registration. It carries the preparation signal into the retained
request builder, latches cancellation without scheduling or arming a grace timer, and renews the
exact acquired fence before settling a cancelled outcome. A successor or unconfirmable owner
receives no terminal from the abandoned preparation. Command signals continue to the active
execution and the returned handle; a late acknowledged decision remains durable and cannot grant
post-cancellation egress.

The Node CLI host yields across a poll turn after a successful decision append, before exposing
its acknowledgement to the engine, so an OS signal queued during native SQLite contention can
reach this cancellation path before dispatch. The row is already committed and is not undone.
This host-specific scheduling belongs outside Core. A delivered terminal with uncertain durability
uses the terminal-outbox outcome, not the nonterminal ownership-refusal path; the canonical
[CLI exit codes](../cli/commands.md#exit-codes) distinguish them.

Cross-process amount/kind/request validation occurs before execution registration. Constructor seeding
is passive; context and effect-journal admission precede timers, media polling and dispatch. After an
asynchronous preflight, the engine rechecks the whole current quote. It then atomically renews
the exact acquired owner/generation fence before any registration or activation. This check also
precedes a refused admission's settlement. A takeover or unconfirmable lease causes a
transient, safe `run_owned_elsewhere` refusal before registration, timers, key resolution or
polling; cleanup releases only the original fence. An expired claim with no successor renews
without minting another generation. Renewal confirms ownership at the store operation. An
unbounded asynchronous host ACK can outlive that renewal's TTL before activation; it is not a
universal freshness guarantee. Later loss is observed through the existing liveness and write
fences. The local SQLite lease operation is synchronous. Every pre-activation refusal and already-terminal no-op
attempts to release its exact acquired fence. A rejected cleanup preserves the primary typed
refusal or closed handle and leaves the existing bounded TTL; it cannot release a successor
or surface private cleanup text. A supplied target decision is
applied before its timer could be armed; surviving gates keep their absolute remaining deadlines.
Effect refusal retains priority over authorization. A reconstructed approval does not restore a
token or pretend the agent completed: an eligible kick re-runs under the current budget checks.
Legacy approval likewise grants no allowance. The durable protocol and join rules have one home in
[sse-event-schema.md](../contracts/sse-event-schema.md#durable-budget-authorization).

**W7 status, 2026-10-04:** Step 10's workflow approval protocol is accepted after eight independent
review rounds. Step 11's safe CLI surface is accepted after three independent review rounds;
automatic session pre-send/summary handoff remains Step 8. See the
[W7 execution plan](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md).

### W7 implementation landing — 2026-10-10

The earlier dated W7 status is historical. Measured request reuse, atomic multi-pass compaction,
pre-send and single pre-content overflow recovery, finite frozen allowances and the CLI resume surface
are implemented with scoped independent acceptance. The
[closing register](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10)
tracks final whole-wave acceptance and approved limits; CR-82 and W8 remain open.
