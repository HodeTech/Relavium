import { describe, expect, it } from 'vitest';

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
  it('refuses a keyword nobody implemented, naming it', () => {
    // The substance of ADR-0092 §2. Under the denylist an unknown keyword was IGNORED, so a schema could
    // declare a constraint and be told it was "validated" while nothing checked it.
    const r = strict({ type: 'string', writeOnlyOnTuesdays: true });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('writeOnlyOnTuesdays');
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

  it('refuses a pattern that is not a valid regular expression, without echoing it', () => {
    const r = strict({ type: 'string', pattern: '([' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).not.toContain('([');
  });

  it('format — and REFUSES an unknown one rather than ignoring it', () => {
    expect(accepts({ type: 'string', format: 'email' }, 'a@b.co')).toBe(true);
    expect(accepts({ type: 'string', format: 'email' }, 'nope')).toBe(false);
    expect(accepts({ type: 'string', format: 'uuid' }, 'not-a-uuid')).toBe(false);
    // Accepting a format and not checking it is the exact shape this mode removes.
    expect(strict({ type: 'string', format: 'hostname' }).ok).toBe(false);
  });

  it('exclusiveMinimum / exclusiveMaximum — which used to become INCLUSIVE bounds', () => {
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

  it('refuses a non-boolean, non-schema additionalProperties', () => {
    expect(strict({ type: 'object', additionalProperties: 'yes' }).ok).toBe(false);
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
