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
