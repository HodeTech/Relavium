import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGeminiAdapter } from '../adapters/gemini.js';
import type { LlmRequest, StreamChunk } from '../types.js';

const request: LlmRequest = {
  model: 'gemini-2.5-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'offline block control' }] }],
};
const completeUsage = {
  promptTokenCount: 4,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 0,
  thoughtsTokenCount: 0,
};
const block = { promptFeedback: { blockReason: 'SAFETY' } };
type Mode = 'generate' | 'stream';

/** Synthetic HTTP responses pass through the installed SDK and the default adapter transport. */
function mockHttp(frames: readonly unknown[], mode: Mode) {
  const body =
    mode === 'generate'
      ? JSON.stringify(frames[0])
      : frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(body, {
        headers: {
          'content-type': mode === 'generate' ? 'application/json' : 'text/event-stream',
        },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function response(mode: Mode, frames: readonly unknown[]) {
  const fetch = mockHttp(frames, mode);
  const adapter = createGeminiAdapter();
  if (mode === 'generate') {
    const result = await adapter.generate(request, 'offline-fixture');
    expect(fetch).toHaveBeenCalledTimes(1);
    return result;
  }
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.stream(request, 'offline-fixture')) chunks.push(chunk);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(chunks.filter((chunk) => chunk.type === 'stop' || chunk.type === 'error')).toHaveLength(1);
  return chunks.at(-1);
}

afterEach(() => vi.unstubAllGlobals());

describe('Gemini prompt block usage through the installed SDK HTTP boundary', () => {
  for (const mode of ['generate', 'stream'] as const) {
    for (const inputTokens of [0, 4]) {
      it(`${mode}: a current prompt block owns complete explicit input ${inputTokens}`, async () => {
        expect(
          await response(mode, [
            { ...block, usageMetadata: { ...completeUsage, promptTokenCount: inputTokens } },
          ]),
        ).toMatchObject({
          stopReason: 'content_filter',
          usage: {
            kind: 'complete',
            usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
          },
        });
      });
    }

    it(`${mode}: a same-frame candidate finish remains authoritative`, async () => {
      expect(
        await response(mode, [
          { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: completeUsage },
        ]),
      ).toMatchObject({
        stopReason: 'content_filter',
        usage: { kind: 'complete', usage: { inputTokens: 4, outputTokens: 0 } },
      });
    });

    it(`${mode}: an absent usage object remains missing`, async () => {
      expect(await response(mode, [block])).toMatchObject({
        stopReason: 'content_filter',
        usage: { kind: 'missing', reason: 'not_reported' },
      });
    });

    it(`${mode}: missing thinking usage remains partial`, async () => {
      expect(
        await response(mode, [
          {
            ...block,
            usageMetadata: {
              promptTokenCount: 4,
              cachedContentTokenCount: 0,
              candidatesTokenCount: 0,
            },
          },
        ]),
      ).toMatchObject({
        stopReason: 'content_filter',
        usage: {
          kind: 'partial',
          reason: 'missing_fields',
          known: { inputTokens: 4, cacheReadTokens: 0 },
        },
      });
    });

    it(`${mode}: an invalid candidate counter remains partial`, async () => {
      expect(
        await response(mode, [
          { ...block, usageMetadata: { ...completeUsage, candidatesTokenCount: -1 } },
        ]),
      ).toMatchObject({
        stopReason: 'content_filter',
        usage: { kind: 'partial', reason: 'invalid_fields', known: { inputTokens: 4 } },
      });
    });

    it(`${mode}: a contradictory cache split remains partial`, async () => {
      expect(
        await response(mode, [
          { ...block, usageMetadata: { ...completeUsage, cachedContentTokenCount: 9 } },
        ]),
      ).toMatchObject({
        stopReason: 'content_filter',
        usage: { kind: 'partial', reason: 'contradictory_fields', known: { outputTokens: 0 } },
      });
    });
  }

  it('stream: final blocked cumulative usage replaces earlier counters rather than adding them', async () => {
    expect(
      await response('stream', [
        { usageMetadata: { ...completeUsage, promptTokenCount: 2 } },
        { ...block, usageMetadata: completeUsage },
      ]),
    ).toMatchObject({
      type: 'stop',
      stopReason: 'content_filter',
      usage: { kind: 'complete', usage: { inputTokens: 4, outputTokens: 0 } },
    });
  });

  it('stream: prior content does not prevent current blocked usage from being final', async () => {
    expect(
      await response('stream', [
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'before block' }] } }],
          usageMetadata: { ...completeUsage, candidatesTokenCount: 1 },
        },
        { ...block, usageMetadata: { ...completeUsage, candidatesTokenCount: 1 } },
      ]),
    ).toMatchObject({
      type: 'stop',
      stopReason: 'content_filter',
      usage: { kind: 'complete', usage: { inputTokens: 4, outputTokens: 1 } },
    });
  });

  it('stream: a prior complete terminal stays complete when a later block omits usage', async () => {
    expect(
      await response('stream', [
        { candidates: [{ finishReason: 'STOP' }], usageMetadata: completeUsage },
        block,
      ]),
    ).toMatchObject({
      type: 'stop',
      stopReason: 'content_filter',
      usage: { kind: 'complete', usage: { inputTokens: 4, outputTokens: 0 } },
    });
  });

  it('stream: cumulative usage without final metadata stays interrupted', async () => {
    expect(await response('stream', [{ usageMetadata: completeUsage }, block])).toMatchObject({
      type: 'stop',
      stopReason: 'content_filter',
      usage: { kind: 'partial', reason: 'interrupted', known: { inputTokens: 4, outputTokens: 0 } },
    });
  });

  for (const promptFeedback of [undefined, { blockReason: 'BLOCKED_REASON_UNSPECIFIED' }]) {
    it(`stream: ${promptFeedback === undefined ? 'absent' : 'unspecified'} block is not a terminal`, async () => {
      expect(
        await response('stream', [{ promptFeedback, usageMetadata: completeUsage }]),
      ).toMatchObject({
        type: 'error',
        error: { kind: 'transport', usage: { kind: 'partial', reason: 'interrupted' } },
      });
    });
  }
});
