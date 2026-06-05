import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CapabilityFlagsSchema,
  LlmErrorKindSchema,
  LlmErrorSchema,
  LlmMessageSchema,
  LlmRequestSchema,
  LlmResultSchema,
  StreamChunkSchema,
  ToolChoiceSchema,
  ToolDefSchema,
  UsageSchema,
} from './types.js';
import type { LlmProvider, LlmResult, ProviderId, StreamChunk } from './types.js';

const usage = { inputTokens: 10, outputTokens: 20 };

describe('seam request/message/tool schemas', () => {
  it('accepts a minimal valid request and rejects an empty model', () => {
    const req = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    expect(LlmRequestSchema.safeParse(req).success).toBe(true);
    expect(LlmRequestSchema.safeParse({ ...req, model: '' }).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ ...req, maxTokens: 0 }).success).toBe(false); // positive
  });

  it('accepts a request with tools, toolChoice, and the providerOptions escape hatch', () => {
    expect(
      LlmRequestSchema.safeParse({
        model: 'gpt-4o',
        system: 'be terse',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [{ name: 'read_file', parameters: { type: 'object' } }],
        toolChoice: { name: 'read_file' },
        temperature: 0.2,
        maxTokens: 256,
        providerOptions: { reasoning: { effort: 'high' } },
      }).success,
    ).toBe(true);
  });

  it('validates a message carries normalized ContentParts, not a raw string', () => {
    expect(LlmMessageSchema.safeParse({ role: 'assistant', content: 'plain string' }).success).toBe(
      false,
    );
    expect(
      LlmMessageSchema.safeParse({
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'read_file', args: {} }],
      }).success,
    ).toBe(true);
  });

  it('accepts an object ToolDef.parameters and rejects a non-object', () => {
    expect(ToolDefSchema.safeParse({ name: 'f', parameters: { type: 'object' } }).success).toBe(
      true,
    );
    expect(ToolDefSchema.safeParse({ name: 'f', parameters: 'nope' }).success).toBe(false);
    expect(ToolDefSchema.safeParse({ name: '', parameters: {} }).success).toBe(false); // non-empty name
  });

  it('accepts the three toolChoice forms', () => {
    for (const tc of ['auto', 'none', 'required', { name: 'f' }]) {
      expect(ToolChoiceSchema.safeParse(tc).success).toBe(true);
    }
    expect(ToolChoiceSchema.safeParse('maybe').success).toBe(false);
  });
});

describe('seam result/usage/error/capability schemas', () => {
  it('pins Usage to non-negative integers', () => {
    expect(UsageSchema.safeParse(usage).success).toBe(true);
    expect(UsageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
    expect(UsageSchema.safeParse({ ...usage, outputTokens: 1.5 }).success).toBe(false);
  });

  it('accepts a result with normalized content + a stop reason', () => {
    expect(
      LlmResultSchema.safeParse({
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage,
        raw: { id: 'msg_1' },
      }).success,
    ).toBe(true);
    // stopReason is the closed StopReason enum (re-exported from @relavium/shared)
    expect(
      LlmResultSchema.safeParse({ content: [], stopReason: 'banana', usage, raw: null }).success,
    ).toBe(false);
  });

  it('classifies LlmError and pins the kind set', () => {
    expect(
      LlmErrorSchema.safeParse({
        kind: 'rate_limit',
        retryable: true,
        status: 429,
        provider: 'anthropic',
        message: 'slow down',
      }).success,
    ).toBe(true);
    expect(LlmErrorKindSchema.options).toHaveLength(9);
    expect(
      LlmErrorSchema.safeParse({ kind: 'boom', retryable: false, provider: 'openai', message: 'x' })
        .success,
    ).toBe(false);
    // provider is the closed seam id set
    expect(
      LlmErrorSchema.safeParse({ kind: 'auth', retryable: false, provider: 'cohere', message: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires every capability flag', () => {
    const flags = {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
    };
    expect(CapabilityFlagsSchema.safeParse(flags).success).toBe(true);
    const missing = {
      tools: true,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
    };
    expect(CapabilityFlagsSchema.safeParse(missing).success).toBe(false); // missing `reasoning`
  });
});

describe('StreamChunk union', () => {
  const chunks: StreamChunk[] = [
    { type: 'text_delta', text: 'he' },
    { type: 'tool_call_start', id: 'c1', name: 'read_file' },
    { type: 'tool_call_delta', id: 'c1', argsJsonDelta: '{"path":' },
    { type: 'tool_call_end', id: 'c1' },
    { type: 'stop', stopReason: 'tool_use', usage },
    {
      type: 'error',
      error: { kind: 'overloaded', retryable: true, provider: 'gemini', message: 'busy' },
    },
  ];

  it.each(chunks)('accepts the %o chunk', (chunk) => {
    expect(StreamChunkSchema.safeParse(chunk).success).toBe(true);
  });

  it('rejects an unknown chunk type', () => {
    expect(StreamChunkSchema.safeParse({ type: 'thinking', text: 'x' }).success).toBe(false);
  });
});

describe('seam types are pure Relavium types (no vendor SDK type crosses the seam)', () => {
  it('pins ProviderId to the closed Relavium id set', () => {
    expectTypeOf<ProviderId>().toEqualTypeOf<'anthropic' | 'openai' | 'gemini' | 'deepseek'>();
  });

  it('LlmResult is the Relavium shape end-to-end', () => {
    expectTypeOf<LlmResult['stopReason']>().toEqualTypeOf<
      'stop' | 'length' | 'tool_use' | 'content_filter' | 'error'
    >();
  });

  it('LlmProvider is implementable with only Relavium types', () => {
    // A stub that typechecks proves the interface needs no vendor SDK type — a leaked vendor type
    // would make this fail to compile (and the import-zone fence forbids the import outright).
    const stub: LlmProvider = {
      id: 'anthropic',
      generate: () => Promise.resolve({ content: [], stopReason: 'stop', usage, raw: null }),
      stream: async function* () {
        await Promise.resolve();
        yield { type: 'text_delta', text: 'hi' } satisfies StreamChunk;
      },
      supports: {
        tools: true,
        streaming: true,
        parallelToolCalls: false,
        vision: false,
        promptCache: false,
        reasoning: false,
      },
    };
    expect(stub.id).toBe('anthropic');
    expectTypeOf<LlmProvider['generate']>().returns.resolves.toEqualTypeOf<LlmResult>();
  });
});
