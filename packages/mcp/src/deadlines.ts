import type { AbortSignalLike } from '@relavium/shared';

/**
 * Deadlines for the inbound MCP layer
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1) — and the bridge from the
 * engine's platform-free {@link AbortSignalLike} to the real `AbortSignal` the SDK wants.
 *
 * **Why this file exists rather than a `RequestOptions` at each call site.** Measured before it was written:
 * a transport whose `start()` never resolves hangs `connectSdkTransport` forever. `Client.connect` awaits
 * `transport.start()` **first and with no options at all**, then issues `initialize` — so the SDK's
 * `RequestOptions` (and its 60 s `DEFAULT_REQUEST_TIMEOUT_MSEC`) reach only the second half. A deadline that
 * covers the half where the hang actually lives has to be ours, wrapped around the whole call.
 *
 * The two mechanisms here are deliberately separate. {@link raceDeadline} bounds an operation the SDK does not
 * let us configure (the connect); {@link remainingMs} feeds what is left of that same window into the options
 * the SDK *does* honour, so its internal default can neither cut an authored window short nor extend one past
 * its end.
 */

/**
 * The per-phase connect/call deadlines (ADR-0088 §1). One object rather than four loose constants, for the
 * reason `ADMISSION_CEILINGS` is: a caller that wants to show them should not have to know four names.
 */
export const MCP_DEADLINES = {
  /**
   * `stdio` connect — spawn through `initialize`. **Deliberately the longest**: the canonical authored
   * example is `command: npx`, and a cold `npx` resolution routinely outruns the SDK's fixed 60 s before the
   * child speaks MCP at all. A too-tight default here turns a working server into an unexplained first-run
   * failure, which is the bad trade a bound can make.
   */
  stdioConnectMs: 120_000,
  /**
   * Network connect — dial through `initialize`. Shorter than `stdio` because nothing is being downloaded:
   * past thirty seconds a remote endpoint is hung, not starting.
   */
  networkConnectMs: 30_000,
  /**
   * The whole `tools/list` walk, not one page. Bounding a page would let a server that answers each page
   * slowly outlive any bound simply by paginating — the same reason `MAX_TOOL_PAGES` bounds the count.
   */
  discoveryMs: 60_000,
  /** One `tools/call`. Matches the SDK's own default, now stated by us rather than inherited from it. */
  callMs: 60_000,
} as const;

/** Why a bounded MCP operation ended — the phase, so a caller can say which deadline was exceeded. */
export type McpDeadlinePhase = 'connect' | 'discovery' | 'call';

/**
 * Convert the engine's platform-free {@link AbortSignalLike} into a real `AbortSignal` for the SDK.
 *
 * `@relavium/shared` compiles with `types: []` and describes a signal only by what it observes, so the
 * engine's signal is structurally compatible but not the DOM/Node class the SDK's `RequestOptions.signal`
 * demands. Rather than widen the shared type (which would drag an ambient lib into the one package that must
 * not have one), the bridge lives here — at the SDK fence, where a vendor's type expectations belong.
 *
 * Returns `undefined` for an absent signal so a caller can spread the result without an explicit `undefined`
 * under `exactOptionalPropertyTypes`. An already-aborted input produces an already-aborted output.
 */
export function toAbortSignal(signal: AbortSignalLike | undefined): AbortSignal | undefined {
  if (signal === undefined) return undefined;
  // A real `AbortSignal` already satisfies `AbortSignalLike`; forwarding it directly avoids a redundant
  // controller AND keeps the SDK's own `signal.reason` intact for its error mapping.
  if (signal instanceof AbortSignal) return signal;
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
    return controller.signal;
  }
  // No `removeEventListener` on completion: the bridged controller lives exactly as long as the request it
  // was created for, and the source signal is the caller's — holding one listener for that span is the point.
  signal.addEventListener('abort', () => controller.abort());
  return controller.signal;
}

/** An operation that exceeded its deadline. The `phase` is a field, never only a sentence (`#203`). */
export class McpDeadlineError extends Error {
  readonly serverId: string;
  readonly phase: McpDeadlinePhase;
  readonly timeoutMs: number;

  constructor(serverId: string, phase: McpDeadlinePhase, timeoutMs: number) {
    super(`MCP server "${serverId}": ${phase} exceeded its ${timeoutMs} ms deadline`);
    this.name = 'McpDeadlineError';
    this.serverId = serverId;
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** A deadline window: when it opened, how long it runs, and the phase it bounds. */
export interface DeadlineWindow {
  readonly startedAt: number;
  readonly timeoutMs: number;
}

/** Open a window NOW. Called before the first I/O — including the DNS preflight — so nothing escapes it. */
export function openWindow(timeoutMs: number, now: () => number = Date.now): DeadlineWindow {
  return { startedAt: now(), timeoutMs };
}

/**
 * What is left of `window`, floored at 1 ms.
 *
 * **Floored at 1, not 0.** The SDK reads `options.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC`, so a `0` would be
 * falsy-safe but a *negative* value is meaningless and a `0` reads as "no time at all" in a way some paths
 * treat as absent. 1 ms says "already expired" unambiguously, and the outer race is what actually enforces the
 * end of the window — this value only stops the SDK's own 60 s default from outliving it.
 */
export function remainingMs(window: DeadlineWindow, now: () => number = Date.now): number {
  return Math.max(1, window.startedAt + window.timeoutMs - now());
}

/**
 * Run `operation` under a hard deadline, rejecting with {@link McpDeadlineError} or {@link McpAbortedError}
 * when the timer or the caller's cancel wins the race.
 *
 * **Teardown is the CALLER's, deliberately, and that is a correction.** A first version took a `dispose`
 * callback and reaped on the losing path, on the reasoning that an abandoned `stdio` connect leaves a spawned
 * child behind (ADR-0088 §1.3). Mutation testing showed the parameter had no owner: removing the `dispose`
 * call left every test green, because {@link connectSdkTransport}'s own `catch` already closes the client on
 * every failure path. Two mechanisms for one obligation is how the second one rots — the caller keeps it,
 * because the caller is what holds the thing that needs closing.
 *
 * **Caller-cancel wins a same-tick tie** ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §5):
 * the abort branch is registered first and checked first, so a signal that fires in the same turn as the timer
 * surfaces as a cancellation rather than a timeout. A user who pressed Esc should not be told the server was
 * slow.
 */
export async function raceDeadline<T>(
  serverId: string,
  phase: McpDeadlinePhase,
  window: DeadlineWindow,
  operation: () => Promise<T>,
  signal?: AbortSignalLike,
  now: () => number = Date.now,
): Promise<T> {
  const remaining = window.startedAt + window.timeoutMs - now();
  if (remaining <= 0) {
    // Already expired before the operation starts — do not begin work that cannot finish inside the window.
    throw new McpDeadlineError(serverId, phase, window.timeoutMs);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    if (signal !== undefined) {
      if (signal.aborted) {
        reject(new McpAbortedError(serverId, phase));
        return;
      }
      onAbort = (): void => reject(new McpAbortedError(serverId, phase));
      signal.addEventListener('abort', onAbort);
    }
    timer = setTimeout(() => {
      reject(new McpDeadlineError(serverId, phase, window.timeoutMs));
    }, remaining);
    // Never hold the process open on this timer: it exists to bound a wait, not to create one.
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(), guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/** A bounded MCP operation the caller cancelled. Distinct from a deadline so a surface can say which happened. */
export class McpAbortedError extends Error {
  readonly serverId: string;
  readonly phase: McpDeadlinePhase;

  constructor(serverId: string, phase: McpDeadlinePhase) {
    super(`MCP server "${serverId}": ${phase} was cancelled`);
    this.name = 'McpAbortedError';
    this.serverId = serverId;
    this.phase = phase;
  }
}
