import Anthropic from '@anthropic-ai/sdk';

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
    default: {
      const unreachable: never = reason;
      throw new Error(`unhandled Anthropic stop reason: ${String(unreachable)}`);
    }
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

/** Classify any SDK throwable into a normalized `LlmError` — no vendor error shape escapes. */
export function anthropicErrorToLlmError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIUserAbortError) {
    return makeLlmError({
      provider: PROVIDER,
      kind: 'cancelled',
      message: 'request aborted',
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return makeLlmError({ provider: PROVIDER, kind: 'timeout', message: err.message, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return makeLlmError({
      provider: PROVIDER,
      kind: 'transport',
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const kind = status !== undefined ? kindFromHttpStatus(status) : 'unknown';
    return makeLlmError(
      status !== undefined
        ? { provider: PROVIDER, kind, message: err.message, status, code: err.name, cause: err }
        : { provider: PROVIDER, kind, message: err.message, code: err.name, cause: err },
    );
  }
  return makeLlmError({
    provider: PROVIDER,
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'unknown provider error',
    cause: err,
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
  // The typed escape hatch (1.D): merge caller-supplied Anthropic-specific params (e.g. `thinking`,
  // `metadata`) the common path doesn't model. Off the common path, so the caller owns their validity.
  return { ...body, ...req.providerOptions };
}

/** Bridge the host's `AbortSignalLike` (a real `AbortSignal` at runtime) to the SDK's signal option. */
function buildRequestOptions(req: LlmRequest): { signal?: AbortSignal } {
  return req.signal !== undefined ? { signal: req.signal as AbortSignal } : {};
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

/** Build an Anthropic `LlmProvider`. Exposed as `anthropicAdapter`; the factory enables DI for 1.F. */
export function createAnthropicAdapter(deps: AnthropicAdapterDeps = {}): LlmProvider {
  const createClient = (key: string): Anthropic =>
    new Anthropic({
      apiKey: key,
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
    });

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
        switch (event.type) {
          case 'message_start':
            usage = mapUsage(event.message.usage);
            break;
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              toolIdByIndex.set(event.index, event.content_block.id);
              yield {
                type: 'tool_call_start',
                id: event.content_block.id,
                name: event.content_block.name,
              };
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { type: 'text_delta', text: event.delta.text };
            } else if (event.delta.type === 'input_json_delta') {
              const id = toolIdByIndex.get(event.index);
              if (id !== undefined) {
                yield { type: 'tool_call_delta', id, argsJsonDelta: event.delta.partial_json };
              }
            }
            break;
          case 'content_block_stop': {
            const id = toolIdByIndex.get(event.index);
            if (id !== undefined) {
              yield { type: 'tool_call_end', id };
            }
            break;
          }
          case 'message_delta':
            stopReason = mapStopReason(event.delta.stop_reason);
            usage = { ...usage, outputTokens: event.usage.output_tokens };
            break;
          case 'message_stop':
            break;
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: 'error', error: anthropicErrorToLlmError(err) };
      return;
    }
    yield { type: 'stop', stopReason, usage };
  }

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
