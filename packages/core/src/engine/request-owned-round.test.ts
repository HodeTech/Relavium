import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateRequestTokens,
  type LlmMessage,
  type LlmRequest,
  type ResponseFormat,
  type ToolDef,
} from '@relavium/llm';
import {
  createAnthropicAdapter,
  createGeminiAdapter,
  createOpenAiAdapter,
} from '@relavium/llm/adapters';
import { unwiredEffectJournal } from '@relavium/shared';
import {
  prepareAgentTurnRequest,
  runAgentTurn,
  type AgentTurnParams,
  type TextPreEgressInfo,
} from './agent-turn.js';
import { MoneyDurability } from './money-durability.js';

const cases = [
  { provider: 'openai', model: 'gpt-5.4-mini', path: 'stream' },
  { provider: 'deepseek', model: 'deepseek-chat', path: 'stream' },
  { provider: 'anthropic', model: 'claude-haiku-4-5', path: 'stream' },
  { provider: 'gemini', model: 'gemini-2.5-flash', path: 'stream' },
  { provider: 'gemini', model: 'gemini-2.5-flash', path: 'generate' },
] as const;
type Case = (typeof cases)[number];
function deferred() {
  let resolve: () => void = () => {
    throw new Error('deferred not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function reply(c: Case): Response {
  const json =
    c.provider === 'gemini'
      ? {
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }
      : c.provider === 'anthropic'
        ? {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: c.model,
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : {
            id: 'c',
            object: 'chat.completion',
            created: 0,
            model: c.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'done', refusal: null },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
  const sse =
    c.provider === 'gemini'
      ? `data: ${JSON.stringify(json)}\n\n`
      : c.provider === 'anthropic'
        ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
        : 'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  return new Response(c.path === 'generate' ? JSON.stringify(json) : sse, {
    headers: {
      'content-type': c.path === 'generate' ? 'application/json' : 'text/event-stream',
    },
  });
}
function setup(c: Case) {
  const bodies: string[] = [];
  const fetch = (_input: unknown, init?: RequestInit): Promise<Response> => {
    if (typeof init?.body !== 'string') throw new Error('expected actual SDK JSON');
    bodies.push(init.body);
    return Promise.resolve(reply(c));
  };
  vi.stubGlobal('fetch', fetch);
  const provider =
    c.provider === 'gemini'
      ? createGeminiAdapter()
      : c.provider === 'anthropic'
        ? createAnthropicAdapter({ fetch, maxRetries: 0 })
        : createOpenAiAdapter({
            providerId: c.provider,
            fetch,
            maxRetries: 0,
            ...(c.provider === 'deepseek' ? { baseURL: 'https://api.deepseek.com' } : {}),
          });
  const text = { type: 'text' as const, text: 'original message' };
  const messages: LlmMessage[] = [{ role: 'user', content: [text] }];
  const schema = {
    type: 'object' as const,
    description: 'original schema',
    properties: { value: { type: 'string' as const } },
  };
  const tool = {
    name: 'echo',
    description: 'original tool',
    parameters: schema,
  };
  const tools: ToolDef[] = [tool];
  const responseFormat: ResponseFormat = { type: 'json', schema };
  const controller = new AbortController();
  const params: AgentTurnParams = {
    messages,
    tools,
    responseFormat,
    planEntries: [{ provider, model: c.model, maxAttempts: 1 }],
    chainCapabilities: {
      keyFor: () => 'offline-synthetic-credential',
      sleep: () => Promise.resolve(),
    },
    nodeId: 'owned-round',
    signal: controller.signal,
    emit: () => undefined,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => {
        throw new Error('unexpected tool');
      },
    },
    dispatchContext: {
      nodeId: 'owned-round',
      grantedToolIds: new Set(['echo']),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: { maxToolTurns: 1, maxToolCorrections: 0 },
    maxTokens: 16,
    ...(c.path === 'generate' ? { outputModalities: ['text', 'image'] } : {}),
  };
  const mutate = () => {
    text.text = 'x'.repeat(100_000);
    tool.description = 'y'.repeat(100_000);
    schema.description = 'z'.repeat(100_000);
    schema.properties.value.type = 'string';
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'late message' }],
    });
    tools.push({
      name: 'late',
      description: 'late tool',
      parameters: { type: 'object' },
    });
  };
  return { params, provider, bodies, mutate, controller };
}
async function direct(c: Case, provider: ReturnType<typeof setup>['provider'], req: LlmRequest) {
  if (c.path === 'generate') await provider.generate(req, 'offline-synthetic-credential');
  else
    for await (const chunk of provider.stream(req, 'offline-synthetic-credential'))
      expect(chunk.type).not.toBe('error');
}
afterEach(() => vi.unstubAllGlobals());

describe('same measured core round through actual installed SDK HTTP (ADR-0102)', () => {
  for (const c of cases)
    for (const barrier of ['money', 'admission'] as const) {
      it(`${c.provider} ${c.path}: ${barrier} wait cannot alter measurement, quote context or wire body`, async () => {
        const f = setup(c);
        const prepared = prepareAgentTurnRequest(f.params);
        await direct(c, f.provider, prepared.request);
        const expectedBody = f.bodies.shift();
        expect(expectedBody).toBeDefined();
        const entered = deferred();
        const release = deferred();
        const money = new MoneyDurability({
          emit: (draft) => {
            if (draft.nodeId === 'sibling') {
              entered.resolve();
              return release.promise;
            }
            return undefined;
          },
        });
        if (barrier === 'money')
          money.record(
            {
              nodeId: 'sibling',
              model: c.model,
              attemptNumber: 1,
              inputTokens: 1,
              outputTokens: 0,
              costMicrocents: 1,
              priced: true,
            },
            1,
          );
        const infos: TextPreEgressInfo[] = [];
        const active = runAgentTurn({
          ...f.params,
          preparedRequest: prepared.request,
          money: money.turnPort(() => 2),
          preEgress: (info) => {
            if (info.route !== 'text') throw new Error('unexpected media endpoint');
            infos.push(info);
            if (barrier === 'admission') {
              entered.resolve();
              return release.promise;
            }
            return undefined;
          },
        });
        const result = active.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await entered.promise;
          expect(f.bodies).toEqual([]);
          f.mutate();
          release.resolve();
          const outcome = await result;
          if (!outcome.ok) throw outcome.error;
          expect(infos).toHaveLength(1);
          expect(infos[0]?.inputTokensEstimate).toBe(prepared.inputTokensEstimate);
          const context = infos[0]?.allowanceQuoteContext;
          if (context?.route !== 'text') throw new Error('missing exact quote construction');
          expect(context.request.messages).toBe(prepared.request.messages);
          expect(context.request.responseFormat).toBe(prepared.request.responseFormat);
          expect(
            estimateRequestTokens({
              ...context.request,
              system: context.request.system ?? '',
            }),
          ).toBe(prepared.inputTokensEstimate);
          expect(f.bodies).toEqual([expectedBody]);
          expect(f.params.messages.length).toBe(2);
          expect(Object.isFrozen(f.params.messages)).toBe(false);
        } finally {
          release.resolve();
          await result;
          await money.join();
        }
      });
    }
  for (const c of cases) {
    it(`${c.provider} ${c.path}: caller mutation after initial measurement still executes the exact prepared payload`, async () => {
      const f = setup(c);
      const first = prepareAgentTurnRequest(f.params);
      await direct(c, f.provider, first.request);
      const expected = f.bodies.shift();
      f.mutate();
      const infos: TextPreEgressInfo[] = [];
      await runAgentTurn({
        ...f.params,
        preparedRequest: first.request,
        preEgress: (info) => {
          if (info.route !== 'text') throw new Error('unexpected route');
          infos.push(info);
        },
      });
      expect(infos[0]?.inputTokensEstimate).toBe(first.inputTokensEstimate);
      expect(f.bodies).toEqual([expected]);
    });
  }
});
