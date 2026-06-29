import type { ProviderId } from '@relavium/llm';
import type { ManagerSkippedTool } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';

import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  validateProviderKey,
  type ProviderResolver,
} from '../engine/providers.js';
import { sanitizeInline } from '../render/tui/chat-projection.js';
import { okCheck, warnCheck, failCheck, type DoctorCheck } from './doctor.js';

/**
 * The `/doctor --deep` probes (2.5.C S5).
 *
 * SECURITY:
 *  - Provider validation delegates the live request + the key-redaction + the BOUND (AbortController + hard
 *    `Promise.race` timeout) to {@link validateProviderKey} (the seam) — the secret never reaches a `detail`
 *    string and a stalled provider can never hang `/doctor`.
 *  - MCP reporting is **read-only**: it reports the live session's ALREADY-connected status (the agent's declared
 *    `mcp_servers` — all connected, because the session is live and the connect is fail-loud — plus the tools the
 *    manager dropped at discovery). It does NOT connect/spawn anything. This is deliberate (a security-review
 *    finding): re-connecting from `/doctor` would (a) connect/spawn the authorized set REDUNDANTLY and risk an
 *    orphaned child on a timeout+exit window, and (b) — if it connected the config `[[mcp_servers]]` registrations
 *    — spawn servers NO agent referenced, an arbitrary-spawn primitive from an imported project config. The
 *    session already proves connectivity within the documented on-demand model; the probe only reports it.
 */

// ── provider-key validation ──────────────────────────────────────────────────

export interface ProviderProbeDeps {
  readonly resolver: ProviderResolver;
  /** The candidate provider ids to consider (default: every known provider, {@link KNOWN_PROVIDER_IDS}). Each is
   *  validated ONLY if its key actually resolves (keychain ∪ env) — the filter runs lazily INSIDE the probe so
   *  assembling the probe does no I/O (never reads a key until `/doctor --deep` runs). */
  readonly candidateIds?: readonly ProviderId[];
  /** Per-provider request bound (ms) — threaded to {@link validateProviderKey}; default there. */
  readonly timeoutMs?: number;
}

/** Build the `--deep` provider probe: validate each CONFIGURED key with a bounded live ping. */
export function buildProviderProbe(deps: ProviderProbeDeps): () => Promise<readonly DoctorCheck[]> {
  return async () => {
    const candidates = deps.candidateIds ?? KNOWN_PROVIDER_IDS;
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
  // `validateProviderKey` is bounded internally (AbortController + hard race), so no outer race is needed here.
  const result = await validateProviderKey(
    provider,
    key,
    KNOWN_PROVIDERS[id].testModel,
    deps.timeoutMs,
  );
  return result.ok
    ? okCheck(`provider:${id}`, id, result.detail)
    : failCheck(`provider:${id}`, id, sanitizeInline(result.detail));
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
