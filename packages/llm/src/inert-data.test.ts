import { describe, expect, it } from 'vitest';

import { UnsupportedRequestDataError } from './errors.js';
import { copyInertData } from './inert-data.js';

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) throw new Error('expected container');
  const result: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return result;
}

function parsedData(json: string): unknown {
  const value: unknown = JSON.parse(json);
  return value;
}

function boxedData(value: unknown): unknown {
  const boxed: unknown = Object(value);
  return boxed;
}

describe('inert request graph ownership (ADR-0102)', () => {
  it('owns mutable caller data, preserves cross-field aliases and isolates mutable working copies', () => {
    const schema = { type: 'object', properties: { text: { type: 'string' } } };
    const data = { tools: [{ schema }], providerOptions: { responseJsonSchema: schema } };
    const owned = copyInertData(data);
    const tools = field(owned, 'tools');
    expect(Array.isArray(tools)).toBe(true);
    if (!Array.isArray(tools)) throw new Error('expected tools');
    const captured = field(tools[0], 'schema');
    expect(captured).toBe(field(field(owned, 'providerOptions'), 'responseJsonSchema'));
    schema.properties.text.type = 'number';
    expect(field(field(field(captured, 'properties'), 'text'), 'type')).toBe('string');
    expect(Object.isFrozen(schema)).toBe(false);
    expect(Object.isFrozen(captured)).toBe(true);
    const working = copyInertData(owned, false);
    const other = copyInertData(owned, false);
    const workingOptions = field(working, 'providerOptions');
    const workingSchema = field(workingOptions, 'responseJsonSchema');
    const workingTools = field(working, 'tools');
    if (!Array.isArray(workingTools)) throw new Error('expected working tools');
    expect(field(workingTools[0], 'schema')).toBe(workingSchema);
    expect(workingSchema).not.toBe(captured);
    Object.defineProperty(workingSchema, 'converted', { value: true });
    expect(field(field(workingTools[0], 'schema'), 'converted')).toBe(true);
    expect(field(captured, 'converted')).toBeUndefined();
    expect(
      field(field(field(other, 'providerOptions'), 'responseJsonSchema'), 'converted'),
    ).toBeUndefined();
    expect(Object.getPrototypeOf(workingSchema)).toBeNull();
  });

  it('retains primitive values, undefined own-presence and trusted array serialization', () => {
    const data = { missing: undefined, values: [undefined, null, NaN, Infinity, -0, false, 'x'] };
    const owned = copyInertData(data);
    expect(Object.getOwnPropertyDescriptor(owned, 'missing')).toBeDefined();
    expect(field(owned, 'values')).toEqual(data.values);
    expect(JSON.stringify(owned)).toBe(JSON.stringify(data));
    expect(Object.getPrototypeOf(owned)).toBeNull();
    const array = field(owned, 'values');
    expect(Object.getOwnPropertyDescriptor(array, 'toJSON')).toMatchObject({
      value: undefined,
      enumerable: false,
    });
    expect(Object.getPrototypeOf(array)).toBe(Array.prototype);
    expect(JSON.stringify(copyInertData(owned, false))).toBe(JSON.stringify(data));
  });

  it('accepts frozen inert data without freezing any caller object', () => {
    const caller = Object.freeze({ list: Object.freeze([{ value: 1 }]) });
    const owned = copyInertData(caller);
    expect(JSON.stringify(owned)).toBe(JSON.stringify(caller));
    expect(Object.isFrozen(caller.list[0])).toBe(false);
    expect(owned).not.toBe(caller);
  });

  it('ignores Map/Set internal entries, preserving inert own properties and aliases', () => {
    const map = new Map<unknown, unknown>();
    map.set(map, map);
    const set = new Set<unknown>();
    set.add(set);
    Object.defineProperty(map, 'value', { value: { x: 'retained' }, enumerable: true });
    const caller = { map, again: map, set };
    const owned = copyInertData(caller);
    expect(field(owned, 'map')).toBe(field(owned, 'again'));
    expect(JSON.stringify(owned)).toBe(JSON.stringify(caller));
    expect(Object.getPrototypeOf(field(owned, 'map'))).toBeNull();
    expect(Object.getPrototypeOf(field(owned, 'set'))).toBeNull();
  });

  it('captures a deep acyclic and repeated shared graph without stack or occurrence amplification', () => {
    let root: Record<string, unknown> = { leaf: 'retained' };
    for (let i = 0; i < 20_000; i += 1) root = { left: root, right: root };
    let owned = copyInertData(root);
    for (let i = 0; i < 20_000; i += 1) {
      expect(field(owned, 'left')).toBe(field(owned, 'right'));
      owned = field(owned, 'left');
    }
    expect(field(owned, 'leaf')).toBe('retained');
  }, 30_000); // Structural stress, not a five-second latency guarantee on shared CI runners.

  const unsupported: readonly [string, () => unknown][] = [
    ['function', () => ({ nested: () => 'private' })],
    ['symbol value', () => ({ nested: Symbol('private') })],
    ['bigint', () => ({ nested: 1n })],
    ['date', () => new Date(0)],
    [
      'boxed number',
      () => {
        const value: unknown = Object(1);
        return value;
      },
    ],
    [
      'custom class',
      () =>
        new (class Custom {
          value = 1;
        })(),
    ],
    ['Map subclass', () => new (class Custom extends Map {})()],
    ['Set subclass', () => new (class Custom extends Set {})()],
    ['sparse array', () => new Array<unknown>(2)],
    ['additional array property', () => Object.assign([1], { private: true })],
    [
      'caller array serializer shadow',
      () => Object.defineProperty([1], 'toJSON', { value: undefined }),
    ],
    ['non-enumerable record', () => Object.defineProperty({}, 'private', { value: 1 })],
    ['symbol record key', () => ({ [Symbol('private')]: 1 })],
    ['callable own serializer', () => ({ toJSON: () => 'private' })],
    ['literal prototype key', () => parsedData('{"__proto__":{"private":true}}')],
    ['nested literal prototype key', () => ({ schema: parsedData('{"__proto__":null}') })],
    [
      'Map literal prototype key',
      () => Object.defineProperty(new Map(), '__proto__', { value: 1, enumerable: true }),
    ],
    [
      'cycle',
      () => {
        const value: Record<string, unknown> = {};
        value['next'] = value;
        return value;
      },
    ],
    [
      'ancestor cycle behind an alias',
      () => {
        const root: Record<string, unknown> = {};
        const child = { root };
        root['child'] = child;
        return { left: root, right: root };
      },
    ],
    [
      'inspection trap',
      () =>
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('private cause');
            },
          },
        ),
    ],
  ];
  it.each(unsupported)('refuses %s with a fixed content-free error', (_name, factory) => {
    let observed: unknown;
    try {
      copyInertData(factory());
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(UnsupportedRequestDataError);
    expect(observed).toMatchObject({
      code: 'unsupported_request_data',
      message: 'request data must contain only supported inert values',
    });
    expect(Object.getOwnPropertyDescriptor(observed, 'cause')).toBeUndefined();
    expect(String(observed)).not.toContain('private');
  });

  it('refuses accessors without running them', () => {
    let invoked = false;
    const caller = {
      get nested() {
        invoked = true;
        throw new Error('private');
      },
    };
    expect(() => copyInertData(caller)).toThrow(UnsupportedRequestDataError);
    expect(invoked).toBe(false);
  });

  it.each([{ values: [] }, { values: [1, undefined, { value: 'retained' }] }])(
    'captures array length from descriptors without ordinary reads: $values',
    ({ values }) => {
      let reads = 0;
      const caller = new Proxy(values, {
        get() {
          reads += 1;
          throw new Error('private ordinary read');
        },
      });
      expect(JSON.stringify(copyInertData(caller))).toBe(JSON.stringify(values));
      expect(reads).toBe(0);
    },
  );

  it.each([
    { make: () => boxedData(true) },
    { make: () => boxedData(1) },
    { make: () => boxedData('value') },
    { make: () => boxedData(1n) },
    { make: () => boxedData(Symbol('value')) },
    { make: () => new Date(0) },
  ])('refuses opaque native brands even when their prototype is changed', ({ make }) => {
    for (const prototype of [null, Object.prototype]) {
      const value: unknown = make();
      if (typeof value !== 'object' || value === null) throw new Error('expected branded object');
      Object.setPrototypeOf(value, prototype);
      expect(() => copyInertData({ nested: value })).toThrow(UnsupportedRequestDataError);
    }
  });

  it('refuses inherited serializers, while generated array shadows survive later prototype mutation', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
    const owned = copyInertData([1, { value: 'retained' }]);
    let invoked = false;
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          invoked = true;
          return 'private';
        },
      });
      expect(() => copyInertData([1])).toThrow(UnsupportedRequestDataError);
      expect(JSON.stringify(owned)).toBe('[1,{"value":"retained"}]');
      expect(JSON.stringify(copyInertData(owned, false))).toBe('[1,{"value":"retained"}]');
      expect(invoked).toBe(false);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(Array.prototype, 'toJSON');
      else Object.defineProperty(Array.prototype, 'toJSON', descriptor);
    }
  });

  it('retains a noncallable ordinary data field named toJSON', () => {
    expect(JSON.stringify(copyInertData({ toJSON: { value: 'data' } }))).toBe(
      '{"toJSON":{"value":"data"}}',
    );
  });

  const workingMutations: readonly [string, (record: object, invoked: () => never) => void][] = [
    [
      'accessor',
      (record, invoked) =>
        Object.defineProperty(record, 'nested', { get: invoked, enumerable: true }),
    ],
    [
      'symbol metadata',
      (record) => Object.defineProperty(record, Symbol('private'), { value: 1, enumerable: true }),
    ],
    [
      'prototype key',
      (record) => Object.defineProperty(record, '__proto__', { value: {}, enumerable: true }),
    ],
    ['hidden metadata', (record) => Object.defineProperty(record, 'hidden', { value: 1 })],
    [
      'own serializer',
      (record, invoked) =>
        Object.defineProperty(record, 'toJSON', { value: invoked, enumerable: true }),
    ],
    [
      'custom prototype',
      (record, invoked) => {
        Object.setPrototypeOf(record, { toJSON: invoked });
      },
    ],
    [
      'ancestor cycle',
      (record) => Object.defineProperty(record, 'self', { value: record, enumerable: true }),
    ],
  ];
  it.each(workingMutations)(
    'revalidates %s installed on a helper-created mutable record without executing it',
    (_name, mutate) => {
      const working = copyInertData({ child: { retained: true } }, false);
      const child = field(working, 'child');
      if (typeof child !== 'object' || child === null) throw new Error('missing working record');
      let invocations = 0;
      mutate(child, () => {
        invocations += 1;
        throw new Error('private inspection cause');
      });
      expect(() => copyInertData(working)).toThrow(UnsupportedRequestDataError);
      expect(invocations).toBe(0);
    },
  );

  it.each([
    { make: () => boxedData(true) },
    { make: () => boxedData(1) },
    { make: () => boxedData('value') },
    { make: () => boxedData(1n) },
    { make: () => boxedData(Symbol('value')) },
    { make: () => new Date(0) },
  ])(
    'refuses disguised raw native data inserted into an otherwise generated record',
    ({ make }) => {
      for (const prototype of [null, Object.prototype]) {
        const native = make();
        if (typeof native !== 'object' || native === null) throw new Error('missing native record');
        Object.setPrototypeOf(native, prototype);
        const working = copyInertData({ retained: true }, false);
        if (typeof working !== 'object' || working === null)
          throw new Error('missing working record');
        Object.defineProperty(working, 'later', { value: native, enumerable: true });
        expect(() => copyInertData(working)).toThrow(UnsupportedRequestDataError);
      }
    },
  );
});
