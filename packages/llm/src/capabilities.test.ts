import { describe, expect, it } from 'vitest';

import {
  assertStreamable,
  assertSupported,
  isOutputCombinationSupported,
  requiredCapabilities,
  supportsRequest,
} from './capabilities.js';
import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest } from './types.js';

const ALL: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: true,
  // vision === media.input.image (the ADR-0031 derived-alias refine).
  media: {
    input: { image: true, audio: true, video: true, document: true },
    outputCombinations: [['text'], ['text', 'image']],
  },
};
const NONE: CapabilityFlags = {
  tools: false,
  streaming: false,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

const TEXT_REQ: LlmRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};
const TOOL_REQ: LlmRequest = {
  ...TEXT_REQ,
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('capability gating', () => {
  it('derives the required capabilities from the request', () => {
    expect(requiredCapabilities(TEXT_REQ)).toEqual([]);
    expect(requiredCapabilities(TOOL_REQ)).toEqual(['tools']);
  });

  it('gates media PER-MODALITY for the FallbackChain pre-skip (1.AF — not coarse vision)', () => {
    const audioReq: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'aGVsbG8=' } },
          ],
        },
      ],
    };
    // Media is no longer a flat `Capability`: `requiredCapabilities` covers only flat flags (tools).
    expect(requiredCapabilities(audioReq)).toEqual([]);
    const audioOnly: CapabilityFlags = {
      ...NONE,
      tools: true,
      media: {
        input: { image: false, audio: true, video: false, document: false },
        outputCombinations: [],
      },
    };
    // THE FLIP: an audio-capable provider now SERVES an audio request (was coarsely skipped pre-1.AF).
    expect(supportsRequest(audioOnly, audioReq)).toBe(true);
    // An image-incapable provider is skipped for an IMAGE request; a fully-capable one serves it.
    const imageReq: LlmRequest = {
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
    expect(supportsRequest(audioOnly, imageReq)).toBe(false);
    expect(supportsRequest(ALL, imageReq)).toBe(true);
    // Output-combination MEMBERSHIP is part of the pre-skip too.
    const imageOutReq: LlmRequest = { ...TEXT_REQ, outputModalities: ['text', 'image'] };
    expect(supportsRequest(ALL, imageOutReq)).toBe(true); // ALL has ['text','image']
    expect(supportsRequest(audioOnly, imageOutReq)).toBe(false); // outputCombinations []
  });

  it('isOutputCombinationSupported is the ONE exact-membership predicate shared by both gates (1.AF H2)', () => {
    const gemini = [['text'], ['text', 'image'], ['text', 'audio']]; // image+audio never together
    // Exact membership of a declared combination → supported.
    expect(isOutputCombinationSupported(gemini, ['text', 'image'])).toBe(true);
    expect(isOutputCombinationSupported(gemini, ['text', 'audio'])).toBe(true);
    // A wire-INVALID combination the closed set exists to reject (image+audio together) → unsupported.
    expect(isOutputCombinationSupported(gemini, ['text', 'image', 'audio'])).toBe(false);
    // A STRICT SUBSET of a single combo is NOT a member — the old runtime subset gate wrongly ADMITTED
    // this (the H2 divergence: load-check rejected, runtime accepted). Now both reject it.
    expect(isOutputCombinationSupported([['text', 'image', 'audio']], ['text', 'image'])).toBe(
      false,
    );
    // text-only is always emittable, even against a no-media `[]`-combo model (Anthropic/DeepSeek) — so a
    // text request is never wrongly skipped/rejected (the one case pure exact-match would have regressed).
    expect(isOutputCombinationSupported([], ['text'])).toBe(true);
    expect(isOutputCombinationSupported(gemini, ['text'])).toBe(true);
  });

  it('supportsRequest reflects whether the provider can serve the request', () => {
    expect(supportsRequest(ALL, TOOL_REQ)).toBe(true);
    expect(supportsRequest(NONE, TOOL_REQ)).toBe(false);
    expect(supportsRequest(NONE, TEXT_REQ)).toBe(true); // a plain text request needs nothing
  });

  it('assertSupported throws a typed error on an unsupported feature, else passes', () => {
    expect(() => assertSupported('openai', NONE, TOOL_REQ)).toThrowError(
      UnsupportedCapabilityError,
    );
    try {
      assertSupported('openai', NONE, TOOL_REQ);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      if (err instanceof UnsupportedCapabilityError) {
        expect(err.code).toBe('unsupported_capability');
        expect(err.capability).toBe('tools');
        expect(err.provider).toBe('openai');
      }
    }
    expect(() => assertSupported('anthropic', ALL, TOOL_REQ)).not.toThrow();
    expect(() => assertSupported('anthropic', NONE, TEXT_REQ)).not.toThrow(); // nothing required
  });

  it('assertStreamable throws when the provider cannot stream', () => {
    expect(() => assertStreamable('gemini', NONE)).toThrowError(UnsupportedCapabilityError);
    expect(() => assertStreamable('anthropic', ALL)).not.toThrow();
  });
});
