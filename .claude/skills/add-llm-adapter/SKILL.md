---
name: add-llm-adapter
description: >
  Add a new LLM provider adapter behind the LLMProvider seam in packages/llm without leaking a single vendor SDK type across it: implement the seam interface, normalize system-prompt placement / tool schema / tool-call round-trip / streaming events / stop reasons / usage to the canonical Relavium types, register a pricing entry for cost, wire it into the fallback runner config, and add the per-provider conformance test (recorded fixtures on PR, live nightly). USE FOR: integrating a new model provider into @relavium/llm. DO NOT USE FOR: adding a new top-level workspace package (use ../add-package/SKILL.md), changing the seam *interface* itself (that supersedes ADR-0011 — use ../write-adr/SKILL.md), or restating the seam contract (it has one canonical home in docs/reference/shared-core/llm-provider-seam.md).
---
# Add an LLM provider adapter

## Purpose
Integrate a new model provider into `packages/llm` (`@relavium/llm`) as a thin adapter that lives **entirely behind the `LLMProvider` seam** — so `packages/core` and every surface keep talking to one provider-agnostic interface in Relavium/Zod types only. The adapter translates one provider's wire behavior into the canonical request/result/stream shapes and back; nothing SDK-shaped escapes it. This is the highest-leverage Relavium-specific scaffold: get the normalization and the conformance test right and provider drift becomes a red CI run instead of a production incident. The seam itself is the immovable contract from [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md); its canonical types live in [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md). This skill changes the *implementation behind* the seam, never the seam.

## When to use
- A new API-based provider must be callable from an agent node (a model id routes to it).
- A provider you already support ships a new wire dialect that needs its own normalization path.
- Note the existing inventory is **three** adapters: a dedicated `AnthropicAdapter` (`@anthropic-ai/sdk`), a dedicated `GeminiAdapter` (`@google/genai`), and **one shared OpenAI-compatible adapter** (the `openai` SDK) serving both OpenAI and DeepSeek (DeepSeek via a custom `baseURL`). If the new provider speaks the OpenAI-compatible wire format, **extend that shared adapter with a new `baseURL` + pricing + capability entry — do not write a fourth adapter.**

## When not to use
- You need to change the seam *interface* — add a method, a chunk variant, or let a vendor type through. That supersedes [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md); stop and run ../write-adr/SKILL.md. The seam is immovable; this skill works strictly behind it.
- You are adopting a multi-LLM *framework* (LangChain, a router, **and never the Vercel AI SDK**) — forbidden by ADR-0011 absent a named-trigger superseding ADR.
- You are scaffolding a brand-new workspace package — use ../add-package/SKILL.md.
- You are adding a local-model runtime (Ollama et al.) — out of MVP scope per ADR-0011; needs an ADR.

## Inputs
| Input | Description |
|-------|-------------|
| Provider id | The literal added to `LlmProvider.id` (`'anthropic' \| 'openai' \| 'gemini' \| 'deepseek' \| …`) — a plain string union, never a vendor enum. |
| SDK / transport | The official TS SDK to wrap, or `openai` + a custom `baseURL` if OpenAI-compatible. An SDK dependency stays strictly inside `packages/llm/src/adapters/*`. |
| Capabilities | `{ tools, streaming, parallelToolCalls, vision, promptCache, reasoning }` — what this provider genuinely supports, for the `supports` capability flags. |
| Model ids + pricing | Canonical model ids this adapter serves and their per-token input/output (and cache) prices, for the pricing table. |
| Wire facts | The provider's native system-prompt placement, tool schema shape, tool-call/result round-trip, streaming events, stop reasons, and usage fields — the six things to normalize. |

## Workflow
1. **Confirm the seam doesn't have to move.** Read [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md) end to end. Map every one of this provider's behaviors onto the *existing* canonical types (`LlmRequest`, `ContentPart`, `LlmResult`, `StopReason`, `Usage`, `StreamChunk`, `CapabilityFlags`). If something genuinely does not fit, that is an ADR (../write-adr/SKILL.md) superseding ADR-0011 — not an edit here. Reach provider-specific features only through the typed `providerOptions` escape hatch and the `supports` flags, never by widening the seam.
2. **Decide adapter vs. shared-OpenAI extension.** If the provider is OpenAI-wire-compatible, extend the shared OpenAI-compatible adapter with a new `baseURL` + capability + pricing entry (the DeepSeek pattern). Otherwise add a new file under `adapters/`:
   ```text
   packages/llm/src/
   ├── types.ts                       # the seam — DO NOT edit to fit a provider
   ├── adapters/
   │   ├── anthropic-adapter.ts
   │   ├── openai-compatible-adapter.ts   # OpenAI + DeepSeek (+ new wire-compatible providers)
   │   ├── gemini-adapter.ts
   │   └── <provider>-adapter.ts          # NEW — only if not OpenAI-compatible
   ├── pricing.ts                     # canonical-model-id → per-token price (add an entry)
   ├── fallback.ts                    # withFallback runner config (register the provider)
   ├── provider-factory.ts            # id → adapter (register the id)
   └── conformance/
       ├── conformance.spec.ts        # the ONE shared spec, run per provider
       └── fixtures/<provider>/       # recorded request/response + SSE transcripts
   ```
   The provider SDK is imported **only** inside its `adapters/*` file (enforced by the import-boundary lint rule — code-style §Module boundaries). Never re-export a vendor type from `index.ts`.
3. **Implement `LlmProvider`.** Provide `id`, `generate(req, key)`, `stream(req, key)`, and `supports`. The `key` argument is **host-aware** ([ADR-0018](../../../docs/decisions/0018-desktop-execution-and-rust-egress.md)): a **resolved key** on the Node-style surfaces (CLI, VS Code host, Phase-2 Bun API), where the adapter attaches it just before the request inside the one trusted process; and a **key *reference*** on the desktop, where the adapter hands the request shape + reference to its injected transport and the Rust `llm_stream` command reads the actual key from the keychain and attaches the `Authorization` header — the raw key never enters the WebView. Either way the key (sourced from the OS keychain at call time per [ADR-0006](../../../docs/decisions/0006-os-keychain-for-api-keys.md)) is never serialized into a checkpoint, a run event, or a log line. Keep the adapter's **HTTP transport injected** so the one adapter runs on every host (desktop wires the Rust-delegated transport, the Node surfaces a direct `fetch`/SDK one) and `@relavium/llm` stays platform-agnostic. Thread `req.signal` (`AbortSignal`) through so cancellation works identically on every host (on desktop it aborts the Rust request). A provider `raw` payload may be carried out as `unknown` for debugging — never typed as a vendor shape.
4. **Normalize the six things — canonical in → native out, native in → canonical out.** Cite the per-provider tables in [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md); do not restate them here, implement against them:
   1. **System-prompt placement** — `req.system` is one top-level field; route it to the provider's home (Anthropic top-level `system`, OpenAI/DeepSeek a prepended `{role:'system'}` message, Gemini `systemInstruction`).
   2. **Tool / function schema** — one canonical `JSONSchema7` per `ToolDef` reshaped into the provider's native tool shape. If the provider restricts JSON-Schema (the Gemini case: no `$ref`, limited formats), **validate and strip unsupported keywords before sending** — never pass an unsupported schema through.
   3. **Tool-call / result round-trip** — map assistant tool calls and tool results both ways. If the provider exposes **no tool-call id** (the Gemini case), **synthesize and track ids by name + order inside the adapter** and rehydrate them into `ContentPart.tool_call.id` / `tool_result.toolCallId` — callers always see ids.
   4. **Streaming events** — fold the native event stream into the one `StreamChunk` union (`text_delta` / `tool_call_start` / `tool_call_delta` / `tool_call_end` / `stop` / `error`). Concatenate tool-arg JSON deltas across `tool_call_delta` and **parse once at `tool_call_end`**. Some providers need an opt-in to emit final usage (OpenAI's `stream_options:{include_usage:true}`) — set it.
   5. **Stop reasons** — map every native reason onto the five-value `StopReason` enum (`stop | length | tool_use | content_filter | error`). No native string leaks out.
   6. **Usage** — map native token fields into `Usage.inputTokens`/`outputTokens` (+ `cacheReadTokens`/`cacheWriteTokens` where the provider exposes them). The final `stop` chunk always carries `stopReason` + `usage`.
5. **Register a pricing entry — cost is ours.** Add the canonical model id(s) and per-token prices to the pricing table (`pricing.ts`). `CostTracker` computes the cost from *our* table keyed on the **canonical model id** — never read a cost number from a provider response. This is the same `costMicrocents` that surfaces in the `cost:updated` run event ([sse-event-schema.md](../../../docs/reference/contracts/sse-event-schema.md)); store cost as integer micro-cents (1 micro-cent = 1e-8 USD), never a float.
6. **Wire it into provider selection and the fallback runner.** Register the id in the provider factory and make it selectable by the `withFallback(providers)` runner so an agent's `fallback_chain` can list it. The chain is policy and lives outside the adapter — the adapter stays dumb. The `fallback_chain` field shapes (`model`, `provider`, `max_attempts`) are canonical in [agent-yaml-spec.md](../../../docs/reference/contracts/agent-yaml-spec.md); do not redefine them. Errors must surface as a classified `LlmError` (retryable vs. fatal per [error-handling.md](../../../docs/standards/error-handling.md)) so the runner knows when to fail over.
7. **Add the conformance test for this provider.** The conformance suite is **one shared spec run against every adapter** — it must prove the new adapter: streams text, calls a tool and returns a normalized `tool_call`, returns usage, maps stop reasons to the canonical enum, and surfaces errors as a classified `LlmError` **whose normalized `message`/`code` is secret-free** — include a fixture with a **secret-bearing vendor error** (a key/token/`baseURL` in the upstream error) and assert none of it survives normalization (testing.md §Per-provider conformance + §Security-critical primitive tests; [security-review.md](../../../docs/standards/security-review.md)). Add the provider to the matrix and record its fixtures:
   ```bash
   # Record fixtures live ONCE (key from env, never committed, never logged), then commit them.
   RELAVIUM_LIVE=1 pnpm --filter @relavium/llm test:conformance:record --provider=<provider>
   # PR CI replays the committed fixtures — fast, deterministic, offline, no keys/quota.
   pnpm --filter @relavium/llm test
   ```
   Fixtures (including streamed SSE transcripts) are checked in and reviewed like code; when the provider's wire format changes, **regenerate the fixture, never hand-edit it**. The live suite runs nightly against the real endpoint (keys from CI secrets) as the drift early-warning.
8. **Verify with no vendor leak.** Run the full graph; confirm the boundary lint passes (the SDK import is confined to the adapter file) and no vendor type appears in `index.ts` or any `packages/core` test.
   ```bash
   pnpm turbo run lint typecheck test --filter=@relavium/llm...
   ```
9. **Commit** with ../commit-and-pr/SKILL.md scoped to the package: `feat(llm): add <provider> adapter behind the LLMProvider seam` with a `Refs: ADR-0011` trailer.

## Outputs
- A new `adapters/<provider>-adapter.ts` (or a new `baseURL`/capability/pricing entry on the shared OpenAI-compatible adapter) implementing `LlmProvider` with full six-axis normalization.
- A pricing-table entry per canonical model id; the provider registered in the factory and selectable in the fallback runner.
- The provider added to the conformance matrix with committed fixtures (PR) wired into the nightly live run.
- No vendor SDK type anywhere above the adapter; the boundary lint green.

## Done criteria
- [ ] The seam interface was **not** changed; everything fits the existing canonical types, with provider-specific features only via `providerOptions`/`supports`.
- [ ] SDK import is confined to `adapters/*`; no vendor type is re-exported or crosses into `packages/core`; `raw` is `unknown`.
- [ ] All six normalizations implemented: system-prompt placement, tool schema (with unsupported-keyword stripping if restricted), tool-call/result round-trip (with id synthesis if the provider has no ids), streaming → `StreamChunk`, stop reasons → the 5-value enum, usage → `Usage`.
- [ ] Pricing entry added; cost computed from our table on the canonical model id and stored as integer micro-cents (`costMicrocents`), never read from the provider or stored as a float.
- [ ] Provider registered in the factory and usable in a `fallback_chain`; errors classified as `LlmError` (retryable/fatal).
- [ ] Key handling host-aware (ADR-0018): a resolved key attached in-adapter on the Node-style hosts; a key *reference* passed to the Rust `llm_stream` egress on desktop (raw key never in the WebView); never logged/checkpointed/sent to the frontend; `AbortSignal` threaded through.
- [ ] Conformance spec passes for this provider with **recorded fixtures** (PR) and is in the **nightly live** matrix; fixtures committed, generated not hand-edited.
- [ ] The normalized `LlmError.message`/`code` is **secret-free** (no key / `baseURL` / auth / token) — asserted by a secret-bearing-error conformance fixture, not assumed (a declared-but-untested "already redacted" invariant is a future leak; [security-review.md](../../../docs/standards/security-review.md)).
- [ ] **Provenance + default-off.** Any new runtime dependency/SDK the adapter pulls in has an ADR (CLAUDE.md #2) and supply-chain sign-off (security-review.md §Dependency and supply chain); a community / non-official provider or aggregator gateway is **default-off / opt-in**, never auto-listed in the default `fallback_chain`.
- [ ] `pnpm turbo run lint typecheck test --filter=@relavium/llm...` is green; the boundary lint passes.

## Common pitfalls
- **Leaking a vendor type across the seam** — typing `raw` as a vendor shape, re-exporting an SDK enum, or pattern-matching a vendor chunk in `packages/core`. This is the one failure ADR-0011 exists to prevent.
- Widening the seam interface to fit a provider instead of using `providerOptions` — that is an ADR, not an edit.
- Writing a fourth adapter for an OpenAI-compatible provider instead of extending the shared one with a `baseURL`.
- Trusting a provider's own cost field instead of computing the cost from our pricing table on the canonical model id; or storing cost as a float instead of integer micro-cents.
- Forgetting the provider-specific stream quirk (e.g. OpenAI's `include_usage` opt-in) so the final `stop` chunk has no usage.
- Passing a restricted-provider tool schema through without stripping unsupported keywords, or losing tool-call ids on a no-id provider.
- Hand-editing a recorded fixture instead of regenerating it; committing a live API key or logging the key.
- Putting fallback/retry logic inside the adapter — the adapter stays dumb; fallback is the runner's job.

## Related
- The canonical seam types & the six normalization tables: ../../../docs/reference/shared-core/llm-provider-seam.md
- Why the seam is immovable / framework-never stance: ../../../docs/decisions/0011-internal-llm-abstraction.md
- Provider-layer rationale (adapters, fallback, cost, conformance): ../../../docs/architecture/multi-llm-providers.md
- Conformance modes (fixtures on PR, live nightly) & coverage bar: ../../../docs/standards/testing.md
- No-vendor-type-across-the-seam, no-`any`: ../../../docs/standards/code-style-typescript.md
- `LlmError` retryable/fatal classification: ../../../docs/standards/error-handling.md
- Keys from the OS keychain at call time: ../../../docs/decisions/0006-os-keychain-for-api-keys.md
- `fallback_chain` field shapes: ../../../docs/reference/contracts/agent-yaml-spec.md · cost event: ../../../docs/reference/contracts/sse-event-schema.md
- Sibling skills: ../add-package/SKILL.md, ../write-adr/SKILL.md, ../commit-and-pr/SKILL.md
