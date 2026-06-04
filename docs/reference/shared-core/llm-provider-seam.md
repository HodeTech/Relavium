# LLM Provider Seam

- **Status**: Stable
- **Canonical home**: the provider-agnostic `LLMProvider` contract exported by `packages/llm` (`@relavium/llm`)
- **Related**: [../../architecture/multi-llm-providers.md](../../architecture/multi-llm-providers.md) (rationale), [../../decisions/0011-internal-llm-abstraction.md](../../decisions/0011-internal-llm-abstraction.md) (the seam as an immovable contract), [../../architecture/managed-inference.md](../../architecture/managed-inference.md) (the Phase-2 `ManagedGatewayProvider` behind this seam), [../contracts/agent-yaml-spec.md](../contracts/agent-yaml-spec.md) (model/provider/fallback semantics), [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md) (run events these chunks feed)

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
  model: string;                 // canonical id, e.g. "claude-sonnet-4-6", mapped per adapter
  system?: string;               // ALWAYS a top-level field; adapters place it correctly
  messages: LlmMessage[];        // role: 'user'|'assistant'|'tool'
  tools?: ToolDef[];             // JSON-Schema params, normalized
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;            // REQUIRED downstream for Anthropic; we default it
  stopSequences?: string[];
  signal?: AbortSignal;          // cancellation; host-injected transport (desktop aborts the Rust llm_stream egress, ADR-0018)
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
  costMicrocents?: number;              // integer micro-cents (canonical unit defined below); computed by a pricing table keyed on canonical model id
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

> **The `key` parameter is host-aware (its `string` *type* is unchanged).** On the
> **Node-style surfaces** (CLI, VS Code extension host, Phase-2 Bun API) `key` is the
> **resolved provider key**, read from the OS keychain at call time inside the one
> trusted process. On the **desktop** `key` is instead a key **reference** (the
> keychain account id, e.g. `anthropic:default`): the WebView-resident adapter passes
> that reference to the Rust `llm_stream` command, and **Rust resolves the real key
> and attaches the `Authorization` header** — the raw key never enters the WebView.
> In **managed** mode (Phase 2) `key` carries a managed session/auth token instead of
> a provider key (see [`ManagedGatewayProvider`](#a-second-implementation-behind-the-same-seam-managedgatewayprovider-phase-2)).
> In every case it is simply "the credential the implementation needs," so the seam
> types are identical across hosts and modes. This host-aware handling is the seam
> side of [ADR-0018](../../decisions/0018-desktop-execution-and-rust-egress.md); the
> desktop egress wiring is in
> [../contracts/ipc-contract.md](../contracts/ipc-contract.md#rust-delegated-llm-egress).

The interface exposes a capability-gated lowest-common-denominator surface
(text + tools + streaming + usage). Provider-specific features (vision, prompt
caching, reasoning/thinking, parallel tool calls) are deliberately **out of the
common path** and reached only through the typed `providerOptions` escape hatch
and the `supports` capability flags — never by leaking a vendor shape across the
seam.

### `LlmError` — the normalized error type

`LlmError` is the **one error shape that crosses the seam**: every failure inside
an adapter is normalized to it before it escapes (no vendor SDK error shape ever
leaks — same boundary rule as every other type here). The seam **owns** this type;
[error-handling.md](../../standards/error-handling.md#llmerror-classification--the-contract-the-fallback-chains-depend-on)
pins how the `withFallback` runner *classifies* it (retryable vs fatal) but defers
the definition here.

```ts
interface LlmError {
  kind: LlmErrorKind;        // stable discriminant callers narrow on — never error.message
  retryable: boolean;        // the classification the fallback runner acts on
  code?: string;             // provider/transport code, normalized where possible (e.g. 'rate_limit', 'overloaded')
  status?: number;           // upstream HTTP status when there was one (429, 5xx, 401, 400, …)
  provider: LlmProvider['id']; // which adapter produced it
  message: string;           // human-readable, already redacted of any secret material
  cause?: unknown;           // original error, for debugging/escape hatch only — never re-thrown across the seam
}

type LlmErrorKind =
  // retryable === true
  | 'rate_limit'             // 429
  | 'overloaded'             // provider 5xx / capacity
  | 'timeout'                // request deadline exceeded
  | 'transport'             // connection reset / DNS / TLS
  // retryable === false (fatal)
  | 'auth'                   // 401/403 — bad or missing key
  | 'bad_request'            // 400 — malformed request, unsupported model id, rejected tool schema
  | 'content_filter'         // content-policy refusal
  | 'cancelled'              // AbortSignal
  | 'unknown';               // unclassifiable — treated as fatal
```

The `kind`/`retryable` split is the contract the fallback runner depends on: a
`retryable` `LlmError` advances `withFallback` to the next provider (recording the
failed attempt's usage so cost stays accurate across the failover); a fatal one is
surfaced and stops the chain. The per-provider mapping (native status/code →
`kind`) lives **inside each adapter** and is exercised by the per-provider
conformance suite — the runner never inspects a provider code directly.

### Adding a provider id is an additive, backwards-compatible amendment

The `LlmProvider.id` union (`'anthropic' | 'openai' | 'gemini' | 'deepseek'`) is
part of the seam, but **extending it with a new id is an *additive* amendment, not
a change to the immovable contract.** Adding a value to the union does not alter
any existing type, method signature, or normalization rule, so it does **not**
require a superseding ADR — it is recorded as an additive note under
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md) (the seam ADR). This
is what lets the add-llm-adapter workflow ship a new adapter (a new `LlmProvider`
implementation plus its `id`) **without** "changing the immovable seam": the seam's
*shape* (request/result/stream types, the normalization contract) is what is
frozen — the *set* of conforming implementations behind it is meant to grow. What
would require a real (superseding) ADR is changing the seam shape itself: the
request/result/stream types, the normalization rules, or the `LlmError` contract
above.

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
- **`costMicrocents` is ours, never the provider's** — it is computed by a Relavium
  pricing table keyed on the **canonical model id**, not read from any provider
  response. This is the same `costMicrocents` that surfaces in the `cost:updated` run
  event (see [../contracts/sse-event-schema.md](../contracts/sse-event-schema.md)).

> **Canonical cost unit (the one home).** All cost figures in Relavium — the seam's
> `Usage.costMicrocents`, the `cost:updated` event's `costMicrocents` /
> `cumulativeCostMicrocents`, and the persisted cost records — are **integer
> micro-cents**, where **1 micro-cent = 1e-8 USD = 1e-6 cent**. Costs are always
> integers (never floats) to avoid precision loss when summing thousands of
> per-token charges; the SQLite type-mapping detail is in
> [../desktop/database-schema.md](../desktop/database-schema.md). Every other
> document links here rather than restating the unit.

#### Stricter usage-capture rules in managed mode (Phase 2)

In Phase 1 (BYOK) the worst case for a missing usage chunk is a slightly
inaccurate local cost estimate. In **managed** mode (Phase 2,
[../../architecture/managed-inference.md](../../architecture/managed-inference.md))
the same `Usage` shape becomes a **billing record**, so the gateway tightens the
capture rules — without changing the seam types:

- **Forced `include_usage`.** The gateway **forces**
  `stream_options: { include_usage: true }` on every OpenAI/DeepSeek managed
  request (it is not left to caller config), so a final usage chunk is always
  emitted. Anthropic usage is accumulated from `message_start` (input) and
  `message_delta` (running output); Gemini usage is read from the final chunk's
  `usageMetadata`.
- **Interruption estimation.** If the stream is aborted before a final usage
  frame arrives, the gateway **estimates** usage from the streamed output plus
  the known input and records the event as estimated — a billable request is
  never silently dropped.
- **Nightly reconciliation.** Estimated and rounded rows are reconciled against
  the providers' own usage/invoice data nightly, correcting drift in the COGS
  figure.

These are gateway-side behaviors layered on top of the same normalized `Usage`;
the seam types are unchanged. The full metering design is in
[../../architecture/managed-inference.md](../../architecture/managed-inference.md).

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

## A second implementation behind the same seam: `ManagedGatewayProvider` (Phase 2)

Phase 2 adds a **new `LLMProvider` implementation, `ManagedGatewayProvider`**,
selected by the factory when `executionMode` is `'managed'`. Instead of calling a
provider SDK directly, it is a thin client that calls a Relavium gateway over
HTTPS; the gateway runs the **same** per-provider adapters server-side with
**Relavium's** key and streams results back as the same normalized `StreamChunk`
union. **No seam type changes are required** — this is exactly the reversibility
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md) preserves: the seam
is immovable, the implementation behind it is not. The `ManagedGatewayProvider`
satisfies the identical `LLMProvider` contract (`id`, `generate`, `stream`,
`supports`), so `packages/core` cannot tell it apart from a direct adapter. In
managed mode the `key: string` parameter on `generate`/`stream` carries a
**managed session/auth token**, not a provider key — it is simply "the credential
the implementation needs," so the real provider key is injected gateway-side and
never reaches this client, leaving the seam types unchanged across all three
modes. The full design — gateway, key vault and pools, metering — is in
[../../architecture/managed-inference.md](../../architecture/managed-inference.md).

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
