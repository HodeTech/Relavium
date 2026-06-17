import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest, ProviderId } from './types.js';

/**
 * Capability gating (1.D) — keeps the common path narrow and honest. A request that needs a feature
 * the provider can't do **fails fast with a typed error rather than being silently dropped**.
 * Provider-specific features with no cross-provider shape (prompt-cache control, thinking budgets,
 * parallel-tool-call toggles) travel through `LlmRequest.providerOptions`, not these flags; the
 * reasoning and media channels are canonical seam shape (ADR-0030/0031). See ADR-0011.
 */

/** One capability flag name. */
export type Capability = keyof CapabilityFlags;

/**
 * The capabilities a request requires, given the current request surface. `tools` and `vision` are
 * the two checked here (vision is the derived alias of `media.input.image` — ADR-0031). The
 * per-modality input/output check is performed by `assertMediaCapabilities` at each adapter entry
 * point (1.AE), which gives more specific error messages. Adding `vision` here lets the
 * FallbackChain skip providers that can't handle image input without reaching the adapter layer.
 */
export function requiredCapabilities(req: LlmRequest): Capability[] {
  const required: Capability[] = [];
  if (req.tools !== undefined && req.tools.length > 0) {
    required.push('tools');
  }
  if (req.messages.some((m) => m.content.some((p) => p.type === 'media'))) {
    required.push('vision');
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
