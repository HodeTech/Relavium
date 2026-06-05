import type { JSONSchema7 } from 'json-schema';
import { describe, expect, it } from 'vitest';

import { ToolSchemaError } from './errors.js';
import {
  GeminiToolCallIds,
  normalizeToolCall,
  reshapeForGemini,
  toWire,
} from './tool-normalizer.js';
import type { AnthropicToolWire, GeminiToolWire, OpenAiToolWire } from './tool-normalizer.js';
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

describe('toWire — one canonical ToolDef, three native shapes', () => {
  it('shapes the Anthropic input_schema form (parameters passed through)', () => {
    const wire = toWire(toolDef, 'anthropic') as AnthropicToolWire;
    expect(wire).toEqual({
      name: 'read_file',
      description: 'Read a file',
      input_schema: parameters,
    });
  });

  it('shapes the OpenAI / DeepSeek function form (one adapter, both ids)', () => {
    const openai = toWire(toolDef, 'openai') as OpenAiToolWire;
    expect(openai).toEqual({
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters },
    });
    expect(toWire(toolDef, 'deepseek')).toEqual(openai);
  });

  it('shapes the Gemini functionDeclarations form with the reshaped schema', () => {
    const wire = toWire(toolDef, 'gemini') as GeminiToolWire;
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
    const props = reshaped['properties'] as Record<string, Record<string, unknown>>;
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
    const value = (reshaped['properties'] as Record<string, Record<string, unknown>>)['value'];
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
    const props = reshaped['properties'] as Record<string, Record<string, unknown>>;
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
