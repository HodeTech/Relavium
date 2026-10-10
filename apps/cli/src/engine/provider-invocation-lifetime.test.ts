import { describe, expect, it } from 'vitest';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import type { LlmInvocationOptions, LlmRequest, MediaGenRequest, StreamChunk } from '@relavium/llm';
import type { EgressDeps, HopRequest, HopResponse } from '@relavium/db';
import { createValidatedFetch } from './validated-fetch.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
function owner() {
  const admitted: Promise<unknown>[] = [];
  let complete = false;
  const options: LlmInvocationOptions = {
    retainWork: (factory) => {
      const raw = factory();
      admitted.push(raw);
      void raw.then(() => {
        complete = true;
      });
      return raw;
    },
  };
  return { options, admitted, complete: () => complete };
}
const request = (text: string, signal?: AbortSignal): LlmRequest => ({
  model: 'custom-text',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  ...(signal === undefined ? {} : { signal }),
});
const jsonReply = JSON.stringify({
  id: 'c',
  object: 'chat.completion',
  created: 0,
  model: 'custom-text',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});
function hop(bytes: string | Uint8Array, mime = 'application/json'): HopResponse {
  return {
    status: 200,
    location: undefined,
    headers: { 'content-type': mime },
    body: (async function* () {
      await Promise.resolve();
      yield typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
    })(),
    dispose() {},
  };
}
function adapterFor(deps: EgressDeps) {
  return createOpenAiAdapter({
    baseURL: 'https://fixture.example/v1',
    fetch: createValidatedFetch(deps),
  });
}

describe('actual OpenAI SDK invocation-local validated transport', () => {
  it.each([false, true])(
    'refuses opaque ownership transfer before any SDK fetch (post entry=%s)',
    async (post) => {
      let reflected = 0;
      let calls = 0;
      let admitted: Promise<unknown> | undefined;
      const opaque = new Proxy(new Error('opaque host refusal'), {
        get() {
          reflected += 1;
          throw new Error('reflection');
        },
        getPrototypeOf() {
          reflected += 1;
          throw new Error('reflection');
        },
      });
      const adapter = adapterFor({
        resolveHost: () => {
          calls += 1;
          return Promise.resolve(['93.184.216.34']);
        },
        openConnection: () => {
          calls += 1;
          return Promise.resolve(hop(jsonReply));
        },
      });
      let seen: unknown;
      try {
        await adapter.generate(request('one'), 'fixture-key', {
          retainWork: (factory) => {
            if (post) admitted = factory();
            throw opaque;
          },
        });
      } catch (error) {
        seen = error;
      }
      expect(Object.is(seen, opaque)).toBe(true);
      expect(reflected).toBe(0);
      expect(calls).toBe(0);
      if (admitted !== undefined) await admitted;
    },
  );

  it('SDK result and headers do not acknowledge the independently retained transport close', async () => {
    const nativeClose = deferred<void>();
    const observed = owner();
    const sent: HopRequest[] = [];
    const adapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (req, _signal, work) => {
        sent.push(req);
        void work?.retainWork?.(() => nativeClose.promise);
        return Promise.resolve(hop(jsonReply));
      },
    });
    const result = await adapter.generate(request('one'), 'fixture-key', observed.options);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(observed.admitted).toHaveLength(1);
    expect(observed.complete()).toBe(false);
    expect(JSON.stringify(sent)).not.toMatch(/retainWork|hostCallOptions|LlmInvocationOptions/);
    nativeClose.resolve();
    await Promise.all(observed.admitted);
    expect(observed.complete()).toBe(true);
  });

  it('same-adapter sibling succeeds while cancelled raw DNS remains owned and cannot dial later', async () => {
    const dns = deferred<readonly string[]>();
    const entered = deferred<void>();
    const a = owner();
    const b = owner();
    let resolveCalls = 0;
    let sockets = 0;
    const adapter = adapterFor({
      resolveHost: () => {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          entered.resolve();
          return dns.promise;
        }
        return Promise.resolve(['93.184.216.34']);
      },
      openConnection: () => {
        sockets += 1;
        return Promise.resolve(hop(jsonReply));
      },
    });
    const abort = new AbortController();
    const first = adapter.generate(request('first', abort.signal), 'fixture-key', a.options);
    const settledFirst = first.then(
      () => 'success',
      () => 'cancelled',
    );
    await entered.promise;
    abort.abort();
    expect(await settledFirst).toBe('cancelled');
    expect(a.complete()).toBe(false);
    expect((await adapter.generate(request('second'), 'fixture-key', b.options)).stopReason).toBe(
      'stop',
    );
    await Promise.all(b.admitted);
    expect(b.complete()).toBe(true);
    expect(a.complete()).toBe(false);
    expect(sockets).toBe(1);
    dns.resolve(['93.184.216.34']);
    await Promise.all(a.admitted);
    expect(sockets).toBe(1);
  });

  it('does not transfer or enter an ignored stream, and a consumed SDK stream still owes native close', async () => {
    const nativeClose = deferred<void>();
    const observed = owner();
    let sockets = 0;
    const sse =
      'data: ' +
      JSON.stringify({
        id: 'c',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      }) +
      '\n\n' +
      'data: ' +
      JSON.stringify({
        id: 'c',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }) +
      '\n\ndata: [DONE]\n\n';
    const adapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_req, _signal, work) => {
        sockets += 1;
        void work?.retainWork?.(() => nativeClose.promise);
        return Promise.resolve(hop(sse, 'text/event-stream'));
      },
    });
    adapter.stream(request('ignored'), 'fixture-key', observed.options);
    await tick();
    expect(observed.admitted).toHaveLength(0);
    expect(sockets).toBe(0);
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter.stream(request('consumed'), 'fixture-key', observed.options))
      chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe('stop');
    expect(observed.complete()).toBe(false);
    nativeClose.resolve();
    await Promise.all(observed.admitted);
  });

  it.each(['image', 'audio', 'video'] as const)(
    'separate-endpoint %s keeps native transport lifetime outside its request body',
    async (modality) => {
      const close = deferred<void>();
      const observed = owner();
      const sent: HopRequest[] = [];
      const bytes =
        modality === 'image'
          ? JSON.stringify({ created: 0, data: [{ b64_json: 'aGk=' }] })
          : modality === 'video'
            ? JSON.stringify({ id: 'video_fixture', status: 'queued' })
            : new Uint8Array([1, 2, 3]);
      const adapter = adapterFor({
        resolveHost: () => Promise.resolve(['93.184.216.34']),
        openConnection: (req, _signal, work) => {
          sent.push(req);
          void work?.retainWork?.(() => close.promise);
          return Promise.resolve(
            hop(bytes, modality === 'audio' ? 'audio/mpeg' : 'application/json'),
          );
        },
      });
      const req: MediaGenRequest = {
        model: modality === 'image' ? 'gpt-image-1' : modality === 'audio' ? 'tts-1' : 'sora-2',
        modality,
        prompt: 'synthetic fixture',
      };
      const result = await adapter.generateMedia?.(req, 'fixture-key', observed.options);
      expect(result).toBeDefined();
      expect(result?.media !== undefined || result?.jobId !== undefined).toBe(true);
      expect(observed.complete()).toBe(false);
      expect(JSON.stringify(sent)).not.toMatch(/retainWork|hostCallOptions|LlmInvocationOptions/);
      if (modality === 'video')
        expect(sent[0]?.headers?.['content-type']).toContain('multipart/form-data; boundary=');
      close.resolve();
      await Promise.all(observed.admitted);
    },
  );

  it('completed Sora status and binary download share one invocation while each native close stays owed', async () => {
    await Promise.resolve();
    const statusClose = deferred<void>();
    const downloadClose = deferred<void>();
    const observed = owner();
    const paths: string[] = [];
    const adapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (req, _signal, work) => {
        paths.push(new URL(req.url).pathname);
        const isDownload = new URL(req.url).pathname.endsWith('/content');
        void work?.retainWork?.(() => (isDownload ? downloadClose.promise : statusClose.promise));
        return Promise.resolve(
          isDownload
            ? hop(new Uint8Array([0, 1, 2]), 'video/mp4')
            : hop(JSON.stringify({ id: 'video_fixture', status: 'completed' })),
        );
      },
    });
    // The opaque id comes from the actual adapter's own submit path rather than duplicating its codec.
    const submitAdapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: () =>
        Promise.resolve(hop(JSON.stringify({ id: 'video_fixture', status: 'queued' }))),
    });
    const submission = await submitAdapter.generateMedia?.(
      { model: 'sora-2', modality: 'video', prompt: 'fixture' },
      'fixture-key',
    );
    if (submission?.jobId === undefined) throw new Error('fixture submission has no job');
    const result = await adapter.pollMediaJob?.(
      submission.jobId,
      'fixture-key',
      undefined,
      observed.options,
    );
    expect(result?.state).toBe('done');
    expect(paths).toHaveLength(2);
    expect(observed.admitted).toHaveLength(1);
    expect(observed.complete()).toBe(false);
    statusClose.resolve();
    await tick();
    expect(observed.complete()).toBe(false);
    downloadClose.resolve();
    await Promise.all(observed.admitted);
  });
  it('SDK stream return settles publicly while exact body next, return and transport close stay owed', async () => {
    const nativeClose = deferred<void>();
    const next = deferred<IteratorResult<Uint8Array>>();
    const returned = deferred<IteratorResult<Uint8Array>>();
    const entered = deferred<void>();
    const observed = owner();
    let nextCalls = 0;
    let returns = 0;
    let disposals = 0;
    const adapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_req, _signal, work) => {
        void work?.retainWork?.(() => nativeClose.promise);
        return Promise.resolve({
          status: 200,
          location: undefined,
          headers: { 'content-type': 'text/event-stream' },
          body: {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                nextCalls += 1;
                entered.resolve();
                return next.promise;
              },
              return: () => {
                returns += 1;
                return returned.promise;
              },
            }),
          },
          dispose: () => {
            disposals += 1;
          },
        });
      },
    });
    const iterator = adapter
      .stream(request('held'), 'fixture-key', observed.options)
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await entered.promise;
    const closing = iterator.return?.();
    await pending;
    await closing;
    expect(returns).toBe(1);
    expect(disposals).toBe(1);
    expect(observed.complete()).toBe(false);
    nativeClose.resolve();
    await tick();
    expect(observed.complete()).toBe(false);
    returned.resolve({ done: true, value: undefined });
    await tick();
    expect(observed.complete()).toBe(false);
    next.resolve({ done: false, value: new TextEncoder().encode('late untrusted bytes') });
    await Promise.all(observed.admitted);
    expect(nextCalls).toBe(1);
    expect(returns).toBe(1);
  });

  it('captures the lazy stream retainer and its receiver at call time', async () => {
    const a = owner();
    const b = owner();
    const options = {
      owner: a,
      retainWork<T>(factory: () => Promise<T>): Promise<T> {
        return this.owner.options.retainWork(factory);
      },
    };
    const adapter = adapterFor({
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: () =>
        Promise.resolve(
          hop(
            'data: ' +
              JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
              '\n\ndata: [DONE]\n\n',
            'text/event-stream',
          ),
        ),
    });
    const stream = adapter.stream(request('captured'), 'fixture-key', options);
    // The function itself must be captured; mutating a separately referenced receiver state is
    // still the trusted host's own behavior, so keep that receiver and replace only the property.
    options.retainWork = b.options.retainWork;
    const chunks: StreamChunk[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.at(-1)?.type).toBe('stop');
    expect(a.admitted).toHaveLength(1);
    expect(b.admitted).toHaveLength(0);
    await Promise.all(a.admitted);
  });
  it('retirement during a real SDK HTTP error body cannot learn or retry a rejected parameter', async () => {
    const body = deferred<void>();
    const entered = deferred<void>();
    const observed = owner();
    let calls = 0;
    const sent: string[] = [];
    const adapter = createOpenAiAdapter({
      baseURL: 'https://retirement-fixture.example/v1',
      fetch: (_input, init) => {
        calls += 1;
        sent.push(typeof init?.body === 'string' ? init.body : '');
        if (calls !== 1)
          return Promise.resolve(
            new Response(jsonReply, { headers: { 'content-type': 'application/json' } }),
          );
        const response = new Response(null, {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
        Object.defineProperty(response, 'text', {
          value: async () => {
            entered.resolve();
            await body.promise;
            return JSON.stringify({
              error: {
                message: "Unsupported parameter: 'temperature'",
                param: 'temperature',
                code: 'unsupported_parameter',
              },
            });
          },
        });
        return Promise.resolve(response);
      },
    });
    const abort = new AbortController();
    const pending = adapter.generate(
      { ...request('retired', abort.signal), temperature: 0.4 },
      'fixture-key',
      observed.options,
    );
    const terminal = pending.then(
      () => 'success',
      () => 'cancelled',
    );
    await entered.promise;
    abort.abort();
    expect(observed.complete()).toBe(false);
    body.resolve();
    expect(await terminal).toBe('cancelled');
    await Promise.all(observed.admitted);
    expect(calls).toBe(1);
    await adapter.generate(
      { ...request('fresh'), temperature: 0.4 },
      'fixture-key',
      owner().options,
    );
    expect(calls).toBe(2);
    expect(JSON.parse(sent[1] ?? '{}')).toMatchObject({ temperature: 0.4 });
  });
});
