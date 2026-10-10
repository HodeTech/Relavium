import { expect, it, vi } from 'vitest';
import { UsageCoverageFold, unwiredEffectJournal } from '@relavium/shared';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import {
  LlmProviderError,
  makeLlmError,
  type LlmInvocationOptions,
  type LlmProvider,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import { MoneyDurability, type SettledAttemptDraft } from './money-durability.js';

const model = 'native-predecessor-core';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 1000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 1000000,
  cachedInputPerMtokMicrocents: 0,
};
function params(provider: LlmProvider, streaming: boolean): AgentTurnParams {
  return {
    nodeId: 'native',
    messages: [],
    temperature: 0.5,
    ...(streaming ? {} : { outputModalities: ['text', 'audio'] }),
    planEntries: [{ provider, model, maxAttempts: 2 }],
    chainCapabilities: { keyFor: () => 'offline', sleep: () => Promise.resolve() },
    signal: new AbortController().signal,
    emit: () => undefined,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected tool')),
    },
    dispatchContext: {
      nodeId: 'native',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
  };
}
for (const streaming of [false, true]) {
  for (const typed of [false, true]) {
    it(`native SDK predecessor retains exact admission failure (${streaming}/${typed})`, async () => {
      const marker = typed
        ? new LlmProviderError(
            makeLlmError({ provider: 'openai', kind: 'rate_limit', message: 'private observer' }),
          )
        : new Error('private observer');
      const fetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message: 'Unsupported parameter: temperature',
                param: 'temperature',
                code: 'unsupported_parameter',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
      const provider = createOpenAiAdapter({
        fetch,
        maxRetries: 0,
        baseURL: 'https://native-predecessor-core.test/v1',
      });
      const settle = vi.fn(() => {
        if (settle.mock.calls.length === 1) throw marker;
      });
      const preEgress = vi.fn(() => ({
        reservedMicrocents: 5,
        release: () => undefined,
        settle: () => undefined,
        settleAtReservedEstimate: settle,
      }));
      const outcome = await captureAgentTurnOutcome({ ...params(provider, streaming), preEgress });
      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('expected observer failure');
      expect(outcome.error).toBe(marker);
      // Lease actions retain their admission/money control-flow origin. A rejected lease
      // action remains owned and is retried conservatively during outer cleanup.
      expect(outcome.failureOrigin).toBe('turn');
      expect(settle).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(preEgress).toHaveBeenCalledTimes(1);
    });
  }
  for (const observer of ['none', 'plain', 'typed'] as const)
    it(`complete predecessor settles once across native repair (${streaming}/${observer})`, async () => {
      const marker =
        observer === 'typed'
          ? new LlmProviderError(
              makeLlmError({
                provider: 'openai',
                kind: 'rate_limit',
                message: 'private cost observer',
              }),
            )
          : new Error('private cost observer');
      const started = vi.fn();
      const settlements: SettledAttemptDraft[] = [];
      const fold = new UsageCoverageFold();
      fold.start('complete');
      let ordinal = 0,
        cost = 0;
      const money = new MoneyDurability({
        beginUsageInvocation: (draft) => {
          const invocation = {
            producerId: 'native',
            ordinal: ++ordinal,
            dispatchId: 'turn',
            round: 1,
            chainAttempt: 1,
          };
          fold.pending(draft.model, invocation);
          return Promise.resolve(invocation);
        },
        emitUsageDisposition: (draft) => {
          fold.disposition(draft.model, draft.invocation, draft.disposition, draft.receiptPending);
        },
        emit: (draft) => {
          settlements.push(draft);
          if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
        },
      });
      const repair = async (options?: LlmInvocationOptions): Promise<void> => {
        await options?.beforeNativeRetry?.({
          ...makeLlmError({
            provider: 'openai',
            kind: 'bad_request',
            status: 400,
            message: 'parameter rejected',
          }),
          usage: { kind: 'complete', usage: { inputTokens: 7, outputTokens: 3 } },
        });
        options?.nativeInvocationStarted?.();
        started();
      };
      // Complete native error evidence is a supported external-provider seam path;
      // shipping OpenAI HTTP parameter errors currently have no usage payload.
      const provider: LlmProvider = {
        ...createOpenAiAdapter(),
        customEndpoint: true,
        generate: async (_request, _key, options) => {
          await repair(options);
          return {
            content: [],
            stopReason: 'stop',
            usage: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
          };
        },
        stream: async function* (_request, _key, options): AsyncGenerator<StreamChunk> {
          await repair(options);
          yield {
            type: 'stop',
            stopReason: 'stop',
            usage: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
          };
        },
      };
      const actual = vi.fn();
      const conservative = vi.fn();
      const outcome = await captureAgentTurnOutcome({
        ...params(provider, streaming),
        resolvePrice: new Map([[model, price]]),
        money: money.turnPort(() => cost),
        emit: (event) => {
          if (event.type === 'cost:updated') {
            cost += event.costMicrocents;
            if (observer !== 'none') throw marker;
          }
        },
        preEgress: () => ({
          reservedMicrocents: 20,
          release: () => undefined,
          settle: actual,
          settleAtReservedEstimate: conservative,
        }),
      });
      if (observer === 'none') expect(outcome.kind).toBe('succeeded');
      else {
        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('expected cost observer failure');
        expect(outcome.error).toBe(marker);
        expect(outcome.failureOrigin).toBe('observer');
      }
      expect(started).toHaveBeenCalledTimes(observer === 'none' ? 1 : 0);
      expect(cost).toBe(10);
      expect(settlements).toHaveLength(observer === 'none' ? 2 : 1);
      expect(settlements[0]).toMatchObject({
        inputTokens: 7,
        outputTokens: 3,
        costMicrocents: 10,
        priced: true,
      });
      if (observer === 'none')
        expect(settlements[1]).toMatchObject({
          inputTokens: 0,
          outputTokens: 0,
          costMicrocents: 0,
          priced: true,
        });
      expect(actual.mock.calls).toEqual(observer === 'none' ? [[10], [0]] : [[10]]);
      expect(conservative).not.toHaveBeenCalled();
      expect(fold.snapshot().coverage).toEqual({
        unverified: false,
        pendingInvocations: 0,
        unknownCalls: 0,
      });
    });
}
