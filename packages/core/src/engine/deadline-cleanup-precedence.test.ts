import { describe, expect, it } from 'vitest';
import { openDeadline, type AbortSignalLike } from '@relavium/shared';
import {
  CostTracker,
  FallbackChain,
  LlmProviderError,
  makeLlmError,
  type AttemptRecord,
  type LlmProvider,
  type LlmResult,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import { createAbortController } from './execution-host.js';

const model = 'r11-cleanup';
const price: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 1000,
  maxOutputTokens: 20,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 0,
};
const auth = new LlmProviderError(
  makeLlmError({ provider: 'openai', kind: 'auth', message: 'auth 401 canonical' }),
);
const cleanup = new Error('PRIVATE independent cleanup');
function p(fails: boolean): LlmProvider {
  return {
    id: 'openai',
    customEndpoint: true,
    supports: {
      tools: false,
      streaming: true,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [['text']],
      },
    },
    generate: () =>
      fails
        ? Promise.reject(auth)
        : Promise.resolve({
            content: [{ type: 'text', text: 'ok' }],
            stopReason: 'stop',
            usage: { inputTokens: 2, outputTokens: 3 },
          }),
    stream: async function* () {
      await Promise.resolve();
      if (fails) throw auth;
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } };
    },
  };
}

describe('R11 independently challenge cleanup precedence after accounted success and prior provider auth', () => {
  for (const mode of ['generate', 'stream'] as const)
    for (const location of ['timer', 'listener'] as const)
      for (const result of ['success', 'provider-auth'] as const)
        it(`${mode} ${location} cleanup preserves ${result} accounting/diagnostic`, async () => {
          const records: AttemptRecord[] = [];
          let removed = 0;
          const signal: AbortSignalLike = {
            aborted: false,
            addEventListener: () => undefined,
            removeEventListener: () => {
              removed++;
              if (location === 'listener') throw cleanup;
            },
          };
          const chain = new FallbackChain(
            [{ provider: p(result === 'provider-auth'), model, maxAttempts: 1 }],
            {
              keyFor: () => 'offline-synthetic',
              sleep: () => Promise.resolve(),
              newAbortController: createAbortController,
              setTimer: () => () => {
                if (location === 'timer') throw cleanup;
              },
              costTracker: new CostTracker(new Map([[model, price]])),
              onAttempt: (r) => records.push(r),
            },
          );
          let caught: unknown;
          const chunks: StreamChunk[] = [];
          try {
            if (mode === 'generate') await chain.generate({ model, messages: [], signal });
            else
              for await (const chunk of chain.stream({ model, messages: [], signal })) {
                chunks.push(chunk);
              }
          } catch (e) {
            caught = e;
          }

          // A secondary cleanup failure cannot replace a canonical provider refusal. Successful
          // invocation still records known cost, then returns a fixed non-retryable host-fault diagnostic.
          const kind = result === 'success' ? 'unknown' : 'auth';
          expect(records).toHaveLength(1);
          expect(records).toMatchObject([
            { outcome: 'failed', providerInvoked: true, error: { kind, retryable: false } },
          ]);
          if (result === 'success')
            expect(records).toMatchObject([
              { usage: { inputTokens: 2, outputTokens: 3 }, cost: { costMicrocents: 8 } },
            ]);
          if (mode === 'generate') {
            expect(caught).toBeInstanceOf(LlmProviderError);
            if (!(caught instanceof LlmProviderError))
              throw new Error('missing typed seam failure');
            expect(caught.llmError).toMatchObject({ kind, retryable: false });
            if (result === 'success') expect(Object.is(caught.llmError.cause, cleanup)).toBe(true);
          } else {
            expect(caught).toBeUndefined();
            const terminal = chunks.at(-1);
            expect(terminal).toMatchObject({ type: 'error', error: { kind, retryable: false } });
            if (terminal?.type !== 'error') throw new Error('missing stream error');
            if (result === 'success') expect(Object.is(terminal.error.cause, cleanup)).toBe(true);
          }
          expect(JSON.stringify(records)).not.toContain('PRIVATE');
          if (location === 'timer') expect.soft(removed).toBe(1);
        });
});

describe('generated ownership before custom deadline cleanup', () => {
  for (const throwing of [false, true]) {
    it(`cleanup mutation cannot replace known quantities or typed content, throwing=${throwing}`, async () => {
      const usage = { inputTokens: 2, outputTokens: 3 };
      const part = { type: 'text' as const, text: 'owned answer' };
      const result: LlmResult = { content: [part], stopReason: 'stop', usage };
      const provider = p(false);
      provider.generate = () => Promise.resolve(result);
      const records: AttemptRecord[] = [];
      const chain = new FallbackChain([{ provider, model, maxAttempts: 1 }], {
        keyFor: () => 'offline-synthetic',
        sleep: () => Promise.resolve(),
        newAbortController: createAbortController,
        setTimer: () => () => {
          usage.inputTokens = 9000;
          part.text = 'replaced by cleanup';
          if (throwing) throw cleanup;
        },
        costTracker: new CostTracker(new Map([[model, price]])),
        onAttempt: (record) => records.push(record),
      });
      let received: LlmResult | undefined;
      let escaped: unknown;
      try {
        received = await chain.generate({ model, messages: [] });
      } catch (error) {
        escaped = error;
      }
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        providerInvoked: true,
        usage: { inputTokens: 2, outputTokens: 3 },
        cost: { costMicrocents: 8 },
        outcome: throwing ? 'failed' : 'succeeded',
      });
      if (throwing) {
        expect(escaped).toBeInstanceOf(LlmProviderError);
        if (!(escaped instanceof LlmProviderError)) throw new Error('missing typed cleanup fault');
        expect(escaped.llmError).toMatchObject({ kind: 'unknown', retryable: false });
        expect(Object.is(escaped.llmError.cause, cleanup)).toBe(true);
      } else {
        expect(escaped).toBeUndefined();
        expect(received?.content).toEqual([{ type: 'text', text: 'owned answer' }]);
        expect(received?.usage).toBe(records[0]?.usage);
      }
    });
  }
});

describe('R11 shared disposer performs all cleanup even if one host callback fails', () => {
  for (const location of ['timer', 'listener'] as const)
    it(`${location} failure still detaches/wakes an already pending race`, async () => {
      let removed = 0,
        disarmed = 0,
        woke = false;
      const signal: AbortSignalLike = {
        aborted: false,
        addEventListener: () => undefined,
        removeEventListener: () => {
          removed++;
          if (location === 'listener') throw cleanup;
        },
      };
      const scope = openDeadline(
        100,
        createAbortController,
        () => () => {
          disarmed++;
          if (location === 'timer') throw cleanup;
        },
        signal,
      );
      const waiting = scope.race(new Promise<number>(() => undefined)).then(() => {
        woke = true;
      });
      expect(() => scope.dispose()).toThrow(cleanup);
      scope.dispose();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect.soft(disarmed).toBe(1);
      expect.soft(removed).toBe(1);
      expect.soft(woke).toBe(true);
      if (woke) await waiting;
    });
});

describe('R11 optional source return synchronous and rejected best effort boundary', () => {
  for (const fault of ['none', 'rejected', 'synchronous'] as const)
    it(`consumer early close keeps source return ${fault} best effort`, async () => {
      let returned = 0;
      const source = p(false);
      source.stream = () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              Promise.resolve({
                done: false as const,
                value: { type: 'text_delta' as const, text: 'open' },
              }),
            return: () => {
              returned++;
              if (fault === 'synchronous') throw cleanup;
              if (fault === 'rejected') return Promise.reject(cleanup);
              return Promise.resolve({ done: true as const, value: undefined });
            },
          };
        },
      });
      const chain = new FallbackChain([{ provider: source, model, maxAttempts: 1 }], {
        keyFor: () => 'offline-synthetic',
        sleep: () => Promise.resolve(),
      });
      const stream: AsyncIterator<StreamChunk> = chain
        .stream({ model, messages: [] })
        [Symbol.asyncIterator]();
      await stream.next();
      let caught: unknown;
      try {
        await stream.return?.();
      } catch (e) {
        caught = e;
      }
      await Promise.resolve();
      expect(returned).toBe(1);
      expect(caught).toBeUndefined();
    });
});
