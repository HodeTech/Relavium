import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AbortSignalLike } from '@relavium/shared';
import type { ToolHostCallOptions } from '@relavium/core';

import type { McpConnection } from './connection.js';
import { MCP_DEADLINES } from './deadlines.js';
import { McpConnectError } from './errors.js';
import { connectSdkTransport } from './sdk-stdio.js';
import { SdkTransportOwner, type SdkLaneLifetime } from './sdk-work.js';
import { McpLifetimeError, McpWorkScope } from './work-scope.js';

/**
 * The **Streamable HTTP** (`http`) transport adapter — one of the SDK-fenced files
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)). It opens the SDK's
 * `StreamableHTTPClientTransport` and reuses the shared `connectSdkTransport` Client wrapper, surfacing only the
 * Relavium {@link McpConnection} seam. Every SDK request uses the REQUIRED host-injected validated fetch,
 * including the initialized session's request-local lanes. The host owns DNS validation and pinned
 * connection entry; the adapter binds each lane's lifetime without relaxing that existing SSRF policy.
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
export interface McpFetchWorkOptions extends ToolHostCallOptions {
  readonly signal?: AbortSignal;
}
export type McpFetch = (
  url: string | URL,
  init?: RequestInit,
  options?: McpFetchWorkOptions,
) => Promise<Response>;

/** The explicit spec for a Streamable HTTP MCP server — a host-validated absolute `http(s)` url. */
export interface HttpServerSpec {
  readonly url: string;
  /** The authored `connect_timeout_ms` (ADR-0088 §1.4). Absent ⇒ {@link MCP_DEADLINES.networkConnectMs}. */
  readonly connectTimeoutMs?: number;
  /**
   * The host's validated `fetch` — **REQUIRED**, and it used to be optional
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.1, §6).
   *
   * Absence meant the runtime's global `fetch`, which is not pinned: the SDK opens its own socket, so all
   * three §2 guarantees — connect-by-validated-IP, redirect refusal, and the transport byte bound — were gone
   * at once, silently. The justification was that a unit test which never dials need not build one, and that
   * is exactly the trade §6 refuses: a remote transport is pinned and bounded, or it is not admitted. These
   * openers are part of this package's PUBLIC surface, so "the CLI always supplies one" is a property of
   * today's only host, not of the seam. A test that never dials passes a `fetch` that throws.
   */
  readonly fetch: McpFetch;
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
  const work = new McpWorkScope();
  const retries = (retired: () => boolean) => ({
    initialReconnectionDelay: 1000,
    maxReconnectionDelay: 30000,
    reconnectionDelayGrowFactor: 1.5,
    get maxRetries(): number {
      return retired() ? 0 : 2;
    },
  });
  const base = new StreamableHTTPClientTransport(endpoint, {
    reconnectionOptions: retries(() => owner?.retired === true),
    fetch: (url, init) => {
      if (owner.retired) throw new McpLifetimeError('retired');
      return work.retainWork(() => spec.fetch(url, init, { retainWork: work.retainWork }));
    },
  });
  const owner: SdkTransportOwner = new SdkTransportOwner(
    base,
    work,
    (lifetime: SdkLaneLifetime) => {
      return new StreamableHTTPClientTransport(endpoint, {
        ...(base.sessionId === undefined ? {} : { sessionId: base.sessionId }),
        reconnectionOptions: retries(() => lifetime.retired),
        fetch: (url, init) => {
          lifetime.assertActive();
          return lifetime.work.retainWork(() =>
            spec.fetch(url, init, {
              retainWork: lifetime.work.retainWork,
              signal: lifetime.signal,
            }),
          );
        },
      });
    },
  );
  return connectSdkTransport(
    serverId,
    owner.transport,
    {
      timeoutMs: spec.connectTimeoutMs ?? MCP_DEADLINES.networkConnectMs,
      ...(signal === undefined ? {} : { signal }),
    },
    owner,
  );
}
