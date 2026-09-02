# ADR-0089: Media correctness — the four boundaries `W5` had to choose (refines ADR-0031, ADR-0039, ADR-0042, ADR-0043, ADR-0044, ADR-0070 and ADR-0071)

- **Status**: Accepted
- **Date**: 2026-09-02
- **Related**: [0064-live-model-catalog.md](0064-live-model-catalog.md) + [0065-provider-economics-and-extensibility.md](0065-provider-economics-and-extensibility.md) (§4's pricing precedence — the live tier is **not** a pricing authority; unchanged here), [0070-durable-per-model-session-cost-attribution.md](0070-durable-per-model-session-cost-attribution.md) (**refined** — §6's `priced` flag keeps its shape and its counter, but its derivation moves from `record.cost !== undefined` to `record.priced !== false`), [0031-llm-seam-shape-amendment-multimodal-io.md](0031-llm-seam-shape-amendment-multimodal-io.md) (**refined** — #7's `tool_result.media` arm is left to the provider-executed case it was built for; the engine-executed `read_media` uses the top-level media arm instead), [0039-same-provider-reasoning-replay.md](0039-same-provider-reasoning-replay.md) (**refined** — the deferred Gemini function-call signature replay is resolved without a seam change), [0042-engine-media-storage-substrate-mediastore-deinline-retention.md](0042-engine-media-storage-substrate-mediastore-deinline-retention.md) (**refined** — the `MediaStore` port gains `putStream?`), [0043-media-egress-failover-rematerialization-ssrf.md](0043-media-egress-failover-rematerialization-ssrf.md) (**refined** — §2's "never fully buffered" gains an end-to-end contract; §4's sidecar discipline is extended, with a correction to its scope), [0044-media-access-governance-read-media-save-to-cost.md](0044-media-access-governance-read-media-save-to-cost.md) (**refined** — §1's model-facing `read_media` narrows to a whole handle; §3's "degrades to allow" is confirmed as the NON-strict default), [0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) (the ephemeral-signature discipline the sidecar keeps structural), [0071-models-dev-as-the-model-metadata-source.md](0071-models-dev-as-the-model-metadata-source.md) (**refined** — §K7's `strict_cost_cap` widens from an unpriced model to an unpriced modality; §5's pricing precedence is unchanged), [0028-workflow-resource-governance.md](0028-workflow-resource-governance.md) (the H4 allow-degrade this leaves intact for the non-strict path), [0013-managed-key-vault-and-pools.md](0013-managed-key-vault-and-pools.md) (unaffected — no key path changes), [../reference/shared-core/built-in-tools.md](../reference/shared-core/built-in-tools.md) + [../reference/shared-core/llm-provider-seam.md](../reference/shared-core/llm-provider-seam.md) (the canonical homes this updates), [../standards/testing.md](../standards/testing.md) (the `Range` acceptance clause this re-homes when §1 lands), [../roadmap/phases/phase-2.6.5-core-reliability-remediation.md](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) (`W5`, `CR-50`–`CR-55`).


> **Superseded in part 2026-09-02 by [ADR-0090](0090-a-continuation-token-rides-the-part-it-belongs-to.md): §3 only.** §1, §2 and §4 stand and remain authoritative. §3's per-request sidecar proved unbuildable — capture and replay happen in different adapter calls, and the adapter is stateless — and its stated objection to a field on `tool_call` was false, because `DurableContentPartSchema`'s separate `durableReasoningPartSchema` already makes exactly that guarantee structurally for `reasoning.signature`. Read §3 for the reasoning that was wrong and ADR-0090 for what replaces it.
## Context

Wave `W5` of [phase 2.6.5](../roadmap/phases/phase-2.6.5-core-reliability-remediation.md) closes six media
defects (`CR-50`–`CR-55`). A full review of the media corpus before implementation found that **most of the
wave is unfulfilled obligation, not open question**: ADR-0043 §2 already requires a media body that is "never
fully buffered in process"; ADR-0043 §3 already requires an input URL "re-hosted at ingest". Those need code,
not a decision.

Four boundaries are genuinely undecided, and each sits on a published contract where a wrong guess is
expensive to undo. A first draft of this ADR chose a mechanism for three of them that **the seam cannot
actually execute**; the review that caught it is why the mechanisms below are stated at the level of the
wire, not the intent.

1. **How `read_media`'s result reaches the model.** `tool_result.media` is `DurableMediaPart[]` — handle-only
   by construction — so a byte *range* has no representation in it, and the tool's `start`/`end` parameters
   have nowhere to go. Worse, **nothing resolves that position**: the chain's egress re-materialization
   (`#materializeMedia`) walks `message.content` for top-level `media` parts and never descends into a
   `tool_result` part's `media[]`, and OpenAI's `role:'tool'` lowering *filters the message to `tool_result`
   parts*, so anything else there is silently dropped. ADR-0043 §1 forbids the adapter resolving it itself.
   ([built-in-tools.md](../reference/shared-core/built-in-tools.md) separately describes the output as "the
   bytes as an in-flight source", which the schema has never permitted.)

2. **How a media body reaches the store without being buffered.** The buffering is not at the store — it is
   upstream of it. `MediaUrlFetch` is typed `(url: string) => Promise<Uint8Array>`: the seam materializes the
   whole asset before `MediaStore.put` is ever called. `readBounded` then makes it worse, retaining the chunk
   list *and* allocating the concatenated copy, after which `resolveForEgress`/`readRange` base64-encode the
   whole thing. Adding a streaming method to the *store* alone would leave ADR-0043 §2 exactly as unmet as it
   is today.

3. **Where Gemini's function-call continuation metadata lives.** A `thoughtSignature` riding a `functionCall`
   part is dropped — the fold reads it only for `thought: true` parts. Restoring it looks like it needs a
   field on the canonical `tool_call` part: a change to a frozen shape, putting a provider continuity token
   on a part ADR-0030/0039 forbid from persisting. But the obvious alternative — a process-scoped sidecar —
   is unsound as stated, because Gemini exposes **no native tool-call id**: Relavium synthesizes
   `gemini-tool-<n>-<name>` from a counter that **restarts at 0 for every request**, so two requests collide
   on their first call to the same tool.

4. **What a missing media *rate* means to the cost cap.** `mediaCost` returns `0` for a modality the model
   declares no rate for, and zero is a *price* the governor cannot tell from "nothing to charge" — so paid
   generation is admitted under a cap and reported as `cost:updated = 0`. Two facts constrain the fix: the
   `generateMedia` path does **not** go through a `FallbackChain` attempt record (it emits `cost:updated`
   directly, and `realizedMediaCost` degrades to 0 by design), and **no shipped model carries a media rate at
   all** — the pricing table leaves `mediaOutputRates` undefined on every row, the DB→overlay projection does
   not carry the columns, and `relavium models pricing` accepts only token rates.

The stakes are the usual ones for this corpus: (1) and (3) would freeze an unexecutable shape into a
published contract; (2) is the difference between a bounded download and an out-of-memory on a large video;
(4) is a cost cap that silently is not one — and, done carelessly, a strict cap that refuses **every** media
call with a remedy the user cannot perform.

## Decision

**We will settle the four boundaries as follows.** Each is a refinement of an Accepted ADR, not a
supersession: ADR-0031, ADR-0039, ADR-0042, ADR-0043 and ADR-0044 are unchanged in history and remain
authoritative for everything this does not name.

### 1. `read_media` returns a whole handle; the bytes reach the model as a top-level media part

The model-facing `read_media` tool takes **`handle` only** — `start`/`end` leave its argument schema and its
`llmVisibleParams`. Its `tool_result.result` is a **short text descriptor** (mime type, byte length, and the
handle). The media itself is delivered to the model as an ordinary top-level **`media` `ContentPart` on a
synthesized `user` message** appended immediately after the tool result.

That is deliberately the *media-input* path that already exists and is exercised on all three providers: the
chain's `#materializeMedia` resolves a top-level `handle` source via `MediaStore.resolveForEgress` before the
adapter is called (ADR-0043 §1), `assertMediaCapabilities` gates it per provider and modality, and every
adapter already lowers a top-level media part. **No seam shape changes and no new per-provider wire mapping
is written.**

Two obligations come with the synthesized message and are part of this decision:

- **Its provenance is marked, and it is not user input.** It carries a fixed, engine-authored preamble naming
  the tool and the handle it answers, so the model — and anyone reading a transcript or an exported workflow —
  can see it was produced by `read_media`, not typed by a person. This is the same trust-provenance rule
  `CR-13` applies to a compaction summary: content that originated outside the user must never present as the
  user's own words.
- **It de-inlines and resumes like any other message.** The part is a handle at rest; `resolveForEgress`
  produces the in-flight source per attempt, so a failover or a resume re-resolves from the canonical handle
  and no provider-hosted ref is carried across.

**`tool_result.media` is left alone**, and that is not a workaround: ADR-0031 #7 created it "so the typed
guard reaches provider-executed image-gen results" — the case where the *provider* returns media inside a
tool result. `read_media` is engine-executed, so it is not that case. The field stays reserved for its
purpose, still handle-only, still gated by `assertMediaCapabilities`.

The engine-pure `Range` primitive [ADR-0044](0044-media-access-governance-read-media-save-to-cost.md) §1 built
(`validateByteRange`, fail-closed against the host-populated `byteLength`) is **unchanged**, and its caller is
now stated precisely rather than loosely: the **desktop `read_media(ref)` display command** performs byte
delivery and exercises the `Range` gate; the **model-facing tool** performs handle authorization and metadata
lookup and exercises the **scope-set** gate. What the two share is the scope-set authz, not the range math —
and [testing.md](../standards/testing.md)'s invalid-`Range` acceptance is re-homed to the byte-delivery path
accordingly, not deleted.

*Considered:* **(a)** forking `tool_result.media` into an in-flight (`MediaPart[]`) and a durable
(`DurableMediaPart[]`) variant, mirroring ADR-0031's top-level fork, and teaching each adapter to lower it —
rejected: it is the schema-faithful shape but it does not survive contact with the providers. Only Anthropic
can carry media natively inside a tool result; Gemini's `functionResponse` is a struct and OpenAI's tool
message is a string, so two of three providers need a follow-up message *anyway* — at which point the seam
change buys nothing and the follow-up message is the whole mechanism. **(b)** lowering it only on Anthropic
and capability-gating `read_media` off the other two — rejected: it makes a core tool's availability depend
on which model is bound, which is exactly the kind of surprise `CR-51` exists to remove. **(c)** writing a
byte range back as a **new** content-addressed handle — rejected with the parameters themselves: it makes
every ranged read a store write plus a GC reference, to serve a caller that cannot use bytes 100–200 of a PNG.
**(chosen)** the top-level media part on a marked synthesized message, because it is uniform across providers,
reuses only machinery that already ships and is tested, and changes no contract.

### 2. Streaming is an end-to-end contract, not a store method

We fulfil [ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) §2 across the whole path a media
byte travels, because fixing either end alone leaves the guarantee unmet:

- **Fetch.** A streaming sibling to `MediaUrlFetch` (`url → AsyncIterable<Uint8Array>`) is added to the seam
  alongside it. The existing whole-buffer type is kept for sub-ceiling callers and is not the media path.
- **Store.** `MediaStore` gains an optional
  **`putStream?(bytes: AsyncIterable<Uint8Array>, mimeType: string): Promise<string>`**. `put` is unchanged.
- **The bound is enforced where the bytes arrive.** `readBounded`'s double buffer is collapsed; the size
  ceiling, the run `AbortSignal`, the request timeout and the per-hop redirect re-validation all apply to the
  stream as it is consumed, and an over-size response is aborted rather than completed and then rejected.
- **A partial write is cleaned up and a handle is published atomically.** A stream that fails mid-write leaves
  no half-object and no reference; the content-addressed handle appears only once the whole object is durable.
- **`put` is not a general fallback.** It stays legitimate for a body already known to be under
  `INLINE_MEDIA_CEILING`. On the large-media path a host that implements no `putStream?` is refused loudly
  rather than silently degrading to a whole-buffer write — which is what keeps this a guarantee rather than a
  preference.

*Considered:* **(a)** changing `put` itself to take a stream — the cleaner end state, but `MediaStore` is a
published seam type and every host (CLI, in-memory reference, tests, the Phase-3 Tauri CAS) would move in one
commit for a benefit the additive method already delivers. **(b)** only collapsing `readBounded`'s double
buffer — roughly halves peak memory and touches no contract, but leaves ADR-0043 §2's actual words and
[security-review.md](../standards/security-review.md)'s explicit prohibition unmet, which is the exact failure
mode this phase exists to stop: a guarantee asserted in a document with nothing between it and the code.
**(c)** an optional `putStream?` with a silent `put` fallback — this was the first draft's answer and it is
wrong: an optional guarantee with a buffering fallback is not a guarantee, it is a hope.

### 3. Gemini's continuation metadata lives in a per-request sidecar, not on a `ContentPart`

The `thoughtSignature` attached to a `functionCall` part is captured into a **sidecar whose lifetime is one
request/turn** — created and disposed with the request, never process-global — and replayed on the
same-provider continuation. **No field is added to the canonical `tool_call` part.**

The per-request scope is load-bearing, not incidental. Gemini exposes no native tool-call id; Relavium
synthesizes `gemini-tool-<n>-<name>` from a counter that restarts at 0 for each request (the same lifetime
rule `GeminiToolCallIds` already documents for itself). A process-scoped map keyed by `(provider, toolCallId)`
would therefore collide on the first identically-named call of any two requests — replaying one turn's
signature into another, which is precisely the cross-context leak ADR-0030/0039 forbid. Binding the sidecar to
the request makes the key unique by construction and makes cleanup trivial: it is dropped when the request
settles, on **every** exit — success, error, cancel, and provider failover (where the next provider must see
no leftover foreign token at all). A same-provider retry within the request keeps it; a cross-provider advance
discards it, mirroring `stripReasoningParts`/`beginEntry`.

This is the more faithful reading of the corpus, not a workaround. A signature is *ephemeral, same-provider,
same-turn* by [ADR-0030](0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md) and
[ADR-0039](0039-same-provider-reasoning-replay.md) — carrying one across a turn or a provider is already
forbidden — so a per-request sidecar's lifetime is exactly the token's permitted lifetime. It closes the
`CR-52` half of ADR-0039's recorded deferral.

**This is a second sidecar, and it must not be merged with the first.**
[ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) §4's sidecar holds provider-hosted **media
refs**, is keyed `(provider, sha256)`, and is owned per-`FallbackChain` run-instance. This one holds
**continuation tokens**, is keyed by tool call within one request, and is owned by the request. They share a
discipline (ephemeral, never persisted, dropped on failover) and nothing else; a future refactor that unifies
them on the assumption that "the adapter has a sidecar" would break both.

*Considered:* an optional `signature?` on the `tool_call` part, mirroring `reasoning.signature` — rejected: it
makes the carrier explicit and easy to test, but it puts a provider continuity token on a part that flows into
`DurableContentPart`, so "it must never persist" becomes a property a **test** defends rather than one the
**type** makes impossible.

### 4. A missing media rate is *unpriced* — on both cost paths — and the rate has a real source

A modality for which the resolved model declares no rate is reported as **unpriced**, never as a cost of zero.
Three things make that a complete answer rather than a slogan:

**(a) Both cost paths carry it.** Pricing a media call returns a *result*, not a bare number — the cost plus
whether it could be priced plus which modality could not. Both producers emit it:

- the `FallbackChain` attempt record's existing **`priced: false`** signal, which
  [ADR-0070](0070-durable-per-model-session-cost-attribution.md)'s durable `unpriced_calls` counter persists
  and `/cost` already renders as *price unknown*; **and**
- the **`generateMedia` / async-completion path**, which emits `cost:updated` directly and is not a chain
  attempt at all. `CostUpdatedEventSchema` already carries an optional `priced` field
  ([ADR-0070](0070-durable-per-model-session-cost-attribution.md) §6) and this path must populate it — a
  media-generation call is the *most* likely one to be unpriced, so leaving the one path CR-55 is about unable
  to say so would defeat the change. `realizedMediaCost`'s "degrade to 0" becomes "degrade to 0, and say it
  was not priced".

The durable `unpriced_calls` counter stays keyed per `(session, model)` and is **not** widened to a modality
tuple — it answers "was anything here unpriced", which a counter does correctly and a modality breakdown would
only complicate. The **modality** appears where it is actionable: in the once-per-condition host notice and in
the strict-mode refusal message.

**(b) Strict mode refuses, and no new event class is introduced.** The authored, opt-in `strict_cost_cap`
([ADR-0071](0071-models-dev-as-the-model-metadata-source.md) §K7) already refuses an unpriced *model*
pre-egress; an unpriced *modality* joins it on the identical rationale — the cap cannot be enforced on a
charge that cannot be estimated. The refusal is the existing `BudgetExceededError` on the existing pre-egress
path, exactly as the unpriced-model refusal is; per [ADR-0044](0044-media-access-governance-read-media-save-to-cost.md)
§3's "no new event or error class", nothing new is added to
[sse-event-schema.md](../reference/contracts/sse-event-schema.md). With strict **off**, the call is allowed
with the same once-per-condition notice an unpriced model gets.

**(c) The rate has a source and the remedy is real.** A refusal that says "price it" against a system where
nothing can be priced is worse than the hole it closes, and today **no** model carries a media rate. So this
decision includes the rate path:

- the DB's media-rate columns project into `ModelPricing.mediaOutputRates` through the same listing/overlay
  path token rates already use;
- precedence is the established one and is not re-invented — **user override > shipped snapshot**, with the
  **live** tier never a pricing authority ([ADR-0071](0071-models-dev-as-the-model-metadata-source.md) §5,
  keeping [ADR-0064](0064-live-model-catalog.md) §6's rule: "the user holds the invoice", and a third-party
  live listing does not);
- a **missing** rate and a **genuine zero** are distinct: absent means unpriced, and an explicitly stated `0`
  means free and is believed — the same distinction `--cached 0` already carries on the token side; and
- `relavium models pricing` gains the three media fields in their canonical billed units — image per count,
  audio per second, video per second — so a user facing a strict refusal has something to do about it.

**This resolves an apparent conflict rather than creating one.** ADR-0044 §3's "a missing media rate degrades
to allow" describes the **non-strict default**, which is unchanged and remains ADR-0028's H4 trade. The strict
path was decided later, by ADR-0071 §K7, and already refuses an unpriced *model*. Extending it to an unpriced
*modality* therefore **removes an asymmetry rather than adding strictness**: today the token path refuses
under a strict cap and the media path cannot, which is the hole `CR-55` names. The phase document's `CR-55`
acceptance is corrected in the same change to say this, so the two records do not disagree.

*Considered:* leaving strict-mode media calls admitted and fixing only the reporting — rejected: it closes the
false `$0` claim but leaves the strict cap a cap the media path can walk through. *Also considered:* landing
the strict refusal without the rate path — rejected outright: it would refuse every media generation in the
product with no remedy, which is not a stricter cap, it is an outage.

## Consequences

### Positive

- `read_media` becomes a tool that can actually work, over a delivery path that already ships and is tested on
  all three providers — and it works the same way on each, so the tool's availability does not depend on which
  model is bound.
- ADR-0043 §2's "never fully buffered" stops being prose, along the whole path rather than at one end. A large
  video no longer needs the chunk list, the concatenated copy and a base64 string alive at once, and a host
  that cannot stream is refused instead of quietly buffering.
- The Gemini continuation token is restored without widening a frozen seam, and the collision that a
  process-scoped sidecar would have introduced — replaying one request's signature into another — is
  structurally impossible rather than merely unlikely.
- The cost cap stops reporting a guess as a fact on **both** producing paths, and `strict_cost_cap` now means
  the same thing for tokens and media — with a rate path behind it, so the refusal names a remedy the user can
  actually perform.

### Negative

- A `read_media` call now adds a synthesized `user` message to the transcript. It is engine-authored and
  marked as such, but it is still a message the user did not write appearing in their history, and it will
  show up in exports and in the context window — mitigated by the fixed preamble that names its origin, and by
  the descriptor-only tool result keeping the duplication to one copy of the bytes.
  **(Amended 2026-09-02, on implementation: the second half of that sentence is wrong.)** The message lives in
  the context window for the duration of the turn and NOWHERE else. `AgentSession` re-appends only the user
  text and the final assistant text, so every intra-turn tool round — this message included — is discarded;
  it never reaches `history.db` and never appears in an export. That is a smaller privacy footprint than
  recorded, and a **larger** provenance gap: the preamble's stated audience was "anyone reading a transcript
  or an exported workflow", and that reader does not exist. Its only reader is the model. No event is emitted
  for the message either, so no surface can show the user that an image was placed in the conversation on
  their behalf. Recorded as an open consequence rather than repaired here: making it visible is a surface
  change (an event, or persistence), which this ADR did not decide.
  See [deferred-tasks.md](../roadmap/deferred-tasks.md).
- Two ways to write bytes into a `MediaStore` (`put` and `putStream?`) until a later change unifies them —
  mitigated by `put` being explicitly scoped to sub-ceiling bodies rather than left as a general fallback, so
  the two are not interchangeable and no caller has to choose.
- Dropping `start`/`end` narrows a published tool contract. Nothing can depend on it — the tool has never been
  dispatchable in production because its delegate was never wired — but the narrowing is recorded here and in
  [built-in-tools.md](../reference/shared-core/built-in-tools.md) rather than left to be rediscovered.
- A request-scoped sidecar is invisible to the type system, so a future refactor could drop the replay without
  a compiler error — mitigated by an adapter-level test asserting the continuation request carries the
  signature, by an explicit test that two requests do not share one, and by this ADR recording why the field
  is deliberately not on the part.
- Turning on `strict_cost_cap` now refuses more calls than it did yesterday: a workflow generating media on a
  model whose media rate is still unknown will stop rather than silently spend. That is the flag's intended
  behaviour and it is opt-in, but it is a real behaviour change for anyone already running with it on — which
  is why the rate path and the CLI fields land in the same change rather than after it.
- `W5` grows: the rate projection and the `models pricing` fields are a CLI/DB surface addition inside a
  correctness wave. Accepted deliberately — the alternative is a refusal with no remedy, and the phase's own
  acceptance for `CR-55` already asks for the media rates to be carried through the overlay path.

## Amendment — 2026-09-02 (implementation of §2)

§2's third bullet says "`readBounded`'s double buffer is collapsed". **It was not.** What shipped adds
`streamBounded` beside `readBounded` and routes media around the buffering one; `readBounded` keeps its ~2×
peak, now documented at its definition, and the text egress path still pays it. Bypassing is arguably the
better answer — collapsing `readBounded` would have changed a primitive every non-media egress caller depends
on, inside a wave whose subject is media — but it is a different answer from the one recorded above, so it is
recorded here rather than quietly assumed. The remaining half is a residual in
[deferred-tasks.md](../roadmap/deferred-tasks.md), not a closed line.

Two further clauses of `CR-53`'s acceptance are open and named there for the same reason: the **adapter** still
returns whole base64 for generated media (`packages/llm` is untouched, so only the `url` carrier streams), and
**delivery** (`resolveForEgress` / `readRange`) still materializes a whole object. §2's decision — carrier
decides, and a `url` with no streaming hook is refused — landed in full; its reach is one direction, not both.
