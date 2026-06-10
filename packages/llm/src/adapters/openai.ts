import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';

import type { ContentPart, StopReason } from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
import { InvalidBaseUrlError } from '../errors.js';
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

import { REASONING_ID, assertNoMediaParts, isAbortSignal } from './shared.js';

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
 * OpenAI's common-path capability surface (reasoning models are a separate, non-common path). The
 * ADR-0031 `media` matrix is honestly all-false at 1.AD: the request path still flattens user
 * content to text (the §1.4 `textOf` bug — fixed at 1.AE), so advertising media/vision would be
 * exactly the "advertised but unsendable" lie the amendment exists to close. 1.AE unflattens the
 * content path and sets the real matrix; `vision` is the derived alias of `media.input.image`.
 */
const OPENAI_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true, // automatic prompt caching; no separate write charge
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

/** DeepSeek's capability surface (deepseek-reasoner exposes reasoning; text-only — no media, ADR-0031). */
const DEEPSEEK_SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true, // cache-hit input is discounted
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
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
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number | null;
  completion_tokens_details?: { reasoning_tokens?: number | null } | null;
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

/** Fold a non-streaming assistant message into canonical content parts (text + tool_call). */
export function mapContent(
  message: {
    content: string | null;
    // DeepSeek-R1 / Kimi return reasoning as a top-level field the OpenAI SDK does not type; the SDK
    // passes unknown response fields through, so it is present at runtime when the model emits it.
    reasoning_content?: string | null;
    tool_calls?:
      | ReadonlyArray<{ id: string; function?: { name: string; arguments: string } }>
      | undefined;
  },
  provider: ProviderId,
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

/** Normalize an SDK `APIError` into an `LlmError`, typed by the structural subset it reads. */
function mapOpenAiApiError(
  err: { status?: unknown; code?: unknown; type?: unknown; message: string },
  provider: ProviderId,
): LlmError {
  const status = typeof err.status === 'number' ? err.status : undefined;
  const code = firstNonEmptyString(err.code, err.type);
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
      // An assistant message that lowered to neither text nor tool calls (e.g. reasoning-only — reasoning
      // is ephemeral and never replayed, ADR-0030) would be wire-invalid; emit empty content instead.
      if (msg.content === undefined && msg.tool_calls === undefined) {
        msg.content = '';
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
  if (req.responseFormat?.type === 'json') {
    if (provider === 'deepseek') {
      // DeepSeek only supports json_object; json_schema returns 400 (ADR-0030).
      // Note: DeepSeek json_object also requires the word "json" to appear in the prompt.
      body.response_format = { type: 'json_object' };
    } else {
      // Native structured output for OpenAI (ADR-0030). The canonical JSON-Schema bridges here.
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: toJsonSchemaName(req.responseFormat.name),
          schema: req.responseFormat.schema as Record<string, unknown>,
          strict: req.responseFormat.strict ?? true,
        },
      };
    }
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

function buildRequestOptions(req: LlmRequest): { signal?: AbortSignal } {
  return isAbortSignal(req.signal) ? { signal: req.signal } : {};
}

/**
 * True for a hostname that resolves to a loopback, private (RFC-1918 / ULA), link-local, or
 * cloud-metadata address — the literal forms an SSRF payload would use. `host` is the already-
 * normalized `URL.hostname` (lowercased, IPv6 brackets stripped, decimal/hex IPs canonicalized).
 */
function isPrivateOrLocalHost(host: string): boolean {
  if (host.includes(':')) {
    // IPv6 literal. An embedded-IPv4 form (IPv4-mapped `::ffff:a.b.c.d` and well-known NAT64
    // `64:ff9b::a.b.c.d`) routes to its embedded IPv4 on a dual-stack host — decode it and re-check
    // the IPv4, so e.g. `::ffff:169.254.169.254` (which Node normalizes to `::ffff:a9fe:a9fe`)
    // cannot slip past as a "non-loopback" IPv6.
    const embeddedHex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (embeddedHex !== null) {
      const hi = Number.parseInt(embeddedHex[1] ?? '', 16);
      const lo = Number.parseInt(embeddedHex[2] ?? '', 16);
      return isPrivateOrLocalHost(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    const embeddedDotted = /^(?:::ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (embeddedDotted !== null) {
      return isPrivateOrLocalHost(embeddedDotted[1] ?? '');
    }
    return (
      host === '::1' || // loopback
      host === '::' || // unspecified
      host.startsWith('fe80:') || // link-local fe80::/10
      host.startsWith('fc') || // unique-local fc00::/7
      host.startsWith('fd')
    );
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host.startsWith('0.') || // 0.0.0.0/8 — "this host" / unspecified
    host.startsWith('127.') || // loopback 127/8
    host.startsWith('10.') || // private 10/8
    host.startsWith('192.168.') || // private 192.168/16
    host.startsWith('169.254.') // IPv4 link-local — cloud metadata (169.254.169.254)
  ) {
    return true;
  }
  // 172.16.0.0–172.31.255.255 (private) and 100.64.0.0–100.127.255.255 (CGNAT).
  const m172 = /^172\.(\d{1,3})\./.exec(host);
  if (m172 !== null) {
    const octet = Number(m172[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  const m100 = /^100\.(\d{1,3})\./.exec(host);
  if (m100 !== null) {
    const octet = Number(m100[1]);
    if (octet >= 64 && octet <= 127) return true;
  }
  return false;
}

/**
 * Throw if a caller-supplied `baseURL` is not a safe public HTTPS endpoint — a construction-time SSRF
 * guard so a hostile base URL can't redirect egress (with the real key) to an internal/metadata host.
 * The `URL` parser normalizes the evasions string-matching misses (userinfo `@`, decimal/hex IPs,
 * trailing dots, case, IPv6 brackets). This is a best-effort literal block; the *complete* SSRF guard
 * (DNS resolution to catch a public name pointing at a private IP, redirect re-validation) is the
 * shared security primitive's job (security-review.md) — a forward obligation, not duplicated here.
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
      assertNoMediaParts(providerId, req.messages); // media input is unwired until 1.AE (ADR-0031)
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
        return {
          // An empty `choices` array is a complete-but-empty 200 — a clean empty stop, not an error.
          content: choice === undefined ? [] : mapContent(choice.message, providerId),
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
      assertNoMediaParts(providerId, req.messages); // media input is unwired until 1.AE (ADR-0031)
      return streamChunks(createClient(key), req, providerId);
    },
  };
}

/** The production OpenAI adapter. */
export const openaiAdapter: LlmProvider = createOpenAiAdapter();

/** The production DeepSeek adapter (the shared OpenAI-compatible impl pointed at DeepSeek). */
export const deepseekAdapter: LlmProvider = createOpenAiAdapter({ providerId: 'deepseek' });
