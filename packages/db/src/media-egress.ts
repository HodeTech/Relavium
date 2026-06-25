import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  extractHttpsHost,
  isPrivateOrLocalHost,
  urlHasCredentials,
  type AbortSignalLike,
} from '@relavium/shared';

/**
 * `fetchMediaBytes` (1.AF/D9, [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md)
 * §2/§3) — the host **mechanism** half of media egress: the Node/filesystem-host reference
 * implementation the engine binds into a {@link MediaUrlFetch} hook so `deInlineMedia` can re-host a
 * `url` media source to bytes. The engine owns the **policy** (the one shared SSRF primitive + the size
 * bound); this performs the validated I/O, in one place, never an adapter:
 *
 * - **HTTPS-only, no embedded credentials** — rejected via the shared {@link extractHttpsHost} /
 *   {@link urlHasCredentials} primitives (never a second hand-rolled parser).
 * - **DNS-rebind defense (TOCTOU)** — resolve the hostname, validate **every** resolved IP against the
 *   shared {@link isPrivateOrLocalHost} range-block, then **connect by the validated IP** (a pinned
 *   `lookup`) so the address checked is the address connected to.
 * - **Per-hop redirect re-validation** — every `3xx` `Location` re-runs the whole HTTPS + no-creds +
 *   resolve + range-block + pin cycle on the new target (a redirect-to-private / -to-http is blocked
 *   mid-fetch), bounded by `maxRedirects`. A redirect body is never read.
 * - **Streamed, size-bounded** — the body is consumed chunk-by-chunk and aborted the moment it exceeds
 *   `maxBytes`; an over-size response is never fully buffered.
 * - **TLS verification is never disabled** — the request connects to the pinned IP but keeps the
 *   original hostname as the SNI `servername`, so the certificate is validated against the hostname.
 *
 * Errors are a typed {@link MediaEgressError} whose message names a **reason only** — never the url, the
 * resolved IP, a host stack, or bytes (ADR-0043 §4 secret-free discipline). The DNS resolver and the
 * connection opener are injectable ({@link MediaEgressDeps}) so the SSRF policy + redirect + size-bound
 * orchestration is deterministically unit-testable without real network/DNS; the default deps are Node.
 */

/** Why a media egress fetch failed — a secret-free, reason-only discriminant. */
export type MediaEgressErrorCode =
  | 'insecure_url' // not HTTPS, embeds credentials, or a malformed authority
  | 'blocked_host' // resolves to (or is) a private/loopback/link-local/metadata address
  | 'too_many_redirects'
  | 'too_large' // body exceeded the configured maximum download size
  | 'bad_status' // a non-200, non-redirect HTTP status
  | 'network'; // the connection failed / was aborted

/** A typed media-egress failure. The `message` names a reason only — never the url/IP/bytes (rule 6). */
export class MediaEgressError extends Error {
  readonly code: MediaEgressErrorCode;
  constructor(code: MediaEgressErrorCode, message: string) {
    super(message);
    this.name = 'MediaEgressError';
    this.code = code;
  }
}

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

/** One redirect-free HTTP response the orchestrator inspects (status + Location + a body stream). */
export interface HopResponse {
  readonly status: number;
  readonly location: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  /** Abort the underlying socket — called when we stop reading early (a redirect, an error, an over-size body). */
  readonly dispose: () => void;
}

/** One pinned request the connection opener must perform (no redirect following — the orchestrator owns that). */
export interface HopRequest {
  readonly url: string;
  readonly hostname: string;
  /** The pre-validated IP the connection MUST be pinned to (TOCTOU defense — never re-resolve here). */
  readonly pinnedIp: string;
}

/** Injectable I/O primitives — Node by default; faked in tests so the SSRF policy is deterministic. */
export interface MediaEgressDeps {
  /** Resolve a hostname to its IP(s) (an IP literal resolves to itself). */
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  /** Open ONE pinned HTTPS connection and return its (unread) response. */
  readonly openConnection: (request: HopRequest, signal: AbortSignal) => Promise<HopResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** True for the redirect statuses we follow (a `Location` is required, re-validated per hop). */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Validate an egress URL's scheme + authority via the shared SSRF policy primitive and return its
 * lowercased host. Throws `insecure_url` for a non-HTTPS scheme, a malformed authority, or embedded
 * credentials — never a second hand-rolled parser.
 */
function validateEgressHost(url: string): string {
  if (urlHasCredentials(url)) {
    throw new MediaEgressError('insecure_url', 'media egress url must not embed credentials');
  }
  const parsed = extractHttpsHost(url);
  if (parsed === null) {
    throw new MediaEgressError('insecure_url', 'media egress url must be a well-formed https url');
  }
  if (parsed.hasCredentials) {
    throw new MediaEgressError('insecure_url', 'media egress url must not embed credentials');
  }
  return parsed.host;
}

/**
 * Resolve `host` and validate the host literal AND **every** resolved IP against the shared range-block.
 * Fail-closed: any private/loopback/link-local/metadata address (unless `allowPrivate`) blocks the whole
 * fetch — so a multi-record name with one private answer cannot slip through.
 */
async function resolveValidatedIps(
  host: string,
  deps: MediaEgressDeps,
  allowPrivate: boolean,
): Promise<readonly string[]> {
  if (!allowPrivate && isPrivateOrLocalHost(host)) {
    throw new MediaEgressError('blocked_host', 'media egress target is a private/loopback address');
  }
  const ips = await deps.resolveHost(host);
  if (ips.length === 0) {
    throw new MediaEgressError('blocked_host', 'media egress target did not resolve to an address');
  }
  for (const ip of ips) {
    // Every resolved value MUST be an IP literal — otherwise a (buggy/malicious) resolver returning a
    // hostname would pass the range-block (a hostname is not a private IP) and become the pinned `lookup`
    // target, defeating the connect-by-validated-IP guarantee. Fail-closed on a non-IP.
    if (isIP(ip) === 0) {
      throw new MediaEgressError('blocked_host', 'media egress resolver returned a non-IP address');
    }
    if (!allowPrivate && isPrivateOrLocalHost(ip)) {
      throw new MediaEgressError(
        'blocked_host',
        'media egress target resolves to a private/loopback address',
      );
    }
  }
  return ips;
}

/** Consume a body stream, aborting the moment it exceeds `maxBytes`; concat the bounded chunks. */
async function readBounded(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
  dispose: () => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new MediaEgressError('too_large', 'media egress response exceeded the maximum size');
      }
      chunks.push(chunk);
    }
  } finally {
    dispose(); // abort the socket (harmless if the body already ended)
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** One validated hop's result: a redirect `Location` to follow, or the delivered size-bounded bytes. */
type HopOutcome =
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array };

/**
 * Perform ONE validated hop: validate the url + resolve / range-block / pin the host, open the pinned
 * connection, and either surface a redirect `Location` (the caller re-validates it on the next hop) or
 * read the size-bounded body. Split out of {@link fetchMediaBytes} to keep its cognitive complexity in
 * budget (sonar S3776); any raw throw here is normalized to a typed `MediaEgressError` by the caller.
 */
async function performHop(
  target: string,
  deps: MediaEgressDeps,
  allowPrivate: boolean,
  signal: AbortSignal,
  maxBytes: number,
): Promise<HopOutcome> {
  const host = validateEgressHost(target);
  const ips = await resolveValidatedIps(host, deps, allowPrivate);
  // Connect by the FIRST validated IP — every IP was range-checked + confirmed an IP literal above, so
  // pinning means the address validated is the address connected to (no re-resolve TOCTOU window).
  const pinnedIp = ips[0];
  if (pinnedIp === undefined) {
    // Unreachable: `resolveValidatedIps` throws `blocked_host` on an empty result rather than returning `[]`.
    // Fail closed (never fall back to pinning the UNVALIDATED hostname) so a future return-convention change
    // can't silently reopen the re-resolve window.
    throw new MediaEgressError('blocked_host', 'no validated IP to pin the connection to');
  }
  const response = await deps.openConnection({ url: target, hostname: host, pinnedIp }, signal);
  if (isRedirectStatus(response.status)) {
    response.dispose(); // never read a redirect body
    const location = response.location;
    if (location === undefined || location.length === 0) {
      throw new MediaEgressError('bad_status', 'media egress redirect had no Location');
    }
    return { kind: 'redirect', location };
  }
  if (response.status !== 200) {
    response.dispose();
    throw new MediaEgressError('bad_status', 'media egress received a non-200 status');
  }
  return { kind: 'bytes', bytes: await readBounded(response.body, maxBytes, response.dispose) };
}

/**
 * Fetch the bytes at a public-HTTPS `url`, enforcing the full SSRF + size-bound policy. The host
 * mechanism the engine binds into a `MediaUrlFetch` hook (the engine supplies `maxBytes` + the
 * `AbortSignal`). See the file header for the security contract. Its ONLY thrown type is
 * {@link MediaEgressError} — every raw resolver / socket / `new URL` / body-read error is normalized.
 */
export async function fetchMediaBytes(
  url: string,
  options: FetchMediaBytesOptions,
  deps: MediaEgressDeps = nodeMediaEgressDeps,
): Promise<Uint8Array> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivate = options.allowPrivate ?? false;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (options.signal?.aborted === true) {
    controller.abort();
  }
  options.signal?.addEventListener('abort', abort); // removed in the finally below
  const timer = setTimeout(abort, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let target = url;
    for (let redirects = 0; ; redirects += 1) {
      if (redirects > maxRedirects) {
        throw new MediaEgressError(
          'too_many_redirects',
          'media egress exceeded the redirect limit',
        );
      }
      const outcome = await performHop(
        target,
        deps,
        allowPrivate,
        controller.signal,
        options.maxBytes,
      );
      if (outcome.kind === 'bytes') {
        return outcome.bytes;
      }
      // A relative Location resolves against the current url; the next iteration re-validates it (per-hop).
      target = new URL(outcome.location, target).toString();
    }
  } catch (error) {
    if (error instanceof MediaEgressError) {
      throw error; // a typed failure (blocked_host / too_large / bad_status / …) — preserve the discriminant
    }
    // Any RAW throw is normalized to the typed, secret-free network failure — a resolver DNS error, an
    // openConnection socket error, a malformed-Location `new URL` TypeError, or an aborted body read — so
    // fetchMediaBytes's ONLY thrown type is MediaEgressError (the function's contract; never a raw leak).
    throw new MediaEgressError('network', 'media egress request failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** The default Node deps: `node:dns` lookup (IP literal → itself) + a pinned `node:https` GET. */
export const nodeMediaEgressDeps: MediaEgressDeps = {
  resolveHost: async (hostname: string): Promise<readonly string[]> => {
    if (isIP(hostname) !== 0) {
      return [hostname]; // already an IP literal — no DNS round-trip
    }
    const records = await dnsLookup(hostname, { all: true });
    return records.map((record) => record.address);
  },
  openConnection: (request: HopRequest, signal: AbortSignal): Promise<HopResponse> =>
    new Promise<HopResponse>((resolve, reject) => {
      const parsed = new URL(request.url);
      const family = isIP(request.pinnedIp) === 6 ? 6 : 4;
      const clientRequest = httpsRequest(
        {
          protocol: 'https:',
          hostname: request.hostname,
          // The URL's port (default 443) is honored as-is — a public CDN media URL may legitimately serve
          // over a non-443 HTTPS port. This is safe under the current default wiring (allowPrivate: false):
          // the private/loopback/link-local IP range block (resolveValidatedIps) prevents reaching an internal
          // service on ANY port, so no port allow-list is needed. If the BYOK local-endpoint allowPrivate
          // opt-in is ever wired, that ADR MUST add an explicit port allow-list decision (a crafted
          // https://host:22/ to a permitted-private address would otherwise be reachable). See SEC-EGRESS-3.
          port: parsed.port === '' ? 443 : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          servername: request.hostname, // SNI + certificate hostname — TLS verification stays ON
          // Pin to the pre-validated IP: the agent connects to exactly this address, never re-resolving.
          lookup: (_hostname, _opts, callback) => callback(null, request.pinnedIp, family),
          signal,
        },
        (incoming) => {
          const location = incoming.headers.location;
          resolve({
            status: incoming.statusCode ?? 0,
            location: typeof location === 'string' ? location : undefined,
            body: incoming,
            dispose: () => {
              incoming.destroy();
              clientRequest.destroy();
            },
          });
        },
      );
      // A secret-free network failure — never echo the underlying message (it can carry the host/IP).
      clientRequest.on('error', () =>
        reject(new MediaEgressError('network', 'media egress request failed')),
      );
      clientRequest.end();
    }),
};
