import type { WorkflowDefinition } from '@relavium/core';
import {
  McpError,
  openStdioConnection,
  startMcpClient as defaultStartMcpClient,
  type ManagerSkippedTool,
  type McpClient,
  type McpServerConfig,
} from '@relavium/mcp';
import type { Agent, AgentRef, McpServerRef } from '@relavium/shared';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';

/**
 * Resolve an agent's inline `mcp_servers` into a live {@link McpClient} (2.R Step 3 — CLI host wiring). This is
 * the Node-host arm that ADR-0052 §2 delegates to the host: it turns each declared **stdio** server into an
 * {@link McpServerConfig} whose `open()` spawns + connects via `@relavium/mcp`'s SDK-fenced `openStdioConnection`,
 * then hands the set to `startMcpClient` (fail-loud connect-all). Only Relavium shapes cross back — the SDK and
 * `node:child_process` stay fenced inside `@relavium/mcp`, and `packages/core` never sees either.
 *
 * **Stdio only for now.** A `sse`/`websocket` (network) server fails loud here — the network transports + their
 * SSRF guard are the Step-4 follow-up ([ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)),
 * and silently dropping a declared server is the opposite of secure-by-default. **No secret interpolation yet.**
 * `{{secrets.*}}` resolution into the child env is also Step 4 (ADR-0052 §6); until it lands an `env` value
 * containing `{{` is **rejected loud** so a placeholder is never passed to the server as a literal string.
 */

/** Options for {@link connectAgentMcp} — the spawn working dir + an injectable client starter (tests). */
export interface ConnectAgentMcpOptions {
  /** The session/run working directory — the spawned server's `cwd` (relative server paths resolve here). */
  readonly cwd: string;
  /** Injectable connect-all (tests pass a fake that never spawns); defaults to the real `startMcpClient`. */
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
}

/**
 * Map an agent's inline `mcp_servers` to {@link McpServerConfig}s (stdio only). Throws a typed, exit-2
 * {@link CliError} for a not-yet-wired transport or an unsupported (`{{…}}`) env value — never a silent skip.
 */
export function resolveStdioServerConfigs(
  mcpServers: readonly McpServerRef[] | undefined,
  cwd: string,
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
    const env = buildChildEnv(ref.id, ref.env);
    configs.push({
      id: ref.id,
      ...(ref.tools_allowlist === undefined ? {} : { toolsAllowlist: ref.tools_allowlist }),
      open: () =>
        openStdioConnection(ref.id, {
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
  const configs = resolveStdioServerConfigs(mcpServers, opts.cwd);
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

/**
 * Build the child env for a stdio server from its declared `env` (verbatim for now). Rejects any value carrying
 * a `{{…}}` interpolation marker: `{{secrets.*}}` resolution is the Step-4 follow-up (ADR-0052 §6), and passing
 * an unresolved placeholder to the server as a literal is a silent-misconfig footgun, so it fails loud instead.
 */
function buildChildEnv(
  serverId: string,
  declared: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (value.includes('{{')) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}': env interpolation (e.g. {{secrets.…}}) in '${key}' is not wired yet. ` +
          `Set a literal value for now, or omit it.`,
      );
    }
    env[key] = value;
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

  const configs = resolveStdioServerConfigs([...byId.values()], opts.cwd);
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
 * A stable fingerprint of a server's connection settings — equal iff two declarations describe the SAME server,
 * so a duplicate id with identical settings dedups while a conflicting one fails loud. `env` keys are sorted
 * (a map is order-insensitive); `args` order is preserved (a command line is ordered).
 */
function serverFingerprint(ref: McpServerRef): string {
  const env = Object.entries(ref.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    t: ref.transport,
    c: ref.command ?? null,
    a: ref.args ?? [],
    u: ref.url ?? null,
    e: env,
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
