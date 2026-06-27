/**
 * Typed errors for the inbound MCP layer. Their `message` is **secret-free** (a server id / tool id / reason —
 * never an env value, a resolved secret, or a raw provider payload) so it is safe to surface in a log, an
 * event, or the `--json` stream. A `cause` chain (when present) is an **opaque diagnostic** for local
 * debugging: it carries no env/secret data, but it MAY carry the spawned command/args, so the host MUST NOT
 * surface `cause` verbatim in a structured `--json` envelope or a `RunEvent` — it strips it at that boundary.
 */

/** Base class for every `@relavium/mcp` error. */
export class McpError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpError';
  }
}

/**
 * A declared MCP server could not be spawned/connected or failed `tools/list` at agent init. Fail-loud: a
 * declared capability that cannot be reached is a configuration error, not a silent capability loss
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2). `cause`
 * is the underlying SDK/spawn error — opaque (see the module note); never surfaced verbatim downstream.
 */
export class McpConnectError extends McpError {
  constructor(serverId: string, options?: { cause?: unknown }) {
    super(`MCP server "${serverId}" could not be connected or listed`, options);
    this.name = 'McpConnectError';
  }
}

/**
 * An MCP-backed tool was dispatched but the host's `McpCapability` (`host.mcp`) is not wired — a host
 * assembly bug, surfaced as a tool execution error rather than a silent no-op.
 */
export class McpHostUnavailableError extends McpError {
  constructor(toolId: string) {
    super(`the MCP capability is not wired on the host (tool "${toolId}")`);
    this.name = 'McpHostUnavailableError';
  }
}
