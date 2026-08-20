/**
 * The canonical JSON form
 * ([ADR-0084](../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3,
 * [ADR-0080](../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md)).
 *
 * Two callers use this as a stored equality oracle, and one of them — ADR-0084's consent digest — must be
 * reproducible by a second, non-TypeScript implementation. So these are not "does it round-trip" tests; they
 * are the byte-level contract a Rust reader is verified against, including the GOLDEN VECTORS §3 requires.
 */

import { describe, expect, it } from 'vitest';

import { canonicalJson, NonCanonicalValueError } from './canonical.js';

describe('canonicalJson', () => {
  it('sorts object keys at every depth, so key order cannot change the bytes', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('sorts by UTF-16 code-unit ORDINAL, never by locale', () => {
    // `localeCompare` is locale-dependent — in a Swedish locale `ä` sorts after `z`, in most others before —
    // so the same declaration would digest differently on two machines. The nearby MCP server sort uses
    // `localeCompare` today; this is the rule that one is not allowed to leak into.
    const ordinal = canonicalJson({ z: 1, ä: 2, a: 3 });
    expect(ordinal).toBe('{"a":3,"z":1,"ä":2}'); // 'a'(97) < 'z'(122) < 'ä'(228)
    expect(['z', 'ä', 'a'].sort((a, b) => a.localeCompare(b))).not.toEqual(['a', 'z', 'ä']);
  });

  it('keeps array ORDER, and serializes a hole and an `undefined` as `null`', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    // Matching `JSON.stringify`, which is what a second implementation will be reading this against.
    expect(canonicalJson([undefined])).toBe('[null]');
    // A HOLE too. `Array.prototype.map` skips holes and `join` renders one as an empty string, so this
    // used to produce `[,1]` — which is not JSON, and which `JSON.parse` rejects. A byte contract cannot
    // emit something the implementation reading it could not parse.
    // eslint-disable-next-line no-sparse-arrays -- the shape under test
    expect(canonicalJson([, 1])).toBe('[null,1]');
  });

  it('REFUSES a shape with no faithful JSON form, rather than flattening it into a collision', () => {
    // Each of these was measured serializing to something that collides with a different, real value:
    // a `Date`/`Map`/class instance to `{}`, a non-finite number and an `undefined` property to `null`.
    // Merging two distinguishable values into one digest is the one thing this function must never do.
    expect(() => canonicalJson(new Date(0))).toThrow(NonCanonicalValueError);
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(NonCanonicalValueError);
    expect(() => canonicalJson({ a: undefined })).toThrow(NonCanonicalValueError);
    expect(() => canonicalJson(Number.NaN)).toThrow(NonCanonicalValueError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(NonCanonicalValueError);
    // …and a null-prototype map is still a plain object, because the engine builds its input maps that way.
    const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    built['a'] = 1;
    expect(canonicalJson(built)).toBe('{"a":1}');
  });

  it('refuses past its depth ceiling instead of blowing the stack', () => {
    // A cross-language contract with no stated bound makes a second implementation's own recursion limit an
    // undocumented part of it. The project caps depth for this reason in four other places.
    const nest = (depth: number): unknown => {
      let value: unknown = 'leaf';
      for (let i = 0; i < depth; i += 1) value = { deeper: value };
      return value;
    };
    expect(() => canonicalJson(nest(60))).not.toThrow();
    expect(() => canonicalJson(nest(200))).toThrow(NonCanonicalValueError);
  });

  it('emits no insignificant whitespace', () => {
    // TWO keys at both levels: the first version used single-entry objects, so a mutation changing the
    // object separator to `', '` inserted nothing and the test stayed green.
    expect(canonicalJson({ a: [1, { b: 2, c: 3 }], d: 4 })).toBe('{"a":[1,{"b":2,"c":3}],"d":4}');
  });

  it('escapes strings with ECMAScript `JSON.stringify` semantics', () => {
    expect(canonicalJson({ 'a"b': 'c\\d\ne' })).toBe('{"a\\"b":"c\\\\d\\ne"}');
    expect(canonicalJson('\u0007')).toBe('"\\u0007"'); // a C0 control that has no short escape
    expect(canonicalJson('é☃')).toBe('"é☃"'); // non-ASCII stays literal, not \u-escaped
  });

  it('the GOLDEN VECTORS — a second implementation is verified against these, not against prose', () => {
    // ADR-0084 §3 requires them, covering the cases two implementations most easily disagree about.
    const vectors: readonly (readonly [unknown, string])[] = [
      [{}, '{}'],
      [[], '[]'],
      [null, 'null'],
      [{ transport: 'stdio', args: [], env: {} }, '{"args":[],"env":{},"transport":"stdio"}'],
      [
        { command: '/usr/bin/node', args: ['a b', 'c"d', 'e\\f'] },
        '{"args":["a b","c\\"d","e\\\\f"],"command":"/usr/bin/node"}',
      ],
      [
        { env: { ACME: { kind: 'secret-ref', name: 'acme' } } },
        '{"env":{"ACME":{"kind":"secret-ref","name":"acme"}}}',
      ],
      [{ cwd: '/tmp/é☃' }, '{"cwd":"/tmp/é☃"}'],
      [{ n: -0 }, '{"n":0}'], // `JSON.stringify(-0)` is `0` — stated so nobody "fixes" it into `-0`
      // KEYS need escaping too, and the vectors did not pin it: a mutation to naive `"${k}":` quoting left
      // this whole block green, so a second implementation verified against the fixtures alone would have
      // shipped it.
      [{ 'a"b': 1 }, '{"a\\"b":1}'],
      [{ 'a\\b': 1 }, '{"a\\\\b":1}'],
      [{ 'a\nb': 1 }, '{"a\\nb":1}'],
      [{ 'é☃': 1 }, '{"é☃":1}'],
    ];
    for (const [value, expected] of vectors) {
      expect(canonicalJson(value), JSON.stringify(value)).toBe(expected);
    }
  });
});
