import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';

import {
  isPrivateOrLocalHost,
  urlHasCredentials,
  type ContentPart,
  mediaModalityOf,
  type StopReason,
} from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
import { InvalidBaseUrlError, UnsupportedCapabilityError } from '../errors.js';
import { LlmProviderError, kindFromHttpStatus, makeLlmError } from '../llm-error.js';
import { normalizeToolCall, toWire } from '../tool-normalizer.js';
import type {
  CapabilityFlags,
  LlmError,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  MediaGenRequest,
  MediaGenResult,
  MediaUnitsEntry,
  ProviderId,
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
 * The shared OpenAI-compatible adapter (1.G) — one implementation over the `openai` SDK serving both
 * **OpenAI** and **DeepSeek** (DeepSeek via a custom `baseURL`, no separate dependency). Like the
 * Anthropic adapter it lives behind the `@relavium/llm` seam: the SDK is imported only here, and no
 * vendor type crosses back out (`generate` → `LlmResult`, `stream` → `StreamChunk`s, failures →
 * `LlmError`). The provider id (`openai` | `deepseek`) selects cost pricing + capabilities while one
 * fold/normalization path is shared. See
 * [llm-provider-seam.md](../../../../docs/reference/shared-core/llm-provider-seam.md).
 */

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/**
 * OpenAI's common-path capability surface. 1.AE wires the real media input matrix (image, audio,
 * document in) and sets `vision` to the derived alias of `media.input.image`. DeepSeek remains
 * text-only (no multimodal support).
 */
const OPENAI_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    // document stays false until handle resolution lands (1.AF): base64 documents are blocked by the
    // seam ceiling (INLINE_MEDIA_CEILING.document = 0) and url/handle sources are rejected by the
    // adapter, so advertising document:true would be "advertised-but-unsendable" (ADR-0031).
    input: { image: true, audio: true, video: false, document: false },
    outputCombinations: [['text'], ['text', 'audio']],
    surface: 'chat', // inline audio is a chat turn; gpt-image-1/Sora generative endpoints are 1.AG Section C/D
  },
};

/** DeepSeek's capability surface (deepseek-reasoner exposes reasoning; text-only — no media, ADR-0031). */
const DEEPSEEK_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
    surface: 'chat', // DeepSeek: text-only, no media generation — 1.AG/ADR-0045 §1
  },
};

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

// --- Normalization: OpenAI wire → canonical ---------------------------------------------------

/** Map an OpenAI/DeepSeek finish reason to the canonical 5-value enum. */
export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      // 'stop' / null / a future reason the SDK doesn't type → graceful 'stop' (matches Anthropic).
      return 'stop';
  }
}

/**
 * Map OpenAI/DeepSeek usage to the canonical **NET** `Usage`. `prompt_tokens` is **gross** (it
 * includes cache reads), so net input = `prompt_tokens − cached`. The cache count comes from
 * OpenAI's `prompt_tokens_details.cached_tokens` or DeepSeek's top-level `prompt_cache_hit_tokens`.
 */
export function mapUsage(usage: {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  prompt_tokens_details?: { cached_tokens?: number | null; audio_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
  completion_tokens_details?: {
    reasoning_tokens?: number | null;
    audio_tokens?: number | null;
  } | null;
}): Usage {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
  const gross = usage.prompt_tokens ?? 0;
  const out: Usage = {
    inputTokens: Math.max(0, gross - cached),
    outputTokens: usage.completion_tokens ?? 0,
  };
  if (cached > 0) {
    out.cacheReadTokens = cached;
  }
  // Reasoning tokens are already counted inside completion_tokens (billing unchanged); surface for
  // observability only (ADR-0030).
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (reasoning > 0) {
    out.reasoningTokens = reasoning;
  }
  // Media usage (ADR-0031/0044, 1.AF): OpenAI reports audio tokens. Report the RAW token count
  // (`unit: 'count'`) — NOT a fabricated tokens→seconds conversion, which would mis-bill — on the
  // disjoint `mediaUnits` axis, never folded into the token counts above. Anthropic/Gemini expose no
  // media counter yet, so they leave `mediaUnits` nil.
  const mediaUnits: MediaUnitsEntry[] = [];
  const inputAudio = usage.prompt_tokens_details?.audio_tokens ?? 0;
  if (inputAudio > 0) {
    mediaUnits.push({ modality: 'audio', direction: 'input', units: inputAudio, unit: 'count' });
  }
  const outputAudio = usage.completion_tokens_details?.audio_tokens ?? 0;
  if (outputAudio > 0) {
    mediaUnits.push({ modality: 'audio', direction: 'output', units: outputAudio, unit: 'count' });
  }
  if (mediaUnits.length > 0) {
    out.mediaUnits = mediaUnits;
  }
  return out;
}

/** OpenAI tool-call arguments arrive as a JSON string; parse to the canonical `args` (empty → `{}`). */
function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw.length > 0 ? raw : '{}');
  } catch {
    // Deliberate (prior review decision, locked by a unit test): a malformed provider tool-arg
    // payload degrades to {} rather than throwing and failing the whole result. A stricter
    // surface-as-fatal alternative was raised in PR #9 review and intentionally not adopted.
    return {};
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** OpenAI's accepted inline-audio output formats (a closed union on the SDK param) — used to narrow a
 *  caller-supplied `providerOptions.audio.format` to a valid value (default `wav`). */
const OPENAI_AUDIO_FORMATS = ['wav', 'aac', 'mp3', 'flac', 'opus', 'pcm16'] as const;

/** Map a requested image-out MIME (`MediaGenRequest.mimeType`) to OpenAI's image `output_format` enum, or
 *  `undefined` to leave the default (gpt-image-1 → PNG). Only the gpt-image-1-supported formats are honored. */
function imageOutputFormat(mimeType: string | undefined): 'png' | 'jpeg' | 'webp' | undefined {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg': // the common non-canonical alias — map it rather than silently falling back to PNG
      return 'jpeg';
    case 'image/webp':
      return 'webp';
    default:
      return undefined;
  }
}

/** Map a requested output-audio `format` (providerOptions.audio.format) to its MIME — OpenAI's response
 *  echoes no format, so the requested one types the media part. Defaults to `audio/wav` (OpenAI's default). */
export function outputAudioMime(req: LlmRequest): string {
  const opts = req.providerOptions;
  const audio = isRecord(opts) ? opts['audio'] : undefined;
  switch (isRecord(audio) ? audio['format'] : undefined) {
    case 'mp3':
      return 'audio/mpeg';
    case 'opus':
      return 'audio/opus';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'pcm16':
      return 'audio/L16';
    default:
      return 'audio/wav';
  }
}

/** Fold a non-streaming assistant message into canonical content parts (text + tool_call + inline audio). */
export function mapContent(
  message: {
    content: string | null;
    // DeepSeek-R1 / Kimi return reasoning as a top-level field the OpenAI SDK does not type; the SDK
    // passes unknown response fields through, so it is present at runtime when the model emits it.
    reasoning_content?: string | null;
    tool_calls?:
      | ReadonlyArray<{ id: string; function?: { name: string; arguments: string } }>
      | undefined;
    // Inline audio-out (modalities ['text','audio']): base64 audio + its transcript (1.AG/ADR-0046).
    audio?: { data: string; transcript?: string | null } | null;
  },
  provider: ProviderId,
  audioMime = 'audio/wav',
): ContentPart[] {
  const parts: ContentPart[] = [];
  if (
    message.reasoning_content !== null &&
    message.reasoning_content !== undefined &&
    message.reasoning_content.length > 0
  ) {
    parts.push({ type: 'reasoning', text: message.reasoning_content });
  }
  if (message.content !== null && message.content.length > 0) {
    parts.push({ type: 'text', text: message.content });
  }
  // Inline audio-out (1.AG/ADR-0046): surface the spoken transcript as a text part PLUS the audio as an
  // in-flight base64 media part; the engine de-inlines the media to a handle at #emitDurable (1.AF).
  // OpenAI sets `message.content` to null when audio output is requested, so the transcript text and the
  // `content` text above are mutually exclusive in practice — the transcript is not a duplicate of `content`.
  if (message.audio !== null && message.audio !== undefined && message.audio.data.length > 0) {
    const transcript = message.audio.transcript ?? '';
    if (transcript.length > 0) {
      parts.push({ type: 'text', text: transcript });
    }
    parts.push({
      type: 'media',
      mimeType: audioMime,
      source: { kind: 'base64', data: message.audio.data },
    });
  }
  for (const call of message.tool_calls ?? []) {
    if (call.function === undefined) {
      continue; // custom (non-function) tool calls are off the common path
    }
    parts.push(
      normalizeToolCall(provider, {
        id: call.id,
        name: call.function.name,
        args: parseToolArgs(call.function.arguments),
      }),
    );
  }
  return parts;
}

/** The first non-empty string of the candidates, else undefined — the normalized error `code`. */
function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** An OpenAI content-policy / moderation rejection code (image-gen + chat). Its own fatal cause, not a
 *  generic bad_request — so `codeForLlmError` yields `content_filter` (1.AG/ADR-0045 §6). */
function isContentPolicyCode(code: string | undefined): boolean {
  return code === 'content_policy_violation' || code === 'moderation_blocked';
}

/** Normalize an SDK `APIError` into an `LlmError`, typed by the structural subset it reads. */
function mapOpenAiApiError(
  err: { status?: unknown; code?: unknown; type?: unknown; message: string },
  provider: ProviderId,
): LlmError {
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = firstNonEmptyString(err.code, err.type);
  // A content-policy block normalizes to content_filter regardless of HTTP status (a moderation 400 would
  // otherwise map to bad_request) — the wired image-gen path then delivers the documented taxonomy.
  let kind: LlmErrorKind;
  if (isContentPolicyCode(code)) {
    kind = 'content_filter';
  } else if (status === undefined) {
    kind = 'unknown';
  } else {
    kind = kindFromHttpStatus(status);
  }
  return makeLlmError({
    provider,
    kind,
    message: err.message,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  });
}

/** Classify any SDK throwable into a normalized `LlmError` — no vendor error shape escapes. */
export function openaiErrorToLlmError(err: unknown, provider: ProviderId): LlmError {
  if (err instanceof APIUserAbortError) {
    return makeLlmError({ provider, kind: 'cancelled', message: 'request aborted' });
  }
  if (err instanceof APIConnectionTimeoutError) {
    return makeLlmError({ provider, kind: 'timeout', message: err.message });
  }
  if (err instanceof APIConnectionError) {
    return makeLlmError({ provider, kind: 'transport', message: err.message });
  }
  if (err instanceof APIError) {
    return mapOpenAiApiError(err, provider);
  }
  return makeLlmError({
    provider,
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'unknown provider error',
  });
}

// --- Request building: canonical → OpenAI wire -----------------------------------------------

type ToolCallPart = Extract<ContentPart, { type: 'tool_call' }>;
type ToolResultPart = Extract<ContentPart, { type: 'tool_result' }>;

/**
 * The §1.4 fix: unflatten user content from `textOf()` to `ChatCompletionContentPart[]`,
 * preserving `image_url` and `input_audio` media parts. When no media parts are present,
 * emit the existing simple `{ role: 'user', content: string }` (backwards-compat).
 */
function toOpenAiUserContent(
  content: readonly ContentPart[],
  provider: ProviderId,
): string | OpenAI.ChatCompletionContentPart[] {
  // Single pass: build the structured parts while noting whether any media is present. A media-free
  // user message stays a plain string (backwards-compat); otherwise the structured array is sent.
  const parts: OpenAI.ChatCompletionContentPart[] = [];
  let hasMedia = false;
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'media') {
      hasMedia = true;
      parts.push(toOpenAiMediaPart(part, provider));
    }
    // tool_call / tool_result / reasoning are not user content — handled per-role elsewhere.
  }
  if (!hasMedia) {
    return parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }
  return parts;
}

/** A typed `bad_request` for an unsendable media shape (never a silent drop — ADR-0031). Carries the real
 *  provider so the shared OpenAI/DeepSeek adapter attributes the error correctly. */
function openAiBadRequest(provider: ProviderId, message: string): LlmProviderError {
  return new LlmProviderError({ kind: 'bad_request', retryable: false, message, provider });
}

/** Map OpenAI's two accepted input-audio formats; reject any other audio subtype rather than mis-tagging
 *  it as `wav` (so `audio/mpeg` — the canonical MP3 MIME — is `mp3`, and `audio/ogg` etc. fail loud). */
function openAiAudioFormat(provider: ProviderId, mimeType: string): 'mp3' | 'wav' {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase() ?? '';
  if (subtype === 'mp3' || subtype === 'mpeg') return 'mp3';
  if (subtype === 'wav' || subtype === 'wave' || subtype === 'x-wav') return 'wav';
  throw openAiBadRequest(
    provider,
    `OpenAI input audio supports only mp3 and wav, not '${mimeType}'`,
  );
}

/**
 * Lower one media part to an OpenAI content part. Only **base64** sources are sent: a `url` source is
 * NEVER forwarded (ADR-0031 §A7 — a media url is fetched by the host/engine, never the adapter), and a
 * `handle` is resolved before egress (1.AF). image → `image_url`, audio → `input_audio`; video/document
 * are not input-supported (the capability gate rejects them — this throws as a fail-closed backstop).
 */
function toOpenAiMediaPart(
  part: Extract<ContentPart, { type: 'media' }>,
  provider: ProviderId,
): OpenAI.ChatCompletionContentPart {
  const modality = mediaModalityOf(part.mimeType);
  if (modality === 'image') {
    if (part.source.kind !== 'base64') {
      throw openAiBadRequest(
        provider,
        `OpenAI does not support ${part.source.kind}-source image input — use base64 (1.AF)`,
      );
    }
    return {
      type: 'image_url',
      image_url: { url: `data:${part.mimeType};base64,${part.source.data}` },
    };
  }
  if (modality === 'audio') {
    if (part.source.kind !== 'base64') {
      throw openAiBadRequest(
        provider,
        `OpenAI does not support ${part.source.kind}-source audio input — use base64 (1.AF)`,
      );
    }
    return {
      type: 'input_audio',
      input_audio: { data: part.source.data, format: openAiAudioFormat(provider, part.mimeType) },
    };
  }
  throw openAiBadRequest(provider, `OpenAI does not support ${modality ?? 'unknown'} media input`);
}

/** Extract the text content of a message for contexts where only text is expected (assistant, tool). */
function textOf(content: readonly ContentPart[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Map one canonical message to one or more OpenAI message params (tool results split out). */
function toOpenAiMessages(
  message: LlmMessage,
  provider: ProviderId,
): OpenAI.ChatCompletionMessageParam[] {
  switch (message.role) {
    case 'user': {
      const content = toOpenAiUserContent(message.content, provider);
      return [{ role: 'user', content }];
    }
    case 'assistant': {
      if (message.content.some((part) => part.type === 'media')) {
        // Provider-OUTPUT media is de-inlined to a handle and never replayed (ADR-0031); a media part on
        // an assistant turn is a misuse — fail loud rather than silently drop it via textOf.
        throw openAiBadRequest(
          provider,
          'assistant-role media is not supported (provider output media is not replayed)',
        );
      }
      const toolCalls = message.content
        .filter((part): part is ToolCallPart => part.type === 'tool_call')
        .map((part) => ({
          id: part.id,
          type: 'function' as const,
          function: { name: part.name, arguments: JSON.stringify(part.args) ?? '{}' },
        }));
      const msg: OpenAI.ChatCompletionAssistantMessageParam = { role: 'assistant' };
      const text = textOf(message.content);
      if (text.length > 0) {
        msg.content = text;
      }
      if (toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      // An assistant message that lowered to neither text nor tool calls (e.g. reasoning-only — reasoning
      // is ephemeral and never replayed, ADR-0030) would be wire-invalid; emit empty content instead.
      if (msg.content === undefined && msg.tool_calls === undefined) {
        msg.content = '';
      }
      return [msg];
    }
    case 'tool':
      // Each tool_result rides in its own {role:'tool'} message keyed by the tool-call id. `part.media`
      // (handle-only durable attachments) is intentionally not lowered here — deferred to 1.AF (resolve
      // via EgressCapability before egress); it is gate-admitted on capable providers but not yet sent.
      return message.content
        .filter((part): part is ToolResultPart => part.type === 'tool_result')
        .map((part) => ({
          role: 'tool',
          tool_call_id: part.toolCallId,
          content:
            typeof part.result === 'string' ? part.result : (JSON.stringify(part.result) ?? ''),
        }));
  }
}

function toOpenAiTool(toolDef: ToolDef, provider: ProviderId): OpenAI.ChatCompletionTool {
  const wire = toWire(toolDef, provider);
  if (!('function' in wire)) {
    throw new Error('unreachable: the OpenAI wire shape always carries a function');
  }
  const fn: OpenAI.ChatCompletionFunctionTool['function'] = {
    name: wire.function.name,
    // The canonical JSON-Schema is a valid OpenAI function-parameters object; bridge at the boundary.
    parameters: wire.function.parameters as Record<string, unknown>,
  };
  if (wire.function.description !== undefined) {
    fn.description = wire.function.description;
  }
  return { type: 'function', function: fn };
}

function toOpenAiToolChoice(choice: ToolChoice): OpenAI.ChatCompletionToolChoiceOption {
  if (choice === 'auto') {
    return 'auto';
  }
  if (choice === 'none') {
    return 'none';
  }
  if (choice === 'required') {
    return 'required';
  }
  return { type: 'function', function: { name: choice.name } };
}

/** OpenAI requires the json_schema `name` to match `^[a-zA-Z0-9_-]{1,64}$`; sanitize a caller's name. */
function toJsonSchemaName(name: string | undefined): string {
  if (name === undefined) {
    return 'response';
  }
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return sanitized.length > 0 ? sanitized : 'response';
}

/** The shared request body (everything except the `stream` discriminant each method sets). */
function buildCommonBody(
  req: LlmRequest,
  provider: ProviderId,
): Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'stream'> {
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (req.system !== undefined) {
    messages.push({ role: 'system', content: req.system });
  }
  for (const message of req.messages) {
    messages.push(...toOpenAiMessages(message, provider));
  }
  const body: Omit<OpenAI.ChatCompletionCreateParamsNonStreaming, 'stream'> = {
    model: req.model,
    messages,
  };
  if (req.tools !== undefined) {
    body.tools = req.tools.map((tool) => toOpenAiTool(tool, provider));
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice = toOpenAiToolChoice(req.toolChoice);
  }
  if (req.responseFormat?.type === 'json') {
    body.response_format = toOpenAiResponseFormat(req.responseFormat, provider);
  }
  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    body.max_tokens = req.maxTokens;
  }
  if (req.stopSequences !== undefined) {
    body.stop = req.stopSequences;
  }
  if (req.outputModalities?.includes('audio')) {
    // Inline audio-out (1.AG/ADR-0046): request the text+audio combination. `body` is spread last below, so
    // these win over a raw providerOptions echo.
    body.modalities = ['text', 'audio'];
    body.audio = resolveOpenAiAudio(req.providerOptions);
  }
  if (req.providerOptions === undefined) {
    return body;
  }
  // The typed escape hatch (1.D): `body` is spread LAST so mapped common-path fields always win.
  return { ...req.providerOptions, ...body };
}

/** Lower a canonical `responseFormat: json` to OpenAI's `response_format`: DeepSeek supports only
 *  `json_object` (json_schema 400s — ADR-0030; it also needs the word "json" in the prompt); OpenAI uses
 *  native `json_schema` (the canonical JSON-Schema bridges here). */
function toOpenAiResponseFormat(
  responseFormat: Extract<NonNullable<LlmRequest['responseFormat']>, { type: 'json' }>,
  provider: ProviderId,
): NonNullable<OpenAI.ChatCompletionCreateParams['response_format']> {
  if (provider === 'deepseek') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: toJsonSchemaName(responseFormat.name),
      schema: responseFormat.schema as Record<string, unknown>,
      strict: responseFormat.strict ?? true,
    },
  };
}

/** Resolve OpenAI inline-audio `voice` (any string) + `format` (a closed union) from
 *  `providerOptions.audio` when supplied, else OpenAI's defaults (1.AG/ADR-0046). */
function resolveOpenAiAudio(providerOptions: LlmRequest['providerOptions']): {
  voice: string;
  format: (typeof OPENAI_AUDIO_FORMATS)[number];
} {
  const audioOpts = isRecord(providerOptions) ? providerOptions['audio'] : undefined;
  const voice =
    isRecord(audioOpts) && typeof audioOpts['voice'] === 'string' ? audioOpts['voice'] : 'alloy';
  const rawFormat = isRecord(audioOpts) ? audioOpts['format'] : undefined;
  const format = OPENAI_AUDIO_FORMATS.find((f) => f === rawFormat) ?? 'wav';
  return { voice, format };
}

/** The TTS `response_format` values `audio.speech` accepts, mapped to the bare MIME the seam admits (1.AH). */
const TTS_FORMAT_TO_MIME = {
  mp3: 'audio/mpeg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
} as const satisfies Record<string, string>;

/** Map a requested output `mimeType` to a TTS `response_format` — the inverse of {@link TTS_FORMAT_TO_MIME}.
 *  Default mp3 (the API default + the canonical fallback for an unspecified/unknown request). */
function ttsResponseFormat(mimeType: string | undefined): keyof typeof TTS_FORMAT_TO_MIME {
  switch (mimeType) {
    case 'audio/opus':
      return 'opus';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
      return 'flac';
    case 'audio/wav':
      return 'wav';
    case 'audio/L16':
      return 'pcm';
    default:
      return 'mp3'; // 'audio/mpeg' or anything unspecified
  }
}

/** The TTS voice from `providerOptions.audio.voice` (any string the vendor accepts), else OpenAI's `alloy`. */
function ttsVoice(providerOptions: MediaGenRequest['providerOptions']): string {
  const audioOpts = isRecord(providerOptions) ? providerOptions['audio'] : undefined;
  return isRecord(audioOpts) && typeof audioOpts['voice'] === 'string'
    ? audioOpts['voice']
    : 'alloy';
}

function buildRequestOptions(req: LlmRequest): { signal?: AbortSignal } {
  return isAbortSignal(req.signal) ? { signal: req.signal } : {};
}

/**
 * Throw if a caller-supplied `baseURL` is not a safe public HTTPS endpoint — a construction-time SSRF
 * guard so a hostile base URL can't redirect egress (with the real key) to an internal/metadata host.
 * Uses `new URL()` for normalization (decimal/hex/octal IPs, case, trailing dots) — this lives in the
 * adapter layer where the URL global is available — then delegates the range-block to the shared
 * `isPrivateOrLocalHost` (security-review.md, 1.AE). The host-side EgressCapability.fetch adds DNS
 * resolution + connect-by-validated-IP + per-hop redirect re-validation.
 */
function assertHttpsBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidBaseUrlError(url, 'not a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new InvalidBaseUrlError(url, `must use HTTPS, got '${parsed.protocol}'`);
  }
  if (urlHasCredentials(url)) {
    throw new InvalidBaseUrlError(url, 'must not contain embedded credentials');
  }
  // Strip IPv6 brackets; the trailing-dot FQDN normalization is handled inside isPrivateOrLocalHost.
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (isPrivateOrLocalHost(host)) {
    throw new InvalidBaseUrlError(url, 'resolves to a private, loopback, or link-local address');
  }
}

// --- Streaming fold --------------------------------------------------------------------------

/**
 * Fold one streamed `tool_calls` delta into chunks, tracking the tool id by its stream index. OpenAI
 * sends `id`/`name` only on the first delta for an index; subsequent deltas carry argument fragments.
 */
function foldToolCallDelta(
  delta: { index: number; id?: string; function?: { name?: string; arguments?: string } },
  toolIdByIndex: Map<number, string>,
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  const args = delta.function?.arguments ?? '';
  const existing = toolIdByIndex.get(delta.index);
  if (existing === undefined) {
    const id = delta.id;
    const name = delta.function?.name;
    if (id === undefined || name === undefined) {
      return chunks; // defensive: can't start a tool call without an id + name
    }
    toolIdByIndex.set(delta.index, id);
    chunks.push({ type: 'tool_call_start', id, name });
    if (args.length > 0) {
      chunks.push({ type: 'tool_call_delta', id, argsJsonDelta: args });
    }
    return chunks;
  }
  if (args.length > 0) {
    chunks.push({ type: 'tool_call_delta', id: existing, argsJsonDelta: args });
  }
  return chunks;
}

/** Read a DeepSeek/Kimi `reasoning_content` delta the OpenAI SDK does not type (present at runtime). */
function readReasoningContent(delta: unknown): string | undefined {
  if (typeof delta === 'object' && delta !== null && 'reasoning_content' in delta) {
    const value = (delta as { reasoning_content?: unknown }).reasoning_content;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Mutable fold state threaded across the streamed chunks. */
interface OpenAiStreamState {
  reasoningOpen: boolean;
  stopReason: StopReason;
  /** True once a terminal `finish_reason` is seen — a stream that ends without one was truncated. */
  sawTerminal: boolean;
  /** True once the provider streamed a refusal (delta.refusal) — the stop normalizes to content_filter. */
  refused: boolean;
  readonly toolIdByIndex: Map<number, string>;
}

/** Emit a `reasoning_end` (closing the ephemeral reasoning channel) if one is open. */
function closeReasoning(state: OpenAiStreamState, out: StreamChunk[]): void {
  if (state.reasoningOpen) {
    out.push({ type: 'reasoning_end', id: REASONING_ID });
    state.reasoningOpen = false;
  }
}

/** Fold one chat-completion chunk into the chunks to emit, mutating the streamed fold state. */
function foldChatChunk(chunk: OpenAI.ChatCompletionChunk, state: OpenAiStreamState): StreamChunk[] {
  const out: StreamChunk[] = [];
  const choice = chunk.choices[0];
  if (choice === undefined) {
    return out;
  }
  // A streamed refusal (delta.refusal) is a safety decline, not an answer — record it so the terminal
  // stop normalizes to content_filter rather than masking the refusal as a successful stop.
  const refusal = choice.delta.refusal;
  if (typeof refusal === 'string' && refusal.length > 0) {
    state.refused = true;
  }
  // DeepSeek-R1 / Kimi stream reasoning first (content null) — open the ephemeral reasoning channel.
  const reasoning = readReasoningContent(choice.delta);
  if (reasoning !== undefined && reasoning.length > 0) {
    if (!state.reasoningOpen) {
      out.push({ type: 'reasoning_start', id: REASONING_ID });
      state.reasoningOpen = true;
    }
    out.push({ type: 'reasoning_delta', id: REASONING_ID, text: reasoning });
  }
  // Gate on length: an empty-string content delta is not real text, and emitting it would also close
  // the reasoning channel prematurely.
  if (choice.delta.content != null && choice.delta.content.length > 0) {
    closeReasoning(state, out);
    out.push({ type: 'text_delta', text: choice.delta.content });
  }
  for (const toolCall of choice.delta.tool_calls ?? []) {
    closeReasoning(state, out);
    out.push(...foldToolCallDelta(toolCall, state.toolIdByIndex));
  }
  if (choice.finish_reason != null) {
    closeReasoning(state, out);
    state.sawTerminal = true;
    state.stopReason = state.refused ? 'content_filter' : mapStopReason(choice.finish_reason);
    // OpenAI has no per-tool end event — every tracked tool finalizes at finish_reason.
    for (const id of state.toolIdByIndex.values()) {
      out.push({ type: 'tool_call_end', id });
    }
    state.toolIdByIndex.clear();
  }
  return out;
}

/** Fold the OpenAI chat-completion event stream into the canonical `StreamChunk` sequence. */
async function* streamChunks(
  client: OpenAI,
  req: LlmRequest,
  provider: ProviderId,
): AsyncIterable<StreamChunk> {
  const state: OpenAiStreamState = {
    reasoningOpen: false,
    stopReason: 'stop',
    sawTerminal: false,
    refused: false,
    toolIdByIndex: new Map<number, string>(),
  };
  let usage: Usage = ZERO_USAGE;
  let sdkStream: AsyncIterable<OpenAI.ChatCompletionChunk>;
  try {
    sdkStream = await client.chat.completions.create(
      { ...buildCommonBody(req, provider), stream: true, stream_options: { include_usage: true } },
      buildRequestOptions(req),
    );
  } catch (err) {
    yield { type: 'error', error: openaiErrorToLlmError(err, provider) };
    return;
  }
  try {
    for await (const chunk of sdkStream) {
      if (chunk.usage) {
        usage = mapUsage(chunk.usage); // the include_usage chunk arrives last, with empty choices
      }
      for (const out of foldChatChunk(chunk, state)) {
        yield out;
      }
    }
  } catch (err) {
    yield { type: 'error', error: openaiErrorToLlmError(err, provider) };
    return;
  }
  // A stream that ends without a terminal finish_reason was truncated (dropped connection, partial
  // body) — surface it as a retryable transport error, never a clean stop that hides lost content.
  if (!state.sawTerminal) {
    yield {
      type: 'error',
      error: makeLlmError({
        provider,
        kind: 'transport',
        message: 'stream ended before a terminal finish_reason (truncated response)',
      }),
    };
    return;
  }
  yield { type: 'stop', stopReason: state.stopReason, usage };
}

// --- The adapter -----------------------------------------------------------------------------

/** The two provider ids the OpenAI-compatible adapter can serve (a strict subset of `ProviderId`). */
type OpenAiProviderId = Extract<ProviderId, 'openai' | 'deepseek'>;

/** Dependencies the conformance replayer / tests inject (and the provider id + base URL selector). */
export interface OpenAiAdapterDeps {
  /** Which provider this instance serves — selects capabilities, cost pricing, and the default base URL. */
  readonly providerId?: OpenAiProviderId;
  /** Override the API base URL (DeepSeek defaults to `api.deepseek.com`). Validated HTTPS-only. */
  readonly baseURL?: string;
  /** Inject a `fetch` (the replayer/recorder) in place of the network. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the SDK retry count (the replayer sets 0 for deterministic, fast tests). */
  readonly maxRetries?: number;
}

/** Build an OpenAI-compatible `LlmProvider`. Exposed as `openaiAdapter` / `deepseekAdapter`. */
export function createOpenAiAdapter(deps: OpenAiAdapterDeps = {}): LlmProvider {
  const providerId: OpenAiProviderId = deps.providerId ?? 'openai';
  const supports = providerId === 'deepseek' ? DEEPSEEK_SUPPORTS : OPENAI_SUPPORTS;
  const baseURL = deps.baseURL ?? (providerId === 'deepseek' ? DEEPSEEK_BASE_URL : undefined);
  // Validate caller-supplied base URLs at construction time: HTTPS-only, no internal addresses.
  if (deps.baseURL !== undefined) {
    assertHttpsBaseUrl(deps.baseURL);
  }
  const createClient = (key: string): OpenAI =>
    new OpenAI({
      apiKey: key,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    });

  return {
    id: providerId,
    supports,
    async generate(req: LlmRequest, key: string): Promise<LlmResult> {
      assertSupported(providerId, supports, req); // fail fast, never silently drop an unsupported feature
      assertMediaCapabilities(providerId, supports, req); // per-modality input/output gate (ADR-0031, 1.AE)
      const client = createClient(key);
      try {
        const completion = await client.chat.completions.create(
          { ...buildCommonBody(req, providerId), stream: false },
          buildRequestOptions(req),
        );
        const choice = completion.choices[0];
        // A non-null refusal is a safety decline — normalize to content_filter, not a clean stop.
        const refused =
          typeof choice?.message.refusal === 'string' && choice.message.refusal.length > 0;
        // Compute the inline-audio output MIME only when audio was actually requested (it is read solely by
        // mapContent's audio branch); a text turn keeps the default and pays no providerOptions scan.
        const audioMime = req.outputModalities?.includes('audio')
          ? outputAudioMime(req)
          : 'audio/wav';
        return {
          // An empty `choices` array is a complete-but-empty 200 — a clean empty stop, not an error.
          content: choice === undefined ? [] : mapContent(choice.message, providerId, audioMime),
          stopReason: refused ? 'content_filter' : mapStopReason(choice?.finish_reason),
          usage: completion.usage ? mapUsage(completion.usage) : ZERO_USAGE,
          raw: completion,
        };
      } catch (err) {
        throw new LlmProviderError(openaiErrorToLlmError(err, providerId));
      }
    },
    stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk> {
      assertSupported(providerId, supports, req); // fail fast on an unsupported feature or no streaming
      assertStreamable(providerId, supports);
      assertMediaCapabilities(providerId, supports, req); // per-modality input/output gate (ADR-0031, 1.AE)
      assertNoStreamingMediaOutput(providerId, req); // media-out is generate()-only; streaming triad deferred (ADR-0046 §4)
      return streamChunks(createClient(key), req, providerId);
    },
    /**
     * Separate-endpoint media generation (1.AG Section C, [ADR-0045](../../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)).
     * SYNC image generation via gpt-image-1 (`client.images.generate` → base64). Audio (TTS via
     * `audio.speech`) and video are NOT wired here yet — they fail loud with a typed capability error, never a
     * silent drop (deferred — deferred-tasks.md). DeepSeek generates no media. No vendor type crosses the seam:
     * the result is a normalized `MediaGenResult` whose `raw` is strip-discarded by sinks.
     */
    async generateMedia(req: MediaGenRequest, key: string): Promise<MediaGenResult> {
      // DeepSeek (the same adapter pointed at a different baseURL) generates no media.
      if (providerId !== 'openai') {
        throw new UnsupportedCapabilityError(
          providerId,
          'media',
          `${providerId} generates no media (only OpenAI generateMedia is wired)`,
        );
      }
      const client = createClient(key);
      // SYNC separate-endpoint generation, dispatched by modality (1.AG/1.AH, ADR-0045 §1): image →
      // gpt-image-1 (images.generate); audio → TTS (audio.speech). Video is the ASYNC Sora path (a separate
      // section) — not a sync surface here.
      if (req.modality === 'image') {
        return openAiGenerateImage(client, req, providerId);
      }
      if (req.modality === 'audio') {
        return openAiGenerateSpeech(client, req, providerId);
      }
      throw new UnsupportedCapabilityError(
        providerId,
        'media',
        `OpenAI generateMedia has no SYNC surface for '${req.modality}' (video is the async Sora path)`,
      );
    },
  };
}

/**
 * SYNC image generation (gpt-image-1 via `images.generate` → base64). Honors a requested output format
 * (`req.mimeType` → png/jpeg/webp; else gpt-image-1's PNG default). The single-`MediaPart` SYNC seam carries
 * one image, so `count > 1` is rejected loud rather than billing N and dropping N-1 (a multi-image array is a
 * deferred ADR-0031 amendment). No vendor type crosses the seam — the normalized `MediaGenResult.raw` is
 * strip-discarded by sinks.
 */
async function openAiGenerateImage(
  client: OpenAI,
  req: MediaGenRequest,
  providerId: ProviderId,
): Promise<MediaGenResult> {
  if (req.count !== undefined && req.count > 1) {
    throw new LlmProviderError(
      makeLlmError({
        provider: providerId,
        kind: 'bad_request',
        message: `OpenAI image generateMedia delivers a single image; count ${String(req.count)} > 1 is not supported on the SYNC seam`,
      }),
    );
  }
  const outputFormat = imageOutputFormat(req.mimeType);
  let response: OpenAI.ImagesResponse;
  try {
    response = await client.images.generate(
      {
        model: req.model,
        prompt: req.prompt,
        ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
      },
      isAbortSignal(req.signal) ? { signal: req.signal } : {},
    );
  } catch (err) {
    throw new LlmProviderError(openaiErrorToLlmError(err, providerId));
  }
  const b64 = response.data?.[0]?.b64_json;
  if (b64 === undefined || b64.length === 0) {
    throw new LlmProviderError(
      makeLlmError({
        provider: providerId,
        kind: 'bad_request',
        message: 'OpenAI image generation returned no base64 image data',
      }),
    );
  }
  const mimeType = outputFormat === undefined ? 'image/png' : `image/${outputFormat}`;
  return {
    media: { type: 'media', mimeType, source: { kind: 'base64', data: b64 } },
    raw: response,
  };
}

/**
 * SYNC text-to-speech (1.AH): `audio.speech` returns BINARY audio bytes, so the adapter base64-encodes them
 * into an in-flight `MediaPart` (the engine de-inlines it to a handle). `req.mimeType` selects the vendor
 * `response_format` (default mp3); `providerOptions.audio.voice` selects the voice (default `alloy`). The raw
 * audio bytes NEVER cross the seam — `raw` carries only a tiny non-byte diagnostic (and sinks strip it anyway).
 */
async function openAiGenerateSpeech(
  client: OpenAI,
  req: MediaGenRequest,
  providerId: ProviderId,
): Promise<MediaGenResult> {
  const format = ttsResponseFormat(req.mimeType);
  let response: Response;
  try {
    response = await client.audio.speech.create(
      {
        model: req.model,
        voice: ttsVoice(req.providerOptions),
        input: req.prompt,
        response_format: format,
      },
      isAbortSignal(req.signal) ? { signal: req.signal } : {},
    );
  } catch (err) {
    throw new LlmProviderError(openaiErrorToLlmError(err, providerId));
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new LlmProviderError(
      makeLlmError({
        provider: providerId,
        kind: 'bad_request',
        message: 'OpenAI TTS returned no audio bytes',
      }),
    );
  }
  return {
    media: {
      type: 'media',
      mimeType: TTS_FORMAT_TO_MIME[format],
      source: { kind: 'base64', data: Buffer.from(bytes).toString('base64') },
    },
    raw: { responseFormat: format }, // diagnostic only — never the audio bytes (I3 / strip-on-sink)
  };
}

/** The production OpenAI adapter. */
export const openaiAdapter: LlmProvider = createOpenAiAdapter();

/** The production DeepSeek adapter (the shared OpenAI-compatible impl pointed at DeepSeek). */
export const deepseekAdapter: LlmProvider = createOpenAiAdapter({ providerId: 'deepseek' });
