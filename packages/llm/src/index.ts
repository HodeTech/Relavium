/**
 * `@relavium/llm` public surface — the frozen `LLMProvider` seam (ADR-0011). Curated, not
 * `export *`: only the seam contract is public. Provider adapters (1.C/1.G/1.H), the
 * `FallbackChain` runner (1.K), and the `CostTracker` (1.B) extend this surface as they land.
 */

export {
  ProviderIdSchema,
  ToolDefSchema,
  LlmRoleSchema,
  LlmMessageSchema,
  ToolChoiceSchema,
  UsageSchema,
  MediaUnitsEntrySchema,
  CapabilityFlagsSchema,
  MediaCapabilitiesSchema,
  ModalitySetSchema,
  LlmErrorKindSchema,
  LlmErrorSchema,
  ResponseFormatSchema,
  LlmRequestSchema,
  LlmResultSchema,
  StreamChunkSchema,
  MediaGenRequestSchema,
  MediaGenResultSchema,
  MediaJobStatusSchema,
} from './types.js';

export type {
  ProviderId,
  ToolDef,
  LlmRole,
  LlmMessage,
  ToolChoice,
  Usage,
  MediaUnitsEntry,
  CapabilityFlags,
  MediaCapabilities,
  ModalitySet,
  LlmErrorKind,
  LlmError,
  ResponseFormat,
  LlmRequest,
  LlmResult,
  StreamChunk,
  MediaGenRequest,
  MediaGenResult,
  MediaJobStatus,
  LlmProvider,
} from './types.js';

// The shared-owned seam substrate, re-exported so callers import it from the seam (single
// canonical home — `@relavium/shared` owns it; the dependency direction is `shared → llm`).
// The media shapes (ADR-0031, 1.AD) live in `@relavium/shared/src/content.ts` for the same reason.
export {
  ContentPartSchema,
  StopReasonSchema,
  DurableContentPartSchema,
  MediaPartSchema,
  DurableMediaPartSchema,
  MediaSourceSchema,
  DurableMediaSourceSchema,
  INLINE_MEDIA_CEILING,
  MEDIA_MESSAGE_CAPS,
  MEDIA_URL_SOURCE_ENABLED,
  MEDIA_HANDLE_PATTERN,
  MEDIA_MODALITIES,
  MediaMimeTypeSchema,
  OUTPUT_MODALITIES,
  MEDIA_BILLED_MODALITIES,
  mediaModalityOf,
  decodedBase64ByteLength,
  containsInlineMediaBytes,
  refineInFlightMediaPart,
  persistableMediaRefine,
} from '@relavium/shared';
export type {
  ContentPart,
  StopReason,
  AbortSignalLike,
  DurableContentPart,
  MediaPart,
  DurableMediaPart,
  MediaSource,
  DurableMediaSource,
  MediaModality,
  OutputModality,
  MediaBilledModality,
  MediaStore,
  DeInlineMedia,
} from '@relavium/shared';

// Typed config/validation errors (1.B/1.E/1.D).
export {
  LlmConfigError,
  UnknownModelError,
  ToolSchemaError,
  UnsupportedCapabilityError,
  InvalidBaseUrlError,
} from './errors.js';
export type { LlmConfigErrorCode } from './errors.js';

// Capability gating + the providerOptions escape hatch (1.D).
export {
  requiredCapabilities,
  supportsRequest,
  assertSupported,
  assertStreamable,
} from './capabilities.js';
export type { Capability } from './capabilities.js';

// LlmError classification — the fallback contract (1.I).
export {
  RETRYABLE_KINDS,
  isRetryable,
  kindFromHttpStatus,
  makeLlmError,
  LlmProviderError,
} from './llm-error.js';

// CostTracker + the canonical model-pricing table (1.B).
export { MODEL_PRICING, KNOWN_MODEL_IDS } from './pricing.js';
export type { ModelPricing, CanonicalModelId } from './pricing.js';
export { priceModel, cost, mediaCost, CostTracker } from './cost-tracker.js';
export type { CostUpdate } from './cost-tracker.js';
export { estimateMaxNextCost, estimateMediaCost } from './budget-estimator.js';
export type { MediaUnitsEstimate } from './budget-estimator.js';

// FallbackChain runner — fallback policy outside the adapters (1.K).
export { FallbackChain, withFallback, stripReasoningParts } from './fallback-chain.js';
export type {
  FallbackPlanEntry,
  FallbackChainOptions,
  AttemptRecord,
  AttemptOutcome,
  BackoffStrategy,
  PreAttemptHook,
} from './fallback-chain.js';

// ToolNormalizer (1.E).
export {
  toWire,
  reshapeForGemini,
  GeminiToolCallIds,
  normalizeToolCall,
} from './tool-normalizer.js';
export type {
  ToolWire,
  OpenAiToolWire,
  AnthropicToolWire,
  GeminiToolWire,
} from './tool-normalizer.js';
