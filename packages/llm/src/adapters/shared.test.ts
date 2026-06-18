import { ZodError } from 'zod';

import { describe, expect, it } from 'vitest';

import { UnsupportedCapabilityError } from '../errors.js';
import type { CapabilityFlags, LlmRequest } from '../types.js';
import { assertMediaCapabilities, isAbortSignal } from './shared.js';

const textOnly: LlmRequest = {
  model: 'm',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'f', args: {} }] },
  ],
};

const noMedia: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: true,
  reasoning: true,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

const openaiMedia: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    input: { image: true, audio: true, video: false, document: true },
    outputCombinations: [['text'], ['text', 'audio']],
  },
};

const anthropicMedia: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    input: { image: true, audio: false, video: false, document: true },
    outputCombinations: [],
  },
};

const geminiMedia: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: false,
  media: {
    input: { image: true, audio: true, video: true, document: true },
    outputCombinations: [['text'], ['text', 'image'], ['text', 'audio']],
  },
};

const HANDLE = `media://sha256-${'a'.repeat(64)}`;

describe('assertMediaCapabilities — per-modality input/output gate (1.AE, ADR-0031)', () => {
  it('passes text/tool-only requests untouched for all providers', () => {
    expect(() => assertMediaCapabilities('deepseek', noMedia, textOnly)).not.toThrow();
    expect(() =>
      assertMediaCapabilities('openai', openaiMedia, { model: 'm', messages: [] }),
    ).not.toThrow();
    expect(() =>
      assertMediaCapabilities('openai', openaiMedia, { ...textOnly, outputModalities: ['text'] }),
    ).not.toThrow();
  });

  it('rejects every media modality when the provider supports none (DeepSeek)', () => {
    const withImage: LlmRequest = {
      ...textOnly,
      messages: [
        ...textOnly.messages,
        {
          role: 'user' as const,
          content: [
            {
              type: 'media' as const,
              mimeType: 'image/png',
              source: { kind: 'base64' as const, data: 'aGVsbG8=' },
            },
          ],
        },
      ],
    };
    try {
      assertMediaCapabilities('deepseek', noMedia, withImage);
      expect.unreachable('must throw on an image part when image is unsupported');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      if (err instanceof UnsupportedCapabilityError) {
        expect(err.code).toBe('unsupported_capability');
        expect(err.capability).toBe('media');
        expect(err.detail).toContain('image');
      }
    }
  });

  it('allows image+audio input for OpenAI; document/video use handles (ceiling=0)', () => {
    const withImage: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withAudio: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withPdfHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'application/pdf', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    const withVideoHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'video/mp4', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, withImage)).not.toThrow();
    expect(() => assertMediaCapabilities('openai', openaiMedia, withAudio)).not.toThrow();
    expect(() => assertMediaCapabilities('openai', openaiMedia, withPdfHandle)).not.toThrow();
    expect(() => assertMediaCapabilities('openai', openaiMedia, withVideoHandle)).toThrowError(
      UnsupportedCapabilityError,
    );
  });

  it('allows image+document for Anthropic but rejects audio and video', () => {
    const withImage: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withAudio: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withPdfHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'application/pdf', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    const withVideoHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'video/mp4', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('anthropic', anthropicMedia, withImage)).not.toThrow();
    expect(() => assertMediaCapabilities('anthropic', anthropicMedia, withPdfHandle)).not.toThrow();
    expect(() => assertMediaCapabilities('anthropic', anthropicMedia, withAudio)).toThrowError(
      UnsupportedCapabilityError,
    );
    expect(() =>
      assertMediaCapabilities('anthropic', anthropicMedia, withVideoHandle),
    ).toThrowError(UnsupportedCapabilityError);
  });

  it('allows all four input modalities for Gemini (video/document use handles)', () => {
    const withImage: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withAudio: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    const withVideoHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'video/mp4', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    const withPdfHandle: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'application/pdf', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('gemini', geminiMedia, withImage)).not.toThrow();
    expect(() => assertMediaCapabilities('gemini', geminiMedia, withAudio)).not.toThrow();
    expect(() => assertMediaCapabilities('gemini', geminiMedia, withVideoHandle)).not.toThrow();
    expect(() => assertMediaCapabilities('gemini', geminiMedia, withPdfHandle)).not.toThrow();
  });

  it('rejects an unknown MIME type at the schema level (fail-closed, ZodError)', () => {
    const withUnknown: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'model/gltf', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, withUnknown)).toThrowError(
      ZodError,
    );
  });

  it('rejects inline base64 for video/document at the schema level (ceiling=0)', () => {
    const inlinePdf: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'media',
              mimeType: 'application/pdf',
              source: { kind: 'base64', data: 'aQ==' },
            },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, inlinePdf)).toThrowError(ZodError);
    const inlineVideo: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, inlineVideo)).toThrowError(
      ZodError,
    );
  });

  it('throws on a handle-source media part when the modality is unsupported', () => {
    const handlePart: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('deepseek', noMedia, handlePart)).toThrowError(
      UnsupportedCapabilityError,
    );
    expect(() => assertMediaCapabilities('openai', openaiMedia, handlePart)).not.toThrow();
  });

  it('gates tool_result media attachments by modality', () => {
    const imageAttachment: LlmRequest = {
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
                { type: 'media', mimeType: 'image/png', source: { kind: 'handle', ref: HANDLE } },
              ],
            },
          ],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, imageAttachment)).not.toThrow();
    expect(() => assertMediaCapabilities('deepseek', noMedia, imageAttachment)).toThrowError(
      UnsupportedCapabilityError,
    );

    const emptyAttachment: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolCallId: 'c1', result: 'ok', media: [] }],
        },
      ],
    };
    expect(() => assertMediaCapabilities('openai', openaiMedia, emptyAttachment)).not.toThrow();
  });

  it('gates output modalities by membership in outputCombinations', () => {
    expect(() =>
      assertMediaCapabilities('openai', openaiMedia, {
        ...textOnly,
        outputModalities: ['text', 'audio'],
      }),
    ).not.toThrow();
    expect(() =>
      assertMediaCapabilities('openai', openaiMedia, {
        ...textOnly,
        outputModalities: ['text', 'image'],
      }),
    ).toThrowError(UnsupportedCapabilityError);
    expect(() =>
      assertMediaCapabilities('anthropic', anthropicMedia, {
        ...textOnly,
        outputModalities: ['text', 'image'],
      }),
    ).toThrowError(UnsupportedCapabilityError);
    expect(() =>
      assertMediaCapabilities('gemini', geminiMedia, {
        ...textOnly,
        outputModalities: ['text', 'image'],
      }),
    ).not.toThrow();
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
