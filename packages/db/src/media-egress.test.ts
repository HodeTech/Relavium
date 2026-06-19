import { request as httpsRequest } from 'node:https';

import { describe, expect, it, vi } from 'vitest';

import {
  fetchMediaBytes,
  MediaEgressError,
  nodeMediaEgressDeps,
  type HopRequest,
  type MediaEgressDeps,
} from './media-egress.js';

// Mock `node:https` so the CONCRETE `nodeMediaEgressDeps.openConnection` (the un-injectable pin/SNI/port
// wiring) is exercised deterministically — without a real TLS handshake (the default deps keep verification
// ON, so a self-signed localhost cert cannot be trusted, and a trusted cert cannot be injected). The
// fakeDeps tests never reach the real openConnection, so the mock is inert for them. (E43-7)
vi.mock('node:https', () => ({ request: vi.fn() }));

const PUBLIC_IP = '203.0.113.10'; // TEST-NET-3 documentation range — not in any SSRF private block
const PUBLIC_IP_2 = '198.51.100.7'; // TEST-NET-2 — a second public address for redirect targets

/** A scripted hop the fake `openConnection` returns in order. */
interface ScriptedHop {
  readonly status: number;
  readonly location?: string;
  readonly body?: readonly Uint8Array[];
  /** Emit one chunk then throw a raw Node-style AbortError mid-stream (models a socket destroy on abort). */
  readonly bodyThrows?: boolean;
}

function bodyOf(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* gen(): AsyncGenerator<Uint8Array> {
    await Promise.resolve(); // a real body stream is async; satisfy require-await for the fake
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

/** A body stream that yields one chunk then throws a raw Node AbortError (a socket destroy mid-read). */
function throwingBody(): AsyncIterable<Uint8Array> {
  return (async function* gen(): AsyncGenerator<Uint8Array> {
    await Promise.resolve();
    yield new Uint8Array([1]);
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  })();
}

/** Build fake deps + capture the connection calls and dispose count, so SSRF policy is deterministic. */
function fakeDeps(config: {
  readonly resolve?: Record<string, readonly string[]>;
  readonly hops?: readonly ScriptedHop[];
}): {
  deps: MediaEgressDeps;
  calls: HopRequest[];
  stats: { disposed: number };
} {
  const calls: HopRequest[] = [];
  const stats = { disposed: 0 };
  let hopIndex = 0;
  const deps: MediaEgressDeps = {
    resolveHost: (hostname) => Promise.resolve(config.resolve?.[hostname] ?? [hostname]),
    openConnection: (request) => {
      calls.push(request);
      const hop = config.hops?.[hopIndex];
      hopIndex += 1;
      if (hop === undefined) {
        return Promise.reject(new Error('test: no scripted hop'));
      }
      return Promise.resolve({
        status: hop.status,
        location: hop.location,
        body: hop.bodyThrows === true ? throwingBody() : bodyOf(hop.body ?? []),
        dispose: () => {
          stats.disposed += 1;
        },
      });
    },
  };
  return { deps, calls, stats };
}

describe('fetchMediaBytes (1.AF/D9, ADR-0043 — SSRF-validated, size-bounded media egress)', () => {
  it('fetches bytes over a 200, pinning the connection to the validated resolved IP', async () => {
    const { deps, calls } = fakeDeps({
      resolve: { 'media.example': [PUBLIC_IP] },
      hops: [{ status: 200, body: [new Uint8Array([1, 2, 3, 4])] }],
    });
    const bytes = await fetchMediaBytes('https://media.example/a.png', { maxBytes: 1000 }, deps);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.hostname).toBe('media.example'); // SNI/Host stays the hostname
    expect(calls[0]?.pinnedIp).toBe(PUBLIC_IP); // connected by the validated IP (TOCTOU defense)
  });

  it('rejects a non-HTTPS url (insecure_url), opening no connection', async () => {
    const { deps, calls } = fakeDeps({ hops: [{ status: 200 }] });
    await expect(
      fetchMediaBytes('http://media.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a url with embedded credentials (insecure_url)', async () => {
    const { deps, calls } = fakeDeps({ hops: [{ status: 200 }] });
    await expect(
      fetchMediaBytes('https://user:pass@media.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    expect(calls).toHaveLength(0);
  });

  it('blocks a private host literal (blocked_host), never resolving or connecting', async () => {
    const { deps, calls } = fakeDeps({ hops: [{ status: 200 }] });
    await expect(
      fetchMediaBytes('https://127.0.0.1/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
    expect(calls).toHaveLength(0);
  });

  it('blocks a public hostname that RESOLVES to a private IP (blocked_host), opening no connection', async () => {
    const { deps, calls } = fakeDeps({
      resolve: { 'rebind.example': ['10.0.0.1'] },
      hops: [{ status: 200 }],
    });
    await expect(
      fetchMediaBytes('https://rebind.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
    expect(calls).toHaveLength(0);
  });

  it('blocks when ANY of multiple resolved IPs is private (fail-closed over the whole record set)', async () => {
    const { deps } = fakeDeps({
      resolve: { 'mixed.example': [PUBLIC_IP, '169.254.169.254'] }, // one public, one metadata
      hops: [{ status: 200 }],
    });
    await expect(
      fetchMediaBytes('https://mixed.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('allows a private target only under the explicit allowPrivate opt-in', async () => {
    const { deps, calls } = fakeDeps({
      resolve: { 'localhost.example': ['127.0.0.1'] },
      hops: [{ status: 200, body: [new Uint8Array([9])] }],
    });
    const bytes = await fetchMediaBytes(
      'https://localhost.example/a.png',
      { maxBytes: 1000, allowPrivate: true },
      deps,
    );
    expect([...bytes]).toEqual([9]);
    expect(calls).toHaveLength(1);
  });

  it('follows a redirect to a public host (re-validating the new target) and disposes the redirect body', async () => {
    const { deps, calls, stats } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP], 'b.example': [PUBLIC_IP_2] },
      hops: [
        { status: 302, location: 'https://b.example/final.png' },
        { status: 200, body: [new Uint8Array([7, 7])] },
      ],
    });
    const bytes = await fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps);
    expect([...bytes]).toEqual([7, 7]);
    expect(calls.map((c) => c.hostname)).toEqual(['a.example', 'b.example']);
    expect(calls[1]?.pinnedIp).toBe(PUBLIC_IP_2); // the redirect target was independently resolved + pinned
    expect(stats.disposed).toBeGreaterThanOrEqual(1); // the 302 body was disposed, not read
  });

  it('blocks a redirect to a private host (per-hop re-validation), even after a public first hop', async () => {
    const { deps } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP], 'evil.example': ['192.168.1.5'] },
      hops: [{ status: 307, location: 'https://evil.example/x' }, { status: 200 }],
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('blocks a redirect to a non-HTTPS target (insecure_url on the hop)', async () => {
    const { deps } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP] },
      hops: [{ status: 301, location: 'http://a.example/x' }],
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'insecure_url' });
  });

  it('fails with too_many_redirects past the limit', async () => {
    const { deps } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP] },
      hops: [
        { status: 302, location: 'https://a.example/1' },
        { status: 302, location: 'https://a.example/2' },
        { status: 302, location: 'https://a.example/3' },
      ],
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000, maxRedirects: 1 }, deps),
    ).rejects.toMatchObject({ code: 'too_many_redirects' });
  });

  it('aborts an over-size body (too_large) and disposes the stream', async () => {
    const { deps, stats } = fakeDeps({
      resolve: { 'big.example': [PUBLIC_IP] },
      hops: [{ status: 200, body: [new Uint8Array(8), new Uint8Array(8)] }], // 16 bytes
    });
    await expect(
      fetchMediaBytes('https://big.example/a.png', { maxBytes: 10 }, deps),
    ).rejects.toMatchObject({ code: 'too_large' });
    expect(stats.disposed).toBeGreaterThanOrEqual(1);
  });

  it('fails with bad_status on a non-200, non-redirect response', async () => {
    const { deps } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP] },
      hops: [{ status: 404 }],
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'bad_status' });
  });

  it('normalizes a socket abort/destroy mid-body-read to a typed MediaEgressError (network)', async () => {
    // The response promise has already resolved when the body stream throws; without normalization a raw
    // Node AbortError would escape, breaking the "only MediaEgressError" contract (security-review finding).
    const { deps, stats } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP] },
      hops: [{ status: 200, bodyThrows: true }],
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'network' });
    expect(stats.disposed).toBeGreaterThanOrEqual(1); // the stream was disposed on the way out
  });

  it('normalizes a resolver rejection to a typed MediaEgressError (never a raw DNS error)', async () => {
    const deps: MediaEgressDeps = {
      resolveHost: () => Promise.reject(new Error('getaddrinfo ENOTFOUND a.example')),
      openConnection: () => Promise.reject(new Error('test: must not connect')),
    };
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('blocks a resolver that returns a non-IP token (the pinned target must be an IP literal)', async () => {
    const deps: MediaEgressDeps = {
      resolveHost: () => Promise.resolve(['not-an-ip.example']), // a hostname, never a pinnable IP
      openConnection: () => Promise.reject(new Error('test: must not connect')),
    };
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('blocks an empty DNS resolution (no address to pin), opening no connection', async () => {
    const { deps, calls } = fakeDeps({
      resolve: { 'nxdomain.example': [] }, // resolver returns zero addresses
      hops: [{ status: 200 }],
    });
    await expect(
      fetchMediaBytes('https://nxdomain.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'blocked_host' });
    expect(calls).toHaveLength(0); // fail-closed before any openConnection (never pins to the hostname)
  });

  it('normalizes a malformed redirect Location to a typed MediaEgressError (no raw URL TypeError)', async () => {
    const { deps } = fakeDeps({
      resolve: { 'a.example': [PUBLIC_IP] },
      hops: [{ status: 302, location: 'https://[' }], // unclosed IPv6 — new URL() throws (scheme incidental)
    });
    await expect(
      fetchMediaBytes('https://a.example/a.png', { maxBytes: 1000 }, deps),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('exposes a typed MediaEgressError', () => {
    const err = new MediaEgressError('blocked_host', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('blocked_host');
    expect(err.name).toBe('MediaEgressError');
  });
});

/* --- the concrete Node mechanism (nodeMediaEgressDeps) — the un-injectable pin/SNI/port wiring (E43-7) --- */

/** The shape of the captured `node:https.request` options we assert (a narrow view of RequestOptions). */
interface CapturedHttpsOptions {
  readonly hostname?: string;
  readonly port?: number;
  readonly path?: string;
  readonly servername?: string;
  readonly lookup?: (
    hostname: string,
    opts: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ) => void;
}

/** A minimal IncomingMessage stand-in: an async byte stream plus the status/headers/destroy openConnection reads. */
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

describe('nodeMediaEgressDeps — the Node mechanism wiring (E43-7)', () => {
  it('resolveHost returns an IP literal as itself, with no DNS round-trip (v4 + v6)', async () => {
    await expect(nodeMediaEgressDeps.resolveHost('203.0.113.10')).resolves.toEqual([
      '203.0.113.10',
    ]);
    await expect(nodeMediaEgressDeps.resolveHost('2001:db8::1')).resolves.toEqual(['2001:db8::1']);
    await expect(nodeMediaEgressDeps.resolveHost('::1')).resolves.toEqual(['::1']);
  });

  it('the DEFAULT deps reject a loopback/link-local literal, opening no connection (fail-closed)', async () => {
    // Drives nodeMediaEgressDeps (no `deps` arg) through the policy: the shared range-block rejects before
    // openConnection, so the real https.request is never called — a regression that opened the socket first
    // would fail this.
    await expect(
      fetchMediaBytes('https://127.0.0.1/a.png', { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      code: 'blocked_host', // loopback
    });
    await expect(
      fetchMediaBytes('https://169.254.169.254/latest', { maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'blocked_host' }); // the cloud-metadata link-local address
    expect(httpsRequest).not.toHaveBeenCalled();
  });

  it('openConnection pins the validated IP via lookup, keeps the hostname as SNI, and parses port/path', async () => {
    vi.mocked(httpsRequest).mockReturnValue({
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as ReturnType<typeof httpsRequest>);
    const request: HopRequest = {
      url: 'https://media.example.com:8443/a/b?c=d',
      hostname: 'media.example.com',
      pinnedIp: '203.0.113.10',
    };
    const pending = nodeMediaEgressDeps.openConnection(request, new AbortController().signal);
    const callArgs = vi.mocked(httpsRequest).mock.calls.at(-1);
    const options = callArgs?.[0] as unknown as CapturedHttpsOptions;
    const onResponse = callArgs?.[1] as unknown as (incoming: FakeIncoming) => void;
    onResponse(fakeIncoming(200, [new Uint8Array([1, 2, 3])])); // deliver a 200 so the promise resolves
    const response = await pending;

    expect(response.status).toBe(200);
    // Pinned to the pre-validated IP, but TLS verification stays ON against the original hostname (SNI).
    expect(options.servername).toBe('media.example.com');
    expect(options.hostname).toBe('media.example.com');
    expect(options.port).toBe(8443);
    expect(options.path).toBe('/a/b?c=d');
    // The lookup callback resolves to EXACTLY the pinned IP (v4 family) — never a re-resolve (TOCTOU defense).
    const lookupCb = vi.fn();
    options.lookup?.('media.example.com', {}, lookupCb);
    expect(lookupCb).toHaveBeenCalledWith(null, '203.0.113.10', 4);
  });

  it('openConnection derives family 6 for an IPv6 pin and defaults a port-less url to 443', async () => {
    vi.mocked(httpsRequest).mockReturnValue({
      on: vi.fn(),
      end: vi.fn(),
    } as unknown as ReturnType<typeof httpsRequest>);
    const pending = nodeMediaEgressDeps.openConnection(
      { url: 'https://v6.example.com/x', hostname: 'v6.example.com', pinnedIp: '2001:db8::1' },
      new AbortController().signal,
    );
    const callArgs = vi.mocked(httpsRequest).mock.calls.at(-1);
    const options = callArgs?.[0] as unknown as CapturedHttpsOptions;
    const onResponse = callArgs?.[1] as unknown as (incoming: FakeIncoming) => void;
    onResponse(fakeIncoming(200));
    await pending;

    expect(options.port).toBe(443); // no port in the url → the https default
    const lookupCb = vi.fn();
    options.lookup?.('v6.example.com', {}, lookupCb);
    expect(lookupCb).toHaveBeenCalledWith(null, '2001:db8::1', 6);
  });
});
