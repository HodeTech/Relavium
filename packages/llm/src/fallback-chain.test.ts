import { describe, expect, it } from 'vitest';

import { CostTracker } from './cost-tracker.js';
import {
  FallbackChain,
  stripReasoningParts,
  withFallback,
  type AttemptRecord,
  type FallbackChainOptions,
  type FallbackPlanEntry,
} from './fallback-chain.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import type {
  CapabilityFlags,
  LlmError,
  LlmErrorKind,
  LlmProvider,
  LlmRequest,
  LlmResult,
  ProviderId,
  StreamChunk,
  Usage,
} from './types.js';

// --- fakes & helpers -------------------------------------------------------------------------

/** A full CapabilityFlags with permissive defaults; only `tools`/`streaming` vary in these tests. */
function caps(overrides?: { tools?: boolean; streaming?: boolean }): CapabilityFlags {
  return {
    tools: overrides?.tools ?? true,
    streaming: overrides?.streaming ?? true,
    parallelToolCalls: false,
    vision: false, // === media.input.image (the refine pins them equal)
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: false, audio: false, video: false, document: false },
      outputCombinations: [],
    },
  };
}

interface FakeProvider {
  readonly provider: LlmProvider;
  /** The requests each generate/stream invocation received, in order. */
  readonly calls: LlmRequest[];
}

function makeProvider(opts: {
  id: ProviderId;
  supports?: { tools?: boolean; streaming?: boolean };
  generate?: (req: LlmRequest, key: string, call: number) => Promise<LlmResult>;
  stream?: (req: LlmRequest, key: string, call: number) => AsyncIterable<StreamChunk>;
}): FakeProvider {
  const calls: LlmRequest[] = [];
  let genCalls = 0;
  let streamCalls = 0;
  const provider: LlmProvider = {
    id: opts.id,
    supports: caps(opts.supports),
    generate(req, key) {
      calls.push(req);
      genCalls += 1;
      if (opts.generate === undefined) {
        throw new Error('generate stub not provided');
      }
      return opts.generate(req, key, genCalls);
    },
    stream(req, key) {
      calls.push(req);
      streamCalls += 1;
      if (opts.stream === undefined) {
        throw new Error('stream stub not provided');
      }
      return opts.stream(req, key, streamCalls);
    },
  };
  return { provider, calls };
}

function entry(fake: FakeProvider, model: string, maxAttempts = 1): FallbackPlanEntry {
  return { provider: fake.provider, model, maxAttempts };
}

const USAGE: Usage = { inputTokens: 1000, outputTokens: 500 };

function result(text: string, usage: Usage = USAGE): LlmResult {
  return { content: [{ type: 'text', text }], stopReason: 'stop', usage, raw: undefined };
}

function providerError(
  provider: ProviderId,
  kind: LlmErrorKind,
  message = 'boom',
): LlmProviderError {
  return new LlmProviderError(makeLlmError({ provider, kind, message }));
}

/** A generate stub that resolves a result (non-async to avoid an awaitless async function). */
const resolves = (text: string, usage?: Usage) => (): Promise<LlmResult> =>
  Promise.resolve(result(text, usage));

/** A generate stub that rejects with a classified `LlmProviderError` (the seam's generate contract). */
const rejects =
  (provider: ProviderId, kind: LlmErrorKind, message?: string) => (): Promise<LlmResult> =>
    Promise.reject(providerError(provider, kind, message));

async function* streamFrom(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  await Promise.resolve(); // a real stream awaits I/O; this keeps the fake a true async iterable
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** An async iterable that rejects on the first pull — models a `stream()` that fails before any chunk. */
function streamThrowing(error: LlmProviderError): AsyncIterable<StreamChunk> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<StreamChunk>> => Promise.reject(error),
    }),
  };
}

function errChunk(provider: ProviderId, kind: LlmErrorKind): StreamChunk {
  return { type: 'error', error: makeLlmError({ provider, kind, message: 'boom' }) };
}

const STOP_CHUNK: StreamChunk = { type: 'stop', stopReason: 'stop', usage: USAGE };

const userReq: LlmRequest = {
  model: 'incoming',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

/** Options with a recording no-op sleep + a recorder for the emitted attempt trace. */
function makeOptions(overrides?: Partial<FallbackChainOptions>): {
  options: FallbackChainOptions;
  trace: AttemptRecord[];
  sleeps: number[];
} {
  const trace: AttemptRecord[] = [];
  const sleeps: number[] = [];
  const options: FallbackChainOptions = {
    keyFor: () => 'test-key',
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    onAttempt: (record) => {
      trace.push(record);
    },
    ...overrides,
  };
  return { options, trace, sleeps };
}

/** Run a promise that should reject with an `LlmProviderError`, returning the carried `LlmError`. */
async function rejectedError(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LlmProviderError) {
      return err.llmError;
    }
    throw err;
  }
  throw new Error('expected the promise to reject with an LlmProviderError');
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

// --- construction ----------------------------------------------------------------------------

describe('FallbackChain construction', () => {
  it('rejects an empty plan (a wiring invariant)', () => {
    const { options } = makeOptions();
    expect(() => new FallbackChain([], options)).toThrowError(/at least one plan entry/);
  });

  it('rejects a plan entry with a non-positive maxAttempts (loud, not a silent skip)', () => {
    const provider = makeProvider({ id: 'anthropic', generate: resolves('x') });
    const { options } = makeOptions();
    expect(
      () => new FallbackChain([{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 0 }], options),
    ).toThrowError(/positive integer maxAttempts/);
  });
});

// --- generate: failover & classification -----------------------------------------------------

describe('FallbackChain.generate', () => {
  it('returns the primary result with no failover when the first attempt succeeds', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const out = await chain.generate(userReq);

    expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(0); // never reached
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      attemptNumber: 1,
      provider: 'anthropic',
      outcome: 'succeeded',
    });
  });

  it('fails over to the next provider on a retryable error, then succeeds', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('recovered') });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const out = await chain.generate(userReq);

    expect(out.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(primary.calls).toHaveLength(1);
    expect(fallback.calls).toHaveLength(1);
    expect(trace.map((r) => [r.provider, r.outcome])).toEqual([
      ['anthropic', 'failed'],
      ['openai', 'succeeded'],
    ]);
    expect(trace.map((r) => r.attemptNumber)).toEqual([1, 2]);
  });

  it('stops immediately on a fatal error and never reaches the fallback', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      generate: rejects('anthropic', 'content_filter'),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('content_filter');
    expect(err.retryable).toBe(false);
    expect(fallback.calls).toHaveLength(0); // fatal does not fall through
  });

  it('normalizes a non-LlmProviderError throw to a fatal `unknown` and stops', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      generate: () => Promise.reject(new TypeError('a bare programming error')),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('unknown');
    expect(fallback.calls).toHaveLength(0);
  });

  it('normalizes a non-Error thrown value to a fatal `unknown` with a generic message', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      generate: () => {
        // A provider that throws a non-Error value (not the seam contract, but the runner must
        // normalize it rather than leak it) — exercises the `#errorOf` fallback message.
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate non-Error throw
        throw 'a bare string failure'; // NOSONAR — the non-Error throw is exactly what this test exercises
      },
    });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('unknown');
    expect(err.message).toBe('unknown provider failure');
  });

  it('exhausts the chain and throws the last error when every entry fails retryably', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({ id: 'openai', generate: rejects('openai', 'timeout') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('timeout'); // the last attempt's classified error
    expect(err.provider).toBe('openai');
  });
});

// --- the failover decision is pure-on-discriminant -------------------------------------------

describe('FallbackChain.generate — pure-on-discriminant decision', () => {
  it('does not fail over on a successful result whose CONTENT looks like an error', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      generate: resolves('Error: this is a normal answer that mentions Error:'),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const out = await chain.generate(userReq);

    expect(out.content).toEqual([
      { type: 'text', text: 'Error: this is a normal answer that mentions Error:' },
    ]);
    expect(fallback.calls).toHaveLength(0); // content is never inspected
  });

  it('does not fail over on a fatal error whose MESSAGE looks transient', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      generate: rejects('anthropic', 'bad_request', 'Error: temporarily unavailable, retry'),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('bad_request'); // the discriminant, not the message, decides
    expect(fallback.calls).toHaveLength(0);
  });

  it('does not fail over on an empty/malformed result body (it is a success)', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      generate: () =>
        Promise.resolve({ content: [], stopReason: 'stop', usage: USAGE, raw: undefined }),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const out = await chain.generate(userReq);

    expect(out.content).toEqual([]); // an empty body is a result, not a failure
    expect(fallback.calls).toHaveLength(0); // body shape never triggers failover
  });
});

// --- cost accounting across a failover -------------------------------------------------------

describe('FallbackChain.generate — per-attempt cost across a failover', () => {
  it('records the winning attempt against ITS model and accumulates in the tracker', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({
      id: 'openai',
      generate: resolves('recovered', { inputTokens: 1000, outputTokens: 500 }),
    });
    const tracker = new CostTracker();
    tracker.record('claude-opus-4-8', { inputTokens: 1000, outputTokens: 500 }); // a prior turn → 1_750_000µ¢
    const { options, trace } = makeOptions({ costTracker: tracker });
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.4-mini')],
      options,
    );

    await chain.generate(userReq);

    // gpt-5.4-mini: 1000 in @ $0.75/MTok = 75_000µ¢; 500 out @ $4.50/MTok = 225_000µ¢ → 300_000.
    expect(trace[0]).toMatchObject({ outcome: 'failed' });
    expect(trace[0]?.cost).toBeUndefined(); // a failed attempt with no usage records no cost
    expect(trace[1]).toMatchObject({ outcome: 'succeeded' });
    expect(trace[1]?.cost?.costMicrocents).toBe(300_000); // THIS attempt, priced against gpt-5.4-mini
    // the running total threads the prior turn forward (not reset, not the single-attempt figure):
    expect(trace[1]?.cost?.cumulativeCostMicrocents).toBe(2_050_000); // 1_750_000 + 300_000
    expect(tracker.cumulativeCostMicrocents).toBe(2_050_000);
  });
});

// --- ADR-0030 reasoning strip on cross-provider failover -------------------------------------

describe('FallbackChain — ADR-0030 strip-on-failover', () => {
  const reqWithReasoning: LlmRequest = {
    model: 'incoming',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'solve it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking...', signature: 'sig-from-anthropic' },
          { type: 'text', text: 'partial' },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
  };

  it('strips reasoning parts (and signature) from the request sent to a DIFFERENT provider', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    await chain.generate(reqWithReasoning);

    const sentToFallback = fallback.calls[0];
    const parts = sentToFallback?.messages.flatMap((m) => m.content) ?? [];
    expect(parts.some((p) => p.type === 'reasoning')).toBe(false);
    // the surrounding non-reasoning content survives
    expect(parts.filter((p) => p.type === 'text')).toHaveLength(3);
    // the primary (originating provider) received the reasoning unchanged
    const sentToPrimary = primary.calls[0];
    const primaryParts = sentToPrimary?.messages.flatMap((m) => m.content) ?? [];
    expect(primaryParts.some((p) => p.type === 'reasoning')).toBe(true);
    // the caller's request is not mutated
    expect(reqWithReasoning.messages[1]?.content.some((p) => p.type === 'reasoning')).toBe(true);
  });

  it('keeps reasoning on a SAME-provider retry (only a provider boundary strips)', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      generate: (_req, _key, call) =>
        call === 1
          ? Promise.reject(providerError('anthropic', 'overloaded'))
          : Promise.resolve(result('ok')),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 2 }],
      options,
    );

    await chain.generate(reqWithReasoning);

    expect(provider.calls).toHaveLength(2);
    const secondCallParts = provider.calls[1]?.messages.flatMap((m) => m.content) ?? [];
    expect(secondCallParts.some((p) => p.type === 'reasoning')).toBe(true); // not stripped
  });
});

describe('stripReasoningParts', () => {
  it('drops reasoning parts, removes emptied messages, and does not mutate the input', () => {
    const req: LlmRequest = {
      model: 'm',
      messages: [
        { role: 'assistant', content: [{ type: 'reasoning', text: 't', signature: 's' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 't2' },
            { type: 'text', text: 'kept' },
          ],
        },
      ],
    };

    const out = stripReasoningParts(req);

    expect(out.messages).toHaveLength(1); // the reasoning-only message is dropped
    expect(out.messages[0]?.content).toEqual([{ type: 'text', text: 'kept' }]);
    expect(req.messages).toHaveLength(2); // input untouched
  });

  it('merges messages left adjacent and same-role after a reasoning-only drop (alternation stays valid)', () => {
    const req: LlmRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'think', signature: 's' }] }, // reasoning-only
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ],
    };

    const out = stripReasoningParts(req);

    // the assistant turn is dropped and the two now-adjacent user turns merge — no `[user, user]`
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
  });
});

// --- auth nuance: no blind retry + optional one-shot refresh ----------------------------------

describe('FallbackChain.generate — auth handling', () => {
  it('never re-attempts an auth failure on the same entry (no blind retry loop)', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'auth') });
    const { options } = makeOptions();
    // A generous budget — auth must still attempt exactly once.
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 5 }],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('auth');
    expect(provider.calls).toHaveLength(1); // one attempt, not five
  });

  it('grants exactly one extra attempt after a successful out-of-band credential refresh', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      generate: (_req, _key, call) =>
        call === 1
          ? Promise.reject(providerError('anthropic', 'auth'))
          : Promise.resolve(result('ok-after-refresh')),
    });
    let refreshCalls = 0;
    const { options } = makeOptions({
      onAuthError: () => {
        refreshCalls += 1;
        return true;
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options); // maxAttempts 1

    const out = await chain.generate(userReq);

    expect(out.content).toEqual([{ type: 'text', text: 'ok-after-refresh' }]);
    expect(refreshCalls).toBe(1);
    expect(provider.calls).toHaveLength(2); // the refresh bought one more attempt despite budget 1
  });

  it('refreshes at most once even when the granted retry also fails auth (no auth loop)', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      // auth on the original AND on the granted retry — the second must be fatal, not re-armed.
      generate: (_req, _key, call) =>
        call <= 2
          ? Promise.reject(providerError('anthropic', 'auth'))
          : Promise.resolve(result('never')),
    });
    let refreshCalls = 0;
    const { options } = makeOptions({
      onAuthError: () => {
        refreshCalls += 1;
        return true;
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options); // maxAttempts 1

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('auth');
    expect(refreshCalls).toBe(1); // the one-shot guard is not re-armed by the granted retry
    expect(provider.calls).toHaveLength(2); // one original + exactly one granted, then fatal (no third)
  });

  it('grants the auth retry ON TOP of the configured budget, not capping it', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      // attempt 1 auth (refresh → +1), attempt 2 overloaded; the remaining configured budget must survive.
      generate: (_req, _key, call) => {
        if (call === 1) return Promise.reject(providerError('anthropic', 'auth'));
        return Promise.reject(providerError('anthropic', 'overloaded'));
      },
    });
    const { options } = makeOptions({ onAuthError: () => true });
    // budget 3 + one auth bonus = 4 same-provider attempts before the chain exhausts.
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 3 }],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('overloaded');
    expect(provider.calls).toHaveLength(4); // 3 configured + 1 auth bonus — the budget was not truncated
  });

  it('is fatal when the credential refresh declines, and refreshes at most once per provider', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'auth') });
    let refreshCalls = 0;
    const { options } = makeOptions({
      onAuthError: () => {
        refreshCalls += 1;
        return false;
      },
    });
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 3 }],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('auth');
    expect(refreshCalls).toBe(1);
    expect(provider.calls).toHaveLength(1);
  });
});

// --- backoff + rate-limit cooldown -----------------------------------------------------------

describe('FallbackChain — backoff and cooldown', () => {
  it('exhausts the entry budget with exponential backoff between attempts, then advances', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options, sleeps } = makeOptions({ backoffBaseMs: 100, backoffMaxMs: 1000 });
    const chain = new FallbackChain(
      [{ ...entry(primary, 'claude-opus-4-8'), maxAttempts: 3 }, entry(fallback, 'gpt-5.5')],
      options,
    );

    await chain.generate(userReq);

    expect(primary.calls).toHaveLength(3); // exhausted the budget
    expect(sleeps).toEqual([100, 200]); // backoff before attempts 2 and 3, exponential, no inter-entry delay
  });

  it('respects the linear backoff curve and the ceiling', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'timeout') });
    const { options, sleeps } = makeOptions({ backoffBaseMs: 100, backoffMaxMs: 250 });
    const chain = new FallbackChain(
      [
        {
          provider: provider.provider,
          model: 'claude-opus-4-8',
          maxAttempts: 4,
          backoff: 'linear',
        },
      ],
      options,
    );

    await rejectedError(chain.generate(userReq));

    expect(sleeps).toEqual([100, 200, 250]); // linear 100/200/300 capped at 250
  });

  it('parks a rate-limited provider in cooldown so the next call skips it', async () => {
    let clock = 0;
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'rate_limit') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options, trace } = makeOptions({ now: () => clock, cooldownMs: 1000 });
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    await chain.generate(userReq); // call 1: primary rate-limits → cooldown → fallback wins
    expect(primary.calls).toHaveLength(1);

    trace.length = 0;
    await chain.generate(userReq); // call 2: still within cooldown → primary skipped
    expect(primary.calls).toHaveLength(1); // NOT hammered again
    expect(fallback.calls).toHaveLength(2);
    expect(trace[0]).toMatchObject({ provider: 'anthropic', outcome: 'skipped' });
    expect(trace[0]?.skipReason).toMatch(/cooldown/);

    trace.length = 0;
    clock = 2000; // cooldown elapsed
    await chain.generate(userReq); // call 3: primary retried again
    expect(primary.calls).toHaveLength(2);
  });
});

// --- capability skip -------------------------------------------------------------------------

describe('FallbackChain — capability skip', () => {
  it('skips a provider that cannot satisfy a required capability without consuming an attempt', async () => {
    const toolReq: LlmRequest = {
      ...userReq,
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    };
    const primary = makeProvider({
      id: 'gemini',
      supports: { tools: false },
      generate: resolves('unused'),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'gemini-2.5-pro'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const out = await chain.generate(toolReq);

    expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(primary.calls).toHaveLength(0); // skipped, never attempted
    expect(trace[0]).toMatchObject({ provider: 'gemini', outcome: 'skipped' });
    expect(trace[0]?.skipReason).toMatch(/capability/);
  });

  it('throws a synthesized error when every entry is skipped', async () => {
    const toolReq: LlmRequest = {
      ...userReq,
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    };
    const a = makeProvider({ id: 'gemini', supports: { tools: false }, generate: resolves('x') });
    const b = makeProvider({ id: 'deepseek', supports: { tools: false }, generate: resolves('x') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(a, 'gemini-2.5-pro'), entry(b, 'deepseek-chat')],
      options,
    );

    const err = await rejectedError(chain.generate(toolReq));

    expect(err.kind).toBe('unknown');
    expect(err.message).toMatch(/exhausted/);
  });
});

// --- abort -----------------------------------------------------------------------------------

describe('FallbackChain — cancellation', () => {
  it('treats an already-aborted signal as fatal and never attempts a provider', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(primary, 'claude-opus-4-8')], options);
    const aborted: LlmRequest = {
      ...userReq,
      signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
    };

    const err = await rejectedError(chain.generate(aborted));

    expect(err.kind).toBe('cancelled');
    expect(primary.calls).toHaveLength(0);
  });

  it('does not fail over when a provider reports cancellation', async () => {
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'cancelled') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('unused') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('cancelled');
    expect(fallback.calls).toHaveLength(0);
  });
});

// --- streaming -------------------------------------------------------------------------------

describe('FallbackChain.stream', () => {
  it('forwards a successful stream and records usage from the stop chunk', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'hello' }, STOP_CHUNK]),
    });
    const tracker = new CostTracker();
    const { options, trace } = makeOptions({ costTracker: tracker });
    const chain = new FallbackChain([entry(provider, 'claude-haiku-4-5')], options);

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([{ type: 'text_delta', text: 'hello' }, STOP_CHUNK]);
    expect(trace[0]).toMatchObject({ outcome: 'succeeded' });
    // claude-haiku-4-5: 1000 in @ $1/MTok = 100_000µ¢; 500 out @ $5/MTok = 250_000µ¢ → 350_000.
    expect(trace[0]?.cost?.costMicrocents).toBe(350_000);
  });

  it('records a content-free success with no usage when the stream omits a stop chunk', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'partial' }]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain([entry(provider, 'claude-haiku-4-5')], options);

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([{ type: 'text_delta', text: 'partial' }]);
    expect(trace[0]).toMatchObject({ outcome: 'succeeded' });
    expect(trace[0]?.usage).toBeUndefined();
    expect(trace[0]?.cost).toBeUndefined();
  });

  it('treats a content-free stop-only stream as a success (committed stays false)', async () => {
    const provider = makeProvider({ id: 'anthropic', stream: () => streamFrom([STOP_CHUNK]) });
    const { options, trace } = makeOptions({ costTracker: new CostTracker() });
    const chain = new FallbackChain([entry(provider, 'claude-haiku-4-5')], options);

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([STOP_CHUNK]);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ outcome: 'succeeded' });
    expect(trace[0]?.cost?.costMicrocents).toBe(350_000); // usage still came from the stop chunk
  });

  it('grants one extra stream attempt after an out-of-band credential refresh', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      stream: (_req, _key, call) =>
        call === 1
          ? streamFrom([errChunk('anthropic', 'auth')])
          : streamFrom([{ type: 'text_delta', text: 'ok-after-refresh' }, STOP_CHUNK]),
    });
    const { options } = makeOptions({ onAuthError: () => true });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options); // maxAttempts 1

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([{ type: 'text_delta', text: 'ok-after-refresh' }, STOP_CHUNK]);
    expect(provider.calls).toHaveLength(2); // refresh bought one more attempt despite budget 1
  });

  it('refreshes at most once on the stream path even when the granted retry fails auth', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      stream: (_req, _key, call) =>
        call <= 2
          ? streamFrom([errChunk('anthropic', 'auth')])
          : streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    let refreshCalls = 0;
    const { options } = makeOptions({
      onAuthError: () => {
        refreshCalls += 1;
        return true;
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toHaveLength(1);
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('auth');
    }
    expect(refreshCalls).toBe(1); // one-shot guard holds on the stream path too
    expect(provider.calls).toHaveLength(2); // one original + exactly one granted, then fatal
  });

  it('strips reasoning on a cross-provider stream failover (ADR-0030)', async () => {
    const reqWithReasoning: LlmRequest = {
      model: 'incoming',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'solve it' }] },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking...', signature: 'sig-from-anthropic' },
            { type: 'text', text: 'partial' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    };
    const primary = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'overloaded')]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'recovered' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    await collect(chain.stream(reqWithReasoning));

    const fallbackParts = fallback.calls[0]?.messages.flatMap((m) => m.content) ?? [];
    expect(fallbackParts.some((p) => p.type === 'reasoning')).toBe(false); // stripped on the boundary
    const primaryParts = primary.calls[0]?.messages.flatMap((m) => m.content) ?? [];
    expect(primaryParts.some((p) => p.type === 'reasoning')).toBe(true); // originator kept it
  });

  it('fails over transparently on a pre-content error chunk', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'overloaded')]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'recovered' }, STOP_CHUNK]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    // the consumer never sees the primary's error chunk — the failover is transparent
    expect(chunks).toEqual([{ type: 'text_delta', text: 'recovered' }, STOP_CHUNK]);
    expect(trace.map((r) => [r.provider, r.outcome])).toEqual([
      ['anthropic', 'failed'],
      ['openai', 'succeeded'],
    ]);
  });

  it('does NOT fail over after the first content chunk — it surfaces the error', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () =>
        streamFrom([
          { type: 'text_delta', text: 'partial output' },
          errChunk('anthropic', 'overloaded'),
        ]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([
      { type: 'text_delta', text: 'partial output' },
      errChunk('anthropic', 'overloaded'),
    ]);
    expect(fallback.calls).toHaveLength(0); // committed → no failover
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ provider: 'anthropic', outcome: 'failed' });
  });

  it('commits the stream on a non-text content chunk (tool_call_start), preventing failover', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () =>
        streamFrom([
          { type: 'tool_call_start', id: 'tc1', name: 'read_file' },
          errChunk('anthropic', 'overloaded'),
        ]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'tc1', name: 'read_file' },
      errChunk('anthropic', 'overloaded'),
    ]);
    expect(fallback.calls).toHaveLength(0); // a non-text content chunk commits → no failover
  });

  it('surfaces a post-content throw without failing over', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: async function* () {
        yield { type: 'text_delta', text: 'partial' } satisfies StreamChunk;
        await Promise.resolve();
        throw providerError('anthropic', 'transport');
      },
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'partial' });
    expect(chunks[1]?.type).toBe('error');
    expect(fallback.calls).toHaveLength(0);
  });

  it('fails over when the provider throws before any content (iterator creation)', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () => streamThrowing(providerError('anthropic', 'transport')),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'recovered' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toEqual([{ type: 'text_delta', text: 'recovered' }, STOP_CHUNK]);
  });

  it('stops on a fatal pre-content error and surfaces it as an error chunk', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'content_filter')]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: 'error' });
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('content_filter');
    }
    expect(fallback.calls).toHaveLength(0);
  });

  it('yields a synthesized error chunk when the chain is exhausted', async () => {
    const primary = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'overloaded')]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([errChunk('openai', 'rate_limit')]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toHaveLength(1);
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('rate_limit'); // the last attempt's error
    }
  });

  it('skips a non-streaming provider and yields the cancelled error when aborted', async () => {
    const nonStreaming = makeProvider({
      id: 'gemini',
      supports: { streaming: false },
      stream: () => streamFrom([STOP_CHUNK]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'ok' }, STOP_CHUNK]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(nonStreaming, 'gemini-2.5-pro'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));
    expect(chunks).toEqual([{ type: 'text_delta', text: 'ok' }, STOP_CHUNK]);
    expect(nonStreaming.calls).toHaveLength(0);
    expect(trace[0]).toMatchObject({ provider: 'gemini', outcome: 'skipped' });

    // and an already-aborted stream stops before any provider
    const aborted: LlmRequest = {
      ...userReq,
      signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
    };
    const abortedChunks = await collect(chain.stream(aborted));
    expect(abortedChunks).toHaveLength(1);
    if (abortedChunks[0]?.type === 'error') {
      expect(abortedChunks[0].error.kind).toBe('cancelled');
    }
  });

  it('yields a synthesized exhausted error when every stream entry is skipped', async () => {
    const a = makeProvider({
      id: 'gemini',
      supports: { streaming: false },
      stream: () => streamFrom([STOP_CHUNK]),
    });
    const b = makeProvider({
      id: 'deepseek',
      supports: { streaming: false },
      stream: () => streamFrom([STOP_CHUNK]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(a, 'gemini-2.5-pro'), entry(b, 'deepseek-chat')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(chunks).toHaveLength(1);
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('unknown');
      expect(chunks[0].error.message).toMatch(/exhausted/);
    }
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('stops with a cancelled chunk when aborted between stream attempts', async () => {
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'overloaded')]),
    });
    const { options } = makeOptions({
      sleep: () => {
        signal.aborted = true; // a caller abort lands during backoff, before the next attempt
        return Promise.resolve();
      },
    });
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 3 }],
      options,
    );

    const chunks = await collect(chain.stream({ ...userReq, signal }));

    expect(provider.calls).toHaveLength(1); // the second attempt is cancelled before it runs
    expect(chunks).toHaveLength(1);
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('cancelled');
    }
  });

  it('applies backoff and exhausts the budget on the streaming path too', async () => {
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([errChunk('anthropic', 'overloaded')]),
    });
    const { options, sleeps } = makeOptions({ backoffBaseMs: 100 });
    const chain = new FallbackChain(
      [{ ...entry(provider, 'claude-opus-4-8'), maxAttempts: 2 }],
      options,
    );

    await collect(chain.stream(userReq));

    expect(provider.calls).toHaveLength(2);
    expect(sleeps).toEqual([100]); // one backoff between the two attempts
  });
});

// --- withFallback façade ---------------------------------------------------------------------

describe('withFallback façade', () => {
  it('runs a single-shot generate and returns the result', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: resolves('facade') });
    const { options } = makeOptions();

    const out = await withFallback([entry(provider, 'claude-opus-4-8')], userReq, options);

    expect(out.content).toEqual([{ type: 'text', text: 'facade' }]);
  });
});
