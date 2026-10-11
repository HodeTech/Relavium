import { describe, expect, it, vi } from 'vitest';

import { createOpenAiAdapter } from '../adapters/openai.js';
import type { ProviderFetch, ProviderFetchWorkOptions } from '../adapters/invocation-work.js';
import { CostTracker } from '../cost-tracker.js';
import { FallbackChain, type AttemptRecord } from '../fallback-chain.js';
import { LlmProviderError, makeLlmError } from '../llm-error.js';
import type { LlmResult, UsageEvidence } from '../types.js';

type Provider = 'openai' | 'deepseek';
type Entry = 'direct' | 'chain';
type Scenario = 'positive' | 'zero' | 'partial' | 'missing' | 'http400' | 'malformed-content';
const model = 'w8-openai-generate-cleanup';
const cleanupMessage = 'the provider attempt cleanup could not be completed';

function nativeUsage(provider: Provider, zero: boolean) {
  const input = zero ? 0 : 13;
  const output = zero ? 0 : 6;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    prompt_tokens_details: { cached_tokens: 0 },
    ...(provider === 'deepseek'
      ? { prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: input }
      : {}),
  };
}

function expectedEvidence(scenario: Scenario): UsageEvidence {
  if (scenario === 'partial')
    return { kind: 'partial', known: { outputTokens: 6 }, reason: 'missing_fields' };
  if (scenario === 'missing' || scenario === 'http400')
    return { kind: 'missing', reason: 'not_reported' };
  return {
    kind: 'complete',
    usage: {
      inputTokens: scenario === 'zero' ? 0 : 13,
      outputTokens: scenario === 'zero' ? 0 : 6,
      cacheReadTokens: 0,
    },
  };
}

/** Authored native HTTP bodies go through the installed SDK; no SDK iterator/getter is injected. */
function response(provider: Provider, scenario: Scenario): Response {
  return new Response(
    JSON.stringify(
      scenario === 'http400'
        ? {
            error: {
              message: 'ordinary offline invalid request',
              type: 'invalid_request_error',
              code: 'invalid_request_error',
              param: null,
            },
          }
        : {
            id: 'offline-generate-cleanup',
            object: 'chat.completion',
            created: 1,
            model,
            choices: [
              {
                index: 0,
                message:
                  scenario === 'malformed-content'
                    ? null
                    : { role: 'assistant', content: 'observed response' },
                finish_reason: 'stop',
              },
            ],
            ...(scenario === 'missing'
              ? {}
              : {
                  usage:
                    scenario === 'partial'
                      ? { completion_tokens: 6 }
                      : nativeUsage(provider, scenario === 'zero'),
                }),
          },
    ),
    {
      status: scenario === 'http400' ? 400 : 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

async function invoke(
  provider: Provider,
  entry: Entry,
  scenario: Scenario,
  cleanup?: { readonly cause: unknown },
) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const retained: Promise<unknown>[] = [];
  const listeners = new Set<() => void>();
  let removals = 0;
  const signal = {
    aborted: false,
    addEventListener: (_type: 'abort', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'abort', listener: () => void) => {
      listeners.delete(listener);
      removals++;
      if (cleanup !== undefined) throw cleanup.cause;
    },
  };
  let releaseChild: () => void = () => {};
  const child = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let transport: ProviderFetchWorkOptions | undefined;
  const fetch = vi.fn<ProviderFetch>(async (input, init, work) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const body: unknown = await request.json();
    requests.push({ method: request.method, path: new URL(request.url).pathname, body });
    transport = work;
    if (work === undefined) throw new Error('Expected retained actual SDK transport work');
    void work.retainWork(() => child);
    return response(provider, scenario);
  });
  const adapter = createOpenAiAdapter({ providerId: provider, fetch });
  const attempts: AttemptRecord[] = [];
  // Synthetic overlay: one microcent per token, so 13 + 6 costs exactly 19 microcents.
  // This checks production pricing arithmetic and once-only admission, not a provider invoice.
  const tracker = new CostTracker(
    new Map([
      [
        model,
        {
          provider,
          nativeId: model,
          displayName: 'Offline cleanup overlay',
          contextWindowTokens: 100_000,
          maxOutputTokens: 1_000,
          inputPerMtokMicrocents: 1_000_000,
          outputPerMtokMicrocents: 1_000_000,
          cachedInputPerMtokMicrocents: 1_000_000,
        },
      ],
    ]),
  );
  const record = vi.spyOn(tracker, 'record');
  const retainWork = <T>(factory: () => Promise<T>): Promise<T> => {
    const raw = factory();
    retained.push(raw);
    void raw.catch(() => undefined);
    return raw;
  };
  const req = {
    model,
    signal,
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'offline cleanup control' }],
      },
    ],
  };
  let result: LlmResult | undefined;
  let failure: { readonly error: unknown } | undefined;
  let adapterFailure: LlmProviderError | undefined;
  const providerWithObservation = {
    ...adapter,
    async generate(...args: Parameters<typeof adapter.generate>): Promise<LlmResult> {
      try {
        return await adapter.generate(...args);
      } catch (error) {
        if (error instanceof LlmProviderError) adapterFailure = error;
        throw error;
      }
    },
  };
  const chain = new FallbackChain([{ provider: providerWithObservation, model, maxAttempts: 2 }], {
    keyFor: () => 'offline-cleanup',
    sleep: () => Promise.resolve(),
    retainWork,
    costTracker: tracker,
    onAttempt: (attempt) => attempts.push(attempt),
  });
  try {
    result =
      entry === 'direct'
        ? await providerWithObservation.generate(req, 'offline-cleanup', { retainWork })
        : await chain.generate(req);
  } catch (error) {
    failure = { error };
  }
  try {
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      {
        method: 'POST',
        path: provider === 'openai' ? '/v1/chat/completions' : '/chat/completions',
        body: {
          model,
          messages: [{ role: 'user', content: 'offline cleanup control' }],
          stream: false,
        },
      },
    ]);
    expect(removals).toBe(entry === 'direct' ? 1 : 2);
    expect(listeners.size).toBe(0);
    if (transport === undefined) throw new Error('Expected transport invocation');
    expect(transport.signal.aborted).toBe(true);
    // Retired SDK work cannot claim positive completion while its admitted child still runs.
    let joined = false;
    const joining = Promise.allSettled(retained).then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    releaseChild();
    await joining;
    expect(joined).toBe(true);
  } finally {
    releaseChild();
    await Promise.allSettled(retained);
  }
  return { result, failure, adapterFailure, attempts, tracker, record };
}

function expectOutcome(
  call: Awaited<ReturnType<typeof invoke>>,
  provider: Provider,
  entry: Entry,
  scenario: Scenario,
  cleanup?: { readonly cause: unknown },
) {
  const evidence = expectedEvidence(scenario);
  const primary = scenario === 'http400' || scenario === 'malformed-content';
  if (primary || cleanup !== undefined) {
    expect(call.result).toBeUndefined();
    expect(call.failure?.error).toBeInstanceOf(LlmProviderError);
    if (!(call.failure?.error instanceof LlmProviderError))
      throw new Error('Expected normalized failure');
    const error = call.failure.error.llmError;
    expect(error.provider).toBe(provider);
    expect(error.retryable).toBe(false);
    if (scenario === 'http400') {
      expect(error).toMatchObject({
        kind: 'bad_request',
        status: 400,
        code: 'invalid_request_error',
      });
      expect(error.usage).toBeUndefined();
    } else {
      expect(error.usage).toEqual(evidence);
      expect(error.kind).toBe('unknown');
    }
    if (primary) {
      expect(call.adapterFailure).toBeDefined();
      expect(error.message).toBe(call.adapterFailure?.llmError.message);
      expect(error.cause).toBe(call.adapterFailure?.llmError.cause);
      if (entry === 'direct') expect(call.failure.error).toBe(call.adapterFailure);
      if (cleanup !== undefined) expect(error.cause).not.toBe(cleanup.cause);
      if (scenario === 'malformed-content') expect(error.message).not.toBe(cleanupMessage);
    } else {
      expect(error.message).toBe(cleanupMessage);
      expect(error.cause).toBe(cleanup?.cause);
      expect(error).not.toHaveProperty('status');
      expect(error).not.toHaveProperty('code');
      expect(error).not.toHaveProperty('retryAfterMs');
    }
  } else {
    expect(call.failure).toBeUndefined();
    expect(call.result).toMatchObject({
      content: [{ type: 'text', text: 'observed response' }],
      stopReason: 'stop',
      usage: evidence,
    });
  }
  if (entry === 'direct') {
    expect(call.attempts).toHaveLength(0);
    expect(call.record).not.toHaveBeenCalled();
    return;
  }
  expect(call.attempts).toHaveLength(1);
  expect(call.attempts[0]).toMatchObject({
    providerInvoked: true,
    outcome: primary || cleanup !== undefined ? 'failed' : 'succeeded',
    usage: evidence,
  });
  if (evidence.kind === 'complete') {
    const expectedMicrocents = scenario === 'zero' ? 0 : 19;
    expect(call.record).toHaveBeenCalledExactlyOnceWith(model, evidence.usage);
    expect(call.attempts[0]?.cost).toEqual({
      inputTokens: evidence.usage.inputTokens,
      outputTokens: evidence.usage.outputTokens,
      costMicrocents: expectedMicrocents,
      cumulativeCostMicrocents: expectedMicrocents,
    });
    expect(call.tracker.cumulativeCostMicrocents).toBe(expectedMicrocents);
  } else {
    expect(call.record).not.toHaveBeenCalled();
    expect(call.attempts[0]?.cost).toBeUndefined();
    expect(call.tracker.cumulativeCostMicrocents).toBe(0);
  }
}

describe('OpenAI-compatible generate cleanup through installed SDK HTTP', () => {
  for (const provider of ['openai', 'deepseek'] as const)
    for (const entry of ['direct', 'chain'] as const) {
      for (const scenario of [
        'positive',
        'zero',
        'partial',
        'missing',
        'http400',
        'malformed-content',
      ] as const)
        for (const fault of [false, true])
          it(`${provider}/${entry}/${scenario}: cleanup fault=${fault}`, async () => {
            const cleanup = fault ? { cause: new Error('private cleanup diagnostic') } : undefined;
            expectOutcome(
              await invoke(provider, entry, scenario, cleanup),
              provider,
              entry,
              scenario,
              cleanup,
            );
          });

      for (const shape of ['provider', 'budget'] as const)
        it(`${provider}/${entry}: ${shape}-shaped cleanup has no control authority`, async () => {
          const cleanup = {
            cause:
              shape === 'provider'
                ? new LlmProviderError(
                    makeLlmError({
                      provider,
                      kind: 'rate_limit',
                      message: 'private provider-shaped cleanup content',
                      status: 429,
                      retryAfterMs: 5,
                    }),
                  )
                : Object.assign(new Error('private budget-shaped cleanup content'), {
                    name: 'BudgetExceededError',
                    code: 'budget_exceeded',
                  }),
          };
          expectOutcome(
            await invoke(provider, entry, 'positive', cleanup),
            provider,
            entry,
            'positive',
            cleanup,
          );
        });
    }
});
