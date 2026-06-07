import type { CapabilityFlags, ProviderId } from './types.js';

/**
 * Typed, discriminated config/validation errors thrown on the Relavium side of the seam (cost
 * pricing, tool normalization). These are distinct from `LlmError` — the normalized shape a
 * provider *call* fails with; these are authored/config mistakes caught before egress. Each
 * carries a stable `code` discriminant and structured context, never an interpolated message
 * (docs/standards/error-handling.md).
 */

export type LlmConfigErrorCode =
  | 'unknown_model'
  | 'unsupported_tool_schema'
  | 'unsupported_capability'
  | 'invalid_base_url';

/** Base for the seam's thrown config errors — narrow on `code`, never on `message`. */
export abstract class LlmConfigError extends Error {
  abstract readonly code: LlmConfigErrorCode;
}

/**
 * A model id is not in the pricing table — surfaced rather than silently priced at zero (1.B).
 * User-facing: names the offending id and the known set.
 */
export class UnknownModelError extends LlmConfigError {
  readonly code = 'unknown_model';
  readonly modelId: string;
  readonly knownModels: readonly string[];

  constructor(modelId: string, knownModels: readonly string[]) {
    super(`unknown model id '${modelId}' — not in the pricing table`);
    this.name = 'UnknownModelError';
    this.modelId = modelId;
    this.knownModels = knownModels;
  }
}

/**
 * A tool's JSON-Schema cannot be expressed for a given provider's wire format (e.g. the Gemini
 * OpenAPI-subset reshape hit an unsupported keyword) — 1.E. User-facing: names the tool, the
 * provider, and the reason.
 */
export class ToolSchemaError extends LlmConfigError {
  readonly code = 'unsupported_tool_schema';
  readonly provider: ProviderId;
  readonly toolName: string;
  readonly reason: string;

  constructor(provider: ProviderId, toolName: string, reason: string) {
    super(`tool '${toolName}' cannot be expressed for provider '${provider}': ${reason}`);
    this.name = 'ToolSchemaError';
    this.provider = provider;
    this.toolName = toolName;
    this.reason = reason;
  }
}

/**
 * The factory was given a `baseURL` that is not a safe HTTPS endpoint (e.g. an HTTP URL, a
 * loopback/link-local address, or a cloud-metadata service) — the adapter refuses to construct
 * rather than silently enabling an SSRF path that forwards the real API key.
 */
export class InvalidBaseUrlError extends LlmConfigError {
  readonly code = 'invalid_base_url';
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`invalid base URL '${url}': ${reason}`);
    this.name = 'InvalidBaseUrlError';
    this.url = url;
  }
}

/**
 * A request needs a capability the chosen provider lacks (e.g. tools on a tools-less provider) —
 * surfaced rather than silently dropping the feature (1.D).
 */
export class UnsupportedCapabilityError extends LlmConfigError {
  readonly code = 'unsupported_capability';
  readonly provider: ProviderId;
  readonly capability: keyof CapabilityFlags;

  constructor(provider: ProviderId, capability: keyof CapabilityFlags) {
    super(`provider '${provider}' does not support the '${capability}' capability`);
    this.name = 'UnsupportedCapabilityError';
    this.provider = provider;
    this.capability = capability;
  }
}
