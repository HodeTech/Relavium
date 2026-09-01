import {
  type EffectTier,
  type ToolDef,
  type ToolDispatchContext,
  type ToolHost,
  type ToolPolicyClass,
} from '@relavium/core';

import { stripTerminalControls } from '@relavium/shared';

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
  /** The server's tool name, TERMINAL-SANITIZED — see {@link buildServerToolDefs}'s `skip`. */
  readonly name: string;
  /** Why it was dropped, TERMINAL-SANITIZED — a reason can quote the server's own schema text. */
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
  /**
   * The ONE place a refused tool is recorded — sanitized here rather than at whichever surface renders it
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §7.1).
   *
   * §7.1 already required this of an ADMITTED tool's `description`, and gave the reason: a poisoned string
   * otherwise reaches a log, an approval prompt and the provider before anyone strips it. The SKIPPED entries
   * are the same bytes from the same hostile source, down the path a hostile server actually takes, and they
   * were carried raw.
   *
   * **The `name` is the live one; the `reason` arm is deliberate defence in depth, and saying so is the
   * point.** No reason string can carry server bytes TODAY — the compiler's refusals do interpolate a key
   * (`unsupported JSON-Schema construct: "<key>"`), but `semanticControlByte` drops such a schema before the
   * compiler sees it, and a test pins that ordering. Sanitizing both anyway is what keeps this a boundary
   * rather than a coincidence of which refusal happens to fire first.
   *
   * This does NOT cross §7.1's presentation/semantic line. A skipped tool has no wire contract left to
   * desynchronise — it was dropped — so its name is pure presentation here, unlike the admitted name that
   * `namespacedId` must round-trip.
   *
   * The CLI's own render sanitizes again (`mcpSkippedLines`), so this closes no live injection there. It
   * closes the SHAPE: `drive-home.tsx` and `doctor-deep.ts` both interpolate these fields directly, and each
   * is one render-site refactor away from being the hole. A boundary every consumer must remember is the
   * boundary that gets forgotten.
   */
  const skip = (name: string, reason: string): void => {
    skipped.push({ name: stripTerminalControls(name), reason: stripTerminalControls(reason) });
  };
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
      skip(
        tool.name,
        `and ${remaining} further tool(s) refused — the server's catalogue is beyond the ingress bounds`,
      );
      break;
    }
    if (allow !== undefined && !allow.has(tool.name)) {
      skip(tool.name, 'not in the server tools_allowlist');
      continue;
    }
    // **Bounded BEFORE the schema is compiled**, because compiling is the expensive part and a hostile server
    // should not get it for free. The description bound refuses one tool; the budget refuses the rest of the
    // catalogue too, deliberately — see `DiscoveryBudget.admit`.
    const oversized = overSizedDescription(tool.description);
    if (oversized !== undefined) {
      skip(tool.name, oversized);
      continue;
    }
    const exhausted = budget.admit(toolDefinitionBytes(tool));
    if (exhausted !== undefined) {
      // The budget is order-stable and refuses everything after it is spent, so a per-tool reason from here
      // adds no information — one entry naming the remainder is the whole diagnostic.
      const remaining = tools.length - tools.indexOf(tool);
      skip(tool.name, remaining > 1 ? `${exhausted} (and ${remaining - 1} further tool(s))` : exhausted);
      break;
    }
    if (tool.name.trim() === '') {
      skip(tool.name, 'empty tool name');
      continue;
    }
    const id = namespacedId(serverId, tool.name);
    if (id === undefined) {
      skip(tool.name, 'tool name is not a valid LLM tool id after namespacing');
      continue;
    }
    if (seenToolIds.has(id)) {
      skip(tool.name, `namespaced id collides with another tool ("${id}")`);
      continue;
    }
    // **Presentation text is sanitized; a SEMANTIC field is never rewritten** (ADR-0088 §7.1, `#202`).
    //
    // The distinction is load-bearing rather than tidy. A `description` is text shown to a model or a human,
    // and stripping terminal-control bytes from it changes nothing else. A property NAME, a `const`/`enum`
    // value and a `required` entry are simultaneously the model-visible schema, the compiled validator's
    // expectation, and the wire contract with the server — rewriting one desynchronises all three and
    // produces a tool that is broken rather than safe. So a semantic field carrying a control byte drops the
    // TOOL, fail-closed, through the same path an unsupported schema takes.
    const unsafeField = semanticControlByte(tool);
    if (unsafeField !== undefined) {
      skip(tool.name, unsafeField);
      continue;
    }
    const compiled = compileJsonSchemaToZod(tool.inputSchema);
    if (!compiled.ok) {
      skip(tool.name, `unsupported inputSchema: ${compiled.reason}`);
      continue;
    }
    seenToolIds.add(id);
    const validator = compiled.schema;
    const originalName = tool.name;
    defs.push({
      id,
      source: 'mcp',
      // Sanitized at DISCOVERY, not at whichever surface happens to render it: a poisoned description
      // otherwise reaches a log, an approval prompt and the provider before anyone strips it (§7.1).
      description: stripTerminalControls(tool.description ?? ''),
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
 * Whether any SEMANTIC field of a discovered tool carries a terminal-control or bidi byte — the fields that
 * cannot be sanitized because rewriting them would desynchronise the model-visible schema, the compiled
 * validator and the wire contract (ADR-0088 §7.1).
 *
 * A legitimate server has no reason to put a control character in a tool name, a property name, or a `const`
 * value. Checked against the serialized schema rather than by walking it, because the serialization is what
 * reaches the provider — and because a walker would have to know every place a string can hide.
 */
function semanticControlByte(tool: DiscoveredTool): string | undefined {
  if (hasControlByte(tool.name)) {
    return 'tool name contains a terminal-control or bidi character';
  }
  return schemaHasControlByte(tool.inputSchema, { visited: 0 })
    ? 'inputSchema contains a terminal-control or bidi character'
    : undefined;
}

/** Whether stripping changes the string — i.e. it carried a terminal-control or bidi byte. */
function hasControlByte(text: string): boolean {
  return stripTerminalControls(text) !== text;
}

/**
 * Walk a JSON value for a control byte in ANY string — a key or a value, at any depth.
 *
 * **A walker rather than a check on the serialized form, and the difference is a hole I shipped first.**
 * `JSON.stringify` escapes C0 controls into six-character TEXT (`\u001b`), so the byte being hunted is not in
 * the serialization at all — a property name of `bad\u001b[31m` sailed straight through. It does NOT escape
 * DEL, C1, or the bidi controls, so the serialized check caught some cases and missed others, which is worse
 * than catching none: it reads as a working guard.
 *
 * **Bounded by NODES VISITED, not by depth — and a review proved why that distinction matters.** A first
 * version used a depth ceiling of 16, "mirroring the compiler's `MAX_DEPTH`". It does not mirror it: the
 * compiler counts one level per schema-semantic transition, while a JS walk also descends through each
 * `properties` container, so the walk's depth grows about twice as fast. Measured: a control-byte-free schema
 * nested to semantic depth 8 — comfortably inside the compiler's budget — was already reported "unsafe", and
 * a legitimate tool was dropped with a message naming a defect it did not have.
 *
 * A node budget is the honest bound anyway: total work is what a DoS guard is about, and 2000 is the same
 * ceiling `MAX_NODES` gives the compiler — so a schema this walk cannot finish is one the compiler refuses on
 * its own terms. The depth ceiling stays only as a stack guard, far above any real schema.
 */
function schemaHasControlByte(value: unknown, budget: { visited: number }, depth = 0): boolean {
  if (depth > MAX_SCHEMA_WALK_DEPTH) return true;
  if ((budget.visited += 1) > MAX_SCHEMA_WALK_NODES) return true;
  if (typeof value === 'string') return hasControlByte(value);
  if (Array.isArray(value)) {
    return value.some((item) => schemaHasControlByte(item, budget, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([key, item]) => hasControlByte(key) || schemaHasControlByte(item, budget, depth + 1),
    );
  }
  return false;
}

/** The compiler's own total-work ceiling (`MAX_NODES`) — a schema past it is refused there anyway. */
const MAX_SCHEMA_WALK_NODES = 2000;
/** A stack guard only, deliberately far above any real schema — the NODE budget is the real bound. */
const MAX_SCHEMA_WALK_DEPTH = 128;

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
