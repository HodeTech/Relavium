import { describe, expect, it } from 'vitest';

import {
  DurableContentPartSchema,
  MEDIA_HANDLE_PATTERN,
  type ContentPart,
  type MediaStore,
} from './content.js';
import { deInlineMedia } from './media-deinline.js';

/** A content-addressed in-memory `MediaStore` stub (pure, no crypto): same bytes ⇒ same 64-hex handle. */
function makeStubStore(): {
  store: MediaStore;
  puts: { handle: string; mimeType: string; bytes: Uint8Array }[];
} {
  const puts: { handle: string; mimeType: string; bytes: Uint8Array }[] = [];
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
    resolveForEgress: () =>
      Promise.reject(new Error('resolveForEgress is not exercised by deInlineMedia')),
    readRange: () => Promise.reject(new Error('readRange is not exercised by deInlineMedia')),
  };
  return { store, puts };
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
    const fetchUrl = (url: string): Promise<Uint8Array> => {
      fetched.push(url);
      return Promise.resolve(FETCH_BYTES);
    };
    const urlPart: unknown = [
      {
        type: 'media',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://x.example/a.png' },
      },
    ];
    const out = (await deInlineMedia(urlPart, store, fetchUrl)) as {
      source: unknown;
      byteLength: number;
    }[];
    expect(fetched).toEqual(['https://x.example/a.png']); // the host hook was called with the url
    const put0 = puts[0];
    expect(put0).toBeDefined();
    expect(put0?.bytes).toEqual(FETCH_BYTES); // the fetched bytes were content-addressed
    expect(out[0]?.source).toEqual({ kind: 'handle', ref: put0?.handle });
    expect(out[0]?.byteLength).toBe(4);
    expect(JSON.stringify(out)).not.toContain('x.example'); // the url is gone — re-hosted to a handle (I3)
  });

  it('still hard-fails a mimeType-less url part EVEN WITH a fetch hook (nothing to content-address)', async () => {
    const { store, puts } = makeStubStore();
    const fetchUrl = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array([1]));
    const bare: unknown = {
      type: 'media',
      source: { kind: 'url', url: 'https://x.example/a.png' },
    };
    await expect(deInlineMedia(bare, store, fetchUrl)).rejects.toThrow(
      /re-host a url media source/,
    );
    expect(puts).toHaveLength(0); // fail-closed before the hook — no fetch, no put
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
