import { describe, it, expect } from 'vitest';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { type LlmProvider, type StreamChunk, type ModelPricing, makeLlmError } from '@relavium/llm';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { AgentTurnError } from './agent-turn.js';
import { BudgetPauseError } from './budget-governor.js';
import { LedgerDurabilityError } from './money-durability.js';
const MODEL = 'r10-session-owned';
const PRICE: ModelPricing = {
  provider: 'openai',
  nativeId: MODEL,
  displayName: MODEL,
  contextWindowTokens: 30000,
  maxOutputTokens: 10000,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
  cacheWritePerMtokMicrocents: 4000000,
};
function errorFor(kind: 'typed' | 'pause' | 'ledger' | 'raw' | 'opaque'): unknown {
  if (kind === 'typed')
    return Object.freeze(new AgentTurnError('provider_unavailable', 'r10 PRIVATE observer', true));
  if (kind === 'pause') return Object.freeze(new BudgetPauseError(4, 10, 12));
  if (kind === 'ledger')
    return new LedgerDurabilityError(new Error('r10 PRIVATE false writer'), 'r10-wrong-writer');
  if (kind === 'raw') return new Error('r10 PRIVATE raw');
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('private classification trap');
      },
    },
  );
}
function makeSession(options: {
  fault: 'cost' | 'backoff' | 'clock' | 'compacting' | 'compacted';
  error: unknown;
  toolRound?: boolean;
  abort?: boolean;
}) {
  const events: SessionStreamEvent[] = [];
  const counts = { calls: 0, tools: 0, key: 0 };
  let armed = false,
    failOnce = true;
  const effects = createInMemoryEffectJournalStore();
  const tool: ToolDef = {
    id: 'r10-tool',
    source: 'builtin',
    description: 'independent offline tool',
    llmVisibleParams: { type: 'object' },
    parseArgs: (args) => args,
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    effect: () => 1,
    dispatch: () => {
      counts.tools++;
      return Promise.resolve('offline result');
    },
  };
  const fail = (): never => {
    failOnce = false;
    if (options.abort) session.abort();
    throw options.error;
  };
  const p: LlmProvider = {
    id: 'openai',
    customEndpoint: true,
    supports: {
      tools: true,
      streaming: true,
      parallelToolCalls: true,
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
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      counts.calls++;
      if (options.toolRound && counts.calls === 1) {
        yield { type: 'tool_call_start', id: 'c1', name: 'r10-tool' };
        yield { type: 'tool_call_end', id: 'c1' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 3 } };
        return;
      }
      if (armed && (options.fault === 'backoff' || options.fault === 'clock')) {
        yield {
          type: 'error',
          error: makeLlmError({
            provider: 'openai',
            kind: 'rate_limit',
            message: 'ordinary synthetic refusal',
            status: 429,
          }),
        };
        return;
      }
      yield { type: 'text_delta', text: 'independent summary' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 6, outputTokens: 5 } };
    },
  };
  const tools = options.toolRound ? [tool] : [];
  const session = new AgentSession({
    sessionId: 'r10-session',
    agentRef: 'a',
    agent: AgentSchema.parse({
      id: 'a',
      provider: 'openai',
      model: MODEL,
      system_prompt: 'offline',
      max_tokens: 16,
      tools: tools.map((t) => t.id),
      retry: { max: 2, backoff: 'linear' },
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/offline',
      fsScopeTier: 'sandboxed',
    }),
    deps: {
      resolveProvider: () => p,
      registry: createToolRegistry({ tools, host: {} }),
      tools,
      keyFor: () => {
        counts.key++;
        return 'offline-synthetic-placeholder';
      },
      sleep: () => {
        if (armed && failOnce && options.fault === 'backoff') fail();
        return Promise.resolve();
      },
      now: () => {
        if (armed && failOnce && options.fault === 'clock') fail();
        return 0;
      },
      newAbortController: createAbortController,
      reserveEffectTurnKey: () => counts.key + 1,
      effects: (c) => effects.for(c),
      emit: (e) => {
        events.push(e);
        if (!armed || !failOnce) return;
        if (
          options.fault === 'cost' &&
          e.type === 'cost:updated' &&
          (!options.toolRound || counts.calls === 2)
        )
          fail();
        if (options.fault === 'compacting' && e.type === 'session:compacting') fail();
        if (options.fault === 'compacted' && e.type === 'session:compacted') fail();
      },
      resolvePrice: new Map([[MODEL, PRICE]]),
      autoCompact: false,
      maxTurns: options.toolRound ? 1 : 5,
    },
  });
  session.start();
  return {
    session,
    events,
    counts,
    arm: () => {
      armed = true;
    },
  };
}
describe('R10 independent real session observer boundaries', () => {
  for (const fault of ['cost', 'backoff', 'clock'] as const)
    for (const kind of ['typed', 'pause', 'ledger', 'raw', 'opaque'] as const)
      it(`second tool round ${fault}/${kind} preserves one counted session slot and original delivery`, async () => {
        const error = errorFor(kind);
        const h = makeSession({ fault, error, toolRound: true });
        h.arm();
        let escaped: unknown;
        try {
          await h.session.sendMessage('first');
        } catch (e) {
          escaped = e;
        }
        if (kind === 'typed' || kind === 'pause') expect(escaped).toBeUndefined();
        else expect(Object.is(escaped, error)).toBe(true);
        expect(h.counts.calls).toBe(2);
        expect(h.counts.tools).toBe(1);
        const last = h.events.filter((e) => e.type === 'session:turn_completed').at(-1);
        expect(last).toMatchObject({
          error: { code: 'internal', retryable: false },
          tokensUsed: fault === 'cost' ? { input: 10, output: 8 } : { input: 4, output: 3 },
        });
        await h.session.sendMessage('later');
        expect(h.counts.calls).toBe(2);
        expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
        expect(JSON.stringify(h.events)).not.toContain('PRIVATE');
        expect(JSON.stringify(h.events)).not.toContain('wrong-writer');
      });
  for (const site of ['compacting', 'cost', 'compacted'] as const)
    for (const kind of ['typed', 'pause', 'raw', 'opaque'] as const)
      it(`actual compact ${site}/${kind} retains typed delivery versus exact raw rejection and cleanup`, async () => {
        const error = errorFor(kind);
        const h = makeSession({ fault: site, error });
        await h.session.sendMessage('one');
        await h.session.sendMessage('two');
        h.arm();
        let escaped: unknown;
        let result: Awaited<ReturnType<AgentSession['compact']>> | undefined;
        try {
          result = await h.session.compact();
        } catch (e) {
          escaped = e;
        }
        if (kind === 'typed' || kind === 'pause') {
          expect(escaped).toBeUndefined();
          expect(result).toMatchObject({
            kind: 'failed',
            message: 'the compaction failed with an unexpected observer error',
          });
        } else expect(Object.is(escaped, error)).toBe(true);
        expect(h.counts.calls).toBe(site === 'compacting' ? 2 : 3);
        await h.session.sendMessage('next');
        expect(h.events.at(-1)).toMatchObject({
          type: 'session:turn_completed',
          stopReason: 'stop',
        });
        expect(
          JSON.stringify(h.events.filter((e) => e.type === 'session:turn_completed')),
        ).not.toContain('PRIVATE');
      });
  it('EA7 abort during second paid cost callback wins and clears next-turn state', async () => {
    const error = new Error('r10 private abort callback');
    const h = makeSession({ fault: 'cost', error, toolRound: true, abort: true });
    h.arm();
    await h.session.sendMessage('first');
    expect(h.events.filter((e) => e.type === 'session:turn_completed')).toMatchObject([
      { stopReason: 'aborted', tokensUsed: { input: 10, output: 8 } },
    ]);
    await h.session.sendMessage('blocked');
    expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
    expect(h.counts.calls).toBe(2);
  });
});
