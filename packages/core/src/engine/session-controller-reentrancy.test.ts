import { describe, expect, it } from 'vitest';
import { AgentSchema, SessionContextSchema, type RunOrSessionEvent } from '@relavium/shared';
import {
  prepareOutputCapPlan,
  type LlmProvider,
  type ModelPricing,
  type StreamChunk,
} from '@relavium/llm';
import { AgentSession } from './agent-session.js';
import { BudgetGovernor } from './budget-governor.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink, createSessionHandle } from './session-handle.js';
import { createInMemoryEffectJournalStore, createAbortController } from './execution-host.js';
import type { ToolDef } from '../tools/types.js';
import { createToolRegistry } from '../tools/registry.js';

const model = 'r11-fresh-lifecycle';
const rate: ModelPricing = {
  provider: 'openai',
  nativeId: model,
  displayName: model,
  contextWindowTokens: 9000,
  maxOutputTokens: 100,
  inputPerMtokMicrocents: 1000000,
  outputPerMtokMicrocents: 2000000,
  cachedInputPerMtokMicrocents: 3000000,
};
const prices = new Map([[model, rate]]);
function deferred() {
  let resolve: () => void = () => {
    throw new Error('unarmed');
  };
  let reject: (e: Error) => void = () => {
    throw new Error('unarmed');
  };
  const promise = new Promise<void>((ok, bad) => {
    resolve = ok;
    reject = bad;
  });
  return { promise, resolve, reject };
}
function fixture(
  extra: {
    factory?: () => ReturnType<typeof createAbortController>;
    flush?: () => Promise<void>;
    maxTurns?: number;
    command?: boolean;
  } = {},
) {
  let invocations = 0,
    keys = 0,
    ids = 0,
    toolCalls = 0;
  const journal = createInMemoryEffectJournalStore();
  const command: ToolDef = {
    id: 'run_command',
    source: 'builtin',
    description: 'Offline causal command control',
    llmVisibleParams: { type: 'object' },
    parseArgs: (value) => value,
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    effect: () => 1,
    dispatch: () => {
      toolCalls++;
      return Promise.resolve({ exitCode: 0, stdout: 'offline command', stderr: '', durationMs: 1 });
    },
  };
  const tools = extra.command ? [command] : [];
  const bus = new RunEventBus({ now: () => '2026-10-05T00:00:00.000Z' });
  const passive: RunOrSessionEvent[] = [];
  bus.subscribe((e) => {
    passive.push(e);
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
        surface: 'chat',
      },
    },
    generate: () => {
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      invocations++;
      yield { type: 'text_delta', text: 'fresh offline answer' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 2, outputTokens: 3 } };
    },
  };
  const session = new AgentSession({
    sessionId: 'r11-life',
    agentRef: 'a',
    agent: AgentSchema.parse({
      id: 'a',
      provider: 'openai',
      model,
      max_tokens: 8,
      system_prompt: 'offline',
    }),
    context: SessionContextSchema.parse({ workingDir: '/offline/r11', fsScopeTier: 'sandboxed' }),
    deps: {
      resolveProvider: () => provider,
      keyFor: () => {
        keys++;
        return 'synthetic-only';
      },
      sleep: () => Promise.resolve(),
      newAbortController: extra.factory ?? createAbortController,
      reserveEffectTurnKey: () => ++ids,
      registry: createToolRegistry({ tools, host: {} }),
      tools,
      effects: (correlation) => journal.for(correlation),
      autoCompact: false,
      maxTurns: extra.maxTurns ?? 1,
      resolvePrice: prices,
      emit: createSessionEventSink(bus, 'r11-life'),
      ...(extra.flush === undefined ? {} : { flushBudgetCommitments: extra.flush }),
    },
  });
  const handle = createSessionHandle(bus, 'r11-life', () => session.cancel());
  const primary: RunOrSessionEvent[] = [];
  const consumed = (async () => {
    for await (const e of handle.events) primary.push(e);
  })();
  session.start();
  return {
    session,
    passive,
    primary,
    consumed,
    counts: () => ({ invocations, keys, ids, toolCalls }),
  };
}

describe('R11 fresh real session bus plus real conservative flush', () => {
  for (const action of ['none', 'abort', 'cancel'] as const)
    for (const decision of ['ack', 'fail'] as const)
      it(`provider completed, held genuine flush ${action}/${decision}`, async () => {
        const write = deferred(),
          entered = deferred();
        const governor = new BudgetGovernor({
          budget: { max_cost_microcents: 1000, on_exceed: 'fail' },
          resolvePrice: prices,
          emit: () => write.promise,
        });
        const cap = prepareOutputCapPlan({
          model,
          provider: 'openai',
          endpoint: 'custom',
          maxTokens: 1,
          providerOptions: undefined,
        });
        const admission = await governor.checkPreEgress({
          ...cap,
          outputCapPlan: cap,
          inputTokensEstimate: 1,
          route: 'text',
          maxTokensEstimate: undefined,
        });
        admission?.settleAtReservedEstimate({ nodeId: 'actual-seeded-conservative-writer' });
        const h = fixture({
          flush: async () => {
            entered.resolve();
            await governor.flushCommitments();
          },
        });
        const active = h.session.sendMessage('offline measured turn').then(
          () => undefined,
          (e: unknown) => e,
        );
        await entered.promise;
        expect(h.counts().invocations).toBe(1);
        expect(h.passive.some((e) => e.type === 'session:turn_completed')).toBe(false);
        if (action === 'abort') h.session.abort();
        if (action === 'cancel') h.session.cancel();
        if (decision === 'ack') write.resolve();
        else write.reject(new Error('PRIVATE genuine flush failure'));
        const escaped = await active;
        if (action !== 'cancel') h.session.cancel();
        await h.consumed;

        if (action === 'cancel') {
          expect.soft(escaped).toBeUndefined();
          expect.soft(h.passive.filter((e) => e.type === 'session:turn_completed')).toHaveLength(0);
          expect.soft(h.passive.at(-1)?.type).toBe('session:cancelled');
          expect(h.primary.at(-1)?.type).toBe('session:cancelled');
        } else {
          const complete = h.passive.filter((e) => e.type === 'session:turn_completed');
          expect(complete).toHaveLength(1);
          expect(complete[0]).toMatchObject({
            tokensUsed: { input: 2, output: 3 },
            stopReason: decision === 'ack' ? 'stop' : action === 'abort' ? 'aborted' : 'error',
          });
          if (decision === 'ack' || action === 'abort') expect(escaped).toBeUndefined();
          else expect(escaped).toHaveProperty('name', 'CommitmentDurabilityError');
        }
        expect(h.passive.filter((e) => e.type === 'cost:updated')).toMatchObject([
          { inputTokens: 2, outputTokens: 3, costMicrocents: 8, priced: true },
        ]);
        expect(h.counts().invocations).toBe(1);
        expect(JSON.stringify(h.passive)).not.toContain('PRIVATE');
      });
});

describe('R11 fresh controller factory reentrancy', () => {
  for (const action of ['abort', 'cancel'] as const)
    it(`factory requests ${action} before returning controller`, async () => {
      let armed = true;
      const h = fixture({
        factory: () => {
          if (armed) {
            armed = false;
            if (action === 'abort') h.session.abort();
            else h.session.cancel();
          }
          return createAbortController();
        },
      });
      const escaped = await h.session.sendMessage('should be interrupted').then(
        () => undefined,
        (e: unknown) => e,
      );
      h.session.cancel();
      await h.consumed;
      expect.soft(escaped).toBeUndefined();
      expect.soft(h.counts().invocations).toBe(0);
      if (action === 'abort')
        expect
          .soft(h.passive.filter((e) => e.type === 'session:turn_completed'))
          .toMatchObject([{ stopReason: 'aborted', tokensUsed: { input: 0, output: 0 } }]);
      else expect.soft(h.passive.at(-1)?.type).toBe('session:cancelled');
    });
});

describe('R11 reentrant initializer common send/compact/real-registry command boundary', () => {
  for (const operation of ['compact', 'command'] as const)
    for (const action of ['none', 'abort', 'cancel'] as const)
      it(`${operation} controller ${action} honors pre-work interrupt`, async () => {
        let armed = false;
        const h = fixture({
          maxTurns: 8,
          command: true,
          factory: () => {
            if (armed) {
              armed = false;
              if (action === 'abort') h.session.abort();
              if (action === 'cancel') h.session.cancel();
            }
            return createAbortController();
          },
        });
        if (operation === 'compact') {
          await h.session.sendMessage('older exchange');
          await h.session.sendMessage('newer exchange');
        }
        const before = h.counts();
        armed = true;
        const result =
          operation === 'compact'
            ? await h.session.compact()
            : await h.session.runUserCommand('offline-command', []);
        h.session.cancel();
        await h.consumed;
        if (action === 'none') {
          expect(result.kind).toBe(operation === 'compact' ? 'compacted' : 'ran');
          expect(h.counts().invocations - before.invocations).toBe(operation === 'compact' ? 1 : 0);
          expect(h.counts().toolCalls).toBe(operation === 'command' ? 1 : 0);
        } else {
          expect.soft(result.kind).toBe('cancelled');
          expect.soft(h.counts().invocations).toBe(before.invocations);
          expect.soft(h.counts().toolCalls).toBe(0);
          if (action === 'cancel') expect.soft(h.passive.at(-1)?.type).toBe('session:cancelled');
        }
      });
});
