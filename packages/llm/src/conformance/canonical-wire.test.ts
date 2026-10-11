import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContentPart, UsageEvidence } from '@relavium/shared';
import { createAnthropicAdapter } from '../adapters/anthropic.js';
import { createGeminiAdapter } from '../adapters/gemini.js';
import { createOpenAiAdapter } from '../adapters/openai.js';
import type { LlmProvider, LlmRequest, LlmResult, StreamChunk } from '../types.js';
import { createExchangeReplay } from './exchange-replay.js';
import {
  canonicalWireExchange,
  type WireMethod,
  type WireProvider,
} from './fixtures/canonical-wire.js';

const KEY = 'offline-wire-synthetic-key';
const providers: readonly WireProvider[] = ['anthropic', 'openai', 'deepseek', 'gemini'];
const methods: readonly WireMethod[] = ['generate', 'stream'];

function adapter(
  provider: WireProvider,
  replay: ReturnType<typeof createExchangeReplay>,
): LlmProvider {
  if (provider === 'anthropic') return createAnthropicAdapter({ fetch: replay.fetch });
  if (provider === 'gemini') {
    // Exercise the installed SDK's HTTP serialization and SSE parser, never GeminiTransport.
    vi.stubGlobal('fetch', replay.fetch);
    return createGeminiAdapter();
  }
  return createOpenAiAdapter({
    providerId: provider,
    fetch: replay.fetch,
    ...(provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
  });
}

function structuredRequest(provider: WireProvider): LlmRequest {
  return {
    model: `w8-wire-${provider}`,
    maxTokens: 37,
    system: 'Return the requested JSON object.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Return JSON.' }] }],
    temperature: 0.25,
    stopSequences: ['END'],
    responseFormat: {
      type: 'json',
      name: 'wire_result',
      strict: true,
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    },
  };
}

function toolRequest(provider: WireProvider, named: boolean): LlmRequest {
  return {
    model: `w8-wire-${provider}`,
    maxTokens: 37,
    system: 'Use weather information to answer.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] }],
    tools: [
      {
        name: 'get_weather',
        description: 'Look up weather for a city.',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
      },
    ],
    toolChoice: named ? { name: 'get_weather' } : 'auto',
  };
}

/** Assemble ONLY canonical chunks. No production accumulator or wire mapper participates. */
async function call(
  provider: LlmProvider,
  request: LlmRequest,
  method: WireMethod,
): Promise<Pick<LlmResult, 'content' | 'stopReason' | 'usage'>> {
  if (method === 'generate') return provider.generate(request, KEY);
  const content: ContentPart[] = [];
  const tools = new Map<string, { name: string; args: string }>();
  const thoughts = new Map<string, string>();
  let terminal: Extract<StreamChunk, { type: 'stop' }> | undefined;
  for await (const chunk of provider.stream(request, KEY)) {
    expect(terminal, 'a terminal must be last').toBeUndefined();
    switch (chunk.type) {
      case 'text_delta': {
        const previous = content.at(-1);
        if (previous?.type === 'text') previous.text += chunk.text;
        else content.push({ type: 'text', text: chunk.text });
        break;
      }
      case 'reasoning_start':
        expect(thoughts.has(chunk.id)).toBe(false);
        thoughts.set(chunk.id, '');
        break;
      case 'reasoning_delta':
        expect(thoughts.has(chunk.id)).toBe(true);
        thoughts.set(chunk.id, (thoughts.get(chunk.id) ?? '') + chunk.text);
        break;
      case 'reasoning_end':
        expect(thoughts.has(chunk.id)).toBe(true);
        content.push({
          type: 'reasoning',
          text: thoughts.get(chunk.id) ?? '',
          ...(chunk.signature === undefined ? {} : { signature: chunk.signature }),
        });
        thoughts.delete(chunk.id);
        break;
      case 'tool_call_start':
        expect(tools.has(chunk.id)).toBe(false);
        tools.set(chunk.id, { name: chunk.name, args: '' });
        break;
      case 'tool_call_delta': {
        const tool = tools.get(chunk.id);
        expect(tool).toBeDefined();
        if (tool === undefined) throw new Error('missing canonical tool start');
        tool.args += chunk.argsJsonDelta;
        break;
      }
      case 'tool_call_end': {
        const tool = tools.get(chunk.id);
        expect(tool).toBeDefined();
        if (tool === undefined) throw new Error('missing canonical tool start');
        const args: unknown = JSON.parse(tool.args);
        content.push({
          type: 'tool_call',
          id: chunk.id,
          name: tool.name,
          args,
          ...(chunk.signature === undefined ? {} : { signature: chunk.signature }),
        });
        tools.delete(chunk.id);
        break;
      }
      case 'stop':
        terminal = chunk;
        break;
      default:
        expect.fail(`unexpected canonical chunk: ${chunk.type}`);
    }
  }
  expect(tools.size).toBe(0);
  expect(thoughts.size).toBe(0);
  expect(terminal).toBeDefined();
  if (terminal === undefined) throw new Error('missing canonical terminal');
  return { content, stopReason: terminal.stopReason, usage: terminal.usage };
}

function expectedToolContent(provider: WireProvider, signed: boolean): ContentPart[] {
  return [
    ...(signed && (provider === 'anthropic' || provider === 'gemini')
      ? [
          {
            type: 'reasoning' as const,
            text: 'Check the weather.',
            signature: provider === 'anthropic' ? 'wire-anthropic-thought' : 'wire-gemini-thought',
          },
        ]
      : []),
    {
      type: 'tool_call',
      id:
        provider === 'anthropic'
          ? 'toolu_wire_weather'
          : provider === 'gemini'
            ? 'gemini-tool-0-get_weather'
            : 'call_wire_weather',
      name: 'get_weather',
      args: { city: 'Paris' },
      ...(signed && provider === 'gemini' ? { signature: 'wire-gemini-call' } : {}),
    },
  ];
}

/** Report cleanup failure without replacing an earlier wire/evidence assertion. */
function assertConsumed(replay: ReturnType<typeof createExchangeReplay>): void {
  let failure: { readonly error: unknown } | undefined;
  try {
    replay.assertConsumed();
  } catch (error) {
    failure = { error };
  }
  expect
    .soft(
      failure,
      failure?.error instanceof Error ? failure.error.message : 'exchange consumption must succeed',
    )
    .toBeUndefined();
}

const expectedUsage: Record<WireProvider, UsageEvidence> = {
  anthropic: {
    kind: 'complete',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 },
  },
  openai: {
    kind: 'complete',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, reasoningTokens: 0 },
  },
  deepseek: {
    kind: 'complete',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, reasoningTokens: 0 },
  },
  gemini: {
    kind: 'complete',
    usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 0, reasoningTokens: 0 },
  },
};

function assertUsage(provider: WireProvider, result: Pick<LlmResult, 'usage'>): void {
  expect(result.usage).toEqual(expectedUsage[provider]);
}

describe('canonical wire matrix through installed SDK HTTP (W8 Step 3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  for (const provider of providers) {
    for (const method of methods) {
      it(`${provider} ${method}: populated system and structured JSON match exact HTTP`, async () => {
        const replay = createExchangeReplay([
          canonicalWireExchange(provider, method, 'structured'),
        ]);
        try {
          const result = await call(adapter(provider, replay), structuredRequest(provider), method);
          expect(result.content).toEqual([{ type: 'text', text: '{"ok":true}' }]);
          expect(result.stopReason).toBe('stop');
          assertUsage(provider, result);
        } finally {
          assertConsumed(replay);
        }
      });

      it(`${provider} ${method}: advertised tool schema and named choice match exact HTTP`, async () => {
        const replay = createExchangeReplay([canonicalWireExchange(provider, method, 'named')]);
        try {
          const result = await call(adapter(provider, replay), toolRequest(provider, true), method);
          expect(result.content).toEqual(expectedToolContent(provider, false));
          expect(result.stopReason).toBe('tool_use');
          assertUsage(provider, result);
        } finally {
          assertConsumed(replay);
        }
      });

      it(`${provider} ${method}: returned tool IDs and signed parts survive two-turn continuation HTTP`, async () => {
        const replay = createExchangeReplay([
          canonicalWireExchange(provider, method, 'continuation'),
          canonicalWireExchange(provider, method, 'final'),
        ]);
        try {
          const instance = adapter(provider, replay);
          const request = toolRequest(provider, false);
          const first = await call(instance, request, method);
          // Pin literal canonical IDs, parsed args and signatures BEFORE using the returned data.
          expect(first.content).toEqual(expectedToolContent(provider, true));
          expect(first.stopReason).toBe('tool_use');
          assertUsage(provider, first);
          const tool = first.content.find((part) => part.type === 'tool_call');
          if (tool?.type !== 'tool_call') throw new Error('missing canonical tool call');
          const final = await call(
            instance,
            {
              ...request,
              messages: [
                ...request.messages,
                { role: 'assistant', content: first.content },
                {
                  role: 'tool',
                  content: [
                    {
                      type: 'tool_result',
                      toolCallId: tool.id,
                      result: { forecast: 'sunny', temperatureC: 18 },
                    },
                  ],
                },
              ],
            },
            method,
          );
          expect(final.content).toEqual([{ type: 'text', text: 'Paris is sunny at 18 C.' }]);
          expect(final.stopReason).toBe('stop');
          assertUsage(provider, final);
        } finally {
          assertConsumed(replay);
        }
      });
    }
  }
});
