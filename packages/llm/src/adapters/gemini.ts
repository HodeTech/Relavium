import { GoogleGenAI } from '@google/genai';

import type { ContentPart, StopReason } from '@relavium/shared';

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

/** Gemini's common-path capability surface (restricted tool schema; ids synthesized). */
const GEMINI_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: true,
};

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
}

/** The subset of a `GenerateContentResponse` the fold reads (the real SDK type satisfies this). */
export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
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
      return 'error';
    case 'STOP':
    case undefined:
      return hasToolCalls ? 'tool_use' : 'stop';
    default:
      return 'stop'; // an unknown/future reason degrades, consistent with the other adapters
  }
}

/** Map Gemini usage to the canonical **NET** `Usage`: `promptTokenCount` includes cached content. */
export function mapUsage(usage: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}): Usage {
  const cached = usage.cachedContentTokenCount ?? 0;
  const out: Usage = {
    inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) - cached),
    outputTokens: usage.candidatesTokenCount ?? 0,
  };
  if (cached > 0) {
    out.cacheReadTokens = cached;
  }
  // Thinking tokens are already inside candidatesTokenCount (billing unchanged); surface only (ADR-0030).
  const thinking = usage.thoughtsTokenCount ?? 0;
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
    const parts = toGeminiParts(message, nameById);
    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
  }
  return contents;
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
      parts.push({ functionResponse: { name, response: toResponseObject(part.result) } });
    }
    // reasoning parts are ephemeral (ADR-0030) — dropped here, never replayed to the provider.
  }
  return parts;
}

/** Gemini's `functionResponse.response` must be an object; wrap a non-object result. */
function toResponseObject(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { result };
}

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

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
  if (req.stopSequences !== undefined) {
    config['stopSequences'] = req.stopSequences;
  }
  if (isAbortSignal(req.signal)) {
    config['abortSignal'] = req.signal;
  }
  // The typed escape hatch (1.D): caller-supplied Gemini config the common path doesn't model. The
  // mapped fields are applied AFTER, so they always win over providerOptions.
  const merged = req.providerOptions === undefined ? config : { ...req.providerOptions, ...config };
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

const REASONING_ID = 'reasoning-0';

/** A `reasoning_end` chunk carrying the accumulated ephemeral signature when one was seen. */
function reasoningEnd(signature: string | undefined): StreamChunk {
  return signature === undefined
    ? { type: 'reasoning_end', id: REASONING_ID }
    : { type: 'reasoning_end', id: REASONING_ID, signature };
}

async function* streamChunks(
  transport: GeminiTransport,
  request: GeminiRequest,
  key: string,
): AsyncIterable<StreamChunk> {
  const ids = new GeminiToolCallIds();
  let usage: Usage = ZERO_USAGE;
  let finishReason: string | undefined;
  let hasToolCalls = false;
  let reasoningOpen = false;
  let reasoningSignature: string | undefined;
  let sdkStream: AsyncIterable<GeminiResponse>;
  try {
    sdkStream = await transport.stream(request, key);
  } catch (err) {
    yield { type: 'error', error: geminiErrorToLlmError(err) };
    return;
  }
  try {
    for await (const response of sdkStream) {
      if (response.usageMetadata) {
        usage = mapUsage(response.usageMetadata);
      }
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== undefined) {
        finishReason = candidate.finishReason;
      }
      for (const part of candidate?.content?.parts ?? []) {
        if (part.functionCall !== undefined) {
          if (reasoningOpen) {
            yield reasoningEnd(reasoningSignature);
            reasoningOpen = false;
          }
          const name = part.functionCall.name ?? '';
          const id = ids.synthesize(name);
          // Gemini delivers the whole args object in one event — emit start/delta/end together.
          yield { type: 'tool_call_start', id, name };
          yield {
            type: 'tool_call_delta',
            id,
            argsJsonDelta: JSON.stringify(part.functionCall.args ?? {}),
          };
          yield { type: 'tool_call_end', id };
          hasToolCalls = true;
        } else if (part.text !== undefined && part.text.length > 0) {
          if (part.thought === true) {
            if (!reasoningOpen) {
              yield { type: 'reasoning_start', id: REASONING_ID };
              reasoningOpen = true;
            }
            if (part.thoughtSignature !== undefined && part.thoughtSignature.length > 0) {
              reasoningSignature = part.thoughtSignature;
            }
            yield { type: 'reasoning_delta', id: REASONING_ID, text: part.text };
          } else {
            if (reasoningOpen) {
              yield reasoningEnd(reasoningSignature);
              reasoningOpen = false;
            }
            yield { type: 'text_delta', text: part.text };
          }
        }
      }
    }
  } catch (err) {
    yield { type: 'error', error: geminiErrorToLlmError(err) };
    return;
  }
  if (reasoningOpen) {
    yield reasoningEnd(reasoningSignature);
  }
  yield { type: 'stop', stopReason: mapStopReason(finishReason, hasToolCalls), usage };
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
      try {
        const response = await transport.generate(buildGeminiRequest(req), key);
        const ids = new GeminiToolCallIds();
        const content = mapContent(response, ids);
        const hasToolCalls = content.some((part) => part.type === 'tool_call');
        return {
          content,
          stopReason: mapStopReason(response.candidates?.[0]?.finishReason, hasToolCalls),
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
      return streamChunks(transport, buildGeminiRequest(req), key);
    },
  };
}

/** The production Gemini adapter. */
export const geminiAdapter: LlmProvider = createGeminiAdapter();
