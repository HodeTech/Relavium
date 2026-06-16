import { describe, expect, it } from 'vitest';

import { createOpenAiAdapter, deepseekAdapter } from '../adapters/openai.js';
import { DEEPSEEK_FIXTURES } from './fixtures/deepseek.js';
import { replayFor } from './replay.js';
import { defineConformanceSuite, type MakeReplayAdapter } from './spec.js';

// DeepSeek is served by the SAME OpenAI-compatible adapter pointed at api.deepseek.com — same fold,
// distinct provider id + cache field. The fetch override keeps the SDK inside src/adapters/*. `replayFor`
// serves one body (one-shot scenarios) or a sequence (the multi-turn tool loop).
const makeReplayAdapter: MakeReplayAdapter = (recorded) =>
  createOpenAiAdapter({ providerId: 'deepseek', fetch: replayFor(recorded), maxRetries: 0 });

defineConformanceSuite('deepseek', makeReplayAdapter, DEEPSEEK_FIXTURES);

// Live nightly — runs only when DEEPSEEK_API_KEY is set; skipped in PR mode (testing.md).
const liveKey = process.env['DEEPSEEK_API_KEY'] ?? '';
describe('deepseek — conformance (live, nightly)', () => {
  it.skipIf(liveKey === '')('generate hits the real API and returns canonical text', async () => {
    const result = await deepseekAdapter.generate(
      {
        model: 'deepseek-chat',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
