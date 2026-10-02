import { mediaModalityOf, type ContentPart, type MediaPart } from '@relavium/shared';

import type { EstimateTokensInput } from './types.js';

export const CHARS_PER_TOKEN = 4;
const MESSAGE_ENVELOPE_TOKENS = 2;

/**
 * ADR-0096 fixed per-part charges; sources/derivations and undercount limits have one home in
 * docs/reference/shared-core/llm-provider-seam.md. Image: 2,833 + 8 × 5,667 (GPT-4o mini).
 * Document/audio/video: disclosed assumptions (ten pages / ten minutes), NOT provider bounds.
 */
export const MEDIA_INPUT_TOKENS = Object.freeze({
  image: 48_169,
  document: 80_000,
  audio: 20_000,
  video: 200_000,
});

/** Finite conservative fallback per unserialisable unit; equivalent to 4 Mi serialized characters. */
export const UNSERIALIZABLE_INPUT_TOKENS = 1_048_576;

function serializedTokens(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? UNSERIALIZABLE_INPUT_TOKENS
      : Math.ceil(serialized.length / CHARS_PER_TOKEN);
  } catch {
    // Charge this unit and retain every other contribution. Never expose opaque values/errors.
    return UNSERIALIZABLE_INPUT_TOKENS;
  }
}

function mediaTokens(part: MediaPart): number {
  try {
    const modality = mediaModalityOf(part.mimeType);
    return modality === undefined ? UNSERIALIZABLE_INPUT_TOKENS : MEDIA_INPUT_TOKENS[modality];
  } catch {
    return UNSERIALIZABLE_INPUT_TOKENS;
  }
}

function partTokens(part: ContentPart): number {
  try {
    if (part.type === 'media') return mediaTokens(part);
    if (part.type === 'tool_result') {
      // Only this typed media position is exempt. Media-looking objects inside args/result are
      // ordinary opaque data and keep their complete serialized-length floor.
      const { media, ...body } = part;
      return (
        serializedTokens(body) + (media ?? []).reduce((sum, item) => sum + mediaTokens(item), 0)
      );
    }
    return serializedTokens(part);
  } catch {
    // Also cover throwing accessors/proxies during inspection, before JSON serialization begins.
    return UNSERIALIZABLE_INPUT_TOKENS;
  }
}

/**
 * Pure current-request heuristic used for live context decisions and input pricing (ADR-0096).
 * Every non-media part/tool gets its serialized-length/4 floor; media encoding length is excluded.
 * It does not bound provider tokenization, custom-endpoint image costs, PDF pages or clip duration.
 */
export function estimateRequestTokens(input: EstimateTokensInput): number {
  let tokens = Math.ceil(input.system.length / CHARS_PER_TOKEN);
  for (const message of input.messages) {
    tokens += MESSAGE_ENVELOPE_TOKENS;
    for (const part of message.content) tokens += partTokens(part);
  }
  for (const tool of input.tools ?? []) tokens += serializedTokens(tool);
  return tokens;
}
