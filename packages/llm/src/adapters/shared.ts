import type { LlmMessage, ProviderId } from '../types.js';
import { UnsupportedCapabilityError } from '../errors.js';

/**
 * Shared helpers for the provider adapters — the platform-coupled zone (`src/adapters/*`) that may
 * reference host globals. Kept here so AbortSignal handling lives in one place across the adapters.
 */

/** True for a real `AbortSignal` (the host passes one; it structurally satisfies AbortSignalLike). */
export function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof AbortSignal !== 'undefined' && value instanceof AbortSignal;
}

/**
 * Fail fast on media content until the input wiring lands (1.AE). The ADR-0031 shape landed at
 * 1.AD with every adapter's `supports.media` honestly all-false, so media reaching an adapter — a
 * `media` part with ANY carrier, or a `tool_result` carrying typed `media` attachments (which the
 * request builders would otherwise drop on the floor) — is an unsupported request: thrown as the
 * same typed error the capability gate uses, NEVER silently dropped/flattened (the §1.4
 * silent-flatten bug class this guard exists to block). One shared pre-flight pass so all three
 * adapters reject identically; removed per adapter as 1.AE wires real media input.
 */
export function assertNoMediaParts(provider: ProviderId, messages: readonly LlmMessage[]): void {
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'media') {
        throw new UnsupportedCapabilityError(provider, 'media');
      }
      if (part.type === 'tool_result' && part.media !== undefined && part.media.length > 0) {
        throw new UnsupportedCapabilityError(provider, 'media');
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
