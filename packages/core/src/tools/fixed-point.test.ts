import { describe, expect, it } from 'vitest';

import { fixedPointOf, toFixedPoint } from './fixed-point.js';

describe('toFixedPoint', () => {
  const failed = '[failed]';
  const passes = (outputs: readonly string[]) => {
    const calls: string[] = [];
    const pass = (text: string) => {
      calls.push(text);
      return outputs[calls.length - 1] ?? text;
    };
    return { pass, calls };
  };

  it('returns an input the first pass leaves unchanged after one pass', () => {
    const { pass, calls } = passes(['a']);
    expect(toFixedPoint(pass, 'a', failed)).toBe('a');
    expect(calls).toEqual(['a']);
  });

  it('returns the first output once a second pass confirms it', () => {
    const { pass, calls } = passes(['b', 'b']);
    expect(toFixedPoint(pass, 'a', failed)).toBe('b');
    expect(calls).toEqual(['a', 'b']);
  });

  it('returns the second output once a third pass confirms it', () => {
    const { pass, calls } = passes(['b', 'c', 'c']);
    expect(toFixedPoint(pass, 'a', failed)).toBe('c');
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('fails closed when the third pass still changes the text', () => {
    const { pass, calls } = passes(['b', 'c', 'd']);
    expect(toFixedPoint(pass, 'a', failed)).toBe(failed);
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});

describe('fixedPointOf', () => {
  it('reports a settled output and an unsettled one apart', () => {
    let calls = 0;
    const settles = (text: string) => (text === 'a' ? 'b' : text);
    const drifts = (text: string) => {
      calls += 1;
      return `${text}+`;
    };
    expect(fixedPointOf(settles, 'a')).toBe('b');
    expect(fixedPointOf(drifts, 'a')).toBeUndefined();
    expect(calls).toBe(3);
  });
});
