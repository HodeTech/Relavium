import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tools/registry.js';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import { createAbortController } from './execution-host.js';

type FaultSite = 'token' | 'cost' | 'ready-stop' | 'flush' | 'key' | 'timer';
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
