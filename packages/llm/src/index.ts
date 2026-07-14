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
// The hand-typed price table is GONE from this surface (ADR-0071 §1), and so are the id guards it fed:
// `MODEL_PRICING`, `KNOWN_MODEL_IDS`, `isCanonicalModelId`, `CanonicalModelId`, and `modelSupportsReasoning`.
//
// `isCanonicalModelId` asked "is this one of OUR models". The honest question is "can we price this one", and a
// user-priced model is perfectly billable while never having been canonical — `priceModel`'s own throw answers it.
// `modelSupportsReasoning` asked "does this model reason", which is not the question the wire asks at all
// (`gpt-5.4-pro` reasons AND rejects `low`); `effortTiersFor` is the answer.
//
// `ModelPricing` survives as the CONTRACT — the CostTracker bills against it and a `models pricing` row IS one.
export { contextWindowForModel } from './pricing.js';
export type { ModelPricing } from './pricing.js';
// The pure live/static/user merge helper (ADR-0064 §6) — reused by every surface's model catalog / picker.
export { collapseAliasDatedPinPairs, datedPinBase, mergeModelCatalog } from './model-catalog.js';
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
export { catalogModel, effortTiersFor, modelAccepts } from './catalog/lookup.js';
// The generated snapshot itself + its pricing projection (ADR-0071 §1) — what `MODEL_PRICING` used to be.
export { CATALOG_SNAPSHOT } from './catalog/snapshot.js';
export { catalogPricing, toPricing, pricedModelIds } from './catalog/pricing.js';
// The refresh seam (ADR-0071 §4): the HOST fetches models.dev and installs the result; `@relavium/llm` does no I/O.
// Additive only — the shipped snapshot is the floor, so a bad payload degrades to it rather than to a blank catalog.
export { installCatalogRefresh, clearCatalogRefresh, catalogModelIds } from './catalog/lookup.js';
export { CATALOG_PROVIDER_KEYS } from './catalog/catalog-providers.js';
export { normalizeCatalog, ModelsDevPayloadSchema } from './catalog/models-dev-schema.js';
export type {
  CatalogModel,
  CatalogPriceTier,
  ReasoningControls,
  RequestCapabilities,
} from './catalog/catalog-model.js';
export {
  acceptedTiers,
  canDisableReasoning,
  openAiWireValue,
  reasoningControlShape,
  reasoningWithheldByCap,
  wireValueFor,
  CANONICAL_ON_TIER,
} from './reasoning-wire.js';
// The output cap (ADR-0071 §7) — an authored `max_tokens` held at or below the model's real ceiling. Exported
// because the PRE-EGRESS ESTIMATE must be computed from the same number the wire will carry: a governor that
// pre-authorizes spend on tokens the model is physically incapable of producing kills runs over phantom money.
export { cappedMaxTokens } from './output-cap.js';
export type { EndpointKind } from './output-cap.js';
