/**
 * The engine-side `ToolRegistry` + dispatch (1.T). Pure: it owns tool POLICY + DISPATCH and performs
 * every side effect through the injected {@link ToolHost} (ADR-0037). The dispatch lifecycle's order is
 * security-load-bearing — the effective argument set is assembled and validated BEFORE the guardrail
 * checks, so a `tool` node (whose args come entirely from `input_mapping`, no model args) cannot bypass
 * the allowlist by being checked before its args exist. The canonical contract is
 * [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md).
 */

import { boundForModel } from './bounding.js';
import {
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolDispatchError,
  ToolExecutionError,
  ToolPolicyError,
  UnknownToolError,
} from './errors.js';
import { markUntrusted } from './untrusted.js';
import {
  DEFAULT_TOOL_RESULT_LIMITS,
  type CreateToolRegistryOptions,
  type ToolCallPart,
  type ToolDef,
  type ToolDispatchContext,
  type ToolDispatchOutcome,
  type ToolHost,
  type ToolId,
  type ToolResultPart,
} from './types.js';

/** Build the engine-side tool registry. Performs no I/O and reads no ambient state (engine purity). */
export function createToolRegistry(options: CreateToolRegistryOptions): {
  dispatch(toolCall: ToolCallPart, ctx: ToolDispatchContext): Promise<ToolDispatchOutcome>;
  has(id: ToolId): boolean;
  list(): readonly ToolId[];
} {
  const tools = new Map<ToolId, ToolDef>();
  for (const def of options.tools) {
    if (tools.has(def.id)) {
      throw new Error(`duplicate tool id \`${def.id}\` registered`);
    }
    tools.set(def.id, def);
  }
  const host = options.host;

  return {
    has: (id) => tools.has(id),
    list: () => [...tools.keys()].sort(),
    dispatch: (toolCall, ctx) => dispatch(tools, host, toolCall, ctx),
  };
}

async function dispatch(
  tools: ReadonlyMap<ToolId, ToolDef>,
  host: ToolHost,
  toolCall: ToolCallPart,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchOutcome> {
  throwIfAborted(ctx, undefined);

  // A provider-executed tool_call is NOT dispatched by the engine (content.ts; ADR-0030/0029) — the
  // engine never runs it or applies its allowlist. Surfacing it here is a caller bug.
  if (toolCall.providerExecuted === true) {
    throw new ToolPolicyError(
      toolCall.name,
      'not_granted',
      `tool \`${toolCall.name}\` is provider-executed and is not dispatched by the engine`,
    );
  }

  // 1. Resolve by exact id, then check the node grant (registered ≠ authorized).
  const def = tools.get(toolCall.name);
  if (def === undefined) {
    throw new UnknownToolError(toolCall.name, [...tools.keys()]);
  }
  if (!ctx.grantedToolIds.has(def.id)) {
    throw new ToolPolicyError(
      def.id,
      'not_granted',
      `tool \`${def.id}\` is not granted to node \`${ctx.nodeId}\``,
    );
  }

  // 2. Assemble the effective argument set (model args + input_mapping + config-only, config wins).
  const effective = assembleArgs(def, toolCall.args, ctx);

  // 3. Validate the COMPLETE effective set: secret-taint first (ADR-0029(c)), then the tool's validator.
  assertNoTaintedArgs(def.id, effective, ctx.secretArgKeys);
  let args: unknown;
  try {
    args = def.parseArgs(effective);
  } catch (cause) {
    throw toArgsInvalid(def.id, cause);
  }

  // 4. Enforce the guardrail policy on the EFFECTIVE args (the resolved command/URL is now real).
  enforcePolicy(def, args, ctx);

  // 5. The single side effect. An AbortSignal-origin failure is the cancellation path, not tool_failed.
  let output: unknown;
  try {
    throwIfAborted(ctx, def.id);
    output = await def.dispatch(args, host, ctx);
  } catch (cause) {
    if (isAbort(cause, ctx)) {
      throw new ToolCancelledError(def.id, cause);
    }
    if (cause instanceof ToolDispatchError) {
      throw cause; // a typed error from dispatch (e.g. ToolUnavailableError) passes through
    }
    throw new ToolExecutionError(def.id, `tool \`${def.id}\` failed`, cause);
  }

  // 6. output_mapping runs on the FULL result → workflow state keeps the real value.
  const outputMapped = applyOutputMapping(output, ctx.config.outputMapping);

  // 7. Bound the MODEL-FACING result (the full result is untouched above).
  const limits = ctx.limits ?? DEFAULT_TOOL_RESULT_LIMITS;
  const bounded = await boundForModel(output, limits, host, ctx.signal);

  // 8. Brand the model-facing result untrusted + shape the sanitized event payloads.
  const toolResult: ToolResultPart = {
    type: 'tool_result',
    toolCallId: toolCall.id,
    result: bounded.value,
  };
  return {
    output: outputMapped,
    toolResult: markUntrusted(toolResult),
    truncated: bounded.truncated,
    events: {
      call: { toolId: def.id, toolInput: sanitizeInput(def, effective, ctx.secretArgKeys) },
      result: { toolId: def.id, success: true, outputSummary: bounded.summary },
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 2 — effective args. Precedence: model args (base) < input_mapping (author-wired) < config-only.
 * ------------------------------------------------------------------------------------------------ */

function assembleArgs(
  def: ToolDef,
  modelArgs: unknown,
  ctx: ToolDispatchContext,
): Record<string, unknown> {
  const effective: Record<string, unknown> = isRecord(modelArgs) ? { ...modelArgs } : {};
  const mapping = ctx.config.inputMapping;
  if (mapping !== undefined) {
    for (const [key, value] of Object.entries(mapping)) {
      effective[key] = value;
    }
  }
  const params = ctx.config.parameters;
  if (def.configOnlyParams !== undefined && params !== undefined) {
    for (const key of def.configOnlyParams) {
      if (Object.prototype.hasOwnProperty.call(params, key)) {
        effective[key] = params[key];
      }
    }
  }
  return effective;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 3 — secret taint (ADR-0029(c), re-applied on the effective set) + arg validation.
 * ------------------------------------------------------------------------------------------------ */

function assertNoTaintedArgs(
  toolId: ToolId,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): void {
  if (secretArgKeys === undefined || secretArgKeys.size === 0) {
    return;
  }
  const tainted = Object.keys(effective).filter((key) => secretArgKeys.has(key));
  if (tainted.length > 0) {
    throw new ToolArgsInvalidError(
      toolId,
      tainted.sort(),
      `tool \`${toolId}\`: a secret-typed value cannot flow into tool arguments (${tainted
        .sort()
        .join(', ')}) — use a credential reference (ADR-0029)`,
    );
  }
}

function toArgsInvalid(toolId: ToolId, cause: unknown): ToolArgsInvalidError {
  const fields = zodIssuePaths(cause);
  const where = fields.length > 0 ? ` (${fields.join(', ')})` : '';
  return new ToolArgsInvalidError(toolId, fields, `tool \`${toolId}\`: invalid arguments${where}`, cause);
}

/** Extract field paths from a ZodError-shaped cause — names only, never the received value. */
function zodIssuePaths(cause: unknown): readonly string[] {
  if (!isRecord(cause)) {
    return [];
  }
  const issues = cause['issues'];
  if (!Array.isArray(issues)) {
    return [];
  }
  const paths = new Set<string>();
  for (const issue of issues) {
    if (isRecord(issue)) {
      const path = issue['path'];
      if (Array.isArray(path)) {
        paths.add(path.map((segment: unknown) => String(segment)).join('.') || '(root)');
      }
    }
  }
  return [...paths].sort();
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 4 — guardrail policy on the effective args.
 * ------------------------------------------------------------------------------------------------ */

function enforcePolicy(def: ToolDef, args: unknown, ctx: ToolDispatchContext): void {
  if (def.policy.requiresGateApproval && !ctx.gateApproved) {
    throw new ToolPolicyError(
      def.id,
      'gate_required',
      `tool \`${def.id}\` requires a human-gate approval in an automated workflow`,
    );
  }

  const target = def.policyTarget?.(args) ?? {};

  if (def.policy.spawnsProcess && target.command !== undefined) {
    if (!commandAllowed(target.command, ctx.toolPolicy)) {
      throw new ToolPolicyError(
        def.id,
        'command_not_allowed',
        `tool \`${def.id}\`: command not in the allowedCommands allowlist`,
      );
    }
  }

  if (def.policy.egress === 'http' && target.url !== undefined) {
    enforceHttpEgress(def.id, target.url, ctx);
  }
  // egress 'search' / 'mcp' reach a CONFIGURED provider/server (not an allowedDomains allowlist); the
  // SSRF range-block runs inside the host egress capability (1.AE). No engine allowlist check here.
}

function commandAllowed(
  command: string,
  policy: import('@relavium/shared').ToolPolicy,
): boolean {
  const exact = policy.allowedCommands ?? [];
  if (exact.includes(command)) {
    return true; // exact match (ADR-0029(a)) — `git` never authorizes `git push --force`
  }
  for (const glob of policy.allowedCommandGlobs ?? []) {
    if (globMatch(glob, command)) {
      return true; // opt-in glob
    }
  }
  return false; // empty/absent ⇒ deny-all (symmetry with allowedDomains)
}

function enforceHttpEgress(toolId: ToolId, url: string, ctx: ToolDispatchContext): void {
  const parsed = extractHttpsHost(url);
  if (parsed === null || parsed.hasCredentials) {
    throw new ToolPolicyError(
      toolId,
      'insecure_url',
      `tool \`${toolId}\`: outbound URL must be HTTPS without embedded credentials`,
    );
  }
  const allowed = ctx.toolPolicy.allowedDomains ?? [];
  if (!allowed.includes(parsed.host)) {
    throw new ToolPolicyError(
      toolId,
      'domain_not_allowed',
      `tool \`${toolId}\`: host not in the allowedDomains allowlist`,
    );
  }
  // The SSRF range-block (private/loopback/link-local/metadata) + connect-pinning is the host egress
  // capability's job (the one shared primitive, 1.AE) — never re-implemented in the pure engine.
}

/**
 * Extract the lowercased FQDN host from an HTTPS URL with pure string parsing (no `URL` global — the
 * engine-purity `lib` has no DOM). Returns null for a non-HTTPS URL. This is the exact-FQDN POLICY
 * half only; the SSRF range-block is the host's job.
 */
function extractHttpsHost(url: string): { host: string; hasCredentials: boolean } | null {
  const match = /^https:\/\/([^/?#]+)/i.exec(url);
  if (match === null) {
    return null;
  }
  let authority = match[1] ?? '';
  let hasCredentials = false;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    hasCredentials = true;
    authority = authority.slice(at + 1);
  }
  let host: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    host = end === -1 ? authority : authority.slice(1, end); // IPv6 literal
  } else {
    const colon = authority.indexOf(':');
    host = colon === -1 ? authority : authority.slice(0, colon);
  }
  return { host: host.toLowerCase(), hasCredentials };
}

/** A minimal, well-bounded glob: `*` (any run) and `?` (one char), everything else literal, full match. */
function globMatch(glob: string, value: string): boolean {
  let pattern = '^';
  for (const ch of glob) {
    if (ch === '*') {
      pattern += '.*';
    } else if (ch === '?') {
      pattern += '.';
    } else {
      pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  pattern += '$';
  return new RegExp(pattern).test(value);
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 6 — output_mapping (full result → workflow-state projection).
 * ------------------------------------------------------------------------------------------------ */

function applyOutputMapping(
  full: unknown,
  mapping: Readonly<Record<string, string>> | undefined,
): unknown {
  if (mapping === undefined) {
    return full;
  }
  const out: Record<string, unknown> = {};
  for (const [stateKey, path] of Object.entries(mapping)) {
    out[stateKey] = readPath(full, path);
  }
  return out;
}

/** Read a simple dot-path (`a.b.c`) from a value; undefined when any segment is absent. */
function readPath(value: unknown, path: string): unknown {
  if (path === '') {
    return value;
  }
  let cursor = value;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 8 — event-input sanitization (config-only + secret-tainted keys removed). The bus does final
 * generic masking (ADR-0036); this strips the tool-aware sensitive fields only the registry knows.
 * ------------------------------------------------------------------------------------------------ */

function sanitizeInput(
  def: ToolDef,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...effective };
  for (const key of def.configOnlyParams ?? []) {
    delete out[key];
  }
  if (secretArgKeys !== undefined) {
    for (const key of secretArgKeys) {
      delete out[key];
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ *
 * Cancellation + small guards.
 * ------------------------------------------------------------------------------------------------ */

function throwIfAborted(ctx: ToolDispatchContext, toolId: ToolId | undefined): void {
  if (ctx.signal?.aborted === true) {
    throw new ToolCancelledError(toolId);
  }
}

function isAbort(cause: unknown, ctx: ToolDispatchContext): boolean {
  if (ctx.signal?.aborted === true) {
    return true;
  }
  return cause instanceof Error && cause.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
