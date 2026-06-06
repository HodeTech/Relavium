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
  CapabilityFlagsSchema,
  LlmErrorKindSchema,
  LlmErrorSchema,
  LlmRequestSchema,
  LlmResultSchema,
  StreamChunkSchema,
} from './types.js';

export type {
  ProviderId,
  ToolDef,
  LlmRole,
  LlmMessage,
  ToolChoice,
  Usage,
  CapabilityFlags,
  LlmErrorKind,
  LlmError,
  LlmRequest,
  LlmResult,
  StreamChunk,
  LlmProvider,
} from './types.js';

// The shared-owned seam substrate, re-exported so callers import it from the seam (single
// canonical home — `@relavium/shared` owns it; the dependency direction is `shared → llm`).
export { ContentPartSchema, StopReasonSchema } from '@relavium/shared';
export type { ContentPart, StopReason, AbortSignalLike } from '@relavium/shared';

// Typed config/validation errors (1.B/1.E).
export { LlmConfigError, UnknownModelError, ToolSchemaError } from './errors.js';
export type { LlmConfigErrorCode } from './errors.js';

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
export { priceModel, cost, CostTracker } from './cost-tracker.js';
export type { CostUpdate } from './cost-tracker.js';

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
