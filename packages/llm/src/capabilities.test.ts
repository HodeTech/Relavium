import { describe, expect, it } from 'vitest';

import {
  assertStreamable,
  assertSupported,
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
};
const NONE: CapabilityFlags = {
  tools: false,
  streaming: false,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
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
