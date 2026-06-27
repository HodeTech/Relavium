import {
  McpError,
  openStdioConnection,
  startMcpClient as defaultStartMcpClient,
  type McpClient,
  type McpServerConfig,
} from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';

import { CliError } from '../process/errors.js';

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
  const start = opts.startMcpClient ?? defaultStartMcpClient;
  try {
    return await start(configs);
  } catch (err) {
    if (err instanceof McpError) {
      // The MCP error `message` is secret-free by contract; the opaque `cause` is dropped (never surfaced).
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
