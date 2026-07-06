import { SafeEgressError, type EgressDeps, type HopRequest, type HopResponse } from '@relavium/db';
import { describe, expect, it, vi } from 'vitest';

import { createValidatedFetch } from './validated-fetch.js';

/** An async-iterable body from fixed byte chunks (the live streaming shape connectValidated returns). */
async function* bytes(chunks: readonly string[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve(); // yields the encoded chunks (the leading await keeps this a genuine async generator)
  for (const chunk of chunks) yield new TextEncoder().encode(chunk);
}

/**
 * A fake {@link EgressDeps}: `resolveHost` returns the configured IP(s) (so the SSRF range-block is deterministic
 * without DNS), and `openConnection` returns a scripted {@link HopResponse} + captures the pinned request.
 */
/** An async-iterable body that yields `before`, then THROWS a raw error (a socket reset) — the fault must be
 *  normalized to a secret-free SafeEgressError and never surface the raw message. */
async function* failingBody(before: readonly string[]): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  for (const chunk of before) yield new TextEncoder().encode(chunk);
  throw new Error('socket reset (host 10.9.8.7, key sk-leak-me)'); // must NEVER reach the caller
}

function fakeDeps(opts: {
  ips: readonly string[];
  status?: number;
  headers?: Record<string, string>;
  location?: string;
  chunks?: readonly string[];
  body?: AsyncIterable<Uint8Array>;
  onConnect?: (req: HopRequest) => void;
  dispose?: () => void;
}): EgressDeps {
  return {
    resolveHost: () => Promise.resolve(opts.ips),
    openConnection: (req: HopRequest): Promise<HopResponse> => {
      opts.onConnect?.(req);
      return Promise.resolve({
        status: opts.status ?? 200,
        headers: opts.headers ?? { 'content-type': 'application/json' },
        location: opts.location,
        body: opts.body ?? bytes(opts.chunks ?? ['{"ok":true}']),
        dispose: opts.dispose ?? ((): void => undefined),
      });
    },
  };
}

describe('createValidatedFetch', () => {
  it('routes a request through connectValidated and maps the response (status + headers + body)', async () => {
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], status: 200, chunks: ['{"models":[]}'] }));
    const res = await fetch('https://api.example.com/v1/models');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ models: [] });
  });

  it('BLOCKS a host that resolves to a private/loopback address (SSRF) — the fetch rejects', async () => {
    const fetch = createValidatedFetch(fakeDeps({ ips: ['10.0.0.1'] })); // a private IP
    await expect(fetch('https://sneaky-rebind.example.com/v1/models')).rejects.toBeInstanceOf(SafeEgressError);
  });

  it('rejects a non-HTTPS url (the shared HTTPS policy), never connecting', async () => {
    const onConnect = vi.fn();
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], onConnect }));
    await expect(fetch('http://api.example.com/v1/models')).rejects.toBeInstanceOf(SafeEgressError);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('pins the connection to the validated IP and passes method + headers + body through', async () => {
    let captured: HopRequest | undefined;
    const fetch = createValidatedFetch(fakeDeps({ ips: ['203.0.113.7'], onConnect: (req) => (captured = req) }));
    await fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer sk-secret', 'content-type': 'application/json' },
      body: '{"model":"x"}',
    });
    expect(captured?.pinnedIp).toBe('203.0.113.7'); // connect-by-validated-IP (no re-resolve TOCTOU)
    expect(captured?.method).toBe('POST');
    expect(captured?.hostname).toBe('api.example.com');
    expect(captured?.headers?.['authorization']).toBe('Bearer sk-secret'); // the key rides the header to the endpoint
    expect(captured?.body).toBe('{"model":"x"}');
  });

  it('STREAMS the response body chunk-by-chunk (a custom endpoint SSE completion is not buffered)', async () => {
    const fetch = createValidatedFetch(
      fakeDeps({ ips: ['1.2.3.4'], chunks: ['data: a\n\n', 'data: b\n\n', 'data: [DONE]\n\n'] }),
    );
    const res = await fetch('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no response body stream');
    const received: string[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break; // `done` is typed boolean; only `value` is loosely typed by the lib
      const value: unknown = result.value;
      if (value instanceof Uint8Array) received.push(new TextDecoder().decode(value));
    }
    expect(received).toEqual(['data: a\n\n', 'data: b\n\n', 'data: [DONE]\n\n']); // three distinct streamed chunks
  });

  it('disposes the socket when the response stream is cancelled early', async () => {
    const dispose = vi.fn();
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], chunks: ['a', 'b', 'c'], dispose }));
    const res = await fetch('https://api.example.com/v1/models');
    await res.body?.cancel(); // stop reading early
    expect(dispose).toHaveBeenCalled();
  });

  it('refuses an unsupported HTTP method loudly (never a silent downgrade)', async () => {
    const onConnect = vi.fn();
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], onConnect }));
    await expect(
      fetch('https://api.example.com/v1/models', { method: 'PATCH' }),
    ).rejects.toBeInstanceOf(SafeEgressError);
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('maps a null-body status without a stream (204), disposing the (empty) socket', async () => {
    const dispose = vi.fn();
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], status: 204, dispose }));
    const res = await fetch('https://api.example.com/v1/models', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(dispose).toHaveBeenCalled();
  });

  it('does NOT follow a redirect — a 3xx + Location is returned TERMINALLY (no second unvalidated hop)', async () => {
    const onConnect = vi.fn();
    const fetch = createValidatedFetch(
      fakeDeps({ ips: ['1.2.3.4'], status: 302, location: 'https://169.254.169.254/', onConnect }),
    );
    const res = await fetch('https://api.example.com/v1/models');
    expect(res.status).toBe(302); // handed to the caller as-is...
    expect(onConnect).toHaveBeenCalledTimes(1); // ...never re-issued to the (private) Location target
  });

  it('normalizes a body-read fault to a secret-free SafeEgressError + reaps the socket (never leaks the raw error)', async () => {
    const dispose = vi.fn();
    const fetch = createValidatedFetch(
      fakeDeps({ ips: ['1.2.3.4'], body: failingBody(['data: a\n\n']), dispose }),
    );
    const res = await fetch('https://api.example.com/v1/chat/completions', { method: 'POST', body: '{}' });
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error('no body stream');
    let thrown: unknown;
    try {
      await reader.read(); // 'data: a\n\n'
      await reader.read(); // the underlying body throws → the stream errors
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SafeEgressError);
    if (thrown instanceof SafeEgressError) {
      expect(thrown.message).not.toContain('sk-leak-me'); // the raw error (host + key) never surfaces
      expect(thrown.message).not.toContain('10.9.8.7');
    }
    expect(dispose).toHaveBeenCalled(); // the socket is reaped on the fault
  });

  it('accepts a Request-object input (not just a url + init)', async () => {
    let captured: HopRequest | undefined;
    const fetch = createValidatedFetch(fakeDeps({ ips: ['203.0.113.9'], onConnect: (req) => (captured = req) }));
    await fetch(
      new Request('https://api.example.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-req' },
        body: '{"m":1}',
      }),
    );
    expect(captured?.method).toBe('POST');
    expect(captured?.headers?.['authorization']).toBe('Bearer sk-req');
    expect(captured?.body).toBe('{"m":1}');
  });

  it('rejects an out-of-range HTTP status (a hostile 999) as a typed SafeEgressError, never a raw RangeError', async () => {
    const dispose = vi.fn();
    const fetch = createValidatedFetch(fakeDeps({ ips: ['1.2.3.4'], status: 999, dispose }));
    await expect(fetch('https://api.example.com/v1/models')).rejects.toBeInstanceOf(SafeEgressError);
    expect(dispose).toHaveBeenCalled();
  });
});
