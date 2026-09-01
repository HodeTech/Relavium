import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';

import type { AbortSignalLike } from '@relavium/shared';

import type { McpConnection } from './connection.js';
import { MCP_DEADLINES } from './deadlines.js';
import { McpConnectError, McpError } from './errors.js';
import { connectSdkTransport } from './sdk-stdio.js';

/**
 * The **WebSocket** (`websocket`) transport adapter — one of the SDK-fenced files
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)). It opens the SDK's
 * `WebSocketClientTransport` and reuses the shared `connectSdkTransport` Client wrapper, surfacing only the
 * Relavium {@link McpConnection} seam.
 *
 * **This transport is LOCAL-ONLY, and that is a decision rather than a limitation of this file**
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.3). `WebSocketClientTransport`'s
 * constructor takes a `URL` and nothing else — no `fetch`, no dialer, no socket factory — and its `onmessage`
 * runs `JSON.parse(event.data)` before any Relavium code sees a byte. So on this transport we can enforce
 * neither §2.1's connect-by-validated-IP pin nor §5's per-message byte bound. A **remote** server therefore
 * gets neither, which is why the host refuses one at admission; an `allow_local_endpoint` server is permitted
 * because it is an explicit opt-in to an address the author wrote down, and its residual sits with `stdio`'s:
 * an unbounded transport must be local and consented to. The trigger to revisit is an SDK release with a
 * dialer hook, or a user who actually needs remote websocket — at which point a `ws`-backed transport becomes
 * the proposal, with its own dependency ADR.
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
  /** The authored `connect_timeout_ms` (ADR-0088 §1.4). Absent ⇒ {@link MCP_DEADLINES.networkConnectMs}. */
  readonly connectTimeoutMs?: number;
}

/** Connect a WebSocket MCP server and run the initialize handshake; returns the live connection. */
export async function openWebSocketConnection(
  serverId: string,
  spec: WebSocketServerSpec,
  signal?: AbortSignalLike,
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
  return connectSdkTransport(serverId, new WebSocketClientTransport(endpoint), {
    timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.networkConnectMs,
    ...(signal === undefined ? {} : { signal }),
  });
}
