import {
  connectValidated,
  isRedirectStatus,
  nodeEgressDeps,
  SafeEgressError,
  type EgressDeps,
  type EgressMethod,
  type HopResponse,
  type LocalEndpoint,
} from '@relavium/db';
import { INGRESS_BOUNDS } from '@relavium/mcp';

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
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Statuses that MUST carry a null body (a `Response` with a body and one of these throws). */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([204, 205, 304]);

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
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.href;
    const method = normalizeMethod(init?.method);
    const headers = headersToRecord(init?.headers);
    const body = await bodyToString(init?.body);

    const hop = await connectValidated(
      url,
      {
        method,
        ...(config.localEndpoint === undefined ? {} : { localEndpoint: config.localEndpoint }),
        ...(headers === undefined ? {} : { headers }),
        ...(body === undefined ? {} : { body }),
      },
      deps,
      toAbortSignal(init?.signal),
    );

    if (isRedirectStatus(hop.status)) {
      // Never read a redirect body, and never follow it. The author declared a url; a `3xx` says the server
      // is somewhere else, which is a configuration answer rather than something to resolve at runtime.
      hop.dispose();
      throw new SafeEgressError(
        'insecure_url',
        'an MCP endpoint may not redirect — declare the final url',
      );
    }
    return toResponse(hop, maxMessageBytes);
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
function toResponse(hop: HopResponse, maxMessageBytes: number): Response {
  if (hop.status < 200 || hop.status > 599) {
    // `new Response(…, { status })` throws for a status outside [200, 599]; a hostile endpoint can emit one.
    hop.dispose();
    throw new SafeEgressError('network', 'egress returned an out-of-range HTTP status');
  }
  const headers = hop.headers ?? {};
  // **Both arms map through the same guard.** `new Response(…, { headers })` runs the `Headers` constructor,
  // which throws a raw `TypeError` on a name or value it considers invalid — and these headers come from a
  // hostile server, flattened out of Node's parser, which does not agree with `undici`'s validator in every
  // case. The streaming arm already converted that into a typed `SafeEgressError`; the null-body arm did not,
  // so a `204` with a malformed header name escaped this module as an untyped throw. The socket was never at
  // risk (`dispose` runs first either way) — the error TYPE was, and every caller here classifies on it.
  if (NULL_BODY_STATUS.has(hop.status)) {
    hop.dispose();
    return mapResponse(() => new Response(null, { status: hop.status, headers }));
  }
  return mapResponse(
    () => new Response(hopBodyToStream(hop, maxMessageBytes), { status: hop.status, headers }),
    hop,
  );
}

/**
 * Build a `Response`, converting a constructor throw into a typed {@link SafeEgressError}.
 *
 * `hop` is passed only where the socket is still live: the null-body arm has already disposed, and disposing
 * twice would be harmless but would misstate who owns the teardown.
 */
function mapResponse(build: () => Response, hop?: HopResponse): Response {
  try {
    return build();
  } catch (err) {
    hop?.dispose();
    throw err instanceof SafeEgressError
      ? err
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
function hopBodyToStream(hop: HopResponse, maxMessageBytes: number): ReadableStream<Uint8Array> {
  const iterator = hop.body[Symbol.asyncIterator]();
  let disposed = false;
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
    for (const byte of chunk) {
      const isCr = byte === 0x0d;
      const isLf = byte === 0x0a;
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
      messageBytes += 1;
      if (messageBytes > maxMessageBytes) return false;
    }
    return true;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
          dispose();
        } else if (!chargeAndReset(next.value)) {
          // Refused mid-stream: the socket is reaped and the consumer sees a typed error rather than a
          // truncated message, which for a JSON-RPC frame would be a parse failure with no explanation.
          dispose();
          controller.error(
            new SafeEgressError(
              'too_large',
              `an MCP message exceeded the maximum of ${maxMessageBytes} bytes`,
            ),
          );
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        dispose();
        controller.error(new SafeEgressError('network', 'egress response body read failed'));
      }
    },
    cancel() {
      dispose();
      try {
        const returned = iterator.return?.(undefined);
        if (returned !== undefined) {
          returned.catch(() => {
            // best-effort cleanup; a cancel must never throw
          });
        }
      } catch {
        // a synchronous return() throw is best-effort cleanup, never propagated
      }
    },
  });
}
