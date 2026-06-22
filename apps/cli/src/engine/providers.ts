import { defaultProviders, type LlmProvider, type ProviderId } from '@relavium/llm';

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
