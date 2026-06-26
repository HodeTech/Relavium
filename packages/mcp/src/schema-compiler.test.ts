import { describe, expect, it } from 'vitest';

import { compileJsonSchemaToZod, MAX_DEPTH, MAX_NODES } from './schema-compiler.js';

/** Compile a schema expected to succeed, returning the Zod validator (fails the test if it did not). */
function compileOk(schema: unknown) {
  const result = compileJsonSchemaToZod(schema);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.schema;
}

describe('compileJsonSchemaToZod — supported subset (happy paths)', () => {
  it('compiles an object with required + optional typed properties', () => {
    const schema = compileOk({
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'integer' } },
      required: ['name'],
    });
    expect(schema.safeParse({ name: 'x', count: 3 }).success).toBe(true);
    expect(schema.safeParse({ name: 'x' }).success).toBe(true); // count is optional
    expect(schema.safeParse({ count: 3 }).success).toBe(false); // name is required
    expect(schema.safeParse({ name: 1 }).success).toBe(false); // wrong type
  });

  it('honors additionalProperties:false as strict, and passes extras through by default', () => {
    const strict = compileOk({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    expect(strict.safeParse({ a: 'x', extra: 1 }).success).toBe(false);

    const open = compileOk({ type: 'object', properties: { a: { type: 'string' } } });
    // passthrough keeps the extra key (not stripped) — assert on the typed safeParse result, never an `any` var.
    expect(open.safeParse({ a: 'x', extra: 1 })).toMatchObject({
      success: true,
      data: { a: 'x', extra: 1 },
    });
  });

  it('compiles nested objects and arrays of objects', () => {
    const schema = compileOk({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
        },
      },
      required: ['items'],
    });
    expect(schema.safeParse({ items: [{ id: 1 }, { id: 2 }] }).success).toBe(true);
    expect(schema.safeParse({ items: [{ id: 'no' }] }).success).toBe(false);
  });

  it('compiles enum and const', () => {
    const e = compileOk({ type: 'string', enum: ['a', 'b'] });
    expect(e.safeParse('a').success).toBe(true);
    expect(e.safeParse('c').success).toBe(false);

    const c = compileOk({ const: 42 });
    expect(c.safeParse(42).success).toBe(true);
    expect(c.safeParse(43).success).toBe(false);
  });

  it('compiles nullability via a [T, null] union and via nullable:true', () => {
    const viaUnion = compileOk({ type: ['string', 'null'] });
    expect(viaUnion.safeParse('x').success).toBe(true);
    expect(viaUnion.safeParse(null).success).toBe(true);
    expect(viaUnion.safeParse(1).success).toBe(false);

    const viaFlag = compileOk({ type: 'number', nullable: true });
    expect(viaFlag.safeParse(null).success).toBe(true);
    expect(viaFlag.safeParse(2).success).toBe(true);
  });

  it('accepts an unconstrained schema (no-arg tool) as any value', () => {
    const empty = compileOk({});
    expect(empty.safeParse({ anything: true }).success).toBe(true);
    expect(empty.safeParse(null).success).toBe(true);
  });

  it('honors numeric and length bounds when present', () => {
    const n = compileOk({ type: 'integer', minimum: 1, maximum: 10 });
    expect(n.safeParse(5).success).toBe(true);
    expect(n.safeParse(0).success).toBe(false);
    expect(n.safeParse(11).success).toBe(false);

    const s = compileOk({ type: 'string', minLength: 2 });
    expect(s.safeParse('ab').success).toBe(true);
    expect(s.safeParse('a').success).toBe(false);
  });

  it('accepts a string `pattern` but does NOT enforce it (no untrusted-regex ReDoS surface)', () => {
    // A catastrophic-backtracking regex from a hostile server is never compiled/run — the string is accepted
    // and the server validates server-side. We only assert the value is treated as a plain string here.
    const schema = compileOk({ type: 'string', pattern: '^(a+)+$' });
    expect(schema.safeParse('aaaa').success).toBe(true);
    expect(schema.safeParse('not-matching-but-still-a-string').success).toBe(true);
    expect(schema.safeParse(5).success).toBe(false); // still a string check
  });

  it('treats boolean schemas: `true` ≡ any, `false` ≡ never', () => {
    expect(compileOk(true).safeParse({ x: 1 }).success).toBe(true);
    expect(compileOk(false).safeParse('anything').success).toBe(false);
  });
});

describe('compileJsonSchemaToZod — fail-closed on unsupported / adversarial input', () => {
  it('rejects unsupported combinators and $ref (the tool is dropped at discovery)', () => {
    for (const schema of [
      { $ref: '#/definitions/Foo' },
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
      { anyOf: [{ type: 'string' }] },
      { allOf: [{ type: 'object' }] },
      { type: 'object', patternProperties: { '^x': { type: 'string' } } },
      { if: { type: 'string' }, then: { type: 'number' } },
      { not: { type: 'string' } },
    ]) {
      const result = compileJsonSchemaToZod(schema);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a non-object/boolean schema node and a malformed `type`', () => {
    expect(compileJsonSchemaToZod('not-a-schema').ok).toBe(false);
    expect(compileJsonSchemaToZod(42).ok).toBe(false);
    expect(compileJsonSchemaToZod({ type: 123 }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ type: ['string', 7] }).ok).toBe(false);
  });

  it('rejects tuple `items` and a non-scalar `const`/`enum`', () => {
    expect(compileJsonSchemaToZod({ type: 'array', items: [{ type: 'string' }] }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ const: { nested: true } }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ enum: [{ a: 1 }] }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ enum: [] }).ok).toBe(false);
  });

  it('fails closed on excessive nesting depth (a stack-exhaustion guard)', () => {
    // A linear chain of nested objects past MAX_DEPTH must reject, never recurse to a stack overflow.
    let node: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < MAX_DEPTH + 3; i += 1) {
      node = { type: 'object', properties: { next: node }, required: ['next'] };
    }
    const result = compileJsonSchemaToZod(node);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/depth/);
  });

  it('fails closed on an excessive total node count (a memory/DoS guard)', () => {
    // A balanced object tree whose total node count exceeds MAX_NODES while staying within depth + property
    // bounds — the budget trips on node count partway through, before the whole tree is built.
    const build = (depth: number): Record<string, unknown> => {
      if (depth === 0) return { type: 'string' };
      const child = build(depth - 1);
      return {
        type: 'object',
        properties: { a: child, b: child, c: child, d: child, e: child },
      };
    };
    const result = compileJsonSchemaToZod(build(6)); // 5^0+…+5^6 ≈ 19531 nodes ≫ MAX_NODES
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(new RegExp(String(MAX_NODES)));
  });

  it('never throws — every bad input returns a structured fail-closed result', () => {
    for (const bad of [undefined, null, [], NaN, Symbol('x') as unknown, () => 0]) {
      expect(() => compileJsonSchemaToZod(bad)).not.toThrow();
      expect(compileJsonSchemaToZod(bad).ok).toBe(false);
    }
  });
});
