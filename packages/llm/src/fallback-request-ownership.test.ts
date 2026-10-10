import { describe, expect, it, vi } from 'vitest';
import type { JSONSchema7 } from 'json-schema';

import { FallbackChain, type AttemptRecord, type FallbackPlanEntry } from './fallback-chain.js';
import { UnsupportedRequestDataError } from './errors.js';
import { LlmProviderError, makeLlmError } from './llm-error.js';
import { outputCapPlanForRequest, ownLlmRequest, selectOwnedRequest } from './output-cap.js';
import type { LlmError, LlmProvider, LlmRequest, ProviderId, StreamChunk } from './types.js';

const paths = ['generate', 'stream'] as const;
type Path = (typeof paths)[number];
const MODEL = 'gpt-5';
const usage = { inputTokens: 2, outputTokens: 1 };

function barrier() {
  let release = (): void => {
    throw new Error('barrier not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function provider(id: ProviderId = 'openai') {
  const requests: LlmRequest[] = [];
  const instance: LlmProvider = {
    id,
    customEndpoint: true,
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: true,
      promptCache: true,
      reasoning: true,
      media: {
        input: { image: true, audio: true, video: true, document: true },
        outputCombinations: [['text']],
      },
    },
    generate(request) {
      requests.push(request);
      return Promise.resolve({
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'stop',
        raw: undefined,
        usage,
      });
    },
    stream(request) {
      requests.push(request);
      return (async function* (): AsyncIterable<StreamChunk> {
        await Promise.resolve();
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', stopReason: 'stop', usage };
      })();
    },
  };
  return { instance, requests };
}

function construction() {
  const leaf: JSONSchema7 = { type: 'string' };
  const schema: JSONSchema7 = { type: 'object', properties: { value: leaf } };
  const args = { value: 'before' };
  const result = { value: 'before' };
  const future = { value: 'before' };
  const request: LlmRequest = {
    model: MODEL,
    system: 'before',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'call', name: 'echo', args }] },
      { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'call', result }] },
      { role: 'user', content: [{ type: 'text', text: 'before' }] },
    ],
    tools: [{ name: 'echo', description: 'before', parameters: schema }],
    toolChoice: { name: 'echo' },
    responseFormat: { type: 'json', schema },
    outputModalities: ['text'],
    temperature: 0.5,
    maxTokens: 100,
    reasoningEffort: 'high',
    stopSequences: ['before'],
    providerOptions: { shared: schema, nested: { value: 'before' } },
  };
  Object.defineProperty(request, 'futureField', {
    value: future,
    enumerable: true,
    writable: true,
  });
  const mutate = (): void => {
    request.model = 'after';
    request.system = 'after';
    request.messages.push({ role: 'user', content: [{ type: 'text', text: 'after' }] });
    request.tools?.push({ name: 'after', parameters: {} });
    const tool = request.tools?.[0];
    if (tool !== undefined) tool.description = 'after';
    if (typeof request.toolChoice === 'object') request.toolChoice.name = 'after';
    request.responseFormat = { type: 'text' };
    request.outputModalities?.push('image');
    request.temperature = 1;
    request.maxTokens = 1;
    request.reasoningEffort = 'low';
    request.stopSequences?.push('after');
    leaf.type = 'number';
    args.value = 'after';
    result.value = 'after';
    future.value = 'after';
    request.providerOptions = { shared: 'after' };
  };
  return { request, mutate, schema, args, result };
}

function assertBefore(request: LlmRequest): void {
  expect(request).toMatchObject({
    model: MODEL,
    system: 'before',
    tools: [
      {
        name: 'echo',
        description: 'before',
        parameters: { properties: { value: { type: 'string' } } },
      },
    ],
    toolChoice: { name: 'echo' },
    responseFormat: { type: 'json', schema: { properties: { value: { type: 'string' } } } },
    outputModalities: ['text'],
    temperature: 0.5,
    maxTokens: 100,
    reasoningEffort: 'high',
    stopSequences: ['before'],
    providerOptions: { nested: { value: 'before' } },
    futureField: { value: 'before' },
  });
  expect(request.messages).toHaveLength(3);
  expect(request.tools).toHaveLength(1);
  expect(request.messages[0]?.content[0]).toMatchObject({ args: { value: 'before' } });
  expect(request.messages[1]?.content[0]).toMatchObject({ result: { value: 'before' } });
  const schema = request.tools?.[0]?.parameters;
  expect(request.providerOptions?.['shared']).toBe(schema);
  if (request.responseFormat?.type !== 'json') throw new Error('expected JSON format');
  expect(request.responseFormat.schema).toBe(schema);
  expect(Object.getPrototypeOf(request)).toBeNull();
  expect(Object.getPrototypeOf(schema)).toBeNull();
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.messages)).toBe(true);
  expect(Object.isFrozen(schema)).toBe(true);
  expect(Object.getOwnPropertyDescriptor(request.messages, 'toJSON')?.value).toBeUndefined();
  expect(Object.hasOwn(request.messages, 'toJSON')).toBe(true);
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function call(chain: FallbackChain, path: Path, request: LlmRequest): Promise<void> {
  if (path === 'generate') await chain.generate(request);
  else {
    const chunks = await collect(chain.stream(request));
    expect(chunks.at(-1)?.type).toBe('stop');
  }
}

async function diagnostic(
  chain: FallbackChain,
  path: Path,
  request: LlmRequest,
): Promise<LlmError> {
  if (path === 'generate') {
    try {
      await chain.generate(request);
    } catch (error) {
      if (error instanceof LlmProviderError) return error.llmError;
      throw error;
    }
    throw new Error('expected refusal');
  }
  const chunks = await collect(chain.stream(request));
  expect(chunks).toHaveLength(1);
  const terminal = chunks[0];
  if (terminal?.type !== 'error') throw new Error('expected refusal');
  return terminal.error;
}

function entry(instance: LlmProvider, model = MODEL, maxAttempts = 1): FallbackPlanEntry {
  return { provider: instance, model, maxAttempts };
}

for (const path of paths) {
  describe(`owned fallback request ${path}`, () => {
    for (const phase of ['admission', 'credentials'] as const) {
      it(`owns all fields before the ${phase} handoff without freezing the caller`, async () => {
        const fixture = construction();
        const fake = provider();
        const entered = barrier();
        const released = barrier();
        const hold = async (): Promise<void> => {
          entered.release();
          await released.promise;
        };
        const chain = new FallbackChain([entry(fake.instance)], {
          keyFor: async () => {
            if (phase === 'credentials') await hold();
            return 'offline';
          },
          preAttempt: phase === 'admission' ? hold : () => undefined,
          sleep: () => Promise.resolve(),
        });
        const pending = call(chain, path, fixture.request);
        await entered.promise;
        fixture.mutate();
        expect(Object.isFrozen(fixture.request)).toBe(false);
        expect(Object.isFrozen(fixture.schema)).toBe(false);
        released.release();
        await pending;
        expect(fake.requests).toHaveLength(1);
        const actual = fake.requests[0];
        if (actual === undefined) throw new Error('expected invocation');
        assertBefore(actual);
        expect(actual).not.toBe(fixture.request);
        expect(fixture.args.value).toBe('after');
        expect(fixture.result.value).toBe('after');
      });
    }

    it('rejects unsupported data before admission, credentials and provider invocation', async () => {
      const fake = provider();
      const keyFor = vi.fn(() => 'offline');
      const preAttempt = vi.fn();
      const records: AttemptRecord[] = [];
      const chain = new FallbackChain([entry(fake.instance)], {
        keyFor,
        preAttempt,
        onAttempt: (record) => records.push(record),
        sleep: () => Promise.resolve(),
      });
      const request: LlmRequest = {
        model: MODEL,
        messages: [],
        providerOptions: { private: new Date() },
      };
      const error = await diagnostic(chain, path, request);
      expect(error).toMatchObject({ kind: 'bad_request', retryable: false });
      expect(error.message).toBe('request data must contain only supported inert values');
      expect(error.cause).toBeInstanceOf(UnsupportedRequestDataError);
      expect(keyFor).not.toHaveBeenCalled();
      expect(preAttempt).not.toHaveBeenCalled();
      expect(fake.requests).toHaveLength(0);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ providerInvoked: false, contentReceived: false });
      expect(records[0]).not.toHaveProperty('usage');
    });

    it('preserves exact capture-refusal observer exceptions without reclassifying them', async () => {
      const fake = provider();
      const observerFailure = new LlmProviderError(
        makeLlmError({ provider: 'openai', kind: 'context_overflow', message: 'observer' }),
      );
      const onAttempt = vi.fn(() => {
        throw observerFailure;
      });
      const chain = new FallbackChain([entry(fake.instance)], {
        keyFor: () => 'offline',
        sleep: () => Promise.resolve(),
        onAttempt,
      });
      const request: LlmRequest = {
        model: MODEL,
        messages: [],
        providerOptions: { private: new Date() },
      };
      await expect(
        path === 'generate' ? chain.generate(request) : collect(chain.stream(request)),
      ).rejects.toBe(observerFailure);
      expect(onAttempt).toHaveBeenCalledTimes(1);
      expect(fake.requests).toHaveLength(0);
    });

    it('retains the original tier for a later capable fallback and binds its own caps', async () => {
      const primary = provider('openai');
      const fallback = provider('anthropic');
      primary.instance.generate = () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'transport', message: 'offline transport' }),
          ),
        );
      primary.instance.stream = () =>
        (async function* (): AsyncIterable<StreamChunk> {
          await Promise.resolve();
          yield {
            type: 'error',
            error: makeLlmError({
              provider: 'openai',
              kind: 'transport',
              message: 'offline transport',
            }),
          };
        })();
      const chain = new FallbackChain(
        [entry(primary.instance, 'gpt-3.5-turbo'), entry(fallback.instance, 'claude-opus-4-8')],
        {
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
        },
      );
      const request: LlmRequest = {
        model: MODEL,
        messages: [],
        maxTokens: 100,
        reasoningEffort: 'max',
      };
      await call(chain, path, request);
      const actual = fallback.requests[0];
      if (actual === undefined) throw new Error('expected fallback');
      expect(actual.reasoningEffort).toBe('max');
      expect(outputCapPlanForRequest(actual, 'anthropic', 'custom').mappedField).toBe('max_tokens');
    });

    it('keeps an unused candidate capture failure local, then refuses if it is needed', async () => {
      let serialized = 0;
      const cap = {
        toJSON() {
          serialized += 1;
          if (serialized > 1) throw new Error('PRIVATE_CAP');
          return 40;
        },
      };
      const primary = provider('openai');
      const fallback = provider('anthropic');
      const request: LlmRequest = {
        model: MODEL,
        messages: [],
        providerOptions: { max_completion_tokens: cap },
      };
      const chain = new FallbackChain(
        [entry(primary.instance), entry(fallback.instance, 'claude-opus-4-8')],
        { keyFor: () => 'offline', sleep: () => Promise.resolve() },
      );
      await call(chain, path, request);
      expect(serialized).toBe(2);
      expect(primary.requests).toHaveLength(1);
      expect(fallback.requests).toHaveLength(0);
      // Reuse the exact owned association: no fresh serializer execution can repair its failed candidate.
      const primaryView = primary.requests[0];
      if (primaryView === undefined) throw new Error('expected primary');
      primary.instance.generate = () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'transport', message: 'offline transport' }),
          ),
        );
      primary.instance.stream = () =>
        (async function* (): AsyncIterable<StreamChunk> {
          await Promise.resolve();
          yield {
            type: 'error',
            error: makeLlmError({
              provider: 'openai',
              kind: 'transport',
              message: 'offline transport',
            }),
          };
        })();
      const refused = await diagnostic(chain, path, primaryView);
      expect(refused.kind).toBe('bad_request');
      expect(refused.message).toBe(
        'prepared output cap plan does not match the request and actual endpoint',
      );
      expect(serialized).toBe(2);
      expect(fallback.requests).toHaveLength(0);
    });

    it('reuses an incoming factory-owned measured view through heterogeneous fallback', async () => {
      const primary = provider('openai');
      const fallback = provider('gemini');
      const first = { model: MODEL, provider: 'openai' as const, endpoint: 'custom' as const };
      const next = {
        model: 'gemini-2.5-pro',
        provider: 'gemini' as const,
        endpoint: 'custom' as const,
      };
      let serialized = 0;
      const cap = {
        toJSON() {
          serialized += 1;
          return 70;
        },
      };
      const source = ownLlmRequest(
        {
          model: MODEL,
          messages: [],
          providerOptions: { max_completion_tokens: cap, maxOutputTokens: 90 },
        },
        [first, next],
      );
      const measured = selectOwnedRequest(source, first);
      primary.instance.generate = () =>
        Promise.reject(
          new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'transport', message: 'offline transport' }),
          ),
        );
      primary.instance.stream = () =>
        (async function* (): AsyncIterable<StreamChunk> {
          await Promise.resolve();
          yield {
            type: 'error',
            error: makeLlmError({
              provider: 'openai',
              kind: 'transport',
              message: 'offline transport',
            }),
          };
        })();
      const plans: number[] = [];
      const chain = new FallbackChain(
        [entry(primary.instance), entry(fallback.instance, next.model)],
        {
          keyFor: () => 'offline',
          sleep: () => Promise.resolve(),
          preAttempt: (info) => {
            plans.push(info.outputCapPlan.effectiveCap ?? 0);
          },
        },
      );
      await call(chain, path, measured.request);
      expect(plans).toEqual([70, 90]);
      expect(serialized).toBe(1);
      const actual = fallback.requests[0];
      if (actual === undefined) throw new Error('expected fallback');
      expect(outputCapPlanForRequest(actual, 'gemini', 'custom').effectiveCap).toBe(90);
    });
  });
}

it('captures a direct stream before first next rather than at iterator consumption', async () => {
  const fixture = construction();
  const fake = provider();
  const keyFor = vi.fn(() => 'offline');
  const chain = new FallbackChain([entry(fake.instance)], {
    keyFor,
    sleep: () => Promise.resolve(),
  });
  const stream = chain.stream(fixture.request);
  fixture.mutate();
  expect(keyFor).not.toHaveBeenCalled();
  await collect(stream);
  const actual = fake.requests[0];
  if (actual === undefined) throw new Error('expected request');
  assertBefore(actual);
});

for (const path of paths) {
  it(`${path} owns each returned media source before awaiting the next resolver`, async () => {
    const fake = provider();
    const entered = barrier();
    const released = barrier();
    const source = { kind: 'base64' as const, data: 'YmVmb3Jl' };
    const handles = [1, 2].map((number) => `media://sha256-${String(number).repeat(64)}`);
    const request: LlmRequest = {
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: handles.map((ref) => ({
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref },
          })),
        },
      ],
    };
    const resolve = vi.fn(async (handle: string) => {
      if (handle === handles[0]) return source;
      entered.release();
      await released.promise;
      return { kind: 'base64' as const, data: 'c2Vjb25k' };
    });
    const chain = new FallbackChain([entry(fake.instance)], {
      keyFor: () => 'offline',
      sleep: () => Promise.resolve(),
      resolveForEgress: resolve,
    });
    const pending = call(chain, path, request);
    await entered.promise;
    source.data = 'YWZ0ZXI=';
    released.release();
    await pending;
    const actual = fake.requests[0]?.messages[0]?.content[0];
    expect(actual).toMatchObject({ type: 'media', source: { kind: 'base64', data: 'YmVmb3Jl' } });
    expect(source.data).toBe('YWZ0ZXI=');
    expect(resolve).toHaveBeenCalledTimes(2);
  });
}
