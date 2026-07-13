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
  // ADR-0064 live model catalog — the seam's live-discovery projection (no vendor type crosses).
  ModelListingSchema,
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
  // ADR-0062 context-compaction: the seam input to LlmProvider.estimateTokens.
  EstimateTokensInput,
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
  // ADR-0064 — the live model-discovery entry returned by LlmProvider.listModels?.
  ModelListing,
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
  // ADR-0064 — the provider `kind` protocol vocabulary (shared-owned; the seam surfaces it here).
  PROVIDER_KINDS,
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
  ProviderKind,
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
  isOutputCombinationSupported,
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
// `modelSupportsReasoning` is GONE from this surface (ADR-0071 §6). It answered "does this model reason" — an id
// heuristic over the hand-typed table — and that is not the question the wire asks: `gpt-5.4-pro` reasons AND
// rejects `low`. It disagreed with the catalog on sixteen shipped models, and every disagreement was a tier shown
// or accepted that the wire then dropped. `effortTiersFor` (below) is the one answer.
export {
  MODEL_PRICING,
  KNOWN_MODEL_IDS,
  isCanonicalModelId,
  contextWindowForModel,
} from './pricing.js';
export type { ModelPricing, CanonicalModelId } from './pricing.js';
// The pure live/static/user merge helper (ADR-0064 §6) — reused by every surface's model catalog / picker.
export { mergeModelCatalog } from './model-catalog.js';
export type { ModelCatalogEntry, MergeModelCatalogInput, PricingSource } from './model-catalog.js';
export { priceModel, cost, mediaCost, CostTracker } from './cost-tracker.js';
export type { CostUpdate, PricingOverlay } from './cost-tracker.js';
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

// Default keyless provider registry — the provider→adapter mapping a host wires into
// `resolveProvider` (ADR-0038); the key is injected per call via `keyFor`, never here (ADR-0011).
// `providerKind` derives the ADR-0064 protocol `kind` from a provider id (used by the later merge/refresh steps).
// `createCustomOpenAiProvider` builds a per-provider OpenAI-compatible adapter for a custom base_url (ADR-0065 §3, S9).
export { createCustomOpenAiProvider, defaultProviders, providerKind } from './providers.js';

// --- The generated model catalog (ADR-0071) ------------------------------------------------
// The reasoning CONTROL is per-model data now, not a per-adapter assumption. The host projects a model's
// ACCEPTED TIERS from it (`resolveEffortTiers`), so a tier the model would reject never reaches the wire.
export { catalogModel, effortTiersFor } from './catalog/lookup.js';
export type { CatalogModel, CatalogPriceTier, ReasoningControls } from './catalog/catalog-model.js';
export { acceptedTiers, canDisableReasoning } from './reasoning-wire.js';
