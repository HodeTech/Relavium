# LLM Provider Seam

- **Status**: Stable
- **Canonical home**: the provider-agnostic `LLMProvider` contract exported by `packages/llm` (`@relavium/llm`)
- **Related**: [../../architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md) (rationale), [../../decisions/0011-internal-llm-abstraction.md](../../decisions/0011-internal-llm-abstraction.md) (the seam as an immovable contract), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md) (model/provider/fallback semantics), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md) (run events these chunks feed)

This page is the one canonical home for the **`LLMProvider` seam** — the
provider-agnostic boundary that every multi-LLM call in Relavium crosses. It is
implemented by `@relavium/llm`'s thin hand-rolled adapters over each provider's
official TS SDK (Anthropic and Gemini dedicated; OpenAI and DeepSeek share one
OpenAI-compatible adapter). The *why* lives in
[multi-llm-providers.md](../../architecture/multi-llm-providers.md) and the
decision to keep the seam itself immovable is recorded in
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md); this file is the
dry reference for the types and the normalization rules.

> **The immovable contract.** Every type below is a Relavium/Zod type. **No
> vendor SDK type — message shapes, content blocks, streaming events, tool-call
> representations, usage objects — may cross this seam.** That leak is the only
> thing that would make a future implementation swap expensive, so it is
> forbidden by [ADR-0011](../../decisions/0011-internal-llm-abstraction.md). The
> adapter implementation behind the seam is deliberately reversible; the seam is
> not. Provider SDKs stay strictly inside the adapter package.

## The core interface

The interface in `packages/llm/src/types.ts` is deliberately small: a
normalized request in, either a normalized result or a normalized chunk stream
out.

```ts
// Normalized request — provider-agnostic
interface LlmRequest {
  model: string;                 // canonical id, e.g. "claude-sonnet-4", mapped per adapter
  system?: string;               // ALWAYS a top-level field; adapters place it correctly
  messages: LlmMessage[];        // role: 'user'|'assistant'|'tool'
  tools?: ToolDef[];             // JSON-Schema params, normalized
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;            // REQUIRED downstream for Anthropic; we default it
  stopSequences?: string[];
  signal?: AbortSignal;          // cancellation, works in Node + Tauri WebView fetch
  providerOptions?: Record<string, unknown>; // typed escape hatch (caching, reasoning, etc.)
}

interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];        // normalized parts, not raw strings
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }      // assistant -> wants tool
  | { type: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean };

interface ToolDef {
  name: string;
  description?: string;
  parameters: JSONSchema7;       // single canonical schema; adapters reshape
}

// Normalized non-streaming result
interface LlmResult {
  content: ContentPart[];        // text + any tool_call parts
  stopReason: StopReason;
  usage: Usage;
  raw: unknown;                  // provider response, for debugging/escape hatch
}

type StopReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error';

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;      // Anthropic/DeepSeek expose; others undefined
  cacheWriteTokens?: number;
  costUsd?: number;              // computed by a pricing table keyed on canonical model id
}

// Normalized streaming — one discriminated union for ALL providers
type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsJsonDelta: string }  // partial JSON
  | { type: 'tool_call_end'; id: string }
  | { type: 'stop'; stopReason: StopReason; usage: Usage }
  | { type: 'error'; error: LlmError };

interface LlmProvider {
  readonly id: 'anthropic' | 'openai' | 'gemini' | 'deepseek';
  generate(req: LlmRequest, key: string): Promise<LlmResult>;
  stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk>;
  supports: CapabilityFlags;     // { tools, streaming, parallelToolCalls, vision, promptCache, reasoning }
}
```

The interface exposes a capability-gated lowest-common-denominator surface
(text + tools + streaming + usage). Provider-specific features (vision, prompt
caching, reasoning/thinking, parallel tool calls) are deliberately **out of the
common path** and reached only through the typed `providerOptions` escape hatch
and the `supports` capability flags — never by leaking a vendor shape across the
seam.

## What must be normalized

The seam's value is entirely in the normalization the adapters perform. Each of
the following is reshaped from one canonical Relavium form into the provider's
native form on the way in, and folded back into the canonical form on the way
out.

### 1. System-prompt placement

`system` is **always one top-level field** on `LlmRequest`. Each adapter routes
it to the right place:

| Provider | Where `system` goes |
| --- | --- |
| OpenAI / DeepSeek | A `{ role: 'system' }` message **prepended** to `messages` (it is *not* a message in our model). |
| Anthropic | The top-level `system` request param — **not** a message. |
| Gemini | The `systemInstruction` field on the request. |

### 2. Tool / function schema

One canonical `JSONSchema7` per `ToolDef` goes in; three native shapes come out:

| Provider | Native tool shape |
| --- | --- |
| OpenAI / DeepSeek | `tools: [{ type: 'function', function: { name, description, parameters } }]` |
| Anthropic | `tools: [{ name, description, input_schema }]` |
| Gemini | `tools: [{ functionDeclarations: [{ name, description, parameters }] }]` with a **restricted OpenAPI-subset** schema (no `$ref`, limited formats). |

The Gemini reshape is the riskiest: the adapter **validates and strips
unsupported JSON-Schema keywords** before sending. One canonical schema in,
three shapes out.

### 3. Tool-call / result round-trip

| Provider | Assistant tool call | Tool result |
| --- | --- | --- |
| OpenAI / DeepSeek | `tool_calls[]` with an `id` + stringified-JSON args | a `{ role: 'tool', tool_call_id }` message |
| Anthropic | a `content` block `tool_use { id, name, input }` | a user message with a `tool_result { tool_use_id }` block |
| Gemini | a `functionCall { name, args }` part (**no id**) | a `functionResponse` part (**no id**) |

Gemini exposes **no tool-call id**, so the adapter **synthesizes and tracks ids
itself by name + order** and rehydrates them into the canonical
`ContentPart.tool_call.id` / `tool_result.toolCallId`. Normalizing this
missing-id case is a real edge and is owned entirely inside the Gemini adapter —
callers always see ids.

### 4. Streaming events

Every adapter folds its native event stream into the single `StreamChunk`
discriminated union:

| Provider | Native stream | Folded into |
| --- | --- | --- |
| OpenAI / DeepSeek | SSE `chat.completion.chunk` with `choices[].delta` (content or `tool_calls` fragments; tool-call args arrive as incremental JSON-string fragments per index). | `text_delta`, `tool_call_*`, `stop` |
| Anthropic | Typed events: `message_start`, `content_block_start` / `delta` (`text_delta` \| `input_json_delta`) / `stop`, `message_delta` (carries `stop_reason` + `usage`), `message_stop`. | `text_delta`, `tool_call_*`, `stop` |
| Gemini | `streamGenerateContent` candidate chunks with `parts`. | `text_delta`, `tool_call_*`, `stop` |

Tool-argument JSON deltas are concatenated into `argsJsonDelta` across
`tool_call_delta` chunks and **parsed once at `tool_call_end`**. The final
`stop` chunk always carries `stopReason` + `usage`.

### 5. Stop reasons

All native stop reasons map onto the five-value `StopReason` enum
(`stop | length | tool_use | content_filter | error`):

| Provider | Native | Maps to |
| --- | --- | --- |
| OpenAI / DeepSeek | `stop` / `length` / `tool_calls` / `content_filter` | `stop` / `length` / `tool_use` / `content_filter` |
| Anthropic | `end_turn` / `max_tokens` / `tool_use` / `stop_sequence` | `stop` / `length` / `tool_use` / `stop` |
| Gemini | `STOP` / `MAX_TOKENS` / `SAFETY` / `RECITATION` | `stop` / `length` / `content_filter` / `content_filter` |

### 6. Usage

| Provider | Native usage | Maps to |
| --- | --- | --- |
| OpenAI | `usage { prompt_tokens, completion_tokens }` (+ `prompt_tokens_details.cached_tokens`) | `inputTokens` / `outputTokens` (+ `cacheReadTokens`) |
| Anthropic | `usage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }` | `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` |
| Gemini | `usageMetadata { promptTokenCount, candidatesTokenCount }` | `inputTokens` / `outputTokens` |
| DeepSeek | mirrors OpenAI + `prompt_cache_hit_tokens` | `inputTokens` / `outputTokens` / `cacheReadTokens` |

Two streaming subtleties the adapters must handle:

- **OpenAI** requires `stream_options: { include_usage: true }` to emit a final
  usage chunk; Anthropic puts usage in `message_delta`; Gemini in the final
  chunk.
- **`costUsd` is ours, never the provider's** — it is computed by a Relavium
  pricing table keyed on the **canonical model id**, not read from any provider
  response. This is the same `costUsd` that surfaces in the `cost:updated` run
  event (see [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md)).

## Fallback lives outside the adapter

Adapters stay **dumb**: they normalize one provider and nothing more. Fallback
chains are **policy**, implemented in a small `withFallback(providers:
LlmProvider[])` runner (in `packages/core`/`packages/llm`):

- Try `providers[0]`; on a **classified-retryable** `LlmError` (rate limit,
  5xx, overload) move to the next provider.
- Surface **per-attempt usage** so cost accounting stays accurate even across a
  failover.

This keeps per-agent fallback (e.g. Anthropic → OpenAI → DeepSeek) a config
concern declared in [`agent-yaml-spec.md`](../contracts/agent-yaml-spec.md)
(`fallback_chain` with `max_attempts`), not adapter code.

## Dependency posture

The adapters prefer the official SDKs (`@anthropic-ai/sdk`, `openai`,
`@google/genai`) for typed event parsing and retry plumbing; **DeepSeek reuses
the `openai` SDK with a custom `baseURL` (`api.deepseek.com`)** — no separate
dependency. The SDKs live strictly **behind the adapter boundary** so they are
swappable without touching any caller. A future implementation may drop the
SDKs for raw `fetch` + an SSE parser (maximum no-lock-in), or slot a thin
third-party TS library behind the **same seam** — but only on a named trigger
via a follow-up ADR, and **never the Vercel AI SDK**. See
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md) for the migration
stance and the named triggers.
