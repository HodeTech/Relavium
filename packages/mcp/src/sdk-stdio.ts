import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { JsonSchema } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

import type { DiscoveredTool, McpConnection, McpToolResult } from './connection.js';
import {
  MCP_DEADLINES,
  McpAbortedError,
  McpDeadlineError,
  openWindow,
  raceDeadline,
  remainingMs,
  toAbortSignal,
  type DeadlineWindow,
} from './deadlines.js';
import { McpConnectError, McpError } from './errors.js';
import { INGRESS_BOUNDS, toolDefinitionBytes } from './ingress-bounds.js';
import { shapeToolResult } from './result.js';

/**
 * The **stdio** transport adapter — the ONE place the `@modelcontextprotocol/sdk` (and `node:child_process`,
 * via the SDK's stdio transport) is imported. It implements the `McpConnection` seam and surfaces only
 * Relavium shapes, so nothing else in the package — and never `packages/core` — sees an SDK type
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1, [ADR-0034](../../../docs/decisions/0034-mcp-client-sdk-dependency.md) g3).
 */

/** The explicit spawn spec for a stdio MCP server. */
export interface StdioServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * The child's environment — the declared `env` + the resolved `mcp-secret:*` values, host-constructed. The
   * SDK merges it OVER its own **curated minimal base** (`getDefaultEnvironment()` reads ONLY the safe
   * allowlist `HOME`/`PATH`/`SHELL`/`TERM`/`USER`/`LOGNAME`, plus a fixed Windows set — **never a blanket copy
   * of the host process env, never an arbitrary var like an API key**), with `spec.env` winning every
   * conflict. That "declared env + a minimal base, never a blanket copy" is exactly [ADR-0034](../../../docs/decisions/0034-mcp-client-sdk-dependency.md) g5;
   * the host can override or extend any base var via `spec.env`.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** The authored `connect_timeout_ms` (ADR-0088 §1.4). Absent ⇒ {@link MCP_DEADLINES.stdioConnectMs}. */
  readonly connectTimeoutMs?: number;
}

/**
 * What we tell an MCP server we are, in the `initialize` handshake.
 *
 * The version is **host-supplied** (`#208`). It was a hand-maintained `'0.1.0'` literal that had already
 * drifted past the shipped CLI, and a server that logs or version-gates on it saw a permanently stale
 * number no maintainer would remember to bump. `packages/mcp` has no release version of its own — it is a
 * workspace package — so the host injects the one it actually ships, and the default names the gap rather
 * than inventing a number.
 */
let clientVersion = 'unknown';

/**
 * Set the version reported to every MCP server. Called once by the host at startup, from the same build-time
 * token `--version` uses, so the two cannot drift.
 */
export function setMcpClientVersion(version: string): void {
  clientVersion = version;
}

const clientInfo = (): { name: string; version: string } => ({
  name: 'relavium',
  version: clientVersion,
});

/** A bound on the `tools/list` pages followed — a hostile server returning an endless cursor can't loop forever. */
export const MAX_TOOL_PAGES = 100;

/**
 * One `tools/list` page — the SDK's result is structurally assignable to this minimal shape. The optionals
 * carry an explicit `| undefined` (not just `?:`) so the SDK's `| undefined`-typed optionals assign under
 * `exactOptionalPropertyTypes`.
 */
export interface ToolListPage {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
    readonly inputSchema: JsonSchema;
  }>;
  readonly nextCursor?: string | undefined;
}

/**
 * Page through `tools/list` following `nextCursor` until exhausted (BOUNDED by {@link MAX_TOOL_PAGES}), mapping
 * each page to {@link DiscoveredTool}. Pure + SDK-independent (the page fetch is injected), so it is
 * unit-testable without a live server — and it fixes the single-page discovery that dropped tools past page 1.
 */
export async function collectAllTools(
  listPage: (cursor: string | undefined) => Promise<ToolListPage>,
): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];
  let bytes = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await listPage(cursor);
    for (const tool of result.tools) {
      tools.push({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      });
      bytes += toolDefinitionBytes(tool);
    }
    // **Stop PAGING, not just admitting** ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md)
    // §5.2: "dropped along with every tool after it, and paging stops").
    //
    // It did not, and the gap was the whole point of the bound. The budget lived one layer up in
    // `buildServerToolDefs`, so a server was paged to exhaustion FIRST and bounded afterwards: 100 pages at up
    // to 4 MiB each is ~400 MiB held on a remote transport before admission began, and `stdio` has no
    // transport byte bound at all, so there is no ceiling on that side. Bounding what is admitted while
    // fetching everything is a bound on the wrong thing.
    //
    // Measured on the RAW definitions rather than the shaped ones, deliberately: the shaping is what we are
    // trying not to have to do 50 000 times. The admission budget in `buildServerToolDefs` is unchanged and
    // still decides what is ADMITTED — this only stops asking for more once no further page could contribute.
    if (
      tools.length >= INGRESS_BOUNDS.toolsPerServer ||
      bytes > INGRESS_BOUNDS.discoveryBytesPerServer
    ) {
      return tools;
    }
    if (result.nextCursor === undefined) return tools;
    cursor = result.nextCursor;
  }
  throw new McpError(`tools/list exceeded the maximum of ${MAX_TOOL_PAGES} pages`);
}

/**
 * Spawn + connect a stdio MCP server and run the MCP initialize handshake; returns the live connection.
 *
 * The connect is bounded by `spec.connectTimeoutMs` (default {@link MCP_DEADLINES.stdioConnectMs}) — the
 * longest of the four deadlines on purpose, because the canonical authored example is `command: npx` and a
 * cold resolution routinely outruns a tighter one before the child speaks MCP at all (`#205`).
 */
export async function openStdioConnection(
  serverId: string,
  spec: StdioServerSpec,
  signal?: AbortSignalLike,
): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: spec.command,
    // The host-constructed env (declared vars + resolved `mcp-secret:*`). The SDK force-merges its curated
    // minimal base (`getDefaultEnvironment()` — the HOME/PATH/SHELL/TERM/USER/LOGNAME safe allowlist, never a
    // blanket host-env copy) UNDER this, and `spec.env` wins conflicts: the ADR-0034 g5 "declared env +
    // minimal base" end-state. (See the `env` field doc for the full rationale + the override path.)
    env: { ...spec.env },
    // Discard the child's stderr: 'inherit' would pollute our stderr, and 'pipe' without draining could block
    // the child once the OS pipe buffer fills. A connect/list failure surfaces via the rejected promise.
    stderr: 'ignore',
    // Optional fields spread conditionally (exactOptionalPropertyTypes: never pass an explicit `undefined`).
    ...(spec.args === undefined ? {} : { args: [...spec.args] }),
    ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
  });
  // **Registered BEFORE the connect, because the connect is when the child is spawned.** `childPid` below is
  // read only once the connect RESOLVES, which left the whole spawn-to-`initialize` window — up to 120 s on a
  // cold `npx` — with a live process no synchronous reaper could see. A review reproduced the consequence
  // against a real subprocess: `agent run` signalled mid-connect exited 143 while its MCP child kept running
  // at `ppid 1`. The registry is a THUNK list rather than a pid list for the same reason the bound's
  // `childPid` is a thunk: the pid does not exist yet at registration time, and does by the time an exit
  // handler evaluates it.
  const release = registerLiveChild(latchPid(() => transport.pid ?? undefined));
  try {
    const connection = await connectSdkTransport(serverId, transport, {
      timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.stdioConnectMs,
      ...(signal === undefined ? {} : { signal }),
      // The SDK exposes the spawned pid; carrying it out is what lets a host reap synchronously on an exit
      // path that cannot await an async close (ADR-0088 §1.3). `?? undefined` normalizes the SDK's `null`.
      childPid: () => transport.pid ?? undefined,
    });
    return releaseOnClose(connection, release);
  } catch (err) {
    // **Released LATE, and releasing it here synchronously is what let the measured orphan through.**
    // `connectSdkTransport`'s catch does close the transport — but that ladder is ASYNCHRONOUS and, on an
    // aborted connect, still running. Dropping the registration the instant the connect promise rejected
    // meant the exit net asked for live pids while the child was mid-kill and was told there were none.
    // Reproduced against a real subprocess with this exact line in place: host exit 143, child at `ppid 1`.
    //
    // An unref'd timer sized past the SDK's ~4 s ladder, so the registration outlives the teardown it is
    // protecting and still cannot hold the process open or accumulate forever.
    releaseAfterTeardown(release);
    throw err;
  }
}

/**
 * How long a failed connect's registration outlives the connect.
 *
 * The SDK's stdio close ladder is `stdin.end()` → race(2 s) → `SIGTERM` → race(2 s) → `SIGKILL`, so ~4 s
 * against a child that ignores both. This is that, plus margin: the registration must still be readable when
 * a synchronous exit handler runs at any point during the ladder.
 */
const TEARDOWN_LADDER_MS = 6_000;

function releaseAfterTeardown(release: () => void): void {
  // Never hold the process open for a cleanup: if the host exits first, the registration is exactly what the
  // exit net needs, and it dies with the process.
  setTimeout(release, TEARDOWN_LADDER_MS).unref?.();
}

/**
 * Every stdio child this PROCESS has spawned and not yet closed, as pid thunks.
 *
 * Process-global on purpose: the set of child processes a process owns is an observation of the OS, not a
 * policy, and the synchronous `process.on('exit')` reaper that needs it has no other way to learn a pid that
 * appeared inside an in-flight connect. It lives in `packages/mcp` — which already spawns processes and
 * fences the SDK — never in `packages/core`, which owns no process and must stay platform-free.
 */
const liveChildren = new Set<() => number | undefined>();

/**
 * Latch the first pid the transport reports, and keep returning it.
 *
 * **Measured against the SDK, and it inverts the naive reading.** `StdioClientTransport.close()` sets
 * `this._process = undefined` on its FIRST line — before `stdin.end()`, before `SIGTERM`, before the ~4 s
 * ladder runs — so `transport.pid` reports `null` while the child is still very much alive. A thunk that read
 * it live therefore went blind at exactly the moment a reaper needs it, and the exit net was handed an empty
 * list during a teardown in progress.
 *
 * The short unref'd interval exists because the pid does not exist at registration time either: the spawn
 * happens inside `client.connect()`, which is the call this registration wraps. It stops as soon as it has a
 * pid, never holds the loop open, and is the price of not monkey-patching an SDK object's `start`.
 */
function latchPid(readPid: () => number | undefined): LatchedPid {
  let latched = readPid();
  if (latched !== undefined) return { read: () => latched, stop: () => undefined };
  const poll = setInterval(() => {
    latched = readPid();
    if (latched !== undefined) clearInterval(poll);
  }, PID_LATCH_INTERVAL_MS);
  poll.unref?.();
  return {
    read: () => latched,
    // **The poll must be stoppable, and leaving it self-terminating only was a leak.** It clears itself when
    // a pid appears — but a spawn that FAILS (a typo'd `command`, the ordinary `ENOENT`) never produces one,
    // so the interval ran for the life of the process, once per failed connect. Measured: three failed spawns
    // left three pollers running at 20 ms, still firing 300 ms later. Unref'd, so it never held the process
    // open — which is exactly why nothing noticed.
    stop: () => clearInterval(poll),
  };
}

/** A latched pid plus the means to stop looking for one — see {@link latchPid}. */
interface LatchedPid {
  readonly read: () => number | undefined;
  readonly stop: () => void;
}

/** How often to look for a pid that does not exist yet — fast enough to catch a spawn, idle when it has one. */
const PID_LATCH_INTERVAL_MS = 20;

function registerLiveChild(latched: LatchedPid): () => void {
  liveChildren.add(latched.read);
  // Releasing a registration also stops its poll — the two have the same lifetime, so one owner keeps them
  // from drifting apart. Both release paths (the close wrapper, the post-ladder timer) go through here.
  return () => {
    liveChildren.delete(latched.read);
    latched.stop();
  };
}

/**
 * The pids of every live stdio child, for a host's synchronous last-resort reap.
 *
 * Distinct from {@link McpClient.childPids}, which is a SNAPSHOT taken when the client was assembled and is
 * therefore empty for exactly the window this covers: between the spawn and a completed handshake.
 */
export function liveMcpChildPids(): readonly number[] {
  const pids: number[] = [];
  for (const readPid of liveChildren) {
    const pid = readPid();
    // `undefined` here means "no pid yet", never "the child is gone" — the latch above makes sure of that —
    // so this must NOT prune. Registrations are dropped by their owner: the close wrapper on success, the
    // post-ladder timer on a failed connect.
    if (pid !== undefined) pids.push(pid);
  }
  return pids;
}

/**
 * Wrap a connection so closing it also drops its live-child registration. Idempotent, as `close` is.
 *
 * Every member is forwarded EXPLICITLY rather than spread: `SdkConnection` is a class, so its methods live on
 * the prototype and a spread would silently produce an object missing all of them.
 */
function releaseOnClose(connection: McpConnection, release: () => void): McpConnection {
  return {
    listTools: (signal) => connection.listTools(signal),
    callTool: (name, args, signal) => connection.callTool(name, args, signal),
    close: async () => {
      try {
        await connection.close();
      } finally {
        release();
      }
    },
    childPid: connection.childPid,
  };
}

/**
 * How much longer the SDK's own request timer is given than our window.
 *
 * **Two timers for one deadline is how the surfaced error type becomes a coin flip.** Handing the SDK exactly
 * `remainingMs(window)` armed a second timer for the same instant in a different timer list; when the SDK's
 * won, the rejection was its own `McpError` (`Request timed out`) and the `phase`/`serverId`/`timeoutMs`
 * discriminants ADR-0088 §9 exists to give were gone — non-deterministically. The margin makes ours
 * deterministically first, and leaves the SDK's as a backstop for any path our race cannot observe.
 *
 * Small enough to be invisible against the shortest bound here (30 s), large enough to survive ordinary timer
 * jitter.
 */
const SDK_TIMER_MARGIN_MS = 250;

/** How a connect is bounded — a deadline in ms plus the caller's optional cancel. */
export interface ConnectBound {
  readonly timeoutMs: number;
  readonly signal?: AbortSignalLike;
  /**
   * Read the spawned child's pid, AFTER the connect succeeds — `stdio` only; the network transports own no
   * process and leave it absent.
   *
   * A thunk rather than a number because the pid does not exist until `start()` spawns, and `start()` happens
   * inside the very call this bound wraps. It exists so a host can install a **synchronous** last-resort reap
   * on `process.on('exit')`: `client.close()` is async, and an exit path that does not await it (a second
   * Ctrl-C forcing `process.exit`, say) would otherwise re-orphan exactly the children ADR-0088 §1.3 is about.
   */
  readonly childPid?: () => number | undefined;
}

/**
 * Create an MCP {@link Client}, run the initialize handshake over the given SDK transport, and wrap it as the
 * SDK-type-free {@link McpConnection} seam. Shared by every transport adapter (stdio + the network adapters in
 * `sdk-http.ts`/`sdk-sse.ts`/`sdk-websocket.ts`) so the Client lifecycle + tool shaping live in ONE place. A
 * connect failure tears the client down and surfaces a typed, secret-free {@link McpConnectError} (its `cause`
 * is opaque — the host strips it). The `transport` type is internal to the SDK fence; nothing outside
 * `@relavium/mcp` sees it.
 *
 * **The bound wraps the WHOLE `client.connect()`, and that is the point**
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.1). Passing the SDK a
 * `RequestOptions` is not sufficient: `Client.connect` awaits `transport.start()` **first and with no options
 * at all**, then issues `initialize` — and `start()` is where the hang actually lives (measured: a transport
 * whose `start()` never settles hung this function indefinitely). So the window opens here, before any I/O,
 * and the whole call is raced against it.
 *
 * **The `catch` below is the ONE owner of teardown**, and it is what reaps a spawned `stdio` child rather than
 * orphaning it: `Protocol.connect` assigns `this._transport` BEFORE awaiting `start()`, so `client.close()`
 * reaches `transport.close()` even when the connect never completed.
 *
 * The **remaining** time is also handed to the SDK as `options.timeout`, so its internal 60 s default can
 * neither cut an authored 120 s window short nor outlive the end of one.
 */
export async function connectSdkTransport(
  serverId: string,
  transport: Transport,
  bound: ConnectBound,
): Promise<McpConnection> {
  const window = openWindow(bound.timeoutMs);
  const bridged = toAbortSignal(bound.signal);
  const client = new Client(clientInfo(), { capabilities: {} });
  try {
    await raceDeadline(
      serverId,
      'connect',
      window,
      () =>
        client.connect(transport, {
          timeout: remainingMs(window) + SDK_TIMER_MARGIN_MS,
          ...(bridged.signal === undefined ? {} : { signal: bridged.signal }),
        }),
      bound.signal,
    );
  } catch (err) {
    // `safeClose(client)` is what reaps a spawned child on the deadline/cancel path, and it genuinely does:
    // `Protocol.connect` assigns `this._transport` BEFORE awaiting `transport.start()`, so `client.close()`
    // reaches the transport even when the connect never completed. Measured on a cancelled stdio connect
    // against a child that traps `SIGTERM`: gone at ~4.6 s, which is the SDK's own ladder (stdin EOF → 2 s →
    // SIGTERM → 2 s → SIGKILL) running to completion. An earlier version of this comment claimed the close did
    // NOT reach the transport and added a direct `transport.close()` beside it — the timing was byte-identical
    // with and without, so the addition was inert and the claim was wrong.
    await safeClose(client);
    // A deadline / cancellation keeps its own type — a caller distinguishing "too slow" from "you pressed Esc"
    // from "the server refused" is exactly what `#204` asks for; collapsing them here would undo it. Both now
    // extend `McpError`, so `startMcpClient`'s own wrap preserves them too (it did not, at first).
    if (err instanceof McpDeadlineError || err instanceof McpAbortedError) throw err;
    throw new McpConnectError(serverId, { cause: err });
  } finally {
    bridged.dispose();
  }
  return new SdkConnection(serverId, client, bound.childPid?.());
}

class SdkConnection implements McpConnection {
  readonly #serverId: string;
  readonly #client: Client;
  readonly childPid: number | undefined;

  constructor(serverId: string, client: Client, childPid: number | undefined) {
    this.#serverId = serverId;
    this.#client = client;
    this.childPid = childPid;
  }

  /**
   * The whole paged walk is bounded by ONE window, not each page
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1): a server that answers every
   * page just inside a per-page bound would otherwise outlive any deadline simply by paginating, which is the
   * same hole `MAX_TOOL_PAGES` closes for the page count.
   */
  async listTools(signal?: AbortSignalLike): Promise<readonly DiscoveredTool[]> {
    const window = openWindow(MCP_DEADLINES.discoveryMs);
    return collectAllTools((cursor) =>
      this.#request('discovery', window, signal, (options) =>
        this.#client.listTools(cursor === undefined ? undefined : { cursor }, options),
      ),
    );
  }

  async callTool(name: string, args: unknown, signal?: AbortSignalLike): Promise<McpToolResult> {
    const window = openWindow(MCP_DEADLINES.callMs);
    const result = await this.#request('call', window, signal, (options) =>
      this.#client.callTool({ name, arguments: assertRecordArgs(name, args) }, undefined, options),
    );
    return shapeToolResult(result);
  }

  /**
   * Tear the connection down. **Rejects on a genuine teardown fault**, and it used to swallow every one.
   *
   * `safeClose` exists for the CONNECT failure path, where an error must not mask the original fault. Using
   * it here too meant `close()` could never reject — so `closeAll`'s `onCloseError` callback, added by `#207`
   * precisely so a misbehaving transport could be reported, was unreachable through any real adapter. A
   * feature wired end to end and dead in the middle: the manager offered it, the host could pass it, and no
   * SDK connection could ever trigger it.
   */
  async close(): Promise<void> {
    await this.#client.close();
  }

  /**
   * One bounded SDK request: the remaining window goes into the SDK's own `timeout`, and the whole call is
   * still raced so a transport that never answers cannot outlive the window through a path the SDK does not
   * time.
   *
   * **Nothing is torn down when a request fails**, unlike the connect: the caller may have other work on this
   * server, and tearing the shared connection down for one failed call is precisely the blunt fallback §1.2
   * replaces. The only cleanup here is the bridged signal's listener, freed in the `finally` — a bridge is
   * built per request, and a discovery walk builds one per page.
   */
  async #request<T>(
    phase: 'discovery' | 'call',
    window: DeadlineWindow,
    signal: AbortSignalLike | undefined,
    send: (options: RequestOptions) => Promise<T>,
  ): Promise<T> {
    const bridged = toAbortSignal(signal);
    try {
      return await raceDeadline(
        this.#serverId,
        phase,
        window,
        () =>
          send({
            timeout: remainingMs(window) + SDK_TIMER_MARGIN_MS,
            ...(bridged.signal === undefined ? {} : { signal: bridged.signal }),
          }),
        signal,
      );
    } finally {
      bridged.dispose();
    }
  }
}

/**
 * Close a client, swallowing the fault — for the CONNECT-failure path only.
 *
 * There the original error is what the caller must see, and a teardown fault on top of it would mask a
 * spawn/handshake failure with a close failure. On the ORDINARY teardown path there is no original error to
 * protect, and swallowing is what made `onCloseError` unreachable — see {@link SdkConnection.close}.
 */
async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // A teardown error must never mask the original outcome (e.g. a connect failure) — the child is exiting.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `arguments` a `tools/call` may carry — or a typed refusal (`#206`).
 *
 * **`undefined` for "none" is right; `undefined` for "I did not understand what you sent" is not.** The old
 * `isRecord(args) ? args : undefined` invoked the tool with NO arguments when handed a non-object, which is a
 * silent wrong-behaviour path in a package that fails loud at every other boundary. It is not dead code: the
 * registry coerces a discovered tool's top-level args to a `Record` before dispatch, but the `mcp_call`
 * built-in has a NESTED `args: z.unknown().optional()` that bypasses that coercion, so a model routing
 * through the low-level escape hatch reaches here directly.
 */
function assertRecordArgs(name: string, args: unknown): Record<string, unknown> | undefined {
  if (args === undefined || args === null) return undefined;
  if (isRecord(args)) return args;
  throw new McpError(
    `MCP tool "${name}" was called with non-object arguments — a tools/call takes an object or nothing`,
  );
}
