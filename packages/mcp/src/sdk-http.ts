import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { McpConnection } from './connection.js';
import { McpConnectError } from './errors.js';
import { connectSdkTransport } from './sdk-stdio.js';

/**
 * The **Streamable HTTP** (`http`) transport adapter — one of the SDK-fenced files
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)). It opens the SDK's
 * `StreamableHTTPClientTransport` and reuses the shared `connectSdkTransport` Client wrapper, surfacing only the
 * Relavium {@link McpConnection} seam. The transport uses the runtime's global `fetch` (Node ≥ 18), so no extra
 * dependency. **SSRF is the host's gate**: the CLI host validates the `url` against the shared range-block
 * primitive (and the `allow_local_endpoint` opt-in) BEFORE calling this — the adapter itself only connects.
 */

/** The explicit spec for a Streamable HTTP MCP server — a host-validated absolute `http(s)` url. */
export interface HttpServerSpec {
  readonly url: string;
}

/** Connect a Streamable HTTP MCP server and run the initialize handshake; returns the live connection. */
export async function openHttpConnection(
  serverId: string,
  spec: HttpServerSpec,
): Promise<McpConnection> {
  let endpoint: URL;
  try {
    endpoint = new URL(spec.url);
  } catch (err) {
    // A malformed url is a typed connect failure (secret-free; the host strips the opaque cause).
    throw new McpConnectError(serverId, { cause: err });
  }
  // The SDK's StreamableHTTP transport declares `get sessionId(): string | undefined`, which TS rejects against
  // `Transport.sessionId?: string` under exactOptionalPropertyTypes — a vendor getter-vs-interface inconsistency,
  // not a real incompatibility (the class `implements Transport`). Rather than a whole-object `as Transport`
  // (which would also silently mask a future MISSING-method drift), narrow to the load-bearing methods: those ARE
  // the only required `Transport` members, so the value still satisfies `Transport` (its optionals may be absent)
  // WITHOUT the getter comparison, and this assignment compile-guards against a dropped method on an SDK upgrade.
  const transport: Pick<Transport, 'start' | 'send' | 'close'> = new StreamableHTTPClientTransport(
    endpoint,
  );
  return connectSdkTransport(serverId, transport);
}
