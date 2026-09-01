import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AbortSignalLike } from '@relavium/shared';

import type { McpConnection } from './connection.js';
import { MCP_DEADLINES } from './deadlines.js';
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

/**
 * A `fetch`-shaped function the host supplies so every request on this transport rides its validated,
 * IP-pinned hop ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.1).
 *
 * Declared HERE, in Relavium's own terms, rather than imported from the SDK: the SDK's `FetchLike` is
 * structurally identical, and taking it would put a vendor type on this package's public surface for no gain
 * (ADR-0034 g3). `Response`/`RequestInit` are platform globals, not SDK types — this package is host-bound by
 * design and already imports `@modelcontextprotocol/sdk`.
 */
export type McpFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** The explicit spec for a Streamable HTTP MCP server — a host-validated absolute `http(s)` url. */
export interface HttpServerSpec {
  readonly url: string;
  /** The authored `connect_timeout_ms` (ADR-0088 §1.4). Absent ⇒ {@link MCP_DEADLINES.networkConnectMs}. */
  readonly connectTimeoutMs?: number;
  /**
   * The host's validated `fetch` (ADR-0088 §2.1). **Absent means the runtime's global `fetch`, which is NOT
   * pinned** — the SDK opens its own socket, so without this the DNS-rebind and redirect-to-private holes
   * ADR-0053 §2 named stay open. The CLI host always supplies one; the parameter is optional only because a
   * unit test that never dials does not need to build one.
   */
  readonly fetch?: McpFetch;
}

/** Connect a Streamable HTTP MCP server and run the initialize handshake; returns the live connection. */
export async function openHttpConnection(
  serverId: string,
  spec: HttpServerSpec,
  signal?: AbortSignalLike,
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
    // The injected hop. Every request on this transport — the initialize POST, each `tools/call`, and the
    // long-lived GET stream — goes through it, which is what makes §2.1's pinning cover the session rather
    // than only its first dial.
    spec.fetch === undefined ? undefined : { fetch: spec.fetch },
  );
  return connectSdkTransport(serverId, transport, {
    timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.networkConnectMs,
    ...(signal === undefined ? {} : { signal }),
  });
}
