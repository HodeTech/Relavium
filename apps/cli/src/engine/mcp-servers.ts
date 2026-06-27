import type { WorkflowDefinition } from '@relavium/core';
import {
  McpError,
  openStdioConnection,
  startMcpClient as defaultStartMcpClient,
  type ManagerSkippedTool,
  type McpClient,
  type McpConnection,
  type McpServerConfig,
  type StdioServerSpec,
} from '@relavium/mcp';
import type { Agent, AgentRef, McpServerRef } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';

/**
 * Resolve an agent's inline `mcp_servers` into a live {@link McpClient} (2.R Step 3 — CLI host wiring). This is
 * the Node-host arm that ADR-0052 §2 delegates to the host: it turns each declared **stdio** server into an
 * {@link McpServerConfig} whose `open()` spawns + connects via `@relavium/mcp`'s SDK-fenced `openStdioConnection`,
 * then hands the set to `startMcpClient` (fail-loud connect-all). Only Relavium shapes cross back — the SDK and
 * `node:child_process` stay fenced inside `@relavium/mcp`, and `packages/core` never sees either.
 *
 * **Stdio only for now.** A `sse`/`websocket` (network) server fails loud here — the network transports + their
 * SSRF guard are the Step-4c follow-up ([ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)),
 * and silently dropping a declared server is the opposite of secure-by-default. A `{{secrets.<name>}}` in a
 * server `env` value is resolved (2.R Step 4a, ADR-0052 §6) through the injected {@link McpSecretResolver}; any
 * other `{{…}}` (or a `{{secrets}}` with no resolver wired) is **rejected loud** so a placeholder is never
 * passed to the server as a literal string.
 */

/** Options for {@link connectAgentMcp} — the spawn working dir + an injectable client starter (tests). */
export interface ConnectAgentMcpOptions {
  /** The session/run working directory — the spawned server's `cwd` (relative server paths resolve here). */
  readonly cwd: string;
  /** Injectable connect-all (tests pass a fake that never spawns); defaults to the real `startMcpClient`. */
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  /**
   * Resolve a `{{secrets.<name>}}` placeholder in a server `env` value (2.R Step 4, ADR-0052 §6). When absent,
   * any `{{…}}` in an `env` value is rejected loud (a placeholder is never passed to the child as a literal).
   */
  readonly resolveSecret?: McpSecretResolver;
}

/** Open a stdio MCP connection from a spawn spec — the real {@link openStdioConnection}, or a test spy. */
export type OpenStdioConnection = (
  serverId: string,
  spec: StdioServerSpec,
) => Promise<McpConnection>;

/**
 * Map an agent's inline `mcp_servers` to {@link McpServerConfig}s (stdio only). Throws a typed, exit-2
 * {@link CliError} for a not-yet-wired transport or an unsupported (`{{…}}`) env value — never a silent skip.
 * `openConnection` defaults to the real {@link openStdioConnection}; a test injects a spy to observe the spawn
 * spec (the resolved-secret `env`) at the boundary without spawning a real child.
 */
export function resolveStdioServerConfigs(
  mcpServers: readonly McpServerRef[] | undefined,
  cwd: string,
  resolveSecret?: McpSecretResolver,
  openConnection: OpenStdioConnection = openStdioConnection,
): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  for (const ref of mcpServers ?? []) {
    if (ref.transport !== 'stdio') {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${ref.id}': the '${ref.transport}' transport is not wired yet (stdio only for now). ` +
          `Network MCP transports land in a follow-up.`,
      );
    }
    // The schema's `superRefine` already guarantees `command` for a stdio transport; re-assert so the spawn
    // spec is total without a non-null assertion (a defensive, typed failure rather than an undefined spawn).
    if (ref.command === undefined) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${ref.id}': a 'stdio' transport requires a 'command'.`,
      );
    }
    const command = ref.command;
    const env = buildChildEnv(ref.id, ref.env, resolveSecret);
    configs.push({
      id: ref.id,
      ...(ref.tools_allowlist === undefined ? {} : { toolsAllowlist: ref.tools_allowlist }),
      open: () =>
        openConnection(ref.id, {
          command,
          env,
          cwd,
          ...(ref.args === undefined ? {} : { args: ref.args }),
        }),
    });
  }
  return configs;
}

/**
 * Connect an agent's inline `mcp_servers` and return the live {@link McpClient}, or `undefined` when the agent
 * declares none (so the caller wires no MCP and has nothing to tear down). A connect/`tools/list` failure is
 * **fail-loud**: it surfaces as a typed, exit-2 {@link CliError} whose message is the secret-free MCP summary —
 * the opaque `cause` chain is intentionally NOT attached, honoring the host-boundary cause-strip obligation
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §2 / errors.ts).
 */
export async function connectAgentMcp(
  mcpServers: readonly McpServerRef[] | undefined,
  opts: ConnectAgentMcpOptions,
): Promise<McpClient | undefined> {
  const configs = resolveStdioServerConfigs(mcpServers, opts.cwd, opts.resolveSecret);
  if (configs.length === 0) return undefined;
  return startMcpClientFailLoud(configs, opts.startMcpClient);
}

/**
 * Connect the resolved server configs **fail-loud**: a connect/`tools/list` failure surfaces as a typed, exit-2
 * {@link CliError} whose message is the secret-free MCP summary — the opaque `cause` chain is intentionally NOT
 * attached (the host-boundary cause-strip, ADR-0052 §2). A non-MCP error rethrows verbatim (an unexpected fault
 * is never masked as `invalid_invocation`). Shared by the chat ({@link connectAgentMcp}) and run ({@link
 * connectWorkflowMcp}) host paths so both surface the same typed, secret-free failure.
 */
async function startMcpClientFailLoud(
  configs: readonly McpServerConfig[],
  custom: ConnectAgentMcpOptions['startMcpClient'],
): Promise<McpClient> {
  const start = custom ?? defaultStartMcpClient;
  try {
    return await start(configs);
  } catch (err) {
    if (err instanceof McpError) {
      throw new CliError('invalid_invocation', `MCP server connection failed: ${err.message}`);
    }
    throw err;
  }
}

/** Matches a `{{secrets.<name>}}` placeholder (tolerant of inner whitespace) — the ONLY supported env interpolation. */
const SECRET_PLACEHOLDER = /\{\{\s*secrets\.([A-Za-z0-9._-]+)\s*\}\}/g;

/**
 * Build the child env for a stdio server from its declared `env`, resolving `{{secrets.<name>}}` placeholders
 * (2.R Step 4, ADR-0052 §6) through the injected {@link McpSecretResolver} (keychain `mcp-secret:<name>` →
 * `RELAVIUM_MCP_<NAME>` → fail-closed). The resolved value is injected ONLY here, into the explicit child env at
 * spawn — never a committed file, a log, an event, or `--json`. Any **other** `{{…}}` (or any `{{` left when no
 * resolver is wired) is rejected loud, so an unsupported/unresolved placeholder is never passed as a literal.
 *
 * Exported for a focused unit test of the interpolation/fail-closed behavior (the resolved value is otherwise
 * hidden inside the spawn closure of {@link resolveStdioServerConfigs}).
 */
export function buildChildEnv(
  serverId: string,
  declared: Readonly<Record<string, string>> | undefined,
  resolveSecret?: McpSecretResolver,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared ?? {})) {
    // Detect an unsupported interpolation on the DECLARED value with the supported `{{secrets.<name>}}`
    // placeholders removed (NOT on the substituted result) — so a leftover `{{` is `{{env.X}}`/`{{ctx.Y}}`, a
    // malformed `{{secrets …}}`, or a `{{secrets}}` with no resolver wired. Scanning the pre-substitution value
    // avoids a false reject when a legitimately-resolved secret VALUE itself contains the substring `{{`.
    const withoutSecretRefs =
      resolveSecret === undefined ? value : value.replace(SECRET_PLACEHOLDER, '');
    if (withoutSecretRefs.includes('{{')) {
      // Never pass a placeholder to the server as a literal. The KEY is named, never the value (a resolved
      // secret must not surface), and never the resolved value either.
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}': unsupported interpolation in env '${key}' — only {{secrets.<name>}} is supported.`,
      );
    }
    env[key] =
      resolveSecret === undefined
        ? value
        : value.replace(SECRET_PLACEHOLDER, (_match, name: string) => resolveSecret(name));
  }
  return env;
}

/** A live MCP client plus the workflow rewritten so each inline agent's grant includes its servers' tool ids. */
export interface WorkflowMcpRuntime {
  readonly client: McpClient;
  /** The input workflow with each MCP-declaring inline agent's `tools` unioned with its discovered tool ids. */
  readonly workflow: WorkflowDefinition;
}

/** Options for {@link connectWorkflowMcp} — the run cwd + an injectable client starter (tests). */
export interface ConnectWorkflowMcpOptions {
  readonly cwd: string;
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  /** Resolve `{{secrets.<name>}}` in a server `env` value (2.R Step 4, ADR-0052 §6); see {@link ConnectAgentMcpOptions}. */
  readonly resolveSecret?: McpSecretResolver;
}

/**
 * Connect the inbound MCP servers declared by a workflow's **inline** agents for a `relavium run` (2.R Step 3b).
 * It aggregates the `mcp_servers` across every inline agent ({@link Agent} entry, NOT a `$ref` — `$ref` external
 * agents are not resolved in the CLI run path), **deduplicates by server id** (two agents sharing the same
 * server share one connection; the same id with conflicting connection settings is a fail-loud {@link CliError}),
 * starts them fail-loud, and returns the live {@link McpClient} plus a workflow whose inline agents each have
 * their `tools` grant unioned with ONLY their own declared servers' discovered tool ids (per-agent isolation via
 * the manager's `toolIdsByServer`). Returns `undefined` when no inline agent declares a server. Stdio only —
 * a network transport fails loud in {@link resolveStdioServerConfigs} (the Step-4 follow-up).
 */
export async function connectWorkflowMcp(
  def: WorkflowDefinition,
  opts: ConnectWorkflowMcpOptions,
): Promise<WorkflowMcpRuntime | undefined> {
  const inlineAgents = (def.workflow.agents ?? []).filter(isInlineAgent);

  // Dedup the declared servers by id across agents: identical spec ⇒ one shared connection; same id with a
  // conflicting spec ⇒ fail loud (the namespaced tool ids would otherwise collide across two different servers).
  const byId = new Map<string, McpServerRef>();
  for (const agent of inlineAgents) {
    for (const ref of agent.mcp_servers ?? []) {
      const existing = byId.get(ref.id);
      if (existing === undefined) {
        byId.set(ref.id, ref);
      } else if (serverFingerprint(existing) !== serverFingerprint(ref)) {
        throw new CliError(
          'invalid_invocation',
          `MCP server '${ref.id}' is declared with conflicting settings by more than one agent — ` +
            `give the distinct servers distinct ids.`,
        );
      }
    }
  }
  if (byId.size === 0) return undefined;

  const configs = resolveStdioServerConfigs([...byId.values()], opts.cwd, opts.resolveSecret);
  const client = await startMcpClientFailLoud(configs, opts.startMcpClient);

  // Augment each inline agent's grant with ONLY its own servers' discovered ids (a `$ref` entry passes through).
  const agents = (def.workflow.agents ?? []).map((entry) =>
    isInlineAgent(entry) ? withWorkflowMcpGrant(entry, client.toolIdsByServer) : entry,
  );
  const workflow: WorkflowDefinition = {
    ...def,
    workflow: { ...def.workflow, agents },
  };
  return { client, workflow };
}

/** True for an inline agent definition (carries an `id`), false for a `{ $ref }` external reference. */
function isInlineAgent(entry: Agent | AgentRef): entry is Agent {
  return 'id' in entry;
}

/** Union an inline agent's `tools` grant with its OWN declared servers' discovered tool ids (2.R, ADR-0052 §3). */
function withWorkflowMcpGrant(
  agent: Agent,
  toolIdsByServer: ReadonlyMap<string, readonly string[]>,
): Agent {
  const ids = (agent.mcp_servers ?? []).flatMap((server) => toolIdsByServer.get(server.id) ?? []);
  if (ids.length === 0) return agent;
  return { ...agent, tools: [...new Set([...(agent.tools ?? []), ...ids])] };
}

/**
 * A stable fingerprint of a server's IDENTITY for cross-agent dedup — equal iff two declarations describe the
 * SAME server with the SAME effective grant, so a duplicate id with identical settings shares one connection
 * while a conflicting one fails loud. `env` keys + `tools_allowlist` are sorted (both order-insensitive sets);
 * `args` order is preserved (a command line is ordered).
 *
 * **`tools_allowlist` is part of the identity** (not just the connection): two agents sharing a server id resolve
 * to ONE physical connection whose tools are discovered ONCE under ONE allowlist — it cannot honor two different
 * allowlists. Were the allowlist excluded, a same-id pair with `[read]` vs `[read,write]` would silently collapse
 * to whichever was declared first, granting BOTH agents the union (a privilege escalation past the narrower
 * agent's own declared `tools_allowlist`, violating ADR-0029 narrow-only). Including it makes that pair fail
 * loud, forcing the author to align the allowlists or give the distinct servers distinct ids. `undefined`
 * (all-tools) is a distinct sentinel from `[]` (none).
 */
function serverFingerprint(ref: McpServerRef): string {
  const env = Object.entries(ref.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const allowlist =
    ref.tools_allowlist === undefined
      ? null
      : [...ref.tools_allowlist].sort((a, b) => a.localeCompare(b));
  return JSON.stringify({
    t: ref.transport,
    c: ref.command ?? null,
    a: ref.args ?? [],
    u: ref.url ?? null,
    e: env,
    w: allowlist,
  });
}

/**
 * Surface MCP tools dropped at discovery (allowlist-narrowed, an unsupported schema, a cross-server id
 * collision, or an unsafe name) to **stderr** — a non-fatal diagnostic that never pollutes a `--json` stdout
 * stream. A no-op when nothing was dropped (the common case). Shared by the chat and run host surfaces.
 *
 * The tool `name` and `reason` are **server-controlled** and the MCP server is in-threat-model untrusted
 * (ADR-0052 §4), so both — and the `server` segment, future-proofing the by-name `ref` form — are run through
 * {@link sanitizeInline} (the terminal-escape strip the resume banner / slash echo / streamed tokens use).
 */
export function surfaceMcpSkipped(io: CliIo, skipped: readonly ManagerSkippedTool[]): void {
  for (const tool of skipped) {
    io.writeErr(
      `note: MCP tool '${sanitizeInline(tool.name)}' (server '${sanitizeInline(tool.server)}') skipped — ${sanitizeInline(tool.reason)}\n`,
    );
  }
}
