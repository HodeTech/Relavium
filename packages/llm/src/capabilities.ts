import { mediaModalityOf } from '@relavium/shared';

import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from './types.js';

/**
 * Capability gating (1.D, per-modality at 1.AF) — keeps the common path narrow and honest. A request
 * that needs a feature the provider can't do **fails fast with a typed error rather than being silently
 * dropped**. Provider-specific features with no cross-provider shape (prompt-cache control, thinking
 * budgets, parallel-tool-call toggles) travel through `LlmRequest.providerOptions`, not these flags; the
 * reasoning and media channels are canonical seam shape (ADR-0030/0031). See ADR-0011.
 */

/** One capability flag name. */
export type Capability = keyof CapabilityFlags;

/**
 * The NON-MEDIA capabilities a request requires, given the current request surface. Media is gated
 * per-modality by {@link mediaSupportReason} (it cannot be expressed as a flat `keyof CapabilityFlags`),
 * so it is intentionally absent here — `requiredCapabilities` covers only the flat-flag features
 * (today: `tools`). Streaming is checked separately at `stream()` entry ({@link assertStreamable}).
 */
export function requiredCapabilities(req: LlmRequest): Capability[] {
  const required: Capability[] = [];
  if (req.tools !== undefined && req.tools.length > 0) {
    required.push('tools');
  }
  return required;
}

/**
 * The per-modality media gate (1.AF, ADR-0031/0044) — the ONE shared predicate behind BOTH the
 * `FallbackChain` pre-skip ({@link supportsRequest}) and the adapter-entry `assertMediaCapabilities`,
 * so the pre-skip verdict can never disagree with the adapter throw (no admit-then-hard-fail). Pure,
 * no schema parse. Returns a specific reason string, or `null` if the provider can serve every media
 * part + the requested output combination.
 *
 * An UNKNOWN MIME type returns `null` (not a reason): an unknown MIME is a *schema* concern that
 * `LlmMessageSchema`/`MediaMimeTypeSchema` rejects as a `ZodError` at the adapter entry — so the
 * capability predicate judges only known modalities against the flags and never preempts that schema
 * error (it would also pass the pre-skip, where the un-rehosted request fails the adapter's schema gate).
 */
export function mediaSupportReason(supports: CapabilityFlags, req: LlmRequest): string | null {
  const inputCaps = supports.media.input;
  for (const message of req.messages) {
    const reason = messageMediaReason(inputCaps, message);
    if (reason !== null) return reason;
  }
  return outputCombinationReason(supports, req.outputModalities);
}

/** The first unsupported-modality reason in one message's content (its media + tool_result media), or null. */
function messageMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  message: LlmRequest['messages'][number],
): string | null {
  for (const part of message.content) {
    const reason = partMediaReason(inputCaps, part);
    if (reason !== null) return reason;
  }
  return null;
}

/** The unsupported-modality reason for ONE content part — its own media, or a tool_result's media. */
function partMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  part: LlmRequest['messages'][number]['content'][number],
): string | null {
  if (part.type === 'media') {
    return mediaInputReason(inputCaps, part.mimeType);
  }
  // Array.isArray (not `!== undefined`): a null `media` from parsed JSON would otherwise throw on iterate.
  if (part.type === 'tool_result' && Array.isArray(part.media)) {
    return toolResultMediaReason(inputCaps, part.media);
  }
  return null;
}

/** The first unsupported-modality reason among a `tool_result`'s attached media parts, or null. */
function toolResultMediaReason(
  inputCaps: CapabilityFlags['media']['input'],
  media: readonly { readonly mimeType: string }[],
): string | null {
  for (const mediaPart of media) {
    const reason = mediaInputReason(inputCaps, mediaPart.mimeType, ' in tool_result');
    if (reason !== null) return reason;
  }
  return null;
}

/** A single media input part's modality vs the provider's input flags. Unknown MIME ⇒ `null` (schema's job). */
function mediaInputReason(
  inputCaps: CapabilityFlags['media']['input'],
  mimeType: string,
  suffix: string = '',
): string | null {
  const modality = mediaModalityOf(mimeType);
  if (modality === undefined) return null;
  if (!inputCaps[modality]) {
    return `input modality '${modality}' (${mimeType})${suffix} not supported`;
  }
  return null;
}

/** Requested `outputModalities` vs MEMBERSHIP in `media.outputCombinations` (ADR-0031 decision #3). */
function outputCombinationReason(
  supports: CapabilityFlags,
  outputModalities: LlmRequest['outputModalities'],
): string | null {
  if (outputModalities === undefined) return null;
  const nonText = outputModalities.filter((modality) => modality !== 'text');
  if (nonText.length === 0) return null;
  const outputOk = supports.media.outputCombinations.some((combo) =>
    nonText.every((modality) => combo.includes(modality)),
  );
  return outputOk
    ? null
    : `output modalities [${nonText.join(', ')}] not in any supported output combination`;
}

/**
 * The unified pre-skip reason — combines the flat-flag requirements + the per-modality media gate.
 * `null` ⇒ the provider can serve the request. Used by the `FallbackChain` skip and {@link supportsRequest}.
 */
export function requestSupportReason(supports: CapabilityFlags, req: LlmRequest): string | null {
  for (const capability of requiredCapabilities(req)) {
    if (!supports[capability]) return `'${capability}' capability not supported`;
  }
  return mediaSupportReason(supports, req);
}

/** Whether a provider's flags satisfy everything the request needs (the FallbackChain skip check). */
export function supportsRequest(supports: CapabilityFlags, req: LlmRequest): boolean {
  return requestSupportReason(supports, req) === null;
}

/**
 * Throw `UnsupportedCapabilityError` if the request needs a flat-flag capability the provider lacks.
 * MEDIA gating is deliberately NOT here — it is performed by `assertMediaCapabilities` at the adapter
 * entry, which runs the seam schema parse FIRST (so an unknown MIME / over-ceiling inline media stays a
 * `ZodError`, not a capability error). The pre-skip's media check lives in {@link supportsRequest}.
 */
export function assertSupported(
  providerId: ProviderId,
  supports: CapabilityFlags,
  req: LlmRequest,
): void {
  for (const capability of requiredCapabilities(req)) {
    if (!supports[capability]) {
      throw new UnsupportedCapabilityError(providerId, capability);
    }
  }
}

/** Throw if the provider cannot stream — called at `stream()` entry (streaming isn't in the request). */
export function assertStreamable(providerId: ProviderId, supports: CapabilityFlags): void {
  if (!supports.streaming) {
    throw new UnsupportedCapabilityError(providerId, 'streaming');
  }
}
