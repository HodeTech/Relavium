import type { ProviderKind } from '@relavium/shared';

import { createAnthropicAdapter } from './adapters/anthropic.js';
import { createGeminiAdapter } from './adapters/gemini.js';
import { createOpenAiAdapter } from './adapters/openai.js';
import type { LlmProvider, ProviderId } from './types.js';

/**
 * Build the default **keyless** provider adapter for every authored provider id (ADR-0011 /
 * ADR-0038). A host wires these into `AgentRunnerDeps.resolveProvider` and injects the API key per
 * call via `keyFor` — so the provider→adapter mapping (including DeepSeek being served by the
 * OpenAI-compatible adapter via a custom `baseURL`) lives here, in the seam package, rather than in
 * every surface. The adapters are keyless and reusable: construct the registry once and reuse it
 * across runs. No vendor SDK type crosses the seam — the return is `Record<ProviderId, LlmProvider>`.
 */
export function defaultProviders(): Readonly<Record<ProviderId, LlmProvider>> {
  return {
    anthropic: createAnthropicAdapter(),
    openai: createOpenAiAdapter(),
    deepseek: createOpenAiAdapter({ providerId: 'deepseek' }),
    gemini: createGeminiAdapter(),
  };
}

/**
 * Derive a provider's **protocol {@link ProviderKind}** from its id (ADR-0064 §2) — the pure axis that
 * selects, once per protocol rather than per provider, the adapter factory / list-models endpoint / auth /
 * response mapper. `anthropic` and `gemini` map 1:1; `openai` and `deepseek` share `openai-compatible`
 * (DeepSeek being the OpenAI-compatible adapter at a custom base URL). Exhaustive over the closed
 * `ProviderId` union (a new id is a compile error here), so the two stay in lock-step. Consumed by the
 * later ADR-0064 steps (the refresh service + the static/live merge); the id enum stays closed.
 */
export function providerKind(id: ProviderId): ProviderKind {
  switch (id) {
    case 'anthropic':
      return 'anthropic';
    case 'gemini':
      return 'gemini';
    case 'openai':
    case 'deepseek':
      return 'openai-compatible';
  }
}
