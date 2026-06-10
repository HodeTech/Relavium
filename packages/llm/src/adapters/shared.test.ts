import { describe, expect, it } from 'vitest';

import { UnsupportedCapabilityError } from '../errors.js';
import type { LlmMessage } from '../types.js';
import { assertNoMediaParts, isAbortSignal } from './shared.js';

describe('assertNoMediaParts (the 1.AD shape-only media guard, ADR-0031)', () => {
  const textOnly: LlmMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'f', args: {} }] },
  ];

  it('passes text/tool-only messages untouched', () => {
    expect(() => assertNoMediaParts('anthropic', textOnly)).not.toThrow();
    expect(() => assertNoMediaParts('gemini', [])).not.toThrow();
  });

  it('throws the typed capability error naming the provider on any media part', () => {
    const withMedia: LlmMessage[] = [
      ...textOnly,
      {
        role: 'user',
        content: [
          { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aGVsbG8=' } },
        ],
      },
    ];
    try {
      assertNoMediaParts('deepseek', withMedia);
      expect.unreachable('assertNoMediaParts must throw on a media part');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      if (err instanceof UnsupportedCapabilityError) {
        expect(err.code).toBe('unsupported_capability');
        expect(err.capability).toBe('media');
        expect(err.provider).toBe('deepseek');
      }
    }
  });

  it('throws on a handle-source media part too — no carrier is sendable before 1.AE', () => {
    const handlePart: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref: `media://sha256-${'c'.repeat(64)}` },
          },
        ],
      },
    ];
    expect(() => assertNoMediaParts('anthropic', handlePart)).toThrowError(
      UnsupportedCapabilityError,
    );
  });

  it('throws on tool_result media attachments — the builders would silently drop them otherwise', () => {
    const withAttachment: LlmMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'c1',
            result: { descriptor: 'image saved' },
            media: [
              {
                type: 'media',
                mimeType: 'image/png',
                source: { kind: 'handle', ref: `media://sha256-${'d'.repeat(64)}` },
              },
            ],
          },
        ],
      },
    ];
    expect(() => assertNoMediaParts('openai', withAttachment)).toThrowError(
      UnsupportedCapabilityError,
    );
    // An EMPTY media array is not an attachment — it must pass.
    const emptyAttachment: LlmMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'tool_result', toolCallId: 'c1', result: 'ok', media: [] }],
      },
    ];
    expect(() => assertNoMediaParts('openai', emptyAttachment)).not.toThrow();
  });
});

describe('isAbortSignal', () => {
  it('recognizes a real AbortSignal and rejects a structural lookalike', () => {
    expect(isAbortSignal(new AbortController().signal)).toBe(true);
    expect(
      isAbortSignal({
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    ).toBe(false);
  });
});
