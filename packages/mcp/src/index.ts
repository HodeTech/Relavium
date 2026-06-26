/**
 * `@relavium/mcp` — the inbound MCP client layer (workstream 2.R).
 *
 * This package fences the `@modelcontextprotocol/sdk` and the Node host mechanism (stdio spawn / network
 * connect, `tools/list` discovery) and surfaces outward **only Relavium/Zod shapes** — discovered tools as
 * `ToolDef`s plus an `McpCapability` implementation — so the engine (`packages/core`) never imports the SDK
 * or `node:*` ([ADR-0034](../../../docs/decisions/0034-mcp-client-sdk-dependency.md) g3 /
 * [ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §1).
 *
 * Step 1 (this slice): the dependency-free JSON-Schema → Zod compiler that builds each tool's executable
 * `parseArgs` validator. The SDK transport/client, the `McpClientManager` lifecycle, and the host wiring
 * land in the following steps.
 */
export {
  compileJsonSchemaToZod,
  type CompileResult,
  MAX_DEPTH,
  MAX_NODES,
  MAX_ENUM_MEMBERS,
  MAX_PROPERTIES,
} from './schema-compiler.js';
