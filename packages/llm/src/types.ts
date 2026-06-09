import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';

import { ContentPartSchema, LLM_PROVIDERS, StopReasonSchema } from '@relavium/shared';
import type { AbortSignalLike, LlmProviderId } from '@relavium/shared';

/**
 * The **`LLMProvider` seam** — the provider-agnostic boundary every multi-LLM call in Relavium
 * crosses ([llm-provider-seam.md](../../../docs/reference/shared-core/llm-provider-seam.md),
 * [ADR-0011](../../../docs/decisions/0011-internal-llm-abstraction.md)). Every type here is a
 * Relavium/Zod type. **No vendor SDK type ever crosses this seam** — the import-zone fence allows
 * provider SDKs only under `src/adapters/*`. The seam's _shape_ is immovable; the adapters behind
 * it are reversible, and the _set_ of provider ids is meant to grow (an additive amendment).
 *
 * The data types are Zod schemas (with inferred TS types) so adapter output can be validated; the
 * one exception is `LlmProvider` itself, a behavioural interface (it carries methods). `StopReason`
 * and `ContentPart` are owned by `@relavium/shared` and re-exported here (the dependency direction
 * is `shared → llm`, so they cannot live here and also be used by the shared session schemas).
 */

/** Non-empty string — `@relavium/shared` keeps its Zod primitives internal, so the seam owns one. */
const nonEmptyString = z.string().min(1);
const nonNegativeInt = z.number().int().nonnegative();

/** The seam's closed provider-id set (`LLM_PROVIDERS`; additive per ADR-0011). */
export const ProviderIdSchema = z.enum(LLM_PROVIDERS);
export type ProviderId = LlmProviderId;

/**
 * One canonical tool definition; the `ToolNormalizer` (1.E) reshapes `parameters` to each
 * provider's wire form. `parameters` is a JSON-Schema object — the deep subset validation/reshape
 * is the normalizer's job, so it is accepted here as any object.
 */
export const ToolDefSchema = z.object({
  name: nonEmptyString,
  description: z.string().optional(),
  parameters: z.custom<JSONSchema7>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    { message: 'parameters must be a JSON-Schema object' },
  ),
});
export type ToolDef = z.infer<typeof ToolDefSchema>;

/** A normalized message: a role plus normalized content parts (never a raw string). */
export const LlmRoleSchema = z.enum(['user', 'assistant', 'tool']);
export type LlmRole = z.infer<typeof LlmRoleSchema>;

export const LlmMessageSchema = z.object({
  role: LlmRoleSchema,
  content: z.array(ContentPartSchema),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/** How the model may use tools this turn. */
export const ToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ name: nonEmptyString }),
]);
export type ToolChoice = z.infer<typeof ToolChoiceSchema>;

/**
 * How the model should shape its output (ADR-0030). `json` carries one canonical JSON-Schema; each
 * adapter lowers it to the provider's **native** structured-output mode (OpenAI `response_format`,
 * Gemini `responseJsonSchema`, Anthropic `output_config`/forced tool) — native-vs-forced is the
 * adapter's concern. This is the seam mechanism that realizes a node's `output_schema`.
 */
export const ResponseFormatSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }),
  z.object({
    type: z.literal('json'),
    schema: z.custom<JSONSchema7>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      { message: 'responseFormat.schema must be a JSON-Schema object' },
    ),
    name: nonEmptyString.optional(), // schema name some providers require (OpenAI); adapters default it
    strict: z.boolean().optional(), // strict/exact-schema adherence where the provider supports it
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

/** Normalized token usage. `costMicrocents` is Relavium's, computed from the pricing table. */
export const UsageSchema = z
  .object({
    inputTokens: nonNegativeInt,
    outputTokens: nonNegativeInt,
    cacheReadTokens: nonNegativeInt.optional(),
    cacheWriteTokens: nonNegativeInt.optional(),
    // Reasoning ("thinking") tokens — OBSERVABILITY only (ADR-0030). Already counted inside
    // `outputTokens` for billing, so the CostTracker bills `outputTokens` whole; this is not a new
    // cost class, just visibility into how much of the output was reasoning.
    reasoningTokens: nonNegativeInt.optional(),
    costMicrocents: nonNegativeInt.optional(),
  })
  // Enforce the ADR-0030 invariant: reasoning is a SUBSET of output, never larger. Catches an adapter
  // that mis-maps the reasoning count (the seam's contract, not a billing input).
  .refine((u) => u.reasoningTokens === undefined || u.reasoningTokens <= u.outputTokens, {
    message: 'reasoningTokens must be ≤ outputTokens (reasoning is counted inside output)',
    path: ['reasoningTokens'],
  });
export type Usage = z.infer<typeof UsageSchema>;

/** What a provider supports; features off the common path are reached via `providerOptions`. */
export const CapabilityFlagsSchema = z.object({
  tools: z.boolean(),
  streaming: z.boolean(),
  parallelToolCalls: z.boolean(),
  vision: z.boolean(),
  promptCache: z.boolean(),
  reasoning: z.boolean(),
});
export type CapabilityFlags = z.infer<typeof CapabilityFlagsSchema>;

/**
 * The classified discriminant the `FallbackChain` narrows on (never `error.message`). The first
 * four kinds are `retryable: true`; the rest are fatal. The per-provider native→kind mapping lives
 * inside each adapter (error-handling.md).
 */
export const LlmErrorKindSchema = z.enum([
  'rate_limit',
  'overloaded',
  'timeout',
  'transport',
  'auth',
  'bad_request',
  'content_filter',
  'cancelled',
  'unknown',
]);
export type LlmErrorKind = z.infer<typeof LlmErrorKindSchema>;

/** The one error shape that crosses the seam — no vendor SDK error escapes an adapter. */
export const LlmErrorSchema = z.object({
  kind: LlmErrorKindSchema,
  retryable: z.boolean(),
  code: nonEmptyString.optional(), // normalized provider/transport code, e.g. 'rate_limit'
  status: z.number().int().optional(), // upstream HTTP status, when there was one
  provider: ProviderIdSchema,
  message: z.string(), // human-readable, already redacted of any secret material
  // INTERNAL diagnostic only — may hold a raw vendor error and is NOT scrubbed by `makeLlmError`
  // (unlike `message`/`code`). Never log, serialize, or put it in a run event: any sink must strip
  // `cause` first (the run-event error shape `{ code, message, retryable }` already excludes it).
  cause: z.unknown().optional(), // original error for debugging — never re-thrown across the seam
});
export type LlmError = z.infer<typeof LlmErrorSchema>;

/** The normalized, provider-agnostic request. `system` is always one top-level field. */
export const LlmRequestSchema = z.object({
  model: nonEmptyString, // canonical model id, mapped per adapter
  system: z.string().optional(),
  messages: z.array(LlmMessageSchema),
  tools: z.array(ToolDefSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: ResponseFormatSchema.optional(), // structured-output request (ADR-0030)
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(), // required downstream for Anthropic — adapters default it
  stopSequences: z.array(z.string()).optional(),
  // Host-injected cancellation; the raw key/transport is host-aware (ADR-0018), the type is not.
  // Validated structurally so a non-signal value is rejected at the seam, not later when it is observed.
  signal: z
    .custom<AbortSignalLike>(
      (v: unknown) =>
        typeof v === 'object' &&
        v !== null &&
        'aborted' in v &&
        typeof v.aborted === 'boolean' &&
        'addEventListener' in v &&
        typeof v.addEventListener === 'function' &&
        'removeEventListener' in v &&
        typeof v.removeEventListener === 'function',
      {
        message:
          'signal must be an AbortSignalLike (aborted: boolean; add/removeEventListener: function)',
      },
    )
    .optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(), // typed escape hatch
});
export type LlmRequest = z.infer<typeof LlmRequestSchema>;

/** The normalized non-streaming result. */
export const LlmResultSchema = z.object({
  content: z.array(ContentPartSchema), // text + any tool_call parts
  stopReason: StopReasonSchema,
  usage: UsageSchema,
  raw: z.unknown(), // provider response, for debugging / the escape hatch
});
export type LlmResult = z.infer<typeof LlmResultSchema>;

/** The single discriminated chunk union every provider's stream is folded into. */
export const StreamChunkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_call_start'), id: nonEmptyString, name: nonEmptyString }),
  z.object({ type: z.literal('tool_call_delta'), id: nonEmptyString, argsJsonDelta: z.string() }),
  z.object({ type: z.literal('tool_call_end'), id: nonEmptyString }),
  // Reasoning channel (ADR-0030) — mirrors the tool_call_* triad; `id` correlates the deltas to the
  // terminating reasoning_end, which carries the optional ephemeral provider signature.
  z.object({ type: z.literal('reasoning_start'), id: nonEmptyString }),
  z.object({ type: z.literal('reasoning_delta'), id: nonEmptyString, text: z.string() }),
  z.object({
    type: z.literal('reasoning_end'),
    id: nonEmptyString,
    signature: z.string().optional(),
    redacted: z.boolean().optional(),
  }),
  // A provider-executed (server-side) tool result carried inline (ADR-0030) — distinct from the
  // engine-executed tool_call_* triad. Reserved shape; the engine dispatcher records it, never runs it.
  z.object({
    type: z.literal('tool_result'),
    id: nonEmptyString,
    name: nonEmptyString,
    result: z.unknown(),
    isError: z.boolean().optional(),
    providerExecuted: z.literal(true),
  }),
  z.object({ type: z.literal('stop'), stopReason: StopReasonSchema, usage: UsageSchema }),
  z.object({ type: z.literal('error'), error: LlmErrorSchema }),
]);
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

/**
 * The provider seam itself. A behavioural interface (it carries methods), so it is not a Zod
 * schema. `key` is "the credential the implementation needs" — a resolved provider key on
 * Node-style hosts, a key reference on the desktop (Rust egress), a managed token in managed mode
 * (ADR-0018); the `string` type is identical across all of them.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  generate(req: LlmRequest, key: string): Promise<LlmResult>;
  stream(req: LlmRequest, key: string): AsyncIterable<StreamChunk>;
  readonly supports: CapabilityFlags;
}
