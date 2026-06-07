import { describe, expect, it } from 'vitest';

import { createOpenAiAdapter, openaiAdapter } from '../adapters/openai.js';
import { OPENAI_FIXTURES } from './fixtures/openai.js';
import { replayFetch } from './replay.js';
import { defineConformanceSuite, type MakeReplayAdapter } from './spec.js';

// Wire the OpenAI adapter to replay a recorded response — no vendor SDK is imported here; the adapter
// takes a `fetch` override, so the SDK stays inside src/adapters/* (the seam fence).
const makeReplayAdapter: MakeReplayAdapter = (recorded) =>
  createOpenAiAdapter({ providerId: 'openai', fetch: replayFetch(recorded), maxRetries: 0 });

defineConformanceSuite('openai', makeReplayAdapter, OPENAI_FIXTURES);

// Live nightly — runs only when OPENAI_API_KEY is set; skipped in PR mode (testing.md).
const liveKey = process.env['OPENAI_API_KEY'] ?? '';
describe('openai — conformance (live, nightly)', () => {
  it.skipIf(liveKey === '')('generate hits the real API and returns canonical text', async () => {
    const result = await openaiAdapter.generate(
      {
        model: 'gpt-4o-mini',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
