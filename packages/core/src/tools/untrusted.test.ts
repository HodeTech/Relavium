import { describe, expect, it } from 'vitest';

import { isUntrusted, markUntrusted, unwrapUntrusted } from './untrusted.js';

describe('untrusted brand', () => {
  it('round-trips a value through mark/unwrap', () => {
    const wrapped = markUntrusted({ a: 1 });
    expect(unwrapUntrusted(wrapped)).toEqual({ a: 1 });
  });

  it('detects a wrapped value and rejects a bare one', () => {
    expect(isUntrusted(markUntrusted('x'))).toBe(true);
    expect(isUntrusted({ value: 'x' })).toBe(false); // a look-alike without the brand symbol
    expect(isUntrusted('x')).toBe(false);
    expect(isUntrusted(null)).toBe(false);
    expect(isUntrusted(undefined)).toBe(false);
  });

  it('preserves primitives and undefined payloads', () => {
    expect(unwrapUntrusted(markUntrusted(undefined))).toBeUndefined();
    expect(unwrapUntrusted(markUntrusted(0))).toBe(0);
  });
});
