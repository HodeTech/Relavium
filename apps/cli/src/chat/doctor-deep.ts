import type { ProviderId } from '@relavium/llm';
import type { ManagerSkippedTool } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';

import { KNOWN_PROVIDERS, validateProviderKey, type ProviderResolver } from '../engine/providers.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import { okCheck, warnCheck, failCheck, type DoctorCheck } from './doctor.js';

/**
 * The `/doctor --deep` probes (2.5.C S5).
 *
 * SECURITY:
 *  - Provider validation delegates the live request + the key-redaction to {@link validateProviderKey} (the
 *    seam) — the secret never reaches a `detail` string. Each request is bounded by a hard `Promise.race` (so a
 *    misbehaving adapter cannot hang `/doctor`) plus an `AbortController` that cancels the in-flight request.
 *  - MCP reporting is **read-only**: it reports the live session's ALREADY-connected status (the agent's declared
 *    `mcp_servers` — all connected, because the session is live and the connect is fail-loud — plus the tools the
 *    manager dropped at discovery). It does NOT connect/spawn anything. This is deliberate (a security-review
 *    finding): re-connecting from `/doctor` would (a) connect/spawn the authorized set REDUNDANTLY and risk an
 *    orphaned child on a timeout+exit window, and (b) — if it connected the config `[[mcp_servers]]` registrations
 *    — spawn servers NO agent referenced, an arbitrary-spawn primitive from an imported project config. The
 *    session already proves connectivity within the documented on-demand model; the probe only reports it.
 */

/** The default per-provider request bound — long enough for a cold provider handshake, short enough to stay
 *  snappy. (The MCP tier is read-only and never connects, so it has no timeout.) */
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

// ── MCP status (read-only — reports the live session, never connects) ────────────

/** The display id of an `mcp_servers` entry — the inline `id` or the by-name `ref` (sanitized at render). */
function refId(entry: McpServerRef): string {
  return entry.id ?? entry.ref ?? '?';
}

/**
 * Report the session's MCP status from what the build ALREADY resolved — the agent's declared `mcp_servers` (every
 * one is connected: a live session means the fail-loud connect-all succeeded) and the tools the manager dropped at
 * discovery (`mcpSkipped`). PURE — no connect, no spawn, no socket, no timeout. A skipped tool is a `warn` (it
 * explains a missing capability); no declared server is a `warn` ("none configured").
 */
export function mcpSessionChecks(
  agentMcpServers: readonly McpServerRef[],
  skipped: readonly ManagerSkippedTool[],
): readonly DoctorCheck[] {
  if (agentMcpServers.length === 0) {
    return [warnCheck('mcp', 'MCP servers', 'none configured')];
  }
  const checks: DoctorCheck[] = agentMcpServers.map((entry) => {
    const id = refId(entry);
    return okCheck(`mcp:${id}`, id, 'connected');
  });
  for (const skip of skipped) {
    checks.push(
      warnCheck(
        `mcp:skip:${skip.server}:${skip.name}`,
        `${skip.server}/${skip.name}`,
        `tool skipped — ${skip.reason}`,
      ),
    );
  }
  return checks;
}
