import { describe, expect, it } from 'vitest';
import {
  AgentSchema,
  AgentSessionSchema,
  SessionContextSchema,
  SessionMessageSchema,
  type RunOrSessionEvent,
} from '@relavium/shared';
import type { LlmProvider, LlmRequest, StreamChunk } from '@relavium/llm';
import { AgentSession, SessionStateError } from './agent-session.js';
import { reconstructSessionState } from './session-resume.js';
import { createAbortController } from './execution-host.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink, createSessionHandle } from './session-handle.js';
import { createToolRegistry } from '../tools/registry.js';
function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function fixture(action: 'none' | 'cancel' | 'abort' | 'send', warm: boolean) {
  const entered = gate(),
    finish = gate();
  const requests: LlmRequest[] = [];
  const events: RunOrSessionEvent[] = [];
  let nested: Promise<unknown> | undefined,
    armed = !warm,
    ids = 0,
    controllers = 0;
  const bus = new RunEventBus({ now: () => '2026-10-06T00:00:00.000Z' });
  bus.subscribe((e) => {
    events.push(e);
  });
  const provider: LlmProvider = {
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
        outputCombinations: [],
      },
    },
    generate: () => {
      throw new Error('not used');
    },
    stream: async function* (req): AsyncGenerator<StreamChunk> {
      requests.push(req);
      entered.release();
      await finish.promise;
      yield { type: 'text_delta', text: 'summary result' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } };
    },
  };
  const context = SessionContextSchema.parse({
    workingDir: '/offline/round13',
    fsScopeTier: 'sandboxed',
  });
  const agent = AgentSchema.parse({
    id: 'a',
    provider: 'openai',
    model: 'round13-owner',
    system_prompt: 'offline',
  });
  const state = reconstructSessionState(
    AgentSessionSchema.parse({
      id: 's',
      agentSlug: 'a',
      context,
      status: 'idle',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostMicrocents: 0,
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    }),
    ['user', 'assistant', 'user', 'assistant'].map((role, i) =>
      SessionMessageSchema.parse({
        id: 'm' + i,
        sessionId: 's',
        sequenceNumber: i,
        role,
        content: [{ type: 'text', text: 'prior ' + i }],
        timestamp: '2026-10-06T00:00:00.000Z',
      }),
    ),
  );
  const session = AgentSession.resume(
    {
      sessionId: 's',
      agentRef: 'a',
      agent,
      context,
      deps: {
        resolveProvider: () => {
          if (armed) {
            armed = false;
            if (action === 'cancel') session.cancel();
            if (action === 'abort') session.abort();
            if (action === 'send')
              nested = session.sendMessage('concurrent turn').then(
                () => 'completed',
                (e: unknown) => e,
              );
          }
          return provider;
        },
        keyFor: () => 'synthetic-only',
        sleep: () => Promise.resolve(),
        reserveEffectTurnKey: () => ++ids,
        newAbortController: () => {
          controllers++;
          return createAbortController();
        },
        tools: [],
        registry: createToolRegistry({ tools: [], host: {} }),
        autoCompact: false,
        emit: createSessionEventSink(bus, 's'),
      },
    },
    state,
  );
  const primary: RunOrSessionEvent[] = [];
  const handle = createSessionHandle(bus, 's', () => session.cancel());
  const drain = (async () => {
    for await (const event of handle.events) primary.push(event);
  })();
  return {
    session,
    requests,
    events,
    primary,
    drain,
    entered,
    finish,
    nested: () => nested,
    controllers: () => controllers,
    arm: () => {
      armed = true;
    },
  };
}
describe('cold compaction operation ownership', () => {
  for (const action of ['none', 'cancel', 'abort'] as const)
    it('cold resolver ' + action + ' control', async () => {
      const h = fixture(action, false);
      const work = h.session.compact();
      h.finish.release();
      const result = await work;
      expect(result.kind).toBe(action === 'cancel' ? 'cancelled' : 'compacted');
      expect(h.requests.length).toBe(action === 'cancel' ? 0 : 1);
      expect(h.controllers()).toBe(action === 'cancel' ? 0 : 1);
      h.session.cancel();
      await h.drain;
    });
  it('cold resolver cannot create two simultaneous operations owning one controller slot', async () => {
    const h = fixture('send', false);
    const work = h.session.compact().then(
      (r) => r,
      (e: unknown) => e,
    );
    await h.entered.promise;
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const started = h.requests.length;
    h.session.abort();
    const aborted = h.requests.map((r) => r.signal?.aborted);
    h.finish.release();
    const outcome = await work;
    const nestedOutcome = await h.nested();
    h.session.cancel();
    await h.drain;
    expect(h.events.find((e) => e.type === 'session:turn_completed')).toMatchObject({
      stopReason: 'aborted',
    });
    expect(h.events.filter((e) => e.type === 'session:turn_completed')).toHaveLength(1);
    expect(nestedOutcome).toBe('completed');
    expect(outcome).toBeInstanceOf(SessionStateError);
    expect(outcome).toMatchObject({ code: 'not_active' });
    expect(h.controllers()).toBe(1);
    expect(h.primary).toEqual(h.events);
    expect(h.primary.at(-1)?.type).toBe('session:cancelled');
    expect(started).toBe(1);
    expect(aborted).toEqual([true]);
  });
  it('warm memoized plan does not call the armed resolver again', async () => {
    const h = fixture('send', true);
    const first = h.session.sendMessage('warm');
    h.finish.release();
    await first;
    h.arm();
    await h.session.compact();
    expect(h.nested()).toBeUndefined();
    expect(h.requests).toHaveLength(2);
    h.session.cancel();
    await h.drain;
    await h.drain;
  });
});
