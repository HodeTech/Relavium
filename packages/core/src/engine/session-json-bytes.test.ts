import { utf8ByteLength } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { sessionJsonBytes } from './session-json-bytes.js';

describe('session JSON byte measurement', () => {
  const prototypeKeys: unknown = JSON.parse('{"__proto__":{"constructor":"data"},"10":1,"2":2}');
  const sparse: unknown[] = [undefined, () => 1, Symbol('null')];
  sparse[4] = 3;
  const cases: readonly unknown[] = [
    null,
    [false, true, 0, -0, 1e30, Number.NaN, Number.POSITIVE_INFINITY],
    'é€😀\n\t"\\\ud800\udc00\ud800',
    { 'é\n"': '😀', empty: [], nested: { value: null } },
    { omitted: undefined, function: () => 1, symbol: Symbol('omitted'), present: 3 },
    sparse,
    { first: { x: 1 }, second: { x: 1 } },
    prototypeKeys,
  ];

  it.each(cases.map((value, index) => ({ value, index })))(
    'matches native JSON encoding for leaf $index on both ordinary and deep paths',
    ({ value }) => {
      const expected = utf8ByteLength(JSON.stringify(value) ?? '');
      expect(sessionJsonBytes(value)).toBe(expected);
      let deep: unknown = value;
      const depth = 15_000;
      for (let index = 0; index < depth; index += 1) deep = [deep];
      expect(sessionJsonBytes(deep)).toBe(expected + depth * 2);
    },
  );

  it('counts repeated references independently and refuses cycles', () => {
    const shared = { value: 'é' };
    let deep: unknown = [shared, shared];
    for (let index = 0; index < 15_000; index += 1) deep = [deep];
    expect(sessionJsonBytes(deep)).toBe(30_000 + utf8ByteLength(JSON.stringify([shared, shared])));
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(sessionJsonBytes(cycle)).toBeUndefined();
  });

  it('retains native custom serialization and refuses a deep hook rather than guessing its encoding', () => {
    const custom = { toJSON: () => 'é' };
    expect(sessionJsonBytes(custom)).toBe(4);
    let deep: unknown = custom;
    for (let index = 0; index < 15_000; index += 1) deep = [deep];
    expect(sessionJsonBytes(deep)).toBeUndefined();
    expect(sessionJsonBytes(1n)).toBeUndefined();
    expect(sessionJsonBytes(undefined)).toBe(0);
  });
});
