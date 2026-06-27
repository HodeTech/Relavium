import type { McpCapability, ToolDef } from '@relavium/core';

import type { McpConnection } from './connection.js';
import { McpConnectError, McpError } from './errors.js';
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
  /** Open the live connection (production: a stdio/network adapter; tests: a fake). */
  open(): Promise<McpConnection>;
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
  /** Tear down every connection (idempotent). */
  close(): Promise<void>;
}

export async function startMcpClient(servers: readonly McpServerConfig[]): Promise<McpClient> {
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
      throw new McpError(`duplicate MCP server id "${server.id}"`);
    }
    seenServerIds.add(server.id);
  }

  for (const server of servers) {
    try {
      const connection = await server.open();
      connections.set(server.id, connection);
      const tools = await connection.listTools();
      const shaped = buildServerToolDefs(server.id, tools, server.toolsAllowlist, seenToolIds);
      toolDefs.push(...shaped.defs);
      toolIdsByServer.set(
        server.id,
        shaped.defs.map((def) => def.id),
      );
      for (const s of shaped.skipped) {
        skipped.push({ server: server.id, name: s.name, reason: s.reason });
      }
    } catch (err) {
      // Fail-loud: tear down everything opened so far, then surface a typed, secret-free error.
      await closeAll(connections);
      throw err instanceof McpError ? err : new McpConnectError(server.id, { cause: err });
    }
  }

  const capability: McpCapability = {
    // The `signal` is intentionally not forwarded to the in-flight `tools/call` yet — the engine's
    // `AbortSignalLike` does not match the SDK transport's `AbortSignal`; mid-call abort propagation to the
    // server is a tracked refinement (deferred-tasks.md). A run/turn cancel still tears the connection down.
    call: (input) => {
      const connection = connections.get(input.server);
      if (connection === undefined) {
        return Promise.reject(new McpError(`no MCP connection for server "${input.server}"`));
      }
      return connection.callTool(input.tool, input.args);
    },
  };

  return { capability, toolDefs, toolIdsByServer, skipped, close: () => closeAll(connections) };
}

/** Close every connection, swallowing teardown errors (the children are exiting); clears the map (idempotent). */
async function closeAll(connections: Map<string, McpConnection>): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.all(all.map((connection) => connection.close().catch(() => undefined)));
}
