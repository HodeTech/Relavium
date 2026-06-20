# ADR-0046: Inline media-out routes through `generate()`; the streaming media triad is host-deferred (amends ADR-0031, ADR-0038)

- **Status**: Accepted
- **Date**: 2026-06-20
- **Related**: [0031-llm-seam-shape-amendment-multimodal-io.md](0031-llm-seam-shape-amendment-multimodal-io.md) (**this ADR amends it** — pins which of §5.1's two inline-media-out delivery paths Phase-1 (1.AG) uses; ADR-0031's seam shape is unchanged), [0038-agentrunner-llm-call-boundary.md](0038-agentrunner-llm-call-boundary.md) (**amends** — the per-node turn loop, stream-only today, gains a single-shot `generate()` branch for a media-output turn), [0042-engine-media-storage-substrate-mediastore-deinline-retention.md](0042-engine-media-storage-substrate-mediastore-deinline-retention.md) (the `deInlineMedia` choke point this reuses to turn the in-flight media into a handle), [0043-media-egress-failover-rematerialization-ssrf.md](0043-media-egress-failover-rematerialization-ssrf.md) (the input-side `resolveForEgress` host-hook precedent the deferred streaming path would mirror), [0032-desktop-rust-media-de-inline-amends-0018.md](0032-desktop-rust-media-de-inline-amends-0018.md) (the desktop Rust CAS that owns the deferred streaming-out de-inline), [0045-async-media-job-loop-poll-checkpoint-resume-cancel.md](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md) (the 1.AG sibling — separate-endpoint generators; this is the inline half), [../analysis/multimodal-io-design-2026-06-07.md](../analysis/multimodal-io-design-2026-06-07.md) (§5.1).

## Context

1.AG Section B wires **inline media-out** — a `media_surface: 'chat'` model returning media *in the chat turn* (Gemini `responseModalities` image/audio, OpenAI inline audio, OpenAI agentic image-gen). [ADR-0031](0031-llm-seam-shape-amendment-multimodal-io.md) §5.1 lists **two** delivery paths and calls non-streaming "**the more common of the two**", but does not pin which one Phase-1 implements. The implemented seam makes the choice load-bearing:

- The per-node agent turn ([`agent-turn.ts`](../../packages/core/src/engine/agent-turn.ts)) consumes **`chain.stream()` only**; it folds `text` / `tool_call` / `reasoning` chunks into the result — there is no media path in the turn loop, and the turn **never invokes the `FallbackChain`'s existing `generate()`** (present since 1.K, `fallback-chain.ts`): the turn loop is stream-only today.
- `StreamChunk.media_end` is **handle-only** (`DurableMediaPartSchema`, 1.AD-frozen) and the adapter is **pure** (no `MediaStore`). So a Node adapter that receives the provider's base64 media in its stream has **no way to deliver it** — it cannot emit base64 on a `StreamChunk` (none of the media arms carry base64), and it cannot mint a handle (no store). The input-side de-inline (`resolveForEgress`) is called by the **chain before** the adapter ([ADR-0043](0043-media-egress-failover-rematerialization-ssrf.md) §1); there is no symmetric output-side hook.

So the streaming media triad cannot be driven on Node without a new host-injected de-inline hook reaching the adapter (an output twin of `resolveForEgress`) — a `LlmProvider.stream` signature change to a 1.AD-frozen seam. The non-streaming `generate()` already returns `LlmResult.content`, whose in-flight `MediaPartSchema` **permits base64**, which the engine already de-inlines at the one `#emitDurable` choke point ([ADR-0042](0042-engine-media-storage-substrate-mediastore-deinline-retention.md)). The choice — change the frozen stream seam, or route through the existing `generate()` — is the maintainer's (decided 2026-06-20).

## Decision

**We will deliver Phase-1 (1.AG) inline media-out through the non-streaming `generate()` path; the streaming media triad stays reserved/deferred to the host (1.AH).**

1. **A media-output agent turn calls `chain.generate()`, not `chain.stream()`.** When a turn's resolved model is `media_surface: 'chat'` **and** the node requests media `output_modalities`, the engine issues a single-shot `generate()` whose `LlmResult.content` carries an **in-flight `media` `ContentPart`** (base64). The engine de-inlines it to a `media://sha256-…` handle at the existing `#emitDurable` choke point (the 1.AF `deInlineMedia` pass) on `node:completed.output` — **no new seam shape, no new host hook**. A text-only turn keeps streaming exactly as today.
2. **The agent turn gains a `generate()` routing branch — it calls the `FallbackChain`'s _existing_ `generate()`** (present since 1.K, never invoked by the stream-only turn loop until now), not a new chain method. `generate()` already reuses the same provider skip/select, cross-provider failover, per-attempt cost (`CostTracker`/`PreEgressHook`), `LlmError` classification, **and same-provider reasoning replay** (`beginEntry`, [ADR-0039](0039-same-provider-reasoning-replay.md)) as `stream()`, in one round-trip — so a media-output turn inherits the full chain policy unchanged. *(Considered: drain `stream()` into a synthesised result rather than calling `generate()` — rejected: the media never rides a `StreamChunk`, so a drained stream yields no media; `generate()` is the seam method that returns `LlmResult.content`.)*
3. **The adapter parses provider media output into an in-flight `media` part** (base64), the engine de-inlines it: Gemini `inlineData` → a `media` `ContentPart`; OpenAI inline audio → a `media` part **plus** the transcript text; OpenAI agentic image-gen → a `providerExecuted: true` `tool_result` carrying a **normalized** `media` part (ADR-0031 §4.3/#7). No vendor shape escapes the seam (I1); `LlmResult.raw` is strip-discarded as ever.
4. **The streaming media triad (`media_start`/`media_delta`/`media_end`) stays RESERVED/deferred to 1.AH.** Its Node de-inline needs a host hook reaching the adapter (the output twin of `resolveForEgress`) or the desktop Rust CAS ([ADR-0032](0032-desktop-rust-media-de-inline-amends-0018.md)); recorded in deferred-tasks.md. *Why acceptable:* a media-output turn is typically **terminal/single-shot** (the agent's final artifact), so token-streaming its short accompanying text is low value against a frozen-seam change; ADR-0031 §5.1 itself names non-streaming "the more common."

The `StopReason` rule is unchanged (ADR-0031 §5.3): a media-only turn reports `'stop'`; the signal is a `media` part in `content`, never a new stop reason — consumers inspect `content`. **Additively (a refinement of ADR-0031 §5.3's content-inspection rule):** the engine compares the produced modalities against the node's authored `output_modalities` and may route/retry on a missing modality (a turn *requested* to emit an image that returned only text), rather than relying on a stop reason.

## Consequences

### Positive

- No change to the 1.AD-frozen `StreamChunk`/seam shape and no new host hook in Phase 1; inline media-out reuses the proven `#emitDurable` `deInlineMedia` choke point (1.AF) — the I3 "no bytes durable" invariant is inherited intact (the handle is the only durable form).
- The `FallbackChain.generate()` method is a small, well-bounded addition that mirrors `stream()`'s policy, and the turn change is one routing branch — the streaming machinery (tool loop, reasoning, cost, failover) is untouched for the common text path.

### Negative

- A media-output turn does **not** stream tokens (the short accompanying text arrives whole) — accepted: media turns are typically terminal and the text is incidental.
- True streaming media-out (progressive previews via the triad) is deferred to 1.AH (the host de-inline hook / desktop Rust CAS) — recorded in deferred-tasks.md, not lost.
- A turn that both calls tools **and** emits inline media in one shot is the awkward case — the client-side tool loop is built around `stream()`, and `generate()` is a single round-trip, so a media-output turn cannot run a further tool round. 1.AG handles the terminal media-output turn (no further tool round), consistent with how media-gen is authored (Gemini `responseModalities` and OpenAI's `providerExecuted` image-gen are single-shot).

### Neutral

- Per ADR-0009's append-only rule, ADR-0031/0038 are unchanged in history; this ADR is the authoritative record for the inline-media-out delivery path and the streaming-triad deferral. On acceptance this lands a dated `> Amended by [ADR-0046]` note on ADR-0031 and ADR-0038 (documentation-style.md §7).
- The separate-endpoint generators (`generateMedia`/`pollMediaJob`) are the 1.AG sibling decision ([ADR-0045](0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)); together they cover 1.AG output generation (inline + generative).
