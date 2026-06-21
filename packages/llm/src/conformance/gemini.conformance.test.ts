import { describe, expect, it } from 'vitest';

import {
  createGeminiAdapter,
  geminiAdapter,
  type GeminiImageResponse,
  type GeminiResponse,
  type GeminiTransport,
} from '../adapters/gemini.js';
import { GEMINI_FIXTURES } from './fixtures/gemini.js';
import type { RecordedResponse } from './replay.js';
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
// GeminiImageResponse's only field (generatedImages) is optional; reject non-objects, arrays, and a
// present-but-non-array generatedImages so a malformed fixture fails the guard rather than the fold.
const isGeminiImageResponse = (value: unknown): value is GeminiImageResponse => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  if (!('generatedImages' in value)) {
    return true; // the only field is optional — an object without it is structurally valid
  }
  // `in`-narrowing reads the property with NO unsafe `as` cast and NO `any` (Reflect.get would return any).
  const gen: unknown = value.generatedImages;
  return gen === undefined || Array.isArray(gen);
};

// Gemini has no `fetch` hook, so the conformance harness replays at the transport level: a recorded
// SDK-output JSON (single response or an array of streamed responses) is parsed and served through a
// fake GeminiTransport — no vendor SDK is imported here.
const makeReplayAdapter: MakeReplayAdapter = (recorded) => {
  // One-shot scenarios pass a single RecordedResponse; the multi-turn tool loop passes a sequence served
  // by call index (turn 1 → recordings[0], turn 2 → recordings[1]).
  const recordings: readonly RecordedResponse[] = 'status' in recorded ? [recorded] : recorded;
  let call = 0;
  const nextRecording = (): RecordedResponse => {
    const next = recordings[call];
    call += 1;
    if (next === undefined) {
      throw new Error(`gemini replay: no recorded response for call #${String(call)}`);
    }
    return next;
  };
  const rejection = (status: number): Promise<never> =>
    Promise.reject(Object.assign(new Error('replayed gemini error'), { status }));
  const transport: GeminiTransport = {
    generate: () => {
      const current = nextRecording();
      if (current.status >= 400) return rejection(current.status);
      const parsed: unknown = JSON.parse(current.body);
      return isGeminiResponse(parsed)
        ? Promise.resolve(parsed)
        : Promise.reject(new Error('replay fixture is not a GeminiResponse object'));
    },
    stream: () => {
      const current = nextRecording();
      if (current.status >= 400) return rejection(current.status);
      const parsed: unknown = JSON.parse(current.body);
      return isGeminiResponseArray(parsed)
        ? Promise.resolve(toAsyncIterable(parsed))
        : Promise.reject(new Error('replay fixture is not a GeminiResponse[] array'));
    },
    generateImages: () => {
      const current = nextRecording();
      if (current.status >= 400) return rejection(current.status);
      const parsed: unknown = JSON.parse(current.body);
      return isGeminiImageResponse(parsed)
        ? Promise.resolve(parsed)
        : Promise.reject(new Error('replay fixture is not a GeminiImageResponse object'));
    },
    // The Veo async arm (1.AH A4) has no recorded-fixture conformance scenario yet; the seam contract is
    // covered by generative-seam.conformance.test.ts (stub) + the gemini.test.ts unit tests.
    generateVideos: () =>
      Promise.reject(new Error('veo not exercised by the chat conformance replay')),
    pollVideo: () => Promise.reject(new Error('veo not exercised by the chat conformance replay')),
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
        model: 'gemini-2.5-flash',
        maxTokens: 16,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
      },
      liveKey,
    );
    expect(result.content.some((part) => part.type === 'text')).toBe(true);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });
});
