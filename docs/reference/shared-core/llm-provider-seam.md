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
  reasoningEffort?: ReasoningEffort; // normalized tier off|low|medium|high|max (ADR-0066); each adapter maps to its provider's native tier — CANONICAL, wins over a colliding providerOptions key; absent ⇒ provider default
  stopSequences?: string[];
  responseFormat?: ResponseFormat; // structured-output request (ADR-0030)
  outputModalities?: OutputModality[]; // request media output on the INLINE path (ADR-0031); default ['text']
  signal?: AbortSignalLike;      // cancellation — the structural, platform-free signal contract from @relavium/shared (a real AbortSignal satisfies it); host-injected transport (desktop aborts the Rust llm_stream egress, ADR-0018)
  providerOptions?: Record<string, unknown>; // typed escape hatch (caching, reasoning, etc.)
}

// The output-modality vocabulary (OWNED by @relavium/shared constants.ts, ADR-0031). `document`
// (PDF) is input-only — no provider emits a PDF as a chat-turn output.
type OutputModality = 'text' | 'image' | 'audio' | 'video';

// Structured-output contract (ADR-0030). Each adapter lowers `json` to the provider's native mode
// (OpenAI json_schema; Gemini responseJsonSchema; Anthropic output_config; DeepSeek json_object — no
// schema enforcement, so its fidelity is "parseable JSON", not schema-validated).
type ResponseFormat =
  | { type: 'text' }
  | { type: 'json'; schema: JSONSchema7; name?: string; strict?: boolean };

interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];        // normalized parts, not raw strings
}

// `ContentPart` is OWNED by @relavium/shared (ContentPartSchema) and re-exported by this seam —
// @relavium/shared never imports from @relavium/llm (that would invert the package dependency).
type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; signature?: string; redacted?: boolean }  // ADR-0030; signature is ephemeral — replayed SAME-provider (the Anthropic adapter lowers it back to a thinking block), stripped on a cross-provider failover (ADR-0039)
  | { type: 'tool_call'; id: string; name: string; args: unknown; providerExecuted?: boolean }   // assistant -> wants tool
  | { type: 'tool_result'; toolCallId: string; result: unknown; isError?: boolean; providerExecuted?: boolean;
      media?: DurableMediaPart[] }  // ADR-0031 #7 — typed handle-only attachments; raw media bytes in `result` are FORBIDDEN
  | { type: 'media'; mimeType: string; source: MediaSource; name?: string; transcript?: string };  // ADR-0031 — the in-flight media arm; modality = MIME prefix

// The media carriers (ADR-0031; OWNED by @relavium/shared content.ts). Platform-free: every
// carrier is a string — never a Buffer/Blob. base64 is the in-flight tiny tier, bounded by
// INLINE_MEDIA_CEILING **decoded** bytes per modality (256 KB image/audio; video and document are
// NEVER inline — ceiling 0); per-message count + aggregate-decoded-bytes caps (MEDIA_MESSAGE_CAPS)
// ride the same ingestion boundary. The `url` carrier ships FEATURE-FLAG-OFF
// (MEDIA_URL_SOURCE_ENABLED) until the one shared SSRF range-primitive lands (1.AE).
// EVERY mimeType position — both media arms, media_start, MediaGenRequest — shares the one
// bounded bare-`type/subtype` schema (MediaMimeTypeSchema, ≤255 chars, parameters rejected): an
// unbounded value would turn interpolated rejection messages into a bytes channel (I3). The text
// hints are guarded the same way: `name` is bounded (≤255) and neither `name` nor `transcript`
// may be a base64 `data:` URI — bytes ride the source carrier only.
type MediaSource =                       // in-flight union (request/result content)
  | { kind: 'base64'; data: string }
  | { kind: 'handle'; ref: string }      // `media://sha256-<64hex>` — the canonical durable form
  | { kind: 'url'; url: string };
type DurableMediaSource = { kind: 'handle'; ref: string };  // durable union: handle ONLY — base64/url structurally absent

// The DURABLE fork of the media arm (what persisted/event/IPC positions reference): handle-only
// source plus the Y3 integrity metadata, host-populated at the deInlineMedia boundary. No
// `checksum` field — the content-addressed handle IS the sha256.
type DurableMediaPart = {
  type: 'media'; mimeType: string; source: DurableMediaSource; name?: string; transcript?: string;
  byteLength?: number;   // bounds a Range/byte-delivery request without trusting a raw file size
  durationMs?: number;   // audio/video only — render/desync metadata
};
// DurableContentPart mirrors ContentPart with the durable media arm and a SIGNATURE-LESS reasoning
// arm ({ type: 'reasoning'; text; redacted? }) — the ADR-0030 "never persisted" guarantee made
// structural. deInlineMedia (engine-owned, wired at 1.AF) is the typed flight→durable transform.

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

// `StopReason` is also OWNED by @relavium/shared (constants.ts STOP_REASONS, used by
// `session:turn_completed`) and re-exported by the seam — same one-way ownership as `ContentPart`.
type StopReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error';

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;      // Anthropic/DeepSeek expose; others undefined
  cacheWriteTokens?: number;
  reasoningTokens?: number;      // ADR-0030 — OBSERVABILITY only; a subset of outputTokens (≤), never billed separately
  mediaUnits?: MediaUnitsEntry[]; // ADR-0031 — a DISJOINT media axis (per-image / per-second), never folded into tokens
  costMicrocents?: number;              // integer micro-cents (canonical unit defined below); computed by a pricing table keyed on canonical model id
}

// One media usage record (ADR-0031). `modality` is the deliberately complete media-BILLED closed
// set — document (PDF) and text bill as tokens, so they are excluded, not forgotten. Doubles as
// the managed-mode metering record (counts, never content — ADR-0015).
interface MediaUnitsEntry {
  modality: 'image' | 'audio' | 'video';
  direction: 'input' | 'output';
  units: number;                 // images, audio-seconds, video-seconds — the provider's billed unit
  unit: 'count' | 'second';
}

// Normalized streaming — one discriminated union for ALL providers
type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_start'; id: string }                          // ADR-0030 — reasoning channel
  | { type: 'reasoning_delta'; id: string; text: string }
  | { type: 'reasoning_end'; id: string; signature?: string; redacted?: boolean }  // signature/redacted both surfaced on the stream
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argsJsonDelta: string }  // partial JSON; count/timing is provider-dependent — accumulate, parse at tool_call_end
  | { type: 'tool_call_end'; id: string }
  | { type: 'media_start'; id: string; mimeType: string }            // ADR-0031 — media output channel (mirrors the triads); mimeType is bounded bare type/subtype (MediaMimeTypeSchema)
  | { type: 'media_delta'; id: string; progress?: number; partialRef?: string }  // progress is a 0..1 fraction; NO base64 ever; partialRef is a RESERVED preview HANDLE (A3)
  | { type: 'media_end'; id: string; media: DurableMediaPart }       // terminal — the finished media as a handle-only durable part
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean; providerExecuted: true;
      media?: DurableMediaPart[] }  // ADR-0030 provider-run tool (engine records, never runs); media: ADR-0031 #7
  | { type: 'stop'; stopReason: StopReason; usage: Usage }
  | { type: 'error'; error: LlmError };

interface LlmProvider {
  readonly id: 'anthropic' | 'openai' | 'gemini' | 'deepseek';
  generate(req: LlmRequest, key: string): Promise<LlmResult>;
  stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk>;
  readonly supports: CapabilityFlags;  // { tools, streaming, parallelToolCalls, vision, promptCache, reasoning, media } — vision is the derived alias of media.input.image (ADR-0031)
  // ADR-0031 decision #6 — separate-endpoint media generation. The A5 ADR ([ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md))
  // is landed and the SHAPE is final (the additive pollMediaJob `signal` param, 1.AG Section A); the BEHAVIOR
  // is WIRED — `generateMedia` SYNC de-inline (1.AG Section C) + the engine-owned async poll/checkpoint/
  // resume/cancel loop (1.AG Section D). The Sora/Veo/Imagen/TTS ADAPTER impls are 1.AH host-wiring.
  generateMedia?(req: MediaGenRequest, key: string): Promise<MediaGenResult>;  // sync → { media }; async → { jobId } (Relavium-opaque — never a vendor operation name)
  pollMediaJob?(jobId: string, key: string, signal?: AbortSignalLike): Promise<MediaJobStatus>; // pending(progress?) | done(media) | failed(LlmError); signal aborts the in-flight poll (1.AG/ADR-0045 §4)
  // ADR-0062 context-compaction: per-provider token/context vocabulary, in Relavium/Zod seam types only (no vendor type crosses).
  contextLimit?(model: string): number | undefined;      // the model's context window in tokens; undefined for an unrated/custom model (engine then skips auto-compaction)
  managesOwnContext?(): boolean;                          // provider bounds context itself ⇒ engine skips compaction; false for all current providers
  estimateTokens?(input: EstimateTokensInput): number;   // { system, messages, tools? } → a per-provider estimate; a pre-first-turn FALLBACK only (real usage is authoritative)
  // ADR-0064 live model catalog: return the models this `key` can reach, each mapped INSIDE the adapter to a
  // Relavium ModelListing (no vendor models.list() type crosses). OPTIONAL (a provider without a list endpoint
  // omits it → host degrades to static-only). Bounded + abortable + secret-free; one bad row is dropped, a
  // breaking endpoint change throws a classified, key-redacted LlmProviderError. See "Model discovery" below.
  listModels?(key: string, signal?: AbortSignalLike): Promise<ModelListing[]>;
}

// The per-modality capability matrix (ADR-0031 decision #3). Input composability is unconstrained
// (per-modality booleans; `document` gates application/pdf DISTINCTLY from image — A2). Output is
// `outputCombinations`: the CLOSED set of modality-sets a model can emit in ONE turn ([] = no
// media output) — independent booleans would advertise wire-invalid combinations (e.g. Gemini
// image+audio). requiredCapabilities() gains the input check + the outputCombinations MEMBERSHIP
// check at 1.AF, so an incapable provider fails fast and the FallbackChain skips it.
interface CapabilityFlags {
  tools: boolean; streaming: boolean; parallelToolCalls: boolean;
  vision: boolean;               // TEMPORARY derived alias of media.input.image — a refine pins them equal; removed in a later cleanup
  promptCache: boolean; reasoning: boolean;
  media: {
    input: { image: boolean; audio: boolean; video: boolean; document: boolean };
    outputCombinations: OutputModality[][];
    surface?: 'chat' | 'generative'; // media-output surface (1.AG/ADR-0045 §1); absent ⇒ 'chat'; the seam projection of model_catalog.media_surface
  };
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

The interface exposes a capability-gated common-path surface: text + tools +
streaming + usage, plus the canonical **reasoning channel** (ADR-0030) and the
canonical **media shapes** (ADR-0031 — shape landed at 1.AD, behavior wired
1.AE+). Provider-specific features with no cross-provider shape (prompt-cache
control, thinking budgets, safety settings, parallel-tool-call toggles) stay
**out of the common path**, reached only through the typed `providerOptions`
escape hatch and gated by the `supports` capability flags — never by leaking a
vendor shape across the seam. The promotion rule is ADR-0030's: a capability
shared by several providers in both directions becomes first-class seam shape;
a single-provider quirk rides `providerOptions`.

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

> **The internal-diagnostics rule (`cause` and the `raw` passthroughs).** `LlmError.cause`,
> `LlmResult.raw`, and `MediaGenResult.raw` are internal diagnostics only: **never logged,
> serialized, checkpointed, or put in a run event — any sink strips them first** (the run-event
> error shape `{ code, message, retryable }` already excludes `cause`). This matters doubly for
> media (ADR-0031): from 1.AE/1.AG on, `raw` is the highest-volume media-bytes carrier (vendor
> `b64_json` / `inlineData`), and vendor shapes inside it are invisible to the canonical-shape
> backstop scans — stripping at the sink is the only guarantee.

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

### Seam-shape amendments ([ADR-0030](../../decisions/0030-llm-seam-shape-amendment-reasoning-response-format-provider-executed.md))

Three cross-provider shape additions were made under ADR-0030 (a real amendment to
ADR-0011, decided before the seam froze at M1, while the only consumers were the
adapters):

- **Reasoning channel.** `ContentPart` gains a `reasoning` arm
  (`{ type: 'reasoning', text, signature?, redacted? }`); `StreamChunk` gains
  `reasoning_start` / `reasoning_delta` / `reasoning_end` (mirroring the
  `tool_call_*` triad; `reasoning_end` carries the optional `signature` and
  `redacted` flag — both surfaced on the streaming path, symmetric with the
  non-streaming `reasoning` content part); `Usage` gains an optional
  `reasoningTokens` (**observability only** — already inside `outputTokens` for
  billing on Anthropic/OpenAI; on Gemini, thinking tokens are billed *separately*
  from candidates, so the adapter sums both into `outputTokens` and surfaces the
  thinking subset as `reasoningTokens`). **Reasoning is ephemeral:** a provider-signed
  `signature` is never persisted to a session, never replayed across a provider
  boundary on fallback, and never written to a run event or log — the engine does
  not interpret it; only the originating adapter feeds it back (a same-provider,
  same-turn obligation enforced by the 1.K `FallbackChain` strip-on-failover, which
  drops every `reasoning` part on a cross-provider advance — see the fallback section
  below).
- **`responseFormat`** on `LlmRequest` — `{ type: 'text' } | { type: 'json', schema, name?, strict? }`,
  one canonical JSON-Schema each adapter lowers to the provider's native
  structured-output mode (OpenAI `response_format`, Gemini `responseJsonSchema`,
  Anthropic `output_config`). This is the seam mechanism that realizes a node's
  `output_schema`. (The opencode `{ type: 'tool' }` variant is deliberately not
  adopted — `toolChoice: { name }` already forces a specific tool.)
- **`providerExecuted`** — an optional flag on `ContentPart` `tool_call`/`tool_result`
  plus a provider-executed `tool_result` `StreamChunk` arm, distinguishing a tool
  the **provider** ran on its own side (server-side/built-in) from one the engine
  runs. The engine `ToolDispatcher` skips `providerExecuted` calls (no
  double-execution, and the allowlist applies only to engine-run calls). Phase-1
  adapters reserve the shape but emit no server-tool calls (off the common path).

### Seam-shape amendments ([ADR-0031](../../decisions/0031-llm-seam-shape-amendment-multimodal-io.md))

Eight cross-provider shape additions for **first-class multimodal I/O** were made under
ADR-0031 (a second pre-freeze amendment to ADR-0011, in the ADR-0030 mould — decided
while the only consumers were the adapters, so the new union members are non-breaking).
The shapes landed with roadmap task **1.AD** as **shape only**: behavior arrives with
1.AE–1.AH. `MediaSource`, `INLINE_MEDIA_CEILING`, the media arms, and the durable fork
are **owned by `@relavium/shared`** (`content.ts`, same one-way ownership as
`ContentPart`); the seam re-exports them. The binding security guardrails (the active
`deInlineMedia` emit-time pass, the ephemeral provider-ref sidecar, SSRF, desktop IPC,
managed mode) are recorded in the ADR — this section is the dry shape reference.

- **The `media` `ContentPart` arm, forked flight vs durable.** One MIME-discriminated
  in-flight arm (`{ type: 'media', mimeType, source, name?, transcript? }`) covers
  image / audio / video / `application/pdf` — modality derives from the MIME prefix
  (`mediaModalityOf`), so a new format needs zero schema change. The distinct
  **`DurableMediaPart`** narrows `source` to **handle-only** (`media://sha256-<64hex>`,
  validated by `MEDIA_HANDLE_PATTERN`) and carries the optional Y3 integrity metadata
  (`byteLength?`, audio/video-only `durationMs?`; **no `checksum`** — the handle is the
  sha256), so the compiler proves no bytes reach a durable schema. `DurableContentPart`
  additionally drops the reasoning `signature` **structurally** (parsing a signed part
  through it strips the field — the ADR-0030 never-persisted rule made type-level). An
  ephemeral provider-hosted ref (Gemini `fileUri`, OpenAI `file_id`/`audio.id`) is
  **structurally absent from every part** — it lives only in a process-scoped adapter
  sidecar keyed by `(provider, sha256)` (ADR-0031 §Guardrails).
- **The `media_start` / `media_delta` / `media_end` `StreamChunk` triad** (mirrors the
  `tool_call_*`/`reasoning_*` triads; `id` correlates). **No base64 ever rides the
  normalized stream**: `media_delta` carries `progress?` plus `partialRef?` — a
  **reserved, host-implementation-defined** preview *handle* (A3; unset by every adapter
  until 1.AH / Phase E) — and `media_end` carries a handle-only `DurableMediaPart`. The raw
  desktop IPC path is [ADR-0032](../../decisions/0032-desktop-rust-media-de-inline-amends-0018.md)'s concern.
- **The `CapabilityFlags.media` matrix** — per-modality `input` booleans (`document`
  gates PDF distinctly from `image`, A2) plus **`outputCombinations`**, the closed set of
  modality-sets a model can emit in one turn (`[]` = no media output). `vision` stays as
  a **derived alias of `media.input.image`** — a refine pins the two equal so they cannot
  drift — and is removed in a later cleanup. **At 1.AD every adapter honestly advertises
  all-false / `[]`** (nothing is wired; advertising more would re-create the
  "advertised but unsendable" vision lie), and a shared pre-flight guard
  (`assertNoMediaRequested`) makes each adapter **fail fast with the typed
  `UnsupportedCapabilityError`** — never a silent flatten — on a media part, a
  `tool_result` media attachment, or a non-text `outputModalities` request. That guard
  is the **live** media gate at 1.AD (the `LlmMessageSchema` caps bind a parsed
  request); it stays until 1.AE/1.AF wire request validation + `requiredCapabilities()`
  media gating (input check + `outputCombinations` **membership** check →
  `FallbackChain` skip) at the same entry.
- **`Usage.mediaUnits`** — a disjoint observability + billing axis (per-image /
  per-second, never folded into tokens; no refine ties it to token counts). The inner
  `modality` enum is the deliberately complete media-billed set `image`/`audio`/`video`
  (document and text bill as tokens — excluded, not forgotten). Doubles as the
  managed-mode metering record (counts-not-content, ADR-0015).
- **`LlmRequest.outputModalities`** — request non-text output on the inline path
  (default `['text']`), the symmetric mechanism to ADR-0030's `responseFormat`. Lowering
  is per-adapter (Gemini `responseModalities`; OpenAI audio via Chat `modalities`+`audio`).
  **Delivery path (wired at 1.AG Section B, [ADR-0046](../../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md)):**
  a media-output turn issues a single-shot **`generate()`** (the chain's existing
  non-streaming path) whose `LlmResult.content` carries the in-flight base64 `media`
  part — the engine de-inlines it to a `media://` handle at `#emitDurable`. The
  **streaming** triad stays host-deferred (ADR-0046 §4). **The OpenAI image-out
  exception:** inline image generation is the Responses `image_generation` **built-in
  tool** — it routes through the `providerExecuted` `tool_result` arm, never through
  `outputModalities` (the Responses-API wire is deferred; the shape is defined).
- **`tool_result.media: DurableMediaPart[]`** (content part **and** stream arm) — typed,
  handle-only media attachments. **Raw media bytes inside the opaque `result` are
  forbidden** so the typed guard reaches provider-executed image-gen results; `result`
  carries at most a descriptor.
- **Optional `generateMedia?` / `pollMediaJob?` on `LlmProvider`** (decision #6;
  [ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)) with
  `MediaGenRequest` / `MediaGenResult` / `MediaJobStatus`: a sync generator resolves `{ media }`;
  an async one (Sora, Veo) resolves a **Relavium-opaque** `jobId` (no vendor operation name
  crosses the seam); `failed` carries the existing classified `LlmError` (content-policy →
  `content_filter`). **Wired (1.AG Sections C/D + 1.AH adapters):** `generateMedia` SYNC — the OpenAI
  adapter implements gpt-image-1 image generation (`images.generate` → base64 `media`) and
  **OpenAI-TTS audio** (`audio.speech` binary → base64 + `response_format`↔MIME, 1.AH A1), and the
  **Gemini-Imagen** adapter implements image generation (`generateImages` → base64 `media`, 1.AH A2); a
  `media_surface: 'generative'` agent node routes here instead of the inline `generate()`/`stream()`
  (the engine resolves the per-model surface). The ASYNC `pollMediaJob` poll/checkpoint/resume/cancel
  loop is WIRED in the engine (Section D — `media_job:submitted` park, the derived `pendingMediaJobs`
  slot, re-attach-on-resume, a host-timer poll cadence, deadline→retryable-timeout,
  cancel→abort→terminal sweep; failed→`content_filter`), and the async adapters implement it — **OpenAI/Sora**
  (`videos.create` → an opaque `jobId`, `pollMediaJob` → `videos.retrieve`/`downloadContent` → base64, 1.AH A3)
  and **Gemini/Veo** (`models.generateVideos` → an operation, `pollMediaJob` → `operations.getVideosOperation`
  → inline `videoBytes` base64 OR a re-hostable `url` source the engine de-inlines via `fetchMediaBytes`,
  1.AH A4). The opaque jobId reversibly encodes the vendor id/op-name (`rlv-mediajob:1:<base64url(id)>`, the
  shared `encodeMediaJobId`/`decodeMediaJobId`) so a cold-process re-attach resolves it statelessly (ADR-0045
  §7). The remaining work is **1.AH host-wiring**: the per-model `media_surface` lookup, the `MediaUrlFetch`
  re-host hook (a Veo `url` result needs it end-to-end), and verified generative pricing rows.

  ```ts
  // Seam shape (A5; ADR-0045) — behavior WIRED at 1.AG (sync generateMedia Section C, async poll loop Section D).
  interface MediaGenRequest {
    model: string;
    prompt: string;
    modality: 'image' | 'audio' | 'video'; // the artifact class (the media-billed set)
    mimeType?: string;                     // requested output format hint, e.g. 'image/png' — bounded bare type/subtype (MediaMimeTypeSchema)
    count?: number;                        // artifacts per call (image generators)
    durationSeconds?: number;              // target duration (audio/video generators)
    signal?: AbortSignalLike;
    providerOptions?: Record<string, unknown>;
  }
  interface MediaGenResult {               // EXACTLY ONE of media (sync) | jobId (async)
    media?: MediaPart;                     // an in-flight part — the engine de-inlines it
    jobId?: string;                        // Relavium-opaque; never a vendor operation name
    raw: unknown;                          // debugging only — sinks strip it (the LlmError.cause rule)
  }
  type MediaJobStatus =
    | { state: 'pending'; progress?: number }  // progress is a 0..1 fraction
    | { state: 'done'; media: MediaPart }
    | { state: 'failed'; error: LlmError };    // reuses the one classified failure vocabulary
  ```
- **`StopReason` is unchanged** (decision #8): a media-only inline turn reports
  `'stop'`; the presence of a `media` part in `content` is the signal. Consumers treat
  `content` as the source of truth — tested (a media-only turn is distinguishable from
  an empty text turn by content inspection alone).

**The tier policy and where the rules are mounted.** `INLINE_MEDIA_CEILING` bounds the
in-flight base64 carrier per modality in **decoded** bytes (256 KB image/audio — tunable
constants; **video and document are never inline**, ceiling 0); `MEDIA_MESSAGE_CAPS`
adds the per-message **count** and **aggregate-decoded-bytes** anti-amplification caps.
All ingestion-side rules — ceiling, caps, the unknown-modality fail-closed check, the
`url`-carrier landing gate (`MEDIA_URL_SOURCE_ENABLED`, **OFF** until the shared SSRF
range-primitive lands at 1.AE), and the no-raw-bytes-in-`tool_result.result` scan — are
mounted on **`LlmMessageSchema`** (the seam request boundary), so there is no cap-less
window between the shape (1.AD) and capability-gating (1.AF). `LlmResultSchema` and the
`StreamChunk` `tool_result` arm scan `result` on the way out; the durable union carries
the **`persistableMediaRefine` backstop** (a tripwire — the primary guarantee is the type
split plus the engine's active `deInlineMedia` pass at the one emit choke point, wired at
1.AF). Result content is deliberately **not** ceiling-bounded: a generated image
legitimately exceeds the inline ceiling in flight and is de-inlined at the seam return.
The platform-free **`MediaStore`** contract (`put`/`get`/`resolveForEgress` — bytes as
`Uint8Array`, named only by the handle string) and the **`DeInlineMedia`** transform
signature are landed as reserved shape; implementations and the choke-point wiring are
1.AF.

### Model discovery — the `listModels?` capability ([ADR-0064](../../decisions/0064-live-model-catalog.md))

`listModels?(key, signal?): Promise<ModelListing[]>` is an **optional, capability-varying** method (the same
pattern as `generateMedia?` / `contextLimit?`): a provider without a live list endpoint omits it and the host
degrades to the static registry ([pricing.ts](../../../packages/llm/src/pricing.ts)) for that provider. It
returns **live discovery** — which model ids a given `key` can actually reach (tier/allowlist-gated). The live
tier decides **availability**; the static registry stays the **pricing** authority (ADR-0064 §6), so
`ModelListing` deliberately carries **no price**. Each adapter maps its vendor `models.list()` row to
`ModelListing` **inside `src/adapters/*`** — **no vendor SDK type crosses this seam** (ADR-0011).

```ts
// The Relavium/Zod projection of a live model-list row (ADR-0064 §1). MINIMAL + lenient-inbound /
// strict-outbound: only `id` is required; the rest are provider-varying and OMITTED when unknown.
interface ModelListing {
  id: string;                     // provider-native id (Gemini: the `models/` prefix is stripped)
  displayName?: string;           // Anthropic/Gemini return one; OpenAI/DeepSeek do not
  contextWindowTokens?: number;   // Anthropic `max_input_tokens` / Gemini `inputTokenLimit`; positive-only (a 0/absent limit is "unknown" → OMITTED, never a stored 0)
  maxOutputTokens?: number;       // Anthropic `max_tokens` / Gemini `outputTokenLimit`; positive-only
  deprecatedAt?: string;          // ISO-8601; the LIVE list leaves it UNDEFINED — the static registry supplies the deprecation half, unioned at merge time (ADR-0064 §7)
}
```

**The `kind` protocol axis.** A provider's **`ProviderKind`** ∈ `{ anthropic, openai-compatible, gemini }`
(owned by `@relavium/shared` as `PROVIDER_KINDS`; derived from a `ProviderId` by `@relavium/llm`'s
`providerKind(id)`) selects — **once per protocol rather than per provider** — the adapter factory, the
list-models endpoint, the auth style, and the response mapper: `anthropic → anthropic`, `gemini → gemini`,
`openai`/`deepseek → openai-compatible`. This is a **separate axis** from the provider **id** enum
(`LLM_PROVIDERS`), which stays the closed persisted-contract set; the `kind` enum stays closed too
(ADR-0064 §6). No vendor type crosses either axis.

**Behaviour every implementation shares** (ADR-0064 §3/§8): the call is **bounded + abortable + secret-free**,
mirroring `validateProviderKey` — `signal` (or a hard internal timeout) aborts the in-flight request, the
thrown error is a classified `LlmProviderError` whose message is **key-redacted** and which carries **no
`cause`** (so neither the resolved key nor the raw vendor payload can cross the seam). Parsing is **lenient
inbound / strict outbound**: unknown vendor fields are ignored (additive drift is absorbed silently); a row
that yields no `id` is **dropped** at the mapper boundary, never throwing (one malformed row degrades a single
model, not the whole provider); a breaking endpoint/shape change throws, which the host's per-provider refresh
isolation catches. A per-provider filter keeps only **chat-capable text models**.

Per-provider list-models endpoint contracts:

| Provider (`kind`) | Endpoint | Shape | Mapping + filter |
| --- | --- | --- | --- |
| Anthropic (`anthropic`) | `/v1/models` (SDK `models.list()`, auto-paginating `has_more`/`last_id`) | **Rich** | `id`, `display_name`→`displayName`, `max_input_tokens`→`contextWindowTokens` (omit if 0), `max_tokens`→`maxOutputTokens` (omit if 0). The list is clean — no filter (the rich `capabilities` object is ignored). |
| Gemini (`gemini`) | `/v1beta/models` (SDK `models.list()`) | **Rich** | `name` (strip `models/`)→`id`, `displayName`, `inputTokenLimit`→`contextWindowTokens`, `outputTokenLimit`→`maxOutputTokens`. **Filter:** keep only rows whose `supportedActions` (the SDK's projection of REST `supportedGenerationMethods`) includes `generateContent`. Key sent as the `x-goog-api-key` header, never a `?key=` query param (ADR-0064 §9). |
| OpenAI / DeepSeek (`openai-compatible`) | `/v1/models` (SDK `models.list()`) | **Id-only** | `id`→`id`, no context/price. **Filter:** keep the `gpt` / `o<digit>` / `*chat*` / `deepseek` families; DENY `embedding`/`tts`/`whisper`/`image`/`moderation`/`realtime`/`audio`/`dall-e`/`transcribe`/`search`/`instruct`/`ocr`/`davinci`/`babbage`/`ft:` — each matched on a `-`/`_` **segment boundary** (so `search` denies `gpt-4o-search-preview` but NOT `o3-deep-research`); **union-in** any id present in `MODEL_PRICING` for that provider (cost-eligibility always wins). |

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
| OpenAI / DeepSeek | SSE `chat.completion.chunk` with `choices[].delta` (content or `tool_calls` fragments; tool-call args arrive as incremental JSON-string fragments per index; DeepSeek adds `reasoning_content` deltas). | `text_delta`, `tool_call_*`, `reasoning_*` (DeepSeek — OpenAI chat emits no reasoning), `stop` |
| Anthropic | Typed events: `message_start`, `content_block_start` / `delta` (`text_delta` \| `input_json_delta` \| `thinking_delta`) / `stop`, `message_delta` (carries `stop_reason` + `usage`), `message_stop`. | `text_delta`, `tool_call_*`, `reasoning_*`, `stop` |
| Gemini | `streamGenerateContent` candidate chunks with `parts` (`thought`-flagged parts carry reasoning). | `text_delta`, `tool_call_*`, `reasoning_*`, `stop` |

Tool-argument JSON deltas are concatenated into `argsJsonDelta` across
`tool_call_delta` chunks and **parsed once at `tool_call_end`**. The final
`stop` chunk always carries `stopReason` + `usage`. The `media_start/delta/end`
triad is part of the frozen union but **emitted by no adapter** — non-streaming
media output landed at **1.AG** (inline via `generate()` + the generative
endpoint, [ADR-0046](../../decisions/0046-inline-media-out-via-generate-streaming-triad-deferred.md)); the
**streaming triad is deferred to 1.AH** (ADR-0046 §4).

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

> **`inputTokens` is net of cache (each token billed once).** `inputTokens`, `cacheReadTokens`,
> and `cacheWriteTokens` are **disjoint** counts — the `CostTracker` bills each at its own rate, so
> `inputTokens` must exclude cache reads/writes. Anthropic's native `input_tokens` is already net,
> so it maps straight across. **OpenAI / DeepSeek `prompt_tokens` is *gross*** (it includes
> `cached_tokens` / `prompt_cache_hit_tokens`), so that adapter sets `inputTokens = prompt_tokens −
> cached_tokens` (the cached subset moves to `cacheReadTokens`). Gemini exposes no cache split, so
> `inputTokens` is simply the prompt count.

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
chains are **policy**, implemented by the `FallbackChain` runner (1.K) in
`@relavium/llm` — a class constructed from an ordered plan of attempts
(`{ provider, model, maxAttempts, backoff }`), plus a thin
`withFallback(plan, req, options)` façade for the common single-shot
non-streaming case. It exposes `generate(req)` and `stream(req)`, and the engine
(1.O) builds the plan from the agent's primary `model`/`provider` (+ `retry`)
followed by each authored `fallback_chain` entry:

- Try each entry in order; on a **classified-retryable** `LlmError` (rate limit,
  5xx/overload, timeout, transport) exhaust the entry's `maxAttempts` with
  backoff, then advance to the next entry. On a **fatal** `LlmError` stop
  immediately. The advance/stop decision is a pure function of the classified
  `kind`/`retryable` (1.I) — never content/string-sentinel inspection.
- **No blind auth retry:** an `auth` failure is never re-attempted on the same
  entry; an optional out-of-band credential refresh (`onAuthError`) may grant
  exactly one more attempt, otherwise it is fatal.
- **Rate-limit cooldown:** a rate-limited entry is parked in a per-provider
  cooldown so an immediately-following call on the same chain skips it.
- **No failover after the first streamed content chunk:** once `stream` has
  forwarded content, a mid-stream error surfaces to the node-retry layer (1.S)
  rather than re-issuing on the next provider.
- **Strip-on-failover (ADR-0030):** crossing to a *different* provider drops
  every `reasoning` part (and its ephemeral `signature`) from the request before
  re-issuing — a signature is never replayed across a provider boundary.
- Surface **per-attempt usage** to the injected `CostTracker` (against that
  attempt's model) so cost stays accurate across a failover, and report each
  attempt (succeeded / failed / skipped) via an `onAttempt` observer so the
  engine can emit a `cost:updated` per attempt and a warn log — **visible**
  failover, never a silent provider switch. The runner imports no event bus; it
  is platform-free (the host injects the `sleep` timer).

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
