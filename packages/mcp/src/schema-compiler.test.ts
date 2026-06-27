import { describe, expect, it } from 'vitest';

import {
  compileJsonSchemaToZod,
  MAX_DEPTH,
  MAX_ENUM_MEMBERS,
  MAX_NODES,
  MAX_PROPERTIES,
} from './schema-compiler.js';

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

  it('ENFORCES type:null as null-only (a declared, supported type is actually validated)', () => {
    const schema = compileOk({ type: 'null' });
    expect(schema.safeParse(null).success).toBe(true);
    expect(schema.safeParse(5).success).toBe(false); // not "accept anything"
    expect(schema.safeParse('x').success).toBe(false);
    expect(compileOk({ type: ['null'] }).safeParse({}).success).toBe(false);
    // and as a required property — proving the gate enforces it
    const obj = compileOk({ type: 'object', properties: { n: { type: 'null' } }, required: ['n'] });
    expect(obj.safeParse({ n: null }).success).toBe(true);
    expect(obj.safeParse({ n: 5 }).success).toBe(false);
  });

  it('covers the remaining scalar types and const values', () => {
    expect(compileOk({ type: 'boolean' }).safeParse(true).success).toBe(true);
    expect(compileOk({ type: 'boolean' }).safeParse('x').success).toBe(false);
    expect(compileOk({ type: 'number' }).safeParse(1.5).success).toBe(true);
    expect(compileOk({ type: 'integer' }).safeParse(1.5).success).toBe(false); // the int constraint holds
    expect(compileOk({ const: null }).safeParse(null).success).toBe(true);
    expect(compileOk({ const: null }).safeParse(0).success).toBe(false);
    expect(compileOk({ const: true }).safeParse(true).success).toBe(true);
    expect(compileOk({ const: 'go' }).safeParse('go').success).toBe(true);
  });

  it('intersects a `type` with `enum`/`const` (a contradictory pair accepts nothing)', () => {
    const contradictory = compileOk({ type: 'number', enum: ['a', 'b'] });
    expect(contradictory.safeParse('a').success).toBe(false); // 'a' is not a number
    expect(contradictory.safeParse(1).success).toBe(false); // 1 is not an enum member
    const consistent = compileOk({ type: 'number', enum: [1, 2] });
    expect(consistent.safeParse(1).success).toBe(true);
    expect(consistent.safeParse(3).success).toBe(false);
  });

  it('intersects type:null with a NON-null const/enum (the contradictory pair accepts nothing)', () => {
    // The Opus fix covered type×enum only when types.length > 0; a null-only type still admitted the member.
    const nullEnum = compileOk({ type: 'null', enum: ['a'] });
    expect(nullEnum.safeParse('a').success).toBe(false); // 'a' is not null
    expect(nullEnum.safeParse(null).success).toBe(false); // null is not in the enum
    const nullConst = compileOk({ type: 'null', const: 'x' });
    expect(nullConst.safeParse('x').success).toBe(false);
    expect(nullConst.safeParse(null).success).toBe(false);
    // A CONSISTENT null-only pair still accepts null.
    expect(compileOk({ type: 'null', const: null }).safeParse(null).success).toBe(true);
  });

  it('enforces a `required` property absent from `properties` (present, any value)', () => {
    const schema = compileOk({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'x'],
    });
    expect(schema.safeParse({ a: 's', x: 42 }).success).toBe(true); // x present (any value)
    expect(schema.safeParse({ a: 's', x: null }).success).toBe(true); // x present as null
    expect(schema.safeParse({ a: 's' }).success).toBe(false); // x is required but absent
    expect(schema.safeParse({ x: 1 }).success).toBe(false); // the typed `a` is still required
  });

  it('enforces `required` when `properties` is omitted entirely', () => {
    const schema = compileOk({ type: 'object', required: ['x'] });
    expect(schema.safeParse({ x: 1 }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('enforces an untyped required key under additionalProperties:false (strict still admits the key)', () => {
    const schema = compileOk({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['x'],
      additionalProperties: false,
    });
    expect(schema.safeParse({ a: 's', x: 7 }).success).toBe(true); // x admitted + present
    expect(schema.safeParse({ a: 's' }).success).toBe(false); // x absent
    expect(schema.safeParse({ a: 's', x: 7, y: 9 }).success).toBe(false); // y is an unknown key (strict)
  });

  it('keeps a consistent const + type pair (the intersection admits the in-range literal)', () => {
    const c = compileOk({ type: 'number', const: 42 });
    expect(c.safeParse(42).success).toBe(true);
    expect(c.safeParse(43).success).toBe(false);
    expect(c.safeParse('42').success).toBe(false);
  });

  it('treats a boolean `false` sub-schema as never (a property that admits no value)', () => {
    const schema = compileOk({ type: 'object', properties: { x: false, y: { type: 'string' } } });
    expect(schema.safeParse({ y: 'ok' }).success).toBe(true); // x is optional + never ⇒ omittable
    expect(schema.safeParse({ x: 'anything', y: 'ok' }).success).toBe(false); // x present ⇒ never rejects
  });

  it('honors additionalProperties as a schema (passthrough) and explicit `true`', () => {
    const asSchema = compileOk({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    // additionalProperties-as-a-schema is treated as allowed-but-not-typed: extras pass through, never reject.
    expect(asSchema.safeParse({ a: 'x', extra: 'not-a-number' }).success).toBe(true);
    const explicitTrue = compileOk({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    });
    expect(explicitTrue.safeParse({ a: 'x', extra: 1 }).success).toBe(true);
  });

  it('fails closed on a schema declaring a __proto__ property (prototype-pollution guard), without polluting', () => {
    // Real input is JSON.parse'd off the wire, where "__proto__" is a genuine OWN key (unlike an object
    // literal, where `__proto__:` is the prototype setter). A `__proto__` parameter is never legitimate and
    // would corrupt the shape / poison the validator — so it is rejected at discovery, and never pollutes.
    const schema: unknown = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}}}',
    );
    expect(compileJsonSchemaToZod(schema).ok).toBe(false);
    // also fail closed when `__proto__` appears only in `required` (not in `properties`)
    expect(compileJsonSchemaToZod({ type: 'object', required: ['__proto__'] }).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    // a sibling-clean object (no dangerous keys) still compiles + validates normally
    const clean = compileOk({
      type: 'object',
      properties: { ok: { type: 'string' } },
      required: ['ok'],
    });
    expect(clean.safeParse({ ok: 'x' }).success).toBe(true);
    expect(clean.safeParse({}).success).toBe(false);
  });

  it('honors array minItems/maxItems and string maxLength bounds', () => {
    const arr = compileOk({ type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 });
    expect(arr.safeParse(['a']).success).toBe(false);
    expect(arr.safeParse(['a', 'b']).success).toBe(true);
    expect(arr.safeParse(['a', 'b', 'c', 'd']).success).toBe(false);
    const str = compileOk({ type: 'string', maxLength: 3 });
    expect(str.safeParse('abcd').success).toBe(false);
    expect(str.safeParse('abc').success).toBe(true);
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
    expect(result.ok === false && result.reason).toContain(String(MAX_NODES));
  });

  it('never throws — every bad input returns a structured fail-closed result', () => {
    for (const bad of [undefined, null, [], NaN, Symbol('x') as unknown, () => 0]) {
      expect(() => compileJsonSchemaToZod(bad)).not.toThrow();
      expect(compileJsonSchemaToZod(bad).ok).toBe(false);
    }
  });

  it('fails closed on the per-node MAX_PROPERTIES and MAX_ENUM_MEMBERS caps', () => {
    const wideProps: Record<string, unknown> = {};
    for (let i = 0; i < MAX_PROPERTIES + 1; i += 1) wideProps[`p${i}`] = { type: 'string' };
    const propsResult = compileJsonSchemaToZod({ type: 'object', properties: wideProps });
    expect(propsResult.ok).toBe(false);
    expect(propsResult.ok === false && propsResult.reason).toMatch(/propert/i);

    const bigEnum = Array.from({ length: MAX_ENUM_MEMBERS + 1 }, (_, i) => `m${i}`);
    const enumResult = compileJsonSchemaToZod({ enum: bigEnum });
    expect(enumResult.ok).toBe(false);
    expect(enumResult.ok === false && enumResult.reason).toMatch(/enum/);
  });

  it('fails closed on an unknown type and malformed required/properties', () => {
    expect(compileJsonSchemaToZod({ type: 'frobnicate' }).ok).toBe(false);
    expect(
      compileJsonSchemaToZod({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: 'a',
      }).ok,
    ).toBe(false);
    expect(
      compileJsonSchemaToZod({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [1],
      }).ok,
    ).toBe(false);
    expect(compileJsonSchemaToZod({ type: 'object', properties: [1, 2] }).ok).toBe(false);
  });

  it('fails closed on a huge `required` array (the node budget bounds total work, not just count)', () => {
    const required = Array.from({ length: MAX_NODES + 5 }, (_, i) => `r${i}`);
    const props: Record<string, unknown> = {};
    for (const name of required.slice(0, 3)) props[name] = { type: 'string' };
    const result = compileJsonSchemaToZod({ type: 'object', properties: props, required });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(String(MAX_NODES));
  });

  it('fails closed on a within-per-node-caps but high-TOTAL-work enum schema (the DoS the budget closes)', () => {
    // Each enum is within MAX_ENUM_MEMBERS and the object within MAX_PROPERTIES, but the TOTAL enum work
    // (props × members) far exceeds MAX_NODES — the shared budget trips, so it rejects fast (no multi-second
    // compile). This is the multiplicative-bypass the Opus review found; the budget now debits enum members.
    const props: Record<string, unknown> = {};
    const members = Array.from({ length: MAX_ENUM_MEMBERS }, (_, i) => `m${i}`);
    for (let i = 0; i < 50; i += 1) props[`p${i}`] = { enum: members }; // 50 × 1000 ≫ MAX_NODES
    const result = compileJsonSchemaToZod({ type: 'object', properties: props });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(String(MAX_NODES));
  });

  it('fails closed on a non-finite (NaN/Infinity) const or enum member', () => {
    // NaN/Infinity are not valid JSON; `z.literal(NaN)` would be a permanently-dead gate, so reject at discovery.
    expect(compileJsonSchemaToZod({ const: NaN }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ const: Infinity }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ enum: [NaN, 'a'] }).ok).toBe(false);
    expect(compileJsonSchemaToZod({ enum: [1, Infinity] }).ok).toBe(false);
  });

  it('fails closed on a hostile oversized `type` array (charged to the node budget)', () => {
    const types = Array.from({ length: MAX_NODES + 5 }, () => 'string');
    const result = compileJsonSchemaToZod({ type: types });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain(String(MAX_NODES));
  });
});
