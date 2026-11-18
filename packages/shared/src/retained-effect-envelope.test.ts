import { describe, expect, it } from 'vitest';
import {
  decodeRetainedEffectEnvelope,
  RetainedEffectEnvelopeSchema,
} from './retained-effect-envelope.js';
import { blocksResume } from './run.js';

const valid = {
  v: 2,
  hasValue: true,
  value: null,
  hasMappedValue: false,
  outputMapping: null,
  truncated: false,
  summary: '',
};
describe('strict retained effect evidence', () => {
  it('retains explicit null and absent values independently of mapping presence', () => {
    for (const value of [
      valid,
      { ...valid, hasValue: false, value: undefined },
      {
        v: 2,
        hasValue: false,
        hasMappedValue: false,
        outputMapping: {},
        truncated: true,
        summary: 'bounded',
      },
      { ...valid, outputMapping: { key: 'a' }, hasMappedValue: true, mapped: null },
    ]) {
      const absent =
        value.hasValue === false
          ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'value'))
          : value;
      expect(decodeRetainedEffectEnvelope(absent)).toEqual(absent);
      expect(blocksResume({ state: 'committed', result: absent })).toBe(false);
    }
  });
  it.each([
    null,
    [],
    {},
    1,
    'bare',
    { value: 1, truncated: false, summary: '', hadMapping: false },
    { ...valid, v: 1 },
    { ...valid, v: 3 },
    { ...valid, extra: 1 },
    { ...valid, value: undefined },
    { ...valid, hasValue: false },
    { ...valid, hasValue: false, value: undefined },
    { ...valid, hasMappedValue: true },
    { ...valid, mapped: null },
    { ...valid, hasMappedValue: true, mapped: null },
    { ...valid, outputMapping: [] },
    { ...valid, outputMapping: { a: 1 } },
    { ...valid, truncated: 0 },
    { ...valid, summary: null },
  ])('refuses malformed or insufficient evidence %# before resume', (result) => {
    expect(RetainedEffectEnvelopeSchema.safeParse(result).success).toBe(false);
    expect(decodeRetainedEffectEnvelope(result)).toBeUndefined();
    expect(blocksResume({ state: 'committed', result })).toBe(true);
  });
  it('requires own data properties without consulting accessors or accepting reflective traps', () => {
    let reads = 0;
    const accessor = {
      ...valid,
      get summary() {
        reads++;
        return 'hidden';
      },
    };
    const inherited: unknown = Object.create(valid);
    const symbolic = { ...valid, [Symbol('unknown')]: 1 };
    const trapped = new Proxy(valid, {
      ownKeys: () => {
        throw new Error('private trap');
      },
    });
    for (const result of [accessor, inherited, symbolic, trapped]) {
      expect(decodeRetainedEffectEnvelope(result)).toBeUndefined();
      expect(blocksResume({ state: 'committed', result })).toBe(true);
    }
    expect(reads).toBe(0);
  });
});

it('retains every own mapping key as exact replay evidence', () => {
  const mapping: unknown = JSON.parse('{"__proto__":"ignored","constructor":"x","safe":"y"}');
  const decoded = decodeRetainedEffectEnvelope({ ...valid, outputMapping: mapping });
  expect(Object.keys(decoded?.outputMapping ?? {})).toEqual(['__proto__', 'constructor', 'safe']);
  expect(Object.hasOwn(decoded?.outputMapping ?? {}, '__proto__')).toBe(true);
});
