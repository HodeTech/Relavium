import { describe, expect, it } from 'vitest';

import { shapeToolResult } from './result.js';

describe('shapeToolResult', () => {
  it('maps text content verbatim and defaults isError to false', () => {
    expect(shapeToolResult({ content: [{ type: 'text', text: 'hello' }] })).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
  });

  it('records non-text parts by kind (image/audio/resource), carrying no bytes', () => {
    const r = shapeToolResult({
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'audio', data: 'BBBB', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file://x' } },
      ],
    });
    expect(r.content).toEqual([
      { type: 'non_text', kind: 'image' },
      { type: 'non_text', kind: 'audio' },
      { type: 'non_text', kind: 'resource' },
    ]);
  });

  it('honors isError:true', () => {
    expect(shapeToolResult({ content: [], isError: true }).isError).toBe(true);
  });

  it('is robust to a malformed/legacy result (unknown, missing/typed-wrong content)', () => {
    expect(shapeToolResult(undefined)).toEqual({ content: [], isError: false });
    expect(shapeToolResult({ toolResult: 'legacy' })).toEqual({ content: [], isError: false }); // the legacy variant
    expect(shapeToolResult({ content: 'not-an-array' })).toEqual({ content: [], isError: false });
    // a `text` part missing its `text` string degrades to a non-text marker (never a crash)
    expect(shapeToolResult({ content: [{ type: 'text' }] }).content).toEqual([
      { type: 'non_text', kind: 'text' },
    ]);
    expect(shapeToolResult({ content: [42, null] }).content).toEqual([
      { type: 'non_text', kind: 'unknown' },
      { type: 'non_text', kind: 'unknown' },
    ]);
  });
});
