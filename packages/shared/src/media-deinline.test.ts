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
    const value: unknown = { node: 'gen', output: { artifacts: [base64MediaPart] }, meta: { n: 1 } };
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

  it('throws on an un-re-hosted url media source (re-host is the D9 engine step)', async () => {
    const { store } = makeStubStore();
    // a url part is not flagged by the byte scan, so pair it with a base64 part to force the walk
    const value: unknown = [
      base64MediaPart,
      { type: 'media', mimeType: 'image/png', source: { kind: 'url', url: 'https://x.example/a.png' } },
    ];
    await expect(deInlineMedia(value, store)).rejects.toThrow(/re-host a url media source/);
  });
});
