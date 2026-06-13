# ADR-0030: `@relavium/llm` seam-shape amendment — reasoning channel, responseFormat, providerExecuted

- **Status**: Accepted
- **Date**: 2026-06-07
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md) (the seam ADR this amends), [0029-tool-policy-hardening.md](0029-tool-policy-hardening.md) (the same "tighten the contract before it has consumers" move; the tool allowlist that makes `providerExecuted` matter), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0039-same-provider-reasoning-replay.md](0039-same-provider-reasoning-replay.md) (**adds the same-provider reasoning-replay *behavior* the channel below left shape-only**), [../reference/shared-core/llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the seam's one canonical home), [../standards/error-handling.md](../standards/error-handling.md)

> **Amended 2026-06-14 by [ADR-0039](0039-same-provider-reasoning-replay.md)** (append-only — this body
> is unchanged): the reasoning channel below was landed **shape-only**, with the intent that "only the
> originating adapter feeds it back." ADR-0039 supplies the missing **replay behavior** — the originating
> Anthropic adapter lowers a *surviving* signed reasoning part back to a `thinking` block (at both the
> `toAnthropicBlock` type and the `toAnthropicMessage` filter), the `FallbackChain`'s cross-provider
> strip-latch (`#lastProvider`) moves from per-call `ChainRun` scope to **chain-instance** scope so it
> survives a multi-turn tool loop, and the `AgentRunner` carries the signed part through a same-provider
> continuation. **Anthropic `redacted_thinking` replay** (the opaque `data` is dropped on the way in) and
> **Gemini part-level `thoughtSignature`** (incl. on a `functionCall`) need a canonical opaque-continuation
> carrier and are recorded follow-ups against this ADR's shape.

## Context

The `@relavium/llm` seam — the request/result/stream/usage/content shapes in
[`packages/llm/src/types.ts`](../../packages/llm/src/types.ts) and
[`packages/shared/src/content.ts`](../../packages/shared/src/content.ts) — is the immovable contract
of [ADR-0011](0011-internal-llm-abstraction.md). The three Phase-1 adapters (Anthropic, the shared
OpenAI/DeepSeek adapter, Gemini) now pass the shared conformance suite, so the seam is at the **M1
freeze boundary**. Crucially, **no consumer beyond the adapters exists yet** — the `FallbackChain`
(1.K), the engine (`AgentRunner`/`WorkflowEngine`, 1.O/1.N), the session layer (1.V–1.Z) and the
surfaces are all unbuilt. This is the same situation [ADR-0029](0029-tool-policy-hardening.md) acted
on: a contract change is nearly free before it has consumers and a breaking change after.

The ADR-0011 seam rule (recorded in [llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md))
distinguishes two kinds of change: **adding a provider id is additive** (no ADR — it alters no
existing type); **changing the seam *shape*** — the request/result/stream/usage/content types — is a
real amendment that requires an ADR. Three shape gaps were assessed against the actual pinned SDKs
and the already-merged contracts. Each is a genuine **cross-provider** concern the current seam
cannot express, not a single-provider quirk (those go through `providerOptions` + a capability flag):

1. **Reasoning is advertised but undeliverable.** `CapabilityFlags.reasoning` exists and is set
   `true` for Anthropic/Gemini/DeepSeek, yet the seam has **no channel** to carry the reasoning it
   promises, so all three adapters silently drop it today. The three providers expose reasoning in
   three incompatible native shapes (Anthropic first-class `thinking`/`signature` block-deltas;
   Gemini `thought`-flagged parts with a base64 `thoughtSignature`; DeepSeek/Kimi an untyped
   `reasoning_content` field over the OpenAI-compatible wire). Reasoning text can only reach a
   consumer today as a vendor-shaped blob on `LlmResult.raw` — re-introducing exactly the
   vendor-coupling ADR-0011 exists to prevent, and making the ephemeral-signature guarantee
   unenforceable at the seam.

2. **`responseFormat` is the missing mechanism for an already-merged contract.** `output_schema` is
   already shipped on `agent`/`transform` nodes ([`packages/shared/src/node.ts`](../../packages/shared/src/node.ts)
   `OutputSchemaSchema`), but the LLM seam has no way to ask a model for structured output, so the
   node feature is unimplementable until the seam can carry it.

3. **`providerExecuted` distinguishes server-run tools from engine-run tools.** Providers increasingly
   run tools on their own side (Anthropic `web_search`/`code_execution`, Gemini `googleSearch`,
   OpenAI Responses built-ins). Without a discriminator, the engine `ToolDispatcher` (1.T, allowlist
   [ADR-0029](0029-tool-policy-hardening.md)) cannot tell "I must run this" from "the provider already
   ran this" — risking double-execution and mis-applying the engine's tool-permission model to a call
   the engine never makes.

An adversarial assessment refined the urgency: only a change that adds a **member to a discriminated
union** (`StreamChunk` / `ContentPart`) is genuinely breaking-to-add-later, because every consumer's
exhaustive `switch` + `never`-exhaustiveness check breaks at compile time. Adding an **optional
field** (to `LlmRequest`, or to an existing union arm) is backwards-compatible and could in principle
be deferred to the consumer that needs it. We nonetheless settle all three **now**, in one amendment,
because (a) the reasoning channel and the provider-executed stream chunk *are* union-member additions
that must land before consumers narrow on the frozen shape, and (b) doing the one ADR + one seam edit
once — while the only consumers are the three adapters we are already editing — is cheaper and less
error-prone than three separate future amendments, each re-touching every adapter.

## Decision

**We will extend the `@relavium/llm` seam shape with three additive features, recorded as an
amendment to (not a supersession of) [ADR-0011](0011-internal-llm-abstraction.md).** ADR-0011's
decision — an internal, provider-agnostic seam in Relavium/Zod types with no vendor SDK type crossing
it — is unchanged; this only grows the seam's shape. The canonical types live in
[llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md); the additions are:

**1. Reasoning channel (additive).**
- `ContentPart` gains a `reasoning` arm: `{ type: 'reasoning', text, signature?, redacted? }`.
- `StreamChunk` gains `reasoning_start` / `reasoning_delta` / `reasoning_end` (mirroring the
  `tool_call_*` triad; `id` correlates deltas to the terminating `reasoning_end`, which carries the
  optional `signature`/`redacted`).
- `Usage` gains an optional `reasoningTokens` — **observability only**; the cost math is unchanged
  (every provider counts reasoning inside `outputTokens` for billing, so `CostTracker` keeps billing
  `outputTokens` whole — `reasoningTokens` is never an additional cost line).

**2. `LlmRequest.responseFormat` (additive, optional).** A discriminated union
`{ type: 'text' } | { type: 'json', schema, name?, strict? }` (`schema` is the one canonical
`JSONSchema7`). Each adapter lowers `json` to the provider's **native** structured-output mode where
one exists (OpenAI `response_format: json_schema`; Gemini `responseJsonSchema` + JSON mime type;
Anthropic `output_config`/forced tool) — native-vs-forced-tool is a per-adapter implementation detail,
not a seam concern. We deliberately **drop** the opencode `{ type: 'tool' }` variant: "force a
specific tool" is already expressed by `toolChoice: { name }`, so a third variant would be a
redundant second way to force a tool.

**3. `providerExecuted` (additive).**
- `ContentPart` `tool_call` and `tool_result` gain an optional `providerExecuted?: boolean`.
- `StreamChunk` gains a `tool_result` arm carrying a provider-executed result
  (`{ type: 'tool_result', id, name, result, isError?, providerExecuted: true }`) — distinct from the
  engine-executed `tool_call_start/delta/end` triad. A `providerExecuted === true` call is **skipped**
  by the engine `ToolDispatcher` (1.T): the engine neither runs it nor applies its allowlist to it;
  it only records/forwards it.

**Alternatives weighed.** *(i)* `providerOptions` + the capability flag + `raw` (rejected:
`providerOptions` is request-inbound only and cannot carry reasoning/results back; `raw` is a
vendor-shaped `unknown`, so consumers would pattern-match vendor shapes — the exact coupling ADR-0011
forbids). *(ii)* Defer all three until their consumers exist (rejected for the union-member additions —
breaking-to-add-later; and bundling the optional fields into the same one-time amendment is cheaper
than three future re-touches of every adapter). *(iii)* A full ~16-member opencode-style event union
with `step-*`, media, audio, citations (rejected: speculative; those are deferrable optional/feature
additions to add with their capability when demanded — this amendment stays minimal).

**Guardrails (binding).**
- **Reasoning is ephemeral.** A provider-signed reasoning block (`signature`) is a same-provider,
  same-turn continuity token. It is **never persisted** to a session, **never replayed across a
  provider boundary** (the `FallbackChain`, 1.K, strips reasoning parts when failing over to another
  provider), and **never written to a run event or log**. The engine does not interpret it; only the
  originating adapter feeds it back. `signature` is an opaque `string` (no `Buffer`/Node type — the
  seam stays platform-free, `tsconfig.seam.json` `types: []`).
- **No vendor type crosses the seam.** Each provider's native reasoning/structured-output/server-tool
  shape is normalized to these canonical types inside the adapter; `responseFormat` carries one
  canonical `JSONSchema7`.
- **`providerExecuted` and the engine tool-security model stay disjoint** — the dispatcher applies its
  allowlist only to engine-executed calls; a provider-executed call is never run by the engine.
- **Usage stays NET** ([cost-tracker](../../packages/llm/src/cost-tracker.ts)); `reasoningTokens` is
  an extra disjoint observability count, not a new billable class.

Per-workstream, this lands the **shape** plus the **reasoning + structured-output behavior** wired in
every adapter that supports it (Anthropic/Gemini/DeepSeek reasoning; all three structured output;
OpenAI chat emits no reasoning) with conformance scenarios. `providerExecuted` lands as **shape only**
(no Phase-1 server-tool support is common-path), reserved so 1.T/1.O are born handling it.

## Consequences

### Positive

- The seam is extended at its cheapest possible moment — three adapters, zero downstream consumers —
  avoiding a future breaking discriminated-union change + superseding ADR + consumer rework.
- `CapabilityFlags.reasoning` stops being a dangling promise; reasoning reaches the UI/session as a
  canonical, vendor-neutral channel with an enforceable ephemerality guarantee.
- `output_schema` becomes implementable; the engine can request structured output through one
  canonical field, each adapter using the best native mechanism.
- The engine tool loop is born knowing the difference between a call it must run and one the provider
  already ran — no double-execution, no mis-scoped permission.

### Negative

- A larger seam surface: more `StreamChunk`/`ContentPart` arms for every future consumer to handle
  (mitigated — the additions are minimal and each carries an exhaustiveness obligation that catches
  omissions at compile time).
- `providerExecuted` ships as reserved shape with no Phase-1 emitter, i.e. shape ahead of behavior
  (accepted deliberately: the union-member reservation is the breaking-to-add-later part).
- The reasoning ephemerality guarantee is a standing correctness/data-handling obligation every later
  consumer (fallback, session persistence, run-event logging) must uphold — called out as design
  notes on 1.K and 1.Z.
