import { describe, expect, it } from 'vitest';

import { GeminiToolCallIds } from '../tool-normalizer.js';
import type { LlmRequest, StreamChunk } from '../types.js';
import {
  buildGeminiRequest,
  createGeminiAdapter,
  geminiAdapter,
  geminiErrorToLlmError,
  mapContent,
  mapStopReason,
  mapUsage,
  type GeminiRequest,
  type GeminiResponse,
  type GeminiTransport,
} from './gemini.js';

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

/** A transport that returns a fixed response and captures the request it was handed. */
function fakeTransport(
  response: GeminiResponse,
  stream: readonly GeminiResponse[] = [response],
): GeminiTransport & { lastRequest?: GeminiRequest } {
  const holder: GeminiTransport & { lastRequest?: GeminiRequest } = {
    generate: (request) => {
      holder.lastRequest = request;
      return Promise.resolve(response);
    },
    stream: (request) => {
      holder.lastRequest = request;
      return Promise.resolve(
        (async function* () {
          await Promise.resolve();
          for (const item of stream) {
            yield item;
          }
        })(),
      );
    },
  };
  return holder;
}

const REQ: LlmRequest = {
  model: 'gemini-2.0-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

describe('Gemini adapter', () => {
  it('exposes the gemini id and capability surface', () => {
    expect(geminiAdapter.id).toBe('gemini');
    expect(geminiAdapter.supports.tools).toBe(true);
    expect(geminiAdapter.supports.streaming).toBe(true);
  });

  it('maps finish reasons (STOP+tools → tool_use; SAFETY → content_filter; MALFORMED → error)', () => {
    expect(mapStopReason('STOP', false)).toBe('stop');
    expect(mapStopReason('STOP', true)).toBe('tool_use');
    expect(mapStopReason(undefined, true)).toBe('tool_use');
    expect(mapStopReason('MAX_TOKENS', false)).toBe('length');
    expect(mapStopReason('SAFETY', false)).toBe('content_filter');
    expect(mapStopReason('RECITATION', false)).toBe('content_filter');
    expect(mapStopReason('MALFORMED_FUNCTION_CALL', false)).toBe('error');
    expect(mapStopReason('SOMETHING_NEW', false)).toBe('stop');
  });

  it('maps usage to NET, subtracting cached content from the prompt count', () => {
    expect(
      mapUsage({ promptTokenCount: 100, candidatesTokenCount: 20, cachedContentTokenCount: 30 }),
    ).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadTokens: 30 });
    expect(mapUsage({ promptTokenCount: 12, candidatesTokenCount: 7 })).toEqual({
      inputTokens: 12,
      outputTokens: 7,
    });
    expect(mapUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('mapContent synthesizes tool-call ids, skips thought parts', () => {
    const response: GeminiResponse = {
      candidates: [
        {
          content: {
            parts: [
              { text: 'thinking...', thought: true },
              { text: 'here' },
              { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
            ],
          },
        },
      ],
    };
    const parts = mapContent(response, new GeminiToolCallIds());
    expect(parts[0]).toEqual({ type: 'text', text: 'here' });
    expect(parts[1]).toMatchObject({
      type: 'tool_call',
      name: 'get_weather',
      args: { city: 'Paris' },
    });
    if (parts[1]?.type === 'tool_call') {
      expect(parts[1].id.length).toBeGreaterThan(0); // synthesized
    }
  });
});

describe('geminiErrorToLlmError — classification', () => {
  it('classifies abort, status-bearing, and unknown throwables', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(geminiErrorToLlmError(abort)).toMatchObject({ kind: 'cancelled', retryable: false });
    expect(geminiErrorToLlmError({ status: 429, message: 'rate' })).toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      status: 429,
    });
    expect(geminiErrorToLlmError({ status: 401, message: 'auth' })).toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    expect(geminiErrorToLlmError('boom')).toMatchObject({ kind: 'unknown', retryable: false });
  });
});

describe('Gemini adapter — request building (buildGeminiRequest)', () => {
  it('routes system → systemInstruction, tools → functionDeclarations, and tool choice modes', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.0-flash',
      system: 'be terse',
      temperature: 0.4,
      maxTokens: 64,
      stopSequences: ['END'],
      toolChoice: 'required',
      tools: [
        {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(request.config['systemInstruction']).toBe('be terse');
    expect(request.config['temperature']).toBe(0.4);
    expect(request.config['maxOutputTokens']).toBe(64);
    expect(request.config['stopSequences']).toEqual(['END']);
    expect(request.config['toolConfig']).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(request.config['tools']).toMatchObject([
      { functionDeclarations: [{ name: 'get_weather' }] },
    ]);
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('maps a named tool choice to ANY + allowedFunctionNames', () => {
    const request = buildGeminiRequest({ ...REQ, toolChoice: { name: 'get_weather' } });
    expect(request.config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
  });

  it('threads a real AbortSignal into config.abortSignal', () => {
    const controller = new AbortController();
    const request = buildGeminiRequest({ ...REQ, signal: controller.signal });
    expect(request.config['abortSignal']).toBe(controller.signal);
  });

  it('maps none/auto tool choice modes', () => {
    expect(buildGeminiRequest({ ...REQ, toolChoice: 'none' }).config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
    expect(buildGeminiRequest({ ...REQ, toolChoice: 'auto' }).config['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'AUTO' },
    });
  });

  it('round-trips tool_call → functionCall and tool_result → functionResponse by name', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.0-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_call',
              id: 'gemini-tool-0-get_weather',
              name: 'get_weather',
              args: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            { type: 'tool_result', toolCallId: 'gemini-tool-0-get_weather', result: { tempC: 18 } },
          ],
        },
      ],
    });
    expect(request.contents[0]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
    });
    // the tool result resolves the function name from the matching tool_call id (Gemini has no id)
    expect(request.contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 18 } } }],
    });
  });

  it('wraps a non-object tool result and lets providerOptions only ADD (mapped fields win)', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.0-flash',
      providerOptions: { cachedContent: 'abc', temperature: 99 },
      temperature: 0.1,
      messages: [
        { role: 'tool', content: [{ type: 'tool_result', toolCallId: 'x', result: 'plain text' }] },
      ],
    });
    expect(request.contents[0]?.parts[0]).toEqual({
      functionResponse: { name: 'x', response: { result: 'plain text' } },
    });
    expect(request.config['cachedContent']).toBe('abc'); // escape-hatch field
    expect(request.config['temperature']).toBe(0.1); // mapped field wins over providerOptions
  });
});

describe('Gemini adapter — generate / stream via injected transport', () => {
  const textResponse: GeminiResponse = {
    candidates: [{ content: { parts: [{ text: 'Hello' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };

  it('generate folds a response into an LlmResult', async () => {
    const adapter = createGeminiAdapter({ transport: fakeTransport(textResponse) });
    const result = await adapter.generate(REQ, 'k');
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.stopReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('generate surfaces a transport rejection as a classified LlmProviderError', async () => {
    const transport: GeminiTransport = {
      generate: () => Promise.reject(Object.assign(new Error('rl'), { status: 429 })),
      stream: () => Promise.reject(new Error('unused')),
    };
    const adapter = createGeminiAdapter({ transport });
    let caught: unknown;
    try {
      await adapter.generate(REQ, 'sk-SECRET-123');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.stringify(caught)).not.toContain('SECRET');
  });

  it('stream folds text + a tool call (start/delta/end) then a terminal stop', async () => {
    const toolChunk: GeminiResponse = {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
    };
    const adapter = createGeminiAdapter({ transport: fakeTransport(toolChunk, [toolChunk]) });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.find((c) => c.type === 'tool_call_start')).toMatchObject({ name: 'get_weather' });
    expect(chunks.some((c) => c.type === 'tool_call_delta')).toBe(true);
    expect(chunks.some((c) => c.type === 'tool_call_end')).toBe(true);
    const stop = chunks.at(-1);
    expect(stop?.type).toBe('stop');
    if (stop?.type === 'stop') {
      expect(stop.stopReason).toBe('tool_use');
    }
  });

  it('stream yields a single error chunk when the transport fails to start', async () => {
    const transport: GeminiTransport = {
      generate: () => Promise.reject(new Error('unused')),
      stream: () => Promise.reject(Object.assign(new Error('overloaded'), { status: 503 })),
    };
    const adapter = createGeminiAdapter({ transport });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.type).toBe('error');
    if (chunks[0]?.type === 'error') {
      expect(chunks[0].error.kind).toBe('overloaded');
    }
  });
});

describe('Gemini adapter — remaining branches', () => {
  it('maps all content-filter finish reasons', () => {
    for (const reason of ['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'] as const) {
      expect(mapStopReason(reason, false)).toBe('content_filter');
    }
  });

  it('generate tolerates a response with no usage metadata', async () => {
    const adapter = createGeminiAdapter({
      transport: {
        generate: () =>
          Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          }),
        stream: () => Promise.reject(new Error('unused')),
      },
    });
    const result = await adapter.generate(REQ, 'k');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('folds a mid-stream iteration error into an error chunk', async () => {
    const adapter = createGeminiAdapter({
      transport: {
        generate: () => Promise.reject(new Error('unused')),
        stream: () =>
          Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield { candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
              throw Object.assign(new Error('mid-stream'), { status: 500 });
            })(),
          ),
      },
    });
    const chunks = await collect(adapter.stream(REQ, 'k'));
    expect(chunks.some((c) => c.type === 'text_delta')).toBe(true);
    expect(chunks.at(-1)?.type).toBe('error');
  });

  it('drops a message that lowers to zero parts', () => {
    const request = buildGeminiRequest({
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'user', content: [] },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
    expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });
});
