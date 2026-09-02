import type { AbortSignalLike } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import type { AbortControllerLike } from './attempt-deadline.js';
import { CostTracker } from './cost-tracker.js';
import {
  FallbackChain,
  stripReasoningParts,
  withEntryModel,
  withFallback,
  type AttemptRecord,
  type FallbackChainOptions,
  type FallbackPlanEntry,
} from './fallback-chain.js';
import { UnknownModelError } from './errors.js';
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
  /** A full capability override (e.g. a media-capable provider for the egress re-materialization tests). */
  capabilities?: CapabilityFlags;
  generate?: (req: LlmRequest, key: string, call: number) => Promise<LlmResult>;
  stream?: (req: LlmRequest, key: string, call: number) => AsyncIterable<StreamChunk>;
}): FakeProvider {
  const calls: LlmRequest[] = [];
  let genCalls = 0;
  let streamCalls = 0;
  const provider: LlmProvider = {
    id: opts.id,
    supports: opts.capabilities ?? caps(opts.supports),
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

/** A rejecting stub whose `LlmError` carries the provider's own requested wait (#279). */
const rejectsWithRetryAfter =
  (provider: ProviderId, retryAfterMs: number) => (): Promise<LlmResult> =>
    Promise.reject(
      new LlmProviderError(
        makeLlmError({ provider, kind: 'rate_limit', message: 'rl', retryAfterMs }),
      ),
    );

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

/**
 * The same chunk as {@link errChunk}, stamped as having happened past the first content chunk
 * ([ADR-0082](../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §4).
 *
 * The chain sets this when it SURFACES a failure rather than failing over, so the node-retry budget above it
 * can refuse to re-dispatch. A separate helper, not a flag on `errChunk`, so a test that means "committed"
 * has to say so.
 */
function committedErrChunk(provider: ProviderId, kind: LlmErrorKind): StreamChunk {
  return {
    type: 'error',
    error: { ...makeLlmError({ provider, kind, message: 'boom' }), contentCommitted: true },
  };
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
  sleepSignals: (AbortSignalLike | undefined)[];
} {
  const trace: AttemptRecord[] = [];
  const sleeps: number[] = [];
  const sleepSignals: (AbortSignalLike | undefined)[] = [];
  const options: FallbackChainOptions = {
    keyFor: () => 'test-key',
    sleep: (ms, signal) => {
      sleeps.push(ms);
      sleepSignals.push(signal);
      return Promise.resolve();
    },
    onAttempt: (record) => {
      trace.push(record);
    },
    ...overrides,
  };
  return { options, trace, sleeps, sleepSignals };
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

/** The recorded request at `index`, with a checked access (no `as LlmRequest` cast). */
function reqAt(calls: readonly LlmRequest[], index: number): LlmRequest {
  const req = calls[index];
  if (req === undefined) {
    throw new Error(`expected a recorded request at index ${index}`);
  }
  return req;
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

  it('preAttempt carries THIS attempt’s routing provider — the primary, then the failover (review M2)', async () => {
    // The pre-egress endpoint estimate keys on the routing provider, which MOVES on a failover. Each preAttempt
    // must therefore report the provider of the entry actually being dialed, not a fixed primary.
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('recovered') });
    const seen: { model: string; provider: ProviderId }[] = [];
    const { options } = makeOptions({
      preAttempt: (info) => {
        seen.push({ model: info.model, provider: info.provider });
      },
    });
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt-5.4-mini')],
      options,
    );

    await chain.generate(userReq);

    expect(seen).toEqual([
      { model: 'claude-opus-4-8', provider: 'anthropic' },
      { model: 'gpt-5.4-mini', provider: 'openai' },
    ]);
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

  it('keeps reasoning for a same-provider entry after an intervening provider is skipped', async () => {
    // [anthropic, openai(skipped, lacks tools), anthropic] — the skipped openai entry must NOT count
    // as a provider boundary, or the third (same-provider) entry would wrongly lose its reasoning.
    const toolReq: LlmRequest = {
      ...reqWithReasoning,
      tools: [{ name: 'read_file', parameters: { type: 'object' } }],
    };
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'overloaded') });
    const skipped = makeProvider({
      id: 'openai',
      supports: { tools: false },
      generate: resolves('x'),
    });
    const sameProvider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [
        entry(primary, 'claude-opus-4-8'),
        entry(skipped, 'gpt-5.5'),
        entry(sameProvider, 'claude-haiku-4-5'),
      ],
      options,
    );

    await chain.generate(toolReq);

    expect(skipped.calls).toHaveLength(0); // openai skipped (no tools)
    const parts = sameProvider.calls[0]?.messages.flatMap((m) => m.content) ?? [];
    expect(parts.some((p) => p.type === 'reasoning')).toBe(true); // same provider → reasoning kept
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

describe('withEntryModel (ADR-0066 §4 — per-fallback-entry reasoning gate)', () => {
  it('STRIPS a reasoning-effort tier for a fallback entry model that does not reason', () => {
    const req: LlmRequest = {
      model: 'o1',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    };
    // Failover to a non-reasoning model (gpt-4o) must NOT carry the tier — the provider would 400-reject it, and a
    // fatal unsupported-parameter error would abort the whole remaining chain.
    const out = withEntryModel(req, 'gpt-4o');
    expect(out.model).toBe('gpt-4o');
    expect('reasoningEffort' in out).toBe(false);
    expect(req.reasoningEffort).toBe('high'); // input untouched
  });

  it('KEEPS the tier for a fallback entry model that DOES reason', () => {
    const req: LlmRequest = {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'max',
    };
    const out = withEntryModel(req, 'gpt-5.5'); // a reasoning model ⇒ the tier rides
    expect(out.model).toBe('gpt-5.5');
    expect(out.reasoningEffort).toBe('max');
  });

  /**
   * THE FAILOVER HOLE (ADR-0071 §6) — found by an adversarial review, and the sharpest finding in it.
   *
   * The re-gate used to ask `modelSupportsReasoning(model)`: a BOOLEAN. `gpt-5.5` accepts every tier; `gpt-5.4-pro`
   * rejects `low` outright (it publishes ['medium','high','xhigh']). Both "support reasoning", so the boolean kept
   * the tier — and the fallback, whose entire job is to RESCUE a failing turn, put a rejected value on the wire.
   *
   * A 400 on an unsupported parameter is fatal and non-retryable. So the rescue does not merely fail: it ABORTS
   * the rest of the chain, killing the turn it exists to save. The gate now re-checks the tiers the entry model
   * actually accepts.
   */
  it('STRIPS a tier the fallback model REJECTS — even though that model reasons', () => {
    const req: LlmRequest = {
      model: 'gpt-5.5', // accepts low
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'low',
    };
    // gpt-5.4-pro's ladder starts at `medium`, and OpenAI has no budget field to express `low` some other way.
    const out = withEntryModel(req, 'gpt-5.4-pro');
    expect(out.model).toBe('gpt-5.4-pro');
    expect('reasoningEffort' in out).toBe(false);
  });

  /**
   * …but STRIPPING IS NOT FREE, so it must not happen when the model can serve the tier by another route.
   *
   * `claude-opus-4-5` publishes an effort ladder WITHOUT `max` — and, alongside it, a token budget. Its adapter
   * already falls back to `thinking.budget_tokens` for exactly this case, so `max` is perfectly serviceable. An
   * earlier version of `acceptedTiers` treated the two axes as an either/or and reported the ladder only: the
   * rescue turn then ran with NO reasoning at all, discarding what the user asked for more aggressively than the
   * model required. The axes are a union.
   */
  it('KEEPS a tier the fallback model serves through its BUDGET axis, not its ladder', () => {
    const req: LlmRequest = {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'max',
    };
    const out = withEntryModel(req, 'claude-opus-4-5');
    expect(out.model).toBe('claude-opus-4-5');
    expect(out.reasoningEffort).toBe('max');
  });

  it("STRIPS `low` on a failover to gpt-5.4-pro — the maintainer's bug, reached through the rescue path", () => {
    const req: LlmRequest = {
      model: 'gpt-5.5', // accepts all five
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'low',
    };
    const out = withEntryModel(req, 'gpt-5.4-pro'); // publishes ['medium','high','xhigh'] — no `low`
    expect('reasoningEffort' in out).toBe(false);
  });

  it('STRIPS the tier for a model the catalog does not know (a custom endpoint)', () => {
    const req: LlmRequest = {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    };
    expect('reasoningEffort' in withEntryModel(req, 'some-custom-endpoint-model')).toBe(false);
  });

  it('KEEPS a tier the fallback model DOES accept', () => {
    const req: LlmRequest = {
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    };
    expect(withEntryModel(req, 'gpt-5.4-pro').reasoningEffort).toBe('high'); // `high` IS in its ladder
  });

  it('is a plain model swap when no tier is set', () => {
    const req: LlmRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(withEntryModel(req, 'claude-sonnet-4-6')).toEqual({
      ...req,
      model: 'claude-sonnet-4-6',
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

  it('treats a throwing credential-refresh hook as a declined refresh (fatal, contract intact)', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'auth') });
    const { options } = makeOptions({
      onAuthError: () => {
        throw new Error('the host hook blew up');
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    const err = await rejectedError(chain.generate(userReq));

    expect(err.kind).toBe('auth'); // the ORIGINAL auth error surfaces, not the hook's throw
    expect(provider.calls).toHaveLength(1); // a failed refresh grants no extra attempt
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

  it('records an unpriced model as priced:false rather than silently as no cost (#194, 2.6.Q)', async () => {
    // "No cost" used to be ambiguous between *could not price* and *genuinely free*. A strict cap cannot be
    // enforced over spend it cannot see, so the surface has to be able to say which one happened.
    const provider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options, trace } = makeOptions({
      costTracker: {
        record: () => {
          throw new UnknownModelError('self-hosted-model', ['claude-opus-4-8']);
        },
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain([entry(provider, 'self-hosted-model')], options);

    await chain.generate(userReq);

    const succeeded = trace.find((r) => r.outcome === 'succeeded');
    expect(succeeded?.priced).toBe(false);
    expect(succeeded?.cost).toBeUndefined();
  });

  it('records an unpriced MODALITY as priced:false too, on a model that IS priced (ADR-0089 §4)', async () => {
    // The sibling of the test above, and the half `CR-55` was about. Here nothing throws: the model prices
    // fine, the tokens are costed correctly, and a produced image the model has no rate for contributes
    // nothing — so `costMicrocents` is a FLOOR, not the charge. A reader asking "is this figure the charge?"
    // gets the same answer as for an unpriced model, so it gets the same flag.
    const provider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options, trace } = makeOptions({
      costTracker: {
        record: () => ({
          inputTokens: 10,
          outputTokens: 5,
          costMicrocents: 42,
          cumulativeCostMicrocents: 42,
          unpricedModalities: ['image'] as const,
        }),
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    await chain.generate(userReq);

    const succeeded = trace.find((r) => r.outcome === 'succeeded');
    expect(succeeded?.priced).toBe(false);
    // …and unlike the unpriced-MODEL case, the priced part is still recorded: the cap keeps working on what
    // could be priced rather than being abandoned for the whole call.
    expect(succeeded?.cost?.costMicrocents).toBe(42);
  });

  it('leaves `priced` absent when nothing was unpriced — the flag means something only if it is rare', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options, trace } = makeOptions({
      costTracker: {
        record: () => ({
          inputTokens: 10,
          outputTokens: 5,
          costMicrocents: 42,
          cumulativeCostMicrocents: 42,
        }),
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    await chain.generate(userReq);

    expect(trace.find((r) => r.outcome === 'succeeded')?.priced).toBeUndefined();
  });

  it('does NOT swallow a non-pricing failure from the cost tracker (#194)', async () => {
    // The catch used to be bare, so a genuine defect in the money path — a bad Usage, a broken overlay, a
    // throwing custom tracker — produced "no cost" and looked exactly like an unpriced model.
    const provider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options } = makeOptions({
      costTracker: {
        record: () => {
          throw new TypeError('cumulative overflowed');
        },
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    await expect(chain.generate(userReq)).rejects.toThrow('cumulative overflowed');
  });

  it('a cancel landing in the preAttempt gap does not wait for the provider deadline (generate)', async () => {
    // The reachable gap: the loop checks cancellation, then `preAttempt` and credential resolution run, and
    // only THEN is the deadline opened. A cancel landing in between reaches `openDeadline` already-aborted —
    // which used to leave the hard race with nothing to observe, so an uncooperative provider held the call
    // until the absolute timer. This test would hang for the shipped 120 s default without the caller latch.
    const controller = new AbortController();
    const primary = makeProvider({
      id: 'anthropic',
      generate: () => new Promise<never>(() => undefined), // ignores its signal entirely
    });
    const { options } = makeOptions({
      preAttempt: () => {
        controller.abort(); // the user pressed Ctrl-C exactly here
        return Promise.resolve();
      },
    });
    // The deadline port MUST be wired, or `#openDeadline` returns undefined and the chain plain-`await`s a
    // provider that never settles — a hang with no deadline in it at all, which is a different bug. The
    // timer here is never fired: settling proves the CALLER latch woke the race, not the clock.
    const deadlinePort = {
      newAbortController: (): AbortControllerLike => {
        let aborted = false;
        const listeners = new Set<() => void>();
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: (_t: string, l: () => void) => listeners.add(l),
            removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
          },
          abort: () => {
            if (aborted) return;
            aborted = true;
            for (const l of [...listeners]) l();
          },
        };
      },
      setTimer: () => () => undefined, // armed, never fired
    };
    const chain = new FallbackChain([entry(primary, 'claude-opus-4-8')], {
      ...options,
      ...deadlinePort,
    });

    const error = await rejectedError(chain.generate({ ...userReq, signal: controller.signal }));
    expect(error.kind).toBe('cancelled');
  });

  it('…and the same gap on the STREAM path', async () => {
    // Both paths open their own deadline, so both need the latch. The stream path is the one a user is most
    // likely to cancel, because it is the one they are watching.
    const controller = new AbortController();
    const primary = makeProvider({
      id: 'anthropic',
      // A hand-rolled iterator rather than a generator: an `async function*` with no `yield` is a lint
      // error, and the point is precisely that `next()` never settles.
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
      }),
    });
    const { options } = makeOptions({
      preAttempt: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    // The deadline port MUST be wired, or `#openDeadline` returns undefined and the chain plain-`await`s a
    // provider that never settles — a hang with no deadline in it at all, which is a different bug. The
    // timer here is never fired: settling proves the CALLER latch woke the race, not the clock.
    const deadlinePort = {
      newAbortController: (): AbortControllerLike => {
        let aborted = false;
        const listeners = new Set<() => void>();
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: (_t: string, l: () => void) => listeners.add(l),
            removeEventListener: (_t: string, l: () => void) => listeners.delete(l),
          },
          abort: () => {
            if (aborted) return;
            aborted = true;
            for (const l of [...listeners]) l();
          },
        };
      },
      setTimer: () => () => undefined, // armed, never fired
    };
    const chain = new FallbackChain([entry(primary, 'claude-opus-4-8')], {
      ...options,
      ...deadlinePort,
    });

    const chunks = await collect(chain.stream({ ...userReq, signal: controller.signal }));
    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    expect(last?.type === 'error' ? last.error.kind : undefined).toBe('cancelled');
  });

  it("threads the request's signal into the host timer, so a cancel can break the wait (#W15-14)", async () => {
    // The honoured Retry-After is clamped to a 60 s ceiling, not dropped — long enough that a cancel arriving
    // mid-wait has to be honoured. The chain passed the delay to a bare timer with no signal, so it could not.
    const primary = makeProvider({
      id: 'anthropic',
      generate: rejectsWithRetryAfter('anthropic', 1_500),
    });
    const { options, sleeps, sleepSignals } = makeOptions();
    const chain = new FallbackChain(
      [{ ...entry(primary, 'claude-opus-4-8'), maxAttempts: 2 }],
      options,
    );
    const controller = new AbortController();

    await rejectedError(chain.generate({ ...userReq, signal: controller.signal }));

    expect(sleeps).toEqual([1_500]);
    expect(sleepSignals).toEqual([controller.signal]);
  });

  it("honours the provider's Retry-After over its own computed backoff (#279)", async () => {
    // A rate limit is the one case where the provider knows better than we do: it says when its window
    // reopens. Computing our own delay either hammered it early or waited longer than needed.
    const primary = makeProvider({
      id: 'anthropic',
      generate: rejectsWithRetryAfter('anthropic', 1_500),
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options, sleeps } = makeOptions({ backoffBaseMs: 100, backoffMaxMs: 1000 });
    const chain = new FallbackChain(
      [{ ...entry(primary, 'claude-opus-4-8'), maxAttempts: 3 }, entry(fallback, 'gpt-5.5')],
      options,
    );

    await chain.generate(userReq);

    // 1500 twice — the header, NOT the 100/200 exponential curve this config would otherwise produce.
    expect(sleeps).toEqual([1_500, 1_500]);
  });

  it('falls back to its own curve when the provider requested nothing (#279)', async () => {
    // `undefined` must mean "no instruction", never "wait zero" — otherwise a provider that omits the
    // header would turn the backoff into a tight retry loop.
    const primary = makeProvider({ id: 'anthropic', generate: rejects('anthropic', 'rate_limit') });
    const fallback = makeProvider({ id: 'openai', generate: resolves('ok') });
    const { options, sleeps } = makeOptions({ backoffBaseMs: 100, backoffMaxMs: 1000 });
    const chain = new FallbackChain(
      [{ ...entry(primary, 'claude-opus-4-8'), maxAttempts: 3 }, entry(fallback, 'gpt-5.5')],
      options,
    );

    await chain.generate(userReq);

    expect(sleeps).toEqual([100, 200]);
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

  it('surfaces an accounting throw as an error chunk instead of throwing out of the generator (#W15-9)', async () => {
    // `#emitSuccess` re-throws anything that is not `UnknownModelError` so a money bug is loud (#194) — a
    // provider returning non-integer usage trips `assertAccountableUsage`, a broken overlay or a custom
    // tracker throws. On the `generate()` path that call sits inside the attempt's try, so the throw arrives
    // classified. On this path it sat OUTSIDE, and escaped raw — breaking `stream`'s own contract ("a terminal
    // failure is surfaced as an `error` chunk, not a throw") and crashing the turn unclassified AFTER the
    // content had been produced and the provider had billed for it.
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'hello' }, STOP_CHUNK]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const thrown = new TypeError('cumulative overflowed');
    const { options, trace } = makeOptions({
      costTracker: {
        record: () => {
          throw thrown;
        },
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain(
      [entry(provider, 'claude-haiku-4-5'), entry(fallback, 'gpt-5.5')],
      options,
    );

    // Does not reject: `collect` would propagate a raw throw.
    const chunks = await collect(chain.stream(userReq));

    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    // A FIXED message: the raw text is arbitrary (a custom tracker's throw) and this message is serialized
    // into the turn/node terminal, so it must not echo it. The original survives as `cause`, which no sink
    // serializes.
    expect(last?.type === 'error' && last.error.message).toBe(
      'cost accounting failed after a successful streamed attempt',
    );
    expect(JSON.stringify(last)).not.toContain('cumulative overflowed');
    expect(last?.type === 'error' && last.error.cause).toBe(thrown);
    expect(last?.type === 'error' && last.error.retryable).toBe(false); // never re-run a billed call
    // Still LOUD: the content chunks were forwarded before it, so the consumer sees both.
    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'hello' });
    // Surfaced, NOT failed over — the provider already billed for this call.
    expect(fallback.calls).toHaveLength(0);
    // Exactly one attempt record, and it is the failure — `#emitSuccess` folds usage before it emits, so no
    // success record was written first.
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ outcome: 'failed' });
  });

  it('a stream that omits its terminal FAILS — it is not a content-free success', async () => {
    // **Rewritten, not deleted** (ADR-0082 §12.17). It used to read "records a content-free success with no
    // usage when the stream omits a stop chunk", and the reasoning it recorded was real at the time: the
    // chain folded usage when it had some, and `usage === undefined` simply meant "nothing to fold". What
    // that framing missed is that the same condition also means "no terminal ever arrived" — so a transport
    // cut mid-answer was reported as a completed turn whose partial text became the assistant's reply.
    //
    // The chain now verifies the grammar on every provider, so this is a classified `transport` failure. The
    // partial content is still forwarded — the caller decides what a truncated answer is worth — and the
    // attempt records ONE failure, not a success (§12.2, §12.15).
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'partial' }]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain([entry(provider, 'claude-haiku-4-5')], options);

    const chunks = await collect(chain.stream(userReq));

    expect(chunks[0]).toEqual({ type: 'text_delta', text: 'partial' });
    const surfaced = chunks.at(-1);
    expect(surfaced?.type === 'error' && surfaced.error.kind).toBe('transport');
    expect(trace.filter((r) => r.outcome === 'succeeded')).toHaveLength(0);
    expect(trace.filter((r) => r.outcome === 'failed')).toHaveLength(1);
    // No usage was ever folded, so no cost is claimed for an attempt we cannot account for (ADR-0074).
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

    // The surfaced error now carries `contentCommitted` (ADR-0082 §4). It was NOT stamped before, and that
    // omission was the whole defect: the chain refused to fail over — which this test already proved — while
    // the node-retry budget ABOVE the chain saw a plain `retryable: true` and re-dispatched, producing a
    // second answer and a second charge for a call the user had already seen output from.
    expect(chunks).toEqual([
      { type: 'text_delta', text: 'partial output' },
      committedErrChunk('anthropic', 'overloaded'),
    ]);
    expect(fallback.calls).toHaveLength(0); // committed → no failover
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ provider: 'anthropic', outcome: 'failed' });
  });

  it('stamps a FOLD failure after content too — the third stamp site', async () => {
    // The one surfaced-failure path with no test: the stream succeeded, content already reached the caller,
    // and then cost accounting threw — a broken overlay or a custom tracker. Its own comment claims the
    // stamp keeps "every error the chain surfaces past content carries `contentCommitted`" true, and
    // removing the stamp left all 773 tests in this package green. `kind: 'unknown'` already derives
    // `retryable: false`, so nothing changes today — which is exactly why the invariant needs a test rather
    // than a second, unrelated mechanism holding it up.
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'partial output' }, STOP_CHUNK]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options } = makeOptions({
      costTracker: {
        record: () => {
          throw new TypeError('cumulative overflowed');
        },
      } as unknown as CostTracker,
    });
    const chain = new FallbackChain(
      [entry(provider, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    expect(last?.type === 'error' ? last.error.contentCommitted : undefined).toBe(true);
    expect(last?.type === 'error' ? last.error.message : undefined).toContain('cost accounting');
    expect(fallback.calls).toHaveLength(0); // surfaced, never failed over
  });

  it('stamps a THROWN mid-stream failure too — the second stamp site', async () => {
    // A review reverted ONLY this site (leaving the error-chunk site intact) and 4,402 tests across three
    // packages stayed green. It is the reachable path where a provider's iterator THROWS after content — an
    // adapter rejecting on a malformed SSE frame, an SDK rejection after deltas — instead of yielding an
    // `error` chunk. Without the stamp the node re-dispatches a call the user already saw output from.
    const primary = makeProvider({
      id: 'anthropic',
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'text_delta', text: 'partial output' } satisfies StreamChunk;
        throw new LlmProviderError(
          makeLlmError({ provider: 'anthropic', kind: 'timeout', message: 'boom' }),
        );
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

    expect(chunks[1]).toEqual(committedErrChunk('anthropic', 'timeout'));
    expect(fallback.calls).toHaveLength(0);
  });

  it('a provider CANNOT forge `contentCommitted` and delete the node’s retry budget', async () => {
    // The field rides `LlmErrorSchema`, which is what providers construct — so a pre-content failure
    // claiming commitment would, through the fold above the chain, silently remove transient-failure
    // recovery. The chain strips it on ingress, making `committed()` its only writer.
    //
    // **Asserted on the SURFACED error, not on failover.** A first version of this test checked only that
    // the chain still failed over — and a review measured it vacuous: gutting `disown()` entirely left it
    // green, because chain-level failover is governed by the chain's OWN `state.committed`, tracked from
    // real forwarded chunks, and never by the flag on an incoming error. The flag's only reader is above
    // the chain, so the only thing that proves it was stripped is the error the chain finally yields.
    // A single-entry chain, so the failure is surfaced rather than swallowed by a successful fallback.
    const forged: StreamChunk = {
      type: 'error',
      error: {
        ...makeLlmError({ provider: 'anthropic', kind: 'timeout', message: 'boom' }),
        contentCommitted: true, // …on a stream that produced NO content
      },
    };
    const only = makeProvider({ id: 'anthropic', stream: () => streamFrom([forged]) });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(only, 'claude-opus-4-8', 1)], options);

    const chunks = await collect(chain.stream(userReq));

    const surfaced = chunks.at(-1);
    expect(surfaced?.type).toBe('error');
    expect(surfaced?.type === 'error' && surfaced.error.kind).toBe('timeout');
    // THE assertion: the provider's claim did not survive ingress, so the node keeps its retry budget.
    expect(surfaced?.type === 'error' && surfaced.error.contentCommitted).toBeUndefined();
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

    // Stamped too — `tool_call_start` commits the stream exactly as text does, which is what ADR-0082 §1's
    // "any chunk other than `stop` or `error`" definition records (it is `isContentChunk`'s existing rule,
    // written down rather than changed).
    expect(chunks).toEqual([
      { type: 'tool_call_start', id: 'tc1', name: 'read_file' },
      committedErrChunk('anthropic', 'overloaded'),
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

  it('reclassifies a committed-stream error as cancelled when the signal aborted mid-stream', async () => {
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    // The provider commits (a content delta), then a run cancel lands and the adapter surfaces the wrapped
    // mid-stream abort MIS-classified as `transport` (→ provider_unavailable downstream). The chain must
    // re-show it as `cancelled` because the request signal is aborted (the exact real-TTY Ctrl-C scenario).
    const provider = makeProvider({
      id: 'anthropic',
      stream: () =>
        (async function* () {
          yield { type: 'text_delta', text: 'partial' }; // commits the stream
          await Promise.resolve(); // a tick — the run cancel lands here, mid-stream
          signal.aborted = true;
          yield errChunk('anthropic', 'transport'); // the adapter's mis-classification of the abort
        })(),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(provider, 'claude-haiku-4-5')], options);

    const chunks = await collect(chain.stream({ ...userReq, signal }));
    const errors = chunks.filter((c) => c.type === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.type === 'error') {
      expect(errors[0].error.kind).toBe('cancelled'); // NOT 'transport' → won't show as provider_unavailable
    }
  });

  it('reclassifies a generate failure as cancelled when the signal aborts during the call (no failover)', async () => {
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    // The signal is false at the loop-top guard, then aborts DURING the in-flight call which rejects with a
    // (retryable) transport error — #abortAware must surface it as fatal `cancelled`, and never fail over.
    const primary = makeProvider({
      id: 'anthropic',
      generate: () => {
        signal.aborted = true;
        return rejects('anthropic', 'transport')();
      },
    });
    const fallback = makeProvider({ id: 'openai', generate: resolves('should-not-run') });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(primary, 'claude'), entry(fallback, 'gpt')], options);

    const err = await rejectedError(chain.generate({ ...userReq, signal }));
    expect(err.kind).toBe('cancelled'); // not 'transport'
    expect(fallback.calls).toHaveLength(0); // cancelled is fatal → no failover to a second (paid) provider
  });

  it('reclassifies a PRE-content stream failure as cancelled when aborted (no failover)', async () => {
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const primary = makeProvider({
      id: 'anthropic',
      stream: () =>
        (async function* () {
          await Promise.resolve(); // a tick
          signal.aborted = true; // abort lands BEFORE any content chunk
          yield errChunk('anthropic', 'transport'); // pre-content error
        })(),
    });
    const fallback = makeProvider({ id: 'openai', stream: () => streamFrom([STOP_CHUNK]) });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(primary, 'claude'), entry(fallback, 'gpt')], options);

    const chunks = await collect(chain.stream({ ...userReq, signal }));
    const errors = chunks.filter((c) => c.type === 'error');
    expect(errors).toHaveLength(1);
    if (errors[0]?.type === 'error') {
      expect(errors[0].error.kind).toBe('cancelled');
    }
    expect(fallback.calls).toHaveLength(0); // cancelled is fatal → the pre-content failure does NOT fail over
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

describe('cross-call reasoning strip latch (ADR-0039)', () => {
  const reasoningResult = (): LlmResult => ({
    content: [
      { type: 'reasoning', text: 'thinking', signature: 'sig-1' },
      { type: 'text', text: 'a1' },
    ],
    stopReason: 'stop',
    usage: USAGE,
    raw: undefined,
  });

  const hasReasoning = (req: LlmRequest): boolean =>
    req.messages.some((m) => m.content.some((c) => c.type === 'reasoning'));

  /** The continuation request a tool loop builds: prior messages + the assistant turn (with reasoning). */
  const continuation = (content: LlmResult['content']): LlmRequest => ({
    ...userReq,
    messages: [...userReq.messages, { role: 'assistant', content: [...content] }],
  });

  it('strips a prior provider’s reasoning on the NEXT call after a non-cooldown failover (multi-turn hole)', async () => {
    // Call 1: primary times out (retryable, NO cooldown) → fails over to the fallback, which returns a
    // SIGNED reasoning turn. Call 2 re-issues at the primary; the cross-call latch must strip the
    // fallback's reasoning before the primary ever sees it.
    const primary = makeProvider({
      id: 'anthropic',
      generate: (_req, _key, call) =>
        call === 1 ? rejects('anthropic', 'timeout')() : resolves('p2')(),
    });
    const fallback = makeProvider({
      id: 'openai',
      generate: () => Promise.resolve(reasoningResult()),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt')],
      options,
    );

    const first = await chain.generate(userReq);
    expect(
      hasReasoning({ ...userReq, messages: [{ role: 'assistant', content: first.content }] }),
    ).toBe(true);

    await chain.generate(continuation(first.content));
    // The primary's SECOND request must carry NO reasoning (latch = the fallback, a provider boundary).
    expect(primary.calls).toHaveLength(2);
    expect(hasReasoning(reqAt(primary.calls, 1))).toBe(false);
  });

  it('preserves reasoning across calls on the SAME provider (same-provider replay)', async () => {
    const only = makeProvider({
      id: 'anthropic',
      generate: (_req, _key, call) =>
        call === 1 ? Promise.resolve(reasoningResult()) : resolves('a2')(),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain([entry(only, 'claude-opus-4-8')], options);

    const first = await chain.generate(userReq);
    await chain.generate(continuation(first.content));
    // Same provider both calls → no boundary → the signed reasoning is replayed, not stripped.
    expect(only.calls).toHaveLength(2);
    expect(hasReasoning(reqAt(only.calls, 1))).toBe(true);
  });

  it('strips reasoning across STREAM calls after a non-cooldown failover (the 1.O path)', async () => {
    // 1.O drives stream(), not generate() — the multi-turn hole must be closed on this path too.
    const primary = makeProvider({
      id: 'anthropic',
      stream: (_r, _k, call) =>
        call === 1
          ? streamThrowing(providerError('anthropic', 'timeout'))
          : streamFrom([{ type: 'text_delta', text: 'p2' }, STOP_CHUNK]),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () =>
        streamFrom([
          { type: 'reasoning_start', id: 'r' },
          { type: 'reasoning_delta', id: 'r', text: 't' },
          { type: 'reasoning_end', id: 'r', signature: 'sig' },
          { type: 'text_delta', text: 'q' },
          STOP_CHUNK,
        ]),
    });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(primary, 'claude-opus-4-8'), entry(fallback, 'gpt')],
      options,
    );

    await collect(chain.stream(userReq)); // call 1: primary times out (no cooldown) → fallback (signed)
    await collect(chain.stream(continuation(reasoningResult().content))); // call 2: re-issue at primary
    expect(primary.calls).toHaveLength(2);
    expect(hasReasoning(reqAt(primary.calls, 1))).toBe(false);
  });
});

describe('cost + credential robustness', () => {
  it('does not fail a successful attempt when the model id is unpriced (cost degrades to absent)', async () => {
    const provider = makeProvider({ id: 'anthropic', generate: resolves('ok') });
    const { options, trace } = makeOptions({ costTracker: new CostTracker() });
    const chain = new FallbackChain([entry(provider, 'totally-unpriced-snapshot-2099')], options);

    const out = await chain.generate(userReq); // must NOT throw UnknownModelError after the tokens landed
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(trace[0]?.outcome).toBe('succeeded');
    expect(trace[0]?.cost).toBeUndefined(); // unpriced → no cost recorded, never a thrown failure
  });

  it('redacts a throwing keyFor to a fixed secret-free auth error, dropping the cause (generate)', async () => {
    const secret = ['sk', 'live', 'do-not-leak-123'].join('-');
    const provider = makeProvider({ id: 'anthropic', generate: resolves('unused') });
    const { options } = makeOptions({
      keyFor: () => {
        throw new Error(`keychain unlock failed: ${secret}`);
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    const err = await rejectedError(chain.generate(userReq));
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('credential resolution failed for provider anthropic');
    expect(err.message).not.toContain(secret);
    expect(err.cause).toBeUndefined(); // the original (secret-bearing) error is dropped, not carried
  });

  it('redacts a throwing keyFor on the stream path too (surfaced as an auth error chunk)', async () => {
    const secret = ['sk', 'live', 'do-not-leak-456'].join('-');
    const provider = makeProvider({ id: 'anthropic', stream: () => streamFrom([STOP_CHUNK]) });
    const { options } = makeOptions({
      keyFor: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], options);

    const chunks = await collect(chain.stream(userReq));
    const error = chunks.find((c) => c.type === 'error');
    expect(error?.type === 'error' && error.error.kind).toBe('auth');
    expect(error?.type === 'error' && error.error.message).not.toContain(secret);
  });
});

// --- media egress re-materialization (1.AF, D7/D8, ADR-0043) -----------------------------------

describe('FallbackChain media egress re-materialization (D7/D8)', () => {
  const MEDIA_CAPS: CapabilityFlags = {
    tools: true,
    streaming: true,
    parallelToolCalls: false,
    vision: true,
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: true, audio: true, video: true, document: true },
      outputCombinations: [],
    },
  };
  const HANDLE = `media://sha256-${'a'.repeat(64)}`;
  const handleReq: LlmRequest = {
    model: 'incoming',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
        ],
      },
    ],
  };
  const sentSource = (fake: FakeProvider, call = 0): unknown => {
    const part = fake.calls[call]?.messages[0]?.content[1];
    return part?.type === 'media' ? part.source : null;
  };

  it('resolves a handle media source to its in-flight source before the provider sees it (D8)', async () => {
    const provider = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    const resolveCalls: Array<{ handle: string; provider: ProviderId }> = [];
    const { options } = makeOptions({
      resolveForEgress: (handle, p) => {
        resolveCalls.push({ handle, provider: p });
        return Promise.resolve({ kind: 'base64', data: 'aGVsbG8=' });
      },
    });
    await new FallbackChain([entry(provider, 'gpt-x')], options).generate(handleReq);
    expect(resolveCalls).toEqual([{ handle: HANDLE, provider: 'openai' }]);
    expect(sentSource(provider)).toEqual({ kind: 'base64', data: 'aGVsbG8=' }); // no handle to the adapter
  });

  it('leaves a handle source unchanged when no resolveForEgress hook is wired (no-op)', async () => {
    const provider = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    const { options } = makeOptions();
    await new FallbackChain([entry(provider, 'gpt-x')], options).generate(handleReq);
    expect(sentSource(provider)).toEqual({ kind: 'handle', ref: HANDLE });
  });

  it('caches a non-base64 provider ref and reuses it on a later same-provider call (byte-free sidecar, D7)', async () => {
    const provider = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    let resolveCount = 0;
    const { options } = makeOptions({
      resolveForEgress: () => {
        resolveCount += 1;
        return Promise.resolve({ kind: 'url', url: 'https://files.openai/abc' });
      },
    });
    const chain = new FallbackChain([entry(provider, 'gpt-x')], options);
    await chain.generate(handleReq);
    await chain.generate(handleReq); // a later call on the SAME instance
    expect(resolveCount).toBe(1); // the provider ref was cached + reused (no re-upload)
    expect(sentSource(provider, 1)).toEqual({ kind: 'url', url: 'https://files.openai/abc' });
  });

  it('never caches a base64 source (byte-free sidecar) — re-resolves on each call', async () => {
    const provider = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    let resolveCount = 0;
    const { options } = makeOptions({
      resolveForEgress: () => {
        resolveCount += 1;
        return Promise.resolve({ kind: 'base64', data: 'aGVsbG8=' });
      },
    });
    const chain = new FallbackChain([entry(provider, 'gpt-x')], options);
    await chain.generate(handleReq);
    await chain.generate(handleReq);
    expect(resolveCount).toBe(2); // base64 carries bytes — never cached; re-resolved (sidecar stays byte-free)
  });

  it('re-materializes per-provider across a failover (a foreign ref never crosses the boundary, D7)', async () => {
    const primary = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: rejects('openai', 'overloaded'),
    });
    const fallback = makeProvider({
      id: 'anthropic',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    const seen: ProviderId[] = [];
    const { options } = makeOptions({
      resolveForEgress: (_handle, p) => {
        seen.push(p);
        return Promise.resolve({ kind: 'url', url: `https://files.${p}/abc` });
      },
    });
    const chain = new FallbackChain(
      [entry(primary, 'gpt-x'), entry(fallback, 'claude-x')],
      options,
    );
    await chain.generate(handleReq);
    expect(seen).toEqual(['openai', 'anthropic']); // resolved independently for each provider
    expect(sentSource(fallback)).toEqual({ kind: 'url', url: 'https://files.anthropic/abc' });
  });

  it('advances to the next provider when re-materialization fails (retryable-advance, D7)', async () => {
    const primary = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('primary'),
    });
    const fallback = makeProvider({
      id: 'anthropic',
      capabilities: MEDIA_CAPS,
      generate: resolves('fallback'),
    });
    const { options, trace } = makeOptions({
      resolveForEgress: (_handle, p) =>
        p === 'openai'
          ? Promise.reject(new Error('upload failed'))
          : Promise.resolve({ kind: 'base64', data: 'aGVsbG8=' }),
    });
    const chain = new FallbackChain(
      [entry(primary, 'gpt-x'), entry(fallback, 'claude-x')],
      options,
    );
    const res = await chain.generate(handleReq);
    expect(res.content).toEqual([{ type: 'text', text: 'fallback' }]); // advanced past the failed materialization
    expect(primary.calls).toHaveLength(0); // primary never got a request — materialization failed first
    const failed = trace.find((r) => r.outcome === 'failed');
    expect(failed?.error?.message).toMatch(/re-materialization failed/); // visible + secret-free
  });

  it('makes a re-materialization failure fatal when there is no next provider', async () => {
    const provider = makeProvider({
      id: 'openai',
      capabilities: MEDIA_CAPS,
      generate: resolves('ok'),
    });
    const { options } = makeOptions({
      resolveForEgress: () => Promise.reject(new Error('upload failed')),
    });
    const chain = new FallbackChain([entry(provider, 'gpt-x')], options);
    const error = await rejectedError(chain.generate(handleReq));
    expect(error.message).toMatch(/re-materialization failed/);
    expect(provider.calls).toHaveLength(0);
  });
});

/**
 * The grammar verifier and the deadline, THROUGH the chain (ADR-0082 §3, §5, §9). The module-level tests
 * prove each mechanism; these prove the chain actually uses them, which is the half a wiring commit can get
 * wrong without anything noticing.
 */
describe('FallbackChain — the grammar and the deadline are wired', () => {
  it('a PRE-content grammar violation advances to the next entry without re-attempting the broken one', async () => {
    // §9's `advance` verdict. `retryable` would first burn this entry's whole attempt budget on a provider
    // we already know cannot keep the grammar, and `fatal` would deny a well-behaved fallback its turn.
    const broken = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([STOP_CHUNK, { type: 'text_delta', text: 'after the terminal' }]),
    });
    const good = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'the fallback ran' }, STOP_CHUNK]),
    });
    const { options, trace } = makeOptions();
    // Three attempts budgeted on the broken entry — none of which may be spent.
    const chain = new FallbackChain(
      [entry(broken, 'claude-opus-4-8', 3), entry(good, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(broken.calls).toHaveLength(1); // …exactly one, not three
    expect(good.calls).toHaveLength(1);
    expect(chunks.some((c) => c.type === 'text_delta' && c.text === 'the fallback ran')).toBe(true);
    const failed = trace.filter((r) => r.outcome === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error?.kind).toBe('protocol');
    expect(failed[0]?.error?.retryable).toBe(false);
  });

  it('a POST-content grammar violation is surfaced, not advanced', async () => {
    // The negative control for the arm above: past the first content chunk there is no failing over, because
    // the user has already been shown output.
    const broken = makeProvider({
      id: 'anthropic',
      stream: () =>
        streamFrom([
          { type: 'text_delta', text: 'partial' },
          STOP_CHUNK,
          { type: 'text_delta', text: 'after the terminal' },
        ]),
    });
    const good = makeProvider({ id: 'openai', stream: () => streamFrom([STOP_CHUNK]) });
    const { options } = makeOptions();
    const chain = new FallbackChain(
      [entry(broken, 'claude-opus-4-8'), entry(good, 'gpt-5.5')],
      options,
    );

    const chunks = await collect(chain.stream(userReq));

    expect(good.calls).toHaveLength(0);
    const surfaced = chunks.at(-1);
    expect(surfaced?.type === 'error' && surfaced.error.kind).toBe('protocol');
    expect(surfaced?.type === 'error' && surfaced.error.contentCommitted).toBe(true);
  });

  it('a provider that ignores its signal and never settles hits the DEADLINE', async () => {
    // The hang the deadline exists to remove. `stream()` returns an iterator whose `next()` never settles
    // and which never observes the abort — a cooperative signal alone would wait forever here.
    let disarmed = 0;
    const pending = new Set<() => void>();
    const hung = makeProvider({
      id: 'anthropic',
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
      }),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain([entry(hung, 'claude-opus-4-8')], {
      ...options,
      newAbortController: () => {
        let aborted = false;
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
          abort: () => {
            aborted = true;
          },
        };
      },
      setTimer: (_ms, fire) => {
        pending.add(fire);
        return () => {
          disarmed += 1;
          pending.delete(fire);
        };
      },
    });

    const streamed = collect(chain.stream(userReq));
    // Let the attempt reach its first `next()`, then trip the clock.
    for (let i = 0; i < 200 && pending.size === 0; i += 1) await Promise.resolve();
    expect(pending.size).toBe(1);
    for (const fire of [...pending]) fire();

    const chunks = await streamed;
    const surfaced = chunks.at(-1);
    expect(surfaced?.type === 'error' && surfaced.error.kind).toBe('timeout');
    expect(trace.filter((r) => r.outcome === 'failed')).toHaveLength(1);
    expect(disarmed).toBeGreaterThan(0); // …and the timer was cleaned up
  });

  it('a deadline that trips AFTER content is surfaced, never failed over', async () => {
    // Rule 7 through the DEADLINE arm, which had no coverage: every other deadline test here times out
    // pre-content, and the nearest committed test drives a provider that THROWS after a delta — that lands
    // in `#runEntryStream`'s catch, not in the `step.kind === 'timeout'` branch. Two different lines, and
    // only one of them was pinned.
    //
    // The isolating mutation is passing `{ ...state, committed: false }` to `#failAttempt` in the timeout
    // branch: exactly this test reddens. (DELETING the `state` argument is NOT the mutation — it is a
    // required parameter, so the call throws and four tests fail for the wrong reason. Recorded because the
    // first attempt at break-verifying this made that mistake and read the four reds as coverage.)
    let fire: (() => void) | undefined;
    // Set when the iterator is asked for a SECOND chunk — i.e. the delta above is already forwarded and the
    // attempt is committed. Firing on `fire !== undefined` alone would trip the clock while the deadline was
    // merely armed, which is the PRE-content case three other tests already cover.
    let stalled = false;
    const stalls = makeProvider({
      id: 'anthropic',
      stream: () => ({
        [Symbol.asyncIterator]: () => {
          let sent = false;
          return {
            next: () => {
              if (sent) {
                stalled = true;
                return new Promise<never>(() => undefined);
              }
              sent = true;
              return Promise.resolve({
                value: { type: 'text_delta', text: 'partial output' } satisfies StreamChunk,
                done: false,
              });
            },
          };
        },
      }),
    });
    const fallback = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'never' }, STOP_CHUNK]),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain(
      [entry(stalls, 'claude-opus-4-8'), entry(fallback, 'gpt-5.5')],
      {
        ...options,
        newAbortController: () => {
          let aborted = false;
          return {
            signal: {
              get aborted() {
                return aborted;
              },
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            },
            abort: () => {
              aborted = true;
            },
          };
        },
        setTimer: (_ms, onFire) => {
          fire = onFire;
          return () => undefined;
        },
      },
    );

    const streamed = collect(chain.stream(userReq));
    // Let the first chunk through — commitment is what this test is about — then trip the clock.
    for (let i = 0; i < 200 && !stalled; i += 1) await Promise.resolve();
    expect(stalled).toBe(true); // the delta really was forwarded before the deadline tripped
    fire?.();
    const chunks = await streamed;

    // Asserted field-by-field rather than through `committedErrChunk`, whose message is a provider's
    // `'boom'`: this error is minted by the deadline itself, so the helper would be asserting the wrong
    // author. `contentCommitted` is the load-bearing one — it is what the node-retry budget reads.
    const surfaced = chunks[1];
    expect(surfaced?.type).toBe('error');
    if (surfaced?.type !== 'error') throw new Error('unreachable — narrowed above');
    expect(surfaced.error.kind).toBe('timeout');
    expect(surfaced.error.provider).toBe('anthropic');
    expect(surfaced.error.contentCommitted).toBe(true);
    expect(fallback.calls).toHaveLength(0); // …no failover past content
    expect(trace.filter((r) => r.outcome === 'failed')).toHaveLength(1); // …and exactly one attempt record
  });

  it('entry 1 timing out disarms ITS timer before entry 2 arms one', async () => {
    // A subtle multi-attempt interaction with no direct coverage: the deadline is per ATTEMPT, so a fresh
    // scope must open for entry 2 and entry 1's must already be disarmed. Correct today by construction —
    // attempts run strictly sequentially and each disposes in its own `finally` — which is exactly the kind
    // of property a future refactor (parallelising entries, hoisting the scope) breaks silently.
    const armed: string[] = [];
    let fireFirst: (() => void) | undefined;
    const hung = makeProvider({
      id: 'anthropic',
      stream: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
      }),
    });
    const good = makeProvider({
      id: 'openai',
      stream: () => streamFrom([{ type: 'text_delta', text: 'the fallback ran' }, STOP_CHUNK]),
    });
    const { options } = makeOptions();
    let nth = 0;
    const chain = new FallbackChain([entry(hung, 'claude-opus-4-8'), entry(good, 'gpt-5.5')], {
      ...options,
      newAbortController: () => {
        let aborted = false;
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
          abort: () => {
            aborted = true;
          },
        };
      },
      setTimer: (_ms, fire) => {
        nth += 1;
        const label = String(nth);
        armed.push(`arm-${label}`);
        if (nth === 1) fireFirst = fire;
        return () => armed.push(`disarm-${label}`);
      },
    });

    const streamed = collect(chain.stream(userReq));
    for (let i = 0; i < 200 && fireFirst === undefined; i += 1) await Promise.resolve();
    fireFirst?.();
    const chunks = await streamed;

    expect(chunks.some((c) => c.type === 'text_delta' && c.text === 'the fallback ran')).toBe(true);
    // Entry 1's scope is disposed BEFORE entry 2 arms — the ordering, not just the counts.
    expect(armed.indexOf('disarm-1')).toBeLessThan(armed.indexOf('arm-2'));
    expect(armed.filter((a) => a.startsWith('arm-'))).toHaveLength(2); // one per attempt, not one shared
  });

  it('a HALF-wired timer port arms nothing — both or neither', async () => {
    // The first version built a chain with NEITHER primitive, so `||` and `&&` agreed and a review's
    // mutation of the guard (`||` → `&&`) left all 757 tests green. Under that mutant a host supplying only
    // `setTimer` reaches `openDeadline(ms, undefined, …)` and dies on `newController()` — an uncaught throw
    // out of the attempt, breaking the chain's own "a terminal failure is surfaced as an `error` chunk, not
    // a throw" contract. So this builds each HALF.
    const provider = makeProvider({
      id: 'anthropic',
      stream: () => streamFrom([{ type: 'text_delta', text: 'ok' }, STOP_CHUNK]),
    });
    const controllerOnly = (): AbortControllerLike => ({
      signal: {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
      abort: () => undefined,
    });

    for (const wireTimer of [true, false]) {
      let armed = 0;
      const { options } = makeOptions();
      const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], {
        ...options,
        ...(wireTimer
          ? {
              setTimer: () => {
                armed += 1;
                return () => undefined;
              },
            }
          : { newAbortController: controllerOnly }),
      });

      const chunks = await collect(chain.stream(userReq));
      expect(chunks.some((c) => c.type === 'stop')).toBe(true); // the stream still completes…
      expect(armed).toBe(0); // …and NOTHING was armed — unwired, not half-applied
    }
  });

  it('a `generate()` that never settles hits the deadline too — ADR-0082 §12.10', async () => {
    // The ADR's own motivating example, and the arm the first wiring missed. It is live-reachable: an
    // inline media-out turn (ADR-0046) routes through `chain.generate()`, so a hung provider there waited
    // forever on every surface while the seam doc said every attempt was bounded.
    const pending = new Set<() => void>();
    const hung = makeProvider({
      id: 'anthropic',
      generate: () => new Promise<never>(() => undefined),
    });
    const { options, trace } = makeOptions();
    const chain = new FallbackChain([entry(hung, 'claude-opus-4-8')], {
      ...options,
      newAbortController: () => {
        let aborted = false;
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
          abort: () => {
            aborted = true;
          },
        };
      },
      setTimer: (_ms, fire) => {
        pending.add(fire);
        return () => pending.delete(fire);
      },
    });

    const generated = chain.generate(userReq);
    for (let i = 0; i < 200 && pending.size === 0; i += 1) await Promise.resolve();
    expect(pending.size).toBe(1); // …the timer was ARMED on this arm, which is what was missing
    for (const fire of [...pending]) fire();

    await expect(generated).rejects.toMatchObject({ llmError: { kind: 'timeout' } });
    expect(trace.filter((r) => r.outcome === 'failed')).toHaveLength(1);
    expect(pending.size).toBe(0); // …and disarmed on the way out
  });

  it('a cancel during credential resolution produces NO provider call — generate and stream', async () => {
    // `#resolveKey` is I/O (a keychain read today, a network one in Phase 2), and a cancel landing inside it
    // was invisible: the provider was invoked, and only the deadline opened AFTERWARDS latched the aborted
    // caller — so `race()` reported `cancelled` for a request that had nonetheless gone out. A cancelled run
    // must not produce provider traffic, let alone a charge.
    for (const arm of ['generate', 'stream'] as const) {
      let calls = 0;
      let releaseKey: (() => void) | undefined;
      let aborted = false;
      const listeners = new Set<() => void>();
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: (_t: 'abort', l: () => void) => listeners.add(l),
        removeEventListener: (_t: 'abort', l: () => void) => listeners.delete(l),
      };
      const provider = makeProvider({
        id: 'anthropic',
        generate: () => {
          calls += 1;
          return Promise.resolve({
            content: [{ type: 'text', text: 'sent' }],
            stopReason: 'stop' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'claude-opus-4-8',
            provider: 'anthropic' as const,
          });
        },
        stream: () => {
          calls += 1;
          return streamFrom([{ type: 'text_delta', text: 'sent' }, STOP_CHUNK]);
        },
      });
      const { options } = makeOptions();
      const chain = new FallbackChain([entry(provider, 'claude-opus-4-8')], {
        ...options,
        // The credential resolves only when the test releases it — the window under examination.
        keyFor: () =>
          new Promise<string>((resolve) => {
            releaseKey = () => resolve('k');
          }),
      });

      const req = { ...userReq, signal };
      const running =
        arm === 'generate'
          ? chain.generate(req).then(
              () => 'ok',
              () => 'err',
            )
          : collect(chain.stream(req)).then(() => 'ok');
      for (let i = 0; i < 200 && releaseKey === undefined; i += 1) await Promise.resolve();
      expect(releaseKey).toBeDefined();

      aborted = true; // the caller cancels while the key is still resolving
      for (const l of [...listeners]) l();
      releaseKey?.();
      await running;

      expect(calls, `${arm}: the provider was not called`).toBe(0);
    }
  });

  it('disarms the deadline on the SUCCESS path too — both `stream` and `generate` (ADR-0082 §12.13)', async () => {
    // §12.13 says "timer cleanup proven with a fake clock on every path, **including success**". It was
    // proven for `openDeadline` in isolation (`attempt-deadline.test.ts`) and, at chain level, only on
    // FAILURE paths — every existing assertion here follows a timeout or an error. Nothing proved the chain
    // calls `dispose()` when the attempt simply works.
    //
    // Measured before writing this: making the stream's success exit leak its scope
    // (`if (step.kind === 'done') { deadline = undefined; break; }`) left all 107 tests in this file and
    // `attempt-deadline.test.ts` green. The docblock ten lines above the leak already names the cost — "a
    // leaked timer holds the process awake, which on a CLI is a hang the user cannot explain" — so the risk
    // was identified and simply unguarded.
    //
    // **And the first break-verify of the `generate` arm was a NO-OP, which is worth recording.** Guarding
    // its `finally` with `if (record.outcome === 'failed')` looked like a leak and changed nothing, because
    // the attempt-record factory DEFAULTS `outcome` to `'failed'` (`fallback-chain.ts`'s
    // `outcome: extra?.outcome ?? 'failed'`) — so the condition was always true and `dispose()` still ran.
    // The mutation applied textually and was inert semantically. Deleting the `dispose()` line outright
    // reddens both arms. This is exactly what the phase's discipline rule 2 means by "verify the mutation
    // actually applied": a green suite under a mutation is evidence only once the mutation is known to bite.
    for (const arm of ['stream', 'generate'] as const) {
      const pending = new Set<() => void>();
      let armed = 0;
      let disarmed = 0;
      const ok = makeProvider({
        id: 'anthropic',
        stream: () => streamFrom([{ type: 'text_delta', text: 'it worked' }, STOP_CHUNK]),
        generate: () =>
          Promise.resolve({
            content: [{ type: 'text', text: 'it worked' }],
            stopReason: 'stop' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
            model: 'claude-opus-4-8',
            provider: 'anthropic' as const,
          }),
      });
      const { options } = makeOptions();
      const chain = new FallbackChain([entry(ok, 'claude-opus-4-8')], {
        ...options,
        newAbortController: () => {
          let aborted = false;
          return {
            signal: {
              get aborted() {
                return aborted;
              },
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
            },
            abort: () => {
              aborted = true;
            },
          };
        },
        setTimer: (_ms, fire) => {
          armed += 1;
          pending.add(fire);
          return () => {
            disarmed += 1;
            pending.delete(fire);
          };
        },
      });

      if (arm === 'stream') {
        const chunks = await collect(chain.stream(userReq));
        expect(chunks.some((c) => c.type === 'text_delta' && c.text === 'it worked')).toBe(true);
      } else {
        const result = await chain.generate(userReq);
        expect(result.content[0]).toEqual({ type: 'text', text: 'it worked' });
      }

      // The attempt SUCCEEDED — and its timer is gone. `armed` is asserted first so a chain that armed
      // nothing (a half-wired port, a refactor that dropped the scope) cannot pass this by vacuous zero.
      expect(armed, `${arm}: the deadline was armed`).toBe(1);
      expect(disarmed, `${arm}: …and disposed on the success path`).toBe(1);
      expect(pending.size, `${arm}: no timer outlives the attempt`).toBe(0);
    }
  });

  it('a LATE chunk after a deadline abort produces no second attempt record and no cost update', async () => {
    // ADR-0082 §12.14, and it was missing — which mattered, because a review found a live defect on exactly
    // this path (an already-expired scope abandoning the in-flight `next()` unhandled). A provider that
    // settles just after the timer trips must change nothing: the attempt is already classified.
    let release: ((value: IteratorResult<StreamChunk>) => void) | undefined;
    const pending = new Set<() => void>();
    const slow = makeProvider({
      id: 'anthropic',
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<StreamChunk>>((resolve) => {
              release = resolve;
            }),
        }),
      }),
    });
    const { options, trace } = makeOptions({ costTracker: new CostTracker() });
    const chain = new FallbackChain([entry(slow, 'claude-opus-4-8')], {
      ...options,
      newAbortController: () => {
        let aborted = false;
        return {
          signal: {
            get aborted() {
              return aborted;
            },
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
          },
          abort: () => {
            aborted = true;
          },
        };
      },
      setTimer: (_ms, fire) => {
        pending.add(fire);
        return () => pending.delete(fire);
      },
    });

    const streamed = collect(chain.stream(userReq));
    for (let i = 0; i < 200 && pending.size === 0; i += 1) await Promise.resolve();
    for (const fire of [...pending]) fire(); // the deadline trips…
    const chunks = await streamed;

    // …and only NOW does the provider answer, with a full, usage-bearing terminal.
    release?.({ value: STOP_CHUNK, done: false });
    for (let i = 0; i < 50; i += 1) await Promise.resolve();

    expect(chunks.at(-1)?.type === 'error' && chunks.at(-1)).toMatchObject({
      error: { kind: 'timeout' },
    });
    expect(trace).toHaveLength(1); // one record, not two
    expect(trace[0]?.outcome).toBe('failed');
    expect(trace[0]?.cost).toBeUndefined(); // …and no cost claimed for an answer we discarded
  });

  it('closes the provider’s stream on a grammar violation AND on an early consumer break', async () => {
    // Converting `for await` to manual iteration removed the language's own teardown, and a review measured
    // two live leaks: a grammar VIOLATION (the verifier is suspended mid-`yield`, so its own loop over the
    // source is still open) and an early `break`. Each left the provider's body reader uncancelled — on a
    // real adapter the socket stays held and tokens keep arriving on a call we are still billed for.
    const openSource = (
      chunks: readonly StreamChunk[],
      closed: { value: boolean },
    ): AsyncIterable<StreamChunk> => ({
      async *[Symbol.asyncIterator]() {
        try {
          for (const chunk of chunks) {
            await Promise.resolve();
            yield chunk;
          }
          await new Promise(() => undefined); // …and then hold the connection open
        } finally {
          closed.value = true;
        }
      },
    });

    // 1. A grammar violation: `stop` followed by more content.
    const violated = { value: false };
    const broken = makeProvider({
      id: 'anthropic',
      stream: () => openSource([STOP_CHUNK, { type: 'text_delta', text: 'after' }], violated),
    });
    const { options } = makeOptions();
    await collect(new FallbackChain([entry(broken, 'claude-opus-4-8')], options).stream(userReq));
    expect(violated.value).toBe(true);

    // 2. An early consumer `break` — a Ctrl-C, or a chat abandoning the stream.
    const abandoned = { value: false };
    const chatty = makeProvider({
      id: 'anthropic',
      stream: () =>
        openSource(
          [
            { type: 'text_delta', text: 'one' },
            { type: 'text_delta', text: 'two' },
          ],
          abandoned,
        ),
    });
    for await (const chunk of new FallbackChain([entry(chatty, 'claude-opus-4-8')], options).stream(
      userReq,
    )) {
      if (chunk.type === 'text_delta') break;
    }
    // The `finally` chain runs on the generator's `return()`; give the microtasks a turn to settle.
    for (let i = 0; i < 20 && !abandoned.value; i += 1) await Promise.resolve();
    expect(abandoned.value).toBe(true);
  });

  it('refuses a non-positive attempt timeout at construction', async () => {
    // There is no "disabled" value: unbounded is the state this removes, and a config flag restoring it
    // would restore the defect.
    const provider = makeProvider({ id: 'anthropic', stream: () => streamFrom([STOP_CHUNK]) });
    const { options } = makeOptions();
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () =>
          new FallbackChain([entry(provider, 'claude-opus-4-8')], {
            ...options,
            attemptTimeoutMs: bad,
          }),
      ).toThrow('attemptTimeoutMs');
    }
    await Promise.resolve();
  });
});
