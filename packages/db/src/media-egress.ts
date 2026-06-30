import type { AbortSignalLike } from '@relavium/shared';

import {
  connectValidated,
  isRedirectStatus,
  nodeEgressDeps,
  readBounded,
  SafeEgressError,
  withEgressTimeout,
  type EgressDeps,
} from './safe-egress.js';

/**
 * `fetchMediaBytes` (1.AF/D9, [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md)
 * §2/§3) — the host **mechanism** half of media egress: the Node/filesystem-host reference implementation
 * the engine binds into a `MediaUrlFetch` hook so `deInlineMedia` can re-host a `url` media source to bytes.
 *
 * It is a thin wrapper over the **shared SSRF egress mechanism** ([safe-egress.ts](safe-egress.ts)) — the
 * one connect-by-validated-IP primitive that the CLI tool-egress text fetch ([ADR-0057](../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md)
 * 2.5.E) also reuses, so there is never a second hand-rolled SSRF parser (ADR-0029(d)). This file owns only
 * the media-specific POLICY: GET-only, FOLLOW redirects (each hop re-validated by `connectValidated`; media
 * has no `allowedDomains` allowlist, only the range-block), `200`-only, and size-bounded bytes.
 *
 * Errors are a typed {@link MediaEgressError} (= the shared `SafeEgressError`) whose message names a reason
 * only — never the url, the resolved IP, a host stack, or bytes (ADR-0043 §4). The DNS resolver + connection
 * opener are injectable ({@link MediaEgressDeps}) so the policy is deterministically unit-testable.
 */

// Back-compat public surface: the media API names alias the shared egress types (one implementation).
export {
  SafeEgressError as MediaEgressError,
  nodeEgressDeps as nodeMediaEgressDeps,
} from './safe-egress.js';
export type {
  SafeEgressErrorCode as MediaEgressErrorCode,
  EgressDeps as MediaEgressDeps,
  HopRequest,
  HopResponse,
} from './safe-egress.js';

export interface FetchMediaBytesOptions {
  /** The per-fetch upper bound on the streamed body in bytes (the engine supplies this policy). */
  readonly maxBytes: number;
  /** Overall request timeout in ms (default 30000). */
  readonly timeoutMs?: number;
  /** Maximum number of redirects followed before failing (default 5). */
  readonly maxRedirects?: number;
  /**
   * Cancels the fetch (composed with the timeout). Typed as the platform-free `AbortSignalLike` so the
   * engine's `AbortControllerLike.signal` (the run abort) wires in without a cast at the `HostMediaFetch`
   * boundary; a real `AbortSignal` structurally satisfies it.
   */
  readonly signal?: AbortSignalLike;
  /**
   * Allow a private/loopback target — the BYOK explicit local-endpoint opt-in (security-review.md).
   * Default `false`: private/loopback/link-local/metadata addresses are blocked.
   */
  readonly allowPrivate?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Fetch the bytes at a public-HTTPS `url`, enforcing the full SSRF + size-bound policy via the shared
 * mechanism. Media FOLLOWS redirects (each hop re-validated) and requires a final `200`. Its ONLY thrown
 * type is {@link MediaEgressError} — every raw error is normalized by `withEgressTimeout`.
 */
export async function fetchMediaBytes(
  url: string,
  options: FetchMediaBytesOptions,
  deps: EgressDeps = nodeEgressDeps,
): Promise<Uint8Array> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivate = options.allowPrivate ?? false;
  return withEgressTimeout(
    options.signal,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    async (signal) => {
      let target = url;
      for (let redirects = 0; ; redirects += 1) {
        if (redirects > maxRedirects) {
          throw new SafeEgressError(
            'too_many_redirects',
            'media egress exceeded the redirect limit',
          );
        }
        const response = await connectValidated(
          target,
          { allowPrivate, method: 'GET' },
          deps,
          signal,
        );
        if (isRedirectStatus(response.status)) {
          response.dispose(); // never read a redirect body
          const location = response.location;
          if (location === undefined || location.length === 0) {
            throw new SafeEgressError('bad_status', 'media egress redirect had no Location');
          }
          // A relative Location resolves against the current url; the next iteration re-validates it (per-hop).
          target = new URL(location, target).toString();
          continue;
        }
        if (response.status !== 200) {
          response.dispose();
          throw new SafeEgressError('bad_status', 'media egress received a non-200 status');
        }
        return readBounded(response.body, options.maxBytes, response.dispose);
      }
    },
  );
}
