import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { DiscoveredTool, McpConnection, McpToolResult } from './connection.js';
import { McpConnectError } from './errors.js';
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
}

const CLIENT_INFO = { name: 'relavium', version: '0.1.0' } as const;

/** Spawn + connect a stdio MCP server and run the MCP initialize handshake; returns the live connection. */
export async function openStdioConnection(
  serverId: string,
  spec: StdioServerSpec,
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
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (err) {
    await safeClose(client);
    throw new McpConnectError(serverId, { cause: err });
  }
  return new StdioConnection(client);
}

class StdioConnection implements McpConnection {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  async listTools(): Promise<readonly DiscoveredTool[]> {
    const result = await this.#client.listTools();
    return result.tools.map(
      (tool): DiscoveredTool => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      }),
    );
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const result = await this.#client.callTool({
      name,
      arguments: isRecord(args) ? args : undefined,
    });
    return shapeToolResult(result);
  }

  async close(): Promise<void> {
    await safeClose(this.#client);
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
