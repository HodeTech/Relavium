import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

import type { McpConnection } from './connection.js';
import { McpConnectError, McpError } from './errors.js';
import { connectSdkTransport } from './sdk-stdio.js';

/**
 * The **WebSocket** (`websocket`) transport adapter — one of the SDK-fenced files
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)). It opens the SDK's
 * `WebSocketClientTransport` and reuses the shared `connectSdkTransport` Client wrapper, surfacing only the
 * Relavium {@link McpConnection} seam.
 *
 * **Runtime requirement: a global `WebSocket`.** The SDK's transport uses `new WebSocket(...)` (it has no `ws`
 * dependency), so this requires a runtime with a global `WebSocket` — Node **22+**, which the CLI's `engines`
 * floor now guarantees (`>=22`, [ADR-0067](../../../docs/decisions/0067-node-supported-floor-22-reaffirm-better-sqlite3.md)).
 * The fail-loud typed error below is defense-in-depth for an off-floor runtime rather than a silent failure.
 * **SSRF is the host's gate** (the `wss`/`allow_local_endpoint` validation runs before this).
 */

/** The explicit spec for a WebSocket MCP server — a host-validated absolute `ws(s)` url. */
export interface WebSocketServerSpec {
  readonly url: string;
}

/** Connect a WebSocket MCP server and run the initialize handshake; returns the live connection. */
export async function openWebSocketConnection(
  serverId: string,
  spec: WebSocketServerSpec,
): Promise<McpConnection> {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new McpError(
      `MCP server "${serverId}": the websocket transport requires a global WebSocket (Node 22+). ` +
        `Upgrade Node, or use the 'http' (Streamable HTTP) transport instead.`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(spec.url);
  } catch (err) {
    throw new McpConnectError(serverId, { cause: err });
  }
  return connectSdkTransport(serverId, new WebSocketClientTransport(endpoint));
}
