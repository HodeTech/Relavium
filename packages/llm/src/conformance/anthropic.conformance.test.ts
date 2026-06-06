import { describe, expect, it } from 'vitest';

import { anthropicAdapter, createAnthropicAdapter } from '../adapters/anthropic.js';
import { ANTHROPIC_FIXTURES } from './fixtures/anthropic.js';
import { replayFetch } from './replay.js';
import { defineConformanceSuite, type MakeReplayAdapter } from './spec.js';

// Wire the Anthropic adapter to replay a recorded response — note: no vendor SDK is imported here;
// the adapter takes a `fetch` override, so the SDK stays inside src/adapters/* (the seam fence).
const makeReplayAdapter: MakeReplayAdapter = (recorded) =>
  createAnthropicAdapter({ fetch: replayFetch(recorded), maxRetries: 0 });

defineConformanceSuite('anthropic', makeReplayAdapter, ANTHROPIC_FIXTURES);

// Live nightly — runs only when ANTHROPIC_API_KEY is set; skipped in PR mode (testing.md). The
// nightly job records fresh fixtures and asserts the same canonical invariants against real endpoints.
const liveKey = process.env['ANTHROPIC_API_KEY'] ?? '';
describe('anthropic — conformance (live, nightly)', () => {
  it.skipIf(liveKey === '')('generate hits the real API and returns canonical text', async () => {
    const result = await anthropicAdapter.generate(
      {
        model: 'claude-haiku-4-5',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
