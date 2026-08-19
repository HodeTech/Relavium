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

import { canonicalJson } from './canonical.js';

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
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalJson({ a: [1, { b: 2 }] })).toBe('{"a":[1,{"b":2}]}');
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
    ];
    for (const [value, expected] of vectors) {
      expect(canonicalJson(value), JSON.stringify(value)).toBe(expected);
    }
  });
});
