import { describe, expect, it } from 'vitest';

import { parseNdjson } from './test-support.js';

describe('parseNdjson', () => {
  it('parses one JSON object per non-empty line', () => {
    const text = '{"a":1}\n{"a":2}\n';
    expect(parseNdjson<{ a: number }>(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('ignores trailing/blank lines', () => {
    expect(parseNdjson('{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });

  it('rejects a non-object line (a malformed fixture fails loudly, not silently accepted)', () => {
    expect(() => parseNdjson('{"a":1}\n42')).toThrow(/expected one JSON object/);
    expect(() => parseNdjson('[1,2]')).toThrow(/expected one JSON object/); // an array is not a record
  });
});
