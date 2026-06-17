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
 *
 * The output modality check validates MEMBERSHIP in `media.outputCombinations` (ADR-0031 decision #3):
 * a request for `['text', 'audio']` is valid only if the provider's output Combinations include a set
 * that **contains** both `text` and `audio` — independent booleans would advertise wire-invalid combos.
 */
export function assertMediaCapabilities(
  provider: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
): void {
  // 0. Activate the Zod-level superRefine guards (media ceiling/caps, URL gate, MIME, anti-amp caps).
  for (const message of req.messages) {
    LlmMessageSchema.parse(message);
  }

  const inputCaps = supports.media.input;

  // 1. Gate input modalities — every media part and tool_result media attachment
  for (const message of req.messages) {
    for (const part of message.content) {
      if (part.type === 'media') {
        const modality = mediaModalityOf(part.mimeType);
        if (modality === undefined) {
          throw new UnsupportedCapabilityError(
            provider,
            'media',
            `unsupported MIME type '${part.mimeType}'`,
          );
        }
        if (!inputCaps[modality]) {
          throw new UnsupportedCapabilityError(
            provider,
            'media',
            `input modality '${modality}' (${part.mimeType}) not supported`,
          );
        }
      }
      if (part.type === 'tool_result' && part.media !== undefined && part.media.length > 0) {
        for (const mediaPart of part.media) {
          const modality = mediaModalityOf(mediaPart.mimeType);
          if (modality === undefined) {
            throw new UnsupportedCapabilityError(
              provider,
              'media',
              `unsupported MIME type '${mediaPart.mimeType}' in tool_result attachment`,
            );
          }
          if (!inputCaps[modality]) {
            throw new UnsupportedCapabilityError(
              provider,
              'media',
              `input modality '${modality}' (${mediaPart.mimeType}) in tool_result not supported`,
            );
          }
        }
      }
    }
  }

  // 2. Gate output modalities — membership check against outputCombinations
  if (req.outputModalities !== undefined) {
    const nonText = req.outputModalities.filter((modality) => modality !== 'text');
    if (nonText.length > 0) {
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
  }
}

/**
 * The single-track reasoning-channel id used by the OpenAI/DeepSeek and Gemini streaming folds — those
 * providers emit one reasoning block per response (no concurrent tracks). A provider that interleaves
 * multiple reasoning streams must move to an index-keyed id like the Anthropic adapter (`reasoning-${index}`).
 */
export const REASONING_ID = 'reasoning-0';
