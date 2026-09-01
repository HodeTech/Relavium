import type { McpCapability, ToolDef } from '@relavium/core';
import type { AbortSignalLike } from '@relavium/shared';

import type { McpConnection } from './connection.js';
import {
  McpConnectError,
  McpDuplicateServerError,
  McpError,
  McpNoConnectionError,
} from './errors.js';
import { buildServerToolDefs } from './tool-mapping.js';

/**
 * The host-facing entry point for the inbound MCP layer
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2/§3).
 *
 * `startMcpClient` connects every declared server (**fail-loud** — a declared server that cannot be
 * spawned/connected or fails `tools/list` fails the whole start, never a silent capability loss), discovers +
 * shapes each server's tools into namespaced `ToolDef`s, and returns an {@link McpClient}: the aggregate
 * `toolDefs` to compose into `createToolRegistry({ tools })`, plus an `McpCapability` to wire onto
 * `ToolHost.mcp` that routes a `{ server, tool, args }` call to the owning connection. The `open` per-server
 * is injected (the stdio adapter in production; a fake in tests), so the lifecycle is testable without a live
 * server and the SDK stays fenced in `sdk-stdio.ts`.
 */

/** One server to connect: its namespace-safe routing `id`, an optional `tools_allowlist`, and how to open it. */
export interface McpServerConfig {
  readonly id: string;
  readonly toolsAllowlist?: readonly string[];
  /**
   * Open the live connection (production: a stdio/network adapter; tests: a fake).
   *
   * **Takes the connect signal**, because a connect can be the longest thing a session does — up to
   * `stdio`'s 120 s while a cold `npx` resolves, with the terminal silent and the user reaching for Ctrl-C
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.1). A first version threaded
   * the signal into every adapter and then never passed one here, which made the whole cancel path dead
   * surface: it type-checked and could not fire.
   */
  open(signal?: AbortSignalLike): Promise<McpConnection>;
}

/** A tool dropped at discovery, tagged with its server (allowlist / unsupported schema / collision / unsafe id). */
export interface ManagerSkippedTool {
  readonly server: string;
  readonly name: string;
  readonly reason: string;
}

export interface McpClient {
  /** The host `McpCapability` — wire onto `ToolHost.mcp`; routes `{ server, tool, args }` to the connection. */
  readonly capability: McpCapability;
  /** The aggregate namespaced `ToolDef`s across all servers — compose into `createToolRegistry({ tools })`. */
  readonly toolDefs: readonly ToolDef[];
  /**
   * The granted (post-allowlist, post-collision) namespaced tool ids **grouped by server id** — the host uses
   * this to augment the RIGHT agent's tool grant when several agents in one workflow declare different servers
   * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3). A server
   * that contributed no usable tool still has an entry (an empty array), so a declared id is always present.
   */
  readonly toolIdsByServer: ReadonlyMap<string, readonly string[]>;
  /** Tools dropped at discovery, per server. */
  readonly skipped: readonly ManagerSkippedTool[];
  /**
   * Tear down every connection (idempotent).
   *
   * `onCloseError` is optional (`#207`): a teardown fault is swallowed by default, because "the child is
   * exiting" is true almost always — but a caller that has somewhere to report can hear about the times it
   * is not, which is when an orphaned-process report would otherwise have no trace to start from.
   */
  close(onCloseError?: (serverId: string, cause: unknown) => void): Promise<void>;
  /**
   * The pids of the spawned `stdio` children, for a host's **synchronous** last-resort reap on
   * `process.on('exit')` ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3).
   * {@link close} is async and an exit path that cannot await it would otherwise re-orphan them.
   */
  readonly childPids: readonly number[];
}

export async function startMcpClient(
  servers: readonly McpServerConfig[],
  /** Cancels the connect AND the discovery walk — see {@link McpServerConfig.open}. */
  signal?: AbortSignalLike,
): Promise<McpClient> {
  const connections = new Map<string, McpConnection>();
  const toolDefs: ToolDef[] = [];
  const toolIdsByServer = new Map<string, readonly string[]>();
  const skipped: ManagerSkippedTool[] = [];
  // Shared ACROSS servers so a namespaced id colliding across two servers (e.g. server `a`+tool `b_x` and
  // server `a_b`+tool `x` both → `mcp_a_b_x`) fails closed — never a duplicate id reaching `createToolRegistry`.
  const seenToolIds = new Set<string>();

  // The routing key must be unique (it disambiguates connections AND namespaces the tools).
  const seenServerIds = new Set<string>();
  for (const server of servers) {
    if (seenServerIds.has(server.id)) {
      throw new McpDuplicateServerError(server.id);
    }
    seenServerIds.add(server.id);
  }

  // Connect every server CONCURRENTLY: a slow/hung server no longer serializes startup to N×(its connect bound)
  // — total startup is now bounded by the SLOWEST single server, not their sum. Each task registers its
  // connection as soon as `open()` resolves, so a later `listTools()` failure still has it in `connections` for
  // the fail-loud teardown; and each wraps its own failure into a typed, secret-free error carrying the server id.
  const settled = await Promise.allSettled(
    servers.map(async (server) => {
      try {
        const connection = await server.open(signal);
        connections.set(server.id, connection);
        const tools = await connection.listTools(signal);
        return { server, tools };
      } catch (err) {
        throw err instanceof McpError ? err : new McpConnectError(server.id, { cause: err });
      }
    }),
  );
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure !== undefined) {
    // Fail-loud: tear down everything opened, then surface the (already typed + secret-free) first failure.
    await closeAll(connections);
    throw failure.reason;
  }
  // Assemble the tool defs in DECLARATION order (not connect-completion order) so the cross-server namespacing +
  // collision resolution (shared `seenToolIds`, first-wins) stays deterministic regardless of who connected first.
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue; // unreachable — a rejection already threw above
    const { server, tools } = result.value;
    const shaped = buildServerToolDefs(server.id, tools, server.toolsAllowlist, seenToolIds);
    toolDefs.push(...shaped.defs);
    toolIdsByServer.set(
      server.id,
      shaped.defs.map((def) => def.id),
    );
    for (const s of shaped.skipped) {
      skipped.push({ server: server.id, name: s.name, reason: s.reason });
    }
  }

  const capability: McpCapability = {
    /**
     * The engine's `signal` reaches the in-flight `tools/call`
     * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.2).
     *
     * It was measured dropped: this closure took `(input)` and ignored its second parameter, and
     * `McpConnection.callTool(name, args)` had nowhere to put one — so an aborted call was still pending
     * 500 ms later and the only cancellation available was tearing the whole connection down, which
     * invalidates every other call to that server for the rest of the session. The adapter bridges the
     * platform-free signal to the SDK's `AbortSignal` at the fence.
     */
    call: (input, signal) => {
      const connection = connections.get(input.server);
      if (connection === undefined) {
        return Promise.reject(new McpNoConnectionError(input.server));
      }
      return connection.callTool(input.tool, input.args, signal);
    },
  };

  // Read ONCE, here, while every connection is still registered: `closeAll` clears the map, so a later read
  // would return an empty list exactly when the reaper needs it most.
  const childPids = [...connections.values()]
    .map((connection) => connection.childPid)
    .filter((pid): pid is number => pid !== undefined);

  return {
    capability,
    toolDefs,
    toolIdsByServer,
    skipped,
    childPids,
    close: (onCloseError) => closeAll(connections, onCloseError),
  };
}

/** Close every connection, swallowing teardown errors (the children are exiting); clears the map (idempotent). */
async function closeAll(
  connections: Map<string, McpConnection>,
  onCloseError?: (serverId: string, cause: unknown) => void,
): Promise<void> {
  const all = [...connections.entries()];
  connections.clear();
  await Promise.all(
    all.map(([serverId, connection]) =>
      connection.close().catch((cause: unknown) => {
        // **Reported when a caller asked to hear it, swallowed otherwise** (`#207`). The unconditional
        // discard was defensible — "the child is exiting" is true almost always — but "almost always" is
        // exactly the case where a genuinely misbehaving transport produces an orphaned-process report with
        // no trace to diagnose it from. The callback is optional so the pervasive `.catch(() => undefined)`
        // convention at every existing call site keeps working unchanged; a caller that HAS somewhere to
        // report can now opt in, which is what the finding asked for and what makes the change complete.
        onCloseError?.(serverId, cause);
      }),
    ),
  );
}
