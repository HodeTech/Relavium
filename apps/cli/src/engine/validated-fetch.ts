import {
  connectValidated,
  nodeEgressDeps,
  SafeEgressError,
  type EgressDeps,
  type EgressMethod,
  type HopResponse,
} from '@relavium/db';

/**
 * A `fetch`-shaped function that routes EVERY request through the ONE shared host-side SSRF hop
 * ([safe-egress.ts](../../../../packages/db/src/safe-egress.ts) `connectValidated`: HTTPS + no-creds →
 * DNS-resolve → range-block **every** resolved IP → connect **pinned** to the validated IP with the hostname as
 * SNI). It is injected as the OpenAI SDK's `fetch` for a provider that carries a **custom `base_url`** (2.5.G S9,
 * [ADR-0065](../../../../docs/decisions/0065-provider-economics-and-extensibility.md) §4) — so BOTH the
 * streaming chat (`generate`/`stream`) AND the `models.list` refresh over that custom endpoint ride the same
 * DNS-rebinding-safe validated hop, never a second hand-rolled URL parser (the ADR-0029(d) one-primitive rule).
 *
 * **Streaming-safe:** `connectValidated` returns a LIVE `AsyncIterable` body (it never buffers — `readBounded` is
 * a separate helper), which this wraps in a **backpressure-aware** `ReadableStream`, so an SSE completion streams
 * chunk-by-chunk. It deliberately does NOT wrap the call in `withEgressTimeout` — that would abort a long-lived
 * stream at a fixed deadline; the caller's `AbortSignal` (the OpenAI SDK's own timeout, `boundedListModels`'s 15s,
 * `validateProviderKey`'s 10s) is threaded straight through and tears the socket down on connect AND during
 * streaming. Every escaping error is normalized to a reason-only `SafeEgressError` (never the url/IP/host/key) —
 * `connectValidated`'s own throws already are, and a raw resolver/socket fault (a DNS error carries the non-secret
 * hostname) is re-wrapped here. The `Authorization` key rides the request headers to the endpoint (as the API
 * requires) but is never logged. The `EgressDeps` (DNS + connect) are injectable so the SSRF policy is
 * deterministically unit-testable without real network/DNS.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Statuses that MUST carry a null body (a `Response` with a body + one of these throws). All ≥ 200 (a `< 200`
 *  status is itself out-of-range for `new Response` — handled by the range check in {@link toResponse}). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([204, 205, 304]);

/** Build the validated `fetch`. `deps` default to Node's real DNS + pinned-HTTPS connect. */
export function createValidatedFetch(deps: EgressDeps = nodeEgressDeps): FetchLike {
  return async (input, init) => {
    const req = await normalizeRequest(input, init);
    let hop: HopResponse;
    try {
      hop = await connectValidated(
        req.url,
        {
          allowPrivate: false, // a custom base_url resolving to a private/loopback/metadata address is REFUSED
          method: req.method,
          ...(req.headers === undefined ? {} : { headers: req.headers }),
          ...(req.body === undefined ? {} : { body: req.body }),
        },
        deps,
        req.signal,
      );
    } catch (err) {
      // connectValidated's policy throws are already typed SafeEgressErrors; a raw resolver/socket fault (e.g. a
      // DNS error carrying the non-secret hostname) is re-wrapped so ONLY a reason-only SafeEgressError escapes.
      throw err instanceof SafeEgressError
        ? err
        : new SafeEgressError('network', 'egress connect failed');
    }
    return toResponse(hop);
  };
}

interface NormalizedRequest {
  readonly url: string;
  readonly method: EgressMethod;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: string | undefined;
  readonly signal: AbortSignal;
}

// The `as const satisfies` keeps this set in LOCKSTEP with the `EgressMethod` union — adding one here without
// updating the union (or vice versa) is a compile error, so the `isEgressMethod` narrowing below stays sound.
const EGRESS_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const satisfies readonly EgressMethod[];
const isEgressMethod = (method: string): method is EgressMethod =>
  (EGRESS_METHODS as readonly string[]).includes(method);

/** Resolve the url / method / headers / body / signal from either a `Request` or a `(url, init)` pair. */
async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : typeof input === 'string' ? input : input.href;
  const rawMethod = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (!isEgressMethod(rawMethod)) {
    // The OpenAI SDK uses only GET (models.list) + POST (completions); refuse anything else loudly rather than
    // silently downgrading a method (a secret-free, typed failure the SDK surfaces as a request error).
    throw new SafeEgressError('network', `unsupported egress method '${rawMethod}'`);
  }
  const headers = headersToRecord(init?.headers ?? (isRequest ? input.headers : undefined));
  const body = await bodyToString(init?.body ?? (isRequest ? input.body : undefined));
  const signal = init?.signal ?? (isRequest ? input.signal : undefined) ?? new AbortController().signal;
  return { url, method: rawMethod, headers, body, signal };
}

/** Flatten a `RequestInit['headers']` (Headers | record | pairs) to a plain record; connectValidated re-sanitizes it.
 *  `new Headers(...)` normalizes every `HeadersInit` form (and lower-cases the keys) in one step. Drops
 *  `accept-encoding`: this fetch does NOT auto-decompress the streamed body (unlike a platform `fetch`), so it must
 *  never negotiate compression — else a gzip'd response would reach the SDK as raw bytes it can't parse. */
function headersToRecord(
  headers: RequestInit['headers'],
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    if (key === 'accept-encoding') return; // never negotiate compression — we stream the body verbatim
    out[key] = value;
  });
  return out;
}

/** Read a request body to a string (connectValidated frames a string body). A chat body is already a JSON string. */
async function bodyToString(
  body: RequestInit['body'] | ReadableStream<Uint8Array> | null,
): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  // A ReadableStream / Blob / URLSearchParams / etc. — read it through a Response (the SDK's chat path never hits this).
  return await new Response(body).text();
}

/** Map a validated {@link HopResponse} to a standard `Response` with a backpressure-aware streaming body. */
function toResponse(hop: HopResponse): Response {
  // `new Response(..., { status })` throws a RangeError for a status outside [200, 599]. A hostile custom endpoint
  // can emit a `999` (or a malformed line ⇒ `statusCode ?? 0`), so guard it into the typed, reason-only failure —
  // never a raw RangeError escaping this wrapper — and reap the socket.
  if (hop.status < 200 || hop.status > 599) {
    hop.dispose();
    throw new SafeEgressError('network', 'egress returned an out-of-range HTTP status');
  }
  const headers = hop.headers ?? {};
  if (NULL_BODY_STATUS.has(hop.status)) {
    hop.dispose(); // a null-body status must not carry a stream — reap the (empty) socket
    return new Response(null, { status: hop.status, headers });
  }
  return new Response(hopBodyToStream(hop), { status: hop.status, headers });
}

/** Wrap the HopResponse's live `AsyncIterable` body in a pull-based `ReadableStream` (backpressure — one chunk per
 *  `pull`, not an eager drain), disposing the socket on end / error / cancel. */
function hopBodyToStream(hop: HopResponse): ReadableStream<Uint8Array> {
  const iterator = hop.body[Symbol.asyncIterator]();
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    hop.dispose();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
          dispose();
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        // A body-read/socket fault — never surface the raw error (it can carry the host/IP), and reap the socket.
        dispose();
        controller.error(new SafeEgressError('network', 'egress response body read failed'));
      }
    },
    cancel() {
      dispose();
      void iterator.return?.(undefined);
    },
  });
}
