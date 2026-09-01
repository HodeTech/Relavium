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
        headers: {},
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

  it('refuses a method the shared hop cannot carry, rather than downgrading it', async () => {
    const { deps } = fakeDeps();
    await expect(
      createMcpFetch({ deps })('https://api.example/mcp', { method: 'TRACE' }),
    ).rejects.toThrow(/unsupported egress method/);
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
    const { deps } = fakeDeps({ body: Array.from({ length: 20 }, () => bytes(event)) });
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
    const { deps } = fakeDeps({ body });
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
