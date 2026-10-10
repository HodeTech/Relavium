# @relavium/llm

Relavium's **own** multi-LLM abstraction: the provider-agnostic **`LLMProvider` seam** plus
thin hand-rolled adapters over each provider's official TypeScript SDK. No Vercel AI SDK,
no LangChain — see [ADR-0011](../../docs/decisions/0011-internal-llm-abstraction.md).

## The immovable contract

The seam (`src/types.ts`) is expressed **only** in Relavium/Zod types. **No vendor SDK type ever
crosses it** — provider SDKs are imported _only_ inside `src/adapters/*` (enforced by the
import-zone lint fence). The canonical contract is
[docs/reference/shared-core/llm-provider-seam.md](../../docs/reference/shared-core/llm-provider-seam.md);
this package implements it. Its shape evolves through explicit ADRs; the adapters behind it
remain reversible, and vendor types remain confined to them.

## Status

The Anthropic, OpenAI-compatible (OpenAI + DeepSeek) and Gemini adapters, `FallbackChain`,
`CostTracker` and offline conformance suite are implemented. W7's request ownership and
overflow work is merged. W8's internal [expected-exchange harness](src/conformance/README.md)
provides strict request matching and a 24-case canonical actual-SDK HTTP matrix, with
reproducible production-lowering mutation controls. Step 3 is independently accepted on `development`;
honest missing/partial usage integration and whole-W8 publication remain open. See
[current work](../../docs/roadmap/current.md#next-work--phase-265-w8).
Existing response fixtures alone do not prove the request wire contract.
