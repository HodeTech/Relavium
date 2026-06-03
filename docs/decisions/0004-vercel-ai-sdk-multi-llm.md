# ADR-0004: Vercel AI SDK for multi-LLM, no Python sidecar

- **Status**: Superseded by [ADR-0011](0011-internal-llm-abstraction.md)
- **Date**: 2026-06-03
- **Related**: [0011-internal-llm-abstraction.md](0011-internal-llm-abstraction.md) (supersedes this), [0003-pure-ts-engine-not-langgraph-python.md](0003-pure-ts-engine-not-langgraph-python.md), [0006-os-keychain-for-api-keys.md](0006-os-keychain-for-api-keys.md), [tech-stack.md](../tech-stack.md)

> Superseded 2026-06-03: the project no longer uses the Vercel AI SDK; see [ADR-0011](0011-internal-llm-abstraction.md).

## Context

Relavium is multi-model by definition: an agent node names a model from Anthropic, OpenAI, Google (Gemini), or DeepSeek, and the engine must call any of them with one code path. Two hard requirements fall out of that:

- **Unified streaming.** Every provider streams tokens and tool calls differently. The engine emits a single normalized [run-event stream](../reference/contracts/sse-event-schema.md) (`agent:token`, `agent:tool_call`, `agent:tool_result`, …) regardless of which provider produced it.
- **Cross-provider tool normalization.** Tool/function-calling schemas differ across providers; the engine must present one tool model to agents and translate to each provider's wire format.

This layer lives in `packages/llm` and is consumed by the pure-TypeScript engine from [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md). It must run in the same hosts the engine runs in (desktop, CLI, VS Code extension, Phase-2 cloud workers), so it cannot pull in a separate runtime. API keys are read from the OS keychain per [ADR-0006](0006-os-keychain-for-api-keys.md) and never exposed to the frontend.

## Decision

**We use the Vercel AI SDK as the multi-LLM provider layer**, wrapped in `packages/llm`. We do **not** run a Python LLM proxy (LiteLLM) or any Python sidecar.

Considered options:

1. **Vercel AI SDK** — TypeScript-native, unified streaming and tool-calling across Anthropic/OpenAI/Google/DeepSeek via provider adapters. *Chosen.*
2. **LiteLLM (Python sidecar/proxy)** — a mature multi-provider router, but Python.
3. **Per-provider official SDKs, normalized by hand** — maximum control, maximum boilerplate.

The Vercel AI SDK wins because it is TypeScript-native and gives unified streaming and tool normalization out of the box for exactly the providers we target, keeping the whole execution path in one language alongside the engine. A LiteLLM sidecar would reintroduce the Python runtime that [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md) deliberately removed — it cannot live inside the VS Code extension host, it bloats the Tauri bundle (see [ADR-0001](0001-tauri-v2-over-electron.md)), and it adds a process boundary on the hot path with its own lifecycle, ports, and failure modes. Hand-rolling per-provider SDKs gives the most control but reimplements precisely the streaming/tool-normalization work the SDK already provides.

The historical cross-provider tool-normalization design and cost-tracking notes from the earlier analysis remain valid as input to `packages/llm`'s adapter shape and are reused; the LiteLLM/Python transport they assumed is replaced by the Vercel AI SDK. Provider details and built-in tool wiring are documented in [architecture/multi-llm-providers.md](../architecture/multi-llm-providers.md) and [reference/shared-core/built-in-tools.md](../reference/shared-core/built-in-tools.md). Pinned versions live in [tech-stack.md](../tech-stack.md).

## Consequences

### Positive

- One TypeScript code path for every provider; the engine emits a single normalized [run-event stream](../reference/contracts/sse-event-schema.md) regardless of which model ran.
- No Python runtime and no sidecar process — `packages/llm` loads in the same hosts as the engine (desktop, CLI, VS Code extension, Phase-2 cloud workers), preserving the portability won in [ADR-0003](0003-pure-ts-engine-not-langgraph-python.md).
- Provider-agnostic tool calling: agents declare tools once and the SDK adapters translate to each provider's wire format.
- Adding a new provider is a contained adapter change in one package rather than a new transport or process.
- API keys stay server/engine-side: keys are read from the OS keychain (see [ADR-0006](0006-os-keychain-for-api-keys.md)) and passed into the SDK, never to the frontend.

### Negative

- We are coupled to the Vercel AI SDK's provider-adapter coverage and release cadence; a provider feature the SDK has not yet wrapped may need a temporary direct call. Mitigated by keeping `packages/llm` a thin, swappable wrapper rather than leaking SDK types across the engine.
- Provider-specific capabilities (e.g. a unique cache or reasoning control) may be normalized away by the unified abstraction; surfaced through escape-hatch config when genuinely needed.
- Cost/token accounting depends on per-provider usage reporting being mapped correctly into our cost model; this is an adapter responsibility documented in [architecture/multi-llm-providers.md](../architecture/multi-llm-providers.md).
- We do not get LiteLLM's broader long-tail provider catalog; acceptable because the MVP scope is API-based providers only (no Ollama / local models), so the target set is small and well covered.
