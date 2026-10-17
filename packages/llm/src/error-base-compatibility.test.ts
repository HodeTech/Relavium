import { RelaviumError } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  LlmConfigError,
  LlmProviderError,
  makeLlmError,
  ToolSchemaError,
  UnknownModelError,
} from './index.js';

describe('LLM error family compatibility', () => {
  it('retains config descendants and caller-owned structured context', () => {
    const knownModels = Object.freeze(['model-a', 'model-b']);
    const error = new UnknownModelError('model-c', knownModels);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(LlmConfigError);
    expect(error).toBeInstanceOf(UnknownModelError);
    expect(error).toMatchObject({
      name: 'UnknownModelError',
      code: 'unknown_model',
      modelId: 'model-c',
      message: "unknown model id 'model-c' — not in the pricing table",
    });
    expect(error.knownModels).toBe(knownModels);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });

  it('retains the reason and provider fields of a second config descendant', () => {
    const error = new ToolSchemaError('gemini', 'lookup', 'unsupported keyword');
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(LlmConfigError);
    expect(error).toMatchObject({
      name: 'ToolSchemaError',
      code: 'unsupported_tool_schema',
      provider: 'gemini',
      toolName: 'lookup',
      reason: 'unsupported keyword',
    });
  });

  it('retains the plain normalized seam value and wrapper identity without projecting fields', () => {
    const cause = new Error('transport unavailable');
    const llmError = makeLlmError({
      provider: 'openai',
      kind: 'transport',
      message: 'provider unavailable',
      cause,
    });
    expect(llmError).not.toBeInstanceOf(Error);
    const error = new LlmProviderError(llmError);
    expect(error).toBeInstanceOf(RelaviumError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'LlmProviderError', message: 'provider unavailable' });
    expect(error.llmError).toBe(llmError);
    expect(error.llmError.cause).toBe(cause);
    for (const key of ['code', 'kind', 'cause', 'retryable']) {
      expect(Object.hasOwn(error, key)).toBe(false);
    }
  });
});
