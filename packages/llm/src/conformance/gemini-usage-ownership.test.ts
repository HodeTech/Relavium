import { describe, expect, it, vi } from 'vitest';

import { createGeminiAdapter, type GeminiResponse } from '../adapters/gemini.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import type { LlmResult, StreamChunk, Usage } from '../types.js';

type Mode = 'generate' | 'stream';
const request = { model: 'gemini-2.5-flash', messages: [] };
const quantities = (input: number) => ({
  promptTokenCount: input,
  cachedContentTokenCount: 0,
  candidatesTokenCount: input === 0 ? 0 : 4,
  thoughtsTokenCount: 0,
});
const finalCandidate = { finishReason: 'STOP', content: { parts: [] } };

/** Supported injected transport controls; these do not claim SDK HTTP behavior. */
async function invoke(mode: Mode, frames: readonly GeminiResponse[]) {
  const first = frames[0];
  if (first === undefined) throw new Error('A native response is required');
  const records: AttemptRecord[] = [];
  const record = vi.fn((_model: string, usage: Usage) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicrocents: usage.inputTokens + usage.outputTokens,
    cumulativeCostMicrocents: usage.inputTokens + usage.outputTokens,
  }));
  const provider = createGeminiAdapter({
    transport: {
      generate: () => Promise.resolve(first),
      stream: () =>
        Promise.resolve({
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield* frames;
          },
        }),
      listModels: () => Promise.resolve([]),
      generateImages: () => Promise.reject(new Error('Unused image endpoint')),
      generateVideos: () => Promise.reject(new Error('Unused video endpoint')),
      pollVideo: () => Promise.reject(new Error('Unused poll endpoint')),
    },
  });
  const chain = new FallbackChain([{ provider, model: request.model, maxAttempts: 1 }], {
    keyFor: () => 'offline-usage-ownership',
    sleep: () => Promise.resolve(),
    onAttempt: (attempt) => records.push(attempt),
    costTracker: { record },
  });
  const chunks: StreamChunk[] = [];
  let result: LlmResult | undefined;
  let failure: { error: unknown } | undefined;
  try {
    if (mode === 'generate') result = await chain.generate(request);
    else for await (const chunk of chain.stream(request)) chunks.push(chunk);
  } catch (error) {
    failure = { error };
  }
  return { records, record, chunks, result, failure };
}

function expectComplete(call: Awaited<ReturnType<typeof invoke>>, input: number) {
  const output = input === 0 ? 0 : 4;
  expect(call.records).toHaveLength(1);
  expect(call.records[0]).toMatchObject({
    usage: { kind: 'complete', usage: { inputTokens: input, outputTokens: output } },
    cost: { costMicrocents: input + output },
  });
  expect(call.record).toHaveBeenCalledExactlyOnceWith(
    request.model,
    expect.objectContaining({ inputTokens: input, outputTokens: output }),
  );
}

function expectPartial(call: Awaited<ReturnType<typeof invoke>>, input: number) {
  expect(call.records).toHaveLength(1);
  expect(call.records[0]).toMatchObject({
    usage: {
      kind: 'partial',
      known: { inputTokens: input, outputTokens: input === 0 ? 0 : 4 },
    },
  });
  expect(call.records[0]).not.toHaveProperty('cost');
  expect(call.record).not.toHaveBeenCalled();
}

function expectSuccess(call: Awaited<ReturnType<typeof invoke>>, mode: Mode) {
  expect(call.failure).toBeUndefined();
  if (mode === 'generate') expect(call.result).toBeDefined();
  else expect(call.chunks.at(-1)?.type).toBe('stop');
}

function expectFailure(call: Awaited<ReturnType<typeof invoke>>, mode: Mode) {
  if (mode === 'generate') expect(call.failure).toBeDefined();
  else expect(call.chunks.at(-1)?.type).toBe('error');
}

describe('Gemini owns native quantities before transport getters resume', () => {
  for (const input of [0, 11]) {
    for (const mode of ['generate', 'stream'] as const) {
      it(`${mode}/${input}: reads native usage once`, async () => {
        let reads = 0;
        const usage = quantities(input);
        const call = await invoke(mode, [
          {
            get usageMetadata() {
              if (++reads > 1) throw new Error('Native usage was read twice');
              return usage;
            },
            candidates: [finalCandidate],
          },
        ]);
        expectSuccess(call, mode);
        expectComplete(call, input);
        expect(reads).toBe(1);
      });

      it(`${mode}/${input}: content failure retains complete observed usage`, async () => {
        const call = await invoke(mode, [
          {
            usageMetadata: quantities(input),
            candidates: [
              {
                finishReason: 'STOP',
                get content(): never {
                  throw new Error('Content projection failed');
                },
              },
            ],
          },
        ]);
        expectFailure(call, mode);
        expectComplete(call, input);
      });

      it(`${mode}/${input}: content mutation cannot change owned quantities`, async () => {
        const usage = quantities(input);
        let projections = 0;
        const call = await invoke(mode, [
          {
            usageMetadata: usage,
            candidates: [
              {
                finishReason: 'STOP',
                get content() {
                  projections++;
                  usage.promptTokenCount = 999;
                  usage.candidatesTokenCount = 999;
                  return { parts: [] };
                },
              },
            ],
          },
        ]);
        expectSuccess(call, mode);
        expectComplete(call, input);
        expect(projections).toBeGreaterThan(0);
      });

      it(`${mode}/${input}: ordinary final data prices once`, async () => {
        const call = await invoke(mode, [
          { usageMetadata: quantities(input), candidates: [finalCandidate] },
        ]);
        expectSuccess(call, mode);
        expectComplete(call, input);
      });

      it(`${mode}/${input}: current prompt block authorizes the same owned counts`, async () => {
        const call = await invoke(mode, [
          { usageMetadata: quantities(input), promptFeedback: { blockReason: 'SAFETY' } },
        ]);
        expectSuccess(call, mode);
        expectComplete(call, input);
        expect(mode === 'generate' ? call.result : call.chunks.at(-1)).toMatchObject({
          stopReason: 'content_filter',
        });
      });

      it(`${mode}/${input}: observed inline media demotes complete text counters`, async () => {
        const call = await invoke(mode, [
          {
            usageMetadata: quantities(input),
            candidates: [
              {
                finishReason: 'STOP',
                content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'YQ==' } }] },
              },
            ],
          },
        ]);
        expectSuccess(call, mode);
        expectPartial(call, input);
      });
    }

    for (const boundary of [
      'candidates',
      'finishReason',
      'promptFeedback',
      'blockReason',
    ] as const) {
      it(`stream/${input}: ${boundary} failure before authority retains only partial usage`, async () => {
        const fail = () => {
          throw new Error(`Native ${boundary} getter failed`);
        };
        const response: GeminiResponse = { usageMetadata: quantities(input) };
        if (boundary === 'candidates') Object.defineProperty(response, 'candidates', { get: fail });
        else if (boundary === 'finishReason')
          response.candidates = [
            {
              get finishReason() {
                return fail();
              },
            },
          ];
        else if (boundary === 'promptFeedback')
          Object.defineProperty(response, 'promptFeedback', { get: fail });
        else
          response.promptFeedback = {
            get blockReason() {
              return fail();
            },
          };
        const call = await invoke('stream', [response]);
        expectFailure(call, 'stream');
        expectPartial(call, input);
        expect(call.records[0]?.usage).toMatchObject({ reason: 'interrupted' });
      });
    }

    it(`stream/${input}: verified finish authority survives a later prompt getter failure`, async () => {
      const call = await invoke('stream', [
        {
          usageMetadata: quantities(input),
          candidates: [finalCandidate],
          get promptFeedback(): never {
            throw new Error('Prompt metadata failed after finish authority');
          },
        },
      ]);
      expectFailure(call, 'stream');
      expectComplete(call, input);
    });

    it(`stream/${input}: metadata getters read once cannot mutate the prior owned quantities`, async () => {
      const usage = quantities(input);
      const reads = { candidates: 0, finish: 0, prompt: 0, block: 0 };
      const touch = (field: keyof typeof reads) => {
        if (++reads[field] > 1) throw new Error(`Repeated ${field} metadata read`);
        usage.promptTokenCount = 999;
        usage.candidatesTokenCount = 999;
      };
      const call = await invoke('stream', [
        {
          usageMetadata: usage,
          get candidates() {
            touch('candidates');
            return [
              {
                get finishReason() {
                  touch('finish');
                  return 'STOP';
                },
                content: { parts: [] },
              },
            ];
          },
          get promptFeedback() {
            touch('prompt');
            return {
              get blockReason() {
                touch('block');
                return 'BLOCKED_REASON_UNSPECIFIED';
              },
            };
          },
        },
      ]);
      expectSuccess(call, 'stream');
      expectComplete(call, input);
      expect(reads).toEqual({ candidates: 1, finish: 1, prompt: 1, block: 1 });
    });

    for (const terminal of ['stop', 'block'] as const) {
      it(`stream/${input}: a later ${terminal} without usage cannot promote nonfinal counts`, async () => {
        const call = await invoke('stream', [
          { usageMetadata: quantities(input), candidates: [{ content: { parts: [] } }] },
          terminal === 'stop'
            ? { candidates: [finalCandidate] }
            : { promptFeedback: { blockReason: 'SAFETY' } },
        ]);
        expectSuccess(call, 'stream');
        expectPartial(call, input);
      });
    }

    it(`stream/${input}: final authority cannot invent an absent thought counter`, async () => {
      const { thoughtsTokenCount, ...incomplete } = quantities(input);
      void thoughtsTokenCount;
      const call = await invoke('stream', [
        { usageMetadata: incomplete, candidates: [finalCandidate] },
      ]);
      expectSuccess(call, 'stream');
      expect(call.records[0]?.usage).toMatchObject({
        kind: 'partial',
        known: { inputTokens: input, cacheReadTokens: 0 },
      });
      expect(call.record).not.toHaveBeenCalled();
    });

    it(`stream/${input}: prior verified terminal authority survives later metadata failure`, async () => {
      const call = await invoke('stream', [
        { candidates: [finalCandidate] },
        {
          usageMetadata: quantities(input),
          get candidates(): never {
            throw new Error('Later candidate metadata failed');
          },
        },
      ]);
      expectFailure(call, 'stream');
      expectComplete(call, input);
    });
  }
});
