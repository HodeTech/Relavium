---
name: add-llm-adapter
description: >
  Add a new LLM provider adapter behind the LLMProvider seam in packages/llm without leaking a single vendor SDK type across it: implement the seam interface, normalize system-prompt placement / tool schema / tool-call round-trip / streaming events / stop reasons / usage to the canonical Relavium types, map the provider into the generated model catalog for cost, wire it into the fallback runner config, and add the per-provider conformance test (recorded fixtures on PR, live nightly). USE FOR: integrating a new model provider into @relavium/llm. DO NOT USE FOR: adding a new top-level workspace package (use ../add-package/SKILL.md), changing the seam *interface* itself (that supersedes ADR-0011 — use ../write-adr/SKILL.md), or restating the seam contract (it has one canonical home in docs/reference/shared-core/llm-provider-seam.md).
---
# Add an LLM provider adapter

## Purpose
Integrate a new model provider into `packages/llm` (`@relavium/llm`) as a thin adapter that lives **entirely behind the `LLMProvider` seam** — so `packages/core` and every surface keep talking to one provider-agnostic interface in Relavium/Zod types only. The adapter translates one provider's wire behavior into the canonical request/result/stream shapes and back; nothing SDK-shaped escapes it. This is the highest-leverage Relavium-specific scaffold: get the normalization and the conformance test right and provider drift becomes a red CI run instead of a production incident. The seam itself is the immovable contract from [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md); its canonical types live in [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md). This skill changes the *implementation behind* the seam, never the seam.

## When to use
- A new API-based provider must be callable from an agent node (a model id routes to it).
- A provider you already support ships a new wire dialect that needs its own normalization path.
- Note the existing inventory is **three** adapters: a dedicated `AnthropicAdapter` (`@anthropic-ai/sdk`), a dedicated `GeminiAdapter` (`@google/genai`), and **one shared OpenAI-compatible adapter** (the `openai` SDK) serving both OpenAI and DeepSeek (DeepSeek via a custom `baseURL`). If the new provider speaks the OpenAI-compatible wire format, **extend that shared adapter with a new `baseURL` + capability entry (pricing comes from the generated catalog, not a hand-typed table) — do not write a fourth adapter.**

## When not to use
- You need to change the seam *interface* — add a method, a chunk variant, or let a vendor type through. That supersedes [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md); stop and run ../write-adr/SKILL.md. The seam is immovable; this skill works strictly behind it.
- You are adopting a multi-LLM *framework* (LangChain, a router, **and never the Vercel AI SDK**) — forbidden by ADR-0011 absent a named-trigger superseding ADR.
- You are scaffolding a brand-new workspace package — use ../add-package/SKILL.md.
- You are adding a local-model runtime (Ollama et al.) — out of MVP scope per ADR-0011; needs an ADR.

## Inputs
| Input | Description |
|-------|-------------|
| Provider id | The literal added to the closed `ProviderId` enum — its **canonical home is `LLM_PROVIDERS`** in `packages/shared/src/constants.ts` (`ProviderId` aliases `LlmProviderId = (typeof LLM_PROVIDERS)[number]`, and `ProviderIdSchema = z.enum(LLM_PROVIDERS)`), never a vendor enum. The CLI mirrors it in `KNOWN_PROVIDER_IDS`/`KNOWN_PROVIDERS` (step 7). A genuinely-new arbitrary id **opens** the closed enum — a deliberate supersede per [ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md) §6, not a silent edit. |
| SDK / transport | The official TS SDK to wrap, or `openai` + a custom `baseURL` if OpenAI-compatible. An SDK dependency stays strictly inside `packages/llm/src/adapters/*`. |
| Capabilities | `{ tools, streaming, parallelToolCalls, vision, promptCache, reasoning }` — what this provider genuinely supports, for the `supports` capability flags. |
| Model ids + catalog key | Canonical model ids this adapter serves, and the provider's key in the upstream models.dev catalog (`CATALOG_PROVIDER_KEYS`) — pricing / context / limits are GENERATED from it, never hand-typed. |
| Wire facts | The provider's native system-prompt placement, tool schema shape, tool-call/result round-trip, streaming events, stop reasons, and usage fields — the six things to normalize. |

## Workflow
1. **Confirm the seam doesn't have to move.** Read [llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md) end to end. Map every one of this provider's behaviors onto the *existing* canonical types (`LlmRequest`, `ContentPart`, `LlmResult`, `StopReason`, `Usage`, `StreamChunk`, `CapabilityFlags`). If something genuinely does not fit, that is an ADR (../write-adr/SKILL.md) superseding ADR-0011 — not an edit here. Reach provider-specific features only through the typed `providerOptions` escape hatch and the `supports` flags, never by widening the seam.
2. **Decide adapter vs. shared-OpenAI extension.** If the provider is OpenAI-wire-compatible, extend the shared OpenAI-compatible adapter with a new `baseURL` + capability entry (the DeepSeek pattern; pricing comes from the generated catalog). Otherwise add a new file under `adapters/`:
   ```text
   packages/llm/src/
   ├── types.ts                       # the seam — DO NOT edit to fit a provider
   ├── adapters/
   │   ├── anthropic-adapter.ts
   │   ├── openai-compatible-adapter.ts   # OpenAI + DeepSeek (+ new wire-compatible providers)
   │   ├── gemini-adapter.ts
   │   └── <provider>-adapter.ts          # NEW — only if not OpenAI-compatible
   ├── pricing.ts                     # catalog → price PROJECTION (generated; do NOT hand-edit — see Step 5)
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
5. **Map the provider into the catalog — do NOT hand-write prices** ([ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md)). Model metadata (price, context window, **max output**, and the **reasoning control's shape + accepted tiers**) is *generated*, not typed. Add **one line** to `CATALOG_PROVIDER_KEYS` (`packages/llm/src/catalog/`) mapping your `ProviderId` to the provider's key in the upstream catalog, then re-run `pnpm sync:models` and **review the generated diff** like any other change:

   ```ts
   const CATALOG_PROVIDER_KEYS: Record<ProviderId, string> = {
     …,
     yourprovider: 'their-upstream-key',   // ← the whole integration
   };
   ```

   Two rules this replaces the old hand-typed table for, and why:
   - **Never hand-type a price, a context window, or a max-output value.** The 12-row table this supersedes drifted silently (it claimed `claude-sonnet-4-6` maxed at 64k output; it is 128k) and priced only 12 of ~97 reachable models — so [ADR-0028](../../../docs/decisions/0028-workflow-resource-governance.md)'s cost cap silently did not apply to the rest.
   - **Never hand-write `reasoning: true/false`.** The reasoning control's shape is **per model**, not per provider — `gemini-2.5-*` takes a `thinkingBudget` while `gemini-3.x` takes a `thinkingLevel`, and assuming one shape for a whole adapter is what produced a live bug ([ADR-0066](../../../docs/decisions/0066-normalized-reasoning-effort-control.md)'s dated correction note). Let the catalog say it; compute the accepted tiers with `acceptedTiers(provider, model)`.

   **If the upstream catalog does not cover your provider** (a bespoke or self-hosted endpoint), that is a *supported* case, not an error: its models simply arrive unpriced, exactly like a brand-new model, and a user prices them with `relavium models pricing` ([ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md)). Do not re-introduce a hand-typed table to work around it.

   Cost itself stays **ours**: `CostTracker` computes it from the catalog keyed on the **canonical model id** — never read a cost number from a provider response. It is the same `costMicrocents` that surfaces in the `cost:updated` run event ([sse-event-schema.md](../../../docs/reference/contracts/sse-event-schema.md)); store it as integer micro-cents (1 micro-cent = 1e-8 USD), never a float.
6. **Wire it into provider selection and the fallback runner.** Register the id in the provider factory and make it selectable by the `withFallback(providers)` runner so an agent's `fallback_chain` can list it. The chain is policy and lives outside the adapter — the adapter stays dumb. The `fallback_chain` field shapes (`model`, `provider`, `max_attempts`) are canonical in [agent-yaml-spec.md](../../../docs/reference/contracts/agent-yaml-spec.md); do not redefine them. Errors must surface as a classified `LlmError` (retryable vs. fatal per [error-handling.md](../../../docs/standards/error-handling.md)) so the runner knows when to fail over.
7. **Register the provider on the CLI so its onboarding + management surfaces light up (data-driven — no per-surface UI edit).** The id lives in **two** homes that mirror the seam's closed set; every CLI surface then derives from them:
   1. **`LLM_PROVIDERS`** (`packages/shared/src/constants.ts`) — the canonical closed `ProviderId` enum (`ProviderId` aliases `LlmProviderId = (typeof LLM_PROVIDERS)[number]`; `ProviderIdSchema = z.enum(LLM_PROVIDERS)`; the **persisted** run-event `provider` field + authored agent YAML). Adding an *arbitrary* new id here opens the closed enum → an ADR ([ADR-0065](../../../docs/decisions/0065-provider-economics-and-extensibility.md) §6 supersede), not a silent edit.
   2. **`KNOWN_PROVIDER_IDS` + `KNOWN_PROVIDERS`** (`apps/cli/src/engine/providers.ts`) — the CLI's per-provider metadata (`displayName`, `baseUrl`, a cheap `testModel` for the live key-check, `pricingUrl`). Every provider-facing CLI surface is **data-driven off these two lists**, so a registered provider appears everywhere with **no edit to `wizard.ts` / `provider.ts` / `doctor.ts` / the model picker** — via one of two access patterns: the first-run onboarding **wizard**, `/doctor --deep`'s key probe, and the `/models` Home key-gate **iterate `KNOWN_PROVIDER_IDS`**; `relavium provider add` / `set-key` / `remove-key` / `test` **validate one supplied id against the wider `ProviderIdSchema` (`z.enum(LLM_PROVIDERS)`) and then index `KNOWN_PROVIDERS[id]`** for its metadata.

   **Keep the two lists in lock-step.** `KNOWN_PROVIDER_IDS satisfies readonly ProviderId[]` makes the compiler enforce `KNOWN_PROVIDER_IDS ⊆ LLM_PROVIDERS`, but the **reverse is not** compiler-checked: a provider added to `LLM_PROVIDERS` (so a live/static `model_catalog` row can exist for it) yet **missing from `KNOWN_PROVIDER_IDS`** breaks two ways — it is silently mis-dimmed in the Home (the key-probe filters `KNOWN_PROVIDER_IDS`, so the new provider is never in `keyedProviders`, and `mergeModelCatalog` marks its models `available: false` + `unavailableReason: 'no-key'` **even with a stored key** — the 2.5.G Step-A latent coupling), and `provider add`/`set-key`/`test` (which accept the wider `LLM_PROVIDERS`) would **throw** on the `undefined` `KNOWN_PROVIDERS[id]` metadata lookup. A guard test in `providers.test.ts` pins the two as **equal sets**, so a missed registration is a red CI run rather than either runtime failure.
8. **Add the conformance test for this provider.** The conformance suite is **one shared spec run against every adapter** — it must prove the new adapter: streams text, calls a tool and returns a normalized `tool_call`, returns usage, maps stop reasons to the canonical enum, and surfaces errors as a classified `LlmError` **whose normalized `message`/`code` is secret-free** — include a fixture with a **secret-bearing vendor error** (a key/token/`baseURL` in the upstream error) and assert none of it survives normalization (testing.md §Per-provider conformance + §Security-critical primitive tests; [security-review.md](../../../docs/standards/security-review.md)). Add the provider to the matrix and record its fixtures:
   ```bash
   # Record fixtures live ONCE (key from env, never committed, never logged), then commit them.
   RELAVIUM_LIVE=1 pnpm --filter @relavium/llm test:conformance:record --provider=<provider>
   # PR CI replays the committed fixtures — fast, deterministic, offline, no keys/quota.
   pnpm --filter @relavium/llm test
   ```
   Fixtures (including streamed SSE transcripts) are checked in and reviewed like code; when the provider's wire format changes, **regenerate the fixture, never hand-edit it**. The live suite runs nightly against the real endpoint (keys from CI secrets) as the drift early-warning.
9. **Verify with no vendor leak.** Run the full graph; confirm the boundary lint passes (the SDK import is confined to the adapter file) and no vendor type appears in `index.ts` or any `packages/core` test.
   ```bash
   pnpm turbo run lint typecheck test --filter=@relavium/llm...
   ```
10. **Commit** with ../commit-and-pr/SKILL.md scoped to the package: `feat(llm): add <provider> adapter behind the LLMProvider seam` with a `Refs: ADR-0011` trailer.

## Outputs
- A new `adapters/<provider>-adapter.ts` (or a new `baseURL`/capability entry on the shared OpenAI-compatible adapter) implementing `LlmProvider` with full six-axis normalization.
- One line in `CATALOG_PROVIDER_KEYS` + a re-run `pnpm sync:models` whose generated diff was reviewed; the provider registered in the factory and selectable in the fallback runner.
- The provider added to the conformance matrix with committed fixtures (PR) wired into the nightly live run.
- No vendor SDK type anywhere above the adapter; the boundary lint green.

## Done criteria
- [ ] The seam interface was **not** changed; everything fits the existing canonical types, with provider-specific features only via `providerOptions`/`supports`.
- [ ] SDK import is confined to `adapters/*`; no vendor type is re-exported or crosses into `packages/core`; `raw` is `unknown`.
- [ ] All six normalizations implemented: system-prompt placement, tool schema (with unsupported-keyword stripping if restricted), tool-call/result round-trip (with id synthesis if the provider has no ids), streaming → `StreamChunk`, stop reasons → the 5-value enum, usage → `Usage`.
- [ ] Provider mapped into the catalog (`CATALOG_PROVIDER_KEYS` + `pnpm sync:models`) and the generated metadata reviewed; cost computed from the catalog on the canonical model id and stored as integer micro-cents (`costMicrocents`), never read from the provider or stored as a float.
- [ ] Provider registered in the factory and usable in a `fallback_chain`; errors classified as `LlmError` (retryable/fatal).
- [ ] Id registered in **both** `LLM_PROVIDERS` (`@relavium/shared`) and `KNOWN_PROVIDER_IDS`/`KNOWN_PROVIDERS` (the CLI, with a `testModel`) so the wizard / `provider` / `/doctor` / `/models` surface it data-driven; the `LLM_PROVIDERS`↔`KNOWN_PROVIDER_IDS` lock-step guard test (`providers.test.ts`) is green. A genuinely-new arbitrary id opening the closed enum is an ADR-0065 §6 supersede, not a silent edit.
- [ ] Key handling host-aware (ADR-0018): a resolved key attached in-adapter on the Node-style hosts; a key *reference* passed to the Rust `llm_stream` egress on desktop (raw key never in the WebView); never logged/checkpointed/sent to the frontend; `AbortSignal` threaded through.
- [ ] Conformance spec passes for this provider with **recorded fixtures** (PR) and is in the **nightly live** matrix; fixtures committed, generated not hand-edited.
- [ ] The normalized `LlmError.message`/`code` is **secret-free** (no key / `baseURL` / auth / token) — asserted by a secret-bearing-error conformance fixture, not assumed (a declared-but-untested "already redacted" invariant is a future leak; [security-review.md](../../../docs/standards/security-review.md)).
- [ ] **Provenance + default-off.** Any new runtime dependency/SDK the adapter pulls in has an ADR (CLAUDE.md #2) and supply-chain sign-off (security-review.md §Dependency and supply chain); a community / non-official provider or aggregator gateway is **default-off / opt-in**, never auto-listed in the default `fallback_chain`.
- [ ] `pnpm turbo run lint typecheck test --filter=@relavium/llm...` is green; the boundary lint passes.

## Common pitfalls
- **Leaking a vendor type across the seam** — typing `raw` as a vendor shape, re-exporting an SDK enum, or pattern-matching a vendor chunk in `packages/core`. This is the one failure ADR-0011 exists to prevent.
- Widening the seam interface to fit a provider instead of using `providerOptions` — that is an ADR, not an edit.
- Writing a fourth adapter for an OpenAI-compatible provider instead of extending the shared one with a `baseURL`.
- Trusting a provider's own cost field instead of computing the cost from the generated catalog on the canonical model id; or storing cost as a float instead of integer micro-cents.
- Forgetting the provider-specific stream quirk (e.g. OpenAI's `include_usage` opt-in) so the final `stop` chunk has no usage.
- Passing a restricted-provider tool schema through without stripping unsupported keywords, or losing tool-call ids on a no-id provider.
- Hand-editing a recorded fixture instead of regenerating it; committing a live API key or logging the key.
- Adding the id to `LLM_PROVIDERS` but forgetting the CLI `KNOWN_PROVIDER_IDS`/`KNOWN_PROVIDERS` twin (step 7) — the compiler won't catch it (only `⊆` is enforced), so the provider's models are silently mis-dimmed `no-key` in the Home (the `KNOWN_PROVIDER_IDS`-iterating surfaces) **and** `provider add`/`test` crash on the `undefined` `KNOWN_PROVIDERS[id]` metadata lookup (the id-validating surfaces). The lock-step guard test is what turns this into a red run.
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
