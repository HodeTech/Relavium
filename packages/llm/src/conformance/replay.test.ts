import { describe, expect, it } from 'vitest';

import { looksLikeSecret, recordFetch, replayFetch } from './replay.js';

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
