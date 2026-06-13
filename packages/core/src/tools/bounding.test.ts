import { describe, expect, it, vi } from 'vitest';

import { boundForModel, utf8ByteLength } from './bounding.js';
import type { ToolHost, ToolResultLimits } from './types.js';

const BIG: ToolResultLimits = { maxBytes: 50_000, maxLines: 2000 };
const TINY: ToolResultLimits = { maxBytes: 20, maxLines: 3 };

describe('utf8ByteLength', () => {
  it('counts ASCII, 2-byte, 3-byte, and surrogate-pair (4-byte) code points', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2); // U+00E9
    expect(utf8ByteLength('€')).toBe(3); // U+20AC
    expect(utf8ByteLength('😀')).toBe(4); // U+1F600 surrogate pair
    expect(utf8ByteLength('')).toBe(0);
  });
});

describe('boundForModel', () => {
  const host = (overrides?: Partial<ToolHost>): ToolHost => ({ ...overrides });

  it('passes a within-limits result through untouched', async () => {
    const result = { ok: true, n: 1 };
    const bounded = await boundForModel(result, BIG, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBe(result);
    expect(bounded.summary).toContain('ok');
  });

  it('truncates an over-byte result and spills via the output store', async () => {
    const spill = vi.fn((text: string) => Promise.resolve({ ref: 'spill://abc', byteLength: text.length }));
    const text = 'x'.repeat(500);
    const bounded = await boundForModel(text, TINY, host({ outputStore: { spill } }));
    expect(bounded.truncated).toBe(true);
    expect(spill).toHaveBeenCalledOnce();
    expect(String(bounded.value)).toContain('spill://abc');
    expect(String(bounded.value)).toContain('truncated');
  });

  it('truncates over the LINE ceiling too', async () => {
    const spill = vi.fn(() => Promise.resolve({ ref: 'spill://lines', byteLength: 1 }));
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const bounded = await boundForModel(text, { maxBytes: 50_000, maxLines: 3 }, host({ outputStore: { spill } }));
    expect(bounded.truncated).toBe(true);
    expect(spill).toHaveBeenCalledOnce();
  });

  it('marks "no output store" when none is wired', async () => {
    const bounded = await boundForModel('y'.repeat(500), TINY, host());
    expect(bounded.truncated).toBe(true);
    expect(String(bounded.value)).toContain('no output store');
  });

  it('renders a non-string result as compact JSON and a string result verbatim', async () => {
    const obj = await boundForModel({ a: 1 }, BIG, host());
    expect(obj.summary).toContain('"a"');
    const str = await boundForModel('hello world', BIG, host());
    expect(str.value).toBe('hello world');
  });

  it('treats undefined as empty (never truncated)', async () => {
    const bounded = await boundForModel(undefined, TINY, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.value).toBeUndefined();
  });

  it('renders an unserializable (circular) result without throwing', async () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const bounded = await boundForModel(circular, BIG, host());
    expect(bounded.truncated).toBe(false);
    expect(bounded.summary).toBe('[unserializable]');
  });
});
