import type { WorkflowDefinition } from '@relavium/core';
import {
  McpError,
  openHttpConnection,
  openSseConnection,
  openStdioConnection,
  openWebSocketConnection,
  startMcpClient as defaultStartMcpClient,
  type HttpServerSpec,
  type ManagerSkippedTool,
  type McpClient,
  type McpConnection,
  type McpServerConfig,
  type SseServerSpec,
  type StdioServerSpec,
  type WebSocketServerSpec,
} from '@relavium/mcp';
import {
  isPrivateOrLocalHost,
  type Agent,
  type AgentRef,
  type McpServerRef,
  type McpServerRegistration,
} from '@relavium/shared';

import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import type { McpSecretResolver } from '../secrets/mcp-secret.js';

/**
 * Resolve an agent's inline `mcp_servers` into a live {@link McpClient} (2.R — CLI host wiring). This is the
 * Node-host arm that ADR-0052 §2 delegates to the host: it turns each declared server into an
 * {@link McpServerConfig} whose `open()` spawns (`stdio`) or connects (`http`/`sse`/`websocket`) via
 * `@relavium/mcp`'s SDK-fenced adapters, then hands the set to `startMcpClient` (fail-loud connect-all). Only
 * Relavium shapes cross back — the SDK and `node:child_process` stay fenced inside `@relavium/mcp`, and
 * `packages/core` never sees either.
 *
 * A **network** (`http`/`sse`/`websocket`) `url` passes the {@link assertSafeNetworkEndpoint} SSRF floor
 * (ADR-0053) before connecting. A `{{secrets.<name>}}` in a server `env` value is resolved (2.R Step 4a,
 * ADR-0052 §6) through the injected {@link McpSecretResolver}; any other `{{…}}` (or a `{{secrets}}` with no
 * resolver wired) is **rejected loud** so a placeholder is never passed to the server as a literal string. A
 * by-name `ref` is resolved against the config registrations ({@link resolveMcpServerRef}).
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
  /**
   * The merged config `[[mcp_servers]]` registrations (2.R Step 4b, ADR-0052 §5) — used to resolve a by-name
   * `{ ref: <name> }` server entry to its self-contained connection. Absent ⇒ a `ref` entry fails loud.
   */
  readonly registrations?: readonly McpServerRegistration[];
}

/**
 * Sanitize a registration `name` into a namespace-safe server segment for `mcp_{server}_{tool}` (ADR-0052 §4/§5
 * — "a sanitized form of the registration name"). A `[[mcp_servers]]` `name` is a free `nonEmptyString` (spaces,
 * `:`, `.`, `/`, …), but the LLM-visible id charset is `[A-Za-z0-9_-]`; an UNsanitized segment would make
 * `namespacedId` reject every tool of that server and silently drop them. Mirrors the tool-name sanitization in
 * `@relavium/mcp`. (An inline `id` is already `kebab-case` ⊂ this charset, so sanitizing it is a no-op.) Two
 * names that collapse to the same segment fail closed at discovery (the manager's duplicate-id/collision guards).
 */
function sanitizeServerSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Resolve a by-name `{ ref: <registration-name> }` server entry to a self-contained inline {@link McpServerRef}
 * against the merged config `[[mcp_servers]]` registrations (2.R Step 4b, ADR-0052 §5) — an inline entry passes
 * through unchanged. The resolved server's routing/namespace `id` is the **sanitized** registration `name`
 * ({@link sanitizeServerSegment}), so two agents referencing the same registration dedup to one connection and
 * its tools namespace cleanly. An unknown `ref` is a fail-loud {@link CliError}.
 *
 * NOTE: the resolved `id` is host-internal and namespace-safe (may carry `_`/uppercase) — it is deliberately NOT
 * re-validated through `McpServerRefSchema` (whose `id` is the stricter `kebabIdSchema`); it is never re-parsed.
 */
export function resolveMcpServerRef(
  entry: McpServerRef,
  registrations: readonly McpServerRegistration[],
): McpServerRef {
  if (entry.ref === undefined) return entry; // inline — self-contained (the schema guarantees id + transport)
  const reg = registrations.find((r) => r.name === entry.ref);
  if (reg === undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server ref '${entry.ref}' is not registered — add a [[mcp_servers]] entry named '${entry.ref}' to your config.`,
    );
  }
  return {
    id: sanitizeServerSegment(reg.name),
    transport: reg.transport,
    ...(reg.command === undefined ? {} : { command: reg.command }),
    ...(reg.args === undefined ? {} : { args: reg.args }),
    ...(reg.env === undefined ? {} : { env: reg.env }),
    ...(reg.url === undefined ? {} : { url: reg.url }),
    ...(reg.allow_local_endpoint === undefined
      ? {}
      : { allow_local_endpoint: reg.allow_local_endpoint }),
    ...(entry.tools_allowlist === undefined ? {} : { tools_allowlist: entry.tools_allowlist }),
  };
}

/**
 * The routing/namespace id of an agent's mcp_servers ENTRY (before resolution) — the **sanitized** `ref`
 * registration name (matching {@link resolveMcpServerRef}, so the grant key aligns with the connection id) or the
 * inline `id` (already charset-safe).
 */
function entryServerId(entry: McpServerRef): string | undefined {
  return entry.ref === undefined ? entry.id : sanitizeServerSegment(entry.ref);
}

/** Open a stdio MCP connection from a spawn spec — the real {@link openStdioConnection}, or a test spy. */
export type OpenStdioConnection = (
  serverId: string,
  spec: StdioServerSpec,
) => Promise<McpConnection>;

/**
 * Injectable transport openers — defaults are the real `@relavium/mcp` adapters; a test injects spies to
 * observe the built spec (or assert the SSRF gate) without a real spawn/connect.
 */
export interface ServerOpeners {
  readonly stdio?: OpenStdioConnection;
  readonly http?: (serverId: string, spec: HttpServerSpec) => Promise<McpConnection>;
  readonly sse?: (serverId: string, spec: SseServerSpec) => Promise<McpConnection>;
  readonly websocket?: (serverId: string, spec: WebSocketServerSpec) => Promise<McpConnection>;
}

/** The network transports — all take the same `{ url }` connect spec, so the dispatch is a keyed lookup. */
type NetworkTransport = 'http' | 'sse' | 'websocket';
type NetworkOpener = (serverId: string, spec: { readonly url: string }) => Promise<McpConnection>;
type NetworkOpeners = Record<NetworkTransport, NetworkOpener>;

/**
 * Map an agent's inline `mcp_servers` to {@link McpServerConfig}s, dispatching by transport — `stdio` spawns a
 * child (the declared `env` with `{{secrets.*}}` resolved), and `http` (Streamable HTTP) / `sse` (legacy
 * HTTP+SSE alias) / `websocket` open a network connection through the **SSRF gate** ({@link
 * assertSafeNetworkEndpoint}). Throws a typed, exit-2 {@link CliError} for an unresolved ref, an unsupported
 * (`{{…}}`) env, or an unsafe network endpoint — never a silent skip. A by-name `ref` must already be resolved
 * to inline ({@link resolveMcpServerRef}).
 */
export function resolveServerConfigs(
  mcpServers: readonly McpServerRef[] | undefined,
  cwd: string,
  resolveSecret?: McpSecretResolver,
  openers: ServerOpeners = {},
): McpServerConfig[] {
  const openStdio = openers.stdio ?? openStdioConnection;
  const network: NetworkOpeners = {
    http: openers.http ?? openHttpConnection,
    sse: openers.sse ?? openSseConnection,
    websocket: openers.websocket ?? openWebSocketConnection,
  };
  const configs: McpServerConfig[] = [];
  for (const ref of mcpServers ?? []) {
    // A by-name `ref` must be resolved to inline (id + transport) before reaching here (resolveMcpServerRef).
    if (ref.id === undefined || ref.transport === undefined) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${ref.ref ?? ref.id ?? '?'}': a by-name reference could not be resolved to a connection.`,
      );
    }
    configs.push(
      ref.transport === 'stdio'
        ? buildStdioConfig(ref.id, ref, cwd, resolveSecret, openStdio)
        : buildNetworkConfig(ref.id, ref.transport, ref, network),
    );
  }
  return configs;
}

/** The per-server `tools_allowlist` projected onto the `McpServerConfig` shape (omitted when absent — never an
 *  explicit `undefined`, honoring exactOptionalPropertyTypes). */
function toolsAllowlistFields(ref: McpServerRef): Pick<McpServerConfig, 'toolsAllowlist'> {
  return ref.tools_allowlist === undefined ? {} : { toolsAllowlist: ref.tools_allowlist };
}

/** Build the {@link McpServerConfig} for a `stdio` server — a fail-loud `command` check + the spawn closure
 *  carrying the resolved `env` ({@link buildChildEnv}). */
function buildStdioConfig(
  serverId: string,
  ref: McpServerRef,
  cwd: string,
  resolveSecret: McpSecretResolver | undefined,
  openStdio: OpenStdioConnection,
): McpServerConfig {
  // The schema's `superRefine` already guarantees `command` for a stdio transport; re-assert so the spawn spec
  // is total without a non-null assertion (a defensive, typed failure rather than an undefined spawn).
  if (ref.command === undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': a 'stdio' transport requires a 'command'.`,
    );
  }
  const command = ref.command;
  const env = buildChildEnv(serverId, ref.env, resolveSecret);
  const args = ref.args;
  return {
    id: serverId,
    ...toolsAllowlistFields(ref),
    open: () => openStdio(serverId, { command, env, cwd, ...(args === undefined ? {} : { args }) }),
  };
}

/** Build the {@link McpServerConfig} for a network server (`http`/`sse`/`websocket`) — a fail-loud `url`/`env`
 *  check, the SSRF floor, and the transport-dispatched connect closure. */
function buildNetworkConfig(
  serverId: string,
  transport: NetworkTransport,
  ref: McpServerRef,
  openers: NetworkOpeners,
): McpServerConfig {
  // The schema guarantees a `url` and forbids `env` on a network transport; re-assert both defensively so a
  // programmatic caller that bypassed the schema fails loud rather than silently dropping (an `env` secret).
  if (ref.url === undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': the '${transport}' transport requires a 'url'.`,
    );
  }
  if (ref.env !== undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': 'env' is not used by a network transport — it is injected only into a stdio child.`,
    );
  }
  const url = ref.url;
  // The SSRF pre-connect floor — rejects a private/loopback/link-local host (unless opted in) and a plaintext
  // remote (ADR-0053). The connect-by-validated-IP dialer upgrade (DNS-rebind) is the tracked follow-up.
  assertSafeNetworkEndpoint(serverId, url, ref.allow_local_endpoint === true);
  const open = openers[transport]; // `http` (Streamable HTTP) | `sse` (legacy HTTP+SSE alias) | `websocket`
  return { id: serverId, ...toolsAllowlistFields(ref), open: () => open(serverId, { url }) };
}

/**
 * The **SSRF pre-connect floor** for a network MCP `url` (2.R Step 4c, [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)).
 * Reuses the ONE shared `isPrivateOrLocalHost` range-block primitive (never re-implemented). A private/loopback/
 * link-local/metadata host is rejected UNLESS `allow_local_endpoint` is set (which, for that local endpoint,
 * also permits plaintext `http`/`ws` — a local-dev server is typically plaintext); a **remote** host must use
 * `https`/`wss` regardless of the flag. The no-embedded-credentials check is enforced here too (the flag never
 * relaxes it).
 *
 * **Scope (ADR-0053 §3 / SEC-EGRESS-3):** the opt-in relaxes exactly the **authored `host:port`** — the SDK
 * transport dials precisely the validated `url`, so today the relaxation cannot reach a sibling private port
 * (e.g. `:6379`/`:22`) on the same host. This is the host-validated **FLOOR**: it checks the AUTHORED host, so a
 * hostname that DNS-resolves to a private IP, and a redirect-to-private, are NOT caught here — the
 * connect-by-validated-IP dialer + per-hop re-validation (which **must** re-block any resolved/redirected
 * `host:port` other than the authored one) is the tracked follow-up (deferred-tasks.md).
 */
function assertSafeNetworkEndpoint(serverId: string, url: string, allowLocal: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('invalid_invocation', `MCP server '${serverId}': malformed url.`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': the url must not embed credentials (user:pass@…) — use env/keychain auth.`,
    );
  }
  // Validate the scheme FIRST — the schema already constrains it per transport, but as a host-side floor reject
  // anything outside the http/ws family BEFORE the `allow_local_endpoint` relaxation, so an opt-in local endpoint
  // can never wave through a `file:`/`javascript:`/etc. scheme (defense-in-depth, ADR-0053).
  const scheme = parsed.protocol;
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ws:' && scheme !== 'wss:') {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': unsupported url scheme '${scheme.replace(':', '')}' (http/https/ws/wss only).`,
    );
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const isSecure = scheme === 'https:' || scheme === 'wss:';
  if (isPrivateOrLocalHost(host)) {
    if (!allowLocal) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}': '${host}' is a private/loopback/link-local address. ` +
          `Set 'allow_local_endpoint: true' on the server to permit a local MCP endpoint.`,
      );
    }
    return; // a local endpoint with the explicit opt-in — plaintext is permitted for it (ADR-0053 §3).
  }
  if (!isSecure) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': a remote MCP url must use https/wss (got '${parsed.protocol.replace(':', '')}').`,
    );
  }
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
  // Resolve any by-name `ref` entries to inline against the config registrations (Step 4b) BEFORE building the
  // stdio configs — so the rest of the pipeline always sees a self-contained, inline server.
  const inline = (mcpServers ?? []).map((entry) =>
    resolveMcpServerRef(entry, opts.registrations ?? []),
  );
  const configs = resolveServerConfigs(inline, opts.cwd, opts.resolveSecret);
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
 * hidden inside the spawn closure of {@link resolveServerConfigs}).
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
      // secret must not surface), and never the resolved value either. Distinguish the two causes: a
      // correctly-written `{{secrets.X}}` with NO resolver wired (a host wiring gap) vs an unsupported
      // placeholder kind (`{{env.X}}`, malformed) — so the operator gets actionable guidance, not a syntax red
      // herring. The `{{secrets.…}}` test below the un-substituted detection tells them apart.
      const looksLikeSecretRef = resolveSecret === undefined && SECRET_PLACEHOLDER.test(value);
      SECRET_PLACEHOLDER.lastIndex = 0; // `/g` test() advances lastIndex — reset before the substitution below
      throw new CliError(
        'invalid_invocation',
        looksLikeSecretRef
          ? `MCP server '${serverId}': env '${key}' uses {{secrets.<name>}} but no MCP secret resolver is wired.`
          : `MCP server '${serverId}': unsupported interpolation in env '${key}' — only {{secrets.<name>}} is supported.`,
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
  /** The merged config `[[mcp_servers]]` registrations (Step 4b) — resolves a by-name `ref` entry; see {@link ConnectAgentMcpOptions}. */
  readonly registrations?: readonly McpServerRegistration[];
}

/**
 * Connect the inbound MCP servers declared by a workflow's **inline** agents for a `relavium run` (2.R Step 3b).
 * It aggregates the `mcp_servers` across every inline agent ({@link Agent} entry, NOT a `$ref` — `$ref` external
 * agents are not resolved in the CLI run path), **deduplicates by server id** (two agents sharing the same
 * server share one connection; the same id with conflicting connection settings is a fail-loud {@link CliError}),
 * starts them fail-loud, and returns the live {@link McpClient} plus a workflow whose inline agents each have
 * their `tools` grant unioned with ONLY their own declared servers' discovered tool ids (per-agent isolation via
 * the manager's `toolIdsByServer`). Returns `undefined` when no inline agent declares a server. Each transport
 * (stdio + the network ones) is dispatched + SSRF-gated by {@link resolveServerConfigs}.
 */
export async function connectWorkflowMcp(
  def: WorkflowDefinition,
  opts: ConnectWorkflowMcpOptions,
): Promise<WorkflowMcpRuntime | undefined> {
  const inlineAgents = (def.workflow.agents ?? []).filter(isInlineAgent);
  const registrations = opts.registrations ?? [];

  // Resolve each entry's by-name `ref` to inline (Step 4b), then dedup the servers by id across agents: identical
  // spec ⇒ one shared connection; same id with a conflicting spec ⇒ fail loud (the namespaced tool ids would
  // otherwise collide across two different servers). The resolved id (a registration name for a `ref`) is also
  // the per-agent grant key below.
  const byId = new Map<string, McpServerRef>();
  for (const agent of inlineAgents) {
    for (const entry of agent.mcp_servers ?? []) {
      const ref = resolveMcpServerRef(entry, registrations);
      if (ref.id === undefined) continue; // unreachable (resolved refs carry an id); narrows for the Map key
      const existing = byId.get(ref.id);
      if (existing === undefined) {
        byId.set(ref.id, ref);
      } else if (serverFingerprint(existing) !== serverFingerprint(ref)) {
        throw new CliError(
          'invalid_invocation',
          `MCP server '${ref.id}' is declared with conflicting settings by more than one agent — ` +
            `give the distinct servers distinct ids. (A by-name 'ref' uses the registration name sanitized ` +
            `to the [A-Za-z0-9_-] charset, so two different names can collapse to the same id — if that is the ` +
            `cause, make the registration names charset-distinct.)`,
        );
      }
    }
  }
  if (byId.size === 0) return undefined;

  const configs = resolveServerConfigs([...byId.values()], opts.cwd, opts.resolveSecret);
  const client = await startMcpClientFailLoud(configs, opts.startMcpClient);

  try {
    // Augment each inline agent's grant with ONLY its own servers' discovered ids (a `$ref` entry passes through).
    const agents = (def.workflow.agents ?? []).map((entry) =>
      isInlineAgent(entry) ? withWorkflowMcpGrant(entry, client.toolIdsByServer) : entry,
    );
    const workflow: WorkflowDefinition = {
      ...def,
      workflow: { ...def.workflow, agents },
    };
    return { client, workflow };
  } catch (err) {
    // DEFENSIVE: the augmentation above is pure today (map + spreads + a regex `sanitizeServerSegment`) and
    // cannot throw — the genuinely-throwing assembly (resolveServerConfigs / the dedup) ran BEFORE the client
    // was opened. This guard exists so that if a future throwing transform is added here, the live connection is
    // torn down rather than leaked (uniform all-or-nothing with the self-cleaning chat builders), not because the
    // current body throws. Do not assume `withWorkflowMcpGrant` can fail.
    // Best-effort: a teardown rejection must NOT replace the original augmentation error (preserve the primary).
    await client.close().catch(() => undefined);
    throw err;
  }
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
  // The grant key is the entry's server id — its `ref` registration name (Step 4b) or inline `id` — which is the
  // same id `resolveMcpServerRef` assigned the connection, so `toolIdsByServer` is keyed by it.
  const ids = (agent.mcp_servers ?? []).flatMap((server) => {
    const serverId = entryServerId(server);
    return serverId === undefined ? [] : (toolIdsByServer.get(serverId) ?? []);
  });
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
 * (all-tools) is a distinct sentinel from `[]` (none). **`allow_local_endpoint` is part of the identity too**
 * (ADR-0053 §3): a same-id pair where one opts into a local endpoint and the other does not would otherwise
 * collapse first-wins, silently granting (or denying) BOTH the SSRF relaxation — so it must fail loud.
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
    l: ref.allow_local_endpoint ?? false,
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
  for (const line of mcpSkippedLines(skipped)) io.writeErr(`${line}\n`);
}

/** The per-tool "MCP tool skipped" diagnostic lines (secret-free, terminal-sanitized), each WITHOUT a trailing
 *  newline — so a caller can route them to a store `notice` (which renders in the transcript, surviving the alt
 *  buffer on a `/clear`/reseat re-drive) instead of a raw `io.writeErr` (2.6.F Step 4b-3 Sonnet review). */
export function mcpSkippedLines(skipped: readonly ManagerSkippedTool[]): string[] {
  return skipped.map(
    (tool) =>
      `note: MCP tool '${sanitizeInline(tool.name)}' (server '${sanitizeInline(tool.server)}') skipped — ${sanitizeInline(tool.reason)}`,
  );
}
