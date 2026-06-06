import type { JSONSchema7 } from 'json-schema';
import { describe, expect, it } from 'vitest';

import { ToolSchemaError } from './errors.js';
import {
  GeminiToolCallIds,
  normalizeToolCall,
  reshapeForGemini,
  toWire,
} from './tool-normalizer.js';
import type { ToolDef } from './types.js';

const parameters: JSONSchema7 = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'the file path' },
    encoding: { type: 'string', enum: ['utf8', 'base64'] },
  },
  required: ['path'],
  additionalProperties: false,
};

const toolDef: ToolDef = { name: 'read_file', description: 'Read a file', parameters };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Narrow a reshaped property to a record at runtime — fails the test (no unsafe `as`) if it isn't. */
function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`expected '${key}' to be a record, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Parse a schema the way a tool's YAML/JSON would actually arrive. Needed where an object literal
 * can't express the input: an own `__proto__` key (a literal `__proto__:` sets the prototype) or a
 * non-JSON-Schema-7 keyword like OpenAPI `nullable`. The JSON.parse boundary cast is the canonical use.
 */
const parseSchema = (json: string): JSONSchema7 => JSON.parse(json) as JSONSchema7;

describe('toWire — one canonical ToolDef, three native shapes', () => {
  it('shapes the Anthropic input_schema form (parameters passed through)', () => {
    const wire = toWire(toolDef, 'anthropic');
    expect(wire).toEqual({
      name: 'read_file',
      description: 'Read a file',
      input_schema: parameters,
    });
  });

  it('shapes the OpenAI / DeepSeek function form (one adapter, both ids)', () => {
    const openai = toWire(toolDef, 'openai');
    expect(openai).toEqual({
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters },
    });
    expect(toWire(toolDef, 'deepseek')).toEqual(openai);
  });

  it('shapes the Gemini functionDeclarations form with the reshaped schema', () => {
    const wire = toWire(toolDef, 'gemini');
    if (!('functionDeclarations' in wire)) {
      throw new Error('expected a Gemini functionDeclarations wire shape');
    }
    const decl = wire.functionDeclarations[0];
    expect(decl?.name).toBe('read_file');
    // additionalProperties is stripped by the Gemini reshape; the kept keys survive.
    expect(decl?.parameters).not.toHaveProperty('additionalProperties');
    expect(decl?.parameters).toMatchObject({ type: 'object', required: ['path'] });
  });

  it('omits description when the ToolDef has none', () => {
    const wire = toWire({ name: 'now', parameters: { type: 'object' } }, 'anthropic');
    expect(wire).not.toHaveProperty('description');
  });
});

describe('reshapeForGemini — OpenAPI-subset reshape', () => {
  it('strips unsupported keywords and unsupported format values', () => {
    const reshaped = reshapeForGemini(
      {
        type: 'object',
        properties: {
          when: { type: 'string', format: 'date-time' }, // supported format — kept
          email: { type: 'string', format: 'email' }, // unsupported format — dropped
        },
        additionalProperties: false, // unsupported keyword — stripped
        patternProperties: {}, // unsupported keyword — stripped
      } satisfies JSONSchema7,
      'demo',
    );
    expect(reshaped).not.toHaveProperty('additionalProperties');
    expect(reshaped).not.toHaveProperty('patternProperties');
    const props = recordAt(reshaped, 'properties');
    expect(props['when']).toEqual({ type: 'string', format: 'date-time' });
    expect(props['email']).toEqual({ type: 'string' }); // format dropped
  });

  it('preserves an anyOf union (and reshapes its branches) — Gemini supports it', () => {
    const reshaped = reshapeForGemini(
      {
        type: 'object',
        properties: {
          value: {
            anyOf: [
              { type: 'string', minLength: 1 },
              { type: 'number', minimum: 0 },
            ],
          },
        },
      } satisfies JSONSchema7,
      'demo',
    );
    const value = recordAt(reshaped, 'properties')['value'];
    // The union survives with both branches and their (supported) bound keywords intact.
    expect(value).toEqual({
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'number', minimum: 0 },
      ],
    });
  });

  it('keeps the numeric / string bound keywords Gemini honors', () => {
    const reshaped = reshapeForGemini(
      {
        type: 'object',
        properties: {
          age: { type: 'integer', minimum: 0, maximum: 120 },
          name: { type: 'string', minLength: 1, maxLength: 50, pattern: '^[a-z]+$' },
        },
      } satisfies JSONSchema7,
      'demo',
    );
    const props = recordAt(reshaped, 'properties');
    expect(props['age']).toEqual({ type: 'integer', minimum: 0, maximum: 120 });
    expect(props['name']).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: 50,
      pattern: '^[a-z]+$',
    });
  });

  it('throws a typed ToolSchemaError on a $ref it cannot express', () => {
    const schema = {
      type: 'object',
      properties: { ref: { $ref: '#/$defs/Thing' } },
    } as JSONSchema7;
    expect(() => reshapeForGemini(schema, 'demo')).toThrowError(ToolSchemaError);
    try {
      reshapeForGemini(schema, 'demo');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolSchemaError);
      if (err instanceof ToolSchemaError) {
        expect(err.code).toBe('unsupported_tool_schema');
        expect(err.provider).toBe('gemini');
        expect(err.toolName).toBe('demo');
      }
    }
  });

  it('rejects a primitive-root schema — Gemini parameters must be an object root', () => {
    expect(() => reshapeForGemini({ type: 'string' }, 'demo')).toThrowError(ToolSchemaError);
  });

  it('collapses a nullable union type:["string","null"] to a scalar type + nullable:true', () => {
    const reshaped = reshapeForGemini(
      {
        type: 'object',
        properties: { opt: { type: ['string', 'null'] } },
      },
      'demo',
    );
    const props = recordAt(reshaped, 'properties');
    expect(props['opt']).toEqual({ type: 'string', nullable: true });
  });

  it('throws on an inexpressible non-null type union like ["string","number"]', () => {
    expect(() =>
      reshapeForGemini(
        { type: 'object', properties: { bad: { type: ['string', 'number'] } } },
        'demo',
      ),
    ).toThrowError(ToolSchemaError);
  });

  it('defaults a no-argument tool (typeless {} root) to an object schema', () => {
    // Valid for the other providers; Gemini requires the explicit object type, so default it.
    expect(reshapeForGemini({}, 'demo')).toEqual({ type: 'object' });
  });

  it('keeps a __proto__-named property as an own key without mutating the prototype', () => {
    const reshaped = reshapeForGemini(
      parseSchema(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"keep":{"type":"number"}}}',
      ),
      'demo',
    );
    const props = recordAt(reshaped, 'properties');
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype); // own key, not a prototype mutation
    expect(Object.hasOwn(props, '__proto__')).toBe(true);
    expect(recordAt(props, '__proto__')).toEqual({ type: 'string' });
    expect(recordAt(props, 'keep')).toEqual({ type: 'number' });
  });

  it('lets a type-union null win over a contradictory verbatim nullable:false', () => {
    const reshaped = reshapeForGemini(
      parseSchema(
        '{"type":"object","properties":{"opt":{"type":["string","null"],"nullable":false}}}',
      ),
      'demo',
    );
    expect(recordAt(reshaped, 'properties')['opt']).toEqual({ type: 'string', nullable: true });
  });

  it('keeps a boolean (primitive) items schema verbatim', () => {
    const reshaped = reshapeForGemini(
      { type: 'object', properties: { arr: { type: 'array', items: true } } },
      'demo',
    );
    expect(recordAt(reshaped, 'properties')['arr']).toEqual({ type: 'array', items: true });
  });

  it('throws a typed ToolSchemaError when nesting exceeds the depth cap (DoS guard)', () => {
    let schema: JSONSchema7 = { type: 'object' };
    for (let i = 0; i < 200; i += 1) {
      schema = { type: 'object', properties: { n: schema } };
    }
    expect(() => reshapeForGemini(schema, 'deep')).toThrowError(ToolSchemaError);
  });
});

describe('GeminiToolCallIds — synthesized, stable tool-call ids', () => {
  it('mints unique ids and matches functionResponses FIFO per name across a multi-tool turn', () => {
    const ids = new GeminiToolCallIds();
    const a = ids.synthesize('read_file'); // gemini-tool-0-read_file
    const b = ids.synthesize('write_file'); // gemini-tool-1-write_file
    const c = ids.synthesize('read_file'); // gemini-tool-2-read_file
    expect(new Set([a, b, c]).size).toBe(3); // unique

    // Responses reference by name only — resolved FIFO per name, so each maps to its own call id.
    expect(ids.resolveResponse('read_file')).toBe(a);
    expect(ids.resolveResponse('write_file')).toBe(b);
    expect(ids.resolveResponse('read_file')).toBe(c);
  });

  it('throws when a functionResponse has no matching call', () => {
    const ids = new GeminiToolCallIds();
    expect(() => ids.resolveResponse('ghost')).toThrowError(ToolSchemaError);
  });
});

describe('normalizeToolCall', () => {
  it('folds extracted fields into a canonical tool_call ContentPart', () => {
    expect(
      normalizeToolCall('anthropic', { id: 'c1', name: 'read_file', args: { path: 'x' } }),
    ).toEqual({ type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'x' } });
  });

  it('rejects an empty id or name from a misbehaving provider', () => {
    expect(() => normalizeToolCall('openai', { id: '', name: 'f', args: {} })).toThrowError(
      ToolSchemaError,
    );
    expect(() => normalizeToolCall('openai', { id: 'c1', name: '', args: {} })).toThrowError(
      ToolSchemaError,
    );
  });
});
