import type { ToolDef, ToolDispatchContext, ToolHost, ToolPolicyClass } from '@relavium/core';

import type { DiscoveredTool } from './connection.js';
import { McpHostUnavailableError } from './errors.js';
import { compileJsonSchemaToZod } from './schema-compiler.js';

/**
 * Shape discovered MCP tools into namespaced Relavium `ToolDef`s
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3/§4).
 *
 * Each tool becomes a `ToolDef` whose:
 * - **id** is the LLM-visible namespaced name `mcp_{server}_{tool}` (the tool name sanitized to the LLM
 *   tool-name charset; routing never parses the name back — the `dispatch` closure carries the ORIGINAL
 *   `(serverId, toolName)`, so a name containing `_` is never ambiguous);
 * - **parseArgs** is the executable validator the in-house compiler builds from the server's `inputSchema`
 *   (the dispatch gate — the SDK does not validate args); an `inputSchema` outside the supported subset
 *   **drops the tool at discovery** (fail closed), never admits it unvalidated;
 * - **policy** is the shared `egress: 'mcp'` class (mirrors the `mcp_call` built-in);
 * - **dispatch** routes through the host's `McpCapability` (`host.mcp.call`) — the engine never touches the SDK.
 *
 * A per-server `tools_allowlist` narrows which tools are admitted, and a post-sanitization id collision across
 * tools **fails closed** (the colliding tool is skipped, never silently shadowing another). Skipped tools are
 * returned so the host can surface them.
 */

const MCP_TOOL_POLICY: ToolPolicyClass = {
  fsScoped: false,
  spawnsProcess: false,
  egress: 'mcp',
  requiresGateApproval: false,
};

/** The LLM tool-name charset (Anthropic/OpenAI) — the namespaced id must match this exactly. */
const LLM_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 128;

export interface SkippedTool {
  readonly name: string;
  readonly reason: string;
}
export interface ServerToolDefs {
  readonly defs: readonly ToolDef[];
  readonly skipped: readonly SkippedTool[];
}

/**
 * Build the `ToolDef`s for one server's discovered tools. `serverId` is the routing key the host's
 * `McpCapability` resolves to a connection AND the namespace segment — the caller passes a namespace-safe id
 * (an agent ref's kebab id, or a sanitized registration name). `allowlist` (the per-server `tools_allowlist`)
 * is the original tool names to admit; omitted ⇒ all discovered tools.
 */
export function buildServerToolDefs(
  serverId: string,
  tools: readonly DiscoveredTool[],
  allowlist?: readonly string[],
): ServerToolDefs {
  const defs: ToolDef[] = [];
  const skipped: SkippedTool[] = [];
  const allow = allowlist === undefined ? undefined : new Set(allowlist);
  const seenIds = new Set<string>();

  for (const tool of tools) {
    if (allow !== undefined && !allow.has(tool.name)) {
      skipped.push({ name: tool.name, reason: 'not in the server tools_allowlist' });
      continue;
    }
    const id = namespacedId(serverId, tool.name);
    if (id === undefined) {
      skipped.push({
        name: tool.name,
        reason: 'tool name is not a valid LLM tool id after namespacing',
      });
      continue;
    }
    if (seenIds.has(id)) {
      skipped.push({
        name: tool.name,
        reason: `namespaced id collides with another tool ("${id}")`,
      });
      continue;
    }
    const compiled = compileJsonSchemaToZod(tool.inputSchema);
    if (!compiled.ok) {
      skipped.push({ name: tool.name, reason: `unsupported inputSchema: ${compiled.reason}` });
      continue;
    }
    seenIds.add(id);
    const validator = compiled.schema;
    const originalName = tool.name;
    defs.push({
      id,
      source: 'mcp',
      description: tool.description ?? '',
      parseArgs: (raw: unknown): unknown => validator.parse(raw) as unknown,
      llmVisibleParams: tool.inputSchema,
      policy: MCP_TOOL_POLICY,
      dispatch: (args: unknown, host: ToolHost, ctx: ToolDispatchContext): Promise<unknown> => {
        const mcp = host.mcp;
        if (mcp === undefined) {
          throw new McpHostUnavailableError(id);
        }
        return mcp.call({ server: serverId, tool: originalName, args }, ctx.signal);
      },
    });
  }
  return { defs, skipped };
}

/**
 * The LLM-visible namespaced id `mcp_{server}_{tool}` — the tool name's non-charset bytes are mapped to `_`
 * (display only; routing uses the closure, not a name split). Returns `undefined` if the resulting id is not a
 * valid LLM tool id (e.g. an unsafe `serverId`, or an over-length id) so the caller drops the tool.
 */
function namespacedId(serverId: string, toolName: string): string | undefined {
  const id = `mcp_${serverId}_${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (id.length > MAX_TOOL_NAME_LENGTH || !LLM_TOOL_NAME.test(id)) {
    return undefined;
  }
  return id;
}
