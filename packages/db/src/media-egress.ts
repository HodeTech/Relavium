import type { AbortSignalLike } from '@relavium/shared';

import {
  connectValidated,
  isRedirectStatus,
  nodeEgressDeps,
  readBounded,
  streamBounded,
  SafeEgressError,
  withEgressTimeout,
  type EgressDeps,
  type LocalEndpoint,
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
   * How long a STREAMED body may go with no progress before it is abandoned (default 30000). Streaming
   * only — the whole-buffer form reads inside `withEgressTimeout`, which already bounds it end to end.
   */
  readonly bodyIdleTimeoutMs?: number;
  /**
   * Cancels the fetch (composed with the timeout). Typed as the platform-free `AbortSignalLike` so the
   * engine's `AbortControllerLike.signal` (the run abort) wires in without a cast at the `HostMediaFetch`
   * boundary; a real `AbortSignal` structurally satisfies it.
   */
  readonly signal?: AbortSignalLike;
  /**
   * The ONE authored local endpoint this fetch may reach — the BYOK explicit local-endpoint opt-in
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §4, which resolves the
   * "behind a fresh ADR" deferral [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)
   * §3 left for exactly this seam). Absent — the default, and every caller today — blocks
   * private/loopback/link-local/metadata addresses.
   *
   * It replaced a bare `allowPrivate: boolean` when MCP became the first real consumer: a boolean says
   * "private is fine", which is one flag away from also saying "plaintext to anywhere is fine". A
   * `host:port` says which private endpoint, which is the port-allow-list decision `SEC-EGRESS-3` requires.
   */
  readonly localEndpoint?: LocalEndpoint;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long a streamed body may go with NO progress before it is abandoned (`CR-53` review).
 *
 * An IDLE bound, not a total one, and the distinction is the whole design. `withEgressTimeout` covers the
 * CONNECT and then tears its timer and its abort listener down — so once the response arrives the body
 * phase had neither a deadline nor a cancellation, which is a slow-loris hole and an uncancellable read
 * (the liveness property `W2`/[ADR-0085](../../../docs/decisions/0085-the-node-executor-owes-liveness-and-the-engine-enforces-it.md)
 * established, regressed on a new path).
 *
 * A TOTAL deadline would be wrong here: a legitimate 25 MiB video on a slow link can outlast any connect
 * timeout, and killing it would trade a hang for a false failure. Idle time is the honest signal — a
 * transfer that is making progress is not stuck, however long it takes; one that has produced nothing for
 * this long is. The size ceiling remains the bound on how much it may deliver.
 */
const BODY_IDLE_TIMEOUT_MS = 30_000;
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
  const localEndpoint = options.localEndpoint;
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
          {
            method: 'GET',
            ...(localEndpoint === undefined ? {} : { localEndpoint }),
          },
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

/**
 * The STREAMING form of {@link fetchMediaBytes}
 * ([ADR-0089](../../../docs/decisions/0089-media-correctness-four-boundaries.md) §2) — identical policy,
 * yielded instead of buffered.
 *
 * Same SSRF-validated connect, same per-hop redirect re-validation, same `200`-only rule, same size ceiling
 * and same `MediaEgressError` normalization; the only difference is that the ceiling is enforced against the
 * stream as the consumer pulls it, so a body that would have exceeded it is aborted part-way rather than
 * downloaded whole and then rejected. This is the function the media path uses; the whole-buffer twin stays
 * for a caller that already knows its body is sub-ceiling.
 *
 * It is an async GENERATOR rather than a `Promise<AsyncIterable>` so the connect happens on first pull: a
 * consumer that never iterates never opens a socket, and the timeout window starts when the body is wanted.
 */
export async function* streamMediaBytes(
  url: string,
  options: FetchMediaBytesOptions,
  deps: EgressDeps = nodeEgressDeps,
): AsyncIterable<Uint8Array> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const localEndpoint = options.localEndpoint;
  // `withEgressTimeout` wraps a promise, not a stream, so it is used to establish the CONNECTION (including
  // every redirect hop) and the body is then streamed outside it. The run `AbortSignal` still bounds the
  // read: it is threaded into the connect, and aborting it destroys the socket the body is coming from.
  const connected = await withEgressTimeout(
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
          { method: 'GET', ...(localEndpoint === undefined ? {} : { localEndpoint }) },
          deps,
          signal,
        );
        if (isRedirectStatus(response.status)) {
          response.dispose(); // never read a redirect body
          const location = response.location;
          if (location === undefined || location.length === 0) {
            throw new SafeEgressError('bad_status', 'media egress redirect had no Location');
          }
          target = new URL(location, target).toString();
          continue;
        }
        if (response.status !== 200) {
          response.dispose();
          throw new SafeEgressError('bad_status', 'media egress received a non-200 status');
        }
        return response;
      }
    },
  );
  // The body phase gets its OWN liveness: an idle deadline and a link to the caller's signal, neither of
  // which survives `withEgressTimeout`'s teardown. `dispose` destroys the socket, so both paths actually
  // stop the transfer rather than merely stopping the wait.
  yield* streamWithLiveness(connected, options);
}

/**
 * Yield a validated response body under a size ceiling, an IDLE deadline and the caller's `AbortSignal`.
 *
 * Every exit disposes exactly once — normal end, ceiling breach, idle timeout, caller abort, and a consumer
 * that stops early — because `streamBounded`'s `finally` runs on all of them and the timer is cleared in the
 * same place. Errors are normalized to `SafeEgressError` here rather than escaping raw: the file's contract
 * is that its only thrown type is a `MediaEgressError`, and the whole-buffer twin gets that from
 * `withEgressTimeout`, which the streamed body deliberately runs outside of.
 */
async function* streamWithLiveness(
  connected: { body: AsyncIterable<Uint8Array>; dispose: () => void },
  options: FetchMediaBytesOptions,
): AsyncIterable<Uint8Array> {
  const idleMs = options.bodyIdleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let abandoned: SafeEgressError | undefined;
  // A promise that settles the moment we decide to stop. The read is RACED against it rather than merely
  // interrupted by `dispose`: a real socket destroy does reject a pending read, but relying on that would
  // make our liveness depend on the body implementation honouring it. Racing means the generator returns
  // even against a body that ignores the destroy entirely — which is precisely the adversarial case.
  // The promise resolves WITH the reason, so the race's abandoned arm carries a definite error rather than
  // reading a mutable that the compiler cannot prove is set.
  let signalAbandoned: ((reason: SafeEgressError) => void) | undefined;
  const abandonedSettled = new Promise<SafeEgressError>((resolve) => {
    signalAbandoned = resolve;
  });
  const abandon = (reason: SafeEgressError): void => {
    abandoned ??= reason;
    connected.dispose(); // destroy the socket — stop the transfer, not just our wait for it
    signalAbandoned?.(abandoned);
  };
  const arm = (): void => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(
      () => abandon(new SafeEgressError('network', 'media egress body stalled')),
      idleMs,
    );
    idle.unref?.(); // a stalled-body watchdog must not hold the process open on its own
  };
  const onAbort = (): void => abandon(new SafeEgressError('network', 'media egress was cancelled'));
  options.signal?.addEventListener('abort', onAbort);
  if (options.signal?.aborted === true) onAbort();

  const bounded = streamBounded(connected.body, options.maxBytes, connected.dispose);
  const iterator = bounded[Symbol.asyncIterator]();
  try {
    arm();
    for (;;) {
      const step = await Promise.race([
        iterator.next(),
        abandonedSettled.then((reason) => ({ abandoned: reason }) as const),
      ]);
      if ('abandoned' in step) throw step.abandoned;
      if (abandoned !== undefined) throw abandoned;
      if (step.done === true) return;
      arm(); // progress re-arms the idle deadline
      yield step.value;
    }
  } catch (error) {
    if (abandoned !== undefined) throw abandoned; // the typed reason we chose beats whatever the socket threw
    if (error instanceof SafeEgressError) throw error;
    // Parity with `withEgressTimeout`'s catch: a raw socket throw (ECONNRESET, an AbortError) must not
    // escape this module untyped — the header promises a `MediaEgressError` and nothing else.
    throw new SafeEgressError('network', 'media egress request failed');
  } finally {
    if (idle !== undefined) clearTimeout(idle);
    options.signal?.removeEventListener('abort', onAbort);
    // Dispose HERE, synchronously, on every exit — normal end, ceiling breach, idle timeout, caller abort,
    // and a consumer that stopped early. It is idempotent, so the inner `finally` calling it again is fine.
    //
    // The inner generator is asked to unwind but NOT awaited. One suspended inside `await body.next()`
    // cannot run its `finally` until that read settles, and the whole point of the race above is that a
    // hostile or stalled body may never settle it — awaiting here deadlocked in exactly the case the
    // deadline exists for. Disposing directly is what makes not-awaiting safe: the socket is freed by us,
    // not by whenever (or whether) the inner generator gets to unwind.
    connected.dispose();
    void iterator.return?.(undefined).catch(() => undefined);
  }
}
