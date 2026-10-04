import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';

type Fault = 'cost' | 'updateCost' | 'token' | 'reasoning' | 'ready' | 'sleep' | 'clock';
type FirstChunk = 'text_delta' | 'reasoning_delta' | 'stop';
const FAULTS: readonly Fault[] = [
  'cost',
  'updateCost',
  'token',
  'reasoning',
  'ready',
  'sleep',
  'clock',
];

function harness(
  fault: Fault | undefined,
  aborting: boolean,
  zero: boolean,
  first?: FirstChunk,
  cancelling = false,
) {
  const events: SessionStreamEvent[] = [];
  const journal = createInMemoryEffectJournalStore();
  const counts = { provider: 0, keys: 0, tools: 0 };
  const marker = new Error('private-callback-value');
  let throwOnce = true;
  let currentChunk: StreamChunk['type'] | undefined;
  const fail = (): never => {
    throwOnce = false;
    if (cancelling) session.cancel();
    else if (aborting) session.abort();
    throw marker;
  };
  const active = (): boolean =>
    fault !== undefined && throwOnce && counts.provider === (first === undefined ? 2 : 1);
  const tool: ToolDef = {
    id: 'echo',
    source: 'builtin',
    description: 'offline echo',
    parseArgs: (args) => args,
    llmVisibleParams: { type: 'object' },
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    effect: (): 3 => 3,
    dispatch: () => {
      counts.tools += 1;
      return Promise.resolve('done');
    },
  };
  const provider: LlmProvider = {
    id: 'anthropic',
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
      vision: false,
      promptCache: false,
      reasoning: true,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => {
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      counts.provider += 1;
      if (first !== undefined) {
        currentChunk = first;
        if (first === 'text_delta') yield { type: 'text_delta', text: 'observed text' };
        if (first === 'reasoning_delta') {
          yield { type: 'reasoning_start', id: 'r' };
          yield { type: 'reasoning_delta', id: 'r', text: 'observed reasoning' };
          yield { type: 'reasoning_end', id: 'r' };
        }
        currentChunk = 'stop';
        yield {
          type: 'stop',
          stopReason: 'stop',
          usage: { inputTokens: zero ? 0 : 2, outputTokens: zero ? 0 : 3 },
        };
        return;
      }
      if (counts.provider === 1) {
        for (const id of ['first', 'second']) {
          currentChunk = 'tool_call_start';
          yield { type: 'tool_call_start', id, name: 'echo' };
          currentChunk = 'tool_call_end';
          yield { type: 'tool_call_end', id };
        }
        currentChunk = 'stop';
        yield {
          type: 'stop',
          stopReason: 'tool_use',
          usage: { inputTokens: zero ? 0 : 2, outputTokens: zero ? 0 : 3 },
        };
        return;
      }
      if (fault === 'sleep' || fault === 'clock') {
        currentChunk = 'error';
        yield {
          type: 'error',
          error: {
            provider: 'anthropic',
            kind: fault === 'clock' ? 'rate_limit' : 'transport',
            retryable: true,
            message: 'offline provider error',
          },
        };
        return;
      }
      currentChunk = 'text_delta';
      yield { type: 'text_delta', text: 'second text' };
      currentChunk = 'reasoning_delta';
      yield { type: 'reasoning_start', id: 'r' };
      yield { type: 'reasoning_delta', id: 'r', text: 'second reasoning' };
      yield { type: 'reasoning_end', id: 'r' };
      currentChunk = 'stop';
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { inputTokens: zero ? 0 : 5, outputTokens: zero ? 0 : 7 },
      };
    },
  };
  let turnKey = 100;
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry: createToolRegistry({ tools: [tool], host: {} }),
    tools: [tool],
    maxTurns: 1,
    reserveEffectTurnKey: () => ++turnKey,
    effects: (correlation) => journal.for(correlation),
    keyFor: () => {
      counts.keys += 1;
      return 'synthetic-offline-key';
    },
    sleep: async () => {
      if (fault === 'sleep' && active()) fail();
      return Promise.resolve();
    },
    now: () => {
      if (fault === 'clock' && active()) fail();
      return 0;
    },
    updateCost: () => {
      if (fault === 'updateCost' && active()) fail();
    },
    whenReady: async () => {
      if (fault === 'ready' && active() && currentChunk !== 'error') fail();
      return Promise.resolve();
    },
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
      if (!active()) return;
      if (
        (fault === 'cost' && event.type === 'cost:updated') ||
        (fault === 'token' && event.type === 'agent:token') ||
        (fault === 'reasoning' && event.type === 'agent:reasoning')
      )
        fail();
    },
  };
  const session = new AgentSession({
    sessionId: 'callback-session',
    agentRef: 'callback-agent',
    agent: AgentSchema.parse({
      id: 'callback-agent',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      system_prompt: 'Use offline tools.',
      tools: ['echo'],
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/callback',
      fsScopeTier: 'sandboxed',
    }),
    deps,
  });
  session.start();
  return { session, events, counts, journal, marker };
}

async function assertFailure(
  h: ReturnType<typeof harness>,
  aborting: boolean,
  usage: { input: number; output: number },
  calls: number,
) {
  if (aborting) await expect(h.session.sendMessage('first')).resolves.toBeUndefined();
  else await expect(h.session.sendMessage('first')).rejects.toBe(h.marker);
  const terminals = h.events.filter((event) => event.type === 'session:turn_completed');
  expect(terminals).toHaveLength(1);
  expect(terminals[0]).toMatchObject({
    stopReason: aborting ? 'aborted' : 'error',
    tokensUsed: usage,
  });
  if (aborting) expect(terminals[0]).not.toHaveProperty('error');
  else
    expect(terminals[0]).toMatchObject({
      error: { code: 'internal', message: 'the session turn failed with an unexpected error' },
    });
  await h.session.sendMessage('blocked by the hard cap');
  expect(h.counts.provider).toBe(calls);
  expect(h.counts.keys).toBe(calls);
  expect(h.events.filter((event) => event.type === 'session:turn_completed')).toHaveLength(2);
  expect(h.events.at(-1)).toMatchObject({
    error: { code: 'turn_limit' },
    tokensUsed: { input: 0, output: 0 },
  });
  expect(JSON.stringify(h.events)).not.toContain('private-callback-value');
}

describe('raw callback failures preserve session accounting and exact error identity (ADR-0055 EA2)', () => {
  for (const aborting of [false, true])
    for (const zero of [false, true]) {
      it.each(FAULTS)(
        `%s after a settled round (abort=${aborting}, zero=${zero})`,
        async (fault) => {
          const h = harness(fault, aborting, zero);
          const costSettled = fault === 'cost' || fault === 'updateCost';
          const usage = zero
            ? { input: 0, output: 0 }
            : costSettled
              ? { input: 7, output: 10 }
              : { input: 2, output: 3 };
          await assertFailure(h, aborting, usage, 2);
          expect(h.counts.tools).toBe(2);
          expect(h.journal.rows()).toHaveLength(2);
          expect(h.journal.rows().every((row) => row.state === 'committed')).toBe(true);
        },
      );
    }
  for (const aborting of [false, true]) {
    for (const [fault, first] of [
      ['token', 'text_delta'],
      ['reasoning', 'reasoning_delta'],
      ['ready', 'text_delta'],
      ['ready', 'stop'],
    ] as const) {
      it(`${fault} on first ${first} proves engagement before an attempt record (abort=${aborting})`, async () => {
        const h = harness(fault, aborting, false, first);
        await assertFailure(
          h,
          aborting,
          first === 'stop' ? { input: 2, output: 3 } : { input: 0, output: 0 },
          1,
        );
        expect(h.counts.tools).toBe(0);
        expect(h.journal.rows()).toHaveLength(0);
      });
    }
  }
});

describe('callback accounting positive and terminal-cancellation controls', () => {
  it('counts observed stop usage exactly once when both provider rounds settle', async () => {
    const h = harness(undefined, false, false);
    await h.session.sendMessage('first');
    expect(h.events.filter((event) => event.type === 'session:turn_completed')).toEqual([
      expect.objectContaining({
        stopReason: 'stop',
        tokensUsed: { input: 7, output: 10, model: 'claude-opus-4-8' },
      }),
    ]);
    await h.session.sendMessage('second');
    expect(h.counts).toEqual({ provider: 2, keys: 2, tools: 2 });
    expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
  });
  for (const fault of ['token', 'ready', 'cost'] as const) {
    it(`cancel plus ${fault} fault retains the sole terminal cancellation`, async () => {
      const h = harness(fault, false, false, fault === 'cost' ? undefined : 'text_delta', true);
      await expect(h.session.sendMessage('first')).resolves.toBeUndefined();
      expect(h.events.filter((event) => event.type === 'session:cancelled')).toHaveLength(1);
      expect(h.events.filter((event) => event.type === 'session:turn_completed')).toHaveLength(0);
      const calls = { ...h.counts };
      await expect(h.session.sendMessage('second')).rejects.toThrow();
      expect(h.counts).toEqual(calls);
    });
  }
});
