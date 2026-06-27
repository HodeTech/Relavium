/**
 * `@relavium/mcp` — the inbound MCP client layer (workstream 2.R).
 *
 * This package fences the `@modelcontextprotocol/sdk` and the Node host mechanism (stdio spawn / network
 * connect, `tools/list` discovery) and surfaces outward **only Relavium/Zod shapes** — discovered tools as
 * `ToolDef`s plus an `McpCapability` implementation — so the engine (`packages/core`) never imports the SDK
 * or `node:*` ([ADR-0034](../../../docs/decisions/0034-mcp-client-sdk-dependency.md) g3 /
 * [ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1).
 *
 * Exports: the dependency-free JSON-Schema → Zod compiler; the `McpConnection` seam + the stdio SDK adapter
 * (`openStdioConnection`) that fences `@modelcontextprotocol/sdk`; the discovered-tool → `ToolDef` shaping
 * (`buildServerToolDefs`); and the lifecycle manager — `startMcpClient` returns an `McpClient` (fail-loud
 * connect-all + the aggregate `ToolDef`s + the `McpCapability` routing + `close()`). The **CLI host wiring**
 * (composing the manager into the engine's `ToolRegistry` + `ToolHost`) + the network transports + secrets
 * land in following steps.
 */
export {
  compileJsonSchemaToZod,
  type CompileResult,
  MAX_DEPTH,
  MAX_NODES,
  MAX_ENUM_MEMBERS,
  MAX_PROPERTIES,
} from './schema-compiler.js';
export type {
  McpConnection,
  DiscoveredTool,
  McpToolResult,
  McpContentPart,
  McpTextContent,
  McpNonTextContent,
} from './connection.js';
export { McpError, McpConnectError, McpHostUnavailableError } from './errors.js';
export { shapeToolResult } from './result.js';
export { buildServerToolDefs, type ServerToolDefs, type SkippedTool } from './tool-mapping.js';
export { openStdioConnection, type StdioServerSpec } from './sdk-stdio.js';
export {
  startMcpClient,
  type McpClient,
  type McpServerConfig,
  type ManagerSkippedTool,
} from './manager.js';
