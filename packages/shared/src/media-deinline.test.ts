import { describe, expect, it } from 'vitest';

import {
  DurableContentPartSchema,
  MEDIA_HANDLE_PATTERN,
  type ContentPart,
  type MediaStore,
} from './content.js';
import { deInlineMedia } from './media-deinline.js';

/** A content-addressed in-memory `MediaStore` stub (pure, no crypto): same bytes ⇒ same 64-hex handle. */
/**
 * An `AsyncIterable` over a fixed chunk list — the stub form of a streamed body.
 *
 * Written with an explicit `Symbol.asyncIterator` rather than an `async function*` because a stub over a
 * fixed array genuinely has nothing to await, and `require-await` is right to flag one that pretends
 * otherwise. This shape is honest about being synchronous underneath while satisfying the contract.
 */
function asyncChunks(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<Uint8Array>> => {
          const chunk = chunks[i];
          i += 1;
          return Promise.resolve(
            chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk },
          );
        },
      };
    },
  };
}

function makeStubStore(): {
  store: MediaStore;
  puts: { handle: string; mimeType: string; bytes: Uint8Array }[];
  /** Handles written through `putStream` — so a test can prove WHICH method a carrier took. */
  streamPuts: string[];
} {
  const puts: { handle: string; mimeType: string; bytes: Uint8Array }[] = [];
  const streamPuts: string[] = [];
  const fakeDigest = (bytes: Uint8Array): string => {
    let hex = '';
    for (let seed = 0; seed < 8; seed += 1) {
      let h = (2166136261 ^ (seed * 0x9e3779b1)) >>> 0;
      for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
      hex += h.toString(16).padStart(8, '0');
    }
    return hex; // 8 × 8 = 64 lowercase hex
  };
  const store: MediaStore = {
    put: (bytes, mimeType) => {
      const handle = `media://sha256-${fakeDigest(bytes)}`;
      puts.push({ handle, mimeType, bytes });
      return Promise.resolve(handle);
    },
    get: (handle) => {
      const found = puts.find((p) => p.handle === handle);
      return found === undefined
        ? Promise.reject(new Error(`no bytes for ${handle}`))
        : Promise.resolve(found.bytes);
    },
    // The streaming write (ADR-0089 §2). It CONCATENATES here only because a stub must produce a digest;
    // a real store writes as it consumes. The concatenation is deliberately confined to the fake, so a
    // regression that routed a url through `put` would still be visible in `puts` vs `streamPuts`.
    putStream: async (chunks, mimeType) => {
      const collected: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of chunks) {
        collected.push(chunk);
        total += chunk.length;
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const chunk of collected) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      const handle = `media://sha256-${fakeDigest(bytes)}`;
      puts.push({ handle, mimeType, bytes });
      streamPuts.push(handle);
      return handle;
    },
    resolveForEgress: () =>
      Promise.reject(new Error('resolveForEgress is not exercised by deInlineMedia')),
    readRange: () => Promise.reject(new Error('readRange is not exercised by deInlineMedia')),
  };
  return { store, puts, streamPuts };
}

const base64MediaPart: ContentPart = {
  type: 'media',
  mimeType: 'image/png',
  source: { kind: 'base64', data: 'aGVsbG8=' }, // "hello"
  name: 'pic.png',
};

describe('deInlineMedia (1.AF, ADR-0042 §2 — flight→durable transform)', () => {
  it('replaces an in-flight base64 media part with a handle-only durable part (byteLength set)', async () => {
    const { store, puts } = makeStubStore();
    const out = await deInlineMedia([{ type: 'text', text: 'hi' }, base64MediaPart], store);
    const put0 = puts[0];
    expect(put0).toBeDefined();
    expect(put0?.mimeType).toBe('image/png');
    const media = out[1];
    expect(media?.type).toBe('media');
    if (media?.type === 'media') {
      expect(media.source).toEqual({ kind: 'handle', ref: put0?.handle });
      expect(media.source.ref).toMatch(MEDIA_HANDLE_PATTERN);
      expect(media.byteLength).toBe(5); // "hello"
      expect(media.name).toBe('pic.png');
    }
    // The output parses as a durable content part (handle-only, no bytes) — the I3 invariant.
    for (const part of out) expect(DurableContentPartSchema.safeParse(part).success).toBe(true);
  });

  it('returns the input unchanged on the no-media fast path (same reference, no put)', async () => {
    const { store, puts } = makeStubStore();
    const parts: ContentPart[] = [{ type: 'text', text: 'no media here' }];
    const out = await deInlineMedia(parts, store);
    expect(out).toBe(parts); // identical reference — no clone, no store round-trip
    expect(puts).toHaveLength(0);
  });

  it('rewrites a base64 media part nested in an opaque (unknown) value', async () => {
    const { store, puts } = makeStubStore();
    const value: unknown = {
      node: 'gen',
      output: { artifacts: [base64MediaPart] },
      meta: { n: 1 },
    };
    const out = await deInlineMedia(value, store);
    const put0 = puts[0];
    expect(put0).toBeDefined();
    expect(out).not.toBe(value); // non-mutating: a fresh tree
    const tree = out as { output: { artifacts: { source: unknown }[] } };
    expect(tree.output.artifacts[0]?.source).toEqual({ kind: 'handle', ref: put0?.handle });
    // the original input is untouched
    const original = value as { output: { artifacts: { source: unknown }[] } };
    expect(original.output.artifacts[0]?.source).toEqual({ kind: 'base64', data: 'aGVsbG8=' });
  });

  it('is idempotent (same bytes → same handle) and leaves an already-handle part unchanged', async () => {
    const { store, puts } = makeStubStore();
    const a = await deInlineMedia([base64MediaPart], store);
    const b = await deInlineMedia([base64MediaPart], store);
    const a0 = a[0];
    const b0 = b[0];
    const ha = a0?.type === 'media' ? a0.source.ref : null;
    const hb = b0?.type === 'media' ? b0.source.ref : null;
    expect(ha).not.toBeNull();
    expect(ha).toBe(hb); // content-addressed: identical bytes ⇒ identical handle
    expect(puts).toHaveLength(2);
    // an already-handle media part triggers no put and is passed through unchanged
    const handlePart: ContentPart = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'handle', ref: ha ?? 'media://sha256-' + '0'.repeat(64) },
    };
    const out = await deInlineMedia([handlePart], store);
    expect(puts).toHaveLength(2); // unchanged — the handle part did not put
    expect(out[0]).toEqual(handlePart);
  });

  it('preserves cycles, Maps, and Sets while still de-inlining media within them', async () => {
    const { store } = makeStubStore();
    const cyclic: Record<string, unknown> = { tag: 'root', media: base64MediaPart };
    cyclic['self'] = cyclic; // cycle
    const value: unknown = {
      set: new Set([1, 2]),
      map: new Map([['k', base64MediaPart]]),
      cyclic,
    };
    const out = (await deInlineMedia(value, store)) as {
      set: Set<unknown>;
      map: Map<string, { source: unknown }>;
      cyclic: Record<string, unknown>;
    };
    expect(out.set).toBeInstanceOf(Set);
    expect([...out.set]).toEqual([1, 2]);
    expect(out.map.get('k')?.source).toMatchObject({ kind: 'handle' });
    expect(out.cyclic['self']).toBe(out.cyclic); // the cycle is preserved in the clone
    const media = out.cyclic['media'] as { source: unknown };
    expect(media.source).toMatchObject({ kind: 'handle' });
  });

  it('hard-fails on an un-re-hosted url media part, even url-ONLY (re-host is the D9 engine step)', async () => {
    const { store, puts } = makeStubStore();
    // url-only: containsDurableUnsafeMedia flags a url media part (not just bytes), so the walk runs and
    // the rewrite throws — a url must never silently pass through to a durable position.
    const urlOnly: unknown = [
      {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://x.example/a.png' },
      },
    ];
    await expect(deInlineMedia(urlOnly, store)).rejects.toThrow(/re-host a url media source/);
    expect(puts).toHaveLength(0);
  });

  // --- D9: WITH an injected fetch hook, a canonical url media part is RE-HOSTED to a handle.
  it('re-hosts a url media part to a handle via the injected fetch hook (D9 — no url in output)', async () => {
    const { store, puts } = makeStubStore();
    const fetched: string[] = [];
    const FETCH_BYTES = new Uint8Array([1, 2, 3, 4]);
    // A url takes the STREAMING hook now (ADR-0089 §2) — it is the unbounded carrier, so it must never be
    // whole-buffered. Yielded in two chunks so the counting wrapper is exercised across boundaries.
    const streamUrl = (url: string): AsyncIterable<Uint8Array> => {
      fetched.push(url);
      return asyncChunks([FETCH_BYTES.slice(0, 2), FETCH_BYTES.slice(2)]);
    };
    const urlPart: unknown = [
      {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://x.example/a.png' },
      },
    ];
    const out = (await deInlineMedia(urlPart, store, { streamUrl })) as {
      source: unknown;
      byteLength: number;
    }[];
    expect(fetched).toEqual(['https://x.example/a.png']); // the host hook was called with the url
    const put0 = puts[0];
    expect(put0).toBeDefined();
    expect(put0?.bytes).toEqual(FETCH_BYTES); // the streamed bytes were content-addressed, in order
    expect(out[0]?.source).toEqual({ kind: 'handle', ref: put0?.handle });
    expect(out[0]?.byteLength).toBe(4);
    expect(JSON.stringify(out)).not.toContain('x.example'); // the url is gone — re-hosted to a handle (I3)
  });

  it('REFUSES a url when no streaming hook is wired — it does not fall back to the whole-buffer one', async () => {
    // ADR-0089 §2's load-bearing sentence: an optional guarantee with a buffering fallback is not a
    // guarantee. A url is the UNBOUNDED carrier (unlike base64, which the schema caps at
    // INLINE_MEDIA_CEILING), so a host offering only `fetchUrl` must be refused rather than quietly routed
    // through it — which is exactly how "never fully buffered" would have stayed unmet while looking fixed.
    const { store, puts } = makeStubStore();
    let fetchCalls = 0;
    const fetchUrl = (): Promise<Uint8Array> => {
      fetchCalls += 1;
      return Promise.resolve(new Uint8Array([1]));
    };
    const urlPart: unknown = [
      {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://x.example/a.png' },
      },
    ];
    await expect(deInlineMedia(urlPart, store, { fetchUrl })).rejects.toThrow(
      /no streaming media-egress hook/,
    );
    expect(fetchCalls).toBe(0); // the whole-buffer hook is never reached
    expect(puts).toHaveLength(0);
  });

  it('takes putStream for a url and put for base64 — the carrier decides the method', async () => {
    // The two are not interchangeable. `put` stays correct for a decoded base64 body (already whole, already
    // bounded); routing a url through it is the defect. Asserted by WHICH method each carrier reached.
    const { store, streamPuts } = makeStubStore();
    const streamUrl = (): AsyncIterable<Uint8Array> => asyncChunks([new Uint8Array([9])]);
    await deInlineMedia([base64MediaPart], store, { streamUrl });
    expect(streamPuts).toHaveLength(0); // base64 → put

    await deInlineMedia(
      [
        {
          type: 'media',
          mimeType: 'image/png',
          source: { kind: 'url', url: 'https://x.example/a.png' },
        },
      ] as unknown as ContentPart[],
      store,
      { streamUrl },
    );
    expect(streamPuts).toHaveLength(1); // url → putStream
  });

  it('still hard-fails a mimeType-less url part EVEN WITH a fetch hook (nothing to content-address)', async () => {
    const { store, puts } = makeStubStore();
    let fetchCalls = 0;
    const streamUrl = (): AsyncIterable<Uint8Array> => {
      fetchCalls += 1;
      return asyncChunks([new Uint8Array([1])]);
    };
    const bare: unknown = {
      type: 'media',
      source: { kind: 'url', url: 'https://x.example/a.png' },
    };
    await expect(deInlineMedia(bare, store, { streamUrl })).rejects.toThrow(/no mimeType/);
    expect(puts).toHaveLength(0); // fail-closed before the hook — no fetch, no put
    expect(fetchCalls).toBe(0); // the hook is never invoked — it fails closed BEFORE any fetch
  });

  // --- I3 leak regression: non-canonical byte carriers must HARD-FAIL, never pass through (review HIGH #1)
  it('hard-fails (no leak, no put) on a base64 data: URI string in an opaque value', async () => {
    const { store, puts } = makeStubStore();
    const value: unknown = { node: 'x', out: 'data:image/png;base64,aGVsbG8=' };
    await expect(deInlineMedia(value, store)).rejects.toThrow(/data: URI/);
    expect(puts).toHaveLength(0);
  });

  it('hard-fails on a loose base64 source not wrapped in a media part', async () => {
    const { store } = makeStubStore();
    const value: unknown = { smuggled: { kind: 'base64', data: 'aGVsbG8=' } };
    await expect(deInlineMedia(value, store)).rejects.toThrow(/loose base64 media source/);
  });

  it('hard-fails on a raw binary buffer (never mangles a typed array into a numeric object)', async () => {
    const { store } = makeStubStore();
    const value: unknown = { blob: new Uint8Array([1, 2, 3, 4, 5]) };
    await expect(deInlineMedia(value, store)).rejects.toThrow(/raw binary buffer/);
  });

  it('hard-fails (modality fail-closed) on a media part with an unknown mimeType', async () => {
    const { store } = makeStubStore();
    const bad: unknown = [
      { type: 'media', mimeType: 'application/zip', source: { kind: 'base64', data: 'aGVsbG8=' } },
    ];
    await expect(deInlineMedia(bad, store)).rejects.toThrow(/unsupported media mimeType/);
  });

  // --- review HIGH (rank 1): a url media part with NO mimeType slips past isInflightMediaPart (which
  // requires a string mimeType) but IS flagged by the scan (isUrlMediaPart requires no mimeType) — it must
  // HARD-FAIL, never silently clone the url through to a durable position. Pins the scan/rewrite-asymmetry fix.
  it('hard-fails on a url media part with NO mimeType (mimeType-less opaque url, no leak, no put)', async () => {
    const { store, puts } = makeStubStore();
    const bare: unknown = {
      type: 'media',
      source: { kind: 'url', url: 'https://x.example/a.png' },
    };
    await expect(deInlineMedia(bare, store)).rejects.toThrow(/re-host a url media source/);
    // and nested inside an opaque tree (the unknown-overload walk)
    const nested: unknown = [
      { type: 'media', source: { kind: 'url', url: 'https://x.example/b.png' } },
    ];
    await expect(deInlineMedia(nested, store)).rejects.toThrow(/re-host a url media source/);
    expect(puts).toHaveLength(0);
  });

  it('hard-fails (invalid base64) on a media part whose base64 source.data is not valid base64', async () => {
    const { store, puts } = makeStubStore();
    const bad: unknown = [
      { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: '@@@@' } },
    ];
    await expect(deInlineMedia(bad, store)).rejects.toThrow(/not valid base64/);
    expect(puts).toHaveLength(0);
  });

  it('hard-fails (TypeError naming the real fault) on a base64 media source whose data is not a string', async () => {
    const { store, puts } = makeStubStore();
    // Co-locate with a real carrier so the scan triggers the walk — a lone non-string-data source is NOT
    // flagged (its data isn't a string), so it would otherwise fast-path through unchanged (and fail the
    // durable Zod schema later). The walk reaches mediaPartBytes (isInflightMediaPart only needs a string
    // mimeType + a string kind), and the message names the actual fault (non-string data), not "unsupported kind".
    const bad: unknown = [
      { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 42 } },
      base64MediaPart,
    ];
    await expect(deInlineMedia(bad, store)).rejects.toThrow(/source\.data must be a string/);
    expect(puts).toHaveLength(0); // throws on item 0 before the valid carrier is put
  });

  it('hard-fails on an unknown media source kind (co-located with a real carrier so the scan runs)', async () => {
    const { store } = makeStubStore();
    // A standalone { kind:'blob' } is byte/url-free, so the scan skips it (returns it unchanged); co-locating
    // a real base64 carrier makes the walk run and reach the unknown-kind throw (fail-closed on unknown kind).
    const value: unknown = [
      { type: 'media', mimeType: 'image/png', source: { kind: 'blob', ref: 'x' } },
      base64MediaPart,
    ];
    await expect(deInlineMedia(value, store)).rejects.toThrow(/unsupported media source kind/);
  });

  it('puts a shared media-part reference only once within a single call (cache-before-recursion dedup)', async () => {
    const { store, puts } = makeStubStore();
    await deInlineMedia([base64MediaPart, base64MediaPart], store);
    expect(puts).toHaveLength(1); // the same reference is rewritten once, not per occurrence
  });
});
