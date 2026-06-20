import type { JSONSchema7 } from 'json-schema';
import { z } from 'zod';

import {
  containsInlineMediaBytes,
  ContentPartSchema,
  DurableMediaPartSchema,
  LLM_PROVIDERS,
  MEDIA_BILLED_MODALITIES,
  MEDIA_SURFACES,
  MEDIA_HANDLE_PATTERN,
  MEDIA_MESSAGE_CAPS,
  MediaMimeTypeSchema,
  MediaPartSchema,
  OUTPUT_MODALITIES,
  refineInFlightMediaPart,
  StopReasonSchema,
} from '@relavium/shared';
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

export const LlmMessageSchema = z
  .object({
    role: LlmRoleSchema,
    content: z.array(ContentPartSchema),
  })
  // The seam ingestion boundary for media (ADR-0031): the per-part ceiling / url landing gate /
  // modality rules, the per-message count + aggregate-decoded-bytes anti-amplification caps, and
  // the no-raw-bytes-in-`tool_result.result` rule are all enforced HERE — request-side — so there
  // is no cap-less window between the shape landing (1.AD) and capability-gating (1.AF). Result
  // content is deliberately not ceiling-bounded (a generated image legitimately exceeds it
  // in flight; the engine de-inlines it before anything durable).
  .superRefine((message, ctx) => {
    let mediaPartCount = 0;
    let inlineMediaBytes = 0;
    message.content.forEach((part, index) => {
      if (part.type === 'media') {
        mediaPartCount += 1;
        inlineMediaBytes += refineInFlightMediaPart(part, ctx, ['content', index]);
        return;
      }
      if (part.type === 'tool_result' && containsInlineMediaBytes(part.result)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'raw media bytes are forbidden inside tool_result.result — attach handle-only parts via tool_result.media instead (ADR-0031)',
          path: ['content', index, 'result'],
        });
      }
    });
    if (mediaPartCount > MEDIA_MESSAGE_CAPS.maxPartsPerMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a message may carry at most ${MEDIA_MESSAGE_CAPS.maxPartsPerMessage} media parts (got ${mediaPartCount})`,
        path: ['content'],
      });
    }
    if (inlineMediaBytes > MEDIA_MESSAGE_CAPS.maxInlineBytesPerMessage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a message may carry at most ${MEDIA_MESSAGE_CAPS.maxInlineBytesPerMessage} decoded inline media bytes in total (got ${inlineMediaBytes})`,
        path: ['content'],
      });
    }
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

/**
 * One per-modality media usage record (ADR-0031 decision #4). A DISJOINT observability+billing
 * axis: media bills per-image / per-second, NOT in tokens, so — unlike `reasoningTokens` — there
 * is deliberately no refine tying it to the token counts. `modality` is the deliberately complete
 * media-billed closed set (`document`/PDF and text bill as tokens, so they are excluded, not
 * forgotten). Doubles as the managed-mode metering record: counts, never content.
 */
export const MediaUnitsEntrySchema = z.object({
  modality: z.enum(MEDIA_BILLED_MODALITIES),
  direction: z.enum(['input', 'output']),
  units: nonNegativeInt, // images, audio-seconds, video-seconds — the provider's billed unit
  unit: z.enum(['count', 'second']),
});
export type MediaUnitsEntry = z.infer<typeof MediaUnitsEntrySchema>;

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
    // Media usage (ADR-0031) — an extra disjoint axis, never folded into the token counts.
    mediaUnits: z.array(MediaUnitsEntrySchema).optional(),
    costMicrocents: nonNegativeInt.optional(),
  })
  // Enforce the ADR-0030 invariant: reasoning is a SUBSET of output, never larger. Catches an adapter
  // that mis-maps the reasoning count (the seam's contract, not a billing input).
  .refine((u) => u.reasoningTokens === undefined || u.reasoningTokens <= u.outputTokens, {
    message: 'reasoningTokens must be ≤ outputTokens (reasoning is counted inside output)',
    path: ['reasoningTokens'],
  });
export type Usage = z.infer<typeof UsageSchema>;

/**
 * One **modality-set** a model can emit in a single turn (ADR-0031 decision #3) — an element of
 * `media.outputCombinations`. Output capability is a per-model COMBINATION constraint, not a
 * product of independent booleans: Gemini's `responseModalities` is a closed set per model
 * (image-gen accepts `['text','image']` and rejects audio; native-audio TTS accepts `['audio']`
 * alone), so independent booleans would advertise wire-invalid combinations.
 */
export const ModalitySetSchema = z.array(z.enum(OUTPUT_MODALITIES));
export type ModalitySet = z.infer<typeof ModalitySetSchema>;

/**
 * The per-modality media capability matrix (ADR-0031 decision #3). Input composability is
 * unconstrained (a turn may carry image + audio + text together), so input stays per-modality
 * booleans; `document` gates `application/pdf` DISTINCTLY from `image` (A2). Output is the closed
 * set of emittable modality-sets; `[]` = no media output (Anthropic, DeepSeek).
 * `requiredCapabilities()` gains the input check + the `outputCombinations` MEMBERSHIP check at
 * 1.AF — until then the matrix is shape, honestly all-false/empty (the real values land with the
 * input wiring, 1.AE).
 */
export const MediaCapabilitiesSchema = z.object({
  input: z.object({
    image: z.boolean(),
    audio: z.boolean(),
    video: z.boolean(),
    document: z.boolean(), // application/pdf (A2) — distinct token/cost profile from image
  }),
  outputCombinations: z.array(ModalitySetSchema),
  // The model's media-output SURFACE (1.AG/ADR-0045 §1): `'chat'` routes an agent node to the normal
  // turn with `output_modalities`; `'generative'` routes it to the separate-endpoint `generateMedia()`
  // (sync or async LRO). The seam projection of `model_catalog.media_surface`. **Absent ⇒ `'chat'`** (the
  // column's NOT NULL default + the read-site `?? 'chat'`); optional so a CapabilityFlags literal that
  // predates routing stays valid. `surface` is a per-MODEL catalog property, not an adapter capability — the
  // OpenAI adapter implements sync `generateMedia` (gpt-image-1 image, 1.AG Section C), yet its capability
  // surface here is still `'chat'`; which models route generative is catalog state, not an adapter flag.
  surface: z.enum(MEDIA_SURFACES).optional(),
});
export type MediaCapabilities = z.infer<typeof MediaCapabilitiesSchema>;

/** What a provider supports; features off the common path are reached via `providerOptions`. */
export const CapabilityFlagsSchema = z
  .object({
    tools: z.boolean(),
    streaming: z.boolean(),
    parallelToolCalls: z.boolean(),
    // TEMPORARY derived alias of `media.input.image` (ADR-0031) — kept for live consumers
    // (`db.supports_vision`, adapter `supports.vision`); scheduled for removal once they migrate.
    // The refine below pins the alias so the two cannot drift.
    vision: z.boolean(),
    promptCache: z.boolean(),
    reasoning: z.boolean(),
    media: MediaCapabilitiesSchema,
  })
  .refine((flags) => flags.vision === flags.media.input.image, {
    message: 'vision is a derived alias of media.input.image — the two must not drift (ADR-0031)',
    path: ['vision'],
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

/**
 * Host-injected cancellation; the raw key/transport is host-aware (ADR-0018), the type is not.
 * Validated structurally so a non-signal value is rejected at the seam, not later when it is
 * observed. Shared by `LlmRequest` and the reserved `MediaGenRequest` (ADR-0031).
 */
const abortSignalLikeSchema = z.custom<AbortSignalLike>(
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
);

/** The normalized, provider-agnostic request. `system` is always one top-level field. */
export const LlmRequestSchema = z.object({
  model: nonEmptyString, // canonical model id, mapped per adapter
  system: z.string().optional(),
  messages: z.array(LlmMessageSchema),
  tools: z.array(ToolDefSchema).optional(),
  toolChoice: ToolChoiceSchema.optional(),
  responseFormat: ResponseFormatSchema.optional(), // structured-output request (ADR-0030)
  // Request non-text output on the INLINE path (chat-surface models), default ['text'] —
  // the symmetric mechanism to responseFormat (ADR-0031 decision #5). Validated for MEMBERSHIP in
  // `media.outputCombinations` by requiredCapabilities() at 1.AF. The one exception: OpenAI
  // image-out routes through the Responses `image_generation` BUILT-IN TOOL (the providerExecuted
  // arm), never through this field; separate-endpoint generators use generateMedia() instead.
  outputModalities: z.array(z.enum(OUTPUT_MODALITIES)).optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().positive().optional(), // required downstream for Anthropic — adapters default it
  stopSequences: z.array(z.string()).optional(),
  signal: abortSignalLikeSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(), // typed escape hatch
});
export type LlmRequest = z.infer<typeof LlmRequestSchema>;

/**
 * The normalized non-streaming result. A media-only turn reports `stopReason: 'stop'` — the
 * presence of a `media` part in `content` is the signal, deliberately NOT a new StopReason
 * (ADR-0031 decision #8: closed enum, breaking to extend, and consumers must inspect `content`
 * anyway). Result content may carry over-ceiling in-flight media (a generated image) — the engine
 * de-inlines it at the seam return, before anything durable.
 */
export const LlmResultSchema = z
  .object({
    content: z.array(ContentPartSchema), // text + any tool_call/media parts
    stopReason: StopReasonSchema,
    usage: UsageSchema,
    // INTERNAL diagnostic only — the raw provider response, for debugging / the escape hatch.
    // Never log, serialize, checkpoint, or put it in a run event: any sink must strip `raw` first
    // (the same rule as LlmError.cause). From 1.AE/1.AG on it is the highest-volume media-bytes
    // carrier (vendor b64_json / inlineData), and VENDOR shapes inside it are invisible to the
    // canonical-shape backstop scans — stripping at the sink is the only guarantee.
    raw: z.unknown(),
  })
  // Raw media bytes are forbidden inside the opaque tool_result.result on the way OUT too — a
  // provider-executed image-gen result must be normalized into a typed media part, never smuggled
  // through z.unknown() where the de-inline pass and the refines cannot reach it (ADR-0031 #7).
  .superRefine((result, ctx) => {
    result.content.forEach((part, index) => {
      if (part.type === 'tool_result' && containsInlineMediaBytes(part.result)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'raw media bytes are forbidden inside tool_result.result — normalize them into a typed media part (ADR-0031)',
          path: ['content', index, 'result'],
        });
      }
    });
  });
export type LlmResult = z.infer<typeof LlmResultSchema>;

/**
 * The single discriminated chunk union every provider's stream is folded into. A union-level
 * superRefine backs the `tool_result` arm's no-raw-bytes rule, so the member list is read via
 * `.innerType().options` (the same pattern as `RunEventSchema`).
 */
export const StreamChunkSchema = z
  .discriminatedUnion('type', [
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
    // Media output channel (ADR-0031) — mirrors the tool_call_*/reasoning_* triads; `id` correlates
    // the deltas to the terminating media_end. NO base64 rides the normalized stream: media_delta
    // carries progress plus an optional partial-preview HANDLE, and media_end carries the finished
    // media as a handle-only durable part (the engine's de-inline boundary wrote the bytes to the
    // MediaStore). The raw desktop IPC path is ADR-0032's concern, not this union's.
    // mimeType shares the one bounded bare-MIME schema — every mimeType position does, so a
    // metadata field can never become the bytes channel the no-base64 stream rule forbids.
    z.object({ type: z.literal('media_start'), id: nonEmptyString, mimeType: MediaMimeTypeSchema }),
    z.object({
      type: z.literal('media_delta'),
      id: nonEmptyString,
      progress: z.number().min(0).max(1).optional(),
      // RESERVED, host-implementation-defined (A3): ships in the frozen triad so a later add is
      // non-breaking; unset by every adapter until a surface renders progressive previews (1.AH).
      partialRef: z
        .string()
        .regex(MEDIA_HANDLE_PATTERN, 'must be a media://sha256-<64hex> handle')
        .optional(),
    }),
    z.object({ type: z.literal('media_end'), id: nonEmptyString, media: DurableMediaPartSchema }),
    // A provider-executed (server-side) tool result carried inline (ADR-0030) — distinct from the
    // engine-executed tool_call_* triad. Reserved shape; the engine dispatcher records it, never runs
    // it. `media` carries any provider-generated media as typed handle-only parts (ADR-0031 #7).
    z.object({
      type: z.literal('tool_result'),
      id: nonEmptyString,
      name: nonEmptyString,
      result: z.unknown(),
      isError: z.boolean().optional(),
      providerExecuted: z.literal(true),
      media: z.array(DurableMediaPartSchema).optional(),
    }),
    z.object({ type: z.literal('stop'), stopReason: StopReasonSchema, usage: UsageSchema }),
    z.object({ type: z.literal('error'), error: LlmErrorSchema }),
  ])
  .superRefine((chunk, ctx) => {
    if (chunk.type === 'tool_result' && containsInlineMediaBytes(chunk.result)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'raw media bytes are forbidden inside tool_result.result — normalize them into a typed media part (ADR-0031)',
        path: ['result'],
      });
    }
  });
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

/**
 * The request for a separate-endpoint media generation (`media_surface: 'generative'` models —
 * gpt-image-1, Imagen, TTS, Sora, Veo). Seam shape defined at 1.AD (A5); the BEHAVIOR is WIRED at
 * 1.AG — sync `generateMedia` de-inline (Section C) + the engine-owned async poll/checkpoint/resume/
 * cancel loop (ADR-0045, Section D). Deliberately minimal: provider-specific generation knobs (voice,
 * aspect ratio, fps, …) ride `providerOptions`; conditioning-media inputs can be ADDED later (an
 * optional field is additive).
 */
export const MediaGenRequestSchema = z.object({
  model: nonEmptyString, // canonical model id, mapped per adapter
  prompt: nonEmptyString,
  modality: z.enum(MEDIA_BILLED_MODALITIES), // the artifact class to generate: image | audio | video
  mimeType: MediaMimeTypeSchema.optional(), // requested output format hint, e.g. 'image/png' — the one shared bare-MIME bound
  count: z.number().int().positive().optional(), // artifacts per call (image generators)
  durationSeconds: z.number().positive().optional(), // target duration (audio/video generators)
  signal: abortSignalLikeSchema.optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(), // typed escape hatch
});
export type MediaGenRequest = z.infer<typeof MediaGenRequestSchema>;

/**
 * What a `generateMedia` call resolves: a SYNC generator resolves `media` immediately (an
 * in-flight part — the engine de-inlines it to a handle before anything durable); an ASYNC
 * generator (Sora, Veo) resolves a **Relavium-opaque** `jobId` the engine polls — the adapter
 * mints the id and NEVER echoes the vendor operation-name across the seam (ADR-0031 decision #6).
 * Exactly one of the two is present.
 */
export const MediaGenResultSchema = z
  .object({
    media: MediaPartSchema.optional(),
    jobId: nonEmptyString.optional(),
    // INTERNAL diagnostic only — never log/serialize/persist; sinks strip it first (see
    // LlmResult.raw / LlmError.cause for the same binding rule).
    raw: z.unknown(),
  })
  .refine((result) => (result.media === undefined) !== (result.jobId === undefined), {
    message: 'exactly one of media (sync) or jobId (async) must be present',
    path: ['media'],
  });
export type MediaGenResult = z.infer<typeof MediaGenResultSchema>;

/**
 * One poll of an async media job (A5; the engine-owned poll/checkpoint/resume/cancel loop is wired at
 * 1.AG Section D, [ADR-0045](../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)).
 * `failed` carries the existing classified `LlmError` — a content-policy rejection maps to `content_filter`,
 * a deadline to the retryable `timeout` — so the job path reuses the one failure vocabulary instead of
 * inventing a second. The job path never uses StopReason.
 */
export const MediaJobStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), progress: z.number().min(0).max(1).optional() }),
  z.object({ state: z.literal('done'), media: MediaPartSchema }),
  z.object({ state: z.literal('failed'), error: LlmErrorSchema }),
]);
export type MediaJobStatus = z.infer<typeof MediaJobStatusSchema>;

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
  /**
   * Separate-endpoint media generation (`media_surface: 'generative'`), OPTIONAL on the one seam —
   * deliberately not a sibling `GenerativeMediaProvider` (that would duplicate the
   * id/key/capability/error/fallback registry). Shape at 1.AD; WIRED at 1.AG — the OpenAI adapter
   * implements SYNC image generation (Section C) and the engine owns the async poll/checkpoint/resume/
   * cancel loop (Section D, A5). The Sora/Veo/Imagen/TTS adapters are 1.AH host-wiring.
   */
  generateMedia?(req: MediaGenRequest, key: string): Promise<MediaGenResult>;
  /**
   * Poll an async media job by its Relavium-opaque id (A5, [ADR-0045](../../../docs/decisions/0045-async-media-job-loop-poll-checkpoint-resume-cancel.md)).
   * `signal` aborts the IN-FLIGHT poll so a run cancel reaches the open provider request, not just the
   * next schedule. The engine drives this loop (1.AG Section D); no Phase-1 vendor adapter implements it
   * yet (the async Sora/Veo adapters are 1.AH).
   */
  pollMediaJob?(jobId: string, key: string, signal?: AbortSignalLike): Promise<MediaJobStatus>;
}
