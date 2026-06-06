import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';

import type { ContentPart, StopReason } from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
import { LlmProviderError, kindFromHttpStatus, makeLlmError } from '../llm-error.js';
import { normalizeToolCall, toWire } from '../tool-normalizer.js';
import type {
  CapabilityFlags,
  LlmError,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  ProviderId,
  StreamChunk,
  ToolChoice,
  ToolDef,
  Usage,
} from '../types.js';

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

/** OpenAI's common-path capability surface (reasoning models are a separate, non-common path). */
const OPENAI_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true, // automatic prompt caching; no separate write charge
  reasoning: false,
};

/** DeepSeek's capability surface (deepseek-reasoner exposes reasoning; no vision). */
const DEEPSEEK_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true, // cache-hit input is discounted
  reasoning: true,
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
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
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
  return out;
}

/** OpenAI tool-call arguments arrive as a JSON string; parse to the canonical `args` (empty → `{}`). */
function parseToolArgs(raw: string): unknown {
  return JSON.parse(raw.length > 0 ? raw : '{}');
}

/** Fold a non-streaming assistant message into canonical content parts (text + tool_call). */
export function mapContent(
  message: {
    content: string | null;
    tool_calls?:
      | ReadonlyArray<{ id: string; function?: { name: string; arguments: string } }>
      | undefined;
  },
  provider: ProviderId,
): ContentPart[] {
  const parts: ContentPart[] = [];
  if (message.content !== null && message.content.length > 0) {
    parts.push({ type: 'text', text: message.content });
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

/** Normalize an SDK `APIError` into an `LlmError`, typed by the structural subset it reads. */
function mapOpenAiApiError(
  err: { status?: unknown; code?: unknown; type?: unknown; message: string },
  provider: ProviderId,
): LlmError {
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code =
    typeof err.code === 'string' && err.code.length > 0
      ? err.code
      : typeof err.type === 'string' && err.type.length > 0
        ? err.type
        : undefined;
  const kind = status === undefined ? 'unknown' : kindFromHttpStatus(status);
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

/** Concatenate the text parts of a message into one string (OpenAI content is a plain string here). */
function textOf(content: readonly ContentPart[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/** Map one canonical message to one or more OpenAI message params (tool results split out). */
function toOpenAiMessages(message: LlmMessage): OpenAI.ChatCompletionMessageParam[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: textOf(message.content) }];
    case 'assistant': {
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
      return [msg];
    }
    case 'tool':
      // Each tool_result rides in its own {role:'tool'} message keyed by the tool-call id.
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
    messages.push(...toOpenAiMessages(message));
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
  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  if (req.maxTokens !== undefined) {
    body.max_tokens = req.maxTokens;
  }
  if (req.stopSequences !== undefined) {
    body.stop = req.stopSequences;
  }
  if (req.providerOptions === undefined) {
    return body;
  }
  // The typed escape hatch (1.D): `body` is spread LAST so mapped common-path fields always win.
  return { ...req.providerOptions, ...body };
}

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

function buildRequestOptions(req: LlmRequest): { signal?: AbortSignal } {
  return isAbortSignal(req.signal) ? { signal: req.signal } : {};
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

/** Fold the OpenAI chat-completion event stream into the canonical `StreamChunk` sequence. */
async function* streamChunks(
  client: OpenAI,
  req: LlmRequest,
  provider: ProviderId,
): AsyncIterable<StreamChunk> {
  const toolIdByIndex = new Map<number, string>();
  let usage: Usage = ZERO_USAGE;
  let stopReason: StopReason = 'stop';
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
      const choice = chunk.choices[0];
      if (choice === undefined) {
        continue;
      }
      if (choice.delta.content !== null && choice.delta.content !== undefined) {
        yield { type: 'text_delta', text: choice.delta.content };
      }
      for (const toolCall of choice.delta.tool_calls ?? []) {
        for (const out of foldToolCallDelta(toolCall, toolIdByIndex)) {
          yield out;
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        stopReason = mapStopReason(choice.finish_reason);
        // OpenAI has no per-tool end event — every tracked tool finalizes at finish_reason.
        for (const id of toolIdByIndex.values()) {
          yield { type: 'tool_call_end', id };
        }
        toolIdByIndex.clear();
      }
    }
  } catch (err) {
    yield { type: 'error', error: openaiErrorToLlmError(err, provider) };
    return;
  }
  yield { type: 'stop', stopReason, usage };
}

// --- The adapter -----------------------------------------------------------------------------

/** Dependencies the conformance replayer / tests inject (and the provider id + base URL selector). */
export interface OpenAiAdapterDeps {
  /** Which provider this instance serves — selects capabilities, cost pricing, and the default base URL. */
  readonly providerId?: ProviderId;
  /** Override the API base URL (DeepSeek defaults to `api.deepseek.com`). */
  readonly baseURL?: string;
  /** Inject a `fetch` (the replayer/recorder) in place of the network. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the SDK retry count (the replayer sets 0 for deterministic, fast tests). */
  readonly maxRetries?: number;
}

/** Build an OpenAI-compatible `LlmProvider`. Exposed as `openaiAdapter` / `deepseekAdapter`. */
export function createOpenAiAdapter(deps: OpenAiAdapterDeps = {}): LlmProvider {
  const providerId: ProviderId = deps.providerId ?? 'openai';
  const supports = providerId === 'deepseek' ? DEEPSEEK_SUPPORTS : OPENAI_SUPPORTS;
  const baseURL = deps.baseURL ?? (providerId === 'deepseek' ? DEEPSEEK_BASE_URL : undefined);
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
      const client = createClient(key);
      try {
        const completion = await client.chat.completions.create(
          { ...buildCommonBody(req, providerId), stream: false },
          buildRequestOptions(req),
        );
        const choice = completion.choices[0];
        return {
          content: choice === undefined ? [] : mapContent(choice.message, providerId),
          stopReason: mapStopReason(choice?.finish_reason),
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
      return streamChunks(createClient(key), req, providerId);
    },
  };
}

/** The production OpenAI adapter. */
export const openaiAdapter: LlmProvider = createOpenAiAdapter();

/** The production DeepSeek adapter (the shared OpenAI-compatible impl pointed at DeepSeek). */
export const deepseekAdapter: LlmProvider = createOpenAiAdapter({ providerId: 'deepseek' });
