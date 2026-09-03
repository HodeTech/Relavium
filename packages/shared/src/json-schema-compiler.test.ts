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
