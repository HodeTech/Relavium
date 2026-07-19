import Anthropic from '@anthropic-ai/sdk';

import { mediaModalityOf } from '@relavium/shared';
import type { AbortSignalLike, ContentPart, StopReason } from '@relavium/shared';

import { assertStreamable, assertSupported } from '../capabilities.js';
import { catalogModel, modelAccepts } from '../catalog/lookup.js';
import { cappedMaxTokens } from '../output-cap.js';
import { LlmProviderError, kindFromHttpStatus, makeLlmError } from '../llm-error.js';
import {
  ANTHROPIC_WIRE,
  acceptedWireValue,
  canDisableReasoning,
  reasoningBudgetFor,
  thinkingCeiling,
} from '../reasoning-wire.js';
import { normalizeToolCall, toWire } from '../tool-normalizer.js';
import type {
  CapabilityFlags,
  LlmError,
  LlmErrorKind,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResult,
  ModelListing,
  StreamChunk,
  ToolChoice,
  ToolDef,
  Usage,
} from '../types.js';

import {
  CONTEXT_SEAM_DEFAULTS,
  assertListModelsShape,
  assertMediaCapabilities,
  boundedListModels,
  isAbortSignal,
  isRecord,
  positiveModelInt,
  toModelListing,
} from './shared.js';

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
/** Anthropic's API caps `temperature` at 1 (the shared contract's envelope is the wider [0, 2]). */
const MAX_TEMPERATURE = 1;
// The tier → wire map moved to `reasoning-wire.ts` (ADR-0071 §6): `acceptedTiers` must compose it with the
// catalog's per-model values, and two copies of "what we send a provider" are two chances to disagree.

/**
 * Anthropic supports the full common-path surface; provider-specific features go via
 * `providerOptions`. The ADR-0031 `media` matrix is honestly all-false at 1.AD (shape only — no
 * media input is wired, so advertising it would re-create the "advertised but unsendable" bug);
 * 1.AE wires the input path and sets the real matrix (image/document in, no media out). `vision`
 * is the derived alias of `media.input.image`, so it reads false until then too.
 */
const SUPPORTS: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    // document stays false until handle resolution lands (1.AF): base64 documents are blocked by the
    // seam ceiling (INLINE_MEDIA_CEILING.document = 0), so advertising document:true would be
    // "advertised-but-unsendable" — the gate would admit a PDF the mapper then rejects (ADR-0031).
    input: { image: true, audio: false, video: false, document: false },
    outputCombinations: [],
    surface: 'chat', // no media generation — 1.AG/ADR-0045 §1
  },
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
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}): Usage {
  const out: Usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  if (usage.cache_read_input_tokens != null) {
    out.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens != null) {
    out.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  // Thinking tokens are already inside output_tokens (billing unchanged); surface for visibility (ADR-0030).
  const thinking = usage.output_tokens_details?.thinking_tokens ?? 0;
  if (thinking > 0) {
    out.reasoningTokens = thinking;
  }
  return out;
}

/** Fold an Anthropic message's content blocks into canonical content parts (text + tool_call + reasoning). */
export function mapContent(blocks: readonly Anthropic.ContentBlock[]): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      parts.push(
        normalizeToolCall(PROVIDER, { id: block.id, name: block.name, args: block.input }),
      );
    } else if (block.type === 'thinking') {
      // Reasoning (ADR-0030); the signature is the ephemeral same-provider continuity token.
      parts.push(
        block.signature.length > 0
          ? { type: 'reasoning', text: block.thinking, signature: block.signature }
          : { type: 'reasoning', text: block.thinking },
      );
    } else if (block.type === 'redacted_thinking') {
      parts.push({ type: 'reasoning', text: '', redacted: true });
    }
    // other server-tool blocks remain off the common path — reachable via LlmResult.raw.
  }
  return parts;
}

/**
 * Map one Anthropic `models.list()` row (`ModelInfo`) to a canonical {@link ModelListing}, or `undefined`
 * to drop it (ADR-0064 §3). Anthropic's list is rich: `display_name`→displayName, `max_input_tokens`→
 * contextWindowTokens, `max_tokens`→maxOutputTokens — but Anthropic returns `0`/`null` for an unknown limit,
 * so a non-positive limit is OMITTED (`positiveModelInt`). Lenient-inbound: the SDK types most fields, but
 * each is read defensively (the live API can deviate from the pinned SDK); the rich `capabilities` object is
 * intentionally ignored (nothing in the merge consumes it). No filter — Anthropic's list is clean.
 */
export function mapAnthropicModel(info: {
  id?: string;
  display_name?: string | null;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
}): ModelListing | undefined {
  const candidate: Record<string, unknown> = {
    id: typeof info.id === 'string' ? info.id : '', // '' fails the schema's min(1) → the row is dropped
  };
  if (typeof info.display_name === 'string' && info.display_name.length > 0) {
    candidate['displayName'] = info.display_name;
  }
  const context = positiveModelInt(info.max_input_tokens);
  if (context !== undefined) {
    candidate['contextWindowTokens'] = context;
  }
  const maxOutput = positiveModelInt(info.max_tokens);
  if (maxOutput !== undefined) {
    candidate['maxOutputTokens'] = maxOutput;
  }
  return toModelListing(candidate);
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
  // A NATIVE abort — an `Error`/`DOMException` named 'AbortError' thrown when the signal fires during a body
  // read OUTSIDE the SDK's request wrapper (so not an `APIUserAbortError`). Classify by name → `cancelled`,
  // mirroring the OpenAI adapter, not the catch-all `unknown`.
  if (err instanceof Error && err.name === 'AbortError') {
    return makeLlmError({ provider: PROVIDER, kind: 'cancelled', message: 'request aborted' });
  }
  return makeLlmError({
    provider: PROVIDER,
    kind: 'unknown',
    message: err instanceof Error ? err.message : 'unknown provider error',
  });
}

// --- Request building: canonical → Anthropic wire --------------------------------------------

function toAnthropicBlock(
  part: Exclude<ContentPart, { type: 'reasoning' } | { type: 'media' }>,
): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_call':
      return { type: 'tool_use', id: part.id, name: part.name, input: part.args };
    case 'tool_result': {
      // `part.media` (handle-only durable attachments) is intentionally not lowered here — deferred to
      // 1.AF (resolve via EgressCapability before egress); gate-admitted on capable providers, not yet sent.
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
    /* v8 ignore next 4 -- defensive: the wire-able content is a closed 3-variant union */
    default: {
      const unreachable: never = part;
      throw new Error(`unhandled content part: ${String(unreachable)}`);
    }
  }
}

/** A typed Anthropic `bad_request` for an unsendable shape (never a silent drop — ADR-0031). */
function anthropicBadRequest(message: string): LlmProviderError {
  return new LlmProviderError(makeLlmError({ provider: PROVIDER, kind: 'bad_request', message }));
}

/** The image subtypes Anthropic's base64 image block accepts (the SDK's closed `media_type` union). */
const ANTHROPIC_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/** Narrow a MIME to an Anthropic-accepted image subtype (so the wire `media_type` needs no unsafe cast). */
function isAnthropicImageType(mime: string): mime is Anthropic.Base64ImageSource['media_type'] {
  return (ANTHROPIC_IMAGE_TYPES as readonly string[]).includes(mime);
}

/**
 * Lower one media part to an Anthropic content block — **base64 only**. A `url`/`handle` source is
 * rejected: a media url is fetched by the host/engine, never the adapter (ADR-0031 §A7), and a handle is
 * resolved before egress (1.AF). image → `image` block; document → `document` block (PDF). Other
 * modalities throw as a fail-closed backstop (the capability gate rejects them first).
 */
function toAnthropicMediaBlock(
  part: Extract<ContentPart, { type: 'media' }>,
): Anthropic.ContentBlockParam {
  const modality = mediaModalityOf(part.mimeType);
  if (modality === 'image') {
    if (part.source.kind !== 'base64') {
      throw anthropicBadRequest(
        `Anthropic does not support ${part.source.kind}-source image input — use base64 (1.AF)`,
      );
    }
    if (!isAnthropicImageType(part.mimeType)) {
      // Subtype gate: the modality gate admits any image/*, but Anthropic accepts only these four — reject
      // an unsupported subtype pre-egress with a clear message rather than letting it 400 on the wire.
      throw anthropicBadRequest(
        `Anthropic image input supports only ${ANTHROPIC_IMAGE_TYPES.join(', ')}, not '${part.mimeType}'`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: part.mimeType, data: part.source.data },
    };
  }
  if (modality === 'document') {
    if (part.source.kind !== 'base64') {
      throw anthropicBadRequest(
        `Anthropic does not support ${part.source.kind}-source document input — use base64 (1.AF)`,
      );
    }
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: part.source.data },
    };
  }
  throw anthropicBadRequest(`Anthropic does not support ${modality ?? 'unknown'} media input`);
}

/**
 * Lower one NON-media part onto `blocks`: reasoning becomes a `thinking` block only when it carries a
 * replayable signature (redacted / signature-less reasoning is ephemeral and dropped — ADR-0030);
 * everything else maps via {@link toAnthropicBlock}. Shared by every content-lowering loop.
 */
function pushNonMediaBlock(
  part: Exclude<ContentPart, { type: 'media' }>,
  blocks: Anthropic.ContentBlockParam[],
): void {
  if (part.type === 'reasoning') {
    if (part.redacted === true || part.signature === undefined) {
      return;
    }
    blocks.push({ type: 'thinking', thinking: part.text, signature: part.signature });
    return;
  }
  blocks.push(toAnthropicBlock(part));
}

function toAnthropicContentBlocks(content: readonly ContentPart[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === 'media') {
      blocks.push(toAnthropicMediaBlock(part));
      continue;
    }
    pushNonMediaBlock(part, blocks);
  }
  return blocks;
}

function toAnthropicMessage(message: LlmMessage): Anthropic.MessageParam {
  if (message.role === 'assistant') {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const part of message.content) {
      if (part.type === 'media') {
        // Provider-output media is de-inlined to a handle and never replayed (ADR-0031); a media part on
        // an assistant turn is a misuse — fail loud rather than silently dropping it.
        throw anthropicBadRequest(
          'assistant-role media is not supported (provider output media is not replayed)',
        );
      }
      pushNonMediaBlock(part, content);
    }
    return { role: 'assistant', content };
  }
  // User turns (media or not) lower through the same path — toAnthropicContentBlocks maps any media
  // and pushes every non-media block, so a media-free user message produces the identical blocks.
  return { role: 'user', content: toAnthropicContentBlocks(message.content) };
}

/** Normalize a message's content to a block array (Anthropic allows a bare string for a text turn). */
function blocksOf(content: string | Anthropic.ContentBlockParam[]): Anthropic.ContentBlockParam[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

/**
 * Fold consecutive same-role messages into one. Anthropic requires alternating user/assistant roles
 * and **all** of a turn's `tool_result` blocks in a SINGLE user message — but the canonical model
 * carries one `role:'tool'` message per result (and `tool` lowers to `user`), so a parallel-tool turn
 * produces adjacent user messages the API would 400. Merging the mapped blocks fixes it at the seam
 * (the right home — OpenAI keys per `tool_call_id` and needs no merge).
 */
function mergeAdjacentSameRole(
  messages: readonly Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last !== undefined && last.role === message.role) {
      out[out.length - 1] = {
        role: last.role,
        content: [...blocksOf(last.content), ...blocksOf(message.content)],
      };
    } else {
      out.push(message);
    }
  }
  return out;
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

/**
 * ADR-0066/0071: map the normalized reasoning-effort tier onto Anthropic's PER-MODEL control — it has BOTH shapes
 * in play, and the shipped adapter sent `output_config.effort` to both.
 *
 *   • effort-shaped (`claude-opus-4-8`, …) → `output_config.effort` + ADAPTIVE thinking.
 *   • budget-shaped (`claude-haiku-4-5` — NO effort axis at all) → the legacy `thinking.budget_tokens`. Legacy for
 *     the industry, not for haiku: one of the four Claude models we ship, and it publishes a budget and no ladder.
 *
 * `off` is neither shape: `thinking: {type:'disabled'}`, an independent switch that works on both. A model the
 * catalog cannot describe (a custom endpoint) gets NO reasoning field, `off` included — `thinking:{disabled}` is
 * still a field, and still a 400 on a model with no reasoning surface. A guess is what put a rejected value on the
 * wire in the first place. `maxTokens` is the CLAMPED cap already on `body.max_tokens`, so a derived budget stays
 * under it (Anthropic rejects `budget_tokens >= max_tokens`).
 */
function applyAnthropicReasoning(
  body: Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'>,
  req: LlmRequest,
  maxTokens: number,
): void {
  if (req.reasoningEffort === undefined) return;
  const controls = catalogModel(req.model)?.reasoning;
  if (controls === undefined) return; // unknown/custom model — withhold every reasoning field, `off` included

  if (req.reasoningEffort === 'off') {
    // `canDisableReasoning`, not a bare `true`. An EMPTY descriptor (`{}`) means the model reasons but publishes no
    // knob at all — `thinking:{disabled}` is still a field, and still a 400 on a model with no reasoning surface to
    // switch. Asking the same predicate the picker asks is what keeps the two in step.
    if (canDisableReasoning('anthropic', controls)) {
      body.thinking = { type: 'disabled' };
    }
    return;
  }

  if (acceptedWireValue('anthropic', req.reasoningEffort, controls) !== undefined) {
    // MEMBERSHIP, not presence. `claude-opus-4-5` publishes ['low','medium','high'] — no `max` — and the old branch
    // tested only that an effort axis EXISTED, then sent `effort: 'max'` anyway. It reaches the wire on a FAILOVER,
    // where the chain re-points a request at a weaker model.
    body.thinking = { type: 'adaptive' };
    body.output_config = {
      ...body.output_config,
      // The effort level MERGES alongside any structured-output `format` already on output_config.
      effort: ANTHROPIC_WIRE[req.reasoningEffort],
    };
    return;
  }

  if (controls.budgetTokens !== undefined) {
    // The BUDGET shape — and also the fallback when a model's effort axis does not contain THIS tier.
    // `claude-opus-4-5` publishes both, so a tier it cannot express as an effort level is still expressible as a
    // budget. Anthropic requires `budget_tokens < max_tokens`, and a budget that eats the whole cap leaves no
    // answer — so the ceiling reserves room for the reply (see THINKING_BUDGET_SHARE).
    const budget = reasoningBudgetFor(
      req.reasoningEffort,
      controls.budgetTokens,
      thinkingCeiling(maxTokens), // the CLAMPED cap — the one actually on the wire
    );
    // `undefined` ⇒ the model's MINIMUM budget does not fit under this request's `max_tokens` (haiku's floor is
    // 1024; a request capped at 256 has none). Withhold rather than send a value the API rejects — and rather than
    // quietly raising `max_tokens` to make room, which would change both what the user asked for and what they pay.
    if (budget !== undefined) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
  }
  // A model that publishes NO usable control gets the reasoning field WITHHELD.
}

/** The shared request body (everything except the `stream` discriminant each method sets). */
function buildCommonBody(
  req: LlmRequest,
): Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'> {
  // The output cap, held at or below the model's own ceiling (ADR-0071 §7). Anthropic REQUIRES `max_tokens`, so an
  // absent one defaults — and the default is clamped too, in case a model's ceiling is ever below it.
  //
  // This value is also the ceiling the thinking budget is derived from, a few lines down. Clamping here and not
  // there would put `budget_tokens` above the `max_tokens` we actually send, which Anthropic rejects outright —
  // so it is computed ONCE and both uses read it.
  const maxTokens =
    cappedMaxTokens(req.maxTokens ?? DEFAULT_MAX_TOKENS, req.model) ?? DEFAULT_MAX_TOKENS;
  const body: Omit<Anthropic.MessageCreateParamsNonStreaming, 'stream'> = {
    model: req.model,
    max_tokens: maxTokens,
    messages: mergeAdjacentSameRole(req.messages.map(toAnthropicMessage)),
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
  // `structured_output` is gated on the MODEL's per-model capability (ADR-0071 amendment): a model can reject a
  // response-format request its provider supports, and sending it is a 400. Withhold, never send-and-fail.
  if (req.responseFormat?.type === 'json' && modelAccepts(req.model, 'structuredOutput')) {
    // Native structured output via output_config (ADR-0030); the canonical JSON-Schema bridges here.
    body.output_config = {
      format: { type: 'json_schema', schema: req.responseFormat.schema as Record<string, unknown> },
    };
  }
  applyAnthropicReasoning(body, req, maxTokens);
  // Extended thinking pins `temperature` to 1 on Anthropic — `thinking:{enabled|adaptive}` alongside any other
  // temperature is a guaranteed 400 (review M4). `applyAnthropicReasoning` (above) just set `body.thinking`, so read
  // it here: a non-`disabled` thinking block means reasoning is ON, and the caller's temperature must be WITHHELD.
  const thinkingEnabled = body.thinking !== undefined && body.thinking.type !== 'disabled';
  if (
    req.temperature !== undefined &&
    modelAccepts(req.model, 'temperature') && // the per-model capability (gpt-class parity; ADR-0071 amendment)
    !thinkingEnabled
  ) {
    // The shared contract is the provider-agnostic [0, 2] envelope (common.ts); Anthropic's API
    // accepts temperature in [0, 1]. Fail fast (the adapter's "never silently drop" posture) rather
    // than forward a value the provider will 400 on — the guard stays provider-local, contract
    // unchanged. NaN/negative are rejected too: `NaN > 1` and `-0.5 > 1` are both false, so an
    // upper-bound-only check would silently forward them to a guaranteed 400.
    if (
      !Number.isFinite(req.temperature) ||
      req.temperature < 0 ||
      req.temperature > MAX_TEMPERATURE
    ) {
      throw new LlmProviderError(
        makeLlmError({
          provider: PROVIDER,
          kind: 'bad_request',
          message: `temperature ${String(req.temperature)} is outside Anthropic's accepted range [0, ${String(MAX_TEMPERATURE)}]`,
        }),
      );
    }
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
    output_tokens_details?: { thinking_tokens?: number | null } | null;
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
  // message_delta carries the authoritative cumulative thinking count (same semantics as output_tokens).
  // Fall back to the message_start value only if the delta omits the details field entirely.
  const thinking = delta.output_tokens_details?.thinking_tokens ?? prev.reasoningTokens ?? 0;
  if (thinking > 0) {
    merged.reasoningTokens = thinking;
  }
  return merged;
}

/** Per-index reasoning-block state: the synthesized chunk id, accumulating signature, redacted flag. */
interface ReasoningBlock {
  readonly id: string;
  signature?: string;
  readonly redacted: boolean;
}

/**
 * Fold one content-block stream event into the `StreamChunk` to emit (or `undefined`), tracking the
 * tool-call id and the reasoning block by content-block index so delta/stop chunks carry the matching
 * id (and the reasoning signature accumulates onto the terminating `reasoning_end`). ADR-0030.
 */
function handleContentBlockStart(
  event: Anthropic.RawContentBlockStartEvent,
  toolIdByIndex: Map<number, string>,
  reasoningByIndex: Map<number, ReasoningBlock>,
): StreamChunk | undefined {
  const block = event.content_block;
  if (block.type === 'tool_use') {
    toolIdByIndex.set(event.index, block.id);
    return { type: 'tool_call_start', id: block.id, name: block.name };
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    const id = `reasoning-${String(event.index)}`;
    reasoningByIndex.set(event.index, { id, redacted: block.type === 'redacted_thinking' });
    return { type: 'reasoning_start', id };
  }
  return undefined;
}

function handleContentBlockDelta(
  event: Anthropic.RawContentBlockDeltaEvent,
  toolIdByIndex: Map<number, string>,
  reasoningByIndex: Map<number, ReasoningBlock>,
): StreamChunk | undefined {
  const delta = event.delta;
  if (delta.type === 'text_delta') {
    return { type: 'text_delta', text: delta.text };
  }
  if (delta.type === 'input_json_delta') {
    const id = toolIdByIndex.get(event.index);
    return id === undefined
      ? undefined
      : { type: 'tool_call_delta', id, argsJsonDelta: delta.partial_json };
  }
  if (delta.type === 'thinking_delta') {
    const reasoning = reasoningByIndex.get(event.index);
    return reasoning === undefined
      ? undefined
      : { type: 'reasoning_delta', id: reasoning.id, text: delta.thinking };
  }
  if (delta.type === 'signature_delta') {
    const reasoning = reasoningByIndex.get(event.index);
    if (reasoning !== undefined) {
      // The signature streams incrementally like thinking text — append, don't overwrite.
      reasoning.signature = (reasoning.signature ?? '') + delta.signature;
    }
    return undefined;
  }
  return undefined;
}

function handleContentBlockStop(
  event: Anthropic.RawContentBlockStopEvent,
  toolIdByIndex: Map<number, string>,
  reasoningByIndex: Map<number, ReasoningBlock>,
): StreamChunk | undefined {
  const toolId = toolIdByIndex.get(event.index);
  if (toolId !== undefined) {
    return { type: 'tool_call_end', id: toolId };
  }
  const reasoning = reasoningByIndex.get(event.index);
  if (reasoning === undefined) {
    return undefined;
  }
  // Carry both the accumulated signature and the redacted flag (asymmetry fix: non-streaming
  // mapContent already sets redacted; the stream must too — ADR-0030).
  const end: Extract<StreamChunk, { type: 'reasoning_end' }> = {
    type: 'reasoning_end',
    id: reasoning.id,
  };
  if (reasoning.signature !== undefined) {
    end.signature = reasoning.signature;
  }
  if (reasoning.redacted) {
    end.redacted = true;
  }
  return end;
}

/**
 * Fold one content-block stream event into the `StreamChunk` to emit (or `undefined`) by delegating
 * to the per-phase handlers, which track the tool-call id and reasoning block by content-block index
 * so delta/stop chunks carry the matching id (and the reasoning signature accumulates). ADR-0030.
 */
function contentBlockToChunk(
  event:
    | Anthropic.RawContentBlockStartEvent
    | Anthropic.RawContentBlockDeltaEvent
    | Anthropic.RawContentBlockStopEvent,
  toolIdByIndex: Map<number, string>,
  reasoningByIndex: Map<number, ReasoningBlock>,
): StreamChunk | undefined {
  if (event.type === 'content_block_start') {
    return handleContentBlockStart(event, toolIdByIndex, reasoningByIndex);
  }
  if (event.type === 'content_block_delta') {
    return handleContentBlockDelta(event, toolIdByIndex, reasoningByIndex);
  }
  return handleContentBlockStop(event, toolIdByIndex, reasoningByIndex);
}

/** Fold the Anthropic SSE event stream into the canonical `StreamChunk` sequence. */
async function* streamChunks(client: Anthropic, req: LlmRequest): AsyncIterable<StreamChunk> {
  const toolIdByIndex = new Map<number, string>();
  const reasoningByIndex = new Map<number, ReasoningBlock>();
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = 'stop';
  // The message_delta event carries the authoritative stop_reason + final usage; a stream that ends
  // without it was truncated and must not be reported as a successful stop.
  let sawStop = false;
  let sdkStream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
  try {
    sdkStream = await client.messages.create(
      { ...buildCommonBody(req), stream: true },
      buildRequestOptions(req),
    );
  } catch (err) {
    // A pre-egress guard (e.g. temperature > Anthropic max) already carries a classified LlmError —
    // surface it as-is rather than re-classifying it as an unknown SDK error.
    yield {
      type: 'error',
      error: err instanceof LlmProviderError ? err.llmError : anthropicErrorToLlmError(err),
    };
    return;
  }
  try {
    for await (const event of sdkStream) {
      if (event.type === 'message_start') {
        usage = mapUsage(event.message.usage);
      } else if (event.type === 'message_delta') {
        stopReason = mapStopReason(event.delta.stop_reason);
        usage = mergeDeltaUsage(usage, event.usage);
        sawStop = true;
      } else if (
        event.type === 'content_block_start' ||
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop'
      ) {
        const chunk = contentBlockToChunk(event, toolIdByIndex, reasoningByIndex);
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
  // No message_delta arrived → the SSE stream was cut before completion. Surface a retryable
  // transport error rather than a clean stop that hides the lost tail.
  if (!sawStop) {
    yield {
      type: 'error',
      error: makeLlmError({
        provider: PROVIDER,
        kind: 'transport',
        message: 'stream ended before message_delta (truncated response)',
      }),
    };
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
      assertMediaCapabilities(PROVIDER, SUPPORTS, req); // per-modality input/output gate (ADR-0031, 1.AE)
      const client = createClient(key);
      let message: Anthropic.Message;
      try {
        message = await client.messages.create(
          { ...buildCommonBody(req), stream: false },
          buildRequestOptions(req),
        );
      } catch (err) {
        if (err instanceof LlmProviderError) throw err; // a pre-egress guard error — keep its classification
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
      assertMediaCapabilities(PROVIDER, SUPPORTS, req); // per-modality input/output gate (ADR-0031, 1.AE)
      return streamChunks(createClient(key), req);
    },
    /**
     * Live model discovery (ADR-0064 §1) over the SDK's `models.list()` — a rich, auto-paginating
     * `PagePromise` (iterated with `for await`, which follows `has_more`/`last_id`). Each `ModelInfo` is
     * mapped INSIDE the adapter to a canonical `ModelListing` (no vendor type escapes), and a per-row parse
     * failure drops only that row. Bounded + abortable + secret-free via `boundedListModels`.
     */
    async listModels(key: string, signal?: AbortSignalLike): Promise<ModelListing[]> {
      return boundedListModels({
        provider: PROVIDER,
        key,
        signal,
        classify: anthropicErrorToLlmError,
        collect: async (innerSignal) => {
          const client = createClient(key);
          const listings: ModelListing[] = [];
          const seen = new Set<string>();
          let rawCount = 0;
          let droppedForShape = 0;
          for await (const info of client.models.list(undefined, { signal: innerSignal })) {
            rawCount += 1;
            if (!isRecord(info)) {
              droppedForShape += 1; // a non-object row (e.g. a null in `data`) — drop it, never dereference
              continue;
            }
            const listing = mapAnthropicModel(info);
            if (listing === undefined) {
              droppedForShape += 1; // no usable id (Anthropic's list is unfiltered — undefined ⇒ shape-invalid)
              continue;
            }
            if (!seen.has(listing.id)) {
              seen.add(listing.id);
              listings.push(listing);
            }
          }
          // ADR-0064 §8: a systemic id-removal (rows present, none usable, some shape-broken) THROWS so the
          // host's per-provider isolation shows "last-known" rather than an empty picker.
          assertListModelsShape(PROVIDER, { rawCount, kept: listings.length, droppedForShape });
          return listings;
        },
      });
    },
    // ADR-0062 context-compaction seam — the shared defaults (a native token-count endpoint could specialize
    // estimateTokens later; real usage is authoritative, so the heuristic is only a pre-first-turn fallback).
    ...CONTEXT_SEAM_DEFAULTS,
  };
}

/** The production Anthropic adapter. */
export const anthropicAdapter: LlmProvider = createAnthropicAdapter();
