import { describe, expect, it } from 'vitest';
import {
  AgentSchema,
  AgentSessionSchema,
  SessionMessageSchema,
  SessionContextSchema,
  type RunOrSessionEvent,
  type RunEvent,
} from '@relavium/shared';
import {
  FallbackChain,
  CostTracker,
  type LlmProvider,
  type StreamChunk,
  type LlmResult,
  type ModelPricing,
} from '@relavium/llm';
import { AgentSession } from './agent-session.js';
import { reconstructSessionState } from './session-resume.js';
import { createAbortController, createInMemoryHost, InMemoryRunStore } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink, createSessionHandle } from './session-handle.js';

const model = 'r12-cold-resume';
const rate: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 9000,
  maxOutputTokens: 4096,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
};
function provider(onCall: () => void): LlmProvider {
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
        outputCombinations: [],
        surface: 'chat',
      },
    },
    generate: () => {
      throw new Error('stream-only fixture');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      onCall();
      yield { type: 'text_delta', text: 'fresh summary' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } };
    },
  };
}
function resumed(action: 'none' | 'cancel' | 'abort', mode: 'cold' | 'warm') {
  let calls = 0,
    keys = 0,
    controllers = 0,
    ids = 20;
  const passive: RunOrSessionEvent[] = [];
  const primary: RunOrSessionEvent[] = [];
  const bus = new RunEventBus({ now: () => '2026-10-05T22:00:00.000Z' });
  bus.subscribe((e) => {
    passive.push(e);
  });
  const p = provider(() => {
    calls++;
  });
  let armed = mode === 'cold';
  const context = SessionContextSchema.parse({
    workingDir: '/synthetic/r12',
    fsScopeTier: 'sandboxed',
  });
  const agent = AgentSchema.parse({
    id: 'cold-agent',
    provider: 'openai',
    model,
    system_prompt: 'offline',
    max_tokens: 20,
  });
  const record = AgentSessionSchema.parse({
    id: 'cold',
    agentSlug: 'cold-agent',
    context,
    status: 'idle',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostMicrocents: 0,
    createdAt: '2026-10-05T21:00:00.000Z',
    updatedAt: '2026-10-05T21:00:00.000Z',
  });
  const rows = [
    ['user', 'older question'],
    ['assistant', 'older answer'],
    ['user', 'newer question'],
    ['assistant', 'newer answer'],
  ].map(([role, text], i) =>
    SessionMessageSchema.parse({
      id: 'message-' + i,
      sessionId: 'cold',
      sequenceNumber: i,
      role,
      content: [{ type: 'text', text }],
      timestamp: '2026-10-05T21:00:00.000Z',
    }),
  );
  const state = reconstructSessionState(record, rows);
  expect(state.completedTurnSpans).toHaveLength(2);
  const session = AgentSession.resume(
    {
      sessionId: 'cold',
      agentRef: 'cold-agent',
      agent,
      context,
      deps: {
        resolveProvider: () => {
          if (armed) {
            armed = false;
            if (action === 'cancel') session.cancel();
            if (action === 'abort') session.abort();
          }
          return p;
        },
        keyFor: () => {
          keys++;
          return 'synthetic-r12';
        },
        sleep: () => Promise.resolve(),
        newAbortController: () => {
          controllers++;
          return createAbortController();
        },
        reserveEffectTurnKey: () => ++ids,
        tools: [],
        registry: createToolRegistry({ tools: [], host: {} }),
        autoCompact: false,
        resolvePrice: new Map([[model, rate]]),
        emit: createSessionEventSink(bus, 'cold'),
      },
    },
    state,
  );
  const handle = createSessionHandle(bus, 'cold', () => session.cancel());
  const drain = (async () => {
    for await (const e of handle.events) primary.push(e);
  })();
  return {
    session,
    passive,
    primary,
    drain,
    counts: () => ({ calls, keys, controllers }),
    arm: () => {
      armed = true;
    },
  };
}
describe('R12 newly reconstructed session pre-controller lifecycle', () => {
  for (const action of ['none', 'abort', 'cancel'] as const)
    it(`cold plan resolveProvider ${action}`, async () => {
      const h = resumed(action, 'cold');
      const result = await h.session.compact();
      if (action === 'cancel') {
        expect.soft(result.kind).toBe('cancelled');
        expect.soft(h.counts()).toEqual({ calls: 0, keys: 0, controllers: 0 });
        expect.soft(h.passive.map((e) => e.type)).toEqual(['session:cancelled']);
        const next = await h.session.sendMessage('must remain closed').then(
          () => ({ kind: 'accepted' }),
          (error: unknown) => ({ kind: 'rejected', error }),
        );
        expect.soft(next).toMatchObject({ kind: 'rejected', error: { code: 'not_active' } });
      } else {
        expect(result.kind).toBe('compacted');
        expect(h.counts().calls).toBe(1);
      }
      h.session.cancel();
      await h.drain;
      expect.soft(h.primary.map((e) => e.type)).toEqual(h.passive.map((e) => e.type));
    });
  it('warm memoized plan cannot reinvoke cancellation callback', async () => {
    const h = resumed('cancel', 'warm');
    await h.session.sendMessage('warm plan');
    h.arm();
    const result = await h.session.compact();
    expect(result.kind).toBe('compacted');
    expect(h.counts().calls).toBe(2);
    h.session.cancel();
    await h.drain;
  });
});

describe('R12 generation ownership at pricing vs teardown callbacks', () => {
  for (const location of ['none', 'pricing', 'cleanup'] as const)
    it(`owned generated text survives ${location} mutation`, async () => {
      const part = { type: 'text' as const, text: 'provider-original' };
      const result: LlmResult = {
        content: [part],
        stopReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      };
      const p = provider(() => undefined);
      let calls = 0;
      p.generate = () => {
        calls++;
        return Promise.resolve(result);
      };
      const overlay = new Map([[model, rate]]);
      const originalGet = overlay.get.bind(overlay);
      overlay.get = (key) => {
        if (location === 'pricing') part.text = 'callback-replacement';
        return originalGet(key);
      };
      const chain = new FallbackChain([{ provider: p, model, maxAttempts: 1 }], {
        keyFor: () => 'synthetic',
        sleep: () => Promise.resolve(),
        costTracker: new CostTracker(overlay),
        newAbortController: createAbortController,
        setTimer: () => () => {
          if (location === 'cleanup') part.text = 'callback-replacement';
        },
      });
      const answer = await chain.generate({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }],
      });
      expect(calls).toBe(1);
      expect.soft(answer.content).toEqual([{ type: 'text', text: 'provider-original' }]);
    });
});

import { WorkflowEngine } from './engine.js';
import { createAgentNodeExecutor } from './agent-runner.js';
import { createDispatchingNodeExecutor } from './node-handlers/dispatcher.js';
import { parseWorkflow } from '../parser.js';

describe('R12 pricing mutation at actual workflow output', () => {
  for (const mutation of [false, true])
    it(`workflow retains provider text with pricing mutation=${mutation}`, async () => {
      const part = { type: 'text' as const, text: 'paid provider-original' };
      let calls = 0;
      const p = provider(() => undefined);
      p.supports.media.outputCombinations = [['image']];
      p.generate = () => {
        calls++;
        return Promise.resolve({
          content: [
            {
              type: 'media',
              mimeType: 'image/png',
              source: { kind: 'handle', ref: 'media://sha256-' + 'c'.repeat(64) },
            },
            part,
          ],
          stopReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 2 },
        });
      };
      const overlay = new Map([[model, rate]]);
      const get = overlay.get.bind(overlay);
      overlay.get = (key) => {
        if (mutation && calls > 0) part.text = 'pricing-invented replacement';
        return get(key);
      };
      const store = new InMemoryRunStore();
      const host = createInMemoryHost({ store });
      const executor = createAgentNodeExecutor({
        resolveProvider: () => p,
        keyFor: () => 'r12-synthetic',
        sleep: () => Promise.resolve(),
        tools: [],
        registry: createToolRegistry({ tools: [], host: {} }),
        resolvePrice: overlay,
        resolveMediaSurface: () => 'chat',
      });
      const engine = new WorkflowEngine({
        host,
        executor: createDispatchingNodeExecutor({ agent: executor }),
        resolvePrice: overlay,
      });
      const workflow = parseWorkflow(
        `schema_version: '1.0'\nworkflow:\n  id: r12-result\n  agents:\n    - { id: a, provider: openai, model: r12-cold-resume, system_prompt: offline }\n  nodes:\n    - { id: n, type: agent, agent_ref: a, prompt_template: offline, output_modalities: [image], max_tokens: 9 }\n  edges: []\n`,
      );
      const handle = engine.start({ workflow, inputs: {} });
      const events: RunEvent[] = [];
      for await (const event of handle.events) events.push(event);
      const durable = store.eventsFor(handle.runId);
      const complete = durable.find((e) => e.type === 'node:completed');
      expect(calls).toBe(1);
      expect(events.at(-1)?.type).toBe('run:completed');
      expect(durable.filter((e) => e.type === 'cost:attempt_settled')).toMatchObject([
        { costMicrocents: 7, inputTokens: 3, outputTokens: 2 },
      ]);
      expect.soft(JSON.stringify(complete)).toContain('paid provider-original');
      expect.soft(JSON.stringify(complete)).not.toContain('pricing-invented');
    });
});
