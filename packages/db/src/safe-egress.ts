import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

import {
  extractEgressAuthority,
  isMetadataOrLinkLocal,
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
  /**
   * The validated scheme. `'http'` reaches here ONLY for an authored local endpoint that resolved private
   * (ADR-0088 §4) — an opener must dispatch on it rather than assuming HTTPS, and must not treat it as
   * permission to downgrade anything else.
   */
  readonly scheme: 'http' | 'https';
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
 * The ONE local-endpoint relaxation — a `host:port` a caller has explicitly authored and opted in to
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §4,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md) §3's `SEC-EGRESS-3`).
 *
 * **One bound policy, not two independent booleans, and the difference is a real hole.** A first design had
 * `allowPrivate` and `allowPlaintext` as separate flags set together for any server carrying
 * `allow_local_endpoint`. Set both, and `http://public.example` with that flag becomes a plaintext
 * connection to a REMOTE host — inverting ADR-0053 §3's own "a remote endpoint is always `https`/`wss`"
 * rule, which the pre-connect floor had always enforced correctly.
 *
 * So the two relaxations lift **together, and only** for a target that (a) matches this `host:port`
 * exactly and (b) actually resolves private. A declared local endpoint that resolves to a public address is
 * refused rather than silently downgraded, and a sibling port on the same permitted host (`:6379`, `:5432`,
 * `:22`, a container socket) stays blocked — which is the port-allow-list decision `SEC-EGRESS-3` requires
 * of anyone wiring this at all.
 */
/** A target this hop can actually dial — the two schemes {@link HopRequest} accepts, after validation. */
interface DialableTarget {
  readonly scheme: 'http' | 'https';
  readonly host: string;
  readonly port: number;
}

export interface LocalEndpoint {
  /** Lowercased, brackets stripped — compare against {@link EgressAuthority.host}. */
  readonly host: string;
  readonly port: number;
}

/**
 * Validate an egress URL's scheme + authority via the shared SSRF policy primitives and return its parsed
 * authority. Throws `insecure_url` for an unsupported scheme, a malformed authority, or embedded
 * credentials — never a second hand-rolled parser.
 *
 * Plaintext `http` is admitted here ONLY when it is the authored local endpoint; every other target is
 * HTTPS-only exactly as before. The credential rule is never relaxed by the opt-in.
 */
function validateEgressTarget(url: string, local: LocalEndpoint | undefined): DialableTarget {
  if (urlHasCredentials(url)) {
    throw new SafeEgressError('insecure_url', 'egress url must not embed credentials');
  }
  const parsed = extractEgressAuthority(url);
  if (parsed === null) {
    throw new SafeEgressError('insecure_url', 'egress url must be a well-formed http(s) url');
  }
  if (parsed.hasCredentials) {
    throw new SafeEgressError('insecure_url', 'egress url must not embed credentials');
  }
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    // Parsed by the shared authority reader because MCP declares those schemes, but this hop dials HTTP.
    // Refusing here rather than silently treating `wss` as `https` keeps "what was parsed" and "what will be
    // dialled" the same thing — a websocket target reaching an HTTP dialer is a wiring bug, not a downgrade.
    throw new SafeEgressError('insecure_url', 'egress url must be a well-formed https url');
  }
  const isAuthoredLocal =
    local !== undefined && parsed.host === local.host && parsed.port === local.port;
  if (parsed.scheme !== 'https' && !isAuthoredLocal) {
    throw new SafeEgressError('insecure_url', 'egress url must be a well-formed https url');
  }
  // Re-stated rather than returned as-is, so the narrowing above becomes part of the TYPE the rest of this
  // hop works with. `HopRequest.scheme` is `'http' | 'https'` for a reason — a `ws` target reaching the HTTP
  // opener would be a wiring bug — and the compiler should be what prevents it, not this comment.
  return { scheme: parsed.scheme, host: parsed.host, port: parsed.port };
}

/**
 * Resolve the target and validate the host literal AND **every** resolved IP against the shared range-block.
 *
 * Fail-closed: any private/loopback/link-local/metadata address blocks the whole fetch — so a multi-record
 * name with one private answer cannot slip through. The ONLY exception is the authored local endpoint, and
 * it is bound at both ends: the target must BE that `host:port`, and every resolved address must actually be
 * private. A local-endpoint declaration pointing at a public address is refused, not downgraded.
 */
async function resolveValidatedIps(
  target: DialableTarget,
  deps: EgressDeps,
  local: LocalEndpoint | undefined,
): Promise<readonly string[]> {
  const isAuthoredLocal =
    local !== undefined && target.host === local.host && target.port === local.port;
  if (isAuthoredLocal && isMetadataOrLinkLocal(target.host)) {
    // **The opt-in may not name the metadata space, and this is where a review found it could.**
    // `169.254.169.254` is inside the private ranges `isPrivateOrLocalHost` blocks, so it satisfied every
    // condition for an authored "local endpoint" — and would then have been reachable over PLAINTEXT with
    // the range check lifted, which is the cloud-credential endpoint ADR-0053's own Context names as the
    // motivating threat. A local-development MCP server is never at 169.254.x.x or 0.x.x.x.
    throw new SafeEgressError(
      'blocked_host',
      'a local endpoint may not name a link-local or cloud-metadata address',
    );
  }
  if (!isAuthoredLocal && isPrivateOrLocalHost(target.host)) {
    throw new SafeEgressError('blocked_host', 'egress target is a private/loopback address');
  }
  const ips = await deps.resolveHost(target.host);
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
    const privateIp = isPrivateOrLocalHost(ip);
    if (!isAuthoredLocal && privateIp) {
      throw new SafeEgressError(
        'blocked_host',
        'egress target resolves to a private/loopback address',
      );
    }
    if (isAuthoredLocal && isMetadataOrLinkLocal(ip)) {
      // The same rule on the RESOLVED address, because a name is what an attacker steers. A `*.local`
      // opt-in whose mDNS answer is `169.254.169.254` must not become a plaintext hop to the metadata
      // service just because the authored text looked innocuous.
      throw new SafeEgressError(
        'blocked_host',
        'a local endpoint may not resolve to a link-local or cloud-metadata address',
      );
    }
    if (isAuthoredLocal && !privateIp) {
      // The opt-in NARROWS; it never widens. A declared local endpoint that resolves public would otherwise
      // be a plaintext connection to a remote host, which is the inversion this policy exists to prevent.
      throw new SafeEgressError(
        'blocked_host',
        'a local-endpoint target must resolve to a private/loopback address',
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
    /**
     * The ONE authored local endpoint this hop may reach (see {@link LocalEndpoint}). Absent — the default,
     * and every existing caller — means HTTPS-only with the private ranges blocked, unchanged.
     */
    readonly localEndpoint?: LocalEndpoint | undefined;
    readonly method: EgressMethod;
    readonly headers?: Readonly<Record<string, string>> | undefined;
    readonly body?: string | undefined;
  },
  deps: EgressDeps,
  signal: AbortSignal,
): Promise<HopResponse> {
  const authority = validateEgressTarget(target, opts.localEndpoint);
  const ips = await resolveValidatedIps(authority, deps, opts.localEndpoint);
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
      hostname: authority.host,
      scheme: authority.scheme,
      pinnedIp,
      method: opts.method,
      headers: sanitizeHopHeaders(opts.headers),
      body: opts.body,
    },
    signal,
  );
}

/**
 * Caller-supplied headers that MUST never reach the wire — dropped case-insensitively so a model-controlled
 * `http_request` `headers` arg cannot subvert routing or message framing:
 * - `host` / `:authority` — the wire `Host` is ALWAYS derived from the validated hostname. The IP-pin + SNI fix
 *   the TRANSPORT destination, but a shared/CDN/reverse-proxy IP routes at the APPLICATION layer by `Host`, so a
 *   model-set `Host` could send an `allowedDomains`-approved, correctly-pinned request to a DIFFERENT virtual
 *   host at the same IP (virtual-host-confusion SSRF the pin/SNI alone don't stop).
 * - `content-length` / `transfer-encoding` — Node computes the framing from the actual body bytes. A model-set
 *   `content-length` that MISMATCHES the body is a classic HTTP request-smuggling primitive (the surplus bytes
 *   are parsed as a SECOND, fully attacker-controlled request — forged `Host` included — on a keep-alive
 *   connection), bypassing the very Host-strip above; letting Node own the framing closes it.
 * - `connection` / `keep-alive` / `proxy-connection` / `te` / `upgrade` / `expect` — hop-by-hop / protocol-
 *   negotiation headers a caller has no business setting (connection reuse, 100-continue, protocol upgrade).
 * - `x-forwarded-*` / `forwarded` — a model-set forwarding header can reroute a proxy-trusting target to a
 *   different backend vhost / spoof the source IP its ACLs see (the vhost-confusion class, one hop deeper).
 * The legitimate `authorization` credential header (attached host-side) is untouched.
 *
 * Independently of the name filter, a header whose NAME is not a legal HTTP token or whose VALUE carries a
 * CR / LF / NUL is DROPPED — so a model cannot inject a second header/request line (request splitting) even if
 * a future `openConnection` transport is swapped for one that doesn't itself reject those (the default Node dep
 * does, but this shared SSRF primitive must not delegate that guarantee).
 */
const STRIPPED_HOP_HEADERS: ReadonlySet<string> = new Set([
  'host',
  ':authority',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'expect',
  'x-forwarded-host',
  'x-forwarded-for',
  'x-forwarded-proto',
  'forwarded',
]);

/** A legal HTTP header field-name is one or more RFC 7230 `tchar`s. Linear (single class), no backtracking. */
const HTTP_TOKEN_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function sanitizeHopHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_HOP_HEADERS.has(key.trim().toLowerCase())) continue;
    if (!HTTP_TOKEN_NAME.test(key)) continue; // a non-token name (space/CRLF/`:authority`-style) is dropped
    if (/[\r\n\0]/.test(value)) continue; // a CR/LF/NUL in the value would splice a second header/request line
    out[key] = value;
  }
  return out;
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
 * The shared timeout + abort + error-normalization wrapper. Composes the caller's `signal` with a timeout into
 * one `AbortController`, RACES `fn(controller.signal)` against a hard timeout, and guarantees the ONLY thrown
 * type is a typed, secret-free {@link SafeEgressError} — every raw resolver / socket / `new URL` / body-read
 * error becomes `SafeEgressError('network')`, never a raw leak.
 *
 * The timeout does BOTH: it `abort()`s the controller (cooperative cancellation) AND rejects the race after
 * `timeoutMs`, so the CALLER is always unblocked at the deadline — even for an `fn` that ignores its signal.
 *
 * CANCELLATION SCOPE: the abort reaches the CONNECTION phase (`openConnection` passes the signal to
 * `https.request`, which tears the socket down), but NOT the DNS-resolution phase — Node's
 * `dns.promises.lookup` is not abortable, so a hung authoritative resolver keeps a background `getaddrinfo`
 * running (a libuv threadpool slot) until the OS resolver's own timeout, even though the deadline already
 * rejected the caller. The deadline bounds the caller's wait, not that background resource.
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abort(); // still cancel the inner op (a signal-honoring fn tears down); the reject guards a signal-ignoring one
      reject(new SafeEgressError('network', 'egress request timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof SafeEgressError) {
      throw error; // a typed failure (blocked_host / too_large / bad_status / timeout / …) — preserve the discriminant
    }
    // Any RAW throw is normalized to the typed, secret-free network failure.
    throw new SafeEgressError('network', 'egress request failed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
      // Dispatch on the VALIDATED scheme, never on the url's own text. `http` reaches here only for an
      // authored local endpoint that resolved private (ADR-0088 §4); everything else was refused upstream,
      // so this branch cannot be reached by a crafted url alone.
      const send = request.scheme === 'http' ? httpRequest : httpsRequest;
      const clientRequest = send(
        {
          protocol: `${request.scheme}:`,
          hostname: request.hostname,
          // The URL's port is honored as-is — a public CDN/API URL may legitimately serve over a non-443
          // HTTPS port. Safe under the default wiring (no `localEndpoint`): the private/loopback/link-local
          // IP range block (`resolveValidatedIps`) prevents reaching an internal service on ANY port, so no
          // port allow-list is needed there. **`SEC-EGRESS-3`'s required port decision is now made**, in the
          // one place that relaxes the range block: `LocalEndpoint` is a `host:port` pair and the target must
          // match BOTH, so an opted-in `localhost:4000` cannot reach `localhost:6379` (ADR-0088 §4).
          port: parsed.port === '' ? (request.scheme === 'http' ? 80 : 443) : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          method: request.method,
          ...(request.headers === undefined ? {} : { headers: request.headers }),
          // SNI + certificate hostname — TLS verification stays ON. Meaningless on the plaintext local
          // branch (there is no TLS to verify), and harmless there: `node:http` ignores it.
          servername: request.hostname,
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
