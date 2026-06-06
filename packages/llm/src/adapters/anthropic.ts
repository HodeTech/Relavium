import Anthropic from '@anthropic-ai/sdk';

import type { ContentPart, StopReason } from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
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
  StreamChunk,
  ToolChoice,
  ToolDef,
  Usage,
} from '../types.js';

/**
 * The reference adapter over `@anthropic-ai/sdk` (1.C) — the seam fence's first real consumer and
 * the first place a vendor SDK is imported (allowed only under `src/adapters/*`). It establishes the
 * normalization patterns the conformance harness (1.F) then enforces across every adapter: no vendor
 * type ever crosses back out — `generate` returns `LlmResult`, `stream` yields `StreamChunk`s, and
 * failures are classified `LlmError`s. See
 * [llm-provider-seam.md](../../../../docs/reference/shared-core/llm-provider-seam.md).
 */

const PROVIDER = 'anthropic';
/** Anthropic requires `max_tokens`; default it when the request omits one. */
const DEFAULT_MAX_TOKENS = 4096;

/** Anthropic supports the full common-path surface; provider-specific features go via `providerOptions`. */
const SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: true,
};

// --- Normalization: Anthropic wire → canonical -----------------------------------------------

/** Map an Anthropic stop reason to the canonical 5-value enum. */
export function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
    case null:
      return 'stop';
    default:
      // A stop_reason the pinned SDK's union doesn't cover (the live API can outpace the SDK)
      // degrades to 'stop' rather than throwing and crashing the run.
      return 'stop';
  }
}

/**
 * Map Anthropic usage to the canonical `Usage`. Anthropic's `input_tokens` is already **net** of
 * cache reads/writes (seam §6), so the four token classes stay disjoint and the CostTracker bills
 * each once.
 */
export function mapUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): Usage {
  const out: Usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  if (usage.cache_read_input_tokens != null) {
    out.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens != null) {
    out.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  return out;
}

/** Fold an Anthropic message's content blocks into canonical content parts (text + tool_call). */
export function mapContent(blocks: readonly Anthropic.ContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      parts.push(
        normalizeToolCall(PROVIDER, { id: block.id, name: block.name, args: block.input }),
      );
    }
    // thinking / server-tool blocks are off the common path — reachable via LlmResult.raw.
  }
  return parts;
}

/** Map an Anthropic error-body `type` to a kind — works even when there's no HTTP status (a stream `error` event). */
function kindFromErrorType(type: string): LlmErrorKind | undefined {
  switch (type) {
    case 'rate_limit_error':
      return 'rate_limit';
    case 'overloaded_error':
    case 'api_error':
      return 'overloaded';
    case 'timeout_error':
      return 'timeout';
    case 'authentication_error':
    case 'permission_error':
      return 'auth';
    case 'invalid_request_error':
    case 'not_found_error':
      return 'bad_request';
    default:
      return undefined; // e.g. billing_error → fall back to the HTTP status, then 'unknown'
  }
}

/**
 * Normalize an SDK `APIError` (the only branch with status/code logic) into an `LlmError`. Typed by
 * the structural subset it reads, so the SDK's `APIError<any, …>` generics don't leak in as `any`.
 */
function mapAnthropicApiError(err: {
  status?: unknown;
  type?: unknown;
  message: string;
}): LlmError {
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = typeof err.type === 'string' && err.type.length > 0 ? err.type : undefined;
  // Prefer the provider's own error `type` (set even on a mid-stream `error` event that carries no
  // HTTP status), then fall back to the status, then `unknown`.
  const kind =
    (code === undefined ? undefined : kindFromErrorType(code)) ??
    (status === undefined ? 'unknown' : kindFromHttpStatus(status));
  return makeLlmError({
    provider: PROVIDER,
    kind,
    message: err.message,
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
  });
}

/**
 * Classify any SDK throwable into a normalized `LlmError` — no vendor error shape escapes. The raw
 * SDK error is deliberately **not** attached as `cause`: the `LlmError` crosses the seam (into run
 * events / persistence), and a raw provider object there is both a vendor-shape leak and a latent
 * secret-exposure surface (error-handling.md). `message` is the SDK's already-redacted text; `code`
 * comes from the provider's own error `type` (e.g. 'rate_limit_error'), never `Error.name`.
 */
export function anthropicErrorToLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return makeLlmError({ provider: PROVIDER, kind: 'cancelled', message: 'request aborted' });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return makeLlmError({ provider: PROVIDER, kind: 'timeout', message: err.message });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return makeLlmError({ provider: PROVIDER, kind: 'transport', message: err.message });
  }
  if (err instanceof Anthropic.APIError) {
    return mapAnthropicApiError(err);
  }
  return makeLlmError({
    provider: PROVIDER,
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'unknown provider error',
  });
}

// --- Request building: canonical → Anthropic wire --------------------------------------------

function toAnthropicBlock(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_call':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.args };
    case 'tool_result': {
      const block: Anthropic.ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content:
          typeof part.result === 'string' ? part.result : (JSON.stringify(part.result) ?? ''),
      };
      if (part.isError !== undefined) {
        block.is_error = part.isError;
      }
      return block;
    }
    /* v8 ignore next 4 -- defensive: ContentPart is a closed 3-variant union */
    default: {
      const unreachable: never = part;
      throw new Error(`unhandled content part: ${String(unreachable)}`);
    }
  }
}

function toAnthropicMessage(message: LlmMessage): Anthropic.MessageParam {
  // Anthropic has only user/assistant roles; tool results ride in a user-role message.
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.map(toAnthropicBlock),
  };
}

function toAnthropicToolChoice(choice: ToolChoice): Anthropic.ToolChoice {
  if (choice === 'auto') {
    return { type: 'auto' };
  }
  if (choice === 'none') {
    return { type: 'none' };
  }
  if (choice === 'required') {
    return { type: 'any' };
  }
  return { type: 'tool', name: choice.name };
}

function toAnthropicTool(toolDef: ToolDef): Anthropic.Tool {
  const wire = toWire(toolDef, PROVIDER);
  if (!('input_schema' in wire)) {
    throw new Error('unreachable: the Anthropic wire shape always carries input_schema');
  }
  const tool: Anthropic.Tool = {
    name: wire.name,
    // The canonical JSON-Schema is a valid Anthropic input schema; bridge the narrower SDK type
    // at this vendor boundary.
    input_schema: wire.input_schema as Anthropic.Tool.InputSchema,
  };
  if (wire.description !== undefined) {
    tool.description = wire.description;
  }
  return tool;
}

/** The shared request body (everything except the `stream` discriminant each method sets). */
function buildCommonBody(
  req: LlmRequest,
): Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'> {
  const body: Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'> = {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: req.messages.map(toAnthropicMessage),
  };
  if (req.system !== undefined) {
    body.system = req.system;
  }
  if (req.tools !== undefined) {
    body.tools = req.tools.map(toAnthropicTool);
  }
  if (req.toolChoice !== undefined) {
    body.tool_choice = toAnthropicToolChoice(req.toolChoice);
  }
  if (req.temperature !== undefined) {
    body.temperature = req.temperature;
  }
  if (req.stopSequences !== undefined) {
    body.stop_sequences = req.stopSequences;
  }
  if (req.providerOptions === undefined) {
    return body;
  }
  // The typed escape hatch (1.D): caller-supplied Anthropic-specific params (e.g. `thinking`,
  // `metadata`) the common path doesn't model. `body` is spread LAST so the mapped common-path
  // fields (model / messages / max_tokens / tools / …) always win — providerOptions can only ADD,
  // never override or smuggle past the canonical request.
  return { ...req.providerOptions, ...body };
}

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/** Bridge the host's `AbortSignalLike` (a real `AbortSignal` at runtime) to the SDK's signal option. */
function buildRequestOptions(req: LlmRequest): { signal?: AbortSignal } {
  return isAbortSignal(req.signal) ? { signal: req.signal } : {};
}

// --- The adapter -----------------------------------------------------------------------------

/**
 * Dependencies the conformance replayer / tests inject. They override the transport, not the client,
 * so the provider SDK stays imported only here — the conformance harness never imports a vendor SDK.
 */
export interface AnthropicAdapterDeps {
  /** Inject a `fetch` (the replayer/recorder) in place of the network. */
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Override the SDK retry count (the replayer sets 0 for deterministic, fast tests). */
  readonly maxRetries?: number;
}

/** Merge a streamed `message_delta` usage (whose token fields are cumulative) over the accumulated
 * usage, field by field — so the final cache/input counts the SDK delivers on the delta are kept. */
function mergeDeltaUsage(
  prev: Usage,
  delta: {
    input_tokens: number | null;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): Usage {
  const merged: Usage = {
    inputTokens: delta.input_tokens ?? prev.inputTokens,
    outputTokens: delta.output_tokens,
  };
  const cacheRead = delta.cache_read_input_tokens ?? prev.cacheReadTokens;
  if (cacheRead != null) {
    merged.cacheReadTokens = cacheRead;
  }
  const cacheWrite = delta.cache_creation_input_tokens ?? prev.cacheWriteTokens;
  if (cacheWrite != null) {
    merged.cacheWriteTokens = cacheWrite;
  }
  return merged;
}

/**
 * Fold one content-block stream event into the `StreamChunk` to emit (or `undefined`), tracking the
 * Anthropic tool-call id by content-block index so delta/stop chunks carry the matching id.
 */
function contentBlockToChunk(
  event:
    | Anthropic.RawContentBlockStartEvent
    | Anthropic.RawContentBlockDeltaEvent
    | Anthropic.RawContentBlockStopEvent,
  toolIdByIndex: Map<number, string>,
): StreamChunk | undefined {
  if (event.type === 'content_block_start') {
    if (event.content_block.type === 'tool_use') {
      toolIdByIndex.set(event.index, event.content_block.id);
      return {
        type: 'tool_call_start',
        id: event.content_block.id,
        name: event.content_block.name,
      };
    }
    return undefined;
  }
  if (event.type === 'content_block_delta') {
    if (event.delta.type === 'text_delta') {
      return { type: 'text_delta', text: event.delta.text };
    }
    if (event.delta.type === 'input_json_delta') {
      const id = toolIdByIndex.get(event.index);
      return id === undefined
        ? undefined
        : { type: 'tool_call_delta', id, argsJsonDelta: event.delta.partial_json };
    }
    return undefined;
  }
  // content_block_stop
  const id = toolIdByIndex.get(event.index);
  return id === undefined ? undefined : { type: 'tool_call_end', id };
}

/** Fold the Anthropic SSE event stream into the canonical `StreamChunk` sequence. */
async function* streamChunks(client: Anthropic, req: LlmRequest): AsyncIterable<StreamChunk> {
  const toolIdByIndex = new Map<number, string>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = 'stop';
  let sdkStream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
  try {
    sdkStream = await client.messages.create(
      { ...buildCommonBody(req), stream: true },
      buildRequestOptions(req),
    );
  } catch (err) {
    yield { type: 'error', error: anthropicErrorToLlmError(err) };
    return;
  }
  try {
    for await (const event of sdkStream) {
      if (event.type === 'message_start') {
        usage = mapUsage(event.message.usage);
      } else if (event.type === 'message_delta') {
        stopReason = mapStopReason(event.delta.stop_reason);
        usage = mergeDeltaUsage(usage, event.usage);
      } else if (
        event.type === 'content_block_start' ||
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop'
      ) {
        const chunk = contentBlockToChunk(event, toolIdByIndex);
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      // message_stop (and any other event) emits nothing.
    }
  } catch (err) {
    yield { type: 'error', error: anthropicErrorToLlmError(err) };
    return;
  }
  yield { type: 'stop', stopReason, usage };
}

/** Build an Anthropic `LlmProvider`. Exposed as `anthropicAdapter`; the factory enables DI for 1.F. */
export function createAnthropicAdapter(deps: AnthropicAdapterDeps = {}): LlmProvider {
  const createClient = (key: string): Anthropic =>
    new Anthropic({
      apiKey: key,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.maxRetries === undefined ? {} : { maxRetries: deps.maxRetries }),
    });

  return {
    id: PROVIDER,
    supports: SUPPORTS,
    async generate(req: LlmRequest, key: string): Promise<LlmResult> {
      assertSupported(PROVIDER, SUPPORTS, req); // fail fast, never silently drop an unsupported feature
      const client = createClient(key);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          { ...buildCommonBody(req), stream: false },
          buildRequestOptions(req),
        );
      } catch (err) {
        throw new LlmProviderError(anthropicErrorToLlmError(err));
      }
      return {
        content: mapContent(message.content),
        stopReason: mapStopReason(message.stop_reason),
        usage: mapUsage(message.usage),
        raw: message,
      };
    },
    stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk> {
      assertSupported(PROVIDER, SUPPORTS, req); // fail fast on an unsupported feature or no streaming
      assertStreamable(PROVIDER, SUPPORTS);
      return streamChunks(createClient(key), req);
    },
  };
}

/** The production Anthropic adapter. */
export const anthropicAdapter: LlmProvider = createAnthropicAdapter();
