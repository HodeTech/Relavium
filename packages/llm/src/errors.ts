import { extractHttpsHost } from '@relavium/shared';

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
 * A credential-safe summary of a base URL — scheme + host only, never the userinfo, path, query, or
 * fragment. A base URL may embed `user:pass@host`, and that secret must never reach an error message,
 * a log, a run event, or the frontend (security-review.md §Network/outbound URLs). `URL.host` excludes
 * userinfo; a malformed URL (a common reason the base URL is invalid) falls back to a safe placeholder.
 */
function summarizeBaseUrl(url: string): string {
  // Reuse the shared HTTPS host extractor (pure string parsing — the seam lib has no URL global). The
  // host it returns already excludes the userinfo, so credentials cannot survive into the summary. A
  // non-HTTPS / malformed URL (itself a common reason the base URL is invalid) is never echoed back.
  const parsed = extractHttpsHost(url);
  return parsed === null ? '<non-HTTPS or malformed base URL>' : `https://${parsed.host}`;
}

/**
 * The factory was given a `baseURL` that is not a safe HTTPS endpoint (e.g. an HTTP URL, a
 * loopback/link-local address, or a cloud-metadata service) — the adapter refuses to construct
 * rather than silently enabling an SSRF path that forwards the real API key. The raw URL is NEVER
 * stored or shown — it may embed credentials; only the credential-free scheme+host summary is kept.
 */
export class InvalidBaseUrlError extends LlmConfigError {
  readonly code = 'invalid_base_url';
  /** Credential-free scheme+host summary of the offending base URL (never the raw, creds-bearing URL). */
  readonly url: string;

  constructor(url: string, reason: string) {
    const safe = summarizeBaseUrl(url);
    super(`invalid base URL '${safe}': ${reason}`);
    this.name = 'InvalidBaseUrlError';
    this.url = safe;
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
  readonly detail: string | undefined;

  constructor(provider: ProviderId, capability: keyof CapabilityFlags, detail?: string) {
    const message =
      detail === undefined
        ? `provider '${provider}' does not support the '${capability}' capability`
        : `provider '${provider}' does not support the '${capability}' capability: ${detail}`;
    super(message);
    this.name = 'UnsupportedCapabilityError';
    this.provider = provider;
    this.capability = capability;
    this.detail = detail;
  }
}
