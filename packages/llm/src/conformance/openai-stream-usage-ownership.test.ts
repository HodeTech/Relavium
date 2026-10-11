import { describe, expect, it, vi } from 'vitest';

import { createOpenAiAdapter } from '../adapters/openai.js';
import type { ProviderFetch } from '../adapters/invocation-work.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import type { StreamChunk, Usage, UsageEvidence } from '../types.js';

type Provider = 'openai' | 'deepseek';
type Direction = 'input' | 'output';
const model = 'w8-openai-stream-usage-ownership';
const known = { inputTokens: 11, outputTokens: 4, cacheReadTokens: 0 };

function nativeUsage(
  provider: Provider,
  counts = { input: 11, output: 4 },
  audio?: { direction: Direction; units: number },
) {
  return {
    prompt_tokens: counts.input,
    completion_tokens: counts.output,
    prompt_tokens_details: {
      cached_tokens: 0,
      ...(audio?.direction === 'input' ? { audio_tokens: audio.units } : {}),
    },
    ...(audio?.direction === 'output'
      ? { completion_tokens_details: { audio_tokens: audio.units } }
      : {}),
    ...(provider === 'deepseek'
      ? { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: counts.input }
      : {}),
  };
}

function frame(usage: unknown, terminal: boolean) {
  return {
    id: 'owned-usage',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: terminal ? 'stop' : null }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Ordinary native HTTP/SSE passes through the installed SDK, never a native-chunk injection. */
async function run(provider: Provider, scenario: string, frames: readonly unknown[]) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn<ProviderFetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body: unknown = await request.json();
    requests.push({ method: request.method, path: new URL(request.url).pathname, body });
    return new Response(
      frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  // This recording hook tests complete-only pricing admission, not a provider invoice/rate.
  const record = vi.fn((_model: string, usage: Usage) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costMicrocents: usage.inputTokens + usage.outputTokens,
    cumulativeCostMicrocents: usage.inputTokens + usage.outputTokens,
  }));
  const attempts: AttemptRecord[] = [];
  const chain = new FallbackChain(
    [{ provider: createOpenAiAdapter({ providerId: provider, fetch }), model, maxAttempts: 1 }],
    {
      keyFor: () => 'offline-owned-usage',
      sleep: () => Promise.resolve(),
      costTracker: { record },
      onAttempt: (attempt) => attempts.push(attempt),
    },
  );
  const chunks: StreamChunk[] = [];
  const text = `${provider}/${scenario}`;
  for await (const chunk of chain.stream({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })) {
    chunks.push(chunk);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  // Each scenario sends its own native body; no canonical/native modality request supplies the axis.
  expect(requests).toEqual([
    {
      method: 'POST',
      path: provider === 'openai' ? '/v1/chat/completions' : '/chat/completions',
      body: {
        model,
        messages: [{ role: 'user', content: text }],
        stream: true,
        stream_options: { include_usage: true },
      },
    },
  ]);
  expect(attempts).toHaveLength(1);
  const attempt = attempts[0];
  if (attempt?.providerInvoked !== true) throw new Error('Expected one invoked attempt');
  return { attempt, record, chunks };
}

function expectOutcome(
  result: Awaited<ReturnType<typeof run>>,
  evidence: UsageEvidence,
  failed = false,
) {
  expect(result.attempt.usage).toEqual(evidence);
  expect(result.attempt.outcome).toBe(failed ? 'failed' : 'succeeded');
  expect(
    result.chunks.filter((chunk) => chunk.type === 'stop' || chunk.type === 'error'),
  ).toHaveLength(1);
  if (failed)
    expect(result.chunks.at(-1)).toMatchObject({ type: 'error', error: { usage: evidence } });
  else {
    expect(result.chunks.at(-1)).toMatchObject({ type: 'stop', usage: evidence });
  }
  if (evidence.kind === 'complete') {
    expect(result.record).toHaveBeenCalledExactlyOnceWith(model, evidence.usage);
    expect(result.attempt.cost).toEqual({
      inputTokens: evidence.usage.inputTokens,
      outputTokens: evidence.usage.outputTokens,
      costMicrocents: evidence.usage.inputTokens + evidence.usage.outputTokens,
      cumulativeCostMicrocents: evidence.usage.inputTokens + evidence.usage.outputTokens,
    });
  } else {
    expect(result.record).not.toHaveBeenCalled();
    expect(result.attempt.cost).toBeUndefined();
  }
}

describe('OpenAI-compatible stream usage ownership through installed SDK HTTP', () => {
  for (const provider of ['openai', 'deepseek'] as const) {
    it(`${provider}: a later usage-less finish cannot promote earlier nonfinal counts`, async () => {
      expectOutcome(
        await run(provider, 'nonfinal-then-finish', [
          frame(nativeUsage(provider), false),
          frame(undefined, true),
        ]),
        { kind: 'partial', known, reason: 'interrupted' },
      );
    });

    it(`${provider}: include_usage after finish carries complete final authority`, async () => {
      expectOutcome(
        await run(provider, 'finish-then-usage', [
          frame(undefined, true),
          { ...frame(nativeUsage(provider), false), choices: [] },
        ]),
        { kind: 'complete', usage: known },
      );
    });

    it(`${provider}: truncation retains exact nonfinal quantities without pricing them`, async () => {
      expectOutcome(
        await run(provider, 'truncated-nonfinal', [frame(nativeUsage(provider), false)]),
        { kind: 'partial', known, reason: 'interrupted' },
        true,
      );
    });

    it(`${provider}: a larger authoritative observation replaces earlier cumulative counts`, async () => {
      expectOutcome(
        await run(provider, 'larger-final', [
          frame(nativeUsage(provider, { input: 11, output: 1 }), false),
          frame(nativeUsage(provider), true),
        ]),
        { kind: 'complete', usage: known },
      );
    });

    it(`${provider}: a final complete observation survives a later native stream error`, async () => {
      expectOutcome(
        await run(provider, 'error-after-final', [
          frame(nativeUsage(provider), true),
          {
            error: { type: 'server_error', code: 'server_error', message: 'offline cleanup error' },
          },
        ]),
        { kind: 'complete', usage: known },
        true,
      );
    });

    for (const count of ['positive', 'zero'] as const) {
      it(`${provider}/${count}: ordinary explicit terminal usage prices exactly once`, async () => {
        const counts = count === 'zero' ? { input: 0, output: 0 } : { input: 11, output: 4 };
        expectOutcome(
          await run(provider, `ordinary-${count}`, [frame(nativeUsage(provider, counts), true)]),
          {
            kind: 'complete',
            usage: {
              inputTokens: counts.input,
              outputTokens: counts.output,
              cacheReadTokens: 0,
            },
          },
        );
      });
    }

    for (const shape of ['absent', 'null'] as const) {
      it(`${provider}/${shape} choices: malformed native content retains nonfinal known usage`, async () => {
        const { choices, ...rest } = frame(nativeUsage(provider), false);
        void choices;
        expectOutcome(
          await run(provider, `choices-${shape}`, [
            { ...rest, ...(shape === 'null' ? { choices: null } : {}) },
          ]),
          { kind: 'partial', known, reason: 'interrupted' },
          true,
        );
      });
    }

    for (const authority of ['current', 'earlier'] as const) {
      it(`${provider}/${authority} finish: verified authority survives malformed delta`, async () => {
        const malformed = {
          ...frame(nativeUsage(provider), false),
          choices: [
            { index: 0, delta: null, finish_reason: authority === 'current' ? 'stop' : null },
          ],
        };
        expectOutcome(
          await run(provider, `verified-${authority}-finish`, [
            ...(authority === 'earlier' ? [frame(undefined, true)] : []),
            malformed,
          ]),
          { kind: 'complete', usage: known },
          true,
        );
      });
    }

    for (const direction of ['input', 'output'] as const) {
      for (const units of [0, 2]) {
        for (const ending of ['omitted', 'repeated'] as const) {
          it(`${provider}/${direction}/${units}/${ending}: observed native audio stays applicable`, async () => {
            const audio = { direction, units };
            const quantities = {
              ...known,
              mediaUnits: [
                { modality: 'audio' as const, direction, units, unit: 'count' as const },
              ],
            };
            expectOutcome(
              await run(provider, `${direction}-${units}-${ending}`, [
                frame(nativeUsage(provider, undefined, audio), false),
                frame(
                  nativeUsage(provider, undefined, ending === 'repeated' ? audio : undefined),
                  true,
                ),
              ]),
              ending === 'repeated'
                ? { kind: 'complete', usage: quantities }
                : { kind: 'partial', known: quantities, reason: 'missing_fields' },
            );
          });
        }
      }

      for (const ending of ['omitted', 'repaired'] as const) {
        it(`${provider}/${direction}/invalid/${ending}: native field presence survives invalid units`, async () => {
          const quantities = {
            ...known,
            mediaUnits: [
              { modality: 'audio' as const, direction, units: 2, unit: 'count' as const },
            ],
          };
          expectOutcome(
            await run(provider, `${direction}-invalid-${ending}`, [
              frame(nativeUsage(provider, undefined, { direction, units: -1 }), false),
              frame(
                nativeUsage(
                  provider,
                  undefined,
                  ending === 'repaired' ? { direction, units: 2 } : undefined,
                ),
                true,
              ),
            ]),
            ending === 'repaired'
              ? { kind: 'complete', usage: quantities }
              : { kind: 'partial', known, reason: 'missing_fields' },
          );
        });
      }
    }
  }
});
