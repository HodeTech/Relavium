import { mediaSupportReason } from '../capabilities.js';
import { UnsupportedCapabilityError } from '../errors.js';
import { LlmMessageSchema } from '../types.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from '../types.js';

/**
 * Shared helpers for the provider adapters — the platform-coupled zone (`src/adapters/*`) that may
 * reference host globals. Kept here so AbortSignal handling lives in one place across the adapters.
 */

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/**
 * The per-modality media capability gate (1.AE/1.AF). Every adapter calls this at `generate()`/`stream()`
 * entry, AFTER `assertSupported` and `assertStreamable`. An unsupported modality is thrown as
 * `UnsupportedCapabilityError('media')` with a specific detail string — NEVER silently dropped or
 * flattened (the §1.4 bug class this guard exists to block). DeepSeek's all-false matrix causes every
 * media part to be rejected.
 *
 * Order is deliberate and load-bearing: each message is validated through `LlmMessageSchema` FIRST to
 * activate the superRefine guards (media ceiling/caps, URL gate, MIME-type validation, anti-amplification
 * caps) — so an unknown MIME or an over-ceiling inline payload is a `ZodError` (schema-level), not a
 * capability error. Only then is the per-modality / output-combination gate applied, via the ONE shared
 * {@link mediaSupportReason} predicate that the `FallbackChain` pre-skip (`supportsRequest`) also uses —
 * so the pre-skip verdict can never disagree with this adapter throw. The schema re-parse is
 * O(history-length) per call — deliberately accepted (LLM round-trips dominate; it is the sole seam-side
 * enforcement point).
 */
export function assertMediaCapabilities(
  provider: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
): void {
  for (const message of req.messages) {
    LlmMessageSchema.parse(message);
  }
  const reason = mediaSupportReason(supports, req);
  if (reason !== null) {
    throw new UnsupportedCapabilityError(provider, 'media', reason);
  }
}

/**
 * Reject a non-text `outputModalities` on the STREAMING path (1.AG/[ADR-0046] §4). Inline media-out is
 * delivered ONLY through `generate()` (the in-flight base64 rides `LlmResult.content`); the streaming media
 * triad (`media_start`/`media_delta`/`media_end`) is host-deferred to 1.AH, and the streaming folds drop a
 * provider's media parts — so a `stream()` that requested media output would SILENTLY lose it. Fail loud
 * here instead. The engine routes a media-output turn to `generate()`, so this never fires on the run path;
 * it is a defensive guard for a direct seam consumer. Call it at `stream()` entry, after the media gate.
 */
export function assertNoStreamingMediaOutput(provider: ProviderId, req: LlmRequest): void {
  if (req.outputModalities?.some((modality) => modality !== 'text') === true) {
    throw new UnsupportedCapabilityError(
      provider,
      'media',
      'streaming media output is unsupported — inline media-out is delivered via generate() (ADR-0046 §4)',
    );
  }
}

/**
 * The single-track reasoning-channel id used by the OpenAI/DeepSeek and Gemini streaming folds — those
 * providers emit one reasoning block per response (no concurrent tracks). A provider that interleaves
 * multiple reasoning streams must move to an index-keyed id like the Anthropic adapter (`reasoning-${index}`).
 */
export const REASONING_ID = 'reasoning-0';
