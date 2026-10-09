import {
  connectValidated,
  nodeEgressDeps,
  SafeEgressError,
  type EgressDeps,
  type EgressMethod,
  type EgressWorkOptions,
  type HopResponse,
} from '@relavium/db';

import { EgressWorkScope, egressWorkEntryFailure } from './egress-work.js';

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
 * stream at a fixed working deadline; the caller's `AbortSignal` (the OpenAI SDK's own timeout, `boundedListModels`'s
 * 15s, `validateProviderKey`'s 10s) drives cancellation and tears the socket down on connect AND during streaming.
 * A caller signal is only composed (`AbortSignal.any`) with a very generous, no-op-in-practice ceiling
 * ({@link DEFAULT_EGRESS_CEILING_MS}) that backstops a signal-less / never-firing caller against an infinite hang —
 * it sits far above every real deadline, so it never clips normal streaming. Every escaping error is normalized to a reason-only `SafeEgressError` (never the url/IP/host/key) —
 * `connectValidated`'s own throws already are, and a raw resolver/socket fault (a DNS error carries the non-secret
 * hostname) is re-wrapped here. The `Authorization` key rides the request headers to the endpoint (as the API
 * requires) but is never logged. The `EgressDeps` (DNS + connect) are injectable so the SSRF policy is
 * deterministically unit-testable without real network/DNS.
 */

/** Trusted invocation options are separate from RequestInit and never serialized by the SDK. */
export interface FetchWorkOptions extends EgressWorkOptions {
  readonly signal?: AbortSignal;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
  options?: FetchWorkOptions,
) => Promise<Response>;

/** Statuses that MUST carry a null body (a `Response` with a body + one of these throws). All ≥ 200 (a `< 200`
 *  status is itself out-of-range for `new Response` — handled by the range check in {@link toResponse}). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([204, 205, 304]);

/** Build the validated `fetch`. `deps` default to Node's real DNS + pinned-HTTPS connect. */
export function createValidatedFetch(deps: EgressDeps = nodeEgressDeps): FetchLike {
  return async (input, init, options) => {
    let work: EgressWorkScope | undefined;
    try {
      const signal = composeEgressSignal(
        init?.signal ?? (input instanceof Request ? input.signal : undefined),
        options?.signal,
      );
      assertNotCancelled(signal);
      work = new EgressWorkScope(options);
      const admitted = work;
      const raw = admitted.retainWork(async () => {
        const req = await admitted.retainWork(() => normalizeRequest(input, init, signal));
        assertNotCancelled(signal);
        const hop = await admitted.retainWork(() =>
          connectValidated(
            req.url,
            {
              // Authored custom URLs retain the existing public-only policy and pinned transport.
              method: req.method,
              ...(req.headers === undefined ? {} : { headers: req.headers }),
              ...(req.body === undefined ? {} : { body: req.body }),
            },
            deps,
            req.signal,
            admitted,
          ),
        );
        if (signal.aborted) {
          hop.dispose();
          assertNotCancelled(signal);
        }
        return toResponse(hop, admitted, signal);
      });
      return await raceCancellation(raw, signal);
    } catch (err) {
      const entryFailure = egressWorkEntryFailure(err);
      if (entryFailure !== undefined) throw entryFailure.error;
      // EVERY escaping error — a bad method (normalizeRequest), a policy/connect fault or a raw resolver/socket
      // throw (connectValidated), or a response-mapping failure — is normalized to ONE reason-only SafeEgressError
      // (never the url/IP/host/key). connectValidated's policy throws are already SafeEgressErrors (preserved).
      throw err instanceof SafeEgressError
        ? err
        : new SafeEgressError('network', 'egress request failed');
    } finally {
      work?.seal();
    }
  };
}

interface NormalizedRequest {
  readonly url: string;
  readonly method: EgressMethod;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: string | undefined;
  readonly signal: AbortSignal;
}

// `as const satisfies readonly EgressMethod[]` verifies every listed method IS a real `EgressMethod` (so the
// `isEgressMethod` narrowing is sound); a NEW union member not listed here simply isn't accepted (fails closed).
const EGRESS_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const satisfies readonly EgressMethod[];
const isEgressMethod = (method: string): method is EgressMethod =>
  (EGRESS_METHODS as readonly string[]).includes(method);

/** Resolve the request URL string from a `Request`, a `URL`, or a raw string input (no nested ternary). */
function inputToUrl(input: string | URL | Request): string {
  if (input instanceof Request) return input.url;
  if (typeof input === 'string') return input;
  return input.href;
}

/** Resolve the url / method / headers / body / signal from either a `Request` or a `(url, init)` pair. */
async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
  signal: AbortSignal,
): Promise<NormalizedRequest> {
  const isRequest = input instanceof Request;
  const url = inputToUrl(input);
  const rawMethod = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  if (!isEgressMethod(rawMethod)) {
    // The OpenAI SDK uses only GET (models.list) + POST (completions); refuse anything else loudly rather than
    // silently downgrading a method (a secret-free, typed failure the SDK surfaces as a request error).
    throw new SafeEgressError('network', `unsupported egress method '${rawMethod}'`);
  }
  let headers = headersToRecord(init?.headers ?? (isRequest ? input.headers : undefined));
  const normalizedBody = await bodyToString(init?.body ?? (isRequest ? input.body : undefined));
  if (normalizedBody.contentType !== undefined && headers?.['content-type'] === undefined) {
    headers = { ...headers, 'content-type': normalizedBody.contentType };
  }
  const body = normalizedBody.body;
  return { url, method: rawMethod, headers, body, signal };
}

/** A very generous backstop deadline (NOT a working timeout). A signal-less — or a never-firing — caller would
 *  otherwise ride an unowned `AbortController` signal that never aborts, so the request could hang forever. This
 *  ceiling sits far ABOVE every real caller deadline (the OpenAI SDK's own request timeout, `boundedListModels`'s
 *  15s, `validateProviderKey`'s 10s) and above any normal streamed completion, so a real caller's (shorter) signal
 *  always wins in practice — it never clips normal long-lived streaming, it only backstops a pathological hang. */
const DEFAULT_EGRESS_CEILING_MS = 15 * 60_000; // 15 minutes — a backstop, not a working deadline

/** Compose the caller's `AbortSignal` (if any) with the generous {@link DEFAULT_EGRESS_CEILING_MS} backstop.
 *  `AbortSignal.timeout`'s timer is unref'd, so the ceiling never keeps the process alive after a fast call, and
 *  a caller-provided signal still drives cancellation on connect AND during streaming (it fires long before this). */
function composeEgressSignal(
  callerSignal: AbortSignal | null | undefined,
  retirementSignal?: AbortSignal,
): AbortSignal {
  const ceiling = AbortSignal.timeout(DEFAULT_EGRESS_CEILING_MS);
  const signals = [ceiling];
  if (callerSignal !== undefined && callerSignal !== null) signals.push(callerSignal);
  if (retirementSignal !== undefined) signals.push(retirementSignal);
  return signals.length === 1 ? ceiling : AbortSignal.any(signals);
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new SafeEgressError('network', 'egress request cancelled');
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
): Promise<{ readonly body: string | undefined; readonly contentType?: string }> {
  if (body === undefined || body === null) return { body: undefined };
  if (typeof body === 'string') return { body };
  if (body instanceof Uint8Array) return { body: new TextDecoder().decode(body) };
  // A ReadableStream / Blob / URLSearchParams / etc. — read it through a Response (the SDK's chat path never hits this).
  const response = new Response(body);
  const contentType = response.headers.get('content-type');
  return {
    body: await response.text(),
    ...(contentType === null ? {} : { contentType }),
  };
}

/** Map a validated {@link HopResponse} to a standard `Response` with a backpressure-aware streaming body. */
function toResponse(hop: HopResponse, work: EgressWorkScope, signal: AbortSignal): Response {
  // `new Response(..., { status })` throws a RangeError for a status outside [200, 599]. A hostile custom endpoint
  // can emit a `999` (or a malformed line ⇒ `statusCode ?? 0`), so guard it into the typed, reason-only failure —
  // never a raw RangeError escaping this wrapper — and reap the socket.
  if (hop.status < 200 || hop.status > 599) {
    hop.dispose();
    throw new SafeEgressError('network', 'egress returned an out-of-range HTTP status');
  }
  let prepared: ReturnType<typeof hopBodyToStream> | undefined;
  try {
    // Validate headers before constructing an eager Web Streams body. A mapping failure must
    // close its transferred body scope as well as request native disposal.
    const headers = new Headers(hop.headers ?? {});
    if (NULL_BODY_STATUS.has(hop.status) || headers.get('content-length') === '0') {
      hop.dispose();
      return new Response(null, { status: hop.status, headers });
    }
    prepared = hopBodyToStream(hop, work, signal);
    return new Response(prepared.stream, { status: hop.status, headers });
  } catch (err) {
    prepared?.close();
    hop.dispose();
    throw err instanceof SafeEgressError
      ? err
      : new SafeEgressError('network', 'egress response could not be mapped');
  }
}

/** Wrap the HopResponse's live `AsyncIterable` body in a pull-based `ReadableStream` (backpressure — one chunk per
 *  `pull`, not an eager drain), disposing the socket on end / error / cancel. */
function hopBodyToStream(
  hop: HopResponse,
  parent: EgressWorkScope,
  signal: AbortSignal,
): { readonly stream: ReadableStream<Uint8Array>; readonly close: () => void } {
  // Transfer before iterator acquisition or the eager first Web Streams pull.
  const body = parent.fork();
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = hop.body[Symbol.asyncIterator]();
  } catch (error) {
    body.seal();
    hop.dispose();
    throw error;
  }
  let closed = false;
  let disposed = false;
  let returnStarted = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    hop.dispose();
  };
  const returnIterator = (): void => {
    if (returnStarted) return;
    returnStarted = true;
    try {
      const close = iterator.return?.bind(iterator);
      if (close === undefined) return;
      const returned = body.retainWork(() => close(undefined));
      void returned.catch(() => {
        // Existing best-effort source cleanup: rejection is observed, actual settlement still owed.
      });
    } catch {
      // A synchronous source return fault completes only that entered operation.
    }
  };
  const finish = (): void => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', onAbort);
    try {
      dispose();
    } finally {
      returnIterator();
      body.seal();
    }
  };
  const onAbort = (): void => {
    try {
      finish();
    } catch {
      // The controller below reports a fixed diagnosis; native close still has its own retained ACK.
    }
    controller?.error(new SafeEgressError('network', 'egress request cancelled'));
  };
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      },
      async pull(value) {
        if (closed) return;
        try {
          const next = await body.retainWork(() => iterator.next());
          // A cancellation can win while the source ignores it. Its late result grants no fresh pull
          // and must never enqueue into an already closed or cancelled Web Streams controller.
          if (closed) return;
          if (next.done === true) {
            try {
              finish();
            } catch {
              value.error(new SafeEgressError('network', 'egress response cleanup failed'));
              return;
            }
            value.close();
          } else {
            value.enqueue(next.value);
          }
        } catch {
          if (closed) return;
          try {
            finish();
          } finally {
            value.error(new SafeEgressError('network', 'egress response body read failed'));
          }
        }
      },
      cancel() {
        try {
          finish();
        } catch {
          throw new SafeEgressError('network', 'egress response cleanup failed');
        }
      },
    });
    return { stream, close: finish };
  } catch (error) {
    finish();
    throw error;
  }
}

/** Cancel the public wait while its exact admitted producer and descendants stay retained. */
async function raceCancellation<T>(raw: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SafeEgressError('network', 'egress request cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([raw, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
