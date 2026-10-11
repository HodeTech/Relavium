import { describe, expect, it, vi } from 'vitest';

import {
  createExchangeReplay,
  ExchangeReplayError,
  recordExchangeFetch,
  type ExpectedExchange,
  type JsonValue,
  type RequestProjection,
} from './exchange-replay.js';
import type { FetchLike } from './replay.js';

const URL_VALUE = 'https://provider.example/v1/messages?mode=test';
const RESPONSE = { status: 200, contentType: 'application/json', body: '{"ok":true}' };

function request(
  value: JsonValue = { model: 'synthetic', messages: ['hello'] },
): RequestProjection {
  return {
    method: 'POST',
    origin: 'https://provider.example',
    path: '/v1/messages',
    query: '?mode=test',
    headers: { 'content-type': 'application/json' },
    body: { kind: 'json', value },
  };
}
function fixture(projected = request(), body = RESPONSE.body): ExpectedExchange {
  return { request: projected, response: { ...RESPONSE, body } };
}
function init(body = '{"model":"synthetic","messages":["hello"]}'): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('uninitialized test deferred');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function delayedRequest(body: string) {
  const ready = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      await ready.promise;
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  const options: RequestInit = { ...init(), body: stream, duplex: 'half' };
  return { request: new Request(URL_VALUE, options), ready };
}
async function refusal(promise: Promise<unknown>, reason: string, ordinal = 1) {
  await expect(promise).rejects.toMatchObject({
    name: 'ExchangeReplayError',
    code: 'exchange_replay',
    reason,
    ordinal,
  });
}

describe('strict expected exchange replay', () => {
  it.each(['string', 'URL', 'Request'])(
    'matches effective %s input without network',
    async (kind) => {
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('network forbidden'));
      try {
        const replay = createExchangeReplay([fixture()]);
        const input =
          kind === 'string'
            ? URL_VALUE
            : kind === 'URL'
              ? new URL(URL_VALUE)
              : new Request(URL_VALUE, init());
        const response = await replay.fetch(input, kind === 'Request' ? undefined : init());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        replay.assertConsumed();
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    },
  );

  it('inherits Request body with an explicitly undefined init.body', async () => {
    const replay = createExchangeReplay([fixture()]);
    const options = Object.defineProperty(
      { headers: { 'content-type': 'application/json' } },
      'body',
      { value: undefined },
    );
    await replay.fetch(new Request(URL_VALUE, init()), options);
    replay.assertConsumed();
  });

  it('projects each documented protocol header with native casing and trimming', async () => {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'synthetic-beta',
      'openai-beta': 'synthetic-beta',
    };
    const replay = createExchangeReplay([fixture({ ...request(), headers })]);
    await replay.fetch(URL_VALUE, {
      ...init(),
      headers: {
        Accept: ' application/json ',
        'Content-Type': ' application/json ',
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'synthetic-beta',
        'OpenAI-Beta': 'synthetic-beta',
      },
    });
    replay.assertConsumed();
  });

  it('sanitizes hostile expectation-array property access without invoking accessors', () => {
    const exchanges: ExpectedExchange[] = [];
    Object.defineProperty(exchanges, '0', {
      get() {
        throw new Error('planted-private-value');
      },
      enumerable: true,
    });
    expect(() => createExchangeReplay(exchanges)).toThrow('invalid_expectation');
    expect(() => createExchangeReplay(exchanges)).not.toThrow('planted-private-value');
  });

  it('uses native method/body/header overrides on Request input', async () => {
    const replay = createExchangeReplay([fixture()]);
    const inherited = new Request(URL_VALUE, {
      method: 'PUT',
      body: '{"wrong":true}',
      headers: { accept: 'wrong', 'content-type': 'wrong' },
    });
    await replay.fetch(inherited, init());
    replay.assertConsumed();
  });

  it.each([null, undefined])(
    'inherits Request body with init.body=%s and replaces inherited headers',
    async (body) => {
      const replay = createExchangeReplay([fixture()]);
      const input = new Request(URL_VALUE, {
        ...init(),
        headers: { accept: 'wrong', 'content-type': 'wrong' },
      });
      await replay.fetch(input, {
        headers: { 'content-type': 'application/json' },
        ...(body === null ? { body: null } : {}),
      });
      replay.assertConsumed();
    },
  );

  it('compares object keys structurally, retains prototype-named and unknown keys', async () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":1},"constructor":false,"unknown":2}');
    // JSON.parse is an unknown boundary; the harness guard owns it before matching.
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response('{}')));
    await recorder.fetch(URL_VALUE, init(JSON.stringify(value)));
    const recorded = recorder.exchanges[0];
    expect(recorded).toBeDefined();
    if (recorded === undefined) throw new Error('missing test record');
    const replay = createExchangeReplay([recorded]);
    await replay.fetch(URL_VALUE, init('{"unknown":2,"constructor":false,"__proto__":{"x":1}}'));
    replay.assertConsumed();
  });

  it('ignores JSON object property order against a static expectation', async () => {
    const replay = createExchangeReplay([fixture()]);
    await replay.fetch(URL_VALUE, init('{"messages":["hello"],"model":"synthetic"}'));
    replay.assertConsumed();
  });

  const differences: readonly [string, string, RequestInit, RequestProjection?][] = [
    ['method', URL_VALUE, { ...init(), method: 'PUT' }],
    ['origin', 'https://elsewhere.example/v1/messages?mode=test', init()],
    ['path', 'https://provider.example/v1/other?mode=test', init()],
    ['query value', 'https://provider.example/v1/messages?mode=other', init()],
    ['query extra', `${URL_VALUE}&extra=1`, init()],
    ['query encoding', 'https://provider.example/v1/messages?mode=%74est', init()],
    ['header value', URL_VALUE, { ...init(), headers: { 'content-type': 'text/plain' } }],
    [
      'header extra',
      URL_VALUE,
      { ...init(), headers: { 'content-type': 'application/json', accept: 'application/json' } },
    ],
    ['header missing', URL_VALUE, { ...init(), headers: {} }],
    ['body value', URL_VALUE, init('{"model":"changed","messages":["hello"]}')],
    ['body extra key', URL_VALUE, init('{"model":"synthetic","messages":["hello"],"extra":null}')],
    ['body missing key', URL_VALUE, init('{"model":"synthetic"}')],
    ['array order', URL_VALUE, init('{"items":[2,1]}'), request({ items: [1, 2] })],
    ['array length', URL_VALUE, init('{"items":[1,2,3]}'), request({ items: [1, 2] })],
    ['prototype key', URL_VALUE, init('{"__proto__":1}'), request({})],
  ];
  it.each(differences)(
    'refuses %s mismatch and remains failed after rejection is caught',
    async (_name, url, options, projected) => {
      const replay = createExchangeReplay([fixture(projected ?? request())]);
      await refusal(replay.fetch(url, options), 'request_mismatch');
      expect(() => replay.assertConsumed()).toThrow(ExchangeReplayError);
      expect(() => replay.assertConsumed()).toThrow('request_mismatch');
    },
  );

  it('matches no body and keeps JSON null distinct', async () => {
    const noBody = {
      ...request(),
      method: 'GET',
      headers: {},
      body: { kind: 'none' },
    } satisfies RequestProjection;
    const replay = createExchangeReplay([fixture(noBody), fixture(request(null))]);
    await replay.fetch(URL_VALUE);
    await replay.fetch(URL_VALUE, init('null'));
    replay.assertConsumed();
    await refusal(
      createExchangeReplay([fixture({ ...request(), body: { kind: 'none' } })]).fetch(
        URL_VALUE,
        init('null'),
      ),
      'request_mismatch',
    );
    await refusal(
      createExchangeReplay([fixture(request(null))]).fetch(URL_VALUE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
      'request_mismatch',
    );
  });

  it.each(['', 'plain text', '{', '1e999'])(
    'refuses empty/non-JSON/nonfinite body %j',
    async (body) => {
      await refusal(createExchangeReplay([fixture()]).fetch(URL_VALUE, init(body)), 'invalid_json');
    },
  );

  it('requires every expected exchange exactly once', async () => {
    const replay = createExchangeReplay([fixture(), fixture(request({ turn: 2 }), '{"turn":2}')]);
    expect(() => replay.assertConsumed()).toThrow('under_consumed');
    await replay.fetch(URL_VALUE, init());
    expect(() => replay.assertConsumed()).toThrow('under_consumed');
    const response = await replay.fetch(URL_VALUE, init('{"turn":2}'));
    expect(await response.json()).toEqual({ turn: 2 });
    replay.assertConsumed();
    await refusal(replay.fetch(URL_VALUE, init()), 'over_consumed', 3);
    expect(() => replay.assertConsumed()).toThrow('over_consumed');
  });

  it('reserves replay order at call entry and refuses assertion while body inspection is pending', async () => {
    const first = delayedRequest('{"turn":1}');
    const replay = createExchangeReplay([
      fixture(request({ turn: 1 }), '{"reply":1}'),
      fixture(request({ turn: 2 }), '{"reply":2}'),
    ]);
    const pending = replay.fetch(first.request);
    const second = await replay.fetch(URL_VALUE, init('{"turn":2}'));
    expect(await second.json()).toEqual({ reply: 2 });
    expect(() => replay.assertConsumed()).toThrow('in_flight');
    first.ready.resolve();
    expect(await (await pending).json()).toEqual({ reply: 1 });
    replay.assertConsumed();
  });

  it('does not let an already-pending valid call erase a concurrent failure', async () => {
    const first = delayedRequest('{"turn":1}');
    const replay = createExchangeReplay([
      fixture(request({ turn: 1 })),
      fixture(request({ turn: 2 })),
    ]);
    const pending = replay.fetch(first.request);
    const rejected = expect(pending).rejects.toMatchObject({
      reason: 'request_mismatch',
      ordinal: 2,
    });
    await refusal(replay.fetch(URL_VALUE, init('{"wrong":2}')), 'request_mismatch', 2);
    first.ready.resolve();
    await rejected;
    expect(() => replay.assertConsumed()).toThrow('request_mismatch');
  });

  it('owns expectations at construction, including nested JSON and response', async () => {
    const value = { nested: { items: ['original'] } };
    const projected = { ...request(value), headers: { 'content-type': 'application/json' } };
    const response = { ...RESPONSE };
    const exchanges = [{ request: projected, response }];
    const replay = createExchangeReplay(exchanges);
    value.nested.items[0] = 'mutated';
    projected.headers['content-type'] = 'wrong';
    response.body = '{"wrong":true}';
    exchanges.length = 0;
    expect(
      await (await replay.fetch(URL_VALUE, init('{"nested":{"items":["original"]}}'))).json(),
    ).toEqual({ ok: true });
    replay.assertConsumed();
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    () => 'x',
    Symbol('x'),
    new Date(),
    [undefined],
    Array.from({ length: 1 }),
    { nested: undefined },
  ])('rejects lossy expectation JSON before it can be coerced: %s', (value) => {
    const invalid = { ...fixture(), request: { ...request(), body: { kind: 'json', value } } };
    // Intentionally invoke the runtime trust boundary with an invalid statically typed fixture.
    // @ts-expect-error The test verifies values the JsonValue type prevents callers from supplying.
    expect(() => createExchangeReplay([invalid])).toThrow('invalid_json');
  });

  it('rejects sparse, cyclic, accessor and symbol-bearing expectations', () => {
    const sparse: JsonValue[] = [];
    sparse.length = 1;
    const cyclic: { value?: JsonValue } = {};
    cyclic.value = cyclic;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        throw new Error('must not run getter');
      },
    });
    const symbol = { [Symbol('extra')]: 'hidden' };
    for (const value of [sparse, cyclic, accessor, symbol]) {
      expect(() => createExchangeReplay([fixture(request(value))])).toThrow('invalid_json');
    }
  });

  it('rejects invalid/extra projection fields without silently stripping them', () => {
    const extra = { ...fixture(), extra: true };
    expect(() => createExchangeReplay([extra])).toThrow('invalid_expectation');
    expect(() =>
      createExchangeReplay([fixture({ ...request(), headers: { authorization: 'test' } })]),
    ).toThrow('unsafe_content');
    expect(() =>
      createExchangeReplay([fixture({ ...request(), headers: { 'sdk-agent': 'test' } })]),
    ).toThrow('invalid_expectation');
  });
});

describe('credential-safe projection and diagnostics', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnop1234';

  it('rejects decoded secrets in expected paths', () => {
    const encodedPath = '/sk-ant-%73ynthetic-private-123456789';
    expect(() => createExchangeReplay([fixture({ ...request(), path: encodedPath })])).toThrow(
      'unsafe_content',
    );
  });

  for (const newline of ['\n', '\r\n', '\r']) {
    it.each(['expectation', 'recording'])(
      `refuses assembled credential-bearing SSE with ${JSON.stringify(newline)} framing: %s`,
      async (entry) => {
        const body = [
          ': synthetic comment',
          'event: message',
          'data: {"api_key":',
          'data: "opaque-synthetic-credential"}',
          '',
          '',
        ].join(newline);
        const recorder = recordExchangeFetch(() =>
          Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
        );
        const attempt =
          entry === 'expectation'
            ? Promise.resolve().then(() => createExchangeReplay([fixture(request(), body)]))
            : recorder.fetch(URL_VALUE, init());
        await refusal(attempt, 'unsafe_content');
        expect(recorder.exchanges).toEqual([]);
      },
    );

    it(`preserves safe assembled SSE text with ${JSON.stringify(newline)} framing`, async () => {
      const body = [
        ': ignored comment',
        'event: message',
        'data: {"ok":',
        ': another comment',
        'data: true,"signature":"synthetic-signature"}',
        '',
        '',
      ].join(newline);
      const response = { status: 200, contentType: 'text/event-stream', body };
      const recorder = recordExchangeFetch(() =>
        Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
      );
      expect(await (await recorder.fetch(URL_VALUE, init())).text()).toBe(body);
      expect(recorder.exchanges[0]?.response).toEqual(response);
      const replay = createExchangeReplay([{ request: request(), response }]);
      expect(await (await replay.fetch(URL_VALUE, init())).text()).toBe(body);
      replay.assertConsumed();
    });
  }

  it('checks BOM-prefixed trailing SSE data without a final separator', async () => {
    const body = '\uFEFFdata: {"password":\ndata: "opaque-synthetic-credential"}';
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response(body)));
    await refusal(recorder.fetch(URL_VALUE, init()), 'unsafe_content');
    expect(() => createExchangeReplay([fixture(request(), body)])).toThrow('unsafe_content');
    expect(recorder.exchanges).toEqual([]);
  });

  it('checks JSON after native UTF-8 BOM decoding at both entry points', async () => {
    const body = '\uFEFF{"api_key":"opaque-synthetic-credential"}';
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response(body)));
    await refusal(recorder.fetch(URL_VALUE, init()), 'unsafe_content');
    expect(() => createExchangeReplay([fixture(request(), body)])).toThrow('unsafe_content');
    expect(recorder.exchanges).toEqual([]);
  });

  it('excludes authentication/volatile headers, credential query parameters and URL fragments', async () => {
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response('{}')));
    await recorder.fetch(`${URL_VALUE}&api_key=${secret}&access-token=opaque#${secret}`, {
      ...init(),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
        cookie: 'secret cookie',
        'x-api-key': secret,
        'user-agent': secret,
        'x-stainless-retry-count': '1',
      },
    });
    expect(recorder.exchanges[0]?.request).toEqual(request());
    expect(JSON.stringify(recorder.exchanges)).not.toContain(secret);
    const replay = createExchangeReplay([fixture()]);
    await replay.fetch(`${URL_VALUE}&%61pi-key=${secret}`, {
      ...init(),
      headers: { 'content-type': 'application/json', 'x-api-key': secret },
    });
    replay.assertConsumed();
  });

  it.each([
    'key',
    'api_key',
    'api-key',
    'x-api-key',
    'access_token',
    'token',
    'auth-token',
    'authorization',
    'password',
    'client_secret',
    'signature',
    'sig',
  ])('omits named credential URL parameter %s', async (name) => {
    const replay = createExchangeReplay([fixture()]);
    await replay.fetch(`${URL_VALUE}&${name}=${secret}`, init());
    replay.assertConsumed();
  });

  it('preserves noncredential query order, duplicates, separators and exact encoding', async () => {
    const query = '?b=2&a=%20&a=+&&empty=';
    const replay = createExchangeReplay([fixture({ ...request(), query })]);
    await replay.fetch(`https://provider.example/v1/messages${query}&key=${secret}`, init());
    replay.assertConsumed();
    await refusal(
      createExchangeReplay([fixture({ ...request(), query })]).fetch(
        'https://provider.example/v1/messages?a=%20&b=2&a=+&&empty=',
        init(),
      ),
      'request_mismatch',
    );
  });

  it.each([
    ['body', URL_VALUE, init(`{"leak":"${secret}"}`)],
    ['credential field', URL_VALUE, init('{"api_key":"opaque-credential"}')],
    ['protocol header', URL_VALUE, { ...init(), headers: { 'content-type': secret } }],
    ['path', `https://provider.example/${secret}?mode=test`, init()],
    ['query', `${URL_VALUE}&prompt=${secret}`, init()],
    ['encoded query', `${URL_VALUE}&prompt=${encodeURIComponent(secret)}`, init()],
  ])(
    'refuses planted %s secrets without diagnostics or records retaining values',
    async (_label, url, options) => {
      const real = vi.fn<FetchLike>(() => Promise.resolve(new Response('{}')));
      const recorder = recordExchangeFetch(real);
      await refusal(recorder.fetch(url, options), 'unsafe_content');
      expect(recorder.exchanges).toEqual([]);
      expect(real).not.toHaveBeenCalled();
      const replay = createExchangeReplay([fixture()]);
      try {
        await replay.fetch(url, options);
        throw new Error('missing refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(ExchangeReplayError);
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain('opaque-credential');
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(error).not.toHaveProperty('cause');
      }
    },
  );

  it('rejects URL userinfo and malformed input without native diagnostic leakage', async () => {
    for (const url of [`https://user:${secret}@provider.example/v1/messages`, `bad ${secret}`]) {
      const recorder = recordExchangeFetch(() => Promise.resolve(new Response('{}')));
      await refusal(recorder.fetch(url), 'invalid_request');
      expect(recorder.exchanges).toEqual([]);
      const replay = createExchangeReplay([fixture()]);
      try {
        await replay.fetch(url);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(error).not.toHaveProperty('cause');
      }
    }
  });

  it.each([
    `{"leak":"${secret}"}`,
    '{"api_key":"opaque-key"}',
    `data: {"password":"opaque-key"}\n\n`,
  ])('refuses unsafe response before any complete exchange is recorded', async (body) => {
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response(body)));
    await refusal(recorder.fetch(URL_VALUE, init()), 'unsafe_content');
    expect(recorder.exchanges).toEqual([]);
    expect(() => createExchangeReplay([fixture(request(), body)])).toThrow('unsafe_content');
  });

  it('refuses unsafe response content type and invalid expected response status', async () => {
    const recorder = recordExchangeFetch(() =>
      Promise.resolve(new Response('{}', { headers: { 'content-type': secret } })),
    );
    await refusal(recorder.fetch(URL_VALUE, init()), 'unsafe_content');
    expect(recorder.exchanges).toEqual([]);
    expect(() =>
      createExchangeReplay([{ request: request(), response: { status: 900, body: '{}' } }]),
    ).toThrow('invalid_response');
  });

  it('sanitizes network and stream exceptions, never stores partial exchanges', async () => {
    const recorder = recordExchangeFetch(() => Promise.reject(new Error(secret)));
    await refusal(recorder.fetch(URL_VALUE, init()), 'network_failure');
    expect(recorder.exchanges).toEqual([]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(secret));
      },
    });
    const responseRecorder = recordExchangeFetch(() => Promise.resolve(new Response(stream)));
    await refusal(responseRecorder.fetch(URL_VALUE, init()), 'invalid_response');
    expect(responseRecorder.exchanges).toEqual([]);
    const options: RequestInit = {
      ...init(),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error(secret));
        },
      }),
      duplex: 'half',
    };
    const requestRecorder = recordExchangeFetch(() => Promise.resolve(new Response('{}')));
    await refusal(requestRecorder.fetch(URL_VALUE, options), 'invalid_request');
    expect(requestRecorder.exchanges).toEqual([]);
  });

  it('keeps caught sticky diagnostics immutable and content-free', async () => {
    const replay = createExchangeReplay([fixture()]);
    let caught: unknown;
    try {
      await replay.fetch(URL_VALUE, init('{}'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExchangeReplayError);
    expect(Object.isFrozen(caught)).toBe(true);
    if (!(caught instanceof ExchangeReplayError)) throw new Error('missing refusal');
    expect(() => Object.defineProperty(caught, 'message', { value: secret })).toThrow();
    expect(() => Object.defineProperty(caught, 'cause', { value: secret })).toThrow();
    expect(() => replay.assertConsumed()).toThrow('request_mismatch');
    await expect(replay.fetch(URL_VALUE, init())).rejects.not.toThrow(secret);
  });

  it.each([204, 205, 304])(
    'supports empty bodyless response status %s and refuses payloads',
    async (status) => {
      const replay = createExchangeReplay([{ request: request(), response: { status, body: '' } }]);
      const response = await replay.fetch(URL_VALUE, init());
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      replay.assertConsumed();
      expect(() =>
        createExchangeReplay([{ request: request(), response: { status, body: '{}' } }]),
      ).toThrow('invalid_response');
      const recorder = recordExchangeFetch(() => Promise.resolve(new Response(null, { status })));
      await recorder.fetch(URL_VALUE, init());
      expect(recorder.exchanges[0]?.response).toEqual({ status, body: '' });
    },
  );

  it('permits synthetic thinking signatures as protocol data', async () => {
    const replay = createExchangeReplay([fixture(request({ signature: 'synthetic-signature' }))]);
    await replay.fetch(URL_VALUE, init('{"signature":"synthetic-signature"}'));
    replay.assertConsumed();
  });
});

describe('owned exchange recording', () => {
  it.each(['string', 'URL', 'Request'])('records effective %s input', async (kind) => {
    const recorder = recordExchangeFetch(() =>
      Promise.resolve(
        new Response(RESPONSE.body, { headers: { 'content-type': 'application/json' } }),
      ),
    );
    const input =
      kind === 'string'
        ? URL_VALUE
        : kind === 'URL'
          ? new URL(URL_VALUE)
          : new Request(URL_VALUE, init());
    await recorder.fetch(input, kind === 'Request' ? undefined : init());
    expect(recorder.exchanges).toEqual([fixture()]);
  });

  it('forwards the same effective authenticated Request with an unread body and signal', async () => {
    const controller = new AbortController();
    const real = vi.fn<FetchLike>(async (input, options) => {
      expect(input).toBeInstanceOf(Request);
      expect(options).toBeUndefined();
      if (!(input instanceof Request)) throw new Error('expected native Request');
      expect(input.bodyUsed).toBe(false);
      expect(input.headers.get('authorization')).toBe('Bearer synthetic-credential');
      expect(input.headers.get('x-api-key')).toBe('synthetic-credential');
      expect(await input.json()).toEqual({ model: 'synthetic', messages: ['hello'] });
      controller.abort();
      expect(input.signal.aborted).toBe(true);
      return new Response(RESPONSE.body, { headers: { 'content-type': 'application/json' } });
    });
    const recorder = recordExchangeFetch(real);
    const response = await recorder.fetch(
      new Request(URL_VALUE, { ...init(), signal: controller.signal }),
      {
        headers: {
          authorization: 'Bearer synthetic-credential',
          'x-api-key': 'synthetic-credential',
          'content-type': 'application/json',
        },
      },
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(recorder.exchanges).toEqual([fixture()]);
    expect(JSON.stringify(recorder.exchanges)).not.toContain('synthetic-credential');
  });

  it('records completed successes in call-entry order, even when response completion is reversed', async () => {
    const first = deferred<Response>();
    let count = 0;
    const recorder = recordExchangeFetch(() =>
      ++count === 1 ? first.promise : Promise.resolve(new Response('{"reply":2}')),
    );
    const pending = recorder.fetch(URL_VALUE, init('{"turn":1}'));
    // Wait for the first network entry, without depending on clone-body scheduling.
    await vi.waitFor(() => expect(count).toBe(1));
    await recorder.fetch(URL_VALUE, init('{"turn":2}'));
    const priorSnapshot = recorder.exchanges;
    first.resolve(new Response('{"reply":1}'));
    await pending;
    expect(recorder.exchanges.map((exchange) => exchange.response.body)).toEqual([
      '{"reply":1}',
      '{"reply":2}',
    ]);
    expect(priorSnapshot).toHaveLength(1);
  });

  it('preserves recorder call-entry order across asynchronous body inspection', async () => {
    const first = delayedRequest('{"turn":1}');
    const recorder = recordExchangeFetch(async (input) => {
      const parsed: unknown = await new Request(input).json();
      return new Response(JSON.stringify(parsed));
    });
    const pending = recorder.fetch(first.request);
    await recorder.fetch(URL_VALUE, init('{"turn":2}'));
    first.ready.resolve();
    await pending;
    expect(recorder.exchanges.map((exchange) => exchange.response.body)).toEqual([
      '{"turn":1}',
      '{"turn":2}',
    ]);
  });

  it('freezes exposed snapshots and every nested record, preventing mutable aliases', async () => {
    const recorder = recordExchangeFetch(() => Promise.resolve(new Response('{}')));
    await recorder.fetch(URL_VALUE, init('{"nested":{"items":[1,2]}}'));
    const snapshot = recorder.exchanges;
    const exchange = snapshot[0];
    expect(exchange).toBeDefined();
    if (exchange === undefined || exchange.request.body.kind !== 'json')
      throw new Error('missing record');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(exchange)).toBe(true);
    expect(Object.isFrozen(exchange.request)).toBe(true);
    expect(Object.isFrozen(exchange.request.headers)).toBe(true);
    expect(Object.isFrozen(exchange.request.body)).toBe(true);
    expect(Object.isFrozen(exchange.request.body.value)).toBe(true);
    expect(Object.isFrozen(exchange.response)).toBe(true);
    expect(() => Object.defineProperty(exchange.response, 'body', { value: 'mutated' })).toThrow();
    const bodyValue = exchange.request.body.value;
    expect(() => Object.defineProperty(bodyValue, 'nested', { value: 'mutated' })).toThrow();
    expect(recorder.exchanges[0]).toEqual(exchange);
  });
});
