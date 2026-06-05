# @relavium/llm

Relavium's **own** multi-LLM abstraction: the provider-agnostic **`LLMProvider` seam** plus
(later) thin hand-rolled adapters over each provider's official TypeScript SDK. No Vercel AI SDK,
no LangChain — see [ADR-0011](../../docs/decisions/0011-internal-llm-abstraction.md).

## The immovable contract

The seam (`src/types.ts`) is expressed **only** in Relavium/Zod types. **No vendor SDK type ever
crosses it** — provider SDKs are imported _only_ inside `src/adapters/*` (enforced by the
import-zone lint fence). The canonical contract is
[docs/reference/shared-core/llm-provider-seam.md](../../docs/reference/shared-core/llm-provider-seam.md);
this package implements it. The seam's _shape_ is frozen; the adapters behind it are reversible,
and the _set_ of provider ids is meant to grow (an additive amendment, not a contract change).

## Status

**1.A — seam types frozen.** The adapters (Anthropic, the OpenAI-compatible adapter serving
OpenAI + DeepSeek, Gemini), the `FallbackChain` runner, the `CostTracker`, and the conformance
suite land in workstreams 1.B–1.K (see
[docs/roadmap/phases/phase-1-engine-and-llm.md](../../docs/roadmap/phases/phase-1-engine-and-llm.md)).
