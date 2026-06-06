/**
 * The `@relavium/llm/adapters` entry point — the **platform-coupled** zone where provider SDKs are
 * imported (the seam fence's one legal area). Kept separate from the seam barrel (`@relavium/llm`)
 * so the engine, which consumes only the `LlmProvider` seam and gets concrete adapters injected at
 * the surface, stays platform-free. The OpenAI/DeepSeek (1.G) and Gemini (1.H) adapters land here.
 */

export { anthropicAdapter, createAnthropicAdapter } from './anthropic.js';
export type { AnthropicAdapterDeps } from './anthropic.js';
