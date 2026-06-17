import { mediaModalityOf } from '@relavium/shared';

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
 * Gate every media part and tool_result media attachment against the provider's input modality
 * capabilities (1.AE, ADR-0031). Throws `UnsupportedCapabilityError` on the first violation.
 */
function gateInputModalities(
  provider: ProviderId,
  inputCaps: CapabilityFlags['media']['input'],
  messages: LlmRequest['messages'],
): void {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'media') {
        gateModality(provider, inputCaps, part.mimeType);
      }
      if (part.type === 'tool_result' && part.media !== undefined && part.media.length > 0) {
        for (const mediaPart of part.media) {
          gateModality(provider, inputCaps, mediaPart.mimeType, ' in tool_result');
        }
      }
    }
  }
}

function gateModality(
  provider: ProviderId,
  inputCaps: Record<string, boolean>,
  mimeType: string,
  suffix: string = '',
): void {
  const modality = mediaModalityOf(mimeType);
  if (modality === undefined) {
    throw new UnsupportedCapabilityError(
      provider,
      'media',
      `unsupported MIME type '${mimeType}'${suffix}`,
    );
  }
  if (!inputCaps[modality]) {
    throw new UnsupportedCapabilityError(
      provider,
      'media',
      `input modality '${modality}' (${mimeType})${suffix} not supported`,
    );
  }
}

/**
 * Gate output modalities by MEMBERSHIP in `media.outputCombinations` (ADR-0031 decision #3).
 * A request for `['text', 'audio']` is valid only if some output combination contains both.
 */
function gateOutputCombinations(
  provider: ProviderId,
  supports: CapabilityFlags,
  outputModalities: LlmRequest['outputModalities'],
): void {
  if (outputModalities === undefined) return;
  const nonText = outputModalities.filter((modality) => modality !== 'text');
  if (nonText.length === 0) return;
  const outputOk = supports.media.outputCombinations.some((combo) =>
    nonText.every((modality) => combo.includes(modality)),
  );
  if (!outputOk) {
    throw new UnsupportedCapabilityError(
      provider,
      'media',
      `output modalities [${nonText.join(', ')}] not in any supported output combination`,
    );
  }
}

/**
 * The per-modality media capability gate (1.AE). Every adapter calls this at `generate()`/`stream()`
 * entry, AFTER `assertSupported` and `assertStreamable`, so there is never a cap-less window between
 * the ADR-0031 shape landing and the per-modality wiring. An unsupported modality is thrown as
 * `UnsupportedCapabilityError('media')` with a specific detail string — NEVER silently dropped or
 * flattened (the §1.4 bug class this guard exists to block). DeepSeek's all-false matrix causes
 * every media part to be rejected identically to the old blanket `assertNoMediaRequested`.
 *
 * First, each message is validated through `LlmMessageSchema` to activate the superRefine
 * guards (media ceiling/caps, URL gate, MIME type validation, anti-amplification caps) — defense-in-depth
 * so requests that bypass the engine's own validation are still caught at the seam.
 */
export function assertMediaCapabilities(
  provider: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
): void {
  for (const message of req.messages) {
    LlmMessageSchema.parse(message);
  }
  gateInputModalities(provider, supports.media.input, req.messages);
  gateOutputCombinations(provider, supports, req.outputModalities);
}

/**
 * The single-track reasoning-channel id used by the OpenAI/DeepSeek and Gemini streaming folds — those
 * providers emit one reasoning block per response (no concurrent tracks). A provider that interleaves
 * multiple reasoning streams must move to an index-keyed id like the Anthropic adapter (`reasoning-${index}`).
 */
export const REASONING_ID = 'reasoning-0';
