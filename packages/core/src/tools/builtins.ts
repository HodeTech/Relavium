/**
 * The built-in `ToolDef` catalog (1.T) — the built-in tools every local agent can call
 * ([built-in-tools.md](../../../../docs/reference/shared-core/built-in-tools.md)). Each is engine-pure:
 * `parseArgs` is the executable Zod validator (the full effective-arg set, including config-only params),
 * `llmVisibleParams` is the LLM-facing projection the `ToolNormalizer` (1.E) lowers, and `dispatch`
 * performs side effects ONLY through the injected `ToolHost`. The egress tools (`http_request` /
 * `web_search` / `mcp_call`) are dispatchable against a stub host now and ship gated at the surfaces
 * until the shared SSRF primitive lands (1.AE) — i.e. their host capability is simply not wired yet.
 */

import {
  MEDIA_HANDLE_PATTERN,
  scopeSetIncludes,
  validateByteRange,
  type MediaPart,
} from '@relavium/shared';
import { z } from 'zod';

import { ToolArgsInvalidError, ToolPolicyError, ToolUnavailableError } from './errors.js';
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

// Returns `ToolDef<A>` so each tool keeps its precise validated-arg type; the single controlled
// widening to the heterogeneous `ToolDef` (`Args = unknown`) happens once at the catalog boundary.
function defineBuiltin<A>(spec: BuiltinSpec<A>): ToolDef<A> {
  const def: ToolDef<A> = {
    id: spec.id,
    source: 'builtin',
    description: spec.description,
    parseArgs: (raw: unknown): A => spec.args.parse(raw),
    llmVisibleParams: spec.llmVisibleParams,
    policy: spec.policy,
    ...(spec.configOnlyParams === undefined ? {} : { configOnlyParams: spec.configOnlyParams }),
    ...(spec.policyTarget === undefined ? {} : { policyTarget: spec.policyTarget }),
    dispatch: spec.dispatch,
  };
  return def;
}

/**
 * Build the `web_search` request URL from the config-pinned endpoint. Throws a typed
 * `ToolArgsInvalidError` (field: `endpoint`) when the endpoint is not an absolute `https://` URL — so
 * the caller never forwards a `credentialRef` against a missing/insecure target. The separator is
 * chosen dynamically (`&` when the endpoint already carries a query string, else `?`) to avoid a
 * double `?`, and every parameter value is percent-encoded.
 */
function buildSearchUrl(endpoint: string, query: string, maxResults: number | undefined): string {
  // Validate without the platform `URL` global (absent from the engine-purity lib, CLAUDE.md rule 5):
  // require an absolute https:// URL with a host. A non-HTTPS / relative endpoint is rejected here,
  // before any credentialRef is attached; deep URL parsing + the SSRF range checks live behind the
  // egress host capability (ADR-0029(d)).
  if (!/^https:\/\/[^/?#\s]+/i.test(endpoint)) {
    throw new ToolArgsInvalidError(
      'web_search',
      ['endpoint'],
      'web_search `endpoint` must be an absolute https:// URL',
    );
  }
  const sep = endpoint.includes('?') ? '&' : '?';
  const max =
    maxResults === undefined ? '' : `&maxResults=${encodeURIComponent(String(maxResults))}`;
  return `${endpoint}${sep}q=${encodeURIComponent(query)}${max}`;
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

const FS_POLICY: ToolPolicyClass = {
  fsScoped: true,
  spawnsProcess: false,
  requiresGateApproval: false,
};
const OS_POLICY: ToolPolicyClass = {
  fsScoped: false,
  spawnsProcess: false,
  requiresGateApproval: false,
};
// read_media reads from the host MediaStore via the engine `ctx.mediaRead` delegate (NOT the FS-scope tier,
// NOT an egress) and is read-only, so it needs no guardrail target / gate (ADR-0044 §1; the path-jail +
// scope-set authz + Range gate live inside the dispatch). It bypasses the Phase-2 ActionGuard.
const MEDIA_POLICY: ToolPolicyClass = {
  fsScoped: false,
  spawnsProcess: false,
  requiresGateApproval: false,
};

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
    .object({
      path: z.string().min(1),
      recursive: z.boolean().optional(),
      glob: z.string().optional(),
    })
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
  description:
    'Spawn an allowlisted shell command (shell:false) and capture stdout/stderr/exit code.',
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
  description:
    'Run git status / log / diff in the workspace; extra flags are author-pinned via config, not model-supplied.',
  // SECURITY: `args` is CONFIG-ONLY, not model-facing. A model-supplied `git diff` flag set
  // (e.g. `--no-index -- /etc/passwd`, `log -p --all`) would otherwise read arbitrary files / dump
  // history, since this pre-approved tool has no allowedCommands gate. The model picks only the
  // (safe, read-only) subcommand; any extra flags must be pinned by the trusted workflow author.
  args: z
    .object({
      command: z.enum(['status', 'log', 'diff']).optional(),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { command: { type: 'string', enum: ['status', 'log', 'diff'] } },
    additionalProperties: false,
  },
  configOnlyParams: ['args'],
  // Pre-approved subcommands with no model-controlled args ⇒ no allowedCommands gate needed.
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
  description:
    'Create a commit, optionally restricting it to the given pathspecs — requires a human-gate approval in automated workflows.',
  args: z
    .object({
      message: z.string().min(1),
      // A pathspec must not start with `-`, so a model cannot smuggle a git OPTION (`--amend`,
      // `--no-verify`, `--author=…`) through `files` past the human gate (the `--` separator below is
      // the structural backstop; this refine gives a field-named parse error).
      files: z
        .array(
          z
            .string()
            .min(1)
            .refine((f) => !f.startsWith('-'), { message: 'a pathspec must not start with "-"' }),
        )
        .optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      message: { type: 'string' },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['message'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: true },
  dispatch: (args, host, ctx) =>
    // `--` terminates option parsing so every `files` entry is an operand (pathspec), never an option.
    requireProcess(host, 'git_commit').spawn(
      'git',
      ['commit', '-m', args.message, '--', ...(args.files ?? [])],
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
  description:
    'Outbound HTTPS request to an allowedDomains host (HTTPS-only, exact-FQDN, SSRF-guarded).',
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
  description:
    'Search the web via the configured provider (key resolved host-side via a credential ref).',
  args: z
    .object({
      query: z.string().min(1),
      maxResults: z.number().int().positive().optional(),
      // Config-pinned and REQUIRED: a non-HTTPS or missing endpoint must never be paired with a
      // credentialRef, so the provider endpoint is mandatory rather than defaulted to '' (the empty
      // string silently produced a credentialed request against a bogus URL). The host still runs the
      // shared SSRF primitive; this is the engine-side floor.
      endpoint: z.string().min(1),
      // The opaque secret-store reference (never a raw key), resolved host-side inside its boundary.
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
    // Reject a non-absolute / non-HTTPS endpoint BEFORE attaching the credentialRef — a credential
    // must never be forwarded for an invalid URL. Field names only (the value may be config-secret).
    const url = buildSearchUrl(args.endpoint, args.query, args.maxResults);
    return requireEgress(host, 'web_search').fetch(
      { method: 'GET', url, credentialRef: args.credentialRef },
      ctx.signal,
    );
  },
});

const mcpCallTool = defineBuiltin({
  id: 'mcp_call',
  description:
    'Invoke a tool on a configured MCP server (server URL runs the same SSRF primitive).',
  args: z
    .object({ server: z.string().min(1), tool: z.string().min(1), args: z.unknown().optional() })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: { server: { type: 'string' }, tool: { type: 'string' }, args: {} },
    required: ['server', 'tool'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: false, egress: 'mcp', requiresGateApproval: false },
  dispatch: (args, host, ctx) =>
    requireMcp(host, 'mcp_call').call(
      { server: args.server, tool: args.tool, args: args.args },
      ctx.signal,
    ),
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

const readMediaTool = defineBuiltin({
  id: 'read_media',
  description:
    'Read a produced/received media handle (optionally a byte range) and return it inline for the model.',
  args: z
    .object({
      // Structural validation at the engine-pure policy layer: a malformed handle is rejected at parse
      // (a clear invalid_args on `handle`) rather than only at the host describe() (unknown_handle).
      handle: z.string().regex(MEDIA_HANDLE_PATTERN, 'must be a media://sha256-<64hex> handle'),
      start: z.number().int().nonnegative().optional(),
      end: z.number().int().nonnegative().optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
      start: { type: 'integer', minimum: 0 },
      end: { type: 'integer', minimum: 0 },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  policy: MEDIA_POLICY,
  // Engine-pure byte-delivery gate (ADR-0044 §1): scope-set authz → Range validation → host readRange.
  // The MediaStore + media_references access is the injected `ctx.mediaRead` delegate (NOT a ToolHost arm);
  // the host returns an in-flight base64 source, so this dispatch never touches raw bytes.
  dispatch: async (args, _host, ctx): Promise<MediaPart> => {
    const access = ctx.mediaRead;
    const requesting = ctx.requestingScope;
    if (access === undefined || requesting === undefined) {
      throw new ToolUnavailableError('read_media', 'media-read');
    }
    const info = await access.describe(args.handle);
    if (info === undefined) {
      throw new ToolArgsInvalidError('read_media', ['handle'], 'read_media: unknown media handle');
    }
    // Authz FIRST (before any byte read): scope-set membership, never owner-equality / sha256-knowledge.
    if (!scopeSetIncludes(info.allowedScopes, requesting)) {
      throw new ToolPolicyError(
        'read_media',
        'media_scope_denied',
        'read_media: the requesting scope may not read this media handle',
      );
    }
    // A zero-byte handle has no valid inclusive range; a whole-handle read returns the HANDLE source (the
    // schema-valid representation of empty content — `{ kind:'base64', data:'' }` would violate the
    // base64 `nonEmptyString` contract and break deInlineMedia's empty-decode) rather than tripping the
    // fail-closed check on the default `end = byteLength - 1 = -1` (1.AF off-by-one). An EXPLICIT range on
    // a 0-byte handle still falls through to validateByteRange and is correctly rejected.
    if (info.byteLength === 0 && args.start === undefined && args.end === undefined) {
      return {
        type: 'media',
        mimeType: info.mimeType,
        source: { kind: 'handle', ref: args.handle },
      };
    }
    // Whole-handle when no range is given; else validate the inclusive [start,end] against the durable
    // byteLength (the engine-pure policy — fail-closed on a bad/out-of-bounds range before the host read).
    const range = { start: args.start ?? 0, end: args.end ?? info.byteLength - 1 };
    const checked = validateByteRange(range, info.byteLength);
    if (!checked.ok) {
      throw new ToolArgsInvalidError(
        'read_media',
        ['start', 'end'],
        `read_media: ${checked.reason}`,
      );
    }
    const source = await access.readRange(args.handle, checked.range);
    return { type: 'media', mimeType: info.mimeType, source };
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

/**
 * The built-in tool catalog (built-in-tools.md). Register these into a `ToolRegistry` with a host.
 *
 * The single controlled widening lives HERE: each tool keeps its precise `ToolDef<A>` up to this
 * boundary, where the heterogeneous catalog erases the per-tool `Args` to the shared `ToolDef`
 * (`Args = unknown`). This is safe by construction — the registry validates via `parseArgs` BEFORE it
 * ever calls `dispatch`/`policyTarget`, so the value those receive is exactly the tool's own `A`.
 */
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
  readMediaTool,
  invokeAgentTool,
] as readonly ToolDef[];

/** The built-in tool ids (sorted), for grant construction and tests. */
export const BUILTIN_TOOL_IDS: readonly ToolId[] = BUILTIN_TOOLS.map((tool) => tool.id).sort(
  (a, b) => a.localeCompare(b),
);
