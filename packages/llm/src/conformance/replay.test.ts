import { describe, expect, it } from 'vitest';

import {
  FixtureRecordingError,
  looksLikeSecret,
  recordFetch,
  replayFetch,
  replayFetchSequence,
  replayFor,
} from './replay.js';

describe('replayFetch', () => {
  it('serves the recorded response', async () => {
    const fetch = replayFetch({ status: 200, body: '{"ok":true}' });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{"model":"m"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('rejects a request whose body is not valid JSON (fails loud, no blind serve)', async () => {
    const fetch = replayFetch({ status: 200, body: '{}' });
    await expect(fetch('https://x', { method: 'POST', body: 'not json' })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe('replayFetchSequence', () => {
  it('serves recorded responses in order, one per call (the multi-turn tool loop)', async () => {
    const fetch = replayFetchSequence([
      { status: 200, body: '{"turn":1}' },
      { status: 200, body: '{"turn":2}' },
    ]);
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe(
      '{"turn":1}',
    );
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe(
      '{"turn":2}',
    );
  });

  it('rejects an over-fetch beyond the recorded sequence (a fixture bug fails loud)', async () => {
    const fetch = replayFetchSequence([{ status: 200, body: '{}' }]);
    await fetch('https://x', { method: 'POST', body: '{}' });
    await expect(fetch('https://x', { method: 'POST', body: '{}' })).rejects.toThrow(
      /no recorded response for call #2/,
    );
  });

  it('rejects a request whose body is not valid JSON (parity with replayFetch)', async () => {
    const fetch = replayFetchSequence([{ status: 200, body: '{}' }]);
    await expect(fetch('https://x', { method: 'POST', body: 'nope' })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe('replayFor', () => {
  it('routes a single RecordedResponse to replayFetch (repeats every call)', async () => {
    const fetch = replayFor({ status: 200, body: '{"single":true}' });
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe(
      '{"single":true}',
    );
    // a single response repeats — a second call serves the same body (not an over-fetch error)
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe(
      '{"single":true}',
    );
  });

  it('routes an array to replayFetchSequence (one per call)', async () => {
    const fetch = replayFor([
      { status: 200, body: '{"n":1}' },
      { status: 200, body: '{"n":2}' },
    ]);
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe('{"n":1}');
    expect(await (await fetch('https://x', { method: 'POST', body: '{}' })).text()).toBe('{"n":2}');
  });
});

describe('recordFetch', () => {
  it('captures a clean response as a RecordedResponse', async () => {
    const real = (): Promise<Response> =>
      Promise.resolve(
        new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    const recorder = recordFetch(real);
    await recorder.fetch('https://x');
    expect(recorder.recordings).toHaveLength(1);
    expect(recorder.recordings[0]).toMatchObject({
      status: 200,
      contentType: 'application/json',
      body: '{"ok":1}',
    });
  });

  it('refuses to record a body that looks like it contains a secret', async () => {
    const real = (): Promise<Response> =>
      Promise.resolve(
        new Response('{"leaked":"sk-ant-abcdefghijklmnop1234"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const recorder = recordFetch(real);
    await expect(recorder.fetch('https://x')).rejects.toMatchObject({
      code: 'unsafe_recording',
    });
    expect(recorder.recordings).toHaveLength(0);
  });

  it('rejects planted newer Google keys in bodies and response metadata without retaining them', async () => {
    const planted = 'AQ.synthetic_fixture_credential_1234567890';
    for (const where of ['body', 'content-type'] as const) {
      const recorder = recordFetch(() =>
        Promise.resolve(
          new Response(where === 'body' ? planted : '{}', {
            headers: { 'content-type': where === 'content-type' ? planted : 'application/json' },
          }),
        ),
      );
      let caught: unknown;
      try {
        await recorder.fetch('https://example.test');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FixtureRecordingError);
      expect(caught instanceof FixtureRecordingError && caught.code).toBe('unsafe_recording');
      expect(String(caught)).not.toContain(planted);
      expect(caught instanceof Error && caught.cause).toBeUndefined();
      expect(recorder.recordings).toEqual([]);
    }
  });

  it('refuses transport/body-read failures with a content-free typed diagnostic', async () => {
    const planted = 'sk-ant-synthetic-credential-123456789';
    const providers = [
      () => Promise.reject(new Error(planted)),
      () => {
        const error = new FixtureRecordingError('capture_failed');
        error.message = planted;
        error.cause = new Error(planted);
        return Promise.reject(error);
      },
      () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error(planted));
              },
            }),
          ),
        ),
    ];
    for (const provider of providers) {
      const recorder = recordFetch(provider);
      let caught: unknown;
      try {
        await recorder.fetch('https://example.test');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FixtureRecordingError);
      expect(caught instanceof FixtureRecordingError && caught.code).toBe('capture_failed');
      expect(String(caught)).not.toContain(planted);
      expect(caught instanceof Error && caught.cause).toBeUndefined();
      expect(recorder.recordings).toEqual([]);
    }
  });

  it('exposes frozen recording snapshots while preserving the unread response for the caller', async () => {
    const recorder = recordFetch(() => Promise.resolve(new Response('{"ok":true}')));
    const emptySnapshot = recorder.recordings;
    const response = await recorder.fetch('https://example.test');
    const first = recorder.recordings;
    expect(emptySnapshot).toEqual([]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(await response.text()).toBe('{"ok":true}');
    expect(() => Object.defineProperty(first, '0', { value: 'changed' })).toThrow(TypeError);
    expect(() => Object.defineProperty(first[0], 'body', { value: 'changed' })).toThrow(TypeError);
    await recorder.fetch('https://example.test');
    expect(first).toHaveLength(1);
    expect(recorder.recordings).toHaveLength(2);
    expect(recorder.recordings[0]?.body).toBe('{"ok":true}');
  });
});

describe('looksLikeSecret', () => {
  it('flags key-shaped strings and clears clean text', () => {
    expect(looksLikeSecret('sk-ant-api03-abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecret('Authorization: Bearer abcdefghijklmnop1234')).toBe(true);
    expect(looksLikeSecret('AQ.synthetic_fixture_credential_1234567890')).toBe(true);
    expect(looksLikeSecret('{"model":"claude-opus-4-8","ok":true}')).toBe(false);
  });
});
