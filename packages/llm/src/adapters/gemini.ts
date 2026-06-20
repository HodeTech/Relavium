import { GoogleGenAI } from '@google/genai';

import { mediaModalityOf } from '@relavium/shared';
import type { ContentPart, OutputModality, StopReason } from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
import { LlmProviderError, kindFromHttpStatus, makeLlmError } from '../llm-error.js';
import { GeminiToolCallIds, normalizeToolCall, toWire } from '../tool-normalizer.js';
import type {
  CapabilityFlags,
  LlmError,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  StreamChunk,
  ToolChoice,
  ToolDef,
  Usage,
} from '../types.js';

import {
  REASONING_ID,
  assertMediaCapabilities,
  assertNoStreamingMediaOutput,
  isAbortSignal,
} from './shared.js';

/**
 * The Gemini adapter (1.H) over `@google/genai` — the riskiest adapter: a restricted tool schema and
 * **no native tool-call ids** (synthesized via the 1.E `ToolNormalizer`). Like the others it lives
 * behind the seam (SDK imported only here, nothing vendor-shaped escapes). Because `GoogleGenAI` has
 * no `fetch` hook (unlike the Anthropic/OpenAI SDKs), the network call is isolated behind an injected
 * **`GeminiTransport`**: the default wraps the real SDK, while the conformance harness injects a fake
 * that replays recorded SDK-shaped responses — keeping the fold/normalization (the part conformance
 * proves) identical and the conformance module free of any vendor import. See
 * [llm-provider-seam.md](../../../../docs/reference/shared-core/llm-provider-seam.md).
 */

const PROVIDER = 'gemini';

/**
 * Gemini's common-path capability surface (restricted tool schema; ids synthesized). 1.AE wires
 * `inlineData` input (the broadest of the three providers — all four modalities) and sets the
 * real matrix; `vision` is the derived alias of `media.input.image`. `handle`/`url` sources are
 * deferred to 1.AF (MediaStore resolution).
 */
const GEMINI_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    // video/document stay false until handle resolution lands (1.AF): base64 video/document are blocked
    // by the seam ceiling (INLINE_MEDIA_CEILING = 0 for both), so advertising them would be
    // "advertised-but-unsendable" — the gate would admit a part the mapper then rejects (ADR-0031).
    input: { image: true, audio: true, video: false, document: false },
    outputCombinations: [['text'], ['text', 'image'], ['text', 'audio']],
    surface: 'chat', // inline media-out (responseModalities) is a chat turn; generative endpoints are 1.AG Section C
  },
};

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * True when the prompt was actually blocked. Gemini's `blockReason` enum includes the
 * `BLOCKED_REASON_UNSPECIFIED` sentinel that does **not** mean "blocked" — treat only a real,
 * specified reason as a content-filter block.
 */
function isPromptBlocked(promptFeedback: { blockReason?: string } | undefined): boolean {
  const reason = promptFeedback?.blockReason;
  return reason !== undefined && reason !== 'BLOCKED_REASON_UNSPECIFIED';
}

/** Remove transport-level keys that the SDK exposes for URL/header override — SSRF guard. */
function stripTransportKeys(opts: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    // `httpOptions.baseUrl`/`headers` would redirect egress (and the API key) to an arbitrary host.
    if (k !== 'httpOptions') {
      rest[k] = v;
    }
  }
  return rest;
}

// --- Structural views of the SDK shapes (so the fold + conformance stay vendor-type-free) -------

/** The subset of a Gemini `functionCall` part the fold reads. */
interface GeminiFunctionCall {
  name?: string;
  args?: Record<string, unknown>;
}

/** The subset of a Gemini content part the fold reads. */
interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  // Inline media-out (responseModalities image/audio): a generated artifact returned IN the chat turn
  // as base64 (1.AG/ADR-0046). The engine de-inlines it to a handle at the #emitDurable choke point (1.AF).
  inlineData?: { mimeType?: string; data?: string };
}

/** The subset of a `GenerateContentResponse` the fold reads (the real SDK type satisfies this). */
export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  // Present (with a blockReason) when the prompt itself is blocked and no candidate is produced.
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
}

/** The lowered request the transport sends (a plain object the SDK accepts via a boundary cast). */
export interface GeminiRequest {
  model: string;
  contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }>;
  config: Record<string, unknown>;
}

/**
 * The injected network seam. The default wraps `@google/genai`; the conformance harness injects a
 * replay implementation. Keeping it here lets the one adapter run on every host (ADR-0018) and lets
 * tests drive the fold without a vendor import.
 */
export interface GeminiTransport {
  generate(request: GeminiRequest, key: string): Promise<GeminiResponse>;
  stream(request: GeminiRequest, key: string): Promise<AsyncIterable<GeminiResponse>>;
}

// --- Normalization: Gemini wire → canonical --------------------------------------------------

/** Map a Gemini finish reason to the canonical enum; a `STOP` with tool calls is `tool_use`. */
export function mapStopReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      // A broken/invalid tool call is a terminal failure — surface it as 'error' rather than masking
      // it as a clean 'stop' (both are tool-call faults in the pinned SDK enum; the only adapter
      // that emits 'error').
      return 'error';
    case 'STOP':
    case undefined:
      return hasToolCalls ? 'tool_use' : 'stop';
    default:
      return 'stop'; // an unknown/future reason degrades, consistent with the other adapters
  }
}

/**
 * Map Gemini usage to the canonical **NET** `Usage`. Per the `GenerateContentResponseUsageMetadata`
 * contract (the `generateContent`/`generateContentStream` shape this adapter consumes),
 * `totalTokenCount = promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount + thoughtsTokenCount`
 * — the four are **disjoint additive** terms (unlike Anthropic/OpenAI, where thinking is already inside
 * output). `promptTokenCount` includes cached content (subtracted out for NET input).
 */
export function mapUsage(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
}): Usage {
  const cached = usage.cachedContentTokenCount ?? 0;
  const thinking = usage.thoughtsTokenCount ?? 0;
  const out: Usage = {
    // Tool-use prompt tokens are input-priced and disjoint from promptTokenCount — include them so
    // input is not undercounted on grounded/tool-use calls.
    inputTokens:
      Math.max(0, (usage.promptTokenCount ?? 0) - cached) + (usage.toolUsePromptTokenCount ?? 0),
    // Thinking tokens are billed separately from candidates — sum both to match totalTokenCount (ADR-0030).
    outputTokens: (usage.candidatesTokenCount ?? 0) + thinking,
  };
  if (cached > 0) {
    out.cacheReadTokens = cached;
  }
  // Surface the thinking subset for observability (ADR-0030); already included in outputTokens above.
  if (thinking > 0) {
    out.reasoningTokens = thinking;
  }
  return out;
}

/** Fold a non-streaming Gemini response into canonical content parts (text + synthesized tool_call). */
export function mapContent(response: GeminiResponse, ids: GeminiToolCallIds): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall !== undefined) {
      const name = part.functionCall.name ?? '';
      parts.push(
        normalizeToolCall(PROVIDER, {
          id: ids.synthesize(name), // Gemini has no native id — mint a stable one (1.E)
          name,
          args: part.functionCall.args ?? {},
        }),
      );
    } else if (
      part.inlineData?.data !== undefined &&
      part.inlineData.data.length > 0 &&
      part.inlineData.mimeType !== undefined &&
      part.inlineData.mimeType.length > 0
    ) {
      // Inline media-out (responseModalities): a generated image/audio part, base64, IN the chat turn
      // (1.AG/ADR-0046). Emit an IN-FLIGHT media part; the engine de-inlines it to a handle at #emitDurable
      // (1.AF). No vendor shape escapes (I1) — only the normalized media ContentPart. A part missing data OR
      // mimeType is skipped (Gemini always sends both for a real artifact): a mimeType-less part has no media
      // MIME to content-address and would HARD-FAIL the de-inline (mediaModalityOf undefined → run:failed), so
      // dropping it is symmetric with the empty-data skip — never invent a doomed `application/octet-stream`.
      // Gemini AUDIO output carries a PARAMETERIZED mime (e.g. `audio/L16;codec=pcm;rate=24000`), but the seam's
      // MediaMimeTypeSchema admits only a BARE type/subtype — strip parameters to the bare prefix (the modality
      // derives from it; the durable media part cannot carry parameters anyway). A pathological `;…`-only value
      // strips to empty and is skipped, not emitted as a doomed part.
      const bareMime = part.inlineData.mimeType.split(';')[0]?.trim() ?? '';
      if (bareMime.length > 0) {
        parts.push({
          type: 'media',
          mimeType: bareMime,
          source: { kind: 'base64', data: part.inlineData.data },
        });
      }
    } else if (part.text !== undefined && part.text.length > 0) {
      if (part.thought === true) {
        // Reasoning (ADR-0030); thoughtSignature is the ephemeral same-provider continuity token.
        parts.push(
          part.thoughtSignature !== undefined && part.thoughtSignature.length > 0
            ? { type: 'reasoning', text: part.text, signature: part.thoughtSignature }
            : { type: 'reasoning', text: part.text },
        );
      } else {
        parts.push({ type: 'text', text: part.text });
      }
    }
  }
  return parts;
}

/** Classify any transport/SDK throwable into a normalized `LlmError` — no vendor shape escapes. */
export function geminiErrorToLlmError(err: unknown): LlmError {
  if (err instanceof Error && err.name === 'AbortError') {
    return makeLlmError({ provider: PROVIDER, kind: 'cancelled', message: 'request aborted' });
  }
  // The SDK's `ApiError` (and the conformance replay) carry a numeric `status`; classify by it.
  if (isRecord(err) && typeof err['status'] === 'number') {
    const status = err['status'];
    const message = typeof err['message'] === 'string' ? err['message'] : 'gemini API error';
    return makeLlmError({ provider: PROVIDER, kind: kindFromHttpStatus(status), message, status });
  }
  return makeLlmError({
    provider: PROVIDER,
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'unknown provider error',
  });
}

// --- Request building: canonical → Gemini wire -----------------------------------------------

function toGeminiToolChoice(choice: ToolChoice): Record<string, unknown> {
  // Gemini's function-calling mode: AUTO (default), NONE, or ANY (force a call; a named call uses
  // ANY + allowedFunctionNames).
  if (choice === 'none') {
    return { functionCallingConfig: { mode: 'NONE' } };
  }
  if (choice === 'required') {
    return { functionCallingConfig: { mode: 'ANY' } };
  }
  if (choice === 'auto') {
    return { functionCallingConfig: { mode: 'AUTO' } };
  }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } };
}

function toGeminiTool(toolDef: ToolDef): Record<string, unknown> {
  const wire = toWire(toolDef, PROVIDER);
  /* v8 ignore next 3 -- defensive: toWire('gemini') always returns the functionDeclarations shape */
  if (!('functionDeclarations' in wire)) {
    throw new Error('unreachable: the Gemini wire shape always carries functionDeclarations');
  }
  return { functionDeclarations: wire.functionDeclarations };
}

/** Build the Gemini message contents, mapping tool results back to function responses by name. */
function toGeminiContents(
  messages: readonly LlmMessage[],
): Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> {
  // Gemini references a tool result by function name, not id — recover the name from the matching
  // tool_call in this same request (its synthesized id ↔ name pairing is carried in the messages).
  const nameById = new Map<string, string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_call') {
        nameById.set(part.id, part.name);
      }
    }
  }
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.content.some((part) => part.type === 'media')) {
      // Provider-output media is de-inlined to a handle and never replayed (ADR-0031); a media part on an
      // assistant turn is a misuse — fail loud before egress, matching the OpenAI/Anthropic adapters (M2).
      throw new LlmProviderError(
        makeLlmError({
          provider: PROVIDER,
          kind: 'bad_request',
          message: 'assistant-role media is not supported (provider output media is not replayed)',
        }),
      );
    }
    const parts = toGeminiParts(message, nameById);
    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
  }
  return contents;
}

function toGeminiMediaPart(part: Extract<ContentPart, { type: 'media' }>): Record<string, unknown> {
  const modality = mediaModalityOf(part.mimeType);
  if (modality === undefined) {
    throw new LlmProviderError(
      makeLlmError({
        provider: PROVIDER,
        kind: 'bad_request',
        message: `unsupported media mime type: ${part.mimeType}`,
      }),
    );
  }
  if (part.source.kind === 'base64') {
    return { inlineData: { mimeType: part.mimeType, data: part.source.data } };
  }
  throw new LlmProviderError(
    makeLlmError({
      provider: PROVIDER,
      kind: 'bad_request',
      message: `${part.source.kind} source is unsupported for ${modality} media`,
    }),
  );
}

function toGeminiParts(
  message: LlmMessage,
  nameById: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const part of message.content) {
    if (part.type === 'text') {
      parts.push({ text: part.text });
    } else if (part.type === 'tool_call') {
      parts.push({ functionCall: { name: part.name, args: part.args } });
    } else if (part.type === 'tool_result') {
      const name = nameById.get(part.toolCallId) ?? part.toolCallId;
      // `part.media` (handle-only durable attachments) is intentionally not lowered here — deferred to
      // 1.AF (resolve via EgressCapability before egress); gate-admitted on capable providers, not yet sent.
      parts.push({ functionResponse: { name, response: toResponseObject(part.result) } });
    } else if (part.type === 'media') {
      parts.push(toGeminiMediaPart(part));
    }
    // reasoning parts are ephemeral (ADR-0030) — dropped here, never replayed to the provider.
  }
  return parts;
}

/** Gemini's `functionResponse.response` must be an object; wrap a non-object result. */
function toResponseObject(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { result };
}

/** Map a Relavium output modality to its Gemini `responseModalities` enum value (inline media-out, 1.AG).
 *  `video` is present only to satisfy `Record<OutputModality, …>` exhaustiveness: Gemini's chat-surface
 *  `responseModalities` accepts TEXT/IMAGE/AUDIO only, and no advertised `outputCombinations` includes a
 *  video set, so the exact-membership capability gate (`assertMediaCapabilities`) rejects a video request
 *  before this map is read — the entry is unreachable, kept solely for type completeness. */
const GEMINI_RESPONSE_MODALITY: Record<OutputModality, string> = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
};

/** Lower a canonical request into the Gemini request shape (system → `systemInstruction`, etc.). */
export function buildGeminiRequest(req: LlmRequest): GeminiRequest {
  const config: Record<string, unknown> = {};
  if (req.system !== undefined) {
    config['systemInstruction'] = req.system;
  }
  if (req.tools !== undefined) {
    config['tools'] = req.tools.map(toGeminiTool);
  }
  if (req.toolChoice !== undefined) {
    config['toolConfig'] = toGeminiToolChoice(req.toolChoice);
  }
  if (req.responseFormat?.type === 'json') {
    // Native structured output (ADR-0030): JSON mime type + the canonical schema as responseJsonSchema.
    config['responseMimeType'] = 'application/json';
    config['responseJsonSchema'] = req.responseFormat.schema;
  }
  if (req.temperature !== undefined) {
    config['temperature'] = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    config['maxOutputTokens'] = req.maxTokens;
  }
  if (req.outputModalities !== undefined && req.outputModalities.some((m) => m !== 'text')) {
    // Lower the node's non-text output_modalities to Gemini `responseModalities` (inline media-out,
    // 1.AG/ADR-0046). The per-modality capability gate (assertMediaCapabilities) has already rejected an
    // unsupported combination, so every member maps to a Gemini modality enum.
    config['responseModalities'] = req.outputModalities.map((m) => GEMINI_RESPONSE_MODALITY[m]);
  }
  if (req.stopSequences !== undefined) {
    config['stopSequences'] = req.stopSequences;
  }
  if (isAbortSignal(req.signal)) {
    config['abortSignal'] = req.signal;
  }
  // The typed escape hatch (1.D): caller-supplied Gemini config the common path doesn't model.
  // Strip httpOptions before the merge: a caller-supplied httpOptions.baseUrl is forwarded verbatim
  // to the SDK's patchHttpOptions path, which would redirect the request — and the real API key —
  // to an attacker-controlled URL (SSRF). Transport-level config is never safe to forward from an
  // untrusted providerOptions payload.
  const merged =
    req.providerOptions === undefined
      ? config
      : {
          ...stripTransportKeys(req.providerOptions),
          ...config, // mapped fields win
        };
  return { model: req.model, contents: toGeminiContents(req.messages), config: merged };
}

// --- The default transport (the only place the SDK is used) -----------------------------------

/* v8 ignore start -- the live-only real-SDK transport; the fold it feeds is fully covered offline via an injected GeminiTransport */
const sdkTransport: GeminiTransport = {
  async generate(request: GeminiRequest, key: string): Promise<GeminiResponse> {
    const client = new GoogleGenAI({ apiKey: key });
    return client.models.generateContent(request);
  },
  async stream(request: GeminiRequest, key: string): Promise<AsyncIterable<GeminiResponse>> {
    const client = new GoogleGenAI({ apiKey: key });
    return client.models.generateContentStream(request);
  },
};
/* v8 ignore stop */

// --- Streaming fold --------------------------------------------------------------------------

/** Mutable fold state threaded across the streamed Gemini responses. */
interface GeminiStreamState {
  reasoningOpen: boolean;
  reasoningSignature: string | undefined;
  hasToolCalls: boolean;
  /** A terminal signal (candidate finishReason or prompt block) was seen — else the stream truncated. */
  sawTerminal: boolean;
  /** The prompt was blocked (content_filter), not a normal completion. */
  blocked: boolean;
  finishReason: string | undefined;
  usage: Usage;
  readonly ids: GeminiToolCallIds;
}

/** Emit `reasoning_end` (with the accumulated signature) if reasoning is open, then reset the track. */
function closeReasoning(state: GeminiStreamState, out: StreamChunk[]): void {
  if (!state.reasoningOpen) {
    return;
  }
  out.push(
    state.reasoningSignature === undefined
      ? { type: 'reasoning_end', id: REASONING_ID }
      : { type: 'reasoning_end', id: REASONING_ID, signature: state.reasoningSignature },
  );
  state.reasoningOpen = false;
  state.reasoningSignature = undefined; // reset so a later reasoning segment starts with a fresh signature
}

/** Fold one Gemini content part into the chunks to emit, mutating the streamed fold state. */
function foldGeminiPart(part: GeminiPart, state: GeminiStreamState): StreamChunk[] {
  const out: StreamChunk[] = [];
  if (part.functionCall !== undefined) {
    const name = part.functionCall.name ?? '';
    if (name.length === 0) {
      // A functionCall with no name can't form a valid (nonEmptyString) tool_call chunk — skip it,
      // matching the OpenAI stream guard. (The non-streaming path is stricter: normalizeToolCall
      // throws on an empty name; in a stream we drop the malformed part and continue.)
      return out;
    }
    closeReasoning(state, out);
    const id = state.ids.synthesize(name);
    // Gemini delivers the whole args object in one event — emit start/delta/end together.
    out.push(
      { type: 'tool_call_start', id, name },
      { type: 'tool_call_delta', id, argsJsonDelta: JSON.stringify(part.functionCall.args ?? {}) },
      { type: 'tool_call_end', id },
    );
    state.hasToolCalls = true;
    return out;
  }
  if (part.text === undefined || part.text.length === 0) {
    return out;
  }
  if (part.thought === true) {
    if (!state.reasoningOpen) {
      out.push({ type: 'reasoning_start', id: REASONING_ID });
      state.reasoningOpen = true;
    }
    if (part.thoughtSignature !== undefined && part.thoughtSignature.length > 0) {
      state.reasoningSignature = part.thoughtSignature;
    }
    out.push({ type: 'reasoning_delta', id: REASONING_ID, text: part.text });
    return out;
  }
  closeReasoning(state, out);
  out.push({ type: 'text_delta', text: part.text });
  return out;
}

/** Fold one streamed Gemini response into chunks, updating the terminal/usage tracking on `state`. */
function foldGeminiResponse(response: GeminiResponse, state: GeminiStreamState): StreamChunk[] {
  const out: StreamChunk[] = [];
  if (response.usageMetadata) {
    state.usage = mapUsage(response.usageMetadata);
  }
  if (isPromptBlocked(response.promptFeedback)) {
    state.blocked = true;
    state.sawTerminal = true;
  }
  const candidate = response.candidates?.[0];
  if (candidate?.finishReason !== undefined) {
    state.finishReason = candidate.finishReason;
    state.sawTerminal = true;
  }
  for (const part of candidate?.content?.parts ?? []) {
    out.push(...foldGeminiPart(part, state));
  }
  return out;
}

async function* streamChunks(
  transport: GeminiTransport,
  request: GeminiRequest,
  key: string,
): AsyncIterable<StreamChunk> {
  const state: GeminiStreamState = {
    reasoningOpen: false,
    reasoningSignature: undefined,
    hasToolCalls: false,
    sawTerminal: false,
    blocked: false,
    finishReason: undefined,
    usage: ZERO_USAGE,
    ids: new GeminiToolCallIds(),
  };
  let sdkStream: AsyncIterable<GeminiResponse>;
  try {
    sdkStream = await transport.stream(request, key);
  } catch (err) {
    yield { type: 'error', error: geminiErrorToLlmError(err) };
    return;
  }
  try {
    for await (const response of sdkStream) {
      yield* foldGeminiResponse(response, state);
    }
  } catch (err) {
    yield { type: 'error', error: geminiErrorToLlmError(err) };
    return;
  }
  const tail: StreamChunk[] = [];
  closeReasoning(state, tail);
  yield* tail;
  // No finishReason and no block → truncated stream; surface a retryable transport error.
  if (!state.sawTerminal) {
    yield {
      type: 'error',
      error: makeLlmError({
        provider: PROVIDER,
        kind: 'transport',
        message: 'stream ended before a finishReason (truncated response)',
      }),
    };
    return;
  }
  const stopReason: StopReason = state.blocked
    ? 'content_filter'
    : mapStopReason(state.finishReason, state.hasToolCalls);
  yield { type: 'stop', stopReason, usage: state.usage };
}

// --- The adapter -----------------------------------------------------------------------------

/** Dependencies the conformance replayer / tests inject (the network transport). */
export interface GeminiAdapterDeps {
  /** Override the network transport (the replayer injects a recorded-response transport). */
  readonly transport?: GeminiTransport;
}

/** Build a Gemini `LlmProvider`. Exposed as `geminiAdapter`; the factory enables DI for 1.F. */
export function createGeminiAdapter(deps: GeminiAdapterDeps = {}): LlmProvider {
  const transport = deps.transport ?? sdkTransport;
  return {
    id: PROVIDER,
    supports: GEMINI_SUPPORTS,
    async generate(req: LlmRequest, key: string): Promise<LlmResult> {
      assertSupported(PROVIDER, GEMINI_SUPPORTS, req); // fail fast on an unsupported feature
      assertMediaCapabilities(PROVIDER, GEMINI_SUPPORTS, req); // per-modality input/output gate (ADR-0031, 1.AE)
      try {
        const response = await transport.generate(buildGeminiRequest(req), key);
        const ids = new GeminiToolCallIds();
        const content = mapContent(response, ids);
        const hasToolCalls = content.some((part) => part.type === 'tool_call');
        const candidate = response.candidates?.[0];
        // A blocked prompt yields no candidate but a promptFeedback.blockReason — normalize it to
        // content_filter, not a clean stop that masks the block as an empty success.
        const blocked = candidate === undefined && isPromptBlocked(response.promptFeedback);
        return {
          content,
          stopReason: blocked
            ? 'content_filter'
            : mapStopReason(candidate?.finishReason, hasToolCalls),
          usage: response.usageMetadata ? mapUsage(response.usageMetadata) : ZERO_USAGE,
          raw: response,
        };
      } catch (err) {
        throw new LlmProviderError(geminiErrorToLlmError(err));
      }
    },
    stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk> {
      assertSupported(PROVIDER, GEMINI_SUPPORTS, req); // fail fast on an unsupported feature
      assertStreamable(PROVIDER, GEMINI_SUPPORTS);
      assertMediaCapabilities(PROVIDER, GEMINI_SUPPORTS, req); // per-modality input/output gate (ADR-0031, 1.AE)
      assertNoStreamingMediaOutput(PROVIDER, req); // media-out is generate()-only; streaming triad deferred (ADR-0046 §4)
      return streamChunks(transport, buildGeminiRequest(req), key);
    },
  };
}

/** The production Gemini adapter. */
export const geminiAdapter: LlmProvider = createGeminiAdapter();
