import { describe, expect, it } from 'vitest';
import { AgentSchema, SessionContextSchema, type RunOrSessionEvent } from '@relavium/shared';
import type { LlmProvider, ModelPricing, StreamChunk } from '@relavium/llm';
import { AgentSession } from './agent-session.js';
import { createAbortController } from './execution-host.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink, createSessionHandle } from './session-handle.js';
import { createToolRegistry } from '../tools/registry.js';

const model = 'review-r11-cancel';
const pricing: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 10000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 3000000,
  cachedInputPerMtokMicrocents: 2000000,
};
function gate() {
  let resolve: () => void = () => {
    throw new Error('gate uninitialized');
  };
  let reject: (e: unknown) => void = () => {
    throw new Error('gate uninitialized');
  };
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const entered = gate(),
    release = gate();
  const events: RunOrSessionEvent[] = [];
  const bus = new RunEventBus({ now: () => '2026-10-05T00:00:00.000Z' });
  bus.subscribe((e) => {
    events.push(e);
  });
  let calls = 0,
    keys = 0,
    turn = 0;
  const provider: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      promptCache: false,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => {
      throw new Error('stream expected');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      calls++;
      yield { type: 'text_delta', text: 'paid answer' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 3 },
      };
    },
  };
  const session = new AgentSession({
    sessionId: 'review-cancel',
    agentRef: 'a',
    agent: AgentSchema.parse({ id: 'a', provider: 'openai', model, system_prompt: 'offline' }),
    context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
    deps: {
      resolveProvider: () => provider,
      keyFor: () => {
        keys++;
        return 'synthetic';
      },
      sleep: () => Promise.resolve(),
      newAbortController: createAbortController,
      reserveEffectTurnKey: () => ++turn,
      tools: [],
      registry: createToolRegistry({ tools: [], host: {} }),
      autoCompact: false,
      maxTurns: 1,
      resolvePrice: new Map([[model, pricing]]),
      emit: createSessionEventSink(bus, 'review-cancel'),
      flushBudgetCommitments: () => {
        entered.resolve();
        return release.promise;
      },
    },
  });
  const handle = createSessionHandle(bus, 'review-cancel', () => session.cancel());
  session.start();
  return { session, handle, events, entered, release, counts: () => ({ calls, keys }) };
}

describe('R11 independent cancellation at post-provider durability boundary', () => {
  for (const action of ['none', 'abort', 'cancel'] as const)
    for (const settlement of ['success', 'failure'] as const)
      it(`${action} during awaited flush, ${settlement}`, async () => {
        const h = fixture();
        const failure = new Error('synthetic private flush fault');
        const sent = h.session.sendMessage('first').then(
          () => undefined,
          (error: unknown) => error,
        );
        await h.entered.promise;
        expect(h.counts()).toEqual({ calls: 1, keys: 1 });
        expect(h.events.filter((e) => e.type === 'cost:updated')).toMatchObject([
          { inputTokens: 7, outputTokens: 2, costMicrocents: 19, priced: true },
        ]);
        expect(h.events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
        if (action === 'cancel') h.session.cancel();
        if (action === 'abort') h.session.abort();
        if (settlement === 'success') h.release.resolve();
        else h.release.reject(failure);
        const escaped = await sent;
        if (action === 'cancel') {
          expect.soft(escaped).toBeUndefined();
          expect.soft(h.events.at(-1)?.type).toBe('session:cancelled');
          expect.soft(h.events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
        } else {
          expect(
            Object.is(escaped, settlement === 'failure' && action === 'none' ? failure : undefined),
          ).toBe(true);
          expect(h.events.at(-1)).toMatchObject({
            type: 'session:turn_completed',
            stopReason:
              settlement === 'success' ? 'stop' : action === 'abort' ? 'aborted' : 'error',
            tokensUsed: { input: 7, output: 2 },
          });
          await h.session.sendMessage('past cap');
          expect(h.counts()).toEqual({ calls: 1, keys: 1 });
          expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        }
      });
  it('terminal handle and passive bus observer agree after cancel while flush is pending', async () => {
    const h = fixture();
    const streamEvents: RunOrSessionEvent[] = [];
    const draining = (async () => {
      for await (const e of h.handle.events) streamEvents.push(e);
    })();
    const sent = h.session.sendMessage('first');
    await h.entered.promise;
    h.handle.cancel();
    await draining;
    h.release.resolve();
    await sent;
    expect(streamEvents.at(-1)?.type).toBe('session:cancelled');
    expect.soft(h.events.map((e) => e.type)).toEqual(streamEvents.map((e) => e.type));
  });
});
