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
 * chunk-by-chunk. **Secret-free:** `connectValidated`'s failures are reason-only `SafeEgressError`s (never the
 * url/IP/host), and a body-read fault is normalized to a generic message — the `Authorization` key rides the
 * request headers to the endpoint (as the API requires) but is never logged. The `EgressDeps` (DNS + connect) are
 * injectable so the SSRF policy is deterministically unit-testable without real network/DNS.
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Statuses that MUST carry a null body (a `Response` with a body + one of these throws). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/** Build the validated `fetch`. `deps` default to Node's real DNS + pinned-HTTPS connect. */
export function createValidatedFetch(deps: EgressDeps = nodeEgressDeps): FetchLike {
  return async (input, init) => {
    const req = await normalizeRequest(input, init);
    const hop = await connectValidated(
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

const EGRESS_METHODS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/** Resolve the url / method / headers / body / signal from either a `Request` or a `(url, init)` pair. */
async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> {
  const isRequest = input instanceof Request;
  const url = isRequest ? input.url : typeof input === 'string' ? input : input.href;
  const rawMethod = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (!EGRESS_METHODS.has(rawMethod)) {
    // The OpenAI SDK uses only GET (models.list) + POST (completions); refuse anything else loudly rather than
    // silently downgrading a method (a secret-free, typed failure the SDK surfaces as a request error).
    throw new SafeEgressError('network', `unsupported egress method '${rawMethod}'`);
  }
  const method = rawMethod as EgressMethod; // narrowed by the membership check above (a safe widening, not an unsound cast)
  const headers = headersToRecord(init?.headers ?? (isRequest ? input.headers : undefined));
  const body = await bodyToString(init?.body ?? (isRequest ? input.body : undefined));
  const signal = init?.signal ?? (isRequest ? input.signal : undefined) ?? new AbortController().signal;
  return { url, method, headers, body, signal };
}

/** Flatten a `RequestInit['headers']` (Headers | record | pairs) to a plain record; connectValidated re-sanitizes it.
 *  `new Headers(...)` normalizes every `HeadersInit` form (and lower-cases the keys) in one step. */
function headersToRecord(
  headers: RequestInit['headers'],
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
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
