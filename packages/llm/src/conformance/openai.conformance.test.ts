import { describe, expect, it } from 'vitest';

import { createOpenAiAdapter, openaiAdapter } from '../adapters/openai.js';
import { OPENAI_FIXTURES } from './fixtures/openai.js';
import { replayFor } from './replay.js';
import { defineConformanceSuite, type MakeReplayAdapter } from './spec.js';

// Wire the OpenAI adapter to replay recorded response(s) — no vendor SDK is imported here; the adapter
// takes a `fetch` override, so the SDK stays inside src/adapters/* (the seam fence). `replayFor` serves
// one body (one-shot scenarios) or a sequence (the multi-turn tool loop).
const makeReplayAdapter: MakeReplayAdapter = (recorded) =>
  createOpenAiAdapter({ providerId: 'openai', fetch: replayFor(recorded), maxRetries: 0 });

defineConformanceSuite('openai', makeReplayAdapter, OPENAI_FIXTURES);

// Live nightly — runs only when OPENAI_API_KEY is set; skipped in PR mode (testing.md).
const liveKey = process.env['OPENAI_API_KEY'] ?? '';
describe('openai — conformance (live, nightly)', () => {
  it.skipIf(liveKey === '')('generate hits the real API and returns canonical text', async () => {
    const result = await openaiAdapter.generate(
      {
        model: 'gpt-5.4-mini',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
