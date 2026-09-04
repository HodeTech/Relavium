import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { compileJsonSchemaToZod, type SchemaBounds } from './json-schema-compiler.js';

const BOUNDS: SchemaBounds = {
  maxDepth: 16,
  maxNodes: 2000,
  maxEnumMembers: 1000,
  maxProperties: 500,
  maxStringBytes: 4096,
  maxPropertyNameBytes: 256,
};

const strict = (schema: unknown) => compileJsonSchemaToZod(schema, BOUNDS, 'strict');
const lenient = (schema: unknown) => compileJsonSchemaToZod(schema, BOUNDS, 'lenient');

/** Compile in strict mode and run a value through it; throws if the schema itself was refused. */
const accepts = (schema: unknown, value: unknown): boolean => {
  const compiled = strict(schema);
  if (!compiled.ok) throw new Error(`schema refused: ${compiled.reason}`);
  return compiled.schema.safeParse(value).success;
};

describe('strict mode — the allowlist', () => {
  it('refuses a keyword nobody implemented', () => {
    // The substance of ADR-0092 §2. Under the denylist an unknown keyword was IGNORED, so a schema could
    // declare a constraint and be told it was "validated" while nothing checked it.
    expect(strict({ type: 'string', writeOnlyOnTuesdays: true }).ok).toBe(false);
    expect(strict({ type: 'object', propertyNames: { type: 'string' } }).ok).toBe(false);
  });

  it('names a PUBLISHED keyword, and never echoes an authored one', () => {
    // A refusal that will not say which keyword is nearly useless — but an unrecognised key is authored
    // text, and an author can put anything there, including something secret-shaped. The JSON-Schema
    // vocabulary is fixed and published, so naming a member of it leaks nothing.
    const known = strict({ type: 'object', propertyNames: { type: 'string' } });
    expect(known.ok === false && known.reason).toContain('propertyNames');

    const authored = strict({ type: 'string', 'sk-live-abcdef': 1 });
    expect(authored.ok).toBe(false);
    expect(authored.ok === false && authored.reason).not.toContain('sk-live');
  });

  it('accepts annotations, which carry no validation semantics', () => {
    expect(strict({ type: 'string', title: 'A', description: 'B', default: 'c' }).ok).toBe(true);
  });

  it('refuses a malformed value for a supported keyword', () => {
    // `minLength: "5"` used to pass UNENFORCED: the author mistyped a bound and got a validator that did
    // not check it, with nothing anywhere saying the constraint had been dropped.
    expect(strict({ type: 'string', minLength: '5' }).ok).toBe(false);
    expect(strict({ type: 'string', minLength: -1 }).ok).toBe(false);
    expect(strict({ type: 'number', multipleOf: 0 }).ok).toBe(false);
    expect(strict({ type: 'array', uniqueItems: 'yes' }).ok).toBe(false);
  });

  it('refuses a malformed keyword even when the declared `type` never reads it', () => {
    // The promise was kept only for keywords the CHOSEN type branch reads. A sibling belonging to another
    // type was never looked at, so all of these compiled clean — and the author's mistake is the same
    // whichever type sits next to it.
    for (const schema of [
      { type: 'string', required: 'bad' },
      { type: 'number', properties: [] },
      { type: 'boolean', items: [] },
      { type: 'object', pattern: 42 },
      { type: 'null', uniqueItems: 'yes' },
      { type: 'array', nullable: 'yes' },
    ]) {
      expect(strict(schema).ok).toBe(false);
    }
    // Shape only: a keyword that does not APPLY to the declared type is vacuously satisfied per JSON
    // Schema, not an error.
    expect(strict({ type: 'string', minItems: 3 }).ok).toBe(true);
  });

  it('refuses a degenerate `type` or a duplicated `required` name', () => {
    expect(strict({ type: [] }).ok).toBe(false);
    expect(strict({ type: ['string', 'string'] }).ok).toBe(false);
    expect(strict({ type: 'object', required: ['a', 'a'] }).ok).toBe(false);
    expect(strict({ type: ['string', 'null'] }).ok).toBe(true);
  });

  it('lenient still ignores all of it — the MCP contract is unchanged', () => {
    expect(lenient({ type: 'string', required: 'bad' }).ok).toBe(true);
    expect(lenient({ type: [] }).ok).toBe(true);
  });

  it('still refuses the constructs the denylist refused', () => {
    for (const key of ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties']) {
      expect(strict({ type: 'object', [key]: {} }).ok).toBe(false);
    }
  });
});

describe('strict mode — what it now genuinely ENFORCES', () => {
  it('pattern', () => {
    expect(accepts({ type: 'string', pattern: '^[a-z]+$' }, 'abc')).toBe(true);
    expect(accepts({ type: 'string', pattern: '^[a-z]+$' }, 'ABC')).toBe(false);
  });

  it('a `maxLength` actually GATES the pattern — the ordering, not just the advice', () => {
    // The mitigation json-schema-subset.md tells authors to use. Chaining does not provide it: Zod runs
    // every string check and collects issues, so `.max(8)` did not stop the `.regex` after it and a
    // 29-character input still reached the backtracking engine. Measured 8010 ms chained, 0.1 ms piped.
    const r = strict({ type: 'string', pattern: '^(a+)+$', maxLength: 8 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const started = Date.now();
    expect(r.schema.safeParse('a'.repeat(28) + '!').success).toBe(false);
    // Two orders of magnitude of headroom over the piped cost, and three under the chained one — a bound
    // loose enough not to flake on a slow machine and tight enough that only the defect can breach it.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('the pipe composes with everything a pattern can sit inside', () => {
    // `.pipe()` was added to make `maxLength` gate the regex, and it changes the compiled TYPE from a
    // `ZodString` to a `ZodPipeline` — so every wrapper applied AFTER it (`.nullable()`, a union arm, an
    // object property, an array element, an intersection with `enum`) is a place it could stop working.
    // One test asserting the timing said nothing about any of them.
    const P = { type: 'string', pattern: '^a+$' };
    const cases: ReadonlyArray<readonly [unknown, unknown, boolean]> = [
      [{ ...P, maxLength: 8 }, 'aaa', true],
      [{ ...P, maxLength: 8 }, 'bbb', false],
      [{ ...P, nullable: true }, null, true],
      [{ ...P, nullable: true }, 'zzz', false],
      [{ type: ['string', 'null'], pattern: '^a+$' }, null, true],
      [{ type: ['string', 'null'], pattern: '^a+$' }, 'zzz', false],
      [{ type: 'object', properties: { a: P }, required: ['a'] }, { a: 'aa' }, true],
      [{ type: 'object', properties: { a: P }, required: ['a'] }, { a: 'zz' }, false],
      [{ type: 'array', items: P }, ['zz'], false],
      [{ ...P, enum: ['aa', 'bb'] }, 'bb', false],
      [{ ...P, minLength: 2 }, 'a', false],
    ];
    for (const [schema, value, want] of cases) {
      expect({ schema, value, ok: accepts(schema, value) }).toEqual({ schema, value, ok: want });
    }
  });

  it('accepts an ECMA-262 pattern that unicode mode alone would refuse', () => {
    // JSON Schema defines `pattern` as ECMA-262. `a\-b` — an identity escape outside a character class —
    // is legal there and a syntax error under the `u` flag, so compiling with `u` only refused ordinary
    // patterns while claiming they were invalid.
    expect(strict({ type: 'string', pattern: 'a\\-b' }).ok).toBe(true);
    // …and unicode-only syntax still works, because `u` is tried first.
    expect(accepts({ type: 'string', pattern: '^\\p{L}+$' }, 'héllo')).toBe(true);
  });

  it('refuses a malformed `nullable` in strict, like every other keyword', () => {
    // `=== true` treated `'yes'` as absent, so the author got a non-nullable schema and no indication
    // their modifier had been dropped — the one keyword that escaped the mode's own promise.
    expect(strict({ type: 'string', nullable: 'yes' }).ok).toBe(false);
    expect(strict({ type: 'string', nullable: false }).ok).toBe(true);
    expect(lenient({ type: 'string', nullable: 'yes' }).ok).toBe(true); // lenient still ignores it
  });

  it('never echoes an authored `type` or `format` value', () => {
    for (const schema of [
      { type: 'sk-live-abcdef' },
      { type: 'string', format: 'sk-live-abcdef' },
    ]) {
      const r = strict(schema);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).not.toContain('sk-live');
      // …and still says what IS allowed, which is the actionable half.
      expect(r.ok === false && r.reason).toContain('must be one of');
    }
  });

  it('refuses a pattern that is not a valid regular expression, without echoing it', () => {
    const r = strict({ type: 'string', pattern: '([' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain('([');
  });

  it('counts CODE POINTS for minLength/maxLength, as JSON Schema specifies', () => {
    // Zod's `.min()`/`.max()` count `String.length` — UTF-16 code units. An emoji is one character and two
    // units, so `maxLength: 1` rejected "😀" and `minLength: 2` accepted it: the exact inverse of the spec.
    expect(accepts({ type: 'string', maxLength: 1 }, '😀')).toBe(true);
    expect(accepts({ type: 'string', minLength: 2 }, '😀')).toBe(false);
    expect(accepts({ type: 'string', minLength: 2 }, '😀😀')).toBe(true);
    // …and the ASCII cases are unchanged.
    expect(accepts({ type: 'string', maxLength: 2 }, 'abc')).toBe(false);
  });

  it('`format: time` is RFC 3339 full-time, which REQUIRES an offset', () => {
    // Zod's `.time()` is the opposite of what JSON Schema means: it accepted a bare `12:34:56` and
    // rejected both offset forms — every answer inverted.
    expect(accepts({ type: 'string', format: 'time' }, '12:34:56Z')).toBe(true);
    expect(accepts({ type: 'string', format: 'time' }, '12:34:56+03:00')).toBe(true);
    expect(accepts({ type: 'string', format: 'time' }, '12:34:56')).toBe(false);
    expect(accepts({ type: 'string', format: 'time' }, '25:00:00Z')).toBe(false);
  });

  it('every allowed `format` accepts a valid value and rejects an invalid one', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['email', 'a@b.co', 'nope'],
      ['uuid', '123e4567-e89b-12d3-a456-426614174000', 'not-a-uuid'],
      ['uri', 'https://example.com/x', 'not a uri'],
      ['url', 'https://example.com/x', 'not a url'],
      ['date-time', '2026-09-04T12:00:00Z', '2026-09-04'],
      ['date', '2026-09-04', '2026-13-99'],
      ['time', '12:34:56Z', '12:34:56'],
      ['duration', 'P1DT2H', 'not-a-duration'],
      ['ipv4', '192.168.0.1', '999.1.1.1'],
      ['ipv6', '::1', 'not::an::address::at::all'],
    ];
    for (const [format, good, bad] of cases) {
      expect({ format, value: good, ok: accepts({ type: 'string', format }, good) }).toEqual({
        format,
        value: good,
        ok: true,
      });
      expect({ format, value: bad, ok: accepts({ type: 'string', format }, bad) }).toEqual({
        format,
        value: bad,
        ok: false,
      });
    }
  });

  it('format — and REFUSES an unknown one rather than ignoring it', () => {
    expect(accepts({ type: 'string', format: 'email' }, 'a@b.co')).toBe(true);
    expect(accepts({ type: 'string', format: 'email' }, 'nope')).toBe(false);
    expect(accepts({ type: 'string', format: 'uuid' }, 'not-a-uuid')).toBe(false);
    // Accepting a format and not checking it is the exact shape this mode removes.
    expect(strict({ type: 'string', format: 'hostname' }).ok).toBe(false);
  });

  it('exclusiveMinimum / exclusiveMaximum — which `lenient` ignores outright', () => {
    // Not "became inclusive": ignored. `lenient` accepts 4 for `exclusiveMinimum: 5`, where an inclusive
    // bound would have rejected it — asserted here so the claim has a test rather than three restatements.
    const l = lenient({ type: 'number', exclusiveMinimum: 5 });
    expect(l.ok === true && l.schema.safeParse(4).success).toBe(true);
    expect(accepts({ type: 'number', exclusiveMinimum: 0 }, 0)).toBe(false);
    expect(accepts({ type: 'number', exclusiveMinimum: 0 }, 0.1)).toBe(true);
    expect(accepts({ type: 'number', exclusiveMaximum: 10 }, 10)).toBe(false);
  });

  it('multipleOf', () => {
    expect(accepts({ type: 'integer', multipleOf: 5 }, 10)).toBe(true);
    expect(accepts({ type: 'integer', multipleOf: 5 }, 11)).toBe(false);
  });

  it('uniqueItems — by VALUE, not by reference', () => {
    expect(accepts({ type: 'array', uniqueItems: true }, [1, 2, 3])).toBe(true);
    expect(accepts({ type: 'array', uniqueItems: true }, [1, 1])).toBe(false);
    // Two distinct objects with equal contents are the same member per the spec.
    expect(accepts({ type: 'array', uniqueItems: true }, [{ a: 1 }, { a: 1 }])).toBe(false);
    // …and key order is not a difference.
    expect(
      accepts({ type: 'array', uniqueItems: true }, [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ]),
    ).toBe(false);
  });

  it('minProperties / maxProperties', () => {
    expect(accepts({ type: 'object', minProperties: 2 }, { a: 1 })).toBe(false);
    expect(accepts({ type: 'object', minProperties: 2 }, { a: 1, b: 2 })).toBe(true);
    expect(accepts({ type: 'object', maxProperties: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('additionalProperties as a SCHEMA — which used to type nothing', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: { type: 'number' },
    };
    expect(accepts(schema, { a: 'x', b: 1 })).toBe(true);
    expect(accepts(schema, { a: 'x', b: 'not-a-number' })).toBe(false);
  });

  it('a `required` name is enforced even when its property schema constrains NOTHING', () => {
    // Presence was left to the compiled property schema, and an unconstrained one cannot enforce it:
    // `{}`, `true`, an annotation-only object and a bare `nullable` all compile to `z.unknown()`, which is
    // OPTIONAL inside a `z.object`. `{ properties: { status: {} }, required: ['status'] }` accepted `{}` —
    // deep validation defeated by the most ordinary way to say "this field exists".
    for (const property of [
      {},
      true,
      { description: 'x' },
      { nullable: true },
      { type: 'string' },
    ]) {
      const schema = { type: 'object', properties: { status: property }, required: ['status'] };
      expect(accepts(schema, {})).toBe(false);
      expect(accepts(schema, { status: 'x' })).toBe(true);
    }
  });

  it('…and the same holds in lenient, where an MCP tool call is gated', () => {
    // Same hole, same fix: the MCP boundary compiles a server's `inputSchema` through this path.
    const r = lenient({ type: 'object', properties: { status: {} }, required: ['status'] });
    expect(r.ok === true && r.schema.safeParse({}).success).toBe(false);
    expect(r.ok === true && r.schema.safeParse({ status: 1 }).success).toBe(true);
  });

  it('a `required` name with no `properties` entry obeys `additionalProperties`', () => {
    // Adding such a name to the shape promotes it to a DECLARED property, which is how it escaped both
    // forms: `.strict()` admitted it as known, and `.catchall(schema)` never typed it.
    //
    // With a SCHEMA, the name is typed by it.
    const typed = { type: 'object', required: ['x'], additionalProperties: { type: 'number' } };
    expect(accepts(typed, { x: 1 })).toBe(true);
    expect(accepts(typed, { x: 'not-a-number' })).toBe(false);
    // With `false`, JSON Schema makes the schema unsatisfiable — refused at parse rather than compiled
    // into a validator no value can pass.
    const impossible = strict({ type: 'object', required: ['x'], additionalProperties: false });
    expect(impossible.ok).toBe(false);
    expect(impossible.ok === false && impossible.reason).toContain('no value can satisfy');
    expect(impossible.ok === false && impossible.reason).not.toContain('"x"');
    // A DECLARED required name is unaffected.
    expect(
      accepts(
        {
          type: 'object',
          properties: { x: { type: 'number' } },
          required: ['x'],
          additionalProperties: false,
        },
        { x: 1 },
      ),
    ).toBe(true);
  });

  it('lenient keeps its own behaviour for the same shapes', () => {
    // The MCP boundary's contract is unchanged: a required-only name stays `z.unknown()` and neither
    // form of `additionalProperties` reaches it.
    expect(lenient({ type: 'object', required: ['x'], additionalProperties: false }).ok).toBe(true);
    const r = lenient({
      type: 'object',
      required: ['x'],
      additionalProperties: { type: 'number' },
    });
    expect(r.ok === true && r.schema.safeParse({ x: 'not-a-number' }).success).toBe(true);
  });

  it('refuses a non-boolean, non-schema additionalProperties', () => {
    expect(strict({ type: 'object', additionalProperties: 'yes' }).ok).toBe(false);
  });
});

describe('strict enforces a constraint that has no `type` beside it', () => {
  // JSON Schema applies a constraint to values of the kind it belongs to and leaves other kinds alone:
  // `{ pattern: '^a+$' }` says nothing about a number and everything about a string. The compiler used to
  // return `z.unknown()` for ANY typeless node, so all eleven constraint keywords were silently dropped
  // without a `type` — the allowlist called them accepted and nothing checked them.
  const rows: ReadonlyArray<readonly [string, unknown, unknown, boolean]> = [
    ['pattern rejects a bad string', { pattern: '^a+$' }, 'zzz', false],
    ['pattern accepts a good one', { pattern: '^a+$' }, 'aaa', true],
    ['pattern leaves a NUMBER alone', { pattern: '^a+$' }, 42, true],
    ['minLength', { minLength: 5 }, 'ab', false],
    ['format', { format: 'email' }, 'nope', false],
    ['minimum', { minimum: 10 }, 1, false],
    ['minimum leaves a STRING alone', { minimum: 10 }, 'x', true],
    ['multipleOf', { multipleOf: 5 }, 7, false],
    ['uniqueItems', { uniqueItems: true }, [1, 1], false],
    ['minItems', { minItems: 3 }, [], false],
    ['required', { required: ['a'] }, {}, false],
    ['required satisfied', { required: ['a'] }, { a: 1 }, true],
    ['minProperties', { minProperties: 2 }, {}, false],
    ['properties', { properties: { a: { type: 'number' } } }, { a: 'x' }, false],
    ['additionalProperties: false', { additionalProperties: false }, { x: 1 }, false],
    ['a bare {} still accepts anything', {}, { anything: true }, true],
    ['null is unconstrained', { minLength: 5 }, null, true],
  ];
  for (const [name, schema, value, want] of rows) {
    it(name, () => {
      expect(accepts(schema, value)).toBe(want);
    });
  }

  it('and applies alongside `enum` / `const`, which must BOTH hold', () => {
    // The same hole one branch over: with a value-constraint present and no `type`, only the enum/const
    // arm was built and every loose constraint was dropped. `{ enum: ['aa'], minLength: 5 }` accepted a
    // two-character string. JSON Schema requires both.
    expect(accepts({ enum: ['aa'], minLength: 5 }, 'aa')).toBe(false);
    expect(accepts({ enum: ['aaaaa'], minLength: 5 }, 'aaaaa')).toBe(true);
    expect(accepts({ const: 'zzz', pattern: '^a+$' }, 'zzz')).toBe(false);
    expect(accepts({ const: 'aaa', pattern: '^a+$' }, 'aaa')).toBe(true);
    // …and the arms that already worked are unchanged.
    expect(accepts({ enum: ['a', 'b'] }, 'c')).toBe(false);
    expect(accepts({ type: 'string', enum: ['a'] }, 'a')).toBe(true);
  });

  it('costs the same budget as the `type`-array form expressing the same constraints', () => {
    // `compileNode` charges one node for the node; this path builds up to FOUR sub-schemas from it, which
    // is the work a `type: [a,b,c,d]` array does and `readTypes` charges `list.length` for. Left at one,
    // the two paths disagreed about the same schema — the typeless form compiled under a bound that
    // refused its typed twin.
    const tiny: SchemaBounds = { ...BOUNDS, maxNodes: 3 };
    const constraints = { minLength: 1, minimum: 1, minItems: 1, minProperties: 1 };
    const typed = compileJsonSchemaToZod(
      { type: ['string', 'number', 'array', 'object'], ...constraints },
      tiny,
      'strict',
    );
    const typeless = compileJsonSchemaToZod(constraints, tiny, 'strict');
    expect(typed.ok).toBe(false);
    expect(typeless.ok).toBe(false);
    // …and one kind still fits, so the charge is proportional rather than a flat rejection.
    expect(compileJsonSchemaToZod({ minLength: 1 }, tiny, 'strict').ok).toBe(true);
  });

  it('routes by the VALUE kind, not by `typeof` alone', () => {
    // `typeof null === 'object'` and `typeof [] === 'object'`, so a naive dispatch sends both to the
    // object arm and reports a missing property on a null.
    expect(accepts({ required: ['a'] }, null)).toBe(true);
    expect(accepts({ required: ['a'] }, [1, 2])).toBe(true);
    expect(accepts({ minItems: 3 }, [1])).toBe(false);
    expect(accepts({ minItems: 3 }, { a: 1 })).toBe(true);
    expect(accepts({ minLength: 5 }, true)).toBe(true);
  });

  it('lenient keeps the old behaviour — a typeless schema constrains nothing', () => {
    const r = lenient({ pattern: '^a+$', minLength: 5 });
    expect(r.ok === true && r.schema.safeParse('zzz').success).toBe(true);
  });
});

describe('uniqueItems walks MODEL OUTPUT, so the walk is bounded', () => {
  const nest = (n: number): unknown => {
    let deep: unknown = 1;
    for (let i = 0; i < n; i += 1) deep = [deep];
    return deep;
  };
  const uniqueArray = (): z.ZodTypeAny => {
    const r = strict({ type: 'array', uniqueItems: true });
    if (!r.ok) throw new Error(r.reason);
    return r.schema;
  };

  it('refuses a value past the CAP, well before any stack limit', () => {
    // The discriminating case. Depth 20 is far under V8's limit, so nothing throws on its own — only the
    // explicit cap (`maxDepth`, 16) rejects it. A first version of this test used depth 5000 and could
    // not tell the cap from the `catch` beside it: at that depth the unbounded walk throws RangeError and
    // the catch produces the identical issue, so removing the cap reddened nothing.
    const parsed = uniqueArray().safeParse([nest(20)]);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      'nests deeper than',
    );
  });

  it('and survives a value that would overflow the stack outright', () => {
    // The belt behind the cap. Measured: an unbounded walk over depth 5000 (~10 KiB of `[[[[…]]]]`)
    // throws RangeError — inside a `safeParse`, that is a crash rather than a validation failure.
    expect(() => uniqueArray().safeParse([nest(5000)])).not.toThrow();
  });
});

describe('lenient mode is unchanged — the MCP boundary keeps its contract', () => {
  it('ignores an unknown keyword instead of refusing it', () => {
    expect(lenient({ type: 'string', writeOnlyOnTuesdays: true }).ok).toBe(true);
  });

  it('accepts a `pattern` WITHOUT compiling it — no untrusted-regex surface', () => {
    const r = lenient({ type: 'string', pattern: '^[a-z]+$' });
    expect(r.ok).toBe(true);
    // Not enforced: the value would fail the pattern, and lenient admits it.
    expect(r.ok === true && r.schema.safeParse('ABC').success).toBe(true);
  });

  it('accepts a pattern that could not even compile, because it never tries', () => {
    expect(lenient({ type: 'string', pattern: '([' }).ok).toBe(true);
  });

  it('ignores a malformed bound rather than refusing the stranger`s schema', () => {
    const r = lenient({ type: 'string', minLength: '5' });
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.schema.safeParse('').success).toBe(true);
  });

  it('leaves additionalProperties-as-a-schema untyped', () => {
    const r = lenient({ type: 'object', additionalProperties: { type: 'number' } });
    expect(r.ok === true && r.schema.safeParse({ b: 'not-a-number' }).success).toBe(true);
  });
});

describe('bounds are the caller`s, and they fail closed', () => {
  const tiny: SchemaBounds = {
    ...BOUNDS,
    maxDepth: 1,
    maxNodes: 5,
    maxProperties: 1,
    maxEnumMembers: 2,
  };
  it('depth', () => {
    expect(
      compileJsonSchemaToZod(
        {
          type: 'object',
          properties: { a: { type: 'object', properties: { b: { type: 'string' } } } },
        },
        tiny,
      ).ok,
    ).toBe(false);
  });
  it('properties', () => {
    expect(compileJsonSchemaToZod({ type: 'object', properties: { a: {}, b: {} } }, tiny).ok).toBe(
      false,
    );
  });
  it('enum members', () => {
    expect(compileJsonSchemaToZod({ enum: [1, 2, 3] }, tiny).ok).toBe(false);
  });
});
