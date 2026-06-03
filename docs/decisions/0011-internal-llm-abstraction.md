# ADR-0011: Internal multi-LLM abstraction (`@relavium/llm`), not a 3rd-party framework

- **Status**: Accepted
- **Date**: 2026-06-03
- **Related**: [0004-vercel-ai-sdk-multi-llm.md](0004-vercel-ai-sdk-multi-llm.md) (supersedes), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [0018-desktop-execution-and-rust-egress.md](0018-desktop-execution-and-rust-egress.md) (per-host egress + key handling), [tech-stack.md](../tech-stack.md)

## Context

This ADR supersedes [ADR-0004](0004-vercel-ai-sdk-multi-llm.md), which selected the **Vercel AI SDK** as the multi-LLM layer. That choice is withdrawn: the project will not adopt Vercel-stewarded products. The objection is a hard product input, not a defect claim — the Vercel AI SDK is MIT and runtime-agnostic — but it removes it from consideration, and the alternatives were re-evaluated from scratch.

Relavium is multi-model by definition: an agent node names a model from Anthropic, OpenAI, Google (Gemini), or DeepSeek, and the engine must call any of them through one code path. Two hard requirements fall out of that, plus three more from product scope:

- **Unified streaming.** Every provider streams tokens and tool calls differently. The engine emits a single normalized [run-event stream](../reference/contracts/sse-event-schema.md) (`agent:token`, `agent:tool_call`, …) regardless of which provider produced it.
- **Cross-provider tool normalization.** Tool/function-calling schemas differ per provider; the engine presents one canonical tool model and translates to each wire format.
- **Usage + cost accounting**, **per-agent fallback chains**, and execution on **both a Node worker (CLI/engine) and inside a Tauri desktop context**.

This layer lives in `packages/llm` and is consumed by the pure-TypeScript engine from [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md). It must run in every host the engine runs in (desktop, CLI, VS Code extension, Phase-2 cloud workers), so it cannot pull in a separate runtime. API keys are read from the OS keychain per [ADR-0006](0006-os-keychain-for-api-keys.md) and never exposed to the frontend. The target provider set is small (four) and well documented, and three of the four (OpenAI, DeepSeek, Gemini) are reachable over an OpenAI-compatible wire format.

## Decision

**We build an internal, Relavium-owned multi-LLM abstraction in `packages/llm` (`@relavium/llm`).** Its centre is a single provider-agnostic seam — an `LLMProvider` interface expressed only in Relavium/Zod types — implemented by thin hand-rolled adapters over each provider's official TypeScript SDK. We do **not** adopt the Vercel AI SDK, LangChain.js, or any other multi-LLM framework, and we do **not** run a Python sidecar (LiteLLM).

The seam is the immovable contract; the adapter implementation behind it is deliberately reversible. `AgentRunner` (in `packages/core`) hands `packages/llm` a model id, a message list, and tools, and gets back a normalized chunk stream (`text` / `tool_call` / `usage` / `finish`) plus a cost record. **No vendor SDK type ever crosses that seam.** Anthropic and Gemini get dedicated adapters; OpenAI and DeepSeek share one OpenAI-compatible adapter (DeepSeek via a custom baseURL).

Considered options:

1. **Internal abstraction over official provider SDKs (`@relavium/llm`)** — owned seam, thin per-provider adapters, no framework. *Chosen.*
2. **Vercel AI SDK** — the original choice recorded in [ADR-0004](0004-vercel-ai-sdk-multi-llm.md); withdrawn on the no-Vercel-products constraint (a hard product input) and the vendor-lock-in it would carry into the engine.
3. **LangChain.js (`@langchain/core` + per-provider chat models)** — working multi-provider classes, but it drags in the Runnable/LCEL abstraction and a heavy transitive graph, leaks its own message/content-block model into the engine, and carries documented churn and lock-in (v1.0 reshape, `@langchain/core` 0.3.x exposed to a CVE whose fix lands only in 1.x). Even the narrow "import only the `@langchain/<provider>` chat models behind our seam" variant inherits `@langchain/core` and is barely cheaper than hand-rolled adapters. *Rejected on bloat / churn / lock-in.*
4. **LiteLLM Python sidecar** — mature router, but reintroduces the Python runtime [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md) deliberately removed; cannot live in the VS Code extension host and bloats the Tauri bundle ([ADR-0001](0001-tauri-v2-over-electron.md)). *Rejected.*

The internal abstraction wins because it is the only option that fully honors Relavium's documented engineering principle — build in-house, minimize third-party dependencies, write our own better implementations, performance and security first-class — and its architectural commitments — engine-first, one-language-TypeScript, local-first, and **no vendor lock-in** — for a deliberately narrow surface (text + tools + streaming + usage) against just four providers. The happy path per provider is small; the real cost is the *normalization tax* (tool schemas, streaming events, stop reasons, usage fields) and ongoing provider drift. That cost is bounded and is exactly what we would pay to a framework in coupling and churn instead. We contain it by **freezing the interface to a capability-gated lowest-common-denominator plus a typed `providerOptions` escape hatch**, and by a **per-provider conformance test suite** — recorded fixtures on PR, live APIs nightly in CI. Consistent with the principle, the only third-party code retained is each provider's own official SDK (a vetted transport we wrap tightly), never a framework that owns our control flow.

Because nothing SDK-shaped crosses the seam, replacing the implementation later is cheap and localized. We therefore adopt an **internal-first, framework-never (esp. Vercel-never) stance with a reversible 3rd-party bridge**: a thin TS library *behind the same seam* becomes an option only if a **named trigger** fires — sustained provider-drift maintenance cost exceeding the framework's coupling cost, or a must-have capability that is not economically hand-rollable. The trigger fires a follow-up ADR; it never silently changes the seam, and it is never the Vercel AI SDK.

Provider details and built-in tool wiring are in [architecture/multi-llm-providers.md](../architecture/multi-llm-providers.md) and [reference/shared-core/built-in-tools.md](../reference/shared-core/built-in-tools.md). Pinned SDK versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- One TypeScript code path for every provider, with zero framework dependency; the engine emits a single normalized [run-event stream](../reference/contracts/sse-event-schema.md) regardless of which model ran.
- **No vendor lock-in and no leaked vendor types.** The seam is pure Relavium/Zod; the only third-party code is each provider's own official SDK, which we would keep even after any future migration.
- No Python runtime and no sidecar — `packages/llm` loads in the same hosts as the engine (desktop, CLI, VS Code extension, Phase-2 cloud workers), preserving the portability won in [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md).
- Provider-agnostic tool calling: agents declare tools once; the `ToolNormalizer` translates to each wire format, which is what makes cross-provider fallback chains possible.
- Adding a provider is a contained adapter change in one package; OpenAI and DeepSeek already share one adapter path.
- The migration story is real, not aspirational: because the seam admits no vendor type, a 3rd-party bridge can be slotted behind it on a named trigger without touching `packages/core`.
- API keys stay engine-side: read from the OS keychain ([ADR-0006](0006-os-keychain-for-api-keys.md)) and attached during egress in a host-aware way — directly by the adapter on Node-style hosts (CLI, VS Code extension host, Phase-2 Bun API), and by the Rust backend on desktop where egress is delegated to `llm_stream` (so the key never reaches the WebView-resident adapter, which holds only a key reference). See [ADR-0018](0018-desktop-execution-and-rust-egress.md) and the [IPC contract](../reference/contracts/ipc-contract.md).

### Negative

- We own the normalization tax and ongoing provider drift (tool schemas, streaming events, stop reasons, usage fields) that a framework would otherwise absorb. Mitigated by a frozen lowest-common-denominator interface, a typed `providerOptions` escape hatch, and a conformance suite (recorded fixtures on PR, live nightly in CI).
- Provider-specific modalities (vision, prompt caching, files, reasoning traces, parallel tool calls) are out of the common interface by default; surfaced only through `providerOptions` to prevent scope creep into a "second product".
- More code to write and test up front than importing a ready-made multi-provider library.
- We forgo a framework's broader long-tail provider catalog; acceptable because MVP scope is API-based providers only (no Ollama / local models), so the target set is small and well covered.
- Cost/token accounting depends on mapping each provider's usage fields correctly into our cost model; this is an adapter responsibility, covered by the conformance suite and documented in [architecture/multi-llm-providers.md](../architecture/multi-llm-providers.md).
