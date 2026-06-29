import type { ProviderId } from '@relavium/llm';
import {
  startMcpClient as defaultStartMcpClient,
  type McpClient,
  type McpServerConfig,
} from '@relavium/mcp';

import { KNOWN_PROVIDERS, validateProviderKey, type ProviderResolver } from '../engine/providers.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import { failCheck, okCheck, warnCheck, type DoctorCheck } from './doctor.js';

/**
 * The `/doctor --deep` probes (2.5.C S5) — the network/process-touching tier, kept OUT of the pure doctor.ts.
 * Each probe is a closure built over injected ports, so the orchestrator stays test-driven without a live
 * provider or MCP server.
 *
 * SECURITY:
 *  - Provider validation delegates the live request + the key-redaction to {@link validateProviderKey} (the
 *    seam) — the secret never reaches a `detail` string. Each request is bounded by an `AbortController`.
 *  - MCP probing connects each server ALONE (`startMcpClient` is fail-loud across servers — isolation yields a
 *    per-server verdict), under a bounded race-timeout; a late-resolving (hung) connect is still torn down so a
 *    probe never leaks a child process / socket. Connect failures are typed + secret-free (`McpConnectError`),
 *    re-sanitized to a single line defensively. The endpoints were already vetted by the SSRF floor +
 *    secret-resolution when the caller built the {@link McpServerConfig}s (engine/mcp-servers.ts).
 */

/** The default per-target bound — long enough for a cold provider/MCP handshake, short enough to stay snappy. */
export const DEEP_PROBE_TIMEOUT_MS = 10_000;

// ── provider-key validation ──────────────────────────────────────────────────

export interface ProviderProbeDeps {
  readonly resolver: ProviderResolver;
  /** The candidate provider ids to consider (default: all known providers). Each is validated ONLY if its key
   *  actually resolves (keychain ∪ env) — the filter runs lazily INSIDE the probe so assembling the probe does
   *  no I/O (never reads a key until `/doctor --deep` runs). */
  readonly candidateIds?: readonly ProviderId[];
  readonly timeoutMs?: number;
}

/** Build the `--deep` provider probe: validate each CONFIGURED key with a bounded live ping. */
export function buildProviderProbe(deps: ProviderProbeDeps): () => Promise<readonly DoctorCheck[]> {
  return async () => {
    const candidates = deps.candidateIds ?? (Object.keys(KNOWN_PROVIDERS) as ProviderId[]);
    // Resolve each candidate's key ONCE (keychain → env → skip). All reads happen here, lazily, when the probe
    // runs — never at assembly. A provider with no key is simply not configured, so it is skipped (not failed).
    const configured: { readonly id: ProviderId; readonly key: string }[] = [];
    for (const id of candidates) {
      try {
        configured.push({ id, key: deps.resolver.keyFor(id) });
      } catch {
        // No key for this provider — skip it (an unconfigured provider is not a failure).
      }
    }
    if (configured.length === 0) {
      return [warnCheck('provider', 'providers', 'no keys configured')];
    }
    return Promise.all(configured.map(({ id, key }) => probeProvider(id, key, deps)));
  };
}

async function probeProvider(
  id: ProviderId,
  key: string,
  deps: ProviderProbeDeps,
): Promise<DoctorCheck> {
  const provider = deps.resolver.resolveProvider(id);
  if (provider === undefined) {
    return failCheck(`provider:${id}`, id, 'no adapter');
  }
  const timeoutMs = deps.timeoutMs ?? DEEP_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // HARD outer bound (parity with the MCP probe): the AbortController cancels the in-flight request AND the race
  // guarantees the probe settles even if an adapter ignores the signal — `/doctor` can never hang on a provider.
  const timeout = new Promise<DoctorCheck>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failCheck(`provider:${id}`, id, `timeout (${timeoutMs}ms)`));
    }, timeoutMs);
  });
  const probe = validateProviderKey(
    provider,
    key,
    KNOWN_PROVIDERS[id].testModel,
    controller.signal,
  ).then((result) =>
    result.ok
      ? okCheck(`provider:${id}`, id, result.detail)
      : failCheck(`provider:${id}`, id, sanitizeInline(result.detail)),
  );
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── MCP connectivity ───────────────────────────────────────────────────────────

export interface McpProbeDeps {
  /** The resolved per-server configs — the caller builds them via `resolveServerConfigs` (SSRF + secrets done). */
  readonly servers: readonly McpServerConfig[];
  readonly startMcpClient?: (servers: readonly McpServerConfig[]) => Promise<McpClient>;
  readonly timeoutMs?: number;
}

/** Build the `--deep` MCP probe: connect each declared server (isolated, bounded), report tool count or failure. */
export function buildMcpProbe(deps: McpProbeDeps): () => Promise<readonly DoctorCheck[]> {
  return async () => {
    if (deps.servers.length === 0) {
      return [warnCheck('mcp', 'MCP servers', 'none configured')];
    }
    return Promise.all(deps.servers.map((server) => probeOneServer(server, deps)));
  };
}

type ConnectOutcome =
  | { readonly kind: 'client'; readonly client: McpClient }
  | { readonly kind: 'error'; readonly err: unknown };

async function probeOneServer(server: McpServerConfig, deps: McpProbeDeps): Promise<DoctorCheck> {
  const start = deps.startMcpClient ?? defaultStartMcpClient;
  const timeoutMs = deps.timeoutMs ?? DEEP_PROBE_TIMEOUT_MS;
  // Connect this server ALONE — `startMcpClient` is fail-loud across servers, so isolating yields a per-server
  // verdict (one dead server never masks the others). The promise NEVER rejects (folded into an outcome).
  const connect: Promise<ConnectOutcome> = start([server]).then(
    (client) => ({ kind: 'client', client }),
    (err: unknown) => ({ kind: 'error', err }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([connect, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === 'timeout') {
    // The connect may still resolve later (a hung spawn / handshake) — tear down a late client so the probe
    // never leaks a child process / socket. Best-effort: a teardown failure is swallowed.
    void connect
      .then((late) => (late.kind === 'client' ? late.client.close() : undefined))
      .catch(() => undefined);
    return failCheck(`mcp:${server.id}`, server.id, `timeout (${timeoutMs}ms)`);
  }
  if (outcome.kind === 'error') {
    const detail = outcome.err instanceof Error ? sanitizeInline(outcome.err.message) : 'connect failed';
    return failCheck(`mcp:${server.id}`, server.id, detail);
  }
  const toolCount = outcome.client.toolDefs.length;
  // The server connected + listed tools — that IS the health signal. Teardown is best-effort: a `close()` fault
  // is teardown noise, not a probe failure (and must not reject the whole `/doctor` run via the Promise.all).
  await outcome.client.close().catch(() => undefined);
  return okCheck(`mcp:${server.id}`, server.id, `${toolCount} tool(s)`);
}
