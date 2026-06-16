import { describe, expect, it } from 'vitest';

import {
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
    await expect(recorder.fetch('https://x')).rejects.toThrow(/secret/);
    expect(recorder.recordings).toHaveLength(0);
  });
});

describe('looksLikeSecret', () => {
  it('flags key-shaped strings and clears clean text', () => {
    expect(looksLikeSecret('sk-ant-api03-abcdefghijklmnop')).toBe(true);
    expect(looksLikeSecret('Authorization: Bearer abcdefghijklmnop1234')).toBe(true);
    expect(looksLikeSecret('{"model":"claude-opus-4-8","ok":true}')).toBe(false);
  });
});
