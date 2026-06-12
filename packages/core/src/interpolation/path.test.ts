import { describe, expect, it } from 'vitest';

import { InterpolationError } from '../errors.js';

import { getByPath } from './path.js';

describe('getByPath', () => {
  const obj = {
    score: 7,
    issues: [{ line: 1 }, { line: 2 }],
    'a-b': 'dashed',
    nested: { deep: { value: 'x' } },
  };

  it('returns the value unchanged for an empty path', () => {
    expect(getByPath(obj, '')).toBe(obj);
  });

  it('reads a dotted property', () => {
    expect(getByPath(obj, '.score')).toBe(7);
  });

  it('reads a numeric array index then a property', () => {
    expect(getByPath(obj, '.issues[0].line')).toBe(1);
    expect(getByPath(obj, '.issues[1].line')).toBe(2);
  });

  it('reads a quoted bracket key (single or double quotes)', () => {
    expect(getByPath(obj, '["a-b"]')).toBe('dashed');
    expect(getByPath(obj, "['a-b']")).toBe('dashed');
  });

  it('walks a deep chain', () => {
    expect(getByPath(obj, '.nested.deep.value')).toBe('x');
  });

  it('returns undefined for a missing property (no throw)', () => {
    expect(getByPath(obj, '.nope')).toBeUndefined();
    expect(getByPath(obj, '.nested.missing.deeper')).toBeUndefined();
  });

  it('returns undefined when indexing a non-array or keying a non-object', () => {
    expect(getByPath(obj, '.score[0]')).toBeUndefined(); // index into a number
    expect(getByPath(obj, '.issues.line')).toBeUndefined(); // named key on an array
  });

  it('returns undefined when hopping off null/undefined mid-chain', () => {
    expect(getByPath({ a: null }, '.a.b')).toBeUndefined();
    expect(getByPath(undefined, '.a')).toBeUndefined();
  });

  it('reads a quoted key that itself contains a `]` (scanner is quote-aware, not first-`]`)', () => {
    expect(getByPath({ 'weird]key': 'v' }, '["weird]key"]')).toBe('v');
    expect(getByPath({ scan: { 'a]b': 1 } }, '.scan["a]b"]')).toBe(1);
  });

  it('tolerates whitespace inside brackets, for both quoted keys and numeric indices', () => {
    expect(getByPath({ k: 'v' }, '[ "k" ]')).toBe('v');
    expect(getByPath([10, 20], '[ 1 ]')).toBe(20);
  });

  it('does not read a polluted Array.prototype index (own-index guard)', () => {
    Reflect.set(Array.prototype, 0, 'POLLUTED');
    try {
      expect(getByPath([], '[0]')).toBeUndefined(); // empty array → own index absent → undefined
      expect(getByPath([{ a: 1 }], '[0].a')).toBe(1); // a real own index still resolves
    } finally {
      Reflect.deleteProperty(Array.prototype, 0);
    }
  });

  it('rejects a huge (non-safe-integer) or negative numeric index as invalid_path', () => {
    for (const bad of ['[99999999999999999999]', '[-1]']) {
      expect(() => getByPath([1, 2, 3], bad)).toThrow(InterpolationError);
    }
  });

  it('returns undefined for an inherited prototype member (own-property guard)', () => {
    // Without the guard these would resolve live Object.prototype members rather than undefined.
    for (const proto of [
      '.toString',
      '.constructor',
      '.__proto__',
      '.hasOwnProperty',
      '.valueOf',
    ]) {
      expect(getByPath({ a: 1 }, proto)).toBeUndefined();
    }
    // An OWN property that happens to shadow a prototype name still resolves.
    expect(getByPath({ toString: 'mine' }, '.toString')).toBe('mine');
  });

  it.each(['..score', '.', '[0', '[nope]', '.issues[]', 'score', '["k', '["k"x]'])(
    'throws InterpolationError(invalid_path) for the malformed path %j',
    (bad) => {
      let thrown: unknown;
      try {
        getByPath(obj, bad, '{{run.outputs["x"]}}');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(InterpolationError);
      if (!(thrown instanceof InterpolationError)) {
        throw new Error('expected getByPath to throw InterpolationError');
      }
      expect(thrown.code).toBe('invalid_path');
      expect(thrown.location).toBe('{{run.outputs["x"]}}');
    },
  );
});
