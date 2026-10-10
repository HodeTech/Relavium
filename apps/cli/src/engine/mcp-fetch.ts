import {
  connectValidated,
  isRedirectStatus,
  nodeEgressDeps,
  SafeEgressError,
  type EgressDeps,
  type EgressMethod,
  type EgressWorkOptions,
  type HopResponse,
  type LocalEndpoint,
} from '@relavium/db';
import { INGRESS_BOUNDS } from '@relavium/mcp';
import { EgressWorkScope, egressWorkEntryFailure } from './egress-work.js';

/**
 * The validated `fetch` the `http` / `sse` MCP transports connect through
 * ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.1–§3).
 *
 * **Why MCP needs its own rather than reusing `validated-fetch.ts`.** Both route every request through the one
 * shared `connectValidated` hop, and neither re-implements a URL parser. They differ on the two things this
 * boundary decides differently:
 *
 * 1. **A redirect is REFUSED, not followed.** `validated-fetch.ts` never sees one (the OpenAI SDK's endpoints
 *    do not redirect); here it is a decision. An MCP server is identified by the exact url its author wrote —
 *    and, for a local endpoint, by an exact `host:port`. A redirect changes which server the session is
 *    talking to, and no range-block expresses "and it is still the one the user chose". Refusal is also
 *    provable from the outside: no hop count, no re-validation ordering, no partial state. ADR-0053 §2 had
 *    assumed per-hop re-validation; §3 of ADR-0088 records why the stricter mechanism replaced it.
 * 2. **It carries the local-endpoint policy.** `allow_local_endpoint` is per-server, so the `host:port` scope
 *    travels with the fetch rather than being a property of the process.
 *
 * **§5's transport-level byte bound lives here**, because this is the only place in the MCP path that sees raw
 * bytes before anything parses them — which is exactly what makes it a bound on peak MEMORY rather than on
 * what is admitted. §6's whole invariant ("an unbounded transport must be local and opted into") rests on
 * `http`/`sse` having it.
 */

/** The `fetch` shape the MCP transports take — structurally the SDK's `FetchLike`, in our own terms. */
export interface McpFetchWorkOptions extends EgressWorkOptions {
  readonly signal?: AbortSignal;
}

export type McpFetch = (
  url: string | URL,
  init?: RequestInit,
  options?: McpFetchWorkOptions,
) => Promise<Response>;

/** Statuses that MUST carry a null body (a `Response` with a body and one of these throws). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Is this response an SSE stream — the only body shape with message boundaries we may reset a counter on?
 *
 * **The bound reset on blank lines in EVERY body, and that is a hole with a measured exploit.** A JSON body
 * has no delimiters: trailing whitespace is legal and unbounded, so `"{}" + "\n\n".repeat(10000)` was
 * accepted against a 4-BYTE configured bound — 20 002 raw bytes admitted — because every blank line zeroed
 * the counter. The SDK then calls `Response.json()` on the POST path, which buffers the whole body, so this
 * was the §5 peak-memory guarantee failing on its own terms rather than a cosmetic miscount.
 *
 * Matched on the media type only, case-insensitively, with any `; charset=…` ignored.
 */
function isEventStream(headers: Readonly<Record<string, string>>): boolean {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-type') continue;
    return (value.split(';')[0] ?? '').trim().toLowerCase() === 'text/event-stream';
  }
  return false;
}

export interface McpFetchConfig {
  /** The authored local endpoint this server may reach, when it opted in. Absent ⇒ remote rules apply. */
  readonly localEndpoint?: LocalEndpoint;
  /** Injectable DNS + pinned connect (Node by default; faked in tests so the policy is deterministic). */
  readonly deps?: EgressDeps;
  /** Override the per-message byte bound (tests use a small one); defaults to §5's 4 MiB. */
  readonly maxMessageBytes?: number;
}

/**
 * Build the validated `fetch` for one MCP server.
 *
 * Deliberately does NOT impose a working deadline of its own: the connect and every request are already
 * bounded by {@link MCP_DEADLINES} one layer up, and a second timer here would make which error surfaces a
 * scheduler question — the shape §1.1 already had to correct once.
 */
export function createMcpFetch(config: McpFetchConfig = {}): McpFetch {
  const deps = config.deps ?? nodeEgressDeps;
  const maxMessageBytes = config.maxMessageBytes ?? INGRESS_BOUNDS.transportMessageBytes;
  return async (input, init, options) => {
    let work: EgressWorkScope | undefined;
    try {
      const caller = toAbortSignal(init?.signal);
      const signal =
        options?.signal === undefined ? caller : AbortSignal.any([caller, options.signal]);
      assertActive(signal);
      work = new EgressWorkScope(options);
      const scope = work;
      const raw = scope.retainWork(async () => {
        const url = typeof input === 'string' ? input : input.href;
        const method = normalizeMethod(init?.method);
        const headers = headersToRecord(init?.headers);
        const body = await scope.retainWork(() => bodyToString(init?.body));
        assertActive(signal);
        const hop = await scope.retainWork(() =>
          connectValidated(
            url,
            {
              method,
              ...(config.localEndpoint === undefined
                ? {}
                : { localEndpoint: config.localEndpoint }),
              ...(headers === undefined ? {} : { headers }),
              ...(body === undefined ? {} : { body }),
            },
            deps,
            signal,
            scope,
          ),
        );
        if (signal.aborted) {
          hop.dispose();
          assertActive(signal);
        }
        if (isRedirectStatus(hop.status)) {
          hop.dispose();
          throw new SafeEgressError(
            'insecure_url',
            'an MCP endpoint may not redirect — declare the final url',
          );
        }
        return toResponse(hop, maxMessageBytes, scope, signal);
      });
      return await raceCancellation(raw, signal);
    } catch (error) {
      const entry = egressWorkEntryFailure(error);
      if (entry !== undefined) throw entry.error;
      throw error instanceof SafeEgressError
        ? error
        : new SafeEgressError('network', 'MCP egress request failed');
    } finally {
      work?.seal();
    }
  };
}

/** The four methods the shared hop supports; anything else is refused loudly rather than downgraded. */
const EGRESS_METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const satisfies readonly EgressMethod[];

function normalizeMethod(raw: string | undefined): EgressMethod {
  const method = (raw ?? 'GET').toUpperCase();
  if (!(EGRESS_METHODS as readonly string[]).includes(method)) {
    throw new SafeEgressError('network', `unsupported egress method '${method}'`);
  }
  // The `includes` above narrows nothing for the compiler, so re-derive by lookup rather than by assertion —
  // the project forbids an unsafe `as`, and a `find` keeps the value the union's own member.
  const known = EGRESS_METHODS.find((candidate) => candidate === method);
  if (known === undefined) {
    throw new SafeEgressError('network', `unsupported egress method '${method}'`);
  }
  return known;
}

/**
 * A real `AbortSignal` for the hop.
 *
 * `connectValidated` takes one, and the SDK hands us whatever it put on the `RequestInit` — which is the
 * bridged, per-request signal `packages/mcp` built, so it is already real. An absent one becomes a never-
 * aborting controller rather than being faked away: the deadlines one layer up are what bound this call.
 */
function toAbortSignal(signal: AbortSignal | null | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

/** Flatten a `RequestInit['headers']` to a plain record; `connectValidated` re-sanitizes it. */
function headersToRecord(
  headers: RequestInit['headers'],
): Readonly<Record<string, string>> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    // Never negotiate compression: this fetch does not auto-decompress, so a gzip'd body would reach the SDK
    // as bytes it cannot parse. Same reason the provider-side validated fetch drops it.
    if (key === 'accept-encoding') return;
    out[key] = value;
  });
  return out;
}

/** Read a request body to a string — the MCP wire is JSON, so this is the whole shape in practice. */
async function bodyToString(body: RequestInit['body']): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return await new Response(body).text();
}

/** Map a validated hop to a `Response` with a backpressure-aware, byte-bounded streaming body. */
function toResponse(
  hop: HopResponse,
  maxMessageBytes: number,
  work: EgressWorkScope,
  signal: AbortSignal,
): Response {
  if (hop.status < 200 || hop.status > 599) {
    hop.dispose();
    throw new SafeEgressError('network', 'egress returned an out-of-range HTTP status');
  }
  let prepared: ReturnType<typeof hopBodyToStream> | undefined;
  try {
    const headers = new Headers(hop.headers ?? {});
    if (NULL_BODY_STATUS.has(hop.status) || headers.get('content-length') === '0') {
      hop.dispose();
      return new Response(null, { status: hop.status, headers });
    }
    prepared = hopBodyToStream(
      hop,
      maxMessageBytes,
      isEventStream(hop.headers ?? {}),
      work,
      signal,
    );
    return new Response(prepared.stream, { status: hop.status, headers });
  } catch (error) {
    prepared?.close();
    hop.dispose();
    throw error instanceof SafeEgressError
      ? error
      : new SafeEgressError('network', 'egress response could not be mapped');
  }
}

/**
 * Wrap the hop's live `AsyncIterable` body in a pull-based, **per-message byte-bounded** `ReadableStream`.
 *
 * Pull-based rather than an eager drain because the Streamable HTTP transport's GET stream is long-lived: an
 * MCP session's server-to-client messages arrive over one response that stays open for the whole session, so
 * buffering it would be both a memory-bound violation and a session that never starts.
 *
 * **Which is exactly why the bound is per MESSAGE and not per body** (ADR-0088 §5.4). A whole-body cap would
 * kill a healthy session at whatever moment it had streamed enough — the bound would fire on success. The
 * counter therefore resets at each SSE event boundary, which yields the property that is actually wanted —
 * bounded peak memory — and not the one that cannot be had for a stream with no defined length: a bounded
 * total. A plain JSON response has no delimiter, so the whole body is one "message", which is the correct
 * reading for the POST path.
 *
 * **A boundary is a BLANK LINE, not a newline**, and a review caught the difference mattering: an earlier
 * version reset on any `\n`, and a mutation making that explicit stayed green because every fixture used
 * either no embedded newline or a doubled one. But an SSE event is legitimately multi-line — several `data:`
 * lines before the terminating blank line — so resetting per line would have let a hostile server stream an
 * arbitrarily large single logical message past this bound, one line at a time. That is precisely the bound's
 * reason to exist.
 *
 * All three SSE line terminators are honoured — `\n`, `\r\n`, and a lone `\r` — because the spec permits
 * each, and a counter that only knew `\n` would never reset against a CRLF server: the bound would then fire
 * on a perfectly healthy stream. The CR/LF state carries ACROSS chunks, so a server writing one byte at a
 * time still resets.
 */
function hopBodyToStream(
  hop: HopResponse,
  maxMessageBytes: number,
  eventStream: boolean,
  parent: EgressWorkScope,
  signal: AbortSignal,
): { readonly stream: ReadableStream<Uint8Array>; readonly close: () => void } {
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
  let returned = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let messageBytes = 0;
  // Boundary state, carried ACROSS chunks: whether the previous byte ended a line, and whether it was a CR
  // whose LF is still to come. A server that writes one byte at a time is the reason both must survive.
  let afterTerminator = false;
  let pendingCr = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    hop.dispose();
  };
  /**
   * Charge a chunk's bytes against the current message, resetting at each SSE event boundary. Returns `false`
   * the moment ANY message segment crosses the bound.
   *
   * **Checked inside the scan, not after it**, and a mutation is what proved that matters: an earlier version
   * returned `sawBoundary || messageBytes <= max`, so a chunk carrying a 10 MB message FOLLOWED by a `\n\n`
   * passed — the reset had already zeroed the counter by the time the comparison ran, and the boundary flag
   * excused it outright. A bound that only looks at the tail of a chunk is not a bound.
   */
  const chargeAndReset = (chunk: Uint8Array): boolean => {
    if (!eventStream) {
      // **A body with no message framing is ONE message, delimiters included.** No resets, and the newline
      // bytes are charged like any other: a JSON response's trailing whitespace is unbounded and legal, so a
      // counter that skipped it (or zeroed on it) bounded nothing at all.
      messageBytes += chunk.length;
      return messageBytes <= maxMessageBytes;
    }
    for (const byte of chunk) {
      const isCr = byte === 0x0d;
      const isLf = byte === 0x0a;
      // **Charged BEFORE any boundary handling**, so a stream of nothing but blank lines still hits the bound.
      // Skipping the delimiters made an all-delimiter body free, which is the same hole one level down.
      messageBytes += 1;
      if (messageBytes > maxMessageBytes) return false;
      if (isLf && pendingCr) {
        // The LF half of a CRLF — the CR already ended this line, so it must not end a second one.
        pendingCr = false;
        continue;
      }
      if (isCr || isLf) {
        pendingCr = isCr;
        if (afterTerminator) {
          // A BLANK LINE: the SSE event boundary. The next message starts from zero.
          messageBytes = 0;
          afterTerminator = false;
        } else {
          afterTerminator = true;
        }
        continue;
      }
      pendingCr = false;
      afterTerminator = false;
    }
    return true;
  };
  const returnIterator = (): void => {
    if (returned) return;
    returned = true;
    try {
      const close = iterator.return?.bind(iterator);
      if (close !== undefined) {
        const raw = body.retainWork(() => close(undefined));
        void raw.catch(() => {
          // Cleanup is best effort; its actual settlement remains independently owed.
        });
      }
    } catch {
      // A synchronous cleanup fault settles only the operation actually entered.
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
      // Report only a fixed body diagnosis, without replacing the native-close obligation.
    }
    controller?.error(new SafeEgressError('network', 'MCP egress request cancelled'));
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
        let finishing = false;
        try {
          const next = await body.retainWork(() => iterator.next());
          if (closed) return;
          if (next.done === true) {
            finishing = true;
            finish();
            value.close();
          } else if (!chargeAndReset(next.value)) {
            finishing = true;
            finish();
            value.error(
              new SafeEgressError(
                'too_large',
                `an MCP message exceeded the maximum of ${maxMessageBytes} bytes`,
              ),
            );
          } else {
            value.enqueue(next.value);
          }
        } catch {
          // A different path already ended the stream only when this pull did not
          // start cleanup. A throwing disposer must still settle this reader.
          if (closed && !finishing) return;
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

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new SafeEgressError('network', 'MCP egress request cancelled');
}

async function raceCancellation<T>(raw: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SafeEgressError('network', 'MCP egress request cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([raw, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
