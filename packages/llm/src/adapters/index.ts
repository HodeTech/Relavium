/**
 * The `@relavium/llm/adapters` entry point — the **platform-coupled** zone where provider SDKs are
 * imported (the seam fence's one legal area). Kept separate from the seam barrel (`@relavium/llm`)
 * so the engine, which consumes only the `LlmProvider` seam and gets concrete adapters injected at
 * the surface, stays platform-free.
 */

export { anthropicAdapter, createAnthropicAdapter } from './anthropic.js';
export type { AnthropicAdapterDeps } from './anthropic.js';

export { openaiAdapter, deepseekAdapter, createOpenAiAdapter } from './openai.js';
export type { OpenAiAdapterDeps } from './openai.js';

export { geminiAdapter, createGeminiAdapter } from './gemini.js';
export type { GeminiAdapterDeps } from './gemini.js';
