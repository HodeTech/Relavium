import type { AbortSignalLike } from '@relavium/shared';

import { McpError } from './errors.js';

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

/** A bridged signal and the disposer that releases its listener on the SOURCE signal. */
export interface BridgedSignal {
  readonly signal: AbortSignal | undefined;
  readonly dispose: () => void;
}

/**
 * Convert the engine's platform-free {@link AbortSignalLike} into a **per-request** `AbortSignal` for the SDK.
 *
 * `@relavium/shared` compiles with `types: []` and describes a signal only by what it observes, so the
 * engine's signal is structurally compatible but not the DOM/Node class the SDK's `RequestOptions.signal`
 * demands. Rather than widen the shared type (which would drag an ambient lib into the one package that must
 * not have one), the bridge lives here — at the SDK fence, where a vendor's type expectations belong.
 *
 * **A real `AbortSignal` is bridged too, and that is deliberate — an earlier version forwarded it verbatim.**
 * Forwarding looked strictly better (one fewer controller, and `signal.reason` preserved for the SDK's error
 * mapping) and was measured to be the leak: `Protocol.request` does
 * `options.signal.addEventListener('abort', …)` with **no removal, no `{ once: true }`, and no detach on
 * settle**. Hand it the run-lifetime signal and every `tools/call` — and every one of up to a hundred
 * discovery pages — leaves a listener behind for the rest of the run, each retaining a message id, a schema
 * and a transport. On cancel they all fire, emitting a `notifications/cancelled` per long-answered request.
 *
 * Giving the SDK a controller **we** own moves that retention to something with a lifetime we control: the
 * caller's `finally` calls {@link BridgedSignal.dispose}, the bridged controller becomes garbage, and the
 * SDK's listener goes with it. The `reason` is forwarded through `abort(reason)`, so nothing is lost.
 *
 * `signal` is `undefined` for an absent input so a caller can spread it without an explicit `undefined` under
 * `exactOptionalPropertyTypes`. An already-aborted input produces an already-aborted output.
 */
export function toAbortSignal(signal: AbortSignalLike | undefined): BridgedSignal {
  const noop = (): void => undefined;
  if (signal === undefined) return { signal: undefined, dispose: noop };
  const controller = new AbortController();
  const reasonOf = (source: AbortSignalLike): unknown =>
    source instanceof AbortSignal ? source.reason : undefined;
  if (signal.aborted) {
    controller.abort(reasonOf(signal));
    return { signal: controller.signal, dispose: noop };
  }
  const onAbort = (): void => controller.abort(reasonOf(signal));
  signal.addEventListener('abort', onAbort);
  return {
    signal: controller.signal,
    dispose: () => signal.removeEventListener('abort', onAbort),
  };
}

/**
 * An operation that exceeded its deadline. The `phase` is a field, never only a sentence (`#203`).
 *
 * **Extends `McpError`, and that is load-bearing rather than tidy.** A first version extended `Error`, and a
 * review found the consequence one frame up: `startMcpClient` wraps anything that is not an `McpError` into
 * `McpConnectError`, whose message is the fixed sentence "could not be connected or listed". So the type this
 * class exists to preserve was being flattened into the opaque message ADR-0088 §9 exists to replace — after
 * the user had already waited out the full deadline.
 */
export class McpDeadlineError extends McpError {
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
 * **Caller-cancel wins, and precedence is decided at CLASSIFICATION time — not by listener order.** An
 * earlier version claimed the win came from registering the abort branch first, and a review measured that
 * claim false: registration order only decides a tie when both callbacks land in the same synchronous flush,
 * and the realistic CLI delivery is our timer firing in the timers phase while the user's Esc arrives in the
 * poll phase of the same iteration. The result was a user being told the server exceeded its deadline for
 * what was a cancel — exactly what
 * [ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md)
 * §5 forbids. `@relavium/shared`'s own `openDeadline` had already solved this and written down why; this now
 * uses the same rule, which is also the only version a test can pin without pinning a scheduler detail.
 *
 * **An already-aborted signal does not start the work.** The same refusal the spent-window branch makes, for
 * the same reason: `Promise.race` evaluates its array before racing, so an `operation()` in that array runs
 * even when the guard already rejected. Measured — a pre-aborted connect still **spawned the child** and a
 * pre-aborted request still put bytes on the wire, which is the "the remote or child effect keeps running"
 * harm ADR-0088's own Context names.
 */
export async function raceDeadline<T>(
  serverId: string,
  phase: McpDeadlinePhase,
  window: DeadlineWindow,
  operation: () => Promise<T>,
  signal?: AbortSignalLike,
  now: () => number = Date.now,
): Promise<T> {
  // A function, not a direct read: `AbortSignalLike.aborted` is declared `readonly boolean`, so a narrowing
  // read here would let the compiler treat it as settled for the rest of the scope — and the whole point of
  // the classification below is that it changed in between.
  const cancelled = (): boolean => signal?.aborted === true;
  if (cancelled()) {
    // Refuse BEFORE `Promise.race` evaluates its array: the work in it would otherwise run — spawning a child
    // or writing a request the caller had already cancelled.
    throw new McpAbortedError(serverId, phase);
  }
  const remaining = window.startedAt + window.timeoutMs - now();
  if (remaining <= 0) {
    // Already expired before the operation starts — do not begin work that cannot finish inside the window.
    throw new McpDeadlineError(serverId, phase, window.timeoutMs);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    if (signal !== undefined) {
      // No pre-aborted branch here: the refusal above already returned, so reaching this point means the
      // signal was live. A synchronous `reject` inside this executor was also the one shape that could leave
      // an UNHANDLED rejection — if `operation()` threw synchronously, the array literal never completed and
      // `Promise.race` was never called, so nothing subscribed to `guard`.
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
  } catch (err) {
    // Classification time, not listener order. Only OUR OWN deadline verdict is reclassified: an error the
    // operation itself produced is its own answer and must not be laundered into a cancellation.
    //
    // The identity check is defensive rather than load-bearing today — `operation()` is always a bare SDK call,
    // never a nested `raceDeadline`, so a deadline arriving here is always this call's. It costs one comparison
    // to make that a property of the code instead of a property of the current call graph: if a caller ever
    // nests deadlines (a per-page bound inside the whole-walk bound, say), an inner call's genuine timeout must
    // not be relabelled with the outer call's cancellation.
    if (
      err instanceof McpDeadlineError &&
      err.serverId === serverId &&
      err.phase === phase &&
      cancelled()
    ) {
      throw new McpAbortedError(serverId, phase);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * A bounded MCP operation the caller cancelled. Distinct from a deadline so a surface can say which happened —
 * a user who pressed Esc must not be told the server was slow. Extends `McpError` for the reason
 * {@link McpDeadlineError} does.
 */
export class McpAbortedError extends McpError {
  readonly serverId: string;
  readonly phase: McpDeadlinePhase;

  constructor(serverId: string, phase: McpDeadlinePhase) {
    super(`MCP server "${serverId}": ${phase} was cancelled`);
    this.name = 'McpAbortedError';
    this.serverId = serverId;
    this.phase = phase;
  }
}
