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

const CLIENT_INFO = { name: 'relavium', version: '0.1.0' } as const;

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
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await listPage(cursor);
    for (const tool of result.tools) {
      tools.push({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      });
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
  return connectSdkTransport(serverId, transport, {
    timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.stdioConnectMs,
    ...(signal === undefined ? {} : { signal }),
  });
}

/** How a connect is bounded — a deadline in ms plus the caller's optional cancel. */
export interface ConnectBound {
  readonly timeoutMs: number;
  readonly signal?: AbortSignalLike;
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
 * the whole call is raced against it, and the loser is **disposed** — which for `stdio` is what reaps the
 * spawned child rather than orphaning it.
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
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await raceDeadline(
      serverId,
      'connect',
      window,
      () =>
        client.connect(transport, {
          timeout: remainingMs(window),
          ...(bridged === undefined ? {} : { signal: bridged }),
        }),
      bound.signal,
    );
  } catch (err) {
    await safeClose(client);
    // A deadline / cancellation keeps its own type — a caller distinguishing "too slow" from "you pressed Esc"
    // from "the server refused" is exactly what `#204` asks for; collapsing them here would undo it.
    if (err instanceof McpDeadlineError || err instanceof McpAbortedError) throw err;
    throw new McpConnectError(serverId, { cause: err });
  }
  return new SdkConnection(serverId, client);
}

class SdkConnection implements McpConnection {
  readonly #serverId: string;
  readonly #client: Client;

  constructor(serverId: string, client: Client) {
    this.#serverId = serverId;
    this.#client = client;
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
      this.#client.callTool(
        { name, arguments: isRecord(args) ? args : undefined },
        undefined,
        options,
      ),
    );
    return shapeToolResult(result);
  }

  async close(): Promise<void> {
    await safeClose(this.#client);
  }

  /**
   * One bounded SDK request: the remaining window goes into the SDK's own `timeout`, and the whole call is
   * still raced so a transport that never answers cannot outlive the window through a path the SDK does not
   * time. `dispose` is a no-op here — unlike a connect, a failed in-flight request must NOT tear the shared
   * connection down: the caller may have other work on this server, and blunt teardown is precisely the
   * fallback §1.2 replaces.
   */
  async #request<T>(
    phase: 'discovery' | 'call',
    window: DeadlineWindow,
    signal: AbortSignalLike | undefined,
    send: (options: RequestOptions) => Promise<T>,
  ): Promise<T> {
    const bridged = toAbortSignal(signal);
    return raceDeadline(
      this.#serverId,
      phase,
      window,
      () =>
        send({
          timeout: remainingMs(window),
          ...(bridged === undefined ? {} : { signal: bridged }),
        }),
      signal,
    );
  }
}

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
