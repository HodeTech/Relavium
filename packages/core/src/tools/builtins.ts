/**
 * The built-in `ToolDef` catalog (1.T) — the built-in tools every local agent can call
 * ([built-in-tools.md](../../../../docs/reference/shared-core/built-in-tools.md)). Each is engine-pure:
 * `parseArgs` is the executable Zod validator (the full effective-arg set, including config-only params),
 * `llmVisibleParams` is the LLM-facing projection the `ToolNormalizer` (1.E) lowers, and `dispatch`
 * performs side effects ONLY through the injected `ToolHost`. Egress availability depends on the
 * surface's configured host capability; the CLI's network host enforces its shared SSRF boundary.
 */

import {
  type EffectTier,
  byCodeUnit,
  INLINE_MEDIA_CEILING,
  MEDIA_HANDLE_PATTERN,
  MediaMimeTypeSchema,
  mediaModalityOf,
  scopeSetIncludes,
  utf8ByteLength,
} from '@relavium/shared';
import { z } from 'zod';

import { ToolArgsInvalidError, ToolPolicyError, ToolUnavailableError } from './errors.js';
import { attachMedia, type WithMediaAttachment } from './media-attachment.js';
import {
  type EgressCapability,
  type FsCapability,
  type JsonSchema,
  type McpCapability,
  type OsCapability,
  type PolicyTarget,
  type ProcessCapability,
  type ToolDef,
  type ToolDelegateName,
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
  readonly args: z.ZodType<A, z.ZodTypeDef, unknown>;
  readonly llmVisibleParams: JsonSchema;
  readonly configOnlyParams?: readonly string[];
  readonly policy: ToolPolicyClass;
  readonly policyTarget?: (args: A) => PolicyTarget;
  /** Whether this call mutates externally, and at what tier — ADR-0080; see `ToolDef.effect`. */
  readonly effect?: (args: A) => EffectTier | undefined;
  /** Duplicates of this tool's effect are harmless — first-party built-ins only; see `ToolDef`. */
  readonly duplicationBenign?: boolean;
  /** The dispatch-context delegate this tool needs, so a filter can stop advertising it — see `ToolDef`. */
  readonly requiresDelegate?: ToolDelegateName;
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
    ...(spec.effect === undefined ? {} : { effect: spec.effect }),
    ...(spec.duplicationBenign === undefined ? {} : { duplicationBenign: spec.duplicationBenign }),
    ...(spec.requiresDelegate === undefined ? {} : { requiresDelegate: spec.requiresDelegate }),
    dispatch: spec.dispatch,
  };
  return def;
}

const WRITE_CONTENT_MAX_BYTES = 8 * 1024 * 1024;
const HTTP_BODY_MAX_BYTES = 1024 * 1024;
const COMMAND_ARG_MAX_BYTES = 16 * 1024;
const COMMAND_ARGS_MAX_BYTES = 64 * 1024;
const COMMAND_ARGS_MAX_COUNT = 256;
const COMMIT_MESSAGE_MAX_BYTES = 16 * 1024;

/** UTF-16 length is a cheap lower bound; only plausible strings reach the byte measurement. */
function utf8String(maxBytes: number, minLength = 0): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(minLength)
    .refine((value) => value.length <= maxBytes && utf8ByteLength(value) <= maxBytes, {
      message: `must contain at most ${maxBytes} UTF-8 bytes`,
    });
}

// Refuse impossible vectors before parsing/measuring their members. A Zod array .max() alone still
// parses every member, and a per-member byte refine would scan before the aggregate cheap gate.
const commandArgs = z
  .unknown()
  .superRefine((raw, ctx) => {
    if (!Array.isArray(raw)) return; // The typed array parser below owns the shape error.
    const refuse = (message: string, path: number[] = []): void =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path, fatal: true });
    if (raw.length > COMMAND_ARGS_MAX_COUNT) {
      refuse(`must contain at most ${COMMAND_ARGS_MAX_COUNT} arguments`);
      return;
    }
    let characters = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const value: unknown = raw[i];
      if (typeof value !== 'string') continue;
      if (value.length > COMMAND_ARG_MAX_BYTES) {
        refuse(`must contain at most ${COMMAND_ARG_MAX_BYTES} UTF-8 bytes`, [i]);
        return;
      }
      characters += value.length;
      if (characters > COMMAND_ARGS_MAX_BYTES) {
        refuse(`arguments must total at most ${COMMAND_ARGS_MAX_BYTES} UTF-8 bytes`);
        return;
      }
    }
    let bytes = 0;
    for (let i = 0; i < raw.length; i += 1) {
      const value: unknown = raw[i];
      if (typeof value !== 'string') continue;
      const size = utf8ByteLength(value);
      if (size > COMMAND_ARG_MAX_BYTES) {
        refuse(`must contain at most ${COMMAND_ARG_MAX_BYTES} UTF-8 bytes`, [i]);
        return;
      }
      bytes += size;
      if (bytes > COMMAND_ARGS_MAX_BYTES) {
        refuse(`arguments must total at most ${COMMAND_ARGS_MAX_BYTES} UTF-8 bytes`);
        return;
      }
    }
  })
  .pipe(z.array(z.string()));

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
// `write_file` is a WRITE, so the per-tool approval gates it (ADR-0057 EA3, `fsWrite: true`). A SEPARATE
// object from FS_POLICY: the read-only `read_file` / `list_directory` must keep `fsWrite` absent, or the
// reads would be gated too. `enforcePolicy` is inert for it (no command/domain target, no gate) — the
// `confirmAction` floor is the authoritative writer gate.
const FS_WRITE_POLICY: ToolPolicyClass = {
  fsScoped: true,
  fsWrite: true,
  spawnsProcess: false,
  requiresGateApproval: false,
};
// read_clipboard / notify — a GOVERNED os action (ADR-0057 §security review): the clipboard is ambient,
// un-jailed OS state that routinely holds a freshly-copied secret, so a read is an exfiltration sink, and
// notify paints a native desktop notification; both ride the interactive approval floor.
const OS_POLICY: ToolPolicyClass = {
  fsScoped: false,
  spawnsProcess: false,
  os: true,
  requiresGateApproval: false,
};
// read_media (via `ctx.mediaRead`) + invoke_agent (via `ctx.invokeAgent`) are delegate-backed, read-only /
// orchestration tools with NO guardrail-class capability — they carry no path/command/host/os target, so they
// are NOT governed (the path-jail / scope authz / sub-agent policy live inside their own dispatch). ADR-0044 §1.
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
    properties: {
      path: {
        type: 'string',
        description: 'File path within the host-authorized filesystem roots.',
      },
      glob: {
        type: 'boolean',
        description: 'Treat the path as a glob pattern when true; defaults to false.',
      },
    },
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
      content: utf8String(WRITE_CONTENT_MAX_BYTES),
      append: z.boolean().optional(),
      createDirs: z.boolean().optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Destination file within the host-authorized filesystem roots.',
      },
      content: {
        type: 'string',
        maxLength: WRITE_CONTENT_MAX_BYTES,
        description: 'Text to write, at most 8 MiB of UTF-8 bytes; empty text is allowed.',
      },
      append: {
        type: 'boolean',
        description: 'Append when true; otherwise overwrite or replace the existing file content.',
      },
      createDirs: {
        type: 'boolean',
        description: 'Create missing parent directories when true; defaults to false.',
      },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  policy: FS_WRITE_POLICY,
  // The resolved target path the per-tool approval prompt + `agent:approval_requested` preview show
  // (ADR-0057 EA3). NOT a guardrail target — `enforcePolicy` reads only `command`/`url`, so this changes no
  // allowlist behavior; it is display-only.
  policyTarget: (args) => ({ path: args.path }),
  // An APPEND is an effect: appends compose, so a replay doubles the content. A whole-file overwrite is
  // naturally idempotent — writing the same bytes twice leaves the same file, and the file IS the receipt,
  // so it needs no journal row (ADR-0080 §3). Local, but "external" means outside this PROCESS.
  effect: (args) => (args.append === true ? 3 : undefined),
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
      path: {
        type: 'string',
        description: 'Directory path within the host-authorized filesystem roots.',
      },
      recursive: {
        type: 'boolean',
        description: 'Include nested directory entries when true; defaults to false.',
      },
      glob: {
        type: 'string',
        description: 'Optional glob pattern used to filter the returned directory entries.',
      },
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
    'Run an authorized executable directly, without a shell; return its output and exit code.',
  args: z
    .object({
      command: z.string().min(1),
      args: commandArgs.optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      env: z.record(z.string()).optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Executable name or path permitted by the configured command policy.',
      },
      args: {
        type: 'array',
        maxItems: COMMAND_ARGS_MAX_COUNT,
        description:
          'Literal arguments passed without shell expansion: at most 256 entries, totaling at most 64 KiB of UTF-8 bytes.',
        items: {
          type: 'string',
          maxLength: COMMAND_ARG_MAX_BYTES,
          description:
            'One literal argument, at most 16 KiB of UTF-8 bytes; an empty argument is allowed.',
        },
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  // cwd / timeoutMs / env are pinned by config, never model-supplied.
  configOnlyParams: ['cwd', 'timeoutMs', 'env'],
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: false },
  // The resolved command the exact-match allowedCommands allowlist inspects (ADR-0029(a)).
  policyTarget: (args) => ({ command: [args.command, ...(args.args ?? [])].join(' ') }),
  // Tier 3 and unpromotable: `allowedCommands` is free-form, so the engine cannot know whether a given
  // command is idempotent — `terraform apply` and `ls` are the same shape to it (ADR-0080 §3).
  effect: () => 3,
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
    properties: {
      command: {
        type: 'string',
        enum: ['status', 'log', 'diff'],
        description:
          'Read-only Git operation; defaults to status. Extra flags are configured by the author.',
      },
    },
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
    'Create a commit after a human-gate approval. Chat cannot provide that approval; review changes and commit manually instead.',
  args: z
    .object({
      message: utf8String(COMMIT_MESSAGE_MAX_BYTES, 1),
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
      message: {
        type: 'string',
        minLength: 1,
        maxLength: COMMIT_MESSAGE_MAX_BYTES,
        description: 'Non-empty commit message, at most 16 KiB of UTF-8 bytes.',
      },
      files: {
        type: 'array',
        description: 'Optional file pathspecs to include in the commit.',
        items: {
          type: 'string',
          minLength: 1,
          description: 'A non-empty file pathspec that does not begin with a hyphen.',
        },
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: true, requiresGateApproval: true },
  // Tier 3. Unreachable today (`gateApproved` is hard-coded false at both producers), but the declaration
  // belongs with the tool rather than being remembered when the gate is finally wired.
  effect: () => 3,
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
 * Egress tools (available only when the surface supplies the corresponding network capability).
 * ------------------------------------------------------------------------------------------------ */

const httpRequestTool = defineBuiltin({
  id: 'http_request',
  description:
    'Make an HTTPS request to a configured allowed host, when network access is available.',
  args: z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional(),
      url: z.string().min(1),
      headers: z.record(z.string()).optional(),
      body: utf8String(HTTP_BODY_MAX_BYTES).optional(),
    })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'DELETE'],
        description: 'HTTP method to send; defaults to GET.',
      },
      url: {
        type: 'string',
        description: 'Absolute HTTPS URL whose host is allowed by the configured network policy.',
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP header names and string values for this request.',
        additionalProperties: { type: 'string' },
      },
      body: {
        type: 'string',
        maxLength: HTTP_BODY_MAX_BYTES,
        description: 'Optional request text, at most 1 MiB of UTF-8 bytes; empty text is allowed.',
      },
    },
    required: ['url'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: false, egress: 'http', requiresGateApproval: false },
  policyTarget: (args) => ({ url: args.url }),
  // A GET mutates nothing and is NOT journaled — journaling it would put two durable writes on every read
  // and halt a run on a crashed fetch. Any other method is tier 3 today: tier 1 needs a target that honours
  // an idempotency key, and nothing declares one yet (ADR-0080 §3, and the promotion's trigger in §6).
  effect: (args) => ((args.method ?? 'GET') === 'GET' ? undefined : 3),
  dispatch: (args, host, ctx) =>
    requireEgress(host, 'http_request').fetch(
      { method: args.method ?? 'GET', url: args.url, headers: args.headers, body: args.body },
      ctx.signal,
      ctx.hostCallOptions,
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
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        description: 'Non-empty search query sent to the configured search provider.',
      },
      maxResults: {
        type: 'integer',
        minimum: 1,
        description: 'Optional positive maximum number of search results to request.',
      },
    },
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
      ctx.hostCallOptions,
    );
  },
});

const mcpCallTool = defineBuiltin({
  id: 'mcp_call',
  description: 'Invoke a named tool on a configured MCP server, when that server is available.',
  args: z
    .object({ server: z.string().min(1), tool: z.string().min(1), args: z.unknown().optional() })
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'Identifier of the configured MCP server to call.' },
      tool: {
        type: 'string',
        description: 'Name or identifier of the tool exposed by that server.',
      },
      args: {
        description: 'Optional tool arguments in the shape required by the selected server tool.',
      },
    },
    required: ['server', 'tool'],
    additionalProperties: false,
  },
  policy: { fsScoped: false, spawnsProcess: false, egress: 'mcp', requiresGateApproval: false },
  // Permanently tier 3, and not for want of metadata: an MCP server's own annotations are attacker-controlled
  // bytes from the very party the hostile-MCP class defends against, so they may never RAISE trust
  // (ADR-0080 §5).
  effect: () => 3,
  dispatch: (args, host, ctx) =>
    requireMcp(host, 'mcp_call').call(
      { server: args.server, tool: args.tool, args: args.args },
      ctx.signal,
      ctx.hostCallOptions,
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
    properties: {
      title: {
        type: 'string',
        minLength: 1,
        description: 'Non-empty title shown in the desktop notification.',
      },
      body: { type: 'string', description: 'Notification body text; an empty body is allowed.' },
    },
    required: ['title', 'body'],
    additionalProperties: false,
  },
  policy: OS_POLICY,
  // An effect by the letter of the contract, and benign under duplication — a duplicate desktop toast is not
  // an incident, and halting a run for one would discredit the mechanism. Declared rather than excepted, so
  // the next tool with this property has to state it too (ADR-0080 §5 / effect-journal.md §3.3).
  effect: () => 3,
  duplicationBenign: true,
  dispatch: async (args, host, ctx) => {
    await requireOs(host, 'notify').notify({ title: args.title, body: args.body }, ctx.signal);
    return { delivered: true };
  },
});

const readMediaTool = defineBuiltin({
  id: 'read_media',
  description:
    'Read a produced/received media handle. Returns a short descriptor; the media itself is attached to the conversation for you to look at.',
  args: z
    .object({
      // Structural validation at the engine-pure policy layer: a malformed handle is rejected at parse
      // (a clear invalid_args on `handle`) rather than only at the host describe() (unknown_handle).
      handle: z.string().regex(MEDIA_HANDLE_PATTERN, 'must be a media://sha256-<64hex> handle'),
    })
    // NO `start`/`end` (`CR-50`, ADR-0089 §1). A byte range had nowhere to go: the delivery rail is a
    // top-level media part, which is whole-handle by construction, and a range would have to be written
    // back as a NEW content-addressed handle — a store write plus a GC reference, to serve a caller that
    // cannot use bytes 100–200 of a PNG. `.strict()` makes the removal enforced rather than advertised:
    // a model that sends `start` now gets a typed `invalid_args` instead of a silently ignored argument.
    .strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      handle: {
        type: 'string',
        description:
          'Whole media://sha256-<64hex> handle authorized for this conversation; byte ranges are not supported.',
      },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  policy: MEDIA_POLICY,
  // `ctx.mediaRead` is a DELEGATE, not a host arm, so an arm-only advertise-filter could not see it (`CR-73`).
  requiresDelegate: 'mediaRead',
  // Engine-pure authorization gate (ADR-0044 §1): scope-set membership, then a metadata lookup. The
  // MediaStore + media_references access is the injected `ctx.mediaRead` delegate (NOT a ToolHost arm).
  //
  // The result is a short TEXT descriptor and the bytes ride an ATTACHMENT (ADR-0089 §1): a handle-only
  // media part the turn loop delivers on a synthesized `user` message, where the chain's egress
  // re-materialization resolves it and every adapter already knows how to lower it. This dispatch never
  // touches raw bytes at all — it does not read them, so there is nothing for the I3 boundary to redact.
  dispatch: async (args, _host, ctx): Promise<WithMediaAttachment<string>> => {
    const access = ctx.mediaRead;
    const requesting = ctx.requestingScope;
    if (access === undefined || requesting === undefined) {
      throw new ToolUnavailableError('read_media', 'media-read');
    }
    const info = await access.describe(args.handle, ctx.signal);
    // Authz, and **an unknown handle answers exactly as an unauthorized one does**. Splitting them made the
    // tool an existence oracle: a caller who guessed a sha256 learned whether those bytes were in the store,
    // because `unknown media handle` and `media_scope_denied` are distinguishable and both are fed back to
    // the model. It never learned the content, so ADR-0044 §1's "knowing a sha256 is not authorization" held
    // — but one bit is still one bit more than that posture implies, and the tool is reachable by anything
    // the model can be talked into emitting. Both now say the same thing.
    if (info === undefined || !scopeSetIncludes(info.allowedScopes, requesting)) {
      throw new ToolPolicyError(
        'read_media',
        'media_scope_denied',
        'read_media: no media is readable at that handle from this scope',
      );
    }
    // **Refuse what the delivery rail cannot carry, HERE, where the model can still correct.** The bytes
    // reach the model as an in-flight `base64` part, and `INLINE_MEDIA_CEILING` refuses video and PDF at any
    // size and image/audio over 256 KiB — enforced by the seam's own schema at the adapter. Without this
    // check the tool authorized the handle, described it ("4192304 bytes — attached below"), and the model
    // then read a descriptor for something the NEXT request died trying to send: a `ZodError` after the
    // tool had already run, on every plan entry, telling the caller to "pass a handle instead" — which is
    // exactly what the engine passed. A screenshot, a photo, a generated image or any PDF is over the line.
    //
    // A typed `invalid_args` instead, so the model gets a correctable refusal naming the limit and can pick
    // a different handle or stop asking. The real fix is a delivery path that does not inline — a
    // provider-ref upload through `resolveForEgress` — which ADR-0089 §2's amendment already records as open.
    // The host supplies `mimeType` as a bare `string` (it comes from `media_objects.mime_type`), and it is
    // interpolated into the descriptor — which becomes the tool result AND `agent:tool_result.outputSummary`
    // on a durable event. ADR-0044 §1 already names an unbounded value here as a bytes-smuggling channel
    // into the very logs I3 guards; that bound applied to the rejection path, and this is the success path.
    const checkedMime = MediaMimeTypeSchema.safeParse(info.mimeType);
    if (!checkedMime.success) {
      throw new ToolArgsInvalidError(
        'read_media',
        ['handle'],
        'read_media: the stored media has no usable media type',
      );
    }
    const mimeType = checkedMime.data;
    const modality = mediaModalityOf(mimeType);
    if (modality === undefined) {
      throw new ToolArgsInvalidError(
        'read_media',
        ['handle'],
        `read_media: ${mimeType} is not a media type the model can be shown`,
      );
    }
    const ceiling = INLINE_MEDIA_CEILING[modality];
    if (ceiling === 0) {
      throw new ToolArgsInvalidError(
        'read_media',
        ['handle'],
        `read_media: ${modality} media cannot be delivered inline to a model — describe it or extract frames instead`,
      );
    }
    if (info.byteLength > ceiling) {
      throw new ToolArgsInvalidError(
        'read_media',
        ['handle'],
        `read_media: this ${modality} is ${info.byteLength} bytes, over the ${ceiling}-byte inline limit — a smaller or downscaled handle can be delivered`,
      );
    }
    return attachMedia(`${mimeType}, ${info.byteLength} bytes, ${args.handle} — attached below.`, [
      { type: 'media', mimeType, source: { kind: 'handle', ref: args.handle } },
    ]);
  },
});

const invokeAgentTool = defineBuiltin({
  id: 'invoke_agent',
  description: 'Dispatch another agent node by id with explicit input (orchestrator delegation).',
  args: z.object({ nodeId: z.string().min(1), input: z.unknown().optional() }).strict(),
  llmVisibleParams: {
    type: 'object',
    properties: {
      nodeId: {
        type: 'string',
        description:
          'Identifier of the agent node to invoke through the available delegation capability.',
      },
      input: { description: 'Optional input value supplied to the invoked agent node.' },
    },
    required: ['nodeId'],
    additionalProperties: false,
  },
  // A delegate-backed orchestration tool (NOT an os action) — the non-governed delegate policy, not OS_POLICY.
  policy: MEDIA_POLICY,
  // **`CR-73`.** Nothing in the tree sets `ctx.invokeAgent`, so before this the tool was advertised to every
  // model that was granted it and answered `tool_unavailable` to every call. The dispatch guard below was the
  // only gate, and a backstop that fires after the model has already committed a turn to the call is not a
  // substitute for never offering it.
  requiresDelegate: 'invokeAgent',
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
  byCodeUnit,
);
