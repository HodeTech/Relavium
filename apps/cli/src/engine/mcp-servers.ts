import type { WorkflowDefinition } from '@relavium/core';
import {
  MCP_DEADLINES,
  McpAbortedError,
  McpDeadlineError,
  McpError,
  openWindow,
  raceDeadline,
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
import { nodeEgressDeps, type LocalEndpoint } from '@relavium/db';
import {
  extractEgressAuthority,
  isForbiddenDeclaredEnvKey,
  isMetadataOrLinkLocal,
  isPrivateOrLocalHost,
  urlHasCredentials,
  MCP_CONNECT_TIMEOUT_CEILING_MS,
  type AbortSignalLike,
  type Agent,
  type AgentRef,
  type McpServerRef,
  type McpServerRegistration,
} from '@relavium/shared';

import { CliError } from '../process/errors.js';
import { createMcpFetch, type McpFetch, type McpFetchConfig } from './mcp-fetch.js';
import type { ResolvedStdioSpawn } from './mcp-consent.js';
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
  readonly startMcpClient?: (
    servers: readonly McpServerConfig[],
    signal?: AbortSignalLike,
  ) => Promise<McpClient>;
  /**
   * Cancels the connect and the discovery walk (ADR-0088 §1.1).
   *
   * A connect can be the longest thing a session does — up to `stdio`'s 120 s while a cold `npx` resolves,
   * with the terminal silent and the user reaching for Ctrl-C. Without this the signal guard could only reap
   * children that already existed, leaving the highest-probability window uncovered.
   */
  readonly connectSignal?: AbortSignalLike;
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
  /**
   * The consent gate ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1) —
   * called with the RESOLVED inline refs, before any `McpServerConfig` is built, so a refused server's
   * `open()` is never constructed. Absent ⇒ no gate, which is the shape every existing unit fixture uses;
   * production wires it.
   */
  readonly consentGate?: StdioConsentGate;
  /** The agent path, shown at the consent prompt so the imported-artifact case names its own file. */
  readonly artifact?: string;
}

/**
 * Decide whether these declared servers may spawn. Throws to refuse; returns the resolved spawns on approval
 * so the caller uses the exact absolute executable that was consented to rather than re-resolving the
 * authored word against a `PATH` that may have changed since.
 */
export type StdioConsentGate = (
  refs: readonly ResolvedServerRef[],
  cwd: string,
  /**
   * The artifact that declared these servers — a workflow or agent path, for the prompt
   * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §7). Display-only, never
   * part of the fingerprint: the same declaration in two artifacts is the same program.
   */
  artifact?: string,
) => Promise<ReadonlyMap<string, ResolvedStdioSpawn>>;

/**
 * A declared server resolved to its inline form, plus the host-only provenance the schema cannot carry.
 *
 * `McpServerRefSchema` is `.strict()`, so the registration name has no field to live in — and this shape is
 * host-internal and deliberately never re-parsed, which is what makes an extra property safe here.
 */
export type ResolvedServerRef = McpServerRef & { readonly registrationName?: string };

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
): ResolvedServerRef {
  if (entry.ref === undefined) return entry; // inline — self-contained (the schema guarantees id + transport)
  const reg = registrations.find((r) => r.name === entry.ref);
  if (reg === undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server ref '${entry.ref}' is not registered — add a [[mcp_servers]] entry named '${entry.ref}' to your config.`,
    );
  }
  return {
    // The originating registration NAME, carried outside the schema because `McpServerRefSchema` is
    // `.strict()` and has nowhere for it — and this shape is host-internal and never re-parsed (see the note
    // above). Without it a config-declared server displayed as `inline` at the consent prompt, telling a
    // user the declaration was in the artifact when it was in their own config (ADR-0084 §7).
    registrationName: reg.name,
    id: sanitizeServerSegment(reg.name),
    transport: reg.transport,
    ...(reg.command === undefined ? {} : { command: reg.command }),
    ...(reg.args === undefined ? {} : { args: reg.args }),
    ...(reg.env === undefined ? {} : { env: reg.env }),
    ...(reg.url === undefined ? {} : { url: reg.url }),
    ...(reg.allow_local_endpoint === undefined
      ? {}
      : { allow_local_endpoint: reg.allow_local_endpoint }),
    // The registration owns the connection, so it owns the connect deadline too (ADR-0088 §1.4) — the schema
    // refuses an inline `connect_timeout_ms` alongside a `ref`, so there is nothing to reconcile here.
    ...(reg.connect_timeout_ms === undefined ? {} : { connect_timeout_ms: reg.connect_timeout_ms }),
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
  signal?: AbortSignalLike,
) => Promise<McpConnection>;

/**
 * Injectable transport openers — defaults are the real `@relavium/mcp` adapters; a test injects spies to
 * observe the built spec (or assert the SSRF gate) without a real spawn/connect.
 */
export interface ServerOpeners {
  /**
   * Build the validated `fetch` for one network server (ADR-0088 §2.1). Injectable so a test can observe the
   * `host:port` scope the admission derived — and so the SSRF policy is exercised against fake DNS rather
   * than the network. Production is {@link createMcpFetch}.
   */
  readonly makeFetch?: (config: McpFetchConfig) => McpFetch;
  /**
   * Resolve a hostname — the `websocket` pre-connect range-block (ADR-0088 §2.3). Injectable for the same
   * reason `makeFetch` is: an SSRF policy asserted against real DNS is asserted against the network.
   */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly stdio?: OpenStdioConnection;
  readonly http?: (
    serverId: string,
    spec: HttpServerSpec,
    signal?: AbortSignalLike,
  ) => Promise<McpConnection>;
  readonly sse?: (
    serverId: string,
    spec: SseServerSpec,
    signal?: AbortSignalLike,
  ) => Promise<McpConnection>;
  readonly websocket?: (
    serverId: string,
    spec: WebSocketServerSpec,
    signal?: AbortSignalLike,
  ) => Promise<McpConnection>;
}

/** The network transports — all take the same `{ url }` connect spec, so the dispatch is a keyed lookup. */
type NetworkTransport = 'http' | 'sse' | 'websocket';
type NetworkOpener = (
  serverId: string,
  spec: { readonly url: string; readonly connectTimeoutMs?: number; readonly fetch?: McpFetch },
  signal?: AbortSignalLike,
) => Promise<McpConnection>;
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
  mcpServers: readonly ResolvedServerRef[] | undefined,
  cwd: string,
  resolveSecret?: McpSecretResolver,
  openers: ServerOpeners = {},
  /**
   * The consent gate's resolved spawns, keyed by server id
   * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3). Present ⇒ a stdio
   * server spawns the **exact absolute executable that was consented to**, not the authored word re-resolved
   * against a `PATH` that may have changed between the decision and the spawn. Absent ⇒ the authored
   * command, which is the un-gated path every unit fixture uses.
   */
  consented?: ReadonlyMap<string, ResolvedStdioSpawn>,
): McpServerConfig[] {
  const openStdio = openers.stdio ?? openStdioConnection;
  const makeFetch = openers.makeFetch ?? createMcpFetch;
  const resolveHost = openers.resolveHost ?? nodeEgressDeps.resolveHost;
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
        ? buildStdioConfig(ref.id, ref, cwd, resolveSecret, openStdio, consented?.get(ref.id))
        : buildNetworkConfig(ref.id, ref.transport, ref, network, makeFetch, resolveHost),
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
  consented?: ResolvedStdioSpawn,
): McpServerConfig {
  // The schema's `superRefine` already guarantees `command` for a stdio transport; re-assert so the spawn spec
  // is total without a non-null assertion (a defensive, typed failure rather than an undefined spawn).
  if (ref.command === undefined) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': a 'stdio' transport requires a 'command'.`,
    );
  }
  // The consented absolute executable when the gate ran, else the authored command (ADR-0084 §3). Spawning
  // what was decided about is the other half of resolving before the decision: a `PATH` that changed in
  // between must not select a different binary under an approved fingerprint.
  const command = consented?.resolvedCommand ?? ref.command;
  // **Re-asserted here, defensively**, exactly as the network sibling re-asserts its own `url`/`env` rules
  // and for the same stated reason: a programmatic caller that bypassed the schema must fail loud rather
  // than reach a spawn. ADR-0084 §1 designates this function's caller as THE chokepoint, and
  // `resolveMcpServerRef` hand-builds a ref from a registration that is documented as never re-parsed.
  for (const key of Object.keys(ref.env ?? {})) {
    if (isForbiddenDeclaredEnvKey(key)) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}' declares an environment variable that may not be set — it can redirect the interpreter, the dynamic loader, or a tool's configuration.`,
      );
    }
  }
  const env = buildChildEnv(serverId, ref.env, resolveSecret);
  const args = ref.args;
  return {
    id: serverId,
    ...toolsAllowlistFields(ref),
    // **The signal is a PARAMETER of the closure, not a capture.** `startMcpClient` calls `open(signal)`, and
    // a zero-argument closure accepts that call and silently DROPS the argument — TypeScript is happy, and the
    // whole cancel path becomes dead surface that type-checks and cannot fire. That is exactly the defect the
    // `McpServerConfig.open` doc records one layer down, and it was still true HERE until a review found it:
    // a Ctrl-C during a cold `npx` reached this point and stopped nothing, orphaning the child — because
    // `client.childPids` stays empty until a connect fully succeeds, so neither reaper had a pid either.
    open: (signal) =>
      openStdio(
        serverId,
        {
          command,
          env,
          cwd,
          ...(args === undefined ? {} : { args }),
          ...(ref.connect_timeout_ms === undefined
            ? {}
            : { connectTimeoutMs: ref.connect_timeout_ms }),
        },
        signal,
      ),
  };
}

/** Build the {@link McpServerConfig} for a network server (`http`/`sse`/`websocket`) — a fail-loud `url`/`env`
 *  check, the SSRF floor, and the transport-dispatched connect closure. */
function buildNetworkConfig(
  serverId: string,
  transport: NetworkTransport,
  ref: McpServerRef,
  openers: NetworkOpeners,
  makeFetch: (config: McpFetchConfig) => McpFetch,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
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
  // Admission: scheme, credentials, the private-range rule, and — for `websocket` — the §2.3 narrowing.
  // Returns the authored `host:port` when the server opted into a local endpoint, which is the scope the
  // dialer then enforces (ADR-0088 §2.2/§4).
  const localEndpoint = assertSafeNetworkEndpoint(
    serverId,
    url,
    transport,
    ref.allow_local_endpoint === true,
  );
  const open = openers[transport]; // `http` (Streamable HTTP) | `sse` (legacy HTTP+SSE alias) | `websocket`
  const connectTimeoutMs = ref.connect_timeout_ms;
  // **The validated dialer, per server** (ADR-0088 §2.1). `http`/`sse` accept an injected `fetch`, so every
  // request on those transports — the initialize POST, each `tools/call`, the long-lived GET stream — rides
  // the ONE shared connect-by-validated-IP hop carrying this server's own local-endpoint scope. `websocket`
  // accepts no such hook, which is why §2.3 narrows it to a local endpoint rather than pretending otherwise.
  const validatedFetch =
    transport === 'websocket'
      ? undefined
      : makeFetch({ ...(localEndpoint === undefined ? {} : { localEndpoint }) });
  // **The check §2.3 promises and the first implementation omitted.** `websocket` cannot be pinned, but the
  // ADR still requires the pre-connect resolve-and-range-block — and without it the transport had NO address
  // check at all beyond the authored literal. That mattered because `isPrivateOrLocalHost` treats
  // `*.local` / `*.internal` / `*.localhost` as local from the SUFFIX alone: a cloned repo declaring
  // `ws://mcp-relay.local:8080` with `allow_local_endpoint` was admitted (so the §2.3 remote refusal never
  // fired), connected in plaintext, and pointed wherever the LAN's mDNS responder said — with no consent
  // gate, because ADR-0084 covers `stdio` only.
  const needsPreflight = transport === 'websocket';
  return {
    id: serverId,
    ...toolsAllowlistFields(ref),
    // A parameter, not a capture — see the stdio sibling for what a zero-argument closure silently costs.
    open: async (signal) => {
      // **Run INSIDE `open`, not eagerly at config-build time**, and a review found both reasons. Started
      // eagerly it was a hot promise nobody had to await: a later ref throwing synchronously discarded the
      // whole config array and the abandoned lookup surfaced as an unhandled rejection. And it ran before
      // any deadline or signal existed, so a hung `.local` resolver — the exact case §2.3 is about — hung
      // the whole connect with Ctrl-C doing nothing.
      if (needsPreflight) {
        await assertResolvesLocal(serverId, url, resolveHost, signal);
      }
      return open(
        serverId,
        {
          url,
          ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
          ...(validatedFetch === undefined ? {} : { fetch: validatedFetch }),
        },
        signal,
      );
    },
  };
}

/**
 * The `websocket` pre-connect resolve-and-range-block ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.3).
 *
 * This transport takes no dialer, so the address cannot be PINNED — that residual is stated and accepted. What
 * §2.3 does require, and what makes the local-only narrowing meaningful at all, is that the name actually
 * resolves where the author said: every answer must be private, and none may be link-local or metadata. A
 * suffix like `.local` is a claim about a name, not about an address, and an mDNS responder on the same LAN
 * is who answers it.
 *
 * **Bounded and cancellable, like every other MCP call** (ADR-0088 §1). `dns.lookup` is not abortable, so the
 * bound is a race: the caller is released at the deadline or on their signal even though the lookup itself
 * keeps running in the background until the OS resolver gives up. Without it a hung mDNS responder — the very
 * thing §2.3's narrowing is about — hung the whole connect with Ctrl-C doing nothing.
 */
async function assertResolvesLocal(
  serverId: string,
  url: string,
  resolveHost: (hostname: string) => Promise<readonly string[]>,
  signal?: AbortSignalLike,
): Promise<void> {
  const parsed = extractEgressAuthority(url);
  if (parsed === null) return; // already refused by the admission — nothing to add
  let addresses: readonly string[];
  try {
    addresses = await raceDeadline(
      serverId,
      'connect',
      openWindow(MCP_DEADLINES.networkConnectMs),
      () => resolveHost(parsed.host),
      signal,
    );
  } catch (err) {
    if (err instanceof McpDeadlineError || err instanceof McpAbortedError) throw err;
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': '${parsed.host}' could not be resolved.`,
    );
  }
  if (addresses.length === 0) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': '${parsed.host}' did not resolve to an address.`,
    );
  }
  for (const address of addresses) {
    if (isMetadataOrLinkLocal(address)) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}': '${parsed.host}' resolves to a link-local or cloud-metadata address.`,
      );
    }
    if (!isPrivateOrLocalHost(address)) {
      throw new CliError(
        'invalid_invocation',
        `MCP server '${serverId}': '${parsed.host}' is declared as a local endpoint but resolves to a ` +
          `public address. A 'websocket' server must be genuinely local — use transport: 'http' for a remote one.`,
      );
    }
  }
}

/**
 * **Admission** for a network MCP `url` — what may be declared at all
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.2–§4,
 * [ADR-0053](../../../docs/decisions/0053-mcp-network-transport-egress-security.md)). Reuses the ONE shared
 * `isPrivateOrLocalHost` range-block primitive (never re-implemented), and returns the authored `host:port`
 * when the server opted into a local endpoint — the scope the dialer then enforces on every resolved address.
 *
 * It is no longer the whole story, and that is the point of §2.1: this checks the AUTHORED host, so a name
 * that DNS-resolves to a private IP is caught by the **dialer**, not here. What stays here is what can only be
 * decided from the declaration:
 *
 * - **no embedded credentials**, which the opt-in never relaxes;
 * - **the scheme family**, rejected before any relaxation so an opted-in local endpoint can never wave through
 *   a `file:`/`javascript:` scheme;
 * - **a remote endpoint is `https`/`wss`**, always — the rule two independent relaxation flags would have
 *   inverted (ADR-0088 §4);
 * - **a remote `websocket` is refused outright** (§2.3). `WebSocketClientTransport` takes a `URL` and nothing
 *   else and parses each frame before Relavium sees a byte, so on that transport there is neither a pin nor a
 *   byte bound to give a server the user never consented to run. A local opted-in one is permitted: an
 *   unbounded transport must be local and explicitly admitted, which is the same line `stdio` sits on.
 */
function assertSafeNetworkEndpoint(
  serverId: string,
  url: string,
  transport: NetworkTransport,
  allowLocal: boolean,
): LocalEndpoint | undefined {
  const parsed = extractEgressAuthority(url);
  if (parsed === null) {
    // The ONE parser. `new URL` here would have been a second reading of the same bytes, and the dialer's
    // `host:port` scope must be derived from the SAME parse the admission approved or the two can disagree.
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': malformed url or unsupported scheme (http/https/ws/wss only).`,
    );
  }
  if (parsed.hasCredentials || urlHasCredentials(url)) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': the url must not embed credentials (user:pass@…) — use env/keychain auth.`,
    );
  }
  if (isMetadataOrLinkLocal(parsed.host)) {
    // Refused before the opt-in is even consulted. `169.254.169.254` is inside the private ranges, so it
    // would otherwise satisfy every condition for an "authored local endpoint" — and ADR-0053's own Context
    // names a registry pointing a server there as the motivating threat.
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': '${parsed.host}' is a link-local or cloud-metadata address, which no ` +
        `'allow_local_endpoint' opt-in may name.`,
    );
  }
  const isLocalHost = isPrivateOrLocalHost(parsed.host);
  if (isLocalHost && !allowLocal) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': '${parsed.host}' is a private/loopback/link-local address. ` +
        `Set 'allow_local_endpoint: true' on the server to permit a local MCP endpoint.`,
    );
  }
  if (transport === 'websocket' && !isLocalHost) {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': a remote 'websocket' MCP server is not supported — its transport cannot be ` +
        `pinned to a validated address or byte-bounded, so it is refused rather than connected unsafely. ` +
        `Use transport: 'http' (Streamable HTTP), which carries the same server safely.`,
    );
  }
  if (!isLocalHost && parsed.scheme !== 'https' && parsed.scheme !== 'wss') {
    throw new CliError(
      'invalid_invocation',
      `MCP server '${serverId}': a remote MCP url must use https/wss (got '${parsed.scheme}').`,
    );
  }
  // A local endpoint's scope: exactly this `host:port`, which is what lets the dialer refuse a sibling port
  // on the same permitted host (`:6379`, `:5432`, `:22`, a container socket) — SEC-EGRESS-3's requirement.
  return isLocalHost ? { host: parsed.host, port: parsed.port } : undefined;
}

/**
 * Refuse to reach a spawn when a stdio server is declared and NO consent gate was wired.
 *
 * [ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §1 names these two functions
 * the chokepoint, but the gate arrived as an OPTIONAL dependency — and a review found that exactly one of the
 * four entry points had wired it, so `chat`, `chat-resume`, Home and `agent run` all spawned local programs
 * with no decision at all. An optional guard is a guard that a fifth surface will forget in the same way, so
 * a missing one is a loud refusal here rather than a silent bypass three layers down.
 *
 * It stays a runtime check rather than a required field because `resolveServerConfigs` is also the pure
 * config builder its own unit tests exercise directly; the obligation belongs to the connect boundary, which
 * is what a surface actually calls.
 */
function requireGateForStdio(
  refs: readonly McpServerRef[],
  gate: StdioConsentGate | undefined,
): void {
  if (gate !== undefined) return;
  const stdio = refs.filter((ref) => ref.transport === 'stdio').map((ref) => ref.id);
  if (stdio.length === 0) return;
  throw new CliError(
    'internal',
    `refusing to start local MCP program(s) (${stdio.join(', ')}): this surface reached the MCP host without a consent gate. This is a wiring defect, not a configuration one.`,
  );
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
  // **The gate, before anything is built** (ADR-0084 §1). On the resolved INLINE refs, because an agent may
  // declare a server with no `[[mcp_servers]]` registration at all — the imported-artifact case.
  requireGateForStdio(inline, opts.consentGate);
  const consented = await opts.consentGate?.(inline, opts.cwd, opts.artifact);
  const configs = resolveServerConfigs(inline, opts.cwd, opts.resolveSecret, {}, consented);
  if (configs.length === 0) return undefined;
  return startMcpClientFailLoud(configs, opts.startMcpClient, opts.connectSignal);
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
  connectSignal?: AbortSignalLike,
): Promise<McpClient> {
  const start = custom ?? defaultStartMcpClient;
  try {
    return await start(configs, connectSignal);
  } catch (err) {
    if (err instanceof McpError) {
      throw new CliError(
        'invalid_invocation',
        `MCP server connection failed: ${err.message}${deadlineHint(err)}`,
      );
    }
    throw err;
  }
}

/**
 * The one-line remedy for a connect that ran out of time.
 *
 * Without it a user waits the full deadline and is told only that it elapsed — true, secret-free, and useless,
 * because the escape hatch exists and its name appears nowhere. This is the half of `#204` that a discriminant
 * alone does not buy: the type tells a PROGRAM what happened, and this tells a PERSON what to do. Only the
 * connect phase gets it, because it is the only phase with an authored override — saying "raise
 * `connect_timeout_ms`" after a slow `tools/call` would send an author to a field that cannot help.
 */
function deadlineHint(err: McpError): string {
  if (!(err instanceof McpDeadlineError) || err.phase !== 'connect') return '';
  return (
    ` If this server is legitimately slow to start (a cold \`npx\` often is), raise it with` +
    ` \`connect_timeout_ms\` on the server entry (max ${MCP_CONNECT_TIMEOUT_CEILING_MS} ms).`
  );
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
  readonly startMcpClient?: (
    servers: readonly McpServerConfig[],
    signal?: AbortSignalLike,
  ) => Promise<McpClient>;
  /** Cancels the connect and the discovery walk (ADR-0088 §1.1) — see {@link ConnectAgentMcpOptions.connectSignal}. */
  readonly connectSignal?: AbortSignalLike;
  /** Resolve `{{secrets.<name>}}` in a server `env` value (2.R Step 4, ADR-0052 §6); see {@link ConnectAgentMcpOptions}. */
  readonly resolveSecret?: McpSecretResolver;
  /** The merged config `[[mcp_servers]]` registrations (Step 4b) — resolves a by-name `ref` entry; see {@link ConnectAgentMcpOptions}. */
  readonly registrations?: readonly McpServerRegistration[];
  /** The consent gate (ADR-0084 §1); see {@link ConnectAgentMcpOptions.consentGate}. */
  readonly consentGate?: StdioConsentGate;
  /** The workflow path, shown at the consent prompt so the imported-artifact case names its own file. */
  readonly artifact?: string;
}

/**
 * Does this workflow declare ANY inbound MCP server on an inline agent?
 *
 * A cheap, side-effect-free look ahead of {@link connectWorkflowMcp}, so a caller can decide whether there is
 * anything to guard **before** the connect that spawns the children
 * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §1.3). Arming a signal handler
 * unconditionally was the first attempt and a regression: `relavium run` has a documented single-SIGINT-handler
 * contract (`drive.ts` identifies its own by set-delta), and a guard installed for a workflow with no children
 * to reap is a second listener that does nothing but break it.
 *
 * Deliberately does NOT resolve a `ref` or validate anything — an unresolvable `ref` is
 * {@link connectWorkflowMcp}'s fail-loud, not this predicate's, and answering "yes, look closer" is the safe
 * direction for a look-ahead.
 */
export function workflowDeclaresMcp(def: WorkflowDefinition): boolean {
  return (def.workflow.agents ?? [])
    .filter(isInlineAgent)
    .some((agent) => (agent.mcp_servers ?? []).length > 0);
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

  requireGateForStdio([...byId.values()], opts.consentGate);
  const consented = await opts.consentGate?.([...byId.values()], opts.cwd, opts.artifact);
  const configs = resolveServerConfigs(
    [...byId.values()],
    opts.cwd,
    opts.resolveSecret,
    {},
    consented,
  );
  const client = await startMcpClientFailLoud(configs, opts.startMcpClient, opts.connectSignal);

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
    // Part of the identity for the SAME reason `allow_local_endpoint` is (ADR-0088 §1.4): a same-id pair
    // differing only in its connect deadline would otherwise collapse first-wins, silently giving BOTH
    // declarations a bound neither author wrote. It is deliberately NOT in the ADR-0084 consent digest —
    // that answers "is this the same PROGRAM", and a timeout changes nothing about what executes.
    d: ref.connect_timeout_ms ?? null,
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
