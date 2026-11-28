import type { ProviderId } from '@relavium/llm';
import type { ManagerSkippedTool } from '@relavium/mcp';
import type { McpServerRef } from '@relavium/shared';

import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_IDS,
  providerDisplayName,
  providerEndpointOrigin,
  validateProviderKey,
  type ProviderResolver,
} from '../engine/providers.js';
import { sanitizeInline } from '../render/sanitize.js';
import { okCheck, warnCheck, failCheck, type DoctorCheck } from './doctor.js';
import type { SessionWorkOwner } from './session-work-owner.js';

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
  /** A report timeout does not settle the actual provider operation or release its host. */
  readonly workOwner?: Pick<SessionWorkOwner, 'signal' | 'work' | 'assertAdmitting'>;
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
    deps.workOwner?.assertAdmitting();
    const candidates = deps.candidateIds ?? KNOWN_PROVIDER_IDS;
    // Resolve each candidate's key ONCE (keychain → env → skip). All reads happen here, lazily, when the probe
    // runs — never at assembly. A provider with no key is simply not configured, so it is skipped (not failed).
    const configured: { readonly id: ProviderId; readonly key: string }[] = [];
    for (const id of candidates) {
      deps.workOwner?.assertAdmitting();
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
    return failCheck(`provider:${id}`, providerDisplayName(id), 'no adapter');
  }
  // `validateProviderKey` is bounded internally (AbortController + hard race), so no outer race is needed here.
  const result = await validateProviderKey(
    provider,
    key,
    KNOWN_PROVIDERS[id].starterModel,
    deps.timeoutMs,
    deps.workOwner,
  );
  return result.ok
    ? okCheck(`provider:${id}`, providerDisplayName(id), result.detail)
    : failCheck(`provider:${id}`, providerDisplayName(id), sanitizeInline(result.detail));
}

// ── the consented deep tier (the doctor popup, ADR-0148 §8) ───────────────────────

/**
 * One provider the deep tier's confirmation line names: its id and the ORIGIN its key would be sent to, both frozen when the line was armed
 * (`providerEndpointOrigin`, the resolver's pinned destination). The run is given exactly these and refuses anything else.
 */
export interface ConsentTarget {
  readonly providerId: ProviderId;
  readonly origin: string;
}

/** What the consented run needs: the resolver it reads the keys and the adapters from, the lifetime its requests run under, and their bound. */
export interface ConsentedProbeDeps {
  readonly resolver: ProviderResolver;
  /** Always given: its signal aborts every request (a closed popup, `Esc`, the owner stopping), and its `work` retains each producer. */
  readonly lifecycle: NonNullable<Parameters<typeof validateProviderKey>[4]>;
  /** Per-provider request bound (ms), threaded to {@link validateProviderKey}; default there. */
  readonly timeoutMs?: number;
}

/** What a target says when it was not contacted, as its row's detail: the line named another destination, or the key is gone. */
export const ENDPOINT_CHANGED_DETAIL =
  'not contacted: its endpoint changed after the confirmation was shown, so nothing was sent';
export const KEY_GONE_DETAIL =
  'not contacted: its key could not be read after the confirmation, so nothing was sent';

/**
 * Validate the keys of EXACTLY the providers the confirmation line named, each only at the origin the line named for it (ADR-0148 §8). No other
 * id is read or contacted: a key stored after the line was armed is not in `targets`. For each target, in ONE synchronous step before its
 * request starts, the adapter is taken from the resolver and its pinned destination is read again: a destination that is not the frozen origin
 * is refused with a `fail` row and no request is made, and the key is read only after that check passed. The request goes through
 * {@link validateProviderKey} (the seam, its redaction and its bound), whose abort reaches the request.
 */
export async function runConsentedProviderChecks(
  targets: readonly ConsentTarget[],
  deps: ConsentedProbeDeps,
): Promise<readonly DoctorCheck[]> {
  deps.lifecycle.assertAdmitting();
  const checks = targets.map((target): Promise<DoctorCheck> => {
    const id = target.providerId;
    const label = providerDisplayName(id);
    const provider = deps.resolver.resolveProvider(id);
    // Read in the same synchronous step as the adapter above and the request below: what is checked is what the request is built from.
    if (providerEndpointOrigin(deps.resolver, id) !== target.origin)
      return Promise.resolve(failCheck(`provider:${id}`, label, ENDPOINT_CHANGED_DETAIL));
    if (provider === undefined)
      return Promise.resolve(failCheck(`provider:${id}`, label, 'no adapter'));
    let key: string;
    try {
      key = deps.resolver.keyFor(id);
    } catch {
      return Promise.resolve(failCheck(`provider:${id}`, label, KEY_GONE_DETAIL));
    }
    return validateProviderKey(
      provider,
      key,
      KNOWN_PROVIDERS[id].starterModel,
      deps.timeoutMs,
      deps.lifecycle,
    ).then((result) =>
      result.ok
        ? okCheck(`provider:${id}`, label, result.detail)
        : failCheck(`provider:${id}`, label, sanitizeInline(result.detail)),
    );
  });
  return Promise.all(checks);
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
 * explains a missing capability); no declared server is `ok` ("none configured"): nothing was asked of an MCP server, so nothing is wrong, and
 * a healthy first deep run must not be headed as a problem for a feature the person has not set up.
 */
export function mcpSessionChecks(
  agentMcpServers: readonly McpServerRef[],
  skipped: readonly ManagerSkippedTool[],
): readonly DoctorCheck[] {
  if (agentMcpServers.length === 0) {
    return [okCheck('mcp', 'MCP servers', 'none configured')];
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
