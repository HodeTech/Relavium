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
