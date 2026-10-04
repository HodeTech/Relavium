import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tools/registry.js';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import { createAbortController } from './execution-host.js';

type FaultSite = 'token' | 'cost' | 'ready-stop' | 'flush' | 'key' | 'timer' | 'method';
function fixture(site: FaultSite, marker: Error, aborting = false, zero = false, hook = false) {
  const events: SessionStreamEvent[] = [];
  const counts = { provider: 0, keys: 0 };
  let once = true;
  let stopObserved = false;
  let turnKey = 0;
  const fail = (): never => {
    once = false;
    if (aborting) session.abort();
    throw marker;
  };
  const provider: LlmProvider = {
    id: 'anthropic',
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
      throw new Error('unused generate');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      counts.provider += 1;
      yield { type: 'text_delta', text: 'observed response' };
      stopObserved = true;
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { inputTokens: zero ? 0 : 2, outputTokens: zero ? 0 : 3 },
      };
    },
  };
  if (site === 'method') {
    const stream = provider.stream.bind(provider);
    Object.defineProperty(provider, 'stream', {
      get: () => {
        if (once) fail();
        return stream;
      },
    });
  }
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    tools: [],
    registry: createToolRegistry({ tools: [], host: {} }),
    maxTurns: site === 'flush' ? 2 : 1,
    reserveEffectTurnKey: () => ++turnKey,
    keyFor: () => {
      counts.keys += 1;
      if (site === 'key' && once) fail();
      return 'synthetic-offline-key';
    },
    sleep: () => Promise.resolve(),
    now: () => 0,
    newAbortController: createAbortController,
    ...(hook ? { preEgress: () => undefined } : {}),
    ...(site === 'timer'
      ? {
          setTimer: () => {
            if (once) fail();
            return () => undefined;
          },
        }
      : {}),
    whenReady: async () => {
      if (site === 'ready-stop' && stopObserved && once) fail();
      return Promise.resolve();
    },
    flushBudgetCommitments: async () => {
      if (site === 'flush' && once) fail();
      return Promise.resolve();
    },
    emit: (event) => {
      events.push(event);
      if (
        once &&
        ((site === 'token' && event.type === 'agent:token') ||
          (site === 'cost' && event.type === 'cost:updated'))
      )
        fail();
    },
  };
  const session = new AgentSession({
    sessionId: 'callback-boundary',
    agentRef: 'boundary',
    agent: AgentSchema.parse({
      id: 'boundary',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      system_prompt: 'Offline response.',
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/boundary',
      fsScopeTier: 'sandboxed',
    }),
    deps,
  });
  session.start();
  return { session, events, counts };
}

const classified = () => new AgentTurnError('internal', 'fixed classified failure', false);
function staleClassified() {
  const error = classified();
  error.engaged = true;
  error.usage = { input: 999, output: 999 };
  return error;
}

async function attempt(h: ReturnType<typeof fixture>, marker: Error, aborting: boolean) {
  if (aborting || marker instanceof AgentTurnError || marker instanceof BudgetPauseError)
    await expect(h.session.sendMessage('first')).resolves.toBeUndefined();
  else await expect(h.session.sendMessage('first')).rejects.toBe(marker);
}

const terminal = (h: ReturnType<typeof fixture>) =>
  h.events.filter((event) => event.type === 'session:turn_completed');

describe('canonical turn accounting is independent of exception mutability and class', () => {
  for (const aborting of [false, true])
    for (const zero of [false, true])
      it.each(['token', 'cost', 'ready-stop'] as const)(
        `frozen classified %s (abort=${aborting}, zero=${zero})`,
        async (site) => {
          const marker = Object.freeze(classified());
          const h = fixture(site, marker, aborting, zero);
          await attempt(h, marker, aborting);
          expect(terminal(h)).toHaveLength(1);
          expect(terminal(h)[0]).toMatchObject({
            stopReason: aborting ? 'aborted' : 'error',
            tokensUsed:
              zero || site === 'token' ? { input: 0, output: 0 } : { input: 2, output: 3 },
          });
          expect(marker.engaged).toBeUndefined();
          expect(marker.usage).toBeUndefined();
          await h.session.sendMessage('hard cap');
          expect(h.counts.provider).toBe(1);
          expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        },
      );

  for (const aborting of [false, true])
    it.each([
      classified,
      staleClassified,
      () => new BudgetPauseError(1, 1, 100),
      () => new Error('private raw failure'),
    ])(
      `flush fault uses successful turn usage and consumes one slot (abort=${aborting}): %s`,
      async (makeError) => {
        const marker = makeError();
        const h = fixture('flush', marker, aborting);
        await attempt(h, marker, aborting);
        expect(terminal(h)[0]).toMatchObject({ tokensUsed: { input: 2, output: 3 } });
        await h.session.sendMessage('second allowed turn');
        expect(h.counts.provider).toBe(2);
        await h.session.sendMessage('third blocked turn');
        expect(h.counts.provider).toBe(2);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        expect(JSON.stringify(h.events)).not.toContain('private raw failure');
      },
    );

  for (const aborting of [false, true])
    it(
      'a pause-shaped cost observer retains observed usage and the engaged slot (abort=' +
        aborting +
        ')',
      async () => {
        const marker = new BudgetPauseError(1, 1, 100);
        const h = fixture('cost', marker, aborting);
        await attempt(h, marker, aborting);
        expect(terminal(h)[0]).toMatchObject({ tokensUsed: { input: 2, output: 3 } });
        await h.session.sendMessage('hard cap');
        expect(h.counts.provider).toBe(1);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
      },
    );
});

describe('proven pre-provider failures do not consume the hard turn cap', () => {
  for (const hook of [false, true])
    it.each(['key', 'timer'] as const)(
      `%s refusal permits retry (budget hook=${hook})`,
      async (site) => {
        const h = fixture(site, new Error('private pre-provider value'), false, false, hook);
        await h.session.sendMessage('refused before provider');
        expect(h.counts.provider).toBe(0);
        expect(terminal(h)[0]).toMatchObject({ tokensUsed: { input: 0, output: 0 } });
        await h.session.sendMessage('retry');
        expect(h.counts.provider).toBe(1);
        expect(h.events.at(-1)).toMatchObject({
          stopReason: 'stop',
          tokensUsed: { input: 2, output: 3 },
        });
        await h.session.sendMessage('hard cap');
        expect(h.counts.provider).toBe(1);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        expect(JSON.stringify(h.events)).not.toContain('private pre-provider value');
      },
    );
});

describe('throwable presentation cannot replace the original failure', () => {
  for (const aborting of [false, true])
    for (const site of ['token', 'cost', 'flush'] as const)
      it(`hostile prototype ${site} abort=${aborting}`, async () => {
        const reflection = new Error('private reflection failure');
        const marker = new Proxy(new Error('original private callback'), {
          getPrototypeOf: () => {
            throw reflection;
          },
        });
        const h = fixture(site, marker, aborting);
        const observed = await h.session.sendMessage('first').then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(observed === (aborting ? undefined : marker)).toBe(true);
        expect(terminal(h)).toHaveLength(1);
        expect(terminal(h)[0]).toMatchObject({
          stopReason: aborting ? 'aborted' : 'error',
          tokensUsed: site === 'token' ? { input: 0, output: 0 } : { input: 2, output: 3 },
        });
        expect(JSON.stringify(h.events)).not.toContain('private');
        if (site === 'flush') await h.session.sendMessage('second allowed');
        await h.session.sendMessage('blocked');
        expect(h.counts.provider).toBe(site === 'flush' ? 2 : 1);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
      });
  for (const field of ['code', 'message', 'retryable'] as const)
    it(`hostile classified ${field} diagnostic falls back without replacing error`, async () => {
      const reflection = new Error('private diagnostic failure');
      const marker = new Proxy(classified(), {
        get: (target, key, receiver) => {
          if (key === field) throw reflection;
          const value: unknown = Reflect.get(target, key, receiver);
          return value;
        },
      });
      const h = fixture('cost', marker);
      const observed = await h.session.sendMessage('first').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(observed === marker).toBe(true);
      expect(terminal(h)).toHaveLength(1);
      expect(terminal(h)[0]).toMatchObject({
        tokensUsed: { input: 2, output: 3 },
        error: { code: 'internal' },
      });
      await h.session.sendMessage('blocked');
      expect(h.counts.provider).toBe(1);
      expect(JSON.stringify(h.events)).not.toContain('private');
    });
  for (const hook of [false, true])
    it(`provider method lookup refusal releases the session slot (hook=${hook})`, async () => {
      const h = fixture('method', new Error('private method lookup failure'), false, false, hook);
      await h.session.sendMessage('first');
      expect(h.counts.provider).toBe(0);
      expect(terminal(h)[0]).toMatchObject({ tokensUsed: { input: 0, output: 0 } });
      await h.session.sendMessage('repaired');
      expect(h.counts.provider).toBe(1);
      await h.session.sendMessage('blocked');
      expect(h.counts.provider).toBe(1);
      expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
    });
});

describe('typed observer presentation has no provider or budget authority', () => {
  for (const site of ['token', 'cost', 'ready-stop'] as const)
    for (const kind of ['turn', 'budget'] as const)
      it(`${site}/${kind} retains classified delivery with fixed private-safe presentation`, async () => {
        const marker =
          kind === 'turn'
            ? new AgentTurnError('provider_unavailable', 'private typed observer', true)
            : new BudgetPauseError(1, 1, 100);
        const h = fixture(site, marker);
        await expect(h.session.sendMessage('first')).resolves.toBeUndefined();
        expect(terminal(h)).toEqual([
          expect.objectContaining({
            stopReason: 'error',
            tokensUsed: site === 'token' ? { input: 0, output: 0 } : { input: 2, output: 3 },
            error: {
              code: 'internal',
              message: 'the session turn failed with an unexpected error',
              retryable: false,
            },
          }),
        ]);
        expect(JSON.stringify(h.events)).not.toContain(marker.message);
        await h.session.sendMessage('blocked');
        expect(h.counts.provider).toBe(1);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
      });
});
