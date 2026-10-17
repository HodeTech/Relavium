import { toWire, ToolDefSchema, type ProviderId, type ToolWire } from '@relavium/llm';
import { describe, expect, it } from 'vitest';

import { BUILTIN_TOOLS } from './builtins.js';
import type { ToolDef } from './types.js';

interface Shape {
  readonly id: string;
  readonly properties: readonly string[];
  readonly required: readonly string[];
  readonly configOnly?: readonly string[];
}

const SHAPES: readonly Shape[] = [
  { id: 'read_file', properties: ['path', 'glob'], required: ['path'] },
  {
    id: 'write_file',
    properties: ['path', 'content', 'append', 'createDirs'],
    required: ['path', 'content'],
  },
  { id: 'list_directory', properties: ['path', 'recursive', 'glob'], required: ['path'] },
  {
    id: 'run_command',
    properties: ['command', 'args'],
    required: ['command'],
    configOnly: ['cwd', 'env', 'timeoutMs'],
  },
  { id: 'git_status', properties: ['command'], required: [], configOnly: ['args'] },
  { id: 'git_commit', properties: ['message', 'files'], required: ['message'] },
  { id: 'http_request', properties: ['method', 'url', 'headers', 'body'], required: ['url'] },
  {
    id: 'web_search',
    properties: ['query', 'maxResults'],
    required: ['query'],
    configOnly: ['endpoint', 'credentialRef'],
  },
  { id: 'mcp_call', properties: ['server', 'tool', 'args'], required: ['server', 'tool'] },
  { id: 'read_clipboard', properties: [], required: [] },
  { id: 'notify', properties: ['title', 'body'], required: ['title', 'body'] },
  { id: 'read_media', properties: ['handle'], required: ['handle'] },
  { id: 'invoke_agent', properties: ['nodeId', 'input'], required: ['nodeId'] },
];

function builtin(id: string): ToolDef {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing built-in fixture: ${id}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected an object schema in actual built-in/lowered fixture');
  }
  return value;
}

function properties(schema: unknown): Record<string, unknown> {
  return record(record(schema)['properties']);
}

function description(schema: unknown): string {
  const text = record(schema)['description'];
  expect(
    typeof text,
    '[MODEL-DESCRIPTION] every actual model-visible property describes its use',
  ).toBe('string');
  if (typeof text !== 'string') return '';
  expect(
    text.trim().length,
    '[MODEL-DESCRIPTION] property guidance is more than a field-name label',
  ).toBeGreaterThan(10);
  return text;
}

function wireSchema(wire: ToolWire): unknown {
  if ('input_schema' in wire) return wire.input_schema;
  if ('function' in wire) return wire.function.parameters;
  const declaration = wire.functionDeclarations[0];
  if (declaration === undefined) throw new Error('missing actual Gemini declaration');
  return declaration.parameters;
}

function wireDescription(wire: ToolWire): string | undefined {
  if ('input_schema' in wire) return wire.description;
  if ('function' in wire) return wire.function.description;
  return wire.functionDeclarations[0]?.description;
}

function expectShape(schema: unknown, shape: Shape): void {
  expect(
    Object.keys(properties(schema)).sort(),
    '[MODEL-SHAPE] lowering retains exactly the advertised fields',
  ).toEqual([...shape.properties].sort());
  expect(
    record(schema)['required'] ?? [],
    '[MODEL-REQUIRED] required and optional distinctions survive',
  ).toEqual(shape.required);
  for (const key of shape.configOnly ?? []) {
    expect(
      properties(schema),
      '[MODEL-CONFIG-EXCLUSION] pinned author configuration is not advertised',
    ).not.toHaveProperty(key);
  }
}

const BOUNDED_FIELDS = [
  { id: 'write_file', field: 'content', cap: 8 * 1024 * 1024, units: /(?:8\s*MiB|8,?388,?608)/i },
  { id: 'http_request', field: 'body', cap: 1024 * 1024, units: /(?:1\s*MiB|1,?048,?576)/i },
  { id: 'git_commit', field: 'message', cap: 16 * 1024, units: /(?:16\s*KiB|16,?384)/i },
];

function expectBounds(id: string, schema: unknown): void {
  for (const bound of BOUNDED_FIELDS.filter((candidate) => candidate.id === id)) {
    const field = record(properties(schema)[bound.field]);
    const text = description(field);
    expect(text, '[MODEL-BYTE-UNITS] string budget uses UTF-8 bytes').toMatch(/UTF-?8/i);
    expect(text, '[MODEL-BYTE-UNITS] exact approved byte ceiling is communicated').toMatch(
      bound.units,
    );
    // JSON Schema maxLength is only a necessary character bound. The description, not an invented
    // custom keyword or a claim that maxLength counts bytes, communicates the executable byte cap.
    expect(
      field['maxLength'],
      '[MODEL-CHAR-BOUND] character constraint remains a valid necessary bound',
    ).toBe(bound.cap);
  }
  if (id === 'run_command') {
    const args = record(properties(schema)['args']);
    expect(args['maxItems'], '[MODEL-ARG-COUNT] maximum vector count survives lowering').toBe(256);
    const text = description(args);
    expect(text, '[MODEL-ARG-TOTAL] aggregate byte budget survives lowering').toMatch(
      /(?:64\s*KiB|65,?536)/i,
    );
    expect(text).toMatch(/UTF-?8/i);
    expect(text).toMatch(/256/);
    const item = record(args['items']);
    const itemText = description(item);
    expect(itemText, '[MODEL-ARG-ENTRY] per-entry UTF-8 byte budget survives lowering').toMatch(
      /UTF-?8/i,
    );
    expect(itemText).toMatch(/(?:16\s*KiB|16,?384)/i);
    expect(item['maxLength'], '[MODEL-ARG-ENTRY] necessary character bound survives lowering').toBe(
      16 * 1024,
    );
  }
}

describe('actual built-in model metadata through the public LLM seam', () => {
  it('[MODEL-CATALOG] expectation table covers every actual built-in', () => {
    expect(SHAPES.map((shape) => shape.id).sort()).toEqual(
      BUILTIN_TOOLS.map((tool) => tool.id).sort(),
    );
  });

  for (const shape of SHAPES) {
    it(`[MODEL-AUTHORED] ${shape.id} describes every property/item and preserves its strict projection`, () => {
      const tool = builtin(shape.id);
      expectShape(tool.llmVisibleParams, shape);
      expect(record(tool.llmVisibleParams)['additionalProperties']).toBe(false);
      for (const field of Object.values(properties(tool.llmVisibleParams))) {
        description(field);
        if (record(field)['type'] === 'array') description(record(field)['items']);
      }
      expect(
        tool.description,
        '[MODEL-GUIDANCE] model instructions avoid host implementation vocabulary',
      ).not.toMatch(/shell:false|allowedDomains|SSRF-guarded|exact-FQDN/);
      expectBounds(shape.id, tool.llmVisibleParams);
    });

    for (const provider of ['anthropic', 'openai', 'deepseek', 'gemini'] satisfies ProviderId[]) {
      it(`[MODEL-LOWERING] ${shape.id} keeps descriptions, bounds and configuration exclusions for ${provider}`, () => {
        const tool = builtin(shape.id);
        const parsed = ToolDefSchema.parse({
          name: tool.id,
          description: tool.description,
          parameters: tool.llmVisibleParams,
        });
        const wire = toWire(parsed, provider);
        const schema = wireSchema(wire);
        expectShape(schema, shape);
        expect(wireDescription(wire)).toBe(tool.description);
        for (const [name, source] of Object.entries(properties(tool.llmVisibleParams))) {
          const lowered = properties(schema)[name];
          description(lowered);
          expect(
            record(lowered)['description'],
            '[MODEL-LOWERING-DESCRIPTION] actual property text survives the real normalizer',
          ).toBe(record(source)['description']);
          if (record(source)['type'] === 'array') {
            description(record(lowered)['items']);
            expect(record(record(lowered)['items'])['description']).toBe(
              record(record(source)['items'])['description'],
            );
          }
        }
        expectBounds(shape.id, schema);
        if (provider === 'gemini')
          expect(record(schema)).not.toHaveProperty('additionalProperties');
        else expect(record(schema)['additionalProperties']).toBe(false);
      });
    }
  }

  it('[MODEL-PRACTICAL-SEMANTICS] descriptions explain safe choices, defaults and availability', () => {
    const write = properties(builtin('write_file').llmVisibleParams);
    expect(description(write['append'])).toMatch(/append/i);
    expect(description(write['append'])).toMatch(/overwrite|replace/i);
    const command = builtin('run_command');
    expect(
      `${command.description} ${description(properties(command.llmVisibleParams)['args'])}`,
    ).toMatch(
      /(?:without|no)\s+(?:a\s+)?shell|(?:not|never)\s+(?:a\s+)?shell|literal|directly|verbatim/i,
    );
    const http = builtin('http_request');
    expect(`${http.description} ${description(properties(http.llmVisibleParams)['url'])}`).toMatch(
      /HTTPS/i,
    );
    expect(`${http.description} ${description(properties(http.llmVisibleParams)['url'])}`).toMatch(
      /allow|configur/i,
    );
    const status = properties(builtin('git_status').llmVisibleParams);
    expect(record(status['command'])['enum']).toEqual(['status', 'log', 'diff']);
    expect(description(status['command'])).toMatch(/default.*status|status.*default/i);
    expect(description(properties(builtin('git_commit').llmVisibleParams)['files'])).toMatch(
      /path|file/i,
    );
    const media = builtin('read_media');
    expect(
      `${media.description} ${description(properties(media.llmVisibleParams)['handle'])}`,
    ).toMatch(/whole|entire/i);
    const mcp = properties(builtin('mcp_call').llmVisibleParams);
    expect(description(mcp['server'])).toMatch(/configur/i);
    expect(description(mcp['tool'])).toMatch(/name|identif/i);
  });
});
