import {
  type EffectTier,
  type ToolDef,
  type ToolDispatchContext,
  type ToolHost,
  type ToolPolicyClass,
} from '@relavium/core';

import type { DiscoveredTool } from './connection.js';
import { McpHostUnavailableError } from './errors.js';
import {
  DiscoveryBudget,
  INGRESS_BOUNDS,
  overSizedDescription,
  toolDefinitionBytes,
} from './ingress-bounds.js';
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
  /**
   * A collision set the caller may SHARE across servers (the manager does), so a namespaced id that collides
   * with a tool from ANOTHER server also fails closed — never two `ToolDef`s with one id reaching the registry.
   * Omitted ⇒ a fresh per-call set (intra-server dedup only).
   */
  seenToolIds: Set<string> = new Set<string>(),
): ServerToolDefs {
  const defs: ToolDef[] = [];
  const skipped: SkippedTool[] = [];
  const allow = allowlist === undefined ? undefined : new Set(allowlist);
  // The aggregate half of `CR-42`. Per-item bounds alone do not bound the total: 256 tools at 8 KiB each is
  // 2 MiB before a single schema is counted, and the measured hostile catalogue was 50 000 tools / 52 GB.
  const budget = new DiscoveryBudget();

  for (const tool of tools) {
    // **The diagnostic is bounded by the same catalogue limit as the admission**, and this guard is here
    // because the regression test was slow rather than because anyone read it: bounding what is ADMITTED
    // while recording one entry per REFUSED tool just moves the flood — the measured 50 000-tool catalogue
    // produced 50 000 skip entries, each of which the host renders to stderr. Past this point a server has
    // already told us its catalogue is beyond the bound; further entries add nothing.
    if (skipped.length >= INGRESS_BOUNDS.toolsPerServer) {
      const remaining = tools.length - tools.indexOf(tool);
      skipped.push({
        name: tool.name,
        reason: `and ${remaining} further tool(s) refused — the server's catalogue is beyond the ingress bounds`,
      });
      break;
    }
    if (allow !== undefined && !allow.has(tool.name)) {
      skipped.push({ name: tool.name, reason: 'not in the server tools_allowlist' });
      continue;
    }
    // **Bounded BEFORE the schema is compiled**, because compiling is the expensive part and a hostile server
    // should not get it for free. The description bound refuses one tool; the budget refuses the rest of the
    // catalogue too, deliberately — see `DiscoveryBudget.admit`.
    const oversized = overSizedDescription(tool.description);
    if (oversized !== undefined) {
      skipped.push({ name: tool.name, reason: oversized });
      continue;
    }
    const exhausted = budget.admit(toolDefinitionBytes(tool));
    if (exhausted !== undefined) {
      // The budget is order-stable and refuses everything after it is spent, so a per-tool reason from here
      // adds no information — one entry naming the remainder is the whole diagnostic.
      const remaining = tools.length - tools.indexOf(tool);
      skipped.push({
        name: tool.name,
        reason: remaining > 1 ? `${exhausted} (and ${remaining - 1} further tool(s))` : exhausted,
      });
      break;
    }
    if (tool.name.trim() === '') {
      skipped.push({ name: tool.name, reason: 'empty tool name' });
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
    if (seenToolIds.has(id)) {
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
    seenToolIds.add(id);
    const validator = compiled.schema;
    const originalName = tool.name;
    defs.push({
      id,
      source: 'mcp',
      description: tool.description ?? '',
      parseArgs: (raw: unknown): unknown => validator.parse(raw) as unknown,
      llmVisibleParams: tool.inputSchema,
      policy: MCP_TOOL_POLICY,
      // **Every discovered MCP tool is tier 3, unconditionally** (ADR-0080 §5). Not a placeholder pending
      // richer metadata: an MCP server's own annotations (`readOnlyHint` / `idempotentHint` / …) are
      // attacker-controlled bytes from the very party the hostile-MCP class defends against, so they may
      // never RAISE trust. A server cannot talk its way out of being journaled, and it cannot declare its
      // effects benign either — `duplicationBenign` is first-party-only and is deliberately not set here.
      effect: (): EffectTier => 3,
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
