# ADR-0090: A continuation token rides the part it belongs to (supersedes ADR-0089 §3)

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0089-media-correctness-four-boundaries.md](0089-media-correctness-four-boundaries.md) (**supersedes its §3 only**; §1, §2 and §4 stand unchanged), [0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) (**refines** — the ephemeral-signature discipline, and the `reasoning.signature` precedent this copies), [0039-same-provider-reasoning-replay.md](0039-same-provider-reasoning-replay.md) (**refines** — the Gemini `functionCall` deferral this closes, by the mechanism that ADR predicted and ADR-0089 §3 wrongly talked itself out of), [0031-llm-seam-shape-amendment-multimodal-io.md](0031-llm-seam-shape-amendment-multimodal-io.md) (the in-flight/durable `ContentPart` fork this reuses), [0043-media-egress-failover-rematerialization-ssrf.md](0043-media-egress-failover-rematerialization-ssrf.md) (§4's sidecar, whose scope ADR-0089 §3 misread as transferable), [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md) (no vendor type crosses the seam), [../reference/shared-core/llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the seam's canonical home), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`CR-52`).

## Context

[ADR-0089](0089-media-correctness-four-boundaries.md) §3 decided that Gemini's function-call
`thoughtSignature` would be captured into "a sidecar whose lifetime is one request/turn" and replayed on the
continuation, explicitly rejecting an optional `signature?` on the canonical `tool_call` part. Implementation
found the decision unbuildable, and the reasoning that produced it wrong on both halves.

**The mechanism cannot work.** Capture and replay happen in *different adapter calls*. A tool loop is
`generate()` → the model returns a `functionCall` → the engine runs the tool → `generate()` again, carrying the
`tool_call` and its `tool_result`. Gemini's adapter constructs `new GeminiToolCallIds()` **inside** each
`generate`/`stream` (`gemini.ts`), and `createGeminiAdapter()` returns a stateless object that
`defaultProviders()` builds once and reuses across every run. So a per-*request* sidecar is structurally
incapable of carrying a token from call N to call N+1, and a per-*turn* one has nowhere to live: the adapter
holds no turn-scoped state, and the only channel from the engine into an adapter is `LlmRequest`.

**The premise behind "request/turn" was a conflation.** §3 argued that "a within-turn tool loop is in-process,
so a sidecar's lifetime is exactly the token's permitted lifetime". In-process is not in-one-call. The
[ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) §4 sidecar it cited as precedent works for a
different reason than the one §3 gave: the **`FallbackChain`** owns it and re-materializes *before* invoking the
adapter, so the value it holds never has to survive an adapter boundary. There is no symmetric hook for a token
the adapter itself must place on the wire.

**And the objection to the rejected alternative was false.** §3 refused a field on `tool_call` because it
"would flow into `DurableContentPart`, so 'it must never persist' becomes a property a **test** defends rather
than one the **type** makes impossible." The corpus had already solved exactly this, one part over:
`reasoning.signature` rides the canonical `ContentPart`, and `DurableContentPartSchema` composes a **separate**
`durableReasoningPartSchema` that simply has no `signature` field (`content.ts`) — "the persisted type simply
has no field to put it in", a compiler-proof strip. The mechanism §3 said did not exist is the one ADR-0030
established and ADR-0039 assumed when it recorded this deferral as needing "a continuation-metadata carrier on
the canonical `tool_call` (and reasoning) parts".

The stakes: without the replay, Gemini 3 thinking-plus-function-calling continuations lose the signature and
can 400 — the defect `CR-52` exists to close — and the shipped `tool_call` arm is shared between the in-flight
and durable unions, so getting the fork wrong would put a provider continuity token into a persisted
transcript, which [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md)
forbids outright.

## Decision

**We will carry a provider continuation token on the canonical `tool_call` part, and fork the durable arm so it
cannot persist — exactly as `reasoning.signature` already does.** ADR-0089 §3 is superseded; its other three
sections are untouched and remain authoritative.

1. **`tool_call` gains an optional `signature?: string`** on the in-flight `ContentPart`: an opaque,
   provider-owned continuity token, never interpreted by the engine, meaningful only to the provider that
   issued it. The name matches `reasoning.signature` deliberately — it is the same concept on a second part,
   and a reader who knows one now knows the other.

2. **`DurableContentPartSchema` composes a `durableToolCallPartSchema` that has no such field.** The strip is
   structural, not a refine and not a test: parsing an in-flight part through the durable union produces a part
   with the token gone, and no durable position can express one. This is the `durableReasoningPartSchema` move,
   applied to the arm beside it.

3. **The same-provider rule is inherited, not re-invented.**
   [ADR-0039](0039-same-provider-reasoning-replay.md)'s strip-on-failover already governs replay: a token is
   replayed only to the provider that issued it, and a cross-provider advance strips it. Extending that latch
   to cover `tool_call.signature` alongside `reasoning.signature` is one predicate, not a second policy.

4. **Gemini captures on the way in and replays on the way out.** The response fold reads `thoughtSignature` off
   a `functionCall` part (today it is read only for `thought: true` parts, which is the bug), and
   `toGeminiParts` puts it back on the outgoing `functionCall`. Both the streaming and non-streaming folds
   capture, because a tool loop can run on either.

*Considered:* **(a)** the ADR-0089 §3 sidecar — rejected: unbuildable, for the reasons in Context; a per-request
scope cannot bridge two calls and a stateless adapter has no per-turn scope. **(b)** a provider-opaque
continuation map on `LlmRequest` (`{ toolCallId → token }`) rather than on the part — rejected: requests are
ephemeral so the persistence property would come free, but the token still has to get *out* of a response,
which means a field on the response part anyway; and it would put the engine in the business of routing an
opaque provider token between calls, which is precisely what ADR-0030's discipline keeps out of the engine.
**(c)** carrying it in `providerOptions`/`raw` — rejected outright: vendor-shaped, invisible to the durable
type split, and forbidden by [ADR-0011](0011-internal-llm-abstraction.md).

## Consequences

### Positive

- `CR-52` becomes implementable at all, and closes ADR-0039's recorded deferral by the mechanism that ADR
  predicted rather than by a second one invented beside it.
- One concept, one shape: a continuity token rides the part it belongs to, on both parts that can carry one,
  and both are stripped by a durable arm that has no field for them. A future third case has a pattern to copy.
- The "never persists" guarantee is enforced by the compiler on both parts, which is strictly stronger than the
  sidecar would have been — a sidecar is invisible to the type system, as ADR-0089's own Consequences admitted.

### Negative

- The frozen `ContentPart` shape grows an optional field. Additive and therefore non-breaking, but
  [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) froze this union deliberately and every addition
  spends some of that stability — mitigated by it being the *second* instance of an established shape rather
  than a new idea, and by the durable fork landing in the same change.
- `toolCallPartSchema` stops being shared between the two unions, so a future field added to it must be
  consciously placed in one or both. That is the cost the reasoning fork already pays; the mitigation is that
  the durable arm's absence of a field is the whole mechanism, so it is not a subtlety a reader can miss.
- A superseded section one day after its ADR was accepted. Recorded plainly rather than quietly rewritten
  (ADRs are append-only): ADR-0089 §3 stands in history with its reasoning, and this ADR says which half of
  that reasoning was wrong and why, so the next reader inherits the correction rather than the confidence.
