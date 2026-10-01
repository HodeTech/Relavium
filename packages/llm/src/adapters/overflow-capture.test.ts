import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_MAX_INPUT_CHARACTERS,
  CAPTURE_MAX_RESPONSE_BYTES,
  CAPTURE_TIMEOUT_MS,
  captureRequest,
  captureResponse,
  parseCaptureArguments,
  validateCaptureKey,
  type CaptureDependencies,
} from './overflow-capture.js';

const KEY = 'capture-test-key-12345';
const DATE = '2026-10-02T03:00:00.000Z';
const args = [
  '--provider',
  'anthropic',
  '--model',
  'claude-example',
  '--input-chars',
  '1024',
  '--out',
  'capture.json',
];
const options = parseCaptureArguments(args);
const jsonResponse = (
  body = '{"error":{"message":"synthetic overflow"}}',
  status = 400,
): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const dependencies = (fetch: CaptureDependencies['fetch']): CaptureDependencies => ({
  fetch,
  newAbortController: () => new AbortController(),
  setTimer: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
  now: () => DATE,
});

describe('maintainer overflow capture admission', () => {
  it.each(
    [
      [],
      [...args, '--url', 'https://evil.example'],
      [...args, '--model', 'duplicate'],
      [...args.slice(0, -1)],
      ['--provider', 'unknown', ...args.slice(2)],
      ['--provider', 'gemini', '--model', '../private?key=secret', ...args.slice(4)],
      [...args.slice(0, 5), 'Infinity', ...args.slice(6)],
      [...args.slice(0, 5), '0x1000', ...args.slice(6)],
      [...args.slice(0, 5), String(CAPTURE_MAX_INPUT_CHARACTERS + 1), ...args.slice(6)],
      [...args, '--max-output', '4097'],
      ['--provider', 'openai', ...args.slice(2), '--purpose', 'context-stop-probe'],
      [...args.slice(0, -1), 'file\nwith-control.json'],
      [...args.slice(0, 3), 'sk-ant-abcdefghijklmnopqrstuv', ...args.slice(4)],
    ].map((input) => ({ input })),
  )('refuses invalid/redirecting/ambiguous arguments before capture: $input', ({ input }) => {
    expect(() => parseCaptureArguments(input)).toThrow('invalid_arguments');
  });

  it.each(['', 'two\nkeys', 'short', 'a'.repeat(513), 'has a space'])(
    'refuses invalid key bytes',
    (key) => {
      expect(() => validateCaptureKey(key)).toThrow('invalid_key');
    },
  );

  it.each([
    ['anthropic', 'https://api.anthropic.com/v1/messages', 'max_tokens'],
    ['openai', 'https://api.openai.com/v1/chat/completions', 'max_completion_tokens'],
    ['deepseek', 'https://api.deepseek.com/chat/completions', 'max_tokens'],
    [
      'gemini',
      'https://generativelanguage.googleapis.com/v1beta/models/example:generateContent',
      'maxOutputTokens',
    ],
  ])('pins %s to its own official dialect and explicit output cap', (provider, url, capField) => {
    const selected = parseCaptureArguments([
      '--provider',
      provider,
      '--model',
      'example',
      ...args.slice(4),
    ]);
    const request = captureRequest(selected, KEY);
    expect(request.url).toBe(url);
    expect(request.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(request.url).not.toContain(KEY);
    expect(request.init.body).not.toContain(KEY);
    expect(request.init.body).toContain(`"${capField}":64`);
    expect(request.init.body).not.toContain('tools');
    expect(request.init.body).not.toContain('user content');
  });

  it('revalidates typed callers and prevents a key becoming metadata or a filename', () => {
    expect(() => captureRequest({ ...options, inputCharacters: Infinity }, KEY)).toThrow(
      'invalid_arguments',
    );
    expect(() => captureRequest({ ...options, model: KEY }, KEY)).toThrow('invalid_arguments');
    expect(() => captureRequest({ ...options, out: `${KEY}.json` }, KEY)).toThrow(
      'invalid_arguments',
    );
  });
});

describe('bounded, secret-free live response capture', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retains the exact response/date/model without inventing an overflow classification or auth headers', async () => {
    const body = '{"type":"message","stop_reason":"model_context_window_exceeded"}';
    const fetch = vi.fn(() => Promise.resolve(jsonResponse(body, 200)));
    const artifact = await captureResponse(options, KEY, dependencies(fetch));
    expect(artifact).toMatchObject({
      capturedAt: DATE,
      provider: 'anthropic',
      model: 'claude-example',
      response: { status: 200, body },
    });
    expect(JSON.stringify(artifact)).not.toContain(KEY);
    expect(artifact).not.toHaveProperty('classification');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    JSON.stringify({ error: KEY }),
    JSON.stringify({ [KEY]: 'value' }),
    JSON.stringify({ error: KEY }).replace('capture-', '\\u0063apture-'),
    JSON.stringify({ nested: [{ secret: 'Bearer opaque-token' }] }),
    JSON.stringify({ error: 'Basic dXNlcjpwYXNz' }),
    JSON.stringify({ url: 'https://user:password@example.org/path' }),
    JSON.stringify({ url: 'https://example.org/?token=opaque' }),
    JSON.stringify({ key: 'AIzaabcdefghijklmnopqrstuv12345' }),
    JSON.stringify({ key: 'sk-ant-abcdefghijklmnopqrstuv' }),
  ])('refuses raw/decoded/nested secret material without changing a fixture: %j', async (body) => {
    await expect(
      captureResponse(
        options,
        KEY,
        dependencies(() => Promise.resolve(jsonResponse(body))),
      ),
    ).rejects.toMatchObject({ code: 'secret_in_response' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new Response('not JSON', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/json-malformed' } }),
    new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    new Response(null, { headers: { 'content-type': 'application/json' } }),
  ])('refuses unusable protocol bodies', async (response) => {
    await expect(
      captureResponse(
        options,
        KEY,
        dependencies(() => Promise.resolve(response)),
      ),
    ).rejects.toMatchObject({ code: 'response_not_json' });
  });

  it('bounds the actual bytes even with no trustworthy length header', async () => {
    const body = 'x'.repeat(CAPTURE_MAX_RESPONSE_BYTES + 1);
    await expect(
      captureResponse(
        options,
        KEY,
        dependencies(() => Promise.resolve(jsonResponse(body))),
      ),
    ).rejects.toMatchObject({ code: 'response_limit' });
  });

  it('refuses an oversized declared body before reading it', async () => {
    const response = jsonResponse('{}');
    response.headers.set('content-length', String(CAPTURE_MAX_RESPONSE_BYTES + 1));
    await expect(
      captureResponse(
        options,
        KEY,
        dependencies(() => Promise.resolve(response)),
      ),
    ).rejects.toMatchObject({ code: 'response_limit' });
  });

  it('bounds an endless zero-byte stream so resolved microtasks cannot starve the timer', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array());
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    await expect(
      captureResponse(
        options,
        KEY,
        dependencies(() => Promise.resolve(response)),
      ),
    ).rejects.toMatchObject({ code: 'response_limit' });
  });

  it('hard-races a transport that ignores the signal and never retries', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const result = captureResponse(options, KEY, dependencies(fetch));
    const refused = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await refused;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the same absolute deadline for a body that stalls after headers', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    const result = captureResponse(
      options,
      KEY,
      dependencies(() => Promise.resolve(response)),
    );
    const refused = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await refused; // Also proves cleanup does not await an uncooperative cancel.
  });

  it('pre-abort prevents egress, and mid-flight abort wins over deadline classification', async () => {
    const caller = new AbortController();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    caller.abort();
    await expect(
      captureResponse(options, KEY, { ...dependencies(fetch), signal: caller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetch).not.toHaveBeenCalled();
    const fresh = new AbortController();
    const result = captureResponse(options, KEY, { ...dependencies(fetch), signal: fresh.signal });
    const refused = expect(result).rejects.toMatchObject({ code: 'cancelled' });
    fresh.abort();
    await refused;
  });

  it('drops arbitrary transport errors/causes and refuses invalid capture provenance', async () => {
    const failing = () => Promise.reject(new Error(`transport echoed ${KEY}`));
    const failed = captureResponse(options, KEY, dependencies(failing));
    await expect(failed).rejects.toMatchObject({ code: 'transport' });
    await expect(failed).rejects.not.toHaveProperty('cause');
    await expect(failed).rejects.not.toThrow(KEY);
    await expect(
      captureResponse(options, KEY, {
        ...dependencies(() => Promise.resolve(jsonResponse())),
        now: () => 'invalid',
      }),
    ).rejects.toMatchObject({ code: 'invalid_arguments' });
  });
});
