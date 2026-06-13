/**
 * The built-in `ToolDef` catalog (1.T) — the twelve tools every local agent can call
 * ([built-in-tools.md](../../../../docs/reference/shared-core/built-in-tools.md)). Each is engine-pure:
 * `parseArgs` is the executable Zod validator (the full effective-arg set, including config-only params),
 * `llmVisibleParams` is the LLM-facing projection the `ToolNormalizer` (1.E) lowers, and `dispatch`
 * performs side effects ONLY through the injected `ToolHost`. The egress tools (`http_request` /
 * `web_search` / `mcp_call`) are dispatchable against a stub host now and ship gated at the surfaces
 * until the shared SSRF primitive lands (1.AE) — i.e. their host capability is simply not wired yet.
 */

import { z } from 'zod';

import { ToolUnavailableError } from './errors.js';
import {
  type EgressCapability,
  type FsCapability,
  type JsonSchema,
  type McpCapability,
  type OsCapability,
  type PolicyTarget,
  type ProcessCapability,
  type ToolDef,
  type ToolDispatchContext,
  type ToolHost,
  type ToolId,
  type ToolPolicyClass,
} from './types.js';

/* ------------------------------------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------------------------------------ */

// Generic over the validated arg type `A` (inferred from `args: z.ZodType<A>`), not over the schema
// type, so `parseArgs` returns a real `A` rather than `z.infer<ZodTypeAny>` (= `any`).
interface BuiltinSpec<A> {
  readonly id: ToolId;
  readonly description: string;
  readonly args: z.ZodType<A>;
  readonly llmVisibleParams: JsonSchema;
  readonly configOnlyParams?: readonly string[];
  readonly policy: ToolPolicyClass;
  readonly policyTarget?: (args: A) => PolicyTarget;
  readonly dispatch: (args: A, host: ToolHost, ctx: ToolDispatchContext) => Promise<unknown>;
}

function defineBuiltin<A>(spec: BuiltinSpec<A>): ToolDef {
  const def: ToolDef<A> = {
    id: spec.id,
    source: 'builtin',
    description: spec.description,
    parseArgs: (raw: unknown): A => spec.args.parse(raw),
    llmVisibleParams: spec.llmVisibleParams,
    policy: spec.policy,
    ...(spec.configOnlyParams !== undefined ? { configOnlyParams: spec.configOnlyParams } : {}),
    ...(spec.policyTarget !== undefined ? { policyTarget: spec.policyTarget } : {}),
    dispatch: spec.dispatch,
  };
  // Erase the `Args` generic so heterogeneous tools share one `ToolDef[]`. The cast is necessary —
  // `policyTarget`'s parameter is contravariant — and safe by construction: the registry validates via
  // `parseArgs` BEFORE it ever calls `dispatch`/`policyTarget`, so the value those receive is exactly `A`.
  return def as ToolDef;
}

function requireFs(host: ToolHost, toolId: ToolId): FsCapability {
  if (host.fs === undefined) {
    throw new ToolUnavailableError(toolId, 'fs');
  }
  return host.fs;
}
function requireProcess(host: ToolHost, toolId: ToolId): ProcessCapability {
  if (host.process === undefined) {
    throw new ToolUnavailableError(toolId, 'process');
  }
  return host.process;
}
function requireEgress(host: ToolHost, toolId: ToolId): EgressCapability {
  if (host.egress === undefined) {
    throw new ToolUnavailableError(toolId, 'egress');
  }
  return host.egress;
}
function requireOs(host: ToolHost, toolId: ToolId): OsCapability {
  if (host.os === undefined) {
    throw new ToolUnavailableError(toolId, 'os');
  }
  return host.os;
}
function requireMcp(host: ToolHost, toolId: ToolId): McpCapability {
  if (host.mcp === undefined) {
    throw new ToolUnavailableError(toolId, 'mcp');
  }
  return host.mcp;
}

const FS_POLICY: ToolPolicyClass = { fsScoped: true, spawnsProcess: false, requiresGateApproval: false };
const OS_POLICY: ToolPolicyClass = { fsScoped: false, spawnsProcess: false, requiresGateApproval: false };

/* ------------------------------------------------------------------------------------------------ *
 * Filesystem tools.
 * ------------------------------------------------------------------------------------------------ */

const readFileTool = defineBuiltin({
  id: 'read_file',
  description: 'Read a text file as UTF-8; binary/media content returns a durable media handle.',
  args: z.object({ path: z.string().min(1), glob: z.boolean().optional() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { path: { type: 'string' }, glob: { type: 'boolean' } },
    required: ['path'],
    additionalProperties: false,
  },
  policy: FS_POLICY,
  dispatch: (args, host, ctx) =>
    requireFs(host, 'read_file').readFile(args.path, { glob: args.glob }, ctx.signal),
});

const writeFileTool = defineBuiltin({
  id: 'write_file',
  description: 'Write or append content to a file, within the allowed FS scope only.',
  args: z
    .object({
      path: z.string().min(1),
      content: z.string(),
      append: z.boolean().optional(),
      createDirs: z.boolean().optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      append: { type: 'boolean' },
      createDirs: { type: 'boolean' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  policy: FS_POLICY,
  dispatch: (args, host, ctx) =>
    requireFs(host, 'write_file').writeFile(
      args.path,
      args.content,
      { append: args.append, createDirs: args.createDirs },
      ctx.signal,
    ),
});

const listDirectoryTool = defineBuiltin({
  id: 'list_directory',
  description: 'List directory contents, optionally recursive with a glob filter.',
  args: z
    .object({ path: z.string().min(1), recursive: z.boolean().optional(), glob: z.string().optional() })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      recursive: { type: 'boolean' },
      glob: { type: 'string' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  policy: FS_POLICY,
  dispatch: (args, host, ctx) =>
    requireFs(host, 'list_directory').listDirectory(
      args.path,
      { recursive: args.recursive, glob: args.glob },
      ctx.signal,
    ),
});

/* ------------------------------------------------------------------------------------------------ *
 * Process tools.
 * ------------------------------------------------------------------------------------------------ */

const runCommandTool = defineBuiltin({
  id: 'run_command',
  description: 'Spawn an allowlisted shell command (shell:false) and capture stdout/stderr/exit code.',
  args: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: z.record(z.string()).optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
    additionalProperties: false,
  },
  // cwd / timeoutMs / env are pinned by config, never model-supplied.
  configOnlyParams: ['cwd', 'timeoutMs', 'env'],
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: false },
  // The resolved command the exact-match allowedCommands allowlist inspects (ADR-0029(a)).
  policyTarget: (args) => ({ command: [args.command, ...(args.args ?? [])].join(' ') }),
  dispatch: (args, host, ctx) =>
    requireProcess(host, 'run_command').spawn(
      args.command,
      args.args ?? [],
      args.env ?? {},
      { cwd: args.cwd, timeoutMs: args.timeoutMs },
      ctx.signal,
    ),
});

const gitStatusTool = defineBuiltin({
  id: 'git_status',
  description: 'Run git status / log / diff in the workspace (pre-approved git allowlist).',
  args: z
    .object({ command: z.enum(['status', 'log', 'diff']).optional(), args: z.array(z.string()).optional() })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['status', 'log', 'diff'] },
      args: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  // Pre-approved: no policyTarget command, so the generic allowedCommands check is skipped.
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: false },
  dispatch: (args, host, ctx) =>
    requireProcess(host, 'git_status').spawn(
      'git',
      [args.command ?? 'status', ...(args.args ?? [])],
      {},
      {},
      ctx.signal,
    ),
});

const gitCommitTool = defineBuiltin({
  id: 'git_commit',
  description: 'Stage files and create a commit — requires a human-gate approval in automated workflows.',
  args: z.object({ message: z.string().min(1), files: z.array(z.string()).optional() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
    required: ['message'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: true },
  dispatch: (args, host, ctx) =>
    requireProcess(host, 'git_commit').spawn(
      'git',
      ['commit', '-m', args.message, ...(args.files ?? [])],
      {},
      {},
      ctx.signal,
    ),
});

/* ------------------------------------------------------------------------------------------------ *
 * Egress tools (gated until the shared SSRF primitive lands — 1.AE).
 * ------------------------------------------------------------------------------------------------ */

const httpRequestTool = defineBuiltin({
  id: 'http_request',
  description: 'Outbound HTTPS request to an allowedDomains host (HTTPS-only, exact-FQDN, SSRF-guarded).',
  args: z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
      url: z.string().min(1),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      url: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      body: { type: 'string' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: false, egress: 'http', requiresGateApproval: false },
  policyTarget: (args) => ({ url: args.url }),
  dispatch: (args, host, ctx) =>
    requireEgress(host, 'http_request').fetch(
      { method: args.method ?? 'GET', url: args.url, headers: args.headers, body: args.body },
      ctx.signal,
    ),
});

const webSearchTool = defineBuiltin({
  id: 'web_search',
  description: 'Search the web via the configured provider (key resolved host-side via a credential ref).',
  args: z
    .object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional(),
      // Config-pinned: the provider endpoint + the opaque secret-store reference (never a raw key).
      endpoint: z.string().optional(),
      credentialRef: z.string().optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { query: { type: 'string' }, maxResults: { type: 'integer', minimum: 1 } },
    required: ['query'],
    additionalProperties: false,
  },
  configOnlyParams: ['endpoint', 'credentialRef'],
  policy: { fsScoped: false, spawnsProcess: false, egress: 'search', requiresGateApproval: false },
  dispatch: (args, host, ctx) => {
    const endpoint = args.endpoint ?? '';
    const url = `${endpoint}?q=${encodeURIComponent(args.query)}`;
    return requireEgress(host, 'web_search').fetch(
      { method: 'GET', url, credentialRef: args.credentialRef },
      ctx.signal,
    );
  },
});

const mcpCallTool = defineBuiltin({
  id: 'mcp_call',
  description: 'Invoke a tool on a configured MCP server (server URL runs the same SSRF primitive).',
  args: z.object({ server: z.string().min(1), tool: z.string().min(1), args: z.unknown().optional() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { server: { type: 'string' }, tool: { type: 'string' }, args: {} },
    required: ['server', 'tool'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: false, egress: 'mcp', requiresGateApproval: false },
  dispatch: (args, host, ctx) =>
    requireMcp(host, 'mcp_call').call({ server: args.server, tool: args.tool, args: args.args }, ctx.signal),
});

/* ------------------------------------------------------------------------------------------------ *
 * OS + orchestration tools.
 * ------------------------------------------------------------------------------------------------ */

const readClipboardTool = defineBuiltin({
  id: 'read_clipboard',
  description: 'Read the current clipboard text.',
  args: z.object({}).strict(),
  llmVisibleParams: { type: 'object', properties: {}, additionalProperties: false },
  policy: OS_POLICY,
  dispatch: (_args, host, ctx) => requireOs(host, 'read_clipboard').readClipboard(ctx.signal),
});

const notifyTool = defineBuiltin({
  id: 'notify',
  description: 'Send a native desktop notification (title + body).',
  args: z.object({ title: z.string().min(1), body: z.string() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { title: { type: 'string' }, body: { type: 'string' } },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  policy: OS_POLICY,
  dispatch: async (args, host, ctx) => {
    await requireOs(host, 'notify').notify({ title: args.title, body: args.body }, ctx.signal);
    return { delivered: true };
  },
});

const invokeAgentTool = defineBuiltin({
  id: 'invoke_agent',
  description: 'Dispatch another agent node by id with explicit input (orchestrator delegation).',
  args: z.object({ nodeId: z.string().min(1), input: z.unknown().optional() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { nodeId: { type: 'string' }, input: {} },
    required: ['nodeId'],
    additionalProperties: false,
  },
  policy: OS_POLICY,
  dispatch: (args, _host, ctx) => {
    if (ctx.invokeAgent === undefined) {
      // Not a ToolHost I/O capability — an engine delegate. Absent ⇒ the same typed unavailable error.
      throw new ToolUnavailableError('invoke_agent', 'invokeAgent');
    }
    return ctx.invokeAgent(args.nodeId, args.input);
  },
});

/* ------------------------------------------------------------------------------------------------ *
 * The catalog.
 * ------------------------------------------------------------------------------------------------ */

/** The built-in tool catalog (built-in-tools.md). Register these into a `ToolRegistry` with a host. */
export const BUILTIN_TOOLS: readonly ToolDef[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  runCommandTool,
  gitStatusTool,
  gitCommitTool,
  httpRequestTool,
  webSearchTool,
  mcpCallTool,
  readClipboardTool,
  notifyTool,
  invokeAgentTool,
];

/** The built-in tool ids (sorted), for grant construction and tests. */
export const BUILTIN_TOOL_IDS: readonly ToolId[] = BUILTIN_TOOLS.map((tool) => tool.id).sort();
