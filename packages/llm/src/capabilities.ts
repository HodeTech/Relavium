import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from './types.js';

/**
 * Capability gating (1.D) — keeps the common path narrow and honest. A request that needs a feature
 * the provider can't do **fails fast with a typed error rather than being silently dropped**.
 * Provider-specific features off the common path (vision, prompt cache, reasoning, parallel tool
 * calls) travel through `LlmRequest.providerOptions`, not these flags. See ADR-0011.
 */

/** One capability flag name. */
export type Capability = keyof CapabilityFlags;

/**
 * The capabilities a request requires, given the current request surface. Only `tools` is currently
 * expressible in a canonical `LlmRequest`; the rest (vision, cache, reasoning, parallel tool calls)
 * are reached via `providerOptions` and so are not gated here. The ADR-0031 media gating — the
 * per-modality input check derived from the request's media parts plus the `outputModalities`
 * MEMBERSHIP check against `media.outputCombinations` — lands with the engine media plumbing
 * (1.AF); at 1.AD the `media` matrix is shape only, so it is deliberately not consulted yet.
 */
export function requiredCapabilities(req: LlmRequest): Capability[] {
  const required: Capability[] = [];
  if (req.tools !== undefined && req.tools.length > 0) {
    required.push('tools');
  }
  return required;
}

/** Whether a provider's flags satisfy everything the request needs (the FallbackChain skip check). */
export function supportsRequest(supports: CapabilityFlags, req: LlmRequest): boolean {
  return requiredCapabilities(req).every((capability) => supports[capability]);
}

/** Throw `UnsupportedCapabilityError` if the request needs a capability the provider lacks. */
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
