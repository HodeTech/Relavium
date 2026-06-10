import { describe, expect, it } from 'vitest';

import { UnsupportedCapabilityError } from '../errors.js';
import type { LlmRequest } from '../types.js';
import { assertNoMediaRequested, isAbortSignal } from './shared.js';

const textOnly: LlmRequest = {
  model: 'm',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'f', args: {} }] },
  ],
};

describe('assertNoMediaRequested (the 1.AD shape-only media guard, ADR-0031)', () => {
  it('passes text/tool-only requests untouched, including an explicit text-only outputModalities', () => {
    expect(() => assertNoMediaRequested('anthropic', textOnly)).not.toThrow();
    expect(() => assertNoMediaRequested('gemini', { model: 'm', messages: [] })).not.toThrow();
    expect(() =>
      assertNoMediaRequested('openai', { ...textOnly, outputModalities: ['text'] }),
    ).not.toThrow();
  });

  it('throws the typed capability error naming the provider on any media part', () => {
    const withMedia: LlmRequest = {
      ...textOnly,
      messages: [
        ...textOnly.messages,
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aGVsbG8=' } },
          ],
        },
      ],
    };
    try {
      assertNoMediaRequested('deepseek', withMedia);
      expect.unreachable('assertNoMediaRequested must throw on a media part');
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
    const handlePart: LlmRequest = {
      model: 'm',
      messages: [
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
      ],
    };
    expect(() => assertNoMediaRequested('anthropic', handlePart)).toThrowError(
      UnsupportedCapabilityError,
    );
  });

  it('throws on tool_result media attachments — the builders would silently drop them otherwise', () => {
    const withAttachment: LlmRequest = {
      model: 'm',
      messages: [
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
      ],
    };
    expect(() => assertNoMediaRequested('openai', withAttachment)).toThrowError(
      UnsupportedCapabilityError,
    );
    // An EMPTY media array is not an attachment — it must pass.
    const emptyAttachment: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'c1', result: 'ok', media: [] }],
        },
      ],
    };
    expect(() => assertNoMediaRequested('openai', emptyAttachment)).not.toThrow();
  });

  it('throws on a non-text outputModalities request — media output is unwired until 1.AG', () => {
    // Without this, outputModalities: ['image'] would reach an all-false adapter and be silently
    // ignored (answered with text) — the same silent-degradation class as the input flatten.
    expect(() =>
      assertNoMediaRequested('gemini', { ...textOnly, outputModalities: ['text', 'image'] }),
    ).toThrowError(UnsupportedCapabilityError);
    expect(() =>
      assertNoMediaRequested('openai', { ...textOnly, outputModalities: ['audio'] }),
    ).toThrowError(UnsupportedCapabilityError);
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
