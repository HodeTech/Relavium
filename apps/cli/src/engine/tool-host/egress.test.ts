import type { EgressDeps, HopRequest } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { createNodeEgressCapability } from './egress.js';
import { EgressCapabilityError, EgressDeniedError } from './errors.js';

async function* bodyOf(text: string): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  if (text.length > 0) yield new TextEncoder().encode(text);
}

interface FakeResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/** A deterministic egress-deps fake: a host→IPs resolver + a single scripted response. */
function fakeDeps(config: {
  readonly resolve?: Record<string, readonly string[]>;
  readonly response: FakeResponse;
}): { deps: EgressDeps; calls: HopRequest[] } {
  const calls: HopRequest[] = [];
  const deps: EgressDeps = {
    resolveHost: (host) => Promise.resolve(config.resolve?.[host] ?? [host]),
    openConnection: (request) => {
      calls.push(request);
      return Promise.resolve({
        status: config.response.status,
        headers: config.response.headers,
        location: config.response.headers?.['location'],
        body: bodyOf(config.response.body ?? ''),
        dispose: () => {},
      });
    },
  };
  return { deps, calls };
}

const PUBLIC = { 'api.example.com': ['203.0.113.10'] } as const; // a public TEST-NET-3 IP

describe('createNodeEgressCapability (2.5.E Step 3) — text egress over the shared SSRF mechanism', () => {
  it('performs a GET, pinned to the validated IP, returning status + headers + decoded text', async () => {
    const { deps, calls } = fakeDeps({
      resolve: PUBLIC,
      response: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      },
    });
    const egress = createNodeEgressCapability({ deps });
    const res = await egress.fetch({ method: 'GET', url: 'https://api.example.com/x' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.headers['content-type']).toBe('application/json');
    expect(calls[0]?.pinnedIp).toBe('203.0.113.10'); // connect-by-validated-IP
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.hostname).toBe('api.example.com'); // SNI keeps the hostname
  });

  it('DENIES a private/loopback target (SSRF range-block) as a fatal EgressDeniedError', async () => {
    const { deps } = fakeDeps({
      resolve: { 'evil.example.com': ['127.0.0.1'] },
      response: { status: 200 },
    });
    const egress = createNodeEgressCapability({ deps });
    const err = await egress
      .fetch({ method: 'GET', url: 'https://evil.example.com/x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressDeniedError);
    expect((err as EgressDeniedError).runErrorCode).toBe('tool_denied'); // fatal, never retried
    expect((err as EgressDeniedError).retryable).toBe(false);
  });

  it('DENIES a non-HTTPS url as a fatal EgressDeniedError (before any DNS)', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({ deps });
    await expect(
      egress.fetch({ method: 'GET', url: 'http://api.example.com/x' }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(calls).toHaveLength(0); // rejected at the url policy gate, never opened a connection
  });

  it('does NOT follow redirects — a 3xx is RETURNED with its Location (avoids the allowedDomains bypass)', async () => {
    const { deps, calls } = fakeDeps({
      resolve: PUBLIC,
      response: { status: 302, headers: { location: 'https://other.example.com/y' } },
    });
    const egress = createNodeEgressCapability({ deps });
    const res = await egress.fetch({ method: 'GET', url: 'https://api.example.com/x' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://other.example.com/y'); // surfaced for the model to re-issue
    expect(calls).toHaveLength(1); // exactly ONE hop — the redirect was never chased
  });

  it('returns a non-200, non-redirect status (e.g. 404) rather than throwing — the model surfaces it', async () => {
    const { deps } = fakeDeps({ resolve: PUBLIC, response: { status: 404, body: 'not found' } });
    const egress = createNodeEgressCapability({ deps });
    const res = await egress.fetch({ method: 'GET', url: 'https://api.example.com/x' });
    expect(res.status).toBe(404);
    expect(res.body).toBe('not found');
  });

  it('resolves an opaque credentialRef host-side and attaches it as a bearer header (never the engine)', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: (ref) =>
        Promise.resolve(ref === 'kc:search' ? ['SECRET', 'KEY'].join('-') : undefined),
    });
    await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      credentialRef: 'kc:search',
    });
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer SECRET-KEY');
  });

  it('the host-resolved credential WINS over a model-supplied Authorization header (any case)', async () => {
    // The model could inject its own `Authorization` in any casing; when a credential is resolved host-side it
    // must win deterministically — no stale/duplicate auth header on the wire.
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: () => Promise.resolve('RESOLVED'),
    });
    await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      credentialRef: 'kc:x',
      headers: { Authorization: 'Bearer MODEL-INJECTED', 'X-Keep': 'yes' },
    });
    // Only ONE authorization header reaches the hop, carrying the resolved credential; no capitalized duplicate.
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer RESOLVED');
    expect(calls[0]?.headers?.['Authorization']).toBeUndefined();
    expect(calls[0]?.headers?.['X-Keep']).toBe('yes'); // unrelated model headers still pass through
  });

  it('with NO host credential, a model-supplied Authorization passes through unchanged', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({ deps }); // no resolveCredential
    await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      headers: { Authorization: 'Bearer MODEL-OWN' },
    });
    expect(calls[0]?.headers?.['Authorization']).toBe('Bearer MODEL-OWN'); // untouched — nothing to override
  });

  it('drops BOTH case variants when the model sets Authorization AND authorization simultaneously', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: () => Promise.resolve('WON'),
    });
    await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      credentialRef: 'kc:x',
      headers: { Authorization: 'Bearer A', authorization: 'Bearer B' }, // both casings present
    });
    expect(calls[0]?.headers?.['Authorization']).toBeUndefined();
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer WON'); // exactly one, the resolved credential
  });

  it('TRIMS a resolved credential with stray surrounding whitespace (a pasted-key footgun)', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: () => Promise.resolve('  KEY-WITH-NEWLINE\n'),
    });
    await egress.fetch({ method: 'GET', url: 'https://api.example.com/x', credentialRef: 'kc:x' });
    // Without the trim the CR/LF value would be dropped by the request-splitting guard → sent unauthenticated.
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer KEY-WITH-NEWLINE');
  });

  it('proceeds WITHOUT a credential when the ref does not resolve (a provider 401 surfaces, never a crash)', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: () => Promise.resolve(undefined),
    });
    await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      credentialRef: 'kc:missing',
    });
    expect(calls[0]?.headers?.['authorization']).toBeUndefined();
  });

  it('degrades a REJECTING credential resolver (a keychain fault) to no credential — never a crash', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({
      deps,
      resolveCredential: () => Promise.reject(new Error('keychain locked')),
    });
    // The request still succeeds credential-less (the "never a crash" contract) — the raw keychain error does
    // NOT escape fetch(), and no authorization header is attached.
    const res = await egress.fetch({
      method: 'GET',
      url: 'https://api.example.com/x',
      credentialRef: 'kc:x',
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.headers?.['authorization']).toBeUndefined();
  });

  it('forwards a POST method + body to the hop', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200, body: 'ok' } });
    const egress = createNodeEgressCapability({ deps });
    await egress.fetch({ method: 'POST', url: 'https://api.example.com/x', body: '{"q":1}' });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{"q":1}');
  });

  it('fails an over-size response as a transient EgressCapabilityError (retryable)', async () => {
    const { deps } = fakeDeps({
      resolve: PUBLIC,
      response: { status: 200, body: 'x'.repeat(500) },
    });
    const egress = createNodeEgressCapability({ deps, maxResponseBytes: 100 });
    await expect(
      egress.fetch({ method: 'GET', url: 'https://api.example.com/x' }),
    ).rejects.toBeInstanceOf(EgressCapabilityError);
  });

  it('DENIES a credentialed url (user:pass@host) as a fatal EgressDeniedError, before any connection', async () => {
    const { deps, calls } = fakeDeps({ resolve: PUBLIC, response: { status: 200 } });
    const egress = createNodeEgressCapability({ deps });
    await expect(
      egress.fetch({ method: 'GET', url: 'https://user:pass@api.example.com/x' }),
    ).rejects.toBeInstanceOf(EgressDeniedError);
    expect(calls).toHaveLength(0); // rejected at the url policy gate, never opened a connection
  });

  it('threads the caller abort signal through to the connection (the cancel contract)', async () => {
    let innerAborted: boolean | undefined;
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['203.0.113.10']),
      openConnection: (_request, signal) =>
        new Promise((_resolve, reject) => {
          innerAborted = signal.aborted;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
          if (signal.aborted) reject(new Error('aborted'));
        }),
    };
    const egress = createNodeEgressCapability({ deps });
    const ac = new AbortController();
    ac.abort();
    await egress
      .fetch({ method: 'GET', url: 'https://api.example.com/x' }, ac.signal)
      .catch(() => undefined);
    expect(innerAborted).toBe(true); // the composed inner signal reached the connection already-aborted
  });

  it('times out a hung connection as a transient EgressCapabilityError (retryable)', async () => {
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['203.0.113.10']),
      // Honors the abort signal (as the real node deps do) but never resolves on its own — the 5ms timeout
      // composed by withEgressTimeout aborts it, surfacing a normalized transient failure to the model.
      openConnection: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by the timeout')));
        }),
    };
    const egress = createNodeEgressCapability({ deps, timeoutMs: 5 });
    await expect(
      egress.fetch({ method: 'GET', url: 'https://api.example.com/x' }),
    ).rejects.toBeInstanceOf(EgressCapabilityError);
  });
});
