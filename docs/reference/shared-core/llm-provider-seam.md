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

## Request data ownership

[ADR-0102](../../decisions/0102-a-measured-request-owns-its-inert-data-through-egress.md)
defines the supported JavaScript data domain for controlled `LlmRequest` generate/stream calls.
Before the first asynchronous handoff, the `ownLlmRequest` factory owns and freezes one
canonical construction. Its mapped readonly `LlmRequestConstruction` input accepts original caller
arrays without normalizing away their descriptors or cross-field aliases. Every current or future
request field is traversed except the live
`signal` and authentic `preparedOutputCaps`. This includes messages, tool arguments/results and
schemas, response formats, tool choice, stop sequences, modalities, temperature, reasoning effort
and non-cap provider options. Ownership does not expand the estimator's system/messages/tools/
response-format subset or change pricing, wire cap precedence or allowance authority.

Supported data comprises primitive strings, booleans, numbers, null and undefined; dense ordinary
arrays; and ordinary or null-prototype records with own enumerable string-keyed data properties.
Numbers, including non-finite values, and present undefined retain their values; native encoding
and validation remain the lowerer's responsibility. Standard Map/Set objects become records of
inert own properties; internal entries are ignored under their existing JSON semantics. Frozen
inert caller containers are accepted. Repeated acyclic aliases are preserved across the entire
payload/options graph through iterative memoized copying, without an added depth/size limit.

Unsupported inputs include functions, symbols, BigInt, ancestor cycles, custom/boxed/Date instances,
accessors, callable own/inherited `toJSON`, sparse arrays, additional array properties and unsupported
non-enumerable/symbol metadata. An own string key exactly `__proto__` anywhere in the traversed non-cap
graph is also refused, including Map/Set properties, schemas and tool arguments/results. Values
previously serialized through Date/custom serializers, or ignored by a provider, are intentionally
outside this narrowed domain. Convert them to inert supported data before calling the seam; use
host tools for executable behavior. Noncallable enumerable `toJSON` remains data. Descriptor
inspection avoids getters; reflection failures receive the same fixed, content-free
`UnsupportedRequestDataError`. No caller property, value, path or inspection cause is exposed.
This is ownership inside the trusted host process, not a sandbox for reflection traps or global
built-in mutation. Standalone `estimateRequestTokens` retains its conservative fallback behavior.

Owned records and their private mutable SDK working copies have null prototypes. Arrays retain
trusted intrinsic behavior and shadow inherited `toJSON` with a helper-generated non-enumerable
undefined property. Capture never freezes the caller. Each SDK attempt receives a fresh working
graph with one memo across all fields; SDK schema mutation cannot change the caller, owned graph
or another attempt. OpenAI learned-parameter retries create a fresh graph too. Gemini's existing
converter observes shared declaration/response-schema aliases without splitting them.

Native cap controls remain the separate exception governed solely by `output-cap.ts`: descriptor
separation, captured real-key serialization, discarded outer-option serializer and exact candidate
binding retain their existing rules. Matching prepared plans are validated before projection can
mask original-control changes, and their captured values/ceiling survive catalog refresh. Candidate
capture failure is surfaced only when the candidate is applicable; an unused candidate cannot stop
a valid primary. Quote-relevant failure remains fail-closed rather than becoming a new exclusion.
Mutable SDK native controls delegate the same cap reconciliation; they do not resolve a plan from
an unauthenticated mutable working copy.

A genuine factory association survives the trusted live-signal overlay and inline-media tool omission.
`ownedRequestShape` exposes immutable tools/modalities for applicability and quote sizing without
selecting a cap. `ownedRequestSource` exposes the frozen canonical construction when all candidates
are inapplicable; it carries no selected cap authority. The chain may record its skips, but cap lookup,
SDK working-copy construction and reasoning/media derivation require genuine candidate selection.
A failed applicable cap remains refused. Legacy raw governor callers may supply their measured attempt
plan to `ownLlmRequest`; the existing authority validates original controls and exact configured
model/provider/endpoint binding before projection. Changed controls, wrong candidate identity and
different existing authority are refused, without reserializing the measured plan or applying a
refreshed ceiling.

The fallback chain captures at method invocation. `stream()` synchronously captures and returns a
private asynchronous iterator, so caller mutation before first `next()` cannot change transmission.
A capture refusal yields one fatal `bad_request` terminal through that iterator, with no admission,
credential resolution or provider invocation; generate rejects with the normalized provider error.
Direct adapter generate retains typed configuration refusal; direct stream capture refusal likewise
uses a terminal `bad_request`, while existing successful-capture capability checks retain their
contract. Foreign providers called by the chain receive read-only owned canonical data and must
make their own working copies. Independently called foreign implementations are outside this guarantee.
The chain immediately copies resolved media discriminants/scalars before caching or another await;
only existing typed media slots change and base64 data is never cached. Live cancellation remains
observable. Separate-endpoint `MediaGenRequest`/generation/polling remains outside this ownership scope.

**W7 integration boundary:** the controlled adapters and chain implement this ownership handoff.
Core now captures its first round before measurement, reuses the factory request for quote/execution
with only the live signal overlaid, and closes each pre-attempt check over that round before money waits.
Real tool results create fresh owned rounds from owned static fields and working history. Core ownership and Step 8's owned summariser/pre-send/recovery integration have independent acceptance;
accepted final wave evidence is tracked by the [closing register](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10).

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
  maxTokens?: number;            // REQUIRED downstream for Anthropic; we default it. CLAMPED to the model's published
                                 // `maxOutputTokens` (ADR-0071 §7) — down, never up; a cap below the ceiling is the author's
                                 // budget. NOT clamped on a custom `base_url` (we cannot describe what it serves). The
                                 // OpenAI-compatible adapter's WIRE FIELD is endpoint-dependent (§10a): OpenAI's own API
                                 // takes `max_completion_tokens`; DeepSeek's API and every custom base URL take `max_tokens`.
  reasoningEffort?: ReasoningEffort; // normalized tier off|low|medium|high|max (ADR-0066); each adapter maps to its provider's native tier — CANONICAL, wins over a colliding providerOptions key; absent ⇒ provider default
  stopSequences?: string[];
  responseFormat?: ResponseFormat; // structured-output request (ADR-0030)
  outputModalities?: OutputModality[]; // request media output on the INLINE path (ADR-0031); default ['text']
  signal?: AbortSignalLike;      // cancellation — the structural, platform-free signal contract from @relavium/shared (a real AbortSignal satisfies it); host-injected transport (desktop aborts the Rust llm_stream egress, ADR-0018)
  providerOptions?: Record<string, unknown>; // typed escape hatch (caching, reasoning, etc.)
  preparedOutputCaps?: PreparedOutputCapPlan[]; // ephemeral candidate-specific cap snapshots; factory-created, never serialized
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
  | { type: 'tool_call'; id: string; name: string; args: unknown; providerExecuted?: boolean; signature?: string }   // assistant -> wants tool; signature is an ephemeral provider continuation token (ADR-0090) — replayed SAME-provider, stripped on failover, structurally absent from the durable arm
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
// DurableContentPart mirrors ContentPart with the durable media arm and TWO signature-less arms — a
// reasoning arm ({ type: 'reasoning'; text; redacted? }) and, since ADR-0090, a tool_call arm with no
// `signature` — so the ADR-0030 "never persisted" guarantee is structural for both continuation tokens
// rather than defended by a test. deInlineMedia (engine-owned, wired at 1.AF) is the flight→durable transform.

interface ToolDef {
  name: string;
  description?: string;
  parameters: JSONSchema7;       // single canonical schema; adapters reshape
}

// Normalized non-streaming result
interface LlmResult {
  content: ContentPart[];        // text + any tool_call parts
  stopReason: StopReason;
  usage: UsageEvidence;
  raw: unknown;                  // provider response, for debugging/escape hatch
}

// `StopReason` is also OWNED by @relavium/shared (constants.ts STOP_REASONS, used by
// `session:turn_completed`) and re-exported by the seam — same one-way ownership as `ContentPart`.
type StopReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error';

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;      // Explicit cache-read observation; see the native dialect rules below
  cacheWriteTokens?: number;
  reasoningTokens?: number;      // ADR-0030 — OBSERVABILITY only; a subset of outputTokens (≤), never billed separately
  mediaUnits?: MediaUnitsEntry[]; // ADR-0031 — a DISJOINT media axis (per-image / per-second), never folded into tokens
  costMicrocents?: number;              // integer micro-cents (canonical unit defined below); computed by the generated catalog snapshot keyed on canonical model id (ADR-0071)
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
  | { type: 'tool_call_end'; id: string; signature?: string }  // ADR-0090 — the ephemeral continuation token for the COMPLETED call, mirroring reasoning_end.signature; the accumulator carries it onto the assembled tool_call part
  | { type: 'media_start'; id: string; mimeType: string }            // ADR-0031 — media output channel (mirrors the triads); mimeType is bounded bare type/subtype (MediaMimeTypeSchema)
  | { type: 'media_delta'; id: string; progress?: number; partialRef?: string }  // progress is a 0..1 fraction; NO base64 ever; partialRef is a RESERVED preview HANDLE (A3)
  | { type: 'media_end'; id: string; media: DurableMediaPart }       // closes the media block — the finished media as a handle-only durable part
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean; providerExecuted: true;
      media?: DurableMediaPart[] }  // ADR-0030 provider-run tool (engine records, never runs); media: ADR-0031 #7
  | { type: 'stop'; stopReason: StopReason; usage: UsageEvidence }
  | { type: 'error'; error: LlmError };

interface LlmInvocationOptions {
  readonly retainWork: <T>(factory: () => Promise<T>) => Promise<T>;
  readonly beforeNativeRetry?: (error: LlmError) => Promise<void>;
  readonly nativeInvocationStarted?: () => void;
}

interface LlmProvider {
  readonly id: 'anthropic' | 'openai' | 'gemini' | 'deepseek';
  readonly customEndpoint?: boolean; // actual adapter-factory identity; absent means official
  generate(req: LlmRequest, key: string, options?: LlmInvocationOptions): Promise<LlmResult>;
  stream(req: LlmRequest, key: string, options?: LlmInvocationOptions): AsyncIterable<StreamChunk>;
  readonly supports: CapabilityFlags;  // { tools, streaming, parallelToolCalls, vision, promptCache, reasoning, media } — vision is the derived alias of media.input.image (ADR-0031)
  // ADR-0031 decision #6 — separate-endpoint media generation. The A5 ADR ([ADR-0045](../../decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md))
  // is landed and the SHAPE is final (the additive pollMediaJob `signal` param, 1.AG Section A); the BEHAVIOR
  // is WIRED — `generateMedia` SYNC de-inline (1.AG Section C) + the engine-owned async poll/checkpoint/
  // resume/cancel loop (1.AG Section D). The Sora/Veo/Imagen/TTS ADAPTER impls are 1.AH host-wiring.
  generateMedia?(req: MediaGenRequest, key: string, options?: LlmInvocationOptions): Promise<MediaGenResult>;  // sync → { media }; async → { jobId } (Relavium-opaque — never a vendor operation name)
  pollMediaJob?(jobId: string, key: string, signal?: AbortSignalLike, options?: LlmInvocationOptions): Promise<MediaJobStatus>; // pending(progress?) | done(media) | failed(LlmError); signal aborts the in-flight poll (1.AG/ADR-0045 §4)
  // ADR-0062 context-compaction: per-provider token/context vocabulary, in Relavium/Zod seam types only (no vendor type crosses).
  contextLimit?(model: string): number | undefined;      // the model's context window in tokens; undefined for an unrated/custom model (engine then skips auto-compaction)
  managesOwnContext?(): boolean;                          // provider bounds context itself ⇒ engine skips compaction; false for all current providers
  estimateTokens?(input: EstimateTokensInput): number;   // { system, messages, tools?, responseFormat? } → a prospective request estimate; actual usage remains authoritative for realized billing
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

### Current-request estimates and bound output caps

[ADR-0096](../../decisions/0096-a-request-is-measured-before-it-is-sent.md)
and [ADR-0101](../../decisions/0101-configured-output-estimates-apply-only-when-the-wire-is-uncapped.md)
separate prospective request size from realized usage. `estimateRequestTokens` is pure and exported
from `@relavium/llm`; adapter `estimateTokens` defaults delegate to it. It sums `ceil(system.length / 4)`,
two tokens per message, and the complete serialized-length/4 floor of each text, reasoning, tool-call,
tool-result body, tool definition and JSON `responseFormat` (including its output schema, name and strictness).
An absent or plain-text response format adds nothing. Measurement uses the constructed pre-strip request;
a dialect that drops a structured schema can therefore be overcounted, in the same conservative direction
as stripped reasoning. Escaping, opaque args/results and continuation signatures count.
Only actual media parts and the typed `tool_result.media` attachments use fixed per-part charges:
media-looking objects nested inside opaque values remain ordinary serialized data.

| Input part | Tokens per part | Basis, checked 2026-10-02 |
|---|---:|---|
| Image | 48,169 | Derived from GPT-4o mini's 2,833 base plus eight 5,667-token tiles under the documented high/auto resize rule: [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision#calculating-costs) |
| Document | 80,000 | **Ten-page assumption**: round up ten times 3,000 typical text tokens plus 4,784 visual tokens. Sources: [Anthropic PDF](https://platform.claude.com/docs/en/build-with-claude/pdf-support#estimate-your-costs), [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision#resolution-and-token-cost) |
| Audio | 20,000 | **Ten-minute assumption**: round up 600 seconds times 32 tokens/second; [Gemini media resolution](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution) |
| Video | 200,000 | **Ten-minute assumption with headroom** over approximately 300 tokens/second in static high-resolution mode; [Gemini video](https://ai.google.dev/gemini-api/docs/video-understanding#technical-details-about-videos) |

Carrier kind and base64 length do not change these charges. They are conservative heuristics, **not
physical upper bounds** on PDF pages, clip durations, custom services or provider tokenization; CJK and
other inputs can be undercounted. Cycles, BigInt and throwing serialization/inspection receive a finite
1,048,576-token fallback per affected unit (4 Mi serialized characters / 4); other units still count.
Shared references that serialize normally retain their complete repeated floor. Synchronous JavaScript
cannot interrupt a non-terminating getter or `toJSON`; this helper promises no such liveness guarantee.

`prepareOutputCapPlan` in `output-cap.ts` owns field selection, captured official catalog clamping,
mapped-field precedence and surviving native-cap evidence. All three adapter implementations use
that same plan to lower both `generate` and `stream`. Official OpenAI maps authored caps to
`max_completion_tokens`; official DeepSeek and custom OpenAI-compatible routes map to `max_tokens`;
Gemini maps to `maxOutputTokens`; Anthropic's required absent-cap default is 4096, clamped to the
captured official ceiling. A mapped cap wins its colliding native fields. With no mapped cap, valid
finite positive integer native controls survive unchanged and reserve their greatest recognized value.
Official OpenAI recognizes both keys, official DeepSeek only `max_tokens`, custom OpenAI-compatible
routes both, and Gemini `maxOutputTokens`. Keeping two native OpenAI keys is a conservative accounting
envelope for an upstream-invalid request, not a valid precedence rule. Invalid native values remain
on the wire but supply no cap evidence. No estimate inserts a new wire limit.

`outputTokensReservation(plan, configuredFallback)` uses the effective wire cap first. Only an uncapped
request uses the configured estimate or the shared 4096 estimate default, clamped against a captured
**official** ceiling. Custom and unknown-model requests do not borrow another service's ceiling.
`estimateResolvedNextCost` then prices the resolved input and output independently at highest-tier
non-cached input/output rates, with user overlays, and performs **no second catalog clamp**. Invalid
non-finite/negative token estimates or unsafe cost arithmetic throw `InvalidTokenEstimateError`.
Governor admission and frozen allowance quotes use the one `estimateResolvedRequestCost` kernel.
It snapshots finite non-negative token/media quantities before reading one user/catalog price,
uses the **highest finite context threshold** and full non-cached token rates, and rounds each
token class and each media entry independently. Its immutable scalar basis records quantities,
selected rates/tier and missing media rates. A safe total returns `priced`; unsafe finite arithmetic
returns `unrepresentable` without an invented numeric amount. The number-returning token/media
compatibility helpers throw `InvalidTokenEstimateError` for that marker. Malformed quantities
remain typed refusals even for an unknown model; malformed selected token rates also refuse.
Missing, negative and non-finite media rates follow
the existing named-gap policy; a requested zero volume still exposes a gap, while an explicit zero
rate is a real price. Realized tier selection retains its strict-threshold and first-equal-tier rules.

Native separate-endpoint media completion also uses the rate-only kernel through `estimateMediaCost`
to price its known authored volume. It does not fabricate a provider-reported `Usage` record:
audio/video duration may be fractional, while image counts and canonical `Usage` quantities retain
their integer guards. The rounded charge must be a non-negative safe integer before accounting;
missing pricing remains an explicit gap under the existing settlement policy.

The output-only `estimateMaxNextCost` remains a compatibility helper for canonical authored caps;
native caps must never pass through it. Gemini's uncapped thinking control keeps its existing catalog
fallback; a native output envelope is a reservation and cannot become an invented thinking budget.

Plans are factory-created immutable cap projections, guarded at runtime and bound to model, actual
provider/endpoint, canonical cap and the three native cap fields. `prepareOutputCapRequest` remains
a cap-only compatibility staging helper. Controlled adapters and the chain instead use the
[owned-request handoff](#request-data-ownership) before admission and credential awaits. Surviving object, function and BigInt cap values
are JSON-lowered once under their original property key, then copied and deeply frozen with detached
object/array prototypes, so an inherited `toJSON` cannot run again after admission. Array identity and
own JSON data keys are preserved. Boxed numbers,
object `toJSON` results and primitive `BigInt.prototype.toJSON` results are priced at the numeric value
actually forwarded, and invalid JSON data retains its wire shape. Omitted values remain omitted.
Discarded opaque/BigInt controls are never serialized, including OpenAI-only cap fields that Gemini's
SDK omits from its HTTP config. DeepSeek's forwarded modern key still receives a JSON capture even
though its official dialect does not recognise it as cap evidence. An unserializable surviving control
refuses with the fixed typed cap-plan error before admission.
Factory input inspection, native option copying, existing-plan binding/lookup and request staging
share that content-free refusal boundary. A throwing getter, proxy trap or serializer becomes
`InvalidOutputCapPlanError`; neither its original message nor its throwable/cause is retained.
This protects these cap helpers and their adapter/attempt callers, rather than sandboxing arbitrary
caller objects throughout every request transform.
Original identities are retained privately only to bind a measured plan; caller-owned executable
values are never re-read after admission. Reconciliation preserves current unrelated options,
except a callable outer `providerOptions.toJSON`: it is executable body replacement and cannot
override mapped fields. Noncallable data bearing that name is preserved.
`LlmRequest.preparedOutputCaps` carries a measured candidate's plan through the chain and
adapter unchanged, including after a catalog refresh; another candidate gets its own bound plan.
The allowance quote consumer prepares heterogeneous candidates from original construction
inputs or separately preserved candidate plans; a primary's filtered cap projection cannot recover
opaque controls that its dialect discarded.
A substituted plan or changed cap/routing binding throws `InvalidOutputCapPlanError`. Neither
`providerOptions` nor prepared plans enter durable budget quotes or events.

Every `PreAttemptInfo`, on both chain paths, requires `model`, `provider`, `endpoint`, `maxTokens`,
`providerOptions` and `outputCapPlan`; the two optional values have required keys allowing `undefined`.
Core's required text/generative-media hook and host configuration forwarding have their canonical
home in the [agent-runner injection contract](agent-runner.md#pre-egress-injection-contract).
Official factories explicitly pin SDK endpoint/backend settings, so ambient SDK environment or
global defaults cannot redirect the request while retaining official cap/refund identity.

**W7 step 6 implementation, 2026-10-02:** cap lowering, financial estimation, required forwarding and
handoff foundations are implemented. Session measured pre-send/recovery and each summariser candidate's
automatic handoff remain step 8; frozen allowance consumers remain step 9. This section does not claim
those later entry points have shipped merely because the seam now supports them.
W8 replaces the earlier synthetic-zero adapter behavior with the explicit
[usage-evidence contract](#6-usage). Admission estimates and prepared cap ownership stay separate
from realized usage. The
[W8 closing register](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w8-closing-register--2026-10-11)
owns CR-82 acceptance.

> **`CapabilityFlags` is per-PROVIDER; a second, per-MODEL axis sits beside it (`CR-51`,
> [ADR-0071](../../decisions/0071-models-dev-as-the-model-metadata-source.md) amendment).** The catalog's
> `RequestCapabilities` records what one MODEL accepts, which varies inside a single provider — OpenAI does
> tools, `gpt-3.5-turbo` does not. Two of its four fields gate the request rather than a preference. Each is
> ONE predicate, read by BOTH the `FallbackChain` pre-skip (through `requestSupportReason`) and the adapter
> entry, so the two cannot disagree — pinned by a test that drives one shared input table through both seams:
>
> - **`toolCall`** — a request carrying `tools` on a model that rejects them.
> - **`attachment`** — a request carrying a `media` input part on a model that rejects them.
>
> The **tool** gate additionally runs at LOAD time: a workflow node granting tools on a tool-incapable model
> fails `validateWorkflowWithCatalog` before a run id exists. That is the "config-time validation"
> [ADR-0071](../../decisions/0071-models-dev-as-the-model-metadata-source.md) §12 named when it deferred this
> gate to "a louder signal … not a silent drop"; `attachment` has no load-time counterpart, because media
> inputs are runtime values and nothing at load can see one. When no chain entry can serve the request, the
> exhausted-chain error carries every skip reason and classifies as `bad_request`, so the refusal is
> explainable rather than opaque.
>
> The other two (`temperature`, `structuredOutput`) are knobs the adapters simply **withhold** from the wire:
> a dropped preference changes nothing about the answer. These two are not knobs — withholding tools from a
> turn that needs them, or dropping the image the question is about, buys a confidently wrong answer at full
> price, and sending them buys a 400. So the chain skips to a model that can serve the request, for free,
> before any egress. A model the catalog cannot describe (a custom `base_url`, a new id) degrades to
> **accepted**, so missing metadata never withholds a capability a model actually has.

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

Stored provider headers do not cross this seam into first-party adapter construction
or HTTP requests. The [canonical provider-header policy](database-schema.md#interim-provider-header-policy)
owns the interim admission/error contract and sensitive legacy retention.
[ADR-0108](../../decisions/0108-provider-headers-stay-gated-until-keychain-custody.md)
gates future activation on keychain-reference custody and reviewed egress/migration
semantics; it does not activate custom headers alongside custom endpoint routing.

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
  contentCommitted?: true;   // chain-observed streamed content or a processed generated response
  usage?: UsageEvidence;             // actual provider usage on a failed response, never a reserved estimate
}

type LlmErrorKind =
  // retryable === true
  | 'rate_limit'             // 429
  | 'overloaded'             // provider 5xx / capacity
  | 'timeout'                // request deadline exceeded
  | 'transport'             // connection reset / DNS / TLS, incl. a stream that ended with no terminal
  // retryable === false (fatal)
  | 'protocol'               // the provider broke the STREAM GRAMMAR below (ADR-0082)
  | 'auth'                   // 401/403 — bad or missing key
  | 'bad_request'            // 400 — malformed request, unsupported model id, rejected tool schema
  | 'context_overflow'       // fixture-pinned official context-window failure; never chain-retried
  | 'content_filter'         // content-policy refusal
  | 'cancelled'              // AbortSignal
  | 'unknown';               // unclassifiable — treated as fatal
```

**`contentCommitted` is the CHAIN's field, never an adapter's.** It is set only when `FallbackChain`
surfaces a failure past the first non-terminal chunk, or observes actual usage on a rejected generated
response. The chain strips it from any error a provider supplies — otherwise a pre-content failure claiming commitment would delete the node's whole retry budget
through the fold above the chain. It exists because *whether to advance to another provider* and *whether to
re-run the node* are different questions: `retryable` stays a pure function of `kind` (so a miswired adapter
cannot produce an inconsistent pair), and commitment is carried as the separate fact it is
([ADR-0082](../../decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §4).

### Classified context overflow

[ADR-0096](../../decisions/0096-a-request-is-measured-before-it-is-sent.md) classification is pinned
by the [unchanged live captures](../../../packages/llm/src/conformance/fixtures/overflow/README.md).
Each HTTP rejection is exercised through the installed SDK on both generate and stream paths.
Unmatched 400 responses remain `bad_request`; other statuses cannot gain overflow classification
from these message patterns.

| Dialect | Classification evidence |
| --- | --- |
| Anthropic | HTTP 400, `invalid_request_error`, and `prompt is too long: N tokens > N maximum` |
| OpenAI | HTTP 400 and structured `context_length_exceeded` code |
| DeepSeek | HTTP 400, `invalid_request_error`, and `This model's maximum context length is N tokens. However, you requested N tokens` |
| Gemini | HTTP 400 and `The input token count exceeds the maximum number of tokens allowed N.` in the SDK message; transport replay preserves the recorded body/message |
| Anthropic native stop | `model_context_window_exceeded` in the captured HTTP 200 message or streamed `message_delta`; a failed generation, never a clean `stop` |

The native stop carries canonical actual `usage` on `LlmError`. The chain validates, owns and
freezes nested quantities before observer/provider handoffs, applies accountable-usage checks,
and folds them into the failed `AttemptRecord`, pricing and realised ledger exactly once. An
invalid quantity preserves the conservative reservation; a pricing failure retains valid usage
and marks the failed record unpriced. Cancellation, custom-endpoint downgrade and a grammar
violation after the held terminal preserve already observed usage. Stream `contentReceived`
is set only by chunks the chain observed; a failed generate carrying validated usage proves a
processed response, even when its text is empty. A provider-supplied `contentCommitted` never
owns that fact. No usage-bearing failure receives a proven-refusal refund.

Anthropic hands off the first native streamed stop and its final usage immediately, then closes
its SDK iterator; later vendor deltas, content or teardown errors cannot replace that observation.
The grammar verifier retains valid terminal usage in attempt-local state before its confirming
read. If cancellation or the attempt deadline wins that read, the existing grammar/deadline
verdict still applies and the owned usage is settled once. An unconfirmed pre-content terminal
can therefore time out and retry under ADR-0082, with each fresh response accounted separately;
usage alone does not invent streamed content commitment. Iterator cleanup remains best effort
under that deadline and does not certify host-safe resource release.

`customEndpoint === true` downgrades `context_overflow` to fatal `bad_request` in the chain
**before** recording or surfacing it, including an adapter spread that retains an official host
or model ID. Classification never silently switches models. Usage-less official overflow
releases its admission only with chain-owned `contentReceived: false`; post-content, custom
and uncertain failures retain the reservation. The existing enumerated pre-content HTTP
refusal rule remains independent of overflow classification.

### The stream grammar

Normative for every `LLMProvider.stream` implementation, and **verified by `FallbackChain`** on every
provider — the adapters we wrote, a cassette, a test double, and Phase 2's managed gateway alike
([ADR-0082](../../decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §1-§3).

1. Exactly one terminal per stream: `stop` **xor** `error`.
2. The terminal is the last chunk.
3. No chunk of any kind after the terminal.
4. Two `stop`, `stop` + `error`, or two `error` are violations.
5. A clean EOF with no terminal is an error, never a success.
6. An empty stream — EOF with no chunks at all — is an error.
7. A pre-content failure may fail over; a **content-committed** failure must not fail over and must not be
   node-retried. It is surfaced.

**Content-committed means any chunk other than `stop` or `error` has been yielded.** Not "text": a
`reasoning_start`, a `tool_call_start`, a `media_start` and a provider-executed `tool_result` all commit the
stream, because each has already reached the user or the model.

The rules overlap by design — an empty stream breaks 1, 5 and 6 at once — so classification is a table of
**disjoint observations**, evaluated in order:

| observed | classification |
|---|---|
| a chunk arrives after a terminal | `protocol` |
| a second terminal arrives | `protocol` |
| EOF, ≥1 non-terminal chunk seen, no terminal | `transport` |
| EOF, zero chunks at all | `transport` |
| EOF, exactly one terminal, last | well-formed — the terminal's own semantics apply |

An empty stream is `transport` rather than a violation because it is indistinguishable from a connection
that opened and died — and because the adapters' own no-terminal check fires unconditionally, so classifying
it otherwise would give first-party and foreign providers opposite verdicts for one fault.

The chain **holds the terminal** until one more read confirms it was last, then forwards it; another chunk
replaces it with a `protocol` failure. If that confirming read THROWS, the terminal is forwarded anyway and
the teardown error discarded: the terminal was validly received, and an SSE reader failing after `[DONE]` is
not a failure of the response.

The verifier checks ORDER only. A chunk's SHAPE is a separate obligation the conformance suite enforces —
parsing every chunk of every token stream would be a real per-chunk cost for a fault that suite already
finds.

### The per-attempt deadline

Every `generate`/`stream` attempt through `FallbackChain` runs under a deadline, defaulting to **120 s** and
host-configurable (§5-§7).

Two halves of "cannot be disabled", stated separately because only one of them is a chain guarantee. The
**value** cannot be set to something that disables it: a non-finite or non-positive `attemptTimeoutMs` is
refused at construction, because unbounded is the state this removes. But the **port is optional**, and a
host that supplies neither `newAbortController` nor `setTimer` gets no deadline at all — both or neither,
never half. A host reading this section as "I get a deadline for free" would be wrong; wiring the port is
what buys it.

The deadline is **hard-raced**, not merely signalled. A provider that returns `new Promise(() => {})` ignores
its abort signal, so the cooperative abort is raised *and* every awaited step is raced against a timer.
Streaming races the same **absolute** deadline against each `next()` — a per-chunk reset would let a provider
dribble one token per interval forever. On expiry the iterator's `return()` is called best-effort and not
awaited without bound, and a late chunk is discarded.

**The guarantee is caller liveness, not resource termination.** An uncooperative provider's work may continue
in the background; what is bounded is how long Relavium waits.

When WorkflowEngine owns the call, the runner forwards an execution-local
`FallbackChainOptions.retainWork(factory)` hook. It synchronously registers and returns the
factory's exact Promise before invoking generation, each verifier `next()`, and each timeout or
final iterator `return()`. The first registered read also constructs `stream()`; a host-entry
refusal invokes no provider and records no egress, even for a synchronous stream factory.
These lifetimes remain owed after a bounded attempt returns. The hook
is optional for standalone chains and sessions without an engine owner; it is neither
`LlmRequest` data nor a general platform capability, and grants no admission or new provider
entry after its producing scope ends. The separate generative-media submission transfers its
raw `generateMedia` Promise in the same way.

**Invocation-local transitive work (ADR-0103).** The chain forwards a separate optional
`LlmInvocationOptions` argument to `generate`/`stream`; the generative runner forwards it to
`generateMedia`. This is an additive behavioural signature extension. It is never a field in
`LlmRequest`, `MediaGenRequest`, providerOptions, SDK RequestInit, a budget quote or durable history.
Existing implementations with fewer parameters remain assignable; ignoring this option does not
certify a foreign implementation's hidden descendants as complete.

The chain and separate generative/poll runners wrap each actual provider invocation in the shared
pure `ProviderInvocationWork` helper, including custom implementations. A completed, timed-out,
aborted or returned invocation retires its own future `retainWork` factories before fallback or
public outcome delivery. Already admitted descendants remain owed independently, including when
a stream's `next()` or `return()` is held. Each poll gets fresh authority; reusable providers and
siblings never inherit another invocation's retainer. Standalone calls keep the optional seam. Typed generated output, successful usage and media result/status are copied before
retirement can invoke caller listener removal or abort observers. Raw diagnostic `cause`/`raw`
identities remain opaque. Retirement attempts abort and quiet acknowledgement even if caller
listener removal throws; admitted descendants still hold their own completion. Partially failed
setup retires its transferred aggregate without replacing the original entry error. An existing
provider/cancellation diagnosis stays primary over cleanup; a standalone cleanup fault remains
loud, without retry authority, and text attempts account known usage exactly once.
The OpenAI-compatible generate adapter owns native usage before invocation retirement. If a
supported caller-listener cleanup callback throws after a native response, its typed cleanup
failure retains that evidence for the chain's complete-only settlement. An already established
provider failure remains primary. A cleanup-only fault has fixed content-free, non-retryable
`unknown` presentation and preserves only its opaque private cause; classifying that value as a
provider error must not create retry, admission or budget authority. Partial and missing evidence
remain uncertain. This includes DeepSeek's shared adapter and does not claim that first-party
native AbortSignal cleanup throws.

Public iterator `return()` and `throw()` attempt the underlying generator exit even when
immediate invocation retirement fails. A consumer throw remains primary over secondary
retirement failure; a standalone retirement failure remains observable after cleanup entry.
Neither path acknowledges held iterator work before its actual settlement (ADR-0103).


The controlled OpenAI-compatible adapter transfers one aggregate lifetime before SDK construction
or entry. It binds that invocation's work and retirement signal into its own client fetch closure,
including custom-endpoint validated fetch. A lazy stream captures the retainer function and receiver
at call time and transfers its lifetime only on first pull; ignoring the iterable enters no SDK.
Return/throw retires fresh entry synchronously even behind a held next. Exact SDK reads/returns,
request normalization, raw DNS, body next/return and actual native request/incoming-close children
remain owed independently. An unobservable native Promise never supplies a completion ACK.

SDK success, headers, EOF, dispose, abort and a bounded public result do not replace actual close.
Retirement vetoes fresh fetch, learned-parameter retry/learning, post-DNS native entry and subsequent
Sora download. One poll aggregate covers status and completed binary download; each actual transport
keeps its own close lifetime. Different invocations on the same reusable adapter/fetch do not share
retirement authority. Standalone calls without options keep their existing API behaviour.

The engine owns each raw media poll, including credential resolution, separately from the old
submission context. `NodeExecutor.pollMediaJob` receives its own optional third invocation argument;
the runner forwards it as the provider's fourth argument after its existing post-key abort check.
Admitted descendants transfer before the raw poll returns. A late poll after terminal cannot pin
media, charge again or publish another event. The engine joins poll scheduling/accounting actors
and final receipt health through its [local departure contract](../../architecture/shared-core-engine.md#internal-departure-foundations-adr-0103);
independent acceptance of that consolidated integration is tracked in
[current.md](../../roadmap/current.md).

Registration failure retains its original process-local identity and host provenance, outside
provider retry/failover classification. A synchronous provider throw retains provider
classification. An established provider/deadline failure stays primary over best-effort
iterator cleanup; a cleanup-only host-entry failure accounts known usage once before escaping,
including an explicit public stream-iterator `return()`. Its handler runs in generator `finally`:
consumer return bypasses subsequent statements, so those statements cannot observe the attempt
or propagate the original refusal. That cleanup handler reports its primary observation once,
with already confirmed terminal usage. Identity recognition does not inspect an arbitrary
throwable's prototype. Raw completion after a bounded failure creates no new provider attempt
or public terminal. Accounting refinement requires the registered receipt authority defined in
[Invocation correlation, repairs and late receipts](#invocation-correlation-repairs-and-late-receipts);
lifetime-only completion cannot charge or refund. This boundary does not certify all transitive
SDK/network/MCP work or safe host departure; those
remaining obligations are recorded in [ADR-0103](../../decisions/0103-a-paused-run-hands-off-its-local-producers-before-its-host-closes.md).

A deadline abort is `timeout`; a caller abort is `cancelled`, and **a caller abort wins a same-tick tie** —
resolved at classification time so the answer is a contract rather than a listener ordering. Rule 7 governs
both: a pre-content timeout may fail over, a content-committed one is surfaced.

The window opens immediately before the seam call — after the pre-egress hook, after media
re-materialization, after credential resolution. Those are Relavium's own work and must not consume the
provider's budget.

Disposal attempts timer disarm, caller-listener detach and waiter release even when a trusted host
cleanup callback throws; the shared primitive rethrows the first original cleanup failure only
after those stages. The chain owns generated quantities and typed content before custom cleanup, and contains a cleanup
failure until attempt settlement. A prior provider or
admission refusal keeps its original diagnosis and attempt record. After a successful invocation,
valid known quantities and price still reach one failed attempt record; the cleanup fault receives
fixed non-retryable `unknown` presentation with its original value kept as an opaque private cause.
It cannot acquire retry, budget-gate or ledger-writer authority from its exception class. Stream
iterator closure remains best-effort. These controls concern supported custom trusted callbacks;
first-party native timer/listener cleanup has not been shown to throw, and resource termination
remains outside the caller-liveness guarantee.

**`protocol` is fatal but still fails over pre-content.** A provider that cannot keep the grammar will not
keep it on the second call, so the node-retry budget must not re-dispatch — but a DIFFERENT provider may be
well-behaved, and before any content has been shown there is nothing to lose by trying one. It maps to the
`provider_unavailable` `ErrorCode`; no new code was added, because no surface would act on the distinction
differently.

> **The internal-diagnostics rule (`cause` and the `raw` passthroughs).** `LlmError.cause`,
> `LlmResult.raw`, and `MediaGenResult.raw` are internal diagnostics only: **never logged,
> serialized, checkpointed, or put in a run event — any sink strips them first** (the run-event
> error shape `{ code, message, retryable }` already excludes `cause`). This matters doubly for
> media (ADR-0031): from 1.AE/1.AG on, `raw` is the highest-volume media-bytes carrier (vendor
> `b64_json` / `inlineData`), and vendor shapes inside it are invisible to the canonical-shape
> backstop scans — stripping at the sink is the only guarantee.

The fallback runner reads both classification and commitment state: a retryable failure
can advance to another provider only before content commits; a pre-content `protocol` failure
can also fail over despite being fatal to node retry. Every attempt is reported. Available attempt usage is
recorded independently of whether it can be fully priced. Unpriced records are marked
`priced: false`: their amount may be an unknown-price placeholder or a token-only cost floor,
rather than a complete charge. If an attempt holds a bounded reservation, missing usage or
incomplete pricing retains it unless proven pre-content refusal permits release. A reservation
is never invented actual usage or realised spend. See
[the financial settlement contract](agent-runner.md) and
[error handling](../../standards/error-handling.md#llmerror-classification--the-contract-the-fallback-chains-depend-on).
Per-provider status/code → `kind` mapping stays **inside each adapter**, exercised by the
conformance suite; the runner never inspects a provider code directly.

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
  below). Since [ADR-0090](../../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md)
  a sibling latch strips `tool_call.signature` — on a **narrower** boundary. Reasoning is
  stripped when the **provider** changes; a `tool_call.signature` is stripped when the
  **issuer** changes, and the issuer is `provider\0model`. So advancing to a different MODEL
  of the same provider keeps the reasoning and drops the tool-call token. That is deliberate:
  Gemini's `thoughtSignature` is minted against the model that issued the call, so replaying it
  to a sibling model can 400, while reasoning replay is a provider-level contract. The
  `tool_call` itself is NOT dropped — only its signature — because the call and its result are
  the conversation the next provider still needs. *(This paragraph previously described both
  strips as sharing one predicate; the code has always used two.)*
- **`customEndpoint?`** on `LlmProvider` (`CR-51` review, 2026-09-02) — `true` when the adapter targets a
  **non-official `base_url`**. The shipped model catalog is keyed by model id ALONE, so a custom
  OpenAI-compatible service serving a tool-capable model under a well-known id inherited that id's verdicts
  and was refused at load and skipped in the chain — breaking the custom-`base_url` feature outright.
  Optional and absent-means-official, so every existing adapter and host is unchanged;
  `createCustomOpenAiProvider` sets it. When set, the catalog stops governing this provider's models and they
  fall back to the same degrade-to-ACCEPTED default an un-described model already gets, because missing (or
  foreign) metadata must never withhold a capability a model actually has. The host tells the engine's
  load-time check the same fact through `CatalogValidateOptions.customEndpoint`.
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
  **structurally absent from every part** — it lives only in a sidecar keyed by
  `(provider, sha256)`, owned **per-`FallbackChain` run-instance**
  ([ADR-0043](../../decisions/0043-media-egress-failover-rematerialization-ssrf.md) §4,
  which sharpened ADR-0031 §Guardrails' looser "process-scoped adapter sidecar" wording —
  a process-wide map would leak refs across unrelated runs). It works because the CHAIN owns
  it and re-materializes **before** invoking the adapter, so its value never has to survive an
  adapter boundary.
  A continuation token has no such hook — capture and replay straddle two adapter calls — so
  Gemini's function-call `thoughtSignature` rides the **part**, not a sidecar
  ([ADR-0090](../../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md),
  superseding ADR-0089 §3; decided and landing in `W5`): `tool_call.signature?` in flight,
  `tool_call_end.signature?` on the stream, and structurally absent from the durable arm.
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
  → inline `videoBytes` base64 OR a re-hostable `url` source the engine de-inlines by STREAMING it into the
  store (`MediaUrlStream` + `MediaStore.putStream`, ADR-0089 §2 — never `fetchMediaBytes`, which whole-buffers),
  1.AH A4). The opaque jobId reversibly encodes the vendor id/op-name (`rlv-mediajob:1:<base64url(id)>`, the
  shared `encodeMediaJobId`/`decodeMediaJobId`) so a cold-process re-attach resolves it statelessly (ADR-0045
  §7). The remaining work is **1.AH host-wiring**: the per-model `media_surface` lookup and verified
  generative pricing rows. The re-host hook itself LANDED in `W5`/`CR-53`: a `url` carrier takes
  `MediaUrlStream`, and a `url` with no streaming hook wired is REFUSED rather than silently inlined.

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
The platform-free **`MediaStore`** contract — `put` / `get` / `resolveForEgress` /
`readRange` / `validateMedia`, bytes as `Uint8Array`, named only by the handle string — and the
**`DeInlineMedia`** transform are **implemented**: `@relavium/db` ships the filesystem CAS
and an in-memory reference, and the choke-point wiring landed at 1.AF. The filesystem implementation's
[physical containment and limits](built-in-tools.md#physical-media-storage-and-limits) are refined by
[ADR-0105](../../decisions/0105-filesystem-roots-are-invocation-grants-not-project-authority.md).
The publication and host API refinements are specified [below](#bounded-verified-media-publication-adr-0106).
[ADR-0089](../../decisions/0089-media-correctness-four-boundaries.md) §2 adds a fifth
method, optional **`putStream?(bytes: AsyncIterable<Uint8Array>, mimeType)`**, plus
**`MediaUrlStream`** — the streaming sibling of `MediaUrlFetch` — so a media body is never
materialized whole between the network and the store. Request-input ceilings do not
limit generated result content. Publication preflights every base64 result's exact decoded
length against the **25 MiB object ceiling before decoding**, then decodes quartet-aligned
bounded chunks through `putStream` when that port is present. This supports large generated
image/audio and completed video/document carriers without a whole decoded-body allocation.
A host lacking `putStream` retains the small image/audio path through `put` only when the
result fits the existing decoded inline ceiling; every larger result and every video/document
result requires streaming. This compatibility branch is selected before storage begins:
stream failure never retries through `put`. A `url` always requires the streaming pair;
a host offering only whole-buffer fetch/write has its URL sources **refused** rather than
quietly buffered. Stream consumption independently counts the object ceiling, so an
over-size fetched body is aborted mid-flight. Request-message caps and direct `put` guards
remain unchanged.

### Bounded verified media publication (ADR-0106)

[ADR-0106](../../decisions/0106-media-publication-requires-bounded-verified-bytes.md) narrows
first-party ingestion to independently verified finite format profiles. A MIME prefix, filename,
HTTP header, existing handle or caller-supplied verification flag cannot establish identity.
All media remains untrusted. Structural identity checks do not establish decoder validity,
playability, absence of malicious content or polyglot exclusion. Explicit raw PCM has the
structural-only qualification below.

Both reference stores independently enforce the existing **256 KiB** decoded inline bound for
image/audio `put`; video/document `put` refuses at any size. Their separate `putStream` path
counts at most **25 MiB**, before excess hashing, copying or writing. It never falls back to
`put`. The in-memory implementation owns borrowed chunks and accumulates within that bound;
the filesystem implementation consumes them incrementally. Recognizers retain at most
**64 KiB inspection scratch**, with bounded structural depth/count and safe lengths.
Required tails, checksums and track identity complete before publication.
The whole-buffer egress helper also owns each admitted borrowed chunk before requesting
the next one. Its copy ignores producer `slice` and iterator overrides, including the
aliasing behaviour of Node `Buffer.slice`; subsequent producer reuse cannot change the
retained bytes.
The shared host-side response reader also enforces each caller's configured byte
limit using the intrinsic typed-array byte count, before copying or yielding an
overflowing chunk. Own `length`/`byteLength` properties cannot lower that count;
the buffered text reader owns admitted chunks before another pull, while the
streaming reader retains no chunk. This per-response limit remains separate from
the stores' independent media-object ceiling.

The exact initial canonical MIME set is `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`audio/wav`, `audio/mpeg`, `audio/flac`, `audio/ogg`, `audio/opus`, `audio/aac`, `audio/L16`,
`video/mp4`, `video/webm` and `application/pdf`. Bare MIME comparison is case-insensitive;
only `image/jpg`, `audio/x-wav` and `audio/x-flac` are lexical aliases. Identified Ogg Opus
produces `audio/opus`; an `audio/ogg` declaration can accept that independently observed codec.
This relation is directional and does not make Ogg and Opus metadata interchangeable.
Unsupported variants refuse rather than acquiring a generic MIME label.

The following is the finite ingestion profile, rather than a claim to decode every file
carrying one of these MIME labels. Each family consumes the complete body. Large skipped
payloads remain subject to the object bound; required structural evidence cannot be skipped.

| Canonical MIME | Admitted identity and framing | Explicit limits |
| --- | --- | --- |
| `image/png` | Signature, unique first IHDR, legal colour/depth fields, palette ordering, consecutive nonempty IDAT, every chunk CRC and exact IEND. | Unknown critical chunks and APNG refuse; compressed pixels are not decoded. [PNG specification](https://www.w3.org/TR/png-3/). |
| `image/jpeg` | SOF0/1/2, 1–4 components, positive dimensions, DQT/DHT, referenced SOS tables, sequential/progressive scan framing, entropy marker escaping/restarts and EOI. | Other SOF, arithmetic and lossless families refuse; entropy coefficients and progressive reconstruction are not decoded. [ITU T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf). |
| `image/gif` | GIF87a/89a screen/palettes, image rectangles, LZW minimum code size, terminated nonempty subblocks, reviewed extensions and exact trailer; multiple images allowed. | LZW output is not decoded. [GIF89a](https://www.w3.org/Graphics/GIF/spec-gif89a.txt). |
| `image/webp` | Exact RIFF extent/padding; static VP8 keyframe or VP8L header; optional first VP8X; metadata/ALPH ordering and flags agree. | Animation/unknown chunks refuse; compressed pixels and VP8L alpha content are not decoded. [WebP RIFF](https://developers.google.com/speed/webp/docs/riff_container). |
| `audio/wav` | RIFF/WAVE extent/padding; one fmt before nonempty aligned data; PCM 8/16/24/32-bit or float 32/64-bit; fmt16/18 or extensible40 PCM/float GUID. | 1–32 channels, rate 1–768000, matching block/byte rate and valid bits. RF64/RIFX/other codecs refuse; channel-mask layout is not decoded. [WAVEFORMATEX](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex), [extensible format](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible). |
| `audio/mpeg` | At least two contiguous complete frames; MPEG 1/2/2.5, layers I/II/III, finite bitrate/rate tables, stable version/layer/rate and padding-aware lengths. Optional single ID3v2.3/2.4 and terminal ID3v1. | Free/reserved bitrate/rate fields refuse; codec CRC, payload and full ID3 frame grammar are not decoded. [MPEG-1 standard text](https://ossrs.net/lts/zh-cn/assets/files/ISO_IEC_11172-3-MP3-1993-7e218e3ec360c25149d36152c4e02f08.pdf), [MPEG-2 standard text](https://ossrs.net/lts/zh-cn/assets/files/ISO_IEC_13818-3-MP3-1997-8bbd47f7cd4e0325f23b9473f6932fa1.pdf), [ID3 structure](https://id3.org/id3v2.4.0-structure). MPEG-2.5 is an extension, not an ISO conformance claim. |
| `audio/flac` | fLaC, first STREAMINFO34, bounded metadata chain with zero-filled PADDING and APPLICATION bodies containing their four-byte identifier; consistent frame fields/coded numbers, fixed/LPC/Rice/escape residual framing, zero frame-alignment padding, CRC8/CRC16 and equality to the declared sample total when nonzero; zero denotes an unknown total and remains admitted. Residual partitions divide the block evenly; the block size divided by partition count exceeds the predictor order. A successor proves the previous frame nonfinal: that block meets the STREAMINFO minimum, and fixed-strategy nonfinal sizes equal the established block size. | Every frame respects the maximum. A final block may be below the minimum, including a short singleton; a fixed final block cannot exceed the established nonfinal size. Variable blocks may vary within the applicable bounds without attaining them. Other metadata bodies, APPLICATION payloads, samples and STREAMINFO MD5 are not reconstructed or semantically validated. [RFC 9639 §8.2](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.2), [metadata](https://www.rfc-editor.org/rfc/rfc9639.html#section-8), [residuals](https://www.rfc-editor.org/rfc/rfc9639.html#section-9.2.7). |
| `audio/ogg`, `audio/opus` | One serial, contiguous v0 pages from BOS through EOS, continuation/lacing and page CRC. OpusHead v1/map0/mono-stereo plus complete OpusTags comment framing and an audio packet yields `audio/opus`; bounded padding and arbitrary binary tails after that comment list are admitted unchanged. Vorbis identification/comments and bounded LSB-packed setup traversal through codebooks, lookup extents, time/floor/residue/mapping/mode fields, references and the actual framing bit, followed by an audio packet, yields `audio/ogg`; its required single comment framing byte remains enforced. | Every OpusTags tail byte remains subject to packet/object bounds and page CRC, including continued packets; its first byte's low bit is tag-editor advice, not an ingestion discriminator. Chained streams, alternate Opus mapping and combined first BOS/EOS refuse. Vorbis setup tails after the actual framing bit are admitted under the same packet/object/CRC bounds. Setup tables reuse 1,969 bytes, giving 6,352 bytes including the reader arena and Ogg prefix/lacing buffers. Huffman trees, lookup vectors and audio packets are not reconstructed or decoded; duration is not inferred from granules. [Ogg Opus §5.2](https://www.rfc-editor.org/rfc/rfc7845.html#section-5.2), [Vorbis](https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html). |
| `audio/aac` | Complete ADTS 7/9-byte frames, legal frequency/channel fields, one raw-data block, stable ID/profile/rate/channels and nonempty payload. | Raw AAC, LATM/LOAS, channel configuration zero and multiblock ADTS refuse; codec CRC/payload are not decoded. [ADTS standard text](https://previewnorm.com/iso/ISO%20IEC%2014496%203-2005%20PDF.pdf), tables 1.A.6–7. |
| `audio/L16` | Explicit protocol/declaration authority plus nonempty even sample-byte count. | Structural exception: no independent format signature, rate/endianness conversion or duration derivation. Fetched bytes require an explicit compatible HTTP header. |
| `video/mp4` | Reviewed ftyp brands; one moov with video track, positive track ID/timescale/dimensions/data reference, visual sample description and nonempty mdat. avc1/avc3+avcC, hvc1/hev1+hvcC, vp09+vpcC or av01+av1C configuration framing required. Late moov and bounded extended box sizes, including their 16-byte header, are supported. Only the original 32-bit size zero denotes a final root mdat through EOF; an extended size zero refuses. | Nonfragmented, unencrypted video only. Audio-only/unknown codecs refuse. Parameter sets/sample payloads, offsets, timing and complete presentation are not decoded. [Atom size forms](https://developer.apple.com/documentation/quicktime-file-format/atoms), [visual sample description](https://developer.apple.com/documentation/quicktime-file-format/video_sample_description), [registered brands](https://mp4ra.org/registered-types/brands), [VP9 binding](https://www.webmproject.org/vp9/mp4/), [AV1 binding](https://aomediacodec.github.io/av1-isobmff/). |
| `video/webm` | EBML webm header, one known/unknown-size Segment, known-size children/clusters; up to 32 tracks; positive-dimension VP8/VP9/AV1 video track and an actual unlaced block referencing it. Late Tracks supported. | Unknown-size clusters, lacing, all ContentEncodings (including encryption/compression), audio-only and unknown video codecs refuse. Timing, seeking, codec-private and compressed payload semantics are not decoded. [WebM container](https://www.webmproject.org/docs/container/), [encryption](https://www.webmproject.org/docs/webm-encryption/), [EBML](https://www.rfc-editor.org/rfc/rfc8794.html). |
| `application/pdf` | PDF 1.0–1.7/2.0 header, terminal startxref/EOF, classic xref within a 49152-byte rolling tail, bounded subsection entries and flat reviewed trailer keys with Root/Size consistency. | Xref streams, hybrid/encrypted/nested or unreviewed trailers refuse. Objects/pages, prior xref chains and live entry targets are not resolved; header 2.0 is admitted only within this classic profile. [ISO 32000-1](https://opensource.adobe.com/dc-acrobat-sdk-docs/standards/pdfstandards/pdf/PDF32000_2008.pdf). |

One selected recognizer owns a reusable 4096-byte arena; Ogg additionally retains 287
header/lacing bytes. PDF instead owns its 49152-byte tail and 9-byte header, plus bounded
tokens (64 ordinary or 256 hex characters) and eight trailer keys. One allocation authority
bounds aggregate retained inspection buffers to 65536 bytes. Parser tables and stacks have
finite scalar limits: structural nesting 16 where applicable, general structures 65536,
audio frames/Ogg pages 1048576, and Ogg comments 65536. This describes inspection data,
not total V8 heap, decoded base64, store-owned object memory or decoder validity.

The provider compatibility controls exercise installed SDK HTTP bodies through actual CAS
and SQLite admission: OpenAI chat and TTS AAC/Opus/PCM, plus Gemini inline PCM, including
effective native chat selectors and bounded OpusTags binary tails. Unsupported explicit
output selections refuse before SDK entry. For OpenAI separate-endpoint image, audio
and video generation, canonical `mimeType` selects the format. Native overrides are
unsupported: any non-`undefined` root `output_format` / `response_format`, or actual-modality
nested `format` / `output_format` / `response_format`, refuses even when its value names
an admitted format. Null and unknown values refuse too; absent or explicit `undefined`
fields retain the canonical selection. Chat `audio.format` has its separate supported lowering.
An unspecified video format retains the MP4 default and supported native size selection;
ordinary Gemini text `application/json` remains a text response format. These are offline
synthetic compatibility controls, not paid-provider captures or decoded audio evidence.

Video identity declarations are singular within their owning structures. WebM refuses
repeated Tracks, TrackNumber, TrackType, CodecID, Video, dimensions and EBML header fields;
MP4 refuses repeated track identity/container boxes and more than the one declared sample
entry. Identical repetitions also refuse. A later supported value cannot replace an earlier
unsupported or conflicting value. Supported single-identity late Tracks/moov remain admitted.

```ts
interface HostMediaRequest {
  readonly url: string;
  readonly mimeType: string;
  readonly maxBytes: number;
  readonly signal?: AbortSignalLike;
}
type MediaUrlFetch = (request: HostMediaRequest) => Promise<Uint8Array>;
type MediaUrlStream = (request: HostMediaRequest) => AsyncIterable<Uint8Array>;
// Core HostMediaFetch/HostMediaStream import this same shared request shape.
// The engine supplies its trusted maxBytes and run signal before host entry.

interface DurableMediaMeta {
  readonly handle: string;
  readonly mimeType: string;
  readonly modality: 'image' | 'audio' | 'video' | 'document';
  readonly byteLength: number;
  readonly durationMs?: number;
}
// Required on a present MediaStore:
validateMedia(
  handle: string,
  descriptor: Omit<DurableMediaMeta, 'handle' | 'byteLength'> & { readonly byteLength?: number },
): Promise<DurableMediaMeta>;
```

This replaces the former positional host fetch/stream arguments; embeddings must migrate both
ports and supply `validateMedia`. Missing validation refuses. Optional input byte count is a
claim, while the returned count is required and independently observed. A supplied count must
be a nonnegative safe integer equal to actual bytes. Present duration must be a positive safe
integer on audio/video; it is consistency metadata, not decoded duration evidence. Invalid
presence is never erased. The returned descriptor is owned. Filesystem validation incrementally
checks the opened bounded fd, hash and format; it does not invoke whole-object `get`.

De-inlining synchronously owns the supported inert graph before its first await,
including source/hints, nested arrays/records and intrinsic Map/Set keys/values. It refuses
accessors, unsupported carriers and inspection faults without invoking caller getters or overridden
collection iterators. Transparent Proxy reflection can itself trap; thrown faults become fixed
errors, without a claim of universally trap-free detection. A base64 source may be shared by
genuine media.source slots, but any additional
record/array/Map/Set alias refuses before writing; replacing a media slot must not leave raw
base64 elsewhere in the owned graph. Every occurrence is checked before
handle deduplication and again against actual returned evidence. Same-hash canonical MIME,
modality, known counts and known durations must agree. Missing stores refuse handle-only media
as well as inline/URL media; text-only values need no store but also return the owned snapshot,
so a caller cannot introduce unvalidated media during the promise gap.

The optional synchronous `deInlineMedia` fourth callback receives the owned graph's unpinned
count after all original occurrences pass preflight and before host entry. The engine reserves
its existing per-node/run rehost budgets there. This prevents counting one caller-owned graph
and subsequently publishing a mutated graph. A source iterator is acquired once and closed on
early store return/failure; actual native host resources are joined, while an arbitrary hostile
never-settling iterator return does not defeat the existing bounded-liveness contract.

The media-specific shared lifecycle protocol ([ADR-0109](../../decisions/0109-native-media-close-ownership-is-explicit-iterator-provenance.md))
uses `registerNativeMediaIterator<T extends AsyncIterator<Uint8Array>>(iterator: T): T`
and `closeMediaIterator(iterator: AsyncIterator<Uint8Array>): Promise<void>`. A trusted
constructor registers the **exact public iterator before escape and first pull**, capturing
its original return operation and receiver in a private WeakMap. Duplicate registration,
registration after close initiation and invalid return capture refuse with the existing fixed
`MediaAdmissionError('source_failed')`. Already-running state cannot be introspected; construction
before use is a trusted precondition. Registration is ownership, not a timer or work scheduler.

Close initiation synchronously caches and returns one acknowledgement before invoking caller
code. Foreign return is invoked once by the helper and its throw/rejection is observed without
joining it; native acknowledgement joins trusted retirement. Callers first clean their own
resources, then await the acknowledgement. A primary verification, write or cancellation
failure survives a secondary close failure; a close-only failure has the same fixed refusal.
The de-inline and reference-store consumers reach interrupted-source cleanup only with
an existing primary failure: successful consumption requires natural EOF. Their cleanup
therefore preserves that primary failure. The shared helper's close-only refusal remains
observable when directly closing a registered iterator, including a yielding native
generator whose `finally` throws during consumer abandonment.
For genuine same-realm and cross-realm Promises, captured intrinsic continuation observes
the original settlement without consulting a replaced own `then` getter or method. Ordinary
constructor/species behaviour is a trusted JavaScript precondition; this does not intercept
independently created rejecting work or arbitrary constructor/species sabotage. Non-Promise
thenables use guarded normal assimilation. A fulfilled genuine Promise remains fulfilled
despite a hostile own `then`; a rejected native return still maps to the fixed close refusal.
The counted de-inline iterator remains foreign: its return only initiates source close, while
the encompassing finally joins the same acknowledgement after store cleanup. Direct raw-store
consumers use the same protocol. Direct return outside the helper is not deduplicated by it;
trusted generators/wrappers must safely join previously initiated retirement.

Native EOF must join retirement before `done: true`. Wrappers do not inherit ownership: an
adopted finite view must deliberately join upstream close before EOF, even if upstream has
more bytes. `streamMediaBytes` registers only the first-party native dependency instance, at
factory call time while retaining lazy dispatch; injected dependency implementations remain
foreign unless their trusted owner explicitly adopts the iterator. The whole-buffer twin
retains its existing limits and native close joining. The protocol does not make a foreign
pending `next()` finite or preempt synchronous JavaScript.

Identity is local to **one loaded shared module**. Built workspace entry points and the actual
CLI bundle must prove a common registration/consumption domain; a separate loaded copy is an
unsupported cross-copy boundary, not an implicit native join. Future desktop/VS Code or other
packaging graphs require their own proof. No public marker, global registry, request field,
vendor type or new error code carries ownership across that boundary.

Fetch receives the declared MIME. It normalizes the final Content-Type casing/parameters once;
an explicit conflicting header refuses before body consumption. Missing/octet-stream headers
require unambiguous self-describing byte evidence. **Raw `audio/L16` requires nonempty even
sample bytes and an explicit compatible HTTP header**; native provider PCM instead has its
explicit protocol type. This does not detect PCM identity, convert sample rate/endianness or
repair existing provider representation limitations. Connect/body-idle deadlines and cancellation
remain; a progressing download gains no new total deadline.

Native HTTP preserves individual original Content-Type field values before Node header
normalization. More than one field refuses before parameter stripping or body iteration,
including identical fields and either conflicting order. Normalized headers for other
consumers are unchanged. The owned `HopResponse.contentTypeValues?` array carries this
multiplicity; older injected ports without it retain the normalized-record check.

The engine awaits a present `MediaReferencePort.admitProducedMedia(batch)` before media enters
workflow state, `save_to`, durable sequence allocation, append or terminal outbox publication.
Completed and branch outputs share this pre-state pin/admission and existing per-node/run
rehost budget; branch selection and token accounting do not change. Downstream state and
durable readers receive the same first-fetch handles.
Absent reference ports are allowed after byte admission; present incomplete ports refuse.
The [SQLite immutable batch contract](database-schema.md#media-metadata-admission) creates no
read grants. After append ACK, reference mutation/reclaim remains best effort. Terminal
preparation failure strips nested media from its outputs while preserving one terminal and
already incurred accounting. Every later publication revalidates bytes; there is no mutable-file
verification cache. Unsupported old handles may remain stored but cannot bypass new admission.

`MediaAdmissionError` has fixed content-free diagnostics and these closed reasons:
`unsupported_mime`, `invalid_descriptor`, `descriptor_conflict`, `invalid_format`,
`inspection_limit`, `object_limit`, `inline_limit`, `unsafe_value`, `store_unavailable`,
`store_contract`, `source_unavailable`, `source_failed`, `stream_incomplete`, `verifier_state`.
It carries no supplied MIME, URL, handle, native cause or bytes. Existing classified network/
timeout errors retain their identity; a failed rehost never repeats already billed node execution.
The [physical storage and maintenance contract](built-in-tools.md#physical-media-storage-and-limits)
owns native file/temporary mechanisms. Whole-Step 6 causal controls and independent cumulative
acceptance remain required; implementation of this contract alone does not close that gate.

### Model discovery — the `listModels?` capability ([ADR-0064](../../decisions/0064-live-model-catalog.md))

`listModels?(key, signal?): Promise<ModelListing[]>` is an **optional, capability-varying** method (the same
pattern as `generateMedia?` / `contextLimit?`): a provider without a live list endpoint omits it and the host
degrades to the generated catalog snapshot ([catalog/snapshot.ts](../../../packages/llm/src/catalog/snapshot.ts)) for that provider. It
returns **live discovery** — which model ids a given `key` can actually reach (tier/allowlist-gated). The live
tier decides **availability**; the shipped catalog snapshot stays the **pricing** authority (ADR-0064 §6, ADR-0071 §5), so
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
  deprecatedAt?: string;          // ISO-8601; the LIVE list leaves it UNDEFINED — the Relavium-owned deprecation overlay supplies the deprecation half, unioned at merge time (ADR-0064 §7)
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
| OpenAI / DeepSeek (`openai-compatible`) | `/v1/models` (SDK `models.list()`) | **Id-only** | `id`→`id`, no context/price. **Filter:** keep the `gpt` / `o<digit>` / `*chat*` / `deepseek` families; DENY `embedding`/`tts`/`whisper`/`image`/`moderation`/`realtime`/`audio`/`dall-e`/`transcribe`/`search`/`instruct`/`ocr`/`davinci`/`babbage`/`ft:` — each matched on a `-`/`_` **segment boundary** (so `search` denies `gpt-4o-search-preview` but NOT `o3-deep-research`); **union-in** any id the generated catalog prices for that provider (ADR-0071 — cost-eligibility always wins; the deny-list still applies, so a priced embedding stays out). |

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

Native presence is interpreted before defaults or arithmetic. `inputTokens` is **net** of
cache; cache reads, cache writes and net input are disjoint billing classes. Only `complete`
evidence reaches `CostTracker.record(model, Usage)`. Partial observations remain visible and
never choose a price tier or manufacture a partial monetary amount.

| Dialect | Complete billing evidence and omissions |
| --- | --- |
| OpenAI Chat Completions | `prompt_tokens` is gross. Net input requires validated `prompt_tokens_details.cached_tokens`, including explicit zero. Missing cached count leaves gross unmapped and preserves independently known `completion_tokens`. Reasoning is an optional observability subset already included in completion. The supported chat dialect has no additional native cache-write billing counter. |
| DeepSeek | Native `prompt_cache_hit_tokens` is cache read and `prompt_cache_miss_tokens` is net input. Either missing half can be derived from gross plus the other. Gross, hit, miss and `prompt_tokens_details.cached_tokens`, whenever present together, must agree. Gross alone cannot prove a cache miss. |
| Anthropic | `input_tokens` is already net; `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` remain independent. Both cache classes require explicit evidence. A cumulative stream starts absent and replaces only fields later frames report, retaining prior observations. Complete evidence requires an authoritative final stop reason, a valid output count in that same frame and all four billing counts across the retained observations. An output-only final frame cannot invent start input. Missing/null/invalid final output leaves prior quantities partial; explicit final zero is valid. Optional thinking is already included in output. |
| Gemini | `promptTokenCount` is gross including `cachedContentTokenCount`; derive net only with both counts. Add `toolUsePromptTokenCount` when tools are applicable. Output is candidates plus thoughts: a thinking-capable or unknown model requires `thoughtsTokenCount`. The exact lowered `thinkingBudget: 0`, or a catalog model with no reasoning capability, establishes non-applicability. Tools absent from both canonical/native request and conversation establish non-applicability of tool-prompt counts. |

All native counts must be nonnegative safe integers before arithmetic; sums must remain safe.
Contradictory splits are never clamped. Independently trustworthy quantities survive invalid or
contradictory fields with fixed reasons. Explicit zero counts, including zero cache/media counts,
remain present. No SDK optional property supplies evidence that its omitted class equals zero.

OpenAI's native audio counters are disjoint `mediaUnits` with `unit: 'count'`. Requested or
observed inline audio output requires its native audio units; inline media output with no
supported counter remains incomplete. Applicability includes native modality controls captured from
the owned lowered request before SDK egress, and media observed anywhere in the response stream.
An earlier or later media frame cannot be erased by a text-only usage frame; a later observation
also downgrades already-owned complete usage when its media axis is missing. This accounting
observation includes native input/output audio-counter presence, even when the reported quantity
is zero or invalid: an invalid quantity establishes no units, but a later omitted counter cannot
erase the applicable axis. An explicit later valid counter can repair that observation. This
adds no streaming media output chunks. Gemini does not invent inline-media units;
zero text-token quantities do not establish zero media volume. Ordinary text-only requests do not
require a media axis. Separate-endpoint media continues using its
accepted authored/frozen volume basis, including fractional durations; it is outside token
`UsageEvidence` and does not fabricate missing token usage.

Adapters own evidence before content projection. Stream errors and truncation preserve observed
quantities, downgrading nonfinal cumulative observations to partial. Authoritative final evidence
survives a later cleanup error. OpenAI/DeepSeek capture each frame's usage once before accessing
its choices. Malformed choices still fail the stream, preserving independently valid counters;
they do not establish terminal authority. Gemini reads each response's usage property once and
owns its canonical quantities before further response access can throw or mutate that native object.
Its streaming quantities remain partial until terminal authority is verified. That authority
promotes the same owned observation, without rereading native counters; a later Gemini terminal
with no usage cannot promote an earlier nonfinal observation. Observed inline media still
downgrades complete evidence when its applicable billing axis is absent.
OpenAI/DeepSeek force `include_usage`; this requests a final
usage frame but cannot prove that it arrives. A native OpenAI/DeepSeek observation acquires final
authority only when its own frame carries a finish reason or a previously verified finish already
exists (including the ordinary empty-choice usage tail). A later usage-less finish or EOF cannot
promote an earlier nonfinal cumulative count; those retained quantities stay partial and do not enter pricing.
The same rule applies to OpenAI-compatible custom endpoints. Anthropic's final authority requires both a non-null
native stop reason and that frame's validated `output_tokens`, captured through the same single
read that retains the quantity. A stop reason alone cannot promote an earlier output count.
Gemini recognizes a current-frame
prompt block as terminal authority before interpreting that frame's usage, just as it recognizes
a candidate finish reason. Fully explicit applicable counts remain complete on a blocked response;
absent or incomplete counters and earlier nonfinal counts remain uncertain. The seam verifier owns
every held terminal's evidence before its confirming read, preserving it across malformed tails and deadlines.
`costMicrocents` remains a Relavium-computed quantity, never a native provider price.

> **Canonical cost unit (the one home).** All cost figures in Relavium — the seam's
> `Usage.costMicrocents`, the `cost:updated` event's `costMicrocents` /
> `cumulativeCostMicrocents`, and the persisted cost records — are **integer
> micro-cents**, where **1 micro-cent = 1e-8 USD = 1e-6 cent**. Costs are always
> integers (never floats) to avoid precision loss when summing thousands of
> per-token charges; the SQLite type-mapping detail is in
> [../shared-core/database-schema.md](../shared-core/database-schema.md). Every other
> document links here rather than restating the unit.

#### W8 production evidence contract

[ADR-0104](../../decisions/0104-unknown-provider-usage-is-durable-cost-uncertainty.md)
activates one intentionally breaking local/Phase-1 seam contract. `LlmResult.usage` and every
successful `stop.usage` require `UsageEvidence`; accountable `LlmError.usage` optionally carries
the same value. `AttemptRecord` is discriminated: `providerInvoked: true` requires evidence,
including the missing arm, while a proven non-invoked record has none. External provider
implementers must migrate together with their consumers; no plain-`Usage` compatibility alias or
automatic wrapping adapter is accepted. `@relavium/shared` owns all quantity/evidence definitions;
`@relavium/llm` re-exports them. Complete `Usage` arithmetic and pricing remain unchanged.

Both packages additionally export `UsageEvidenceSchema`, `UsageEvidence`, the three named
arm schemas (`CompleteUsageEvidenceSchema`, `PartialUsageEvidenceSchema`,
`MissingUsageEvidenceSchema`), `KnownUsageQuantitiesSchema` / `KnownUsageQuantities`,
`UsageEvidenceReasonSchema` / `UsageEvidenceReason`, and `ownUsageEvidence`:

```ts
type UsageEvidence =
  | { kind: 'complete'; usage: Usage }
  | { kind: 'partial'; known: KnownUsageQuantities; reason: UsageEvidenceReason }
  | { kind: 'missing'; reason: UsageEvidenceReason };
```

Complete evidence requires input/output counts and validates every present count, including
Relavium's optional computed `costMicrocents`, as a nonnegative safe integer. Partial evidence
permits only known `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
`reasoningTokens` and `mediaUnits`; it never contains guessed money. It requires at least one
numeric observation or one media entry. An empty media array alone supplies no known quantity.
An explicitly reported zero is preserved; absent fields stay absent and explicit `undefined`
properties are rejected. Reasoning cannot exceed output when both are known. Missing evidence
contains no quantities. The fixed reasons allowed on either incomplete arm are `not_reported`,
`missing_fields`, `invalid_fields`, `contradictory_fields` and `interrupted`; no free-form reason,
raw provider object or extra field is accepted on any arm or nested quantity object.

Inline media keeps the existing integer-unit semantics and disjoint axes: at most six entries,
one per image/audio/video × input/output pair. Entry objects are strict and units are
nonnegative safe integers. The separate-endpoint native-media fractional-duration types and
accounting basis are unchanged. The dialect rules above own applicability; the evidence schema
does not infer applicability or invent cache zero.

`ownUsageEvidence(value: unknown)` snapshots descriptor-first, accepts only inert own plain or
null-prototype record data and ordinary dense arrays, and deeply freezes the resulting arm,
quantities, media array and media entries before returning. It rejects accessors without calling
them, symbol/non-enumerable properties, exotic prototypes, cycles, sparse arrays and unsupported
values. The pre-parse traversal is bounded to 16 containers, four levels, eight own keys per
container, six array elements and 32 characters per key/string; unsupported oversized graphs
are rejected rather than traversed without a bound. Reflection failures, including hostile or
revoked proxies, and all validation failures produce only `InvalidUsageEvidenceError` with
`code: 'invalid_usage_evidence'`, message `Invalid usage evidence` and no input-derived cause.
The exported Zod schemas remain direct data validators and may expose Zod diagnostics;
callers handling untrusted values use the owned boundary. This adds no durable `ErrorCode`,
request contract, invocation authority or pricing path for partial/missing evidence.

Incomplete cumulative OpenAI/DeepSeek and Gemini usage frames retain earlier independently known
canonical quantities. Valid newly reported quantities replace their predecessors, never sum with
them; a partial or invalid later frame remains incomplete even if retained fields fill its gaps.
Missing Gemini thoughts cannot be treated as zero to derive a new combined output count.

#### Invocation correlation, repairs and late receipts

`FallbackChainOptions.beginUsageInvocation(info: PreAttemptInfo): Promise<UsageInvocation>`
is a behavioral port separate from `LlmRequest`. After admission and before credential resolution,
it allocates and acknowledges pending coverage. The chain retains the exact returned identity on
`AttemptRecord.invocation` across settlement and registered late receipts. The host owns its
producer/dispatch/round/ordinal construction; resettable `attemptNumber` alone is not correlation.
A persisted host mints its bounded dispatch identity independently of authored agent/node text;
the producer identity scopes the monotonic dispatch ordinal. Valid long authored identifiers
cannot become invalid usage-correlation metadata or collide through truncation.
A failed acknowledgement prevents provider invocation. Skipped entries require no marker.

OpenAI-compatible parameter repair preserves the existing bounded temperature/reasoning fallback.
Before each additional native create, `LlmInvocationOptions.beforeNativeRetry` settles the prior
classified failure through the existing complete-only pricing path and a `coverageOnly: true` record,
runs fresh admission through `preAttempt`,
and awaits the next pending acknowledgement. The host settles the prior admission and joins its
disposition/conservative-write barrier before admitting that next call. An official pre-content
refusal can release its estimate; a custom endpoint's unknown prior call retains conservative
exposure, and a later zero cannot refund it. Repair never drops an output cap: only temperature and
reasoning effort are repairable, so every retry uses the same central `outputCapPlan`.
An explicit `missing` usage arm supplies no processed-content evidence, just like an absent
error usage field. Generate and native-repair failure accounting preserve this distinction:
partial or complete quantities, including explicit zero, and actual content still establish
processing. Without such proof, an official enumerated pre-content refusal can release its
reservation and a retryable pre-content failure can fail over. A custom endpoint retains its
existing uncertainty; the mere presence of a missing-evidence object cannot change either policy.
`AttemptRecord.preAttemptInfo` carries the exact fresh frozen admission-info object for each native
call. It is ephemeral correlation, never durable data or billing authority, and prevents late cleanup
from releasing a newer fallback admission. `nativeInvocationStarted` marks the repaired call only
after body construction and the last activity check. If pending acknowledgement arrives after the
public attempt has closed, a final correlated proven-non-invoked record retires that marker without
starting the native call. Repair does not change the chain attempt number. Successful final complete
usage follows the existing sole actual-cost writer. The public hook also accepts complete prior
failure evidence: positive and explicit-zero usage is priced, missing model/media rates remain
explicitly unpriced, and incomplete evidence never invents actual money. Current OpenAI HTTP
parameter errors do not supply usage; complete-predecessor controls exercise supported external
seam implementations. A pricing failure refuses repair after its single accounting record. An
observer throwable retains its exact opaque identity across adapter normalization and escapes
after cleanup, without a duplicate predecessor record or another admission. This does not change
core's existing distinction between external observer faults and admission/lease control-flow faults;
a still-unsettled conservative lease retains its required cleanup obligation.

A deadline with a still-live correlated producer marks its incomplete record `receiptPending: true`.
The exact raw promise remains retained; a separate registered retained continuation owns late
settlement before the host can close. Its `receiptFinal: true`, `coverageOnly: true` record carries
the same invocation identity and owned evidence, omits `receiptPending`, and retires receipt authority
for every evidence arm. Complete evidence reaches pricing once. Generated usage is read and owned
once, shared by primary settlement and the late receipt; a late accountable stream rejection contributes
its owned usage unless a held terminal already established authority. If late pricing throws, the final
observation retains complete evidence with `priced: false` and a fixed non-retryable diagnostic before
`onAccountingFailure` latches the host's money health failure. This refines coverage without reopening
the public stream or rewriting a published terminal. A held
already-complete terminal does not create another late charge. Receipt authority is process-local;
persisted identity cannot reconstruct permission to deliver a receipt or invoke another call.
Receipt activation remains a cleanup obligation when the primary attempt observer throws. It
cannot depend on successful observer return. Activating already-observed evidence must also
preserve that exact primary throwable if late accounting raises a secondary failure; no observer
failure permits a retry or discards the retained producer's final evidence.
The [event contract](../contracts/sse-event-schema.md) owns durable pending/disposition semantics.

#### Managed mode compatibility (Phase 2)

The managed gateway is not implemented. Its future `LLMProvider` must implement this same
`UsageEvidence` contract. Forced `include_usage` is a request, not proof of final evidence;
interruption cannot be converted into actual complete usage through estimation. Reservations and
future gateway reconciliation must remain separate from reported actual charges. W8 makes no
claim of compatibility with an older gateway or a new runtime version-negotiation protocol.

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
- **Strip-on-failover (ADR-0030, extended by [ADR-0090](../../decisions/0090-a-continuation-token-rides-the-part-it-belongs-to.md)):**
  crossing to a *different* provider drops every `reasoning` part (and its
  ephemeral `signature`) from the request before re-issuing. A `tool_call`'s
  `signature` strips on the finer **(provider, model)** boundary — a token is the
  MODEL's, and a `tool_call` part is unconditionally replayed where a `reasoning`
  part is optional — but the **call itself survives**: it is the conversation the
  next model still needs, so only the token goes.
- `AttemptRecord` carries chain-owned `providerInvoked`, `contentReceived` and `customEndpoint`
  independently of `LlmError`. `providerInvoked` becomes true immediately before calling the
  already-resolved and receiver-bound `generate` or `stream` method, after a final cancellation check
  following method lookup and request setup. Local cap preparation, pre-attempt
  hooks, credential resolution, cancellation before invocation, deadline setup and method lookup
  failures keep it false. Core uses
  this boundary with or without a budget governor; a failed record alone does not prove invocation.
  An uninvoked attempt cannot report or price diagnostic usage: quantities attached to a typed
  host-hook, credential or setup exception are removed before pricing, observation and surfacing.
  They cannot establish generated-response processing or content commitment. Valid failed-response
  usage after actual invocation remains accountable, including native stops and cancellation/deadline
  races; this distinction does not alter the classified diagnosis or private cause identity.
  Untyped preparation/provider exceptions use a fixed `unknown provider failure` diagnostic and
  retain the original only as a non-public cause. Typed provider errors and engine control-flow
  identities keep their existing handling. Any streamed content chunk, including an empty delta or
  reasoning/tool start, counts; a resolved non-streaming response counts even when empty. After a provider is engaged, core releases
  a failed usage-less reservation only with explicit no-content evidence on an official route and
  either classified `context_overflow` or status **429, 400, 401, 402, 403, 404, 413 or 422**. Custom, missing or uncertain evidence, other
  statuses, transport failures and timeouts retain conservative commitment. Existing proven
  pre-provider failures still release. Accounting failures after a resolved generation use a fixed
  non-retryable `unknown` error and preserve a detached schema-valid usage copy that also passes the
  cost tracker's safe-integer checks, even if pricing fails. Required counts cannot be absent. One
  owned, validated, frozen quantity snapshot feeds pricing, attempt records and the generated result;
  the held streamed terminal owns stop reason and usage, or its detached error diagnostic, before
  the grammar verifier resumes provider code to confirm EOF and before consumer callbacks.
  Cache and media quantities are included. The direct `CostTracker` entry point owns its input before
  consulting host pricing too. A pricing failure with trustworthy quantities explicitly marks its
  record `priced: false`; its realized zero placeholder never claims a complete price, and the
  governor retains its conservative reservation. A throwing usage accessor is recorded without
  invented quantities; the response usage property is read once.
  Typed provider diagnostics are detached and validated inside guarded normalization, including
  nested fields. The original cause remains private. Hostile prototype inspection during pricing or
  core cause classification cannot replace that cause; opaque causes follow normal turn mapping.
  Every attempt diagnostic remains frozen before observer delivery and retry decisions, including
  locally synthesized failures, cancellation and commitment decoration/removal; causes remain private
  opaque identities. A consumer observer exception propagates once outside provider and accounting
  guards. Abrupt consumer closure still settles the exact entered invocation once, including already
  owned complete terminal evidence or an incomplete disposition when no complete evidence exists.
  This teardown cannot yield a replacement terminal, retry the call or discard known spend; registered
  late receipt authority and the original consumer exception retain their existing precedence.
  Core carries its exact external observer origin through generated-result handling and the
  runner, including later tool rounds and host clock/backoff callbacks. Throwing a genuine provider,
  turn, budget or money error class from that observer authorises neither a paid retry, a budget gate
  nor a different ledger failure-writer owner. Core unwraps a private cause as admission/money control
  flow only when it is the exact throwable retained at the current pre-attempt boundary; matching a
  public error class alone is insufficient. Provider and pricing causes follow their guarded chain
  diagnostic. Genuine pre-attempt failures retain their existing handling. Generated content,
  stop reason and raw response properties are each read once into a plain result before host pricing
  and observer delivery, inside the protected post-response projection. A projection fault still
  prices already owned valid quantities before its single failed record; if pricing also fails,
  that accounting failure stays primary. Known usage/price remain on the record with a fixed
  non-retryable diagnostic. This
  detaches the schema-defined content fields, including nested typed media shapes, and validates stop
  reason before host pricing or observer delivery. A later mutation of provider-owned content cannot alter that typed
  projection or install a downstream accessor with retry, budget or failure-writer authority. Opaque
  returned tool arguments/results and raw response payloads retain their existing output contract.
  Their later use as request data follows the [owned-request boundary](#request-data-ownership);
  the output projection does not itself acquire that wider ownership. An admission
  stays owned until its release or settlement succeeds, so a diagnostic failure reaches conservative
  cleanup rather than losing the lease.
- Surface **complete per-attempt usage** to the injected `CostTracker` (against that
  attempt's model) so cost stays accurate across a failover, and report each
  attempt (succeeded / failed / skipped) via an `onAttempt` observer so the
  engine can report complete-evidence actual costs, qualify incomplete attempts through
  [usage coverage](../contracts/sse-event-schema.md#the-runevent-union), and log visible failover.
  The runner imports no event bus; it
  is platform-free (the host injects the `sleep` timer).

This keeps per-agent fallback (e.g. Anthropic → OpenAI → DeepSeek) a config
concern declared in [`agent-yaml-spec.md`](../contracts/agent-yaml-spec.md)
(`fallback_chain` with `max_attempts`), not adapter code.

## A second implementation behind the same seam: `ManagedGatewayProvider` (Phase 2)

Phase 2 plans a **new `LLMProvider` implementation, `ManagedGatewayProvider`** (not implemented),
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

The maintainer-only [overflow capture procedure](../../runbooks/capture-provider-overflow.md)
collects the live evidence required by ADR-0096. It is separate from the public provider seam
and the product adapters; offline command probes do not substitute for live fixtures.

The adapters prefer the official SDKs (`@anthropic-ai/sdk`, `openai`,
`@google/genai`) for typed event parsing and wire/SSE handling. **Their own retry is deliberately disabled (`maxRetries: 0`) for the chain-governed calls — `FallbackChain` is the sole retry authority there (error-handling.md §6, per ADR-0011; #276). The two surfaces the chain does not sit above — live model discovery and the async media-job poll — run with `maxRetries: 0` **as well**. A small SDK retry there was tried and REVERTED: the SDK's sleep honours `retry-after` with no ceiling and no abort awareness, so a hostile `retry-after-ms` parks the call for days.** **DeepSeek reuses
the `openai` SDK with a custom `baseURL` (`api.deepseek.com`)** — no separate
dependency. The SDKs live strictly **behind the adapter boundary** so they are
swappable without touching any caller. A future implementation may drop the
SDKs for raw `fetch` + an SSE parser (maximum no-lock-in), or slot a thin
third-party TS library behind the **same seam** — but only on a named trigger
via a follow-up ADR, and **never the Vercel AI SDK**. See
[ADR-0011](../../decisions/0011-internal-llm-abstraction.md) for the migration
stance and the named triggers.

### W7 implementation landing — 2026-10-10

The earlier dated W7 status is historical. Measured request reuse, atomic multi-pass compaction,
pre-send and single pre-content overflow recovery, finite frozen allowances and the CLI resume surface
are implemented with scoped independent acceptance. The
[closing register](../../roadmap/phases/phase-2.6.5-core-reliability-remediation.md#w7-closing-register--2026-10-10)
tracks W7's final acceptance and approved limits. The
[canonical roadmap](../../roadmap/current.md) owns subsequent W8 status.
