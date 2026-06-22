import type { WorkflowDefinition } from '@relavium/core';
import { defaultProviders, type LlmProvider, type ProviderId } from '@relavium/llm';
import type { Agent } from '@relavium/shared';

import { CliError } from '../process/errors.js';

/**
 * The CLI's provider seam (ADR-0038 host-injected resolution). `resolveProvider` returns the keyless
 * `@relavium/llm` adapter for an authored provider id; `keyFor` resolves that provider's API key from
 * the environment (`RELAVIUM_<PROVIDER>_API_KEY`, the config-spec headless fallback). The OS keychain
 * source lands in **2.C** behind this same seam. A key is read only when `keyFor` is invoked (per
 * attempt) and is never logged, stored, or returned to the caller.
 *
 * Injectable so a test (and the 2.K regression harness) drives a stub provider with a dummy key.
 */
export interface ProviderResolver {
  readonly resolveProvider: (id: ProviderId) => LlmProvider | undefined;
  readonly keyFor: (id: ProviderId) => string;
}

/** The env var holding a provider's API key (the config-spec headless fallback). */
export function providerKeyEnvVar(id: ProviderId): string {
  return `RELAVIUM_${id.toUpperCase()}_API_KEY`;
}

/**
 * The provider ids whose key is **guaranteed** needed by a parsed workflow — the **primary**
 * `provider` (the authored `agent.provider`, never derived from the model) of every inline agent
 * referenced by an `agent` node. Powers the `relavium run` key pre-flight so a missing key is a clean
 * exit-2 invocation error rather than a mid-run failure, and is deliberately a **strict subset** of
 * the keys a run might touch so it can never false-fail a valid run:
 *
 * - A missing **primary** key is fatal at the first attempt — `auth` is not in `RETRYABLE_KINDS`
 *   (@relavium/llm), so the FallbackChain never fails over from it; the node fails regardless of any
 *   fallback. The primary key is therefore always required, so demanding it up-front is always correct.
 * - A **`fallback_chain`** provider's key is read lazily, only if the chain actually fails over to it
 *   (a retryable primary failure). A run whose primary succeeds never needs it — so it is **excluded**
 *   here (demanding it would false-fail that run); a genuinely-missing fallback key surfaces at runtime.
 * - A **`$ref`** / registry agent is **skipped**: the CLI cannot resolve external `.agent.yaml` agents
 *   until 2.M–2.Q, so its key (like a fallback's) surfaces at runtime instead.
 */
export function neededProviderIds(def: WorkflowDefinition): ProviderId[] {
  const referencedRefs = new Set<string>();
  for (const node of def.workflow.nodes) {
    if (node.type === 'agent') {
      referencedRefs.add(node.agent_ref);
    }
  }
  const inlineAgents = (def.workflow.agents ?? []).filter((agent): agent is Agent => 'id' in agent);
  const needed = new Set<ProviderId>();
  for (const ref of referencedRefs) {
    const agent = inlineAgents.find((candidate) => candidate.id === ref);
    if (agent === undefined) {
      continue; // a `$ref` / registry agent — not resolvable in the CLI yet; let it fall through to runtime
    }
    needed.add(agent.provider); // primary only — a fallback key is conditional (see the doc above)
  }
  return [...needed];
}

export function createProviderResolver(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderResolver {
  // Keyless adapters built once and reused; the key is injected per call via `keyFor`. The
  // provider→adapter mapping lives in the seam package (`@relavium/llm`), not here.
  const adapters = defaultProviders();
  return {
    resolveProvider: (id) => adapters[id],
    keyFor: (id) => {
      const key = env[providerKeyEnvVar(id)];
      if (key === undefined || key === '') {
        throw new CliError(
          'invalid_invocation',
          `no API key for provider '${id}' — set ${providerKeyEnvVar(id)} (OS keychain support lands in 2.C).`,
        );
      }
      return key;
    },
  };
}
