import { describe, expect, it } from 'vitest';

import {
  createGeminiAdapter,
  geminiAdapter,
  type GeminiResponse,
  type GeminiTransport,
} from '../adapters/gemini.js';
import { GEMINI_FIXTURES } from './fixtures/gemini.js';
import { defineConformanceSuite, type MakeReplayAdapter } from './spec.js';

async function* toAsyncIterable(items: readonly GeminiResponse[]): AsyncIterable<GeminiResponse> {
  await Promise.resolve(); // a streamed transport is async; this fake yields a recorded sequence
  for (const item of items) {
    yield item;
  }
}

// Validate the parsed fixture with a type guard rather than an unsafe `as` (CLAUDE.md): the fold reads
// every field defensively, so a structural object/array check is sufficient and fails loud on a
// malformed fixture.
const isGeminiResponse = (value: unknown): value is GeminiResponse =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isGeminiResponseArray = (value: unknown): value is GeminiResponse[] =>
  Array.isArray(value) && value.every(isGeminiResponse);

// Gemini has no `fetch` hook, so the conformance harness replays at the transport level: a recorded
// SDK-output JSON (single response or an array of streamed responses) is parsed and served through a
// fake GeminiTransport — no vendor SDK is imported here.
const makeReplayAdapter: MakeReplayAdapter = (recorded) => {
  const failure = recorded.status >= 400;
  const rejection = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('replayed gemini error'), { status: recorded.status }));
  const transport: GeminiTransport = {
    generate: () => {
      if (failure) return rejection();
      const parsed: unknown = JSON.parse(recorded.body);
      return isGeminiResponse(parsed)
        ? Promise.resolve(parsed)
        : Promise.reject(new Error('replay fixture is not a GeminiResponse object'));
    },
    stream: () => {
      if (failure) return rejection();
      const parsed: unknown = JSON.parse(recorded.body);
      return isGeminiResponseArray(parsed)
        ? Promise.resolve(toAsyncIterable(parsed))
        : Promise.reject(new Error('replay fixture is not a GeminiResponse[] array'));
    },
  };
  return createGeminiAdapter({ transport });
};

defineConformanceSuite('gemini', makeReplayAdapter, GEMINI_FIXTURES);

// Live nightly — runs only when GEMINI_API_KEY is set; skipped in PR mode (testing.md).
const liveKey = process.env['GEMINI_API_KEY'] ?? '';
describe('gemini — conformance (live, nightly)', () => {
  it.skipIf(liveKey === '')('generate hits the real API and returns canonical text', async () => {
    const result = await geminiAdapter.generate(
      {
        model: 'gemini-2.0-flash',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
