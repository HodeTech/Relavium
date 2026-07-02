import { request as httpsRequest } from 'node:https';

import { describe, expect, it, vi } from 'vitest';

import {
  connectValidated,
  nodeEgressDeps,
  readBounded,
  SafeEgressError,
  withEgressTimeout,
  type EgressDeps,
  type HopRequest,
} from './safe-egress.js';

// Mock `node:https` so the CONCRETE `nodeEgressDeps.openConnection` (the un-injectable pin/SNI/headers/body
// wiring) is asserted without a real socket. The fake-deps tests below never reach the real openConnection.
vi.mock('node:https', () => ({ request: vi.fn() }));

/**
 * safe-egress.ts is THE single connect-by-validated-IP SSRF primitive shared by media + CLI tool egress
 * (ADR-0029(d)/0043/0057). These tests pin its OWN contract directly (the media wrapper covers the media
 * policy on top): URL validation, range-blocking every resolved IP, connect-pinning, the size bound, the
 * timeout/abort normalization, and the concrete Node POST/body/headers-on-the-wire path.
 */

const sig = (): AbortSignal => new AbortController().signal;

/** A deterministic fake `EgressDeps`: a host→IPs map + a single 200 response, capturing the pinned HopRequest. */
function fakeDeps(opts: {
  resolve?: Record<string, readonly string[]>;
  onOpen?: (request: HopRequest) => void;
}): EgressDeps {
  return {
    resolveHost: (host) => Promise.resolve(opts.resolve?.[host] ?? [host]),
    openConnection: (request) => {
      opts.onOpen?.(request);
      return Promise.resolve({
        status: 200,
        location: undefined,
        body: (async function* empty(): AsyncGenerator<Uint8Array> {
          await Promise.resolve();
          for (const chunk of [] as readonly Uint8Array[]) yield chunk; // an empty body stream
        })(),
        dispose: () => undefined,
      });
    },
  };
}

async function* bytes(...chunks: readonly number[][]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield new Uint8Array(chunk);
  }
}

describe('connectValidated — the one validated hop (URL policy + range-block + pin)', () => {
  it('pins the FIRST validated IP and forwards method/headers/body to the hop', async () => {
    let captured: HopRequest | undefined;
    const deps = fakeDeps({
      resolve: { 'api.example.com': ['203.0.113.5', '203.0.113.6'] },
      onOpen: (request) => (captured = request),
    });
    await connectValidated(
      'https://api.example.com/p?q=1',
      {
        allowPrivate: false,
        method: 'POST',
        headers: { authorization: 'Bearer X' },
        body: '{"a":1}',
      },
      deps,
      sig(),
    );
    expect(captured?.pinnedIp).toBe('203.0.113.5'); // the first range-checked IP — no re-resolve TOCTOU
    expect(captured?.hostname).toBe('api.example.com');
    expect(captured?.method).toBe('POST');
    expect(captured?.headers?.['authorization']).toBe('Bearer X');
    expect(captured?.body).toBe('{"a":1}');
  });

  it('STRIPS a caller-supplied Host / :authority header (virtual-host-confusion SSRF defense)', async () => {
    let captured: HopRequest | undefined;
    const deps = fakeDeps({
      resolve: { 'api.example.com': ['203.0.113.5'] },
      onOpen: (request) => (captured = request),
    });
    await connectValidated(
      'https://api.example.com/x',
      {
        allowPrivate: false,
        method: 'GET',
        // A model could set these to reroute an allowlisted, correctly-pinned request to a DIFFERENT vhost at
        // the same shared IP — the mechanism must drop them so the wire Host derives from the validated host.
        headers: {
          Host: 'internal-admin.example',
          host: 'evil.example',
          ':authority': 'evil2.example',
          'x-keep': 'ok',
          authorization: 'Bearer X',
        },
      },
      deps,
      sig(),
    );
    expect(captured?.headers?.['Host']).toBeUndefined();
    expect(captured?.headers?.['host']).toBeUndefined();
    expect(captured?.headers?.[':authority']).toBeUndefined();
    expect(captured?.headers?.['x-keep']).toBe('ok'); // unrelated headers pass through
    expect(captured?.headers?.['authorization']).toBe('Bearer X'); // the legit credential is untouched
  });

  it('rejects a non-HTTPS url and a credentialed url with insecure_url (before any DNS)', async () => {
    let resolved = false;
    const deps: EgressDeps = {
      resolveHost: (h) => {
        resolved = true;
        return Promise.resolve([h]);
      },
      openConnection: () => Promise.reject(new Error('must not connect')),
    };
    await expect(
      connectValidated(
        'http://api.example.com/x',
        { allowPrivate: false, method: 'GET' },
        deps,
        sig(),
      ),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(
      connectValidated(
        'https://u:p@api.example.com/x',
        { allowPrivate: false, method: 'GET' },
        deps,
        sig(),
      ),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    expect(resolved).toBe(false); // the url gate runs before the resolver
  });

  it('blocks a private IP among MANY resolved answers (one bad answer fails the whole fetch)', async () => {
    const deps = fakeDeps({ resolve: { 'evil.example.com': ['203.0.113.5', '127.0.0.1'] } });
    await expect(
      connectValidated(
        'https://evil.example.com/x',
        { allowPrivate: false, method: 'GET' },
        deps,
        sig(),
      ),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('blocks a resolver that returns a NON-IP (it would defeat connect-by-validated-IP)', async () => {
    const deps = fakeDeps({ resolve: { 'evil.example.com': ['cdn.internal.corp'] } });
    await expect(
      connectValidated(
        'https://evil.example.com/x',
        { allowPrivate: false, method: 'GET' },
        deps,
        sig(),
      ),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('blocks an empty DNS result (fail-closed — never pins the unvalidated hostname)', async () => {
    const deps = fakeDeps({ resolve: { 'nx.example.com': [] } });
    await expect(
      connectValidated(
        'https://nx.example.com/x',
        { allowPrivate: false, method: 'GET' },
        deps,
        sig(),
      ),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('allowPrivate:true permits a loopback target (the BYOK local-endpoint opt-in)', async () => {
    let opened = false;
    const deps = fakeDeps({ resolve: { localhost: ['127.0.0.1'] }, onOpen: () => (opened = true) });
    await connectValidated(
      'https://localhost/x',
      { allowPrivate: true, method: 'GET' },
      deps,
      sig(),
    );
    expect(opened).toBe(true);
  });
});

describe('readBounded — the size bound', () => {
  it('returns the body at EXACTLY maxBytes and disposes', async () => {
    let disposed = false;
    const out = await readBounded(bytes([1, 2, 3]), 3, () => (disposed = true));
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(disposed).toBe(true);
  });

  it('throws too_large ONE byte over the cap and still disposes', async () => {
    let disposed = false;
    await expect(
      readBounded(bytes([1, 2], [3, 4]), 3, () => (disposed = true)),
    ).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(disposed).toBe(true); // the finally disposes even on the over-size throw
  });
});

describe('withEgressTimeout — timeout + abort + error normalization', () => {
  it('normalizes a raw throw to SafeEgressError(network) and preserves a typed SafeEgressError', async () => {
    await expect(
      withEgressTimeout(undefined, 1000, () => Promise.reject(new Error('raw boom (host leak)'))),
    ).rejects.toMatchObject({ name: 'SafeEgressError', code: 'network' });
    await expect(
      withEgressTimeout(undefined, 1000, () =>
        Promise.reject(new SafeEgressError('too_large', 'x')),
      ),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('aborts the inner signal immediately when the outer signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let innerAborted: boolean | undefined;
    await withEgressTimeout(ac.signal, 1000, (inner) => {
      innerAborted = inner.aborted;
      return Promise.resolve('ok');
    });
    expect(innerAborted).toBe(true);
  });

  it('fires the timeout: the inner signal aborts and the call rejects (normalized to network)', async () => {
    const result = withEgressTimeout(
      undefined,
      5,
      (inner) =>
        new Promise<string>((_resolve, reject) => {
          inner.addEventListener('abort', () => reject(new Error('aborted by the timeout')));
        }),
    );
    await expect(result).rejects.toMatchObject({ code: 'network' });
  });
});

/* --- the concrete Node mechanism (nodeEgressDeps.openConnection) — the body/headers-on-the-wire path --- */

interface CapturedHttpsOptions {
  readonly hostname?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly servername?: string;
  readonly lookup?: (
    hostname: string,
    options: unknown,
    callback: (err: unknown, address: string, family: number) => void,
  ) => void;
}

type FakeIncoming = AsyncIterable<Uint8Array> & {
  readonly statusCode: number;
  readonly headers: { readonly location?: string };
  readonly destroy: () => void;
};

function fakeIncoming(status: number, chunks: readonly Uint8Array[] = []): FakeIncoming {
  const stream = (async function* gen(): AsyncGenerator<Uint8Array> {
    await Promise.resolve();
    for (const chunk of chunks) yield chunk;
  })();
  return Object.assign(stream, { statusCode: status, headers: {}, destroy: () => undefined });
}

/** A ClientRequest stub: openConnection calls `.on('error',…)`, optionally `.write(body)`, then `.end()`. */
function stubClientRequest(): {
  on: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
}

function lastHttpsCall(): {
  options: CapturedHttpsOptions;
  onResponse: (incoming: FakeIncoming) => void;
} {
  const call = vi.mocked(httpsRequest).mock.calls.at(-1);
  if (call === undefined) throw new Error('expected https.request to have been called');
  const [options, onResponse] = call;
  if (
    typeof options !== 'object' ||
    options === null ||
    options instanceof URL ||
    typeof onResponse !== 'function'
  ) {
    throw new Error('expected https.request(optionsObject, responseCallback)');
  }
  return { options, onResponse: onResponse as (incoming: FakeIncoming) => void };
}

describe('nodeEgressDeps.openConnection — the concrete body/headers wire path (2.5.E)', () => {
  it('forwards method + headers AND writes the body for a POST', async () => {
    const client = stubClientRequest();
    vi.mocked(httpsRequest).mockReturnValue(client as unknown as ReturnType<typeof httpsRequest>);
    const request: HopRequest = {
      url: 'https://api.example.com/p',
      hostname: 'api.example.com',
      pinnedIp: '203.0.113.5',
      method: 'POST',
      headers: { authorization: 'Bearer SECRET-VALUE' },
      body: '{"q":1}',
    };
    const pending = nodeEgressDeps.openConnection(request, sig());
    const { options, onResponse } = lastHttpsCall();
    onResponse(fakeIncoming(200));
    await pending;
    expect(options.method).toBe('POST');
    expect(options.headers?.['authorization']).toBe('Bearer SECRET-VALUE'); // the host-resolved credential header
    expect(client.write).toHaveBeenCalledWith('{"q":1}'); // the body actually reaches the wire
  });

  it('pins the connection to the validated IP via the lookup callback and keeps the hostname as SNI', async () => {
    const client = stubClientRequest();
    vi.mocked(httpsRequest).mockReturnValue(client as unknown as ReturnType<typeof httpsRequest>);
    const pending = nodeEgressDeps.openConnection(
      {
        url: 'https://api.example.com/x',
        hostname: 'api.example.com',
        pinnedIp: '203.0.113.5',
        method: 'GET',
      },
      sig(),
    );
    const { options, onResponse } = lastHttpsCall();
    // SNI + certificate host stay the validated hostname (TLS verification is against api.example.com), while
    // the socket is pinned to the pre-validated IP — the lookup callback returns pinnedIp, never re-resolving.
    expect(options.servername).toBe('api.example.com');
    expect(options.hostname).toBe('api.example.com');
    let pinnedTo: string | undefined;
    let pinnedFamily: number | undefined;
    options.lookup?.('api.example.com', {}, (_err: unknown, address: string, family: number) => {
      pinnedTo = address;
      pinnedFamily = family;
    });
    expect(pinnedTo).toBe('203.0.113.5');
    expect(pinnedFamily).toBe(4); // an IPv4 pin resolves family 4
    onResponse(fakeIncoming(200));
    await pending;
  });

  it('pins an IPv6 target with family 6', async () => {
    const client = stubClientRequest();
    vi.mocked(httpsRequest).mockReturnValue(client as unknown as ReturnType<typeof httpsRequest>);
    const pending = nodeEgressDeps.openConnection(
      {
        url: 'https://api.example.com/x',
        hostname: 'api.example.com',
        pinnedIp: '2606:2800:220:1:248:1893:25c8:1946',
        method: 'GET',
      },
      sig(),
    );
    const { options, onResponse } = lastHttpsCall();
    let pinnedFamily: number | undefined;
    options.lookup?.('api.example.com', {}, (_e: unknown, _a: string, family: number) => {
      pinnedFamily = family;
    });
    expect(pinnedFamily).toBe(6);
    onResponse(fakeIncoming(200));
    await pending;
  });

  it('does NOT write a body for a GET with no body', async () => {
    const client = stubClientRequest();
    vi.mocked(httpsRequest).mockReturnValue(client as unknown as ReturnType<typeof httpsRequest>);
    const pending = nodeEgressDeps.openConnection(
      {
        url: 'https://api.example.com/x',
        hostname: 'api.example.com',
        pinnedIp: '203.0.113.5',
        method: 'GET',
      },
      sig(),
    );
    lastHttpsCall().onResponse(fakeIncoming(200));
    await pending;
    expect(client.write).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalled();
  });
});
