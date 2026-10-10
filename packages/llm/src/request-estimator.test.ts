import { describe, expect, it } from 'vitest';
import type { ContentPart, MediaPart } from '@relavium/shared';
import type { ResponseFormat, ToolDef } from './types.js';
import {
  estimateRequestTokens,
  MEDIA_INPUT_TOKENS,
  UNSERIALIZABLE_INPUT_TOKENS,
} from './request-estimator.js';

function estimate(parts: ContentPart[], tools?: ToolDef[]): number {
  return estimateRequestTokens({
    system: '',
    messages: [{ role: 'user', content: parts }],
    ...(tools === undefined ? {} : { tools }),
  });
}

function floor(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('fixture must serialize');
  return Math.ceil(text.length / 4);
}

describe('current-request estimator (ADR-0096)', () => {
  it('counts system and envelopes, with serialized text escaping and empty part overhead', () => {
    expect(estimateRequestTokens({ system: '', messages: [] })).toBe(0);
    for (const text of ['', 'hello', '\\"\n'.repeat(1000), '八文字のテキスト']) {
      const part = { type: 'text' as const, text };
      expect(
        estimateRequestTokens({ system: 'abcd', messages: [{ role: 'user', content: [part] }] }),
      ).toBe(1 + 2 + floor(part));
    }
  });

  it('retains complete opaque args/results, reasoning/signatures and tool-schema floors', () => {
    const nestedMedia = {
      type: 'media',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'x'.repeat(100_000) },
    };
    const parts: ContentPart[] = [
      {
        type: 'tool_call',
        id: 'call',
        name: 'read',
        args: { nestedMedia },
        signature: 's'.repeat(10_000),
      },
      { type: 'tool_result', toolCallId: 'call', result: { nestedMedia } },
      { type: 'reasoning', text: 'r'.repeat(40_000), signature: 's'.repeat(10_000) },
    ];
    const tool: ToolDef = {
      name: 'read',
      description: 'd'.repeat(10_000),
      parameters: { type: 'object', description: 'q'.repeat(40_000) },
    };
    expect(estimate(parts, [tool])).toBe(
      2 + parts.reduce((sum, part) => sum + floor(part), 0) + floor(tool),
    );
  });

  it('counts the complete structured response format while an absent/text format adds nothing', () => {
    const input = { system: 'abcd', messages: [] };
    const responseFormat: ResponseFormat = {
      type: 'json',
      schema: { type: 'object', description: 'x'.repeat(40_000) },
      name: 'authored-shape',
      strict: true,
    };
    const request = { ...input, responseFormat };
    expect(estimateRequestTokens(request)).toBe(1 + floor(responseFormat));
    expect(estimateRequestTokens(input)).toBe(1);
    const textRequest = { ...input, responseFormat: { type: 'text' as const } };
    expect(estimateRequestTokens(textRequest)).toBe(1);
  });

  it('contains unserialisable output schemas without losing the remaining request contributions', () => {
    const schema = { type: 'object' as const };
    Object.defineProperty(schema, 'self', { value: schema, enumerable: true });
    const responseFormats: ResponseFormat[] = [
      { type: 'json', schema },
      {
        get type(): 'json' {
          throw new Error('private format content');
        },
        schema: {},
      },
      {
        type: 'json',
        schema: {
          get description(): string {
            throw new Error('private schema content');
          },
        },
      },
    ];
    const part = { type: 'text' as const, text: 'x'.repeat(1000) };
    for (const responseFormat of responseFormats) {
      const request = {
        system: 'abcd',
        messages: [{ role: 'user' as const, content: [part] }],
        responseFormat,
      };
      expect(estimateRequestTokens(request)).toBe(
        1 + 2 + floor(part) + UNSERIALIZABLE_INPUT_TOKENS,
      );
    }
    const brokenRequest = {
      system: 'abcd',
      messages: [{ role: 'user' as const, content: [part] }],
      get responseFormat(): ResponseFormat {
        throw new Error('private format accessor');
      },
    };
    expect(estimateRequestTokens(brokenRequest)).toBe(
      1 + 2 + floor(part) + UNSERIALIZABLE_INPUT_TOKENS,
    );
  });

  it.each([
    ['image/png', 'image'],
    ['application/pdf', 'document'],
    ['audio/wav', 'audio'],
    ['video/mp4', 'video'],
  ] as const)(
    'charges %s per part independently of encoding size or source kind',
    (mimeType, modality) => {
      const small: MediaPart = {
        type: 'media',
        mimeType,
        source: { kind: 'base64', data: 'aQ==' },
      };
      const large: MediaPart = { ...small, source: { kind: 'base64', data: 'x'.repeat(500_000) } };
      const url: MediaPart = { ...small, source: { kind: 'url', url: 'https://example.com/file' } };
      expect(estimate([small])).toBe(2 + MEDIA_INPUT_TOKENS[modality]);
      expect(estimate([large, url])).toBe(2 + 2 * MEDIA_INPUT_TOKENS[modality]);
    },
  );

  it('exempts only typed tool-result attachments, preserving the complete result body', () => {
    const media = {
      type: 'media' as const,
      mimeType: 'image/png' as const,
      source: { kind: 'handle' as const, ref: `media://sha256-${'a'.repeat(64)}` },
    };
    const body = { type: 'tool_result' as const, toolCallId: 'call', result: 'r'.repeat(100_000) };
    expect(estimate([{ ...body, media: [media, media] }])).toBe(
      2 + floor(body) + 2 * MEDIA_INPUT_TOKENS.image,
    );
  });

  it('charges each unserialisable unit while keeping other units and shared references', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const args = [
      cycle,
      1n,
      {
        toJSON: () => {
          throw new Error('private');
        },
      },
      { toJSON: () => undefined },
    ];
    const parts: ContentPart[] = args.map((arg, index) => ({
      type: 'tool_call',
      id: String(index),
      name: 'read',
      args: arg,
    }));
    // An undefined nested args value is omitted by JSON.stringify: its envelope still has a floor.
    const good = { type: 'text' as const, text: 'a'.repeat(100_000) };
    expect(estimate([...parts, good])).toBe(
      2 + 3 * UNSERIALIZABLE_INPUT_TOKENS + floor(parts[3]) + floor(good),
    );
    const shared = { large: 'x'.repeat(1000) };
    const repeated: ContentPart = {
      type: 'tool_result',
      toolCallId: 'call',
      result: { one: shared, two: shared },
    };
    expect(estimate([repeated])).toBe(2 + floor(repeated));
  });

  it('contains throwing inspection accessors without discarding the rest of the request', () => {
    const broken: MediaPart = {
      type: 'media',
      get mimeType(): string {
        throw new Error('private');
      },
      source: { kind: 'base64', data: 'aQ==' },
    };
    const good: ContentPart = { type: 'text', text: 'x'.repeat(100_000) };
    expect(estimate([broken, good])).toBe(2 + UNSERIALIZABLE_INPUT_TOKENS + floor(good));
  });
});
