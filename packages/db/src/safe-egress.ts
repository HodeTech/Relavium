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
 * The ONE shared host-side SSRF egress mechanism — `connectValidated` performs a single validated hop
 * (HTTPS-only + no-creds → DNS-resolve → range-block **every** resolved IP → connect **pinned** to the
 * validated IP, keeping the hostname as the SNI so TLS verification stays on), and `readBounded` /
 * `withEgressTimeout` provide the size-bound + timeout/error-normalization wiring. Both the media-egress
 * byte fetch ([media-egress.ts](media-egress.ts), [ADR-0043](../../../docs/decisions/0043-media-egress-failover-rematerialization-ssrf.md))
 * and the CLI tool-egress text fetch ([ADR-0057](../../../docs/decisions/0057-cli-chat-modes-and-per-tool-approval.md) 2.5.E)
 * reuse this — **never a second hand-rolled SSRF parser** (ADR-0029(d) one-primitive rule). The range-block
 * itself (`isPrivateOrLocalHost`) and the URL policy (`extractHttpsHost` / `urlHasCredentials`) are the
 * shared `@relavium/shared` primitives.
 *
 * The redirect POLICY differs per caller and stays per-caller (it is not part of the shared mechanism):
 * media FOLLOWS redirects (no allowlist; each hop is re-validated by calling `connectValidated` again),
 * while the tool egress does NOT follow them — `enforcePolicy` checked only the ORIGINAL url against the
 * exact-FQDN `allowedDomains` allowlist, so following a `3xx` to a different host would bypass that
 * allowlist; the tool returns the `3xx` (status + `Location`) so the model can re-issue a re-validated call.
 *
 * Errors are a typed {@link SafeEgressError} whose message names a **reason only** — never the url, the
 * resolved IP, a host stack, or bytes. The DNS resolver + connection opener are injectable ({@link EgressDeps})
 * so the policy is deterministically unit-testable without real network/DNS; the default deps are Node.
 */

/** Why a safe-egress fetch failed — a secret-free, reason-only discriminant. */
export type SafeEgressErrorCode =
  | 'insecure_url' // not HTTPS, embeds credentials, or a malformed authority
  | 'blocked_host' // resolves to (or is) a private/loopback/link-local/metadata address
  | 'too_many_redirects'
  | 'too_large' // body exceeded the configured maximum download size
  | 'bad_status' // a non-200, non-redirect HTTP status (media only; the tool returns any status)
  | 'network'; // the connection failed / was aborted

/** A typed egress failure. The `message` names a reason only — never the url/IP/bytes (secret-free). */
export class SafeEgressError extends Error {
  readonly code: SafeEgressErrorCode;
  constructor(code: SafeEgressErrorCode, message: string) {
    super(message);
    this.name = 'SafeEgressError';
    this.code = code;
  }
}

/** The HTTP methods an egress hop may use. Media is GET-only; the tool `http_request` allows the four. */
export type EgressMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** One pinned request the connection opener must perform (no redirect following — the caller owns that). */
export interface HopRequest {
  readonly url: string;
  readonly hostname: string;
  /** The pre-validated IP the connection MUST be pinned to (TOCTOU defense — never re-resolve here). */
  readonly pinnedIp: string;
  readonly method: EgressMethod;
  /** Request headers (incl. a host-resolved credential, already attached by the caller). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
}

/** One redirect-free HTTP response the caller inspects (status + headers + Location + a body stream). */
export interface HopResponse {
  readonly status: number;
  /** Response headers — populated by the Node deps; a media fake may omit them (the byte path ignores them). */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly location: string | undefined;
  readonly body: AsyncIterable<Uint8Array>;
  /** Abort the underlying socket — called when we stop reading early (a redirect, an error, an over-size body). */
  readonly dispose: () => void;
}

/** Injectable I/O primitives — Node by default; faked in tests so the SSRF policy is deterministic. */
export interface EgressDeps {
  /** Resolve a hostname to its IP(s) (an IP literal resolves to itself). */
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  /** Open ONE pinned HTTPS connection and return its (unread) response. */
  readonly openConnection: (request: HopRequest, signal: AbortSignal) => Promise<HopResponse>;
}

/** True for the redirect statuses callers may follow (a `Location` is required, re-validated per hop). */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Validate an egress URL's scheme + authority via the shared SSRF policy primitives and return its
 * lowercased host. Throws `insecure_url` for a non-HTTPS scheme, a malformed authority, or embedded
 * credentials — never a second hand-rolled parser.
 */
function validateEgressHost(url: string): string {
  if (urlHasCredentials(url)) {
    throw new SafeEgressError('insecure_url', 'egress url must not embed credentials');
  }
  const parsed = extractHttpsHost(url);
  if (parsed === null) {
    throw new SafeEgressError('insecure_url', 'egress url must be a well-formed https url');
  }
  if (parsed.hasCredentials) {
    throw new SafeEgressError('insecure_url', 'egress url must not embed credentials');
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
  deps: EgressDeps,
  allowPrivate: boolean,
): Promise<readonly string[]> {
  if (!allowPrivate && isPrivateOrLocalHost(host)) {
    throw new SafeEgressError('blocked_host', 'egress target is a private/loopback address');
  }
  const ips = await deps.resolveHost(host);
  if (ips.length === 0) {
    throw new SafeEgressError('blocked_host', 'egress target did not resolve to an address');
  }
  for (const ip of ips) {
    // Every resolved value MUST be an IP literal — otherwise a (buggy/malicious) resolver returning a
    // hostname would pass the range-block (a hostname is not a private IP) and become the pinned `lookup`
    // target, defeating the connect-by-validated-IP guarantee. Fail-closed on a non-IP.
    if (isIP(ip) === 0) {
      throw new SafeEgressError('blocked_host', 'egress resolver returned a non-IP address');
    }
    if (!allowPrivate && isPrivateOrLocalHost(ip)) {
      throw new SafeEgressError(
        'blocked_host',
        'egress target resolves to a private/loopback address',
      );
    }
  }
  return ips;
}

/**
 * Perform ONE validated hop: validate the url + resolve / range-block / pin the host, then open the pinned
 * connection. The caller decides what to do with the response (follow a redirect — re-validating by calling
 * this again — or read the body). This is the **single** connect-by-validated-IP mechanism; a raw throw is
 * normalized to a typed `SafeEgressError('network')` by {@link withEgressTimeout}.
 */
export async function connectValidated(
  target: string,
  opts: {
    readonly allowPrivate: boolean;
    readonly method: EgressMethod;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | undefined;
  },
  deps: EgressDeps,
  signal: AbortSignal,
): Promise<HopResponse> {
  const host = validateEgressHost(target);
  const ips = await resolveValidatedIps(host, deps, opts.allowPrivate);
  // Connect by the FIRST validated IP — every IP was range-checked + confirmed an IP literal above, so
  // pinning means the address validated is the address connected to (no re-resolve TOCTOU window).
  const pinnedIp = ips[0];
  if (pinnedIp === undefined) {
    // Unreachable: `resolveValidatedIps` throws `blocked_host` on an empty result rather than returning `[]`.
    // Fail closed (never fall back to pinning the UNVALIDATED hostname) so a future return-convention change
    // can't silently reopen the re-resolve window.
    throw new SafeEgressError('blocked_host', 'no validated IP to pin the connection to');
  }
  return deps.openConnection(
    {
      url: target,
      hostname: host,
      pinnedIp,
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
    },
    signal,
  );
}

/** Consume a body stream, aborting the moment it exceeds `maxBytes`; concat the bounded chunks. */
export async function readBounded(
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
        throw new SafeEgressError('too_large', 'egress response exceeded the maximum size');
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

/**
 * The shared timeout + abort + error-normalization wrapper. Composes the caller's `signal` with a timeout
 * into one `AbortController`, runs `fn(controller.signal)`, and guarantees the ONLY thrown type is a typed,
 * secret-free {@link SafeEgressError} — every raw resolver / socket / `new URL` / body-read error becomes
 * `SafeEgressError('network')`, never a raw leak.
 */
export async function withEgressTimeout<T>(
  signal: AbortSignalLike | undefined,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted === true) {
    controller.abort();
  }
  signal?.addEventListener('abort', abort); // removed in the finally below
  const timer = setTimeout(abort, timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error instanceof SafeEgressError) {
      throw error; // a typed failure (blocked_host / too_large / bad_status / …) — preserve the discriminant
    }
    // Any RAW throw is normalized to the typed, secret-free network failure.
    throw new SafeEgressError('network', 'egress request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** The default Node deps: `node:dns` lookup (IP literal → itself) + a pinned `node:https` request. */
export const nodeEgressDeps: EgressDeps = {
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
          // The URL's port (default 443) is honored as-is — a public CDN/API URL may legitimately serve over
          // a non-443 HTTPS port. Safe under the default wiring (allowPrivate: false): the private/loopback/
          // link-local IP range block (resolveValidatedIps) prevents reaching an internal service on ANY
          // port, so no port allow-list is needed. If a BYOK local-endpoint allowPrivate opt-in is ever
          // wired, that ADR MUST add an explicit port allow-list decision (SEC-EGRESS-3).
          port: parsed.port === '' ? 443 : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          method: request.method,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          servername: request.hostname, // SNI + certificate hostname — TLS verification stays ON
          // Pin to the pre-validated IP: the agent connects to exactly this address, never re-resolving.
          lookup: (_hostname, _opts, callback) => callback(null, request.pinnedIp, family),
          signal,
        },
        (incoming) => {
          const location = incoming.headers.location;
          resolve({
            status: incoming.statusCode ?? 0,
            headers: flattenHeaders(incoming.headers),
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
        reject(new SafeEgressError('network', 'egress request failed')),
      );
      if (request.body !== undefined) {
        clientRequest.write(request.body);
      }
      clientRequest.end();
    }),
};

/** Flatten Node's `IncomingHttpHeaders` (string | string[] | undefined) to a plain string record. */
function flattenHeaders(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.join(', ');
    }
  }
  return out;
}
