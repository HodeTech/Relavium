import type { EgressDeps, HopRequest, HopResponse } from '@relavium/db';
import { SafeEgressError } from '@relavium/db';
import { describe, expect, it } from 'vitest';

import { createMcpFetch } from './mcp-fetch.js';

/**
 * The MCP transports' validated dialer
 * ([ADR-0088](../../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §2.1–§3).
 *
 * **The hole this closes was the codebase's one tracked exception to its own SSRF discipline.** Every other
 * egress path connects by validated, pinned IP; the MCP network transports validated the AUTHORED hostname
 * once, pre-connect, and then handed the socket to the vendor SDK — so a name that resolved public at check
 * time and private at connect time (DNS rebinding) sailed through, and any redirect the SDK followed was
 * never re-validated. ADR-0053 §2 named that gap and scoped the fix out; this is the fix.
 *
 * DNS and the socket are injected, so the policy is asserted deterministically rather than against a network.
 */

interface FakeOpts {
  readonly resolve?: Readonly<Record<string, readonly string[]>>;
  readonly status?: number;
  readonly location?: string;
  readonly body?: readonly Uint8Array[];
  /** Response headers the hop returns — so pass-through is observable in BOTH directions. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
}

/** An already-finished body stream — for the tests that never read one. */
function emptyBody(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true as const, value: undefined }),
    }),
  };
}

function fakeDeps(opts: FakeOpts = {}): { deps: EgressDeps; opened: HopRequest[] } {
  const opened: HopRequest[] = [];
  const deps: EgressDeps = {
    resolveHost: (hostname) => Promise.resolve(opts.resolve?.[hostname] ?? ['93.184.216.34']),
    openConnection: (request): Promise<HopResponse> => {
      opened.push(request);
      const chunks = opts.body ?? [new Uint8Array([1, 2, 3])];
      return Promise.resolve({
        status: opts.status ?? 200,
        headers: opts.responseHeaders ?? {},
        location: opts.location,
        body: {
          // A plain async iterable rather than an async generator: nothing here awaits, and the point is to
          // hand `hopBodyToStream` chunks one pull at a time exactly as a socket would.
          async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
              await Promise.resolve();
              yield chunk;
            }
          },
        },
        dispose: () => undefined,
      });
    },
  };
  return { deps, opened };
}

describe('createMcpFetch — the pinned hop', () => {
  it('connects to the VALIDATED resolved IP, not by re-resolving the hostname', async () => {
    // The pin IS the DNS-rebind defence: the address that was range-checked is the address dialled, with the
    // hostname kept as SNI so TLS verification stays on.
    const { deps, opened } = fakeDeps({ resolve: { 'api.example': ['93.184.216.34'] } });
    const response = await createMcpFetch({ deps })('https://api.example/mcp');
    expect(response.status).toBe(200);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.pinnedIp).toBe('93.184.216.34');
    expect(opened[0]?.hostname).toBe('api.example');
    expect(opened[0]?.scheme).toBe('https');
  });

  it('REFUSES a hostname that resolves to a private address — the rebind the old floor could not see', async () => {
    // The authored host is public, so the pre-connect admission passes it. Only the dialer sees the answer.
    const { deps, opened } = fakeDeps({ resolve: { 'public-looking.example': ['127.0.0.1'] } });
    await expect(createMcpFetch({ deps })('https://public-looking.example/mcp')).rejects.toThrow(
      SafeEgressError,
    );
    expect(opened).toHaveLength(0); // refused BEFORE any socket was opened
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['RFC1918', '10.1.2.3'],
    ['cloud metadata', '169.254.169.254'],
  ])('refuses a rebind to %s', async (_label, ip) => {
    const { deps } = fakeDeps({ resolve: { 'evil.example': [ip] } });
    await expect(createMcpFetch({ deps })('https://evil.example/mcp')).rejects.toMatchObject({
      code: 'blocked_host',
    });
  });

  it('refuses when ANY resolved address is private, not just the first', async () => {
    // A multi-record name whose first answer is public and second is private would otherwise slip through on
    // whichever the resolver happened to order first.
    const { deps } = fakeDeps({ resolve: { 'mixed.example': ['93.184.216.34', '10.0.0.7'] } });
    await expect(createMcpFetch({ deps })('https://mixed.example/mcp')).rejects.toMatchObject({
      code: 'blocked_host',
    });
  });
});

describe('createMcpFetch — redirects are refused, not followed (ADR-0088 §3)', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i, whatever it points at', async (status) => {
    // Stricter than ADR-0053 §2's per-hop re-validation, and deliberately: an MCP server is the exact url its
    // author declared, and no range-block expresses "and it is still the server the user chose". Refusal is
    // also provable from outside — no hop count, no ordering, no partial state.
    const { deps } = fakeDeps({ status, location: 'https://elsewhere.example/mcp' });
    await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toThrow(
      /may not redirect/,
    );
  });

  it('refuses a redirect to a PUBLIC host too — the range-block alone would have allowed it', async () => {
    // The case that separates "refuse redirects" from "re-validate each hop": this target passes every SSRF
    // check and is still not the server the author declared.
    const { deps } = fakeDeps({
      status: 302,
      location: 'https://totally-fine.example/mcp',
      resolve: { 'api.example': ['93.184.216.34'] },
    });
    await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toThrow(
      /may not redirect/,
    );
  });

  it('names the remedy, because the fix is one line of the author’s YAML', async () => {
    const { deps } = fakeDeps({ status: 308, location: '/moved' });
    await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toThrow(
      /declare the final url/,
    );
  });
});

describe('createMcpFetch — the local-endpoint scope', () => {
  const localPolicy = { localEndpoint: { host: 'localhost', port: 4000 } } as const;

  it('permits the authored local endpoint over PLAINTEXT, and dials http', async () => {
    const { deps, opened } = fakeDeps({ resolve: { localhost: ['127.0.0.1'] } });
    const response = await createMcpFetch({ ...localPolicy, deps })('http://localhost:4000/mcp');
    expect(response.status).toBe(200);
    expect(opened[0]?.scheme).toBe('http'); // the opener dispatches on the VALIDATED scheme
    expect(opened[0]?.pinnedIp).toBe('127.0.0.1');
  });

  it('refuses a SIBLING PORT on the same permitted host — over plaintext AND over TLS', async () => {
    // SEC-EGRESS-3's requirement, enforced where the connect happens: an opt-in for `:4000` is not an opt-in
    // for Redis on `:6379`, Postgres on `:5432`, SSH on `:22`, or a container socket.
    //
    // Both forms, because two different rules catch them and the SCOPE is what must hold either way. The
    // plaintext form is refused first, by the scheme rule — plaintext is permitted only for the authored
    // endpoint — so it never reaches the range check. The TLS form passes the scheme rule and is refused by
    // the range check instead. A test that asserted only one would leave the other's path unpinned.
    const { deps } = fakeDeps({ resolve: { localhost: ['127.0.0.1'] } });
    await expect(
      createMcpFetch({ ...localPolicy, deps })('http://localhost:6379/mcp'),
    ).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(
      createMcpFetch({ ...localPolicy, deps })('https://localhost:6379/mcp'),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('refuses a DIFFERENT private host, even on the permitted port', async () => {
    const { deps } = fakeDeps({ resolve: { 'other.local': ['10.0.0.9'] } });
    await expect(
      createMcpFetch({ ...localPolicy, deps })('https://other.local:4000/mcp'),
    ).rejects.toMatchObject({ code: 'blocked_host' });
  });

  it('refuses PLAINTEXT to a remote host even while a local policy is set', async () => {
    // The inversion two independent relaxation flags would have produced: the opt-in must not become a
    // process-wide "plaintext is fine".
    const { deps } = fakeDeps();
    await expect(
      createMcpFetch({ ...localPolicy, deps })('http://api.example/mcp'),
    ).rejects.toMatchObject({ code: 'insecure_url' });
  });
});

describe('createMcpFetch — response mapping', () => {
  it('streams the body rather than buffering it', async () => {
    // The Streamable HTTP transport's GET stream stays open for the whole session; buffering it would be both
    // a memory-bound violation and a session that never starts.
    const { deps } = fakeDeps({ body: [new Uint8Array([1]), new Uint8Array([2])] });
    const response = await createMcpFetch({ deps })('https://api.example/mcp');
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value).toEqual(new Uint8Array([1]));
    expect((await reader?.read())?.value).toEqual(new Uint8Array([2]));
    expect((await reader?.read())?.done).toBe(true);
  });

  it('turns an out-of-range status into a typed failure instead of a raw RangeError', async () => {
    // `new Response(…, { status })` throws for anything outside [200, 599], and a hostile endpoint can emit
    // a `999` — or a malformed status line that reads as `0`.
    const { deps } = fakeDeps({ status: 999 });
    await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toThrow(
      SafeEgressError,
    );
  });

  it('types a malformed response HEADER on BOTH arms, including the null-body one', async () => {
    // **The asymmetry a review found.** The streaming arm wrapped the `Response` construction so an invalid
    // header became a typed `SafeEgressError`; the null-body arm (204/205/304) constructed it bare, so the
    // same hostile header escaped as a raw `TypeError` — untyped, and every caller here classifies on the
    // type. The socket was never at risk; the classification was.
    const bad = { 'x y': 'v' }; // a space is illegal in a header name — `new Headers` throws
    for (const status of [200, 204]) {
      const { deps } = fakeDeps({ status, responseHeaders: bad, body: [] });
      await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toBeInstanceOf(
        SafeEgressError,
      );
    }
  });

  it('maps a null-body status to a null-body Response, rather than an empty stream', async () => {
    // The reason that arm exists at all: `new Response(<body>, { status: 204 })` throws outright.
    const { deps } = fakeDeps({ status: 204, body: [] });
    const response = await createMcpFetch({ deps })('https://api.example/mcp');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('refuses a method the shared hop cannot carry, rather than downgrading it', async () => {
    const { deps } = fakeDeps();
    await expect(
      createMcpFetch({ deps })('https://api.example/mcp', { method: 'TRACE' }),
    ).rejects.toThrow(/unsupported egress method/);
  });
});

describe('createMcpFetch — a body with no framing is ONE message (ADR-0088 §5.4)', () => {
  /**
   * The reset belongs to `text/event-stream` alone, and the note worth keeping is what it does NOT buy.
   *
   * A first draft here asserted an SSE stream of bare delimiters was refused. It is a stream of empty events,
   * and refusing it would kill a healthy session: §5.4 bounds peak MEMORY per message, never the total of a
   * stream with no defined length. The JSON case below is the opposite — an unframed body has exactly one
   * message, so bounding it IS bounding the total, and that is why the two must be told apart.
   */
  const jsonDeps = (body: string, contentType = 'application/json'): EgressDeps =>
    fakeDeps({
      body: [new TextEncoder().encode(body)],
      responseHeaders: { 'content-type': contentType },
    }).deps;

  it('refuses a JSON body padded with blank lines past the bound', async () => {
    // **The measured bypass.** The counter reset at every blank line, in EVERY body — but JSON has no message
    // framing and its trailing whitespace is unbounded and legal. `"{}" + "\n\n" x 10000` was accepted whole
    // against a FOUR-byte configured bound: 20 002 raw bytes admitted, then handed to the SDK, which calls
    // `Response.json()` on the POST path and buffers all of it. That is §5's peak-memory guarantee failing on
    // its own terms.
    const body = '{}' + '\n\n'.repeat(10_000);
    const response = await createMcpFetch({ deps: jsonDeps(body), maxMessageBytes: 4 })(
      'https://api.example/mcp',
    );
    await expect(response.text()).rejects.toThrow(/exceeded the maximum/);
  });

  it('admits a JSON body at the bound and refuses one byte past it', async () => {
    const at = await createMcpFetch({ deps: jsonDeps('{"a":1}'), maxMessageBytes: 7 })(
      'https://api.example/mcp',
    );
    expect(JSON.parse(await at.text())).toEqual({ a: 1 });

    const over = await createMcpFetch({ deps: jsonDeps('{"a":1}'), maxMessageBytes: 6 })(
      'https://api.example/mcp',
    );
    await expect(over.text()).rejects.toThrow(/exceeded the maximum/);
  });

  it('still resets per EVENT on a real SSE stream — the case the reset exists for', async () => {
    // The bound must not fire on a healthy long-lived stream: many small events, each inside the bound, sum
    // far past it. Only `text/event-stream` gets that treatment now, which is the whole distinction.
    const events = Array.from({ length: 50 }, (_, i) => `data: {"n":${i}}\n\n`).join('');
    const response = await createMcpFetch({
      deps: jsonDeps(events, 'text/event-stream; charset=utf-8'),
      maxMessageBytes: 32,
    })('https://api.example/mcp');
    expect(await response.text()).toHaveLength(events.length); // whole stream, no refusal
  });
});

describe('createMcpFetch — the per-message byte bound (ADR-0088 §5.4)', () => {
  /**
   * The TRANSPORT-level half of §5, and the only place in the MCP path that can have one: these bytes are
   * counted before anything parses them, so this bounds peak MEMORY — unlike the application-level bounds in
   * `@relavium/mcp`, which bound what is admitted. §6's invariant ("an unbounded transport must be local and
   * opted into") is only true because `http`/`sse` have this.
   */
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  /**
   * An SSE response, declared as one.
   *
   * These fixtures used to omit the content type, which was fine when EVERY body got event-boundary
   * treatment — and that was the bug: a JSON body's unbounded trailing whitespace reset the counter too. The
   * reset now belongs to `text/event-stream` alone, so a test about event boundaries has to say it is one.
   */
  const sseDeps = (body: readonly Uint8Array[]): EgressDeps =>
    fakeDeps({ body, responseHeaders: { 'content-type': 'text/event-stream' } }).deps;

  it('refuses a single oversized message mid-stream, with a typed error', async () => {
    const { deps } = fakeDeps({ body: [bytes('x'.repeat(64)), bytes('y'.repeat(64))] });
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    await reader?.read(); // the first 64 bytes are under the bound
    await expect(reader?.read()).rejects.toMatchObject({ code: 'too_large' });
  });

  it('RESETS at an SSE event boundary, so a long session is not killed by its own length', async () => {
    // The property a whole-body cap cannot have: this stream carries far more total bytes than the bound and
    // is perfectly healthy, because no single message is over it. A body cap would fire on success.
    const event = 'data: ' + 'z'.repeat(50) + '\n\n';
    const deps = sseDeps(Array.from({ length: 20 }, () => bytes(event)));
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    let chunks = 0;
    for (;;) {
      const next = await reader?.read();
      if (next?.done === true) break;
      chunks += 1;
    }
    expect(chunks).toBe(20); // 20 × ~58 bytes = far past the bound in total, none of it over per message
  });

  it('sees a boundary SPLIT ACROSS CHUNKS — a server writing one byte at a time still resets', async () => {
    // A counter that only looked within a chunk would never reset here, so a byte-at-a-time server would trip
    // the bound on a healthy stream. The scan carries the previous chunk's trailing newline.
    const body = [...('a'.repeat(60) + '\n\n' + 'b'.repeat(60))].map((c) => bytes(c));
    const deps = sseDeps(body);
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    let chunks = 0;
    for (;;) {
      const next = await reader?.read();
      if (next?.done === true) break;
      chunks += 1;
    }
    expect(chunks).toBe(body.length);
  });

  it('refuses an oversized message even when a boundary FOLLOWS it in the same chunk', async () => {
    // **The hole a mutation found in this bound's first version.** It compared the counter AFTER scanning the
    // whole chunk, with a "saw a boundary" flag that excused the comparison outright — so a chunk carrying a
    // huge message and then a `\n\n` passed, because the reset had already zeroed the counter. A bound that
    // only looks at the tail of a chunk is not a bound.
    const { deps } = fakeDeps({ body: [bytes('x'.repeat(500) + '\n\n' + 'ok')] });
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    await expect(reader?.read()).rejects.toMatchObject({ code: 'too_large' });
  });

  it('does NOT reset on a single newline — a multi-line SSE event accumulates', async () => {
    // **The hole a review's mutation exposed.** Changing the boundary from "blank line" to "any newline"
    // stayed green, because every fixture used either no embedded newline or a doubled one. An SSE event is
    // legitimately multi-line (several `data:` lines, then a blank line), so a per-line reset would let a
    // hostile server stream an arbitrarily large single logical message past this bound one line at a time —
    // which is the bound's entire reason to exist.
    const lines = 'data: ' + 'x'.repeat(60) + '\ndata: ' + 'y'.repeat(60) + '\n';
    const { deps } = fakeDeps({ body: [bytes(lines)] });
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    await expect(response.body?.getReader().read()).rejects.toMatchObject({ code: 'too_large' });
  });

  it.each([
    ['LF', '\n\n'],
    ['CRLF', '\r\n\r\n'],
    ['bare CR', '\r\r'],
  ])('resets at a blank line terminated by %s', async (_label, boundary) => {
    // The SSE spec permits all three terminators. A counter that only knew `\n` would never reset against a
    // CRLF server, so the bound would fire on a perfectly healthy stream — a false refusal, which for a
    // memory bound is the failure mode that gets it turned off.
    const event = 'data: ' + 'z'.repeat(50) + boundary;
    const deps = sseDeps(Array.from({ length: 20 }, () => bytes(event)));
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    let chunks = 0;
    for (;;) {
      const next = await reader?.read();
      if (next?.done === true) break;
      chunks += 1;
    }
    expect(chunks).toBe(20);
  });

  it('treats a delimiter-free body as ONE message — the correct reading for a plain JSON response', async () => {
    const { deps } = fakeDeps({ body: [bytes('x'.repeat(60)), bytes('x'.repeat(60))] });
    const response = await createMcpFetch({ deps, maxMessageBytes: 100 })(
      'https://api.example/mcp',
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await expect(reader?.read()).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('createMcpFetch — it is a TRANSPORT, not only a refusal machine', () => {
  /**
   * **Five mutations that each break MCP outright left this suite green**, because nothing read what the hop
   * actually received. Dropping every request header kills `Mcp-Session-Id` and any auth; dropping the body
   * empties the initialize POST; forcing GET turns every JSON-RPC call into a no-op; discarding the caller's
   * signal severs the abort path Step 1 threaded here; dropping the response headers loses the session id
   * coming back. A fetch that refuses correctly and transports nothing is not a fetch.
   */
  it('carries the METHOD, HEADERS and BODY through to the hop', async () => {
    const { deps, opened } = fakeDeps();
    await createMcpFetch({ deps })('https://api.example/mcp', {
      method: 'POST',
      headers: { 'mcp-session-id': 'abc123', authorization: 'Bearer t' },
      body: '{"jsonrpc":"2.0"}',
    });
    expect(opened[0]?.method).toBe('POST');
    expect(opened[0]?.headers).toMatchObject({
      'mcp-session-id': 'abc123',
      authorization: 'Bearer t',
    });
    expect(opened[0]?.body).toBe('{"jsonrpc":"2.0"}');
  });

  it('carries the RESPONSE headers back — the session id arrives that way', async () => {
    const { deps } = fakeDeps({ responseHeaders: { 'mcp-session-id': 'srv-1' } });
    const response = await createMcpFetch({ deps })('https://api.example/mcp');
    expect(response.headers.get('mcp-session-id')).toBe('srv-1');
  });

  it('passes the CALLER’S signal to the hop, so Step 1’s abort still reaches the socket', async () => {
    // `packages/mcp` bridges a per-request signal onto the `RequestInit`; this hop is a new link in that
    // chain, and a version that made its own controller would silently sever it.
    const seen: AbortSignal[] = [];
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (_request, signal): Promise<HopResponse> => {
        seen.push(signal);
        return Promise.resolve({
          status: 200,
          headers: {},
          location: undefined,
          // An already-finished body: these tests are about the REQUEST and the refusal, not about streaming.
          body: emptyBody(),
          dispose: () => undefined,
        });
      },
    };
    const controller = new AbortController();
    await createMcpFetch({ deps })('https://api.example/mcp', { signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });

  it('drops `accept-encoding`, because this hop does not decompress', async () => {
    // Its sibling in `validated-fetch.ts` has this test; this copy did not, and its own comment cites that
    // sibling as the reason the line exists. A gzip'd body reaches the SDK as bytes it cannot parse.
    const { deps, opened } = fakeDeps();
    await createMcpFetch({ deps })('https://api.example/mcp', {
      headers: { 'accept-encoding': 'gzip', accept: 'text/event-stream' },
    });
    expect(opened[0]?.headers).not.toHaveProperty('accept-encoding');
    expect(opened[0]?.headers).toMatchObject({ accept: 'text/event-stream' });
  });

  it('DISPOSES the socket when it refuses a redirect — a refusal must not leak a connection', async () => {
    let disposed = 0;
    const deps: EgressDeps = {
      resolveHost: () => Promise.resolve(['93.184.216.34']),
      openConnection: (): Promise<HopResponse> =>
        Promise.resolve({
          status: 302,
          headers: {},
          location: 'https://elsewhere.example/',
          // An already-finished body: these tests are about the REQUEST and the refusal, not about streaming.
          body: emptyBody(),
          dispose: () => {
            disposed += 1;
          },
        }),
    };
    await expect(createMcpFetch({ deps })('https://api.example/mcp')).rejects.toThrow(
      /may not redirect/,
    );
    expect(disposed).toBe(1);
  });
});
