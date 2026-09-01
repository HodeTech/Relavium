import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import type { AbortSignalLike } from '@relavium/shared';

import type { McpConnection } from './connection.js';
import type { McpFetch } from './sdk-http.js';
import { MCP_DEADLINES } from './deadlines.js';
import { McpConnectError } from './errors.js';
import { connectSdkTransport } from './sdk-stdio.js';

/**
 * The **legacy HTTP+SSE** (`sse`) transport adapter — one of the SDK-fenced files
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §5). `sse` is a
 * **deprecated alias** of `http`: the MCP spec replaced HTTP+SSE with Streamable HTTP, but a server declaring
 * `sse` speaks the legacy wire protocol, so it connects via the SDK's `SSEClientTransport` (over global `fetch`).
 * New servers should declare `http`. **SSRF is the host's gate** (the `http(s)`/`allow_local_endpoint`
 * validation runs before this — `sse` uses an `http(s)` url like `http`).
 */

/** The explicit spec for a legacy HTTP+SSE MCP server — a host-validated absolute `http(s)` url. */
export interface SseServerSpec {
  readonly url: string;
  /** The authored `connect_timeout_ms` (ADR-0088 §1.4). Absent ⇒ {@link MCP_DEADLINES.networkConnectMs}. */
  readonly connectTimeoutMs?: number;
  /** The host's validated `fetch` (ADR-0088 §2.1) — see `HttpServerSpec.fetch` for what absence costs. */
  readonly fetch?: McpFetch;
}

/** Connect a legacy HTTP+SSE MCP server and run the initialize handshake; returns the live connection. */
export async function openSseConnection(
  serverId: string,
  spec: SseServerSpec,
  signal?: AbortSignalLike,
): Promise<McpConnection> {
  let endpoint: URL;
  try {
    endpoint = new URL(spec.url);
  } catch (err) {
    throw new McpConnectError(serverId, { cause: err });
  }
  const transport = new SSEClientTransport(
    endpoint,
    spec.fetch === undefined ? undefined : { fetch: spec.fetch },
  );
  return connectSdkTransport(serverId, transport, {
    timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.networkConnectMs,
    ...(signal === undefined ? {} : { signal }),
  });
}
