import type { EgressCapability, EgressRequest, EgressResponse } from '@relavium/core';
import {
  connectValidated,
  nodeEgressDeps,
  readBounded,
  SafeEgressError,
  withEgressTimeout,
  type EgressDeps,
} from '@relavium/db';
import type { AbortSignalLike } from '@relavium/shared';

import { EgressCapabilityError, EgressDeniedError } from './errors.js';

/**
 * The host-side `egress` capability arm (2.5.E Step 3, [ADR-0057](../../../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)) —
 * the text-shaped `EgressCapability.fetch` the engine's `http_request` / `web_search` / `mcp_call`-via-http
 * tools dispatch through. It is a thin caller of the **shared** SSRF mechanism ([safe-egress.ts](../../../../../packages/db/src/safe-egress.ts),
 * `connectValidated`) — the same connect-by-validated-IP primitive media egress uses, never a second parser.
 *
 * Policy (distinct from media's): it does **NOT follow redirects**. The engine's `enforcePolicy` validated
 * only the ORIGINAL url against the exact-FQDN `allowedDomains` allowlist, so following a `3xx` to a different
 * host would bypass that allowlist (the SSRF range-block alone does not). Instead, **any** status (incl. a
 * `3xx`) is returned to the model with its `Location` header so the model can re-issue a re-validated call.
 * The opaque `credentialRef` is resolved host-side ({@link NodeEgressCapabilityConfig.resolveCredential}) and
 * attached as a bearer header INSIDE this trusted boundary — the raw secret never reaches the engine
 * ([ADR-0006](../../../../../docs/decisions/0006-os-keychain-for-api-keys.md)).
 */

/** A 1 MiB raw-body cap (the model-facing result is further bounded by the registry to ~50 KiB). */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface NodeEgressCapabilityConfig {
  /** The raw response-body byte cap (default 1 MiB); an over-size response fails `too_large`. */
  readonly maxResponseBytes?: number;
  /** Overall request timeout in ms (default 30000). */
  readonly timeoutMs?: number;
  /**
   * Resolve an opaque `credentialRef` to its secret VALUE, host-side (the keychain) — never logged, never
   * returned to the engine. Absent (or an unresolved ref) ⇒ the request proceeds with no credential (a
   * provider that requires one returns 401, surfaced to the model — never a crash).
   */
  readonly resolveCredential?: (ref: string) => Promise<string | undefined>;
  /** Injectable egress deps (Node DNS + pinned HTTPS by default; faked in tests). */
  readonly deps?: EgressDeps;
}

export function createNodeEgressCapability(
  config: NodeEgressCapabilityConfig = {},
): EgressCapability {
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deps = config.deps ?? nodeEgressDeps;
  const decoder = new TextDecoder();

  return {
    fetch: async (request: EgressRequest, signal?: AbortSignalLike): Promise<EgressResponse> => {
      // Resolve the opaque credentialRef host-side and attach it as a bearer header INSIDE the trusted
      // boundary — the raw secret never crosses back into the engine. No ref / no resolver ⇒ no header.
      const credential =
        request.credentialRef === undefined
          ? undefined
          : await config.resolveCredential?.(request.credentialRef);
      const headers: Record<string, string> = { ...request.headers };
      if (credential !== undefined && credential.length > 0) {
        headers['authorization'] = `Bearer ${credential}`;
      }

      try {
        return await withEgressTimeout(signal, timeoutMs, async (sig) => {
          const response = await connectValidated(
            request.url,
            {
              allowPrivate: false, // BYOK local-endpoint opt-in is deferred — fail-closed on private targets
              method: request.method,
              headers,
              ...(request.body === undefined ? {} : { body: request.body }),
            },
            deps,
            sig,
          );
          // NO redirect following (allowedDomains bypass — see the file header): return ANY status, with the
          // raw body read under the size cap and decoded as UTF-8 text.
          const bytes = await readBounded(response.body, maxResponseBytes, response.dispose);
          return {
            status: response.status,
            headers: response.headers ?? {},
            body: decoder.decode(bytes),
          };
        });
      } catch (error) {
        throw classifyEgressError(error);
      }
    },
  };
}

/**
 * Map the shared {@link SafeEgressError} to the host error taxonomy: an SSRF range-block or non-HTTPS/
 * credentialed-url denial is a **deterministic** {@link EgressDeniedError} (fatal `tool_denied` — re-issuing
 * re-denies, never burns the node-retry budget); a transient network/size failure is an
 * {@link EgressCapabilityError} (retryable `tool_failed`). The shared message is already a tool-agnostic,
 * reason-only `egress …` string (no url/IP/bytes), so it is passed through verbatim — the SAME arm backs
 * `http_request`, `web_search`, and http-transport `mcp_call`, and the registry attaches the actual invoking
 * tool id when it surfaces the error, so an arm-side `http_request:` prefix would MISATTRIBUTE a `web_search`
 * failure. An abort is classified `cancelled` by the registry's cancel-precedence regardless of this class.
 */
function classifyEgressError(error: unknown): Error {
  if (error instanceof SafeEgressError) {
    if (error.code === 'insecure_url' || error.code === 'blocked_host') {
      return new EgressDeniedError(error.message);
    }
    return new EgressCapabilityError(error.message);
  }
  return error instanceof Error ? error : new EgressCapabilityError('egress request failed');
}
