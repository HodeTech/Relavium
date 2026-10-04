import { describe, expect, it } from 'vitest';
import { type LlmProvider, type StreamChunk } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';

const supports: LlmProvider['supports'] = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [['image']],
  },
};
const tool: ToolDef = {
  id: 'probe',
  source: 'builtin',
  description: 'offline test',
  parseArgs: (v) => v,
  llmVisibleParams: { type: 'object' },
  policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
  effect: () => 3,
  dispatch: () => Promise.resolve('safe tool result'),
};
function sessionFixture(
  site: 'cost' | 'token' | 'ready',
  second: boolean,
  aborting: boolean,
  hostile: boolean,
) {
  const reflection = new Error('private reflected failure');
  const marker = hostile
    ? new Proxy(new Error('private original callback'), {
        getPrototypeOf() {
          throw reflection;
        },
      })
    : new Error('private ordinary callback');
  const journal = createInMemoryEffectJournalStore();
  const events: SessionStreamEvent[] = [];
  let calls = 0;
  let tools = 0;
  let current = '';
  let key = 0;
  const countedTool: ToolDef = {
    ...tool,
    dispatch: () => {
      tools++;
      return Promise.resolve('safe');
    },
  };
  const provider: LlmProvider = {
    id: 'anthropic',
    supports,
    generate: () => {
      throw new Error('unused');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      calls++;
      await Promise.resolve();
      if (second && calls === 1) {
        yield { type: 'tool_call_start', id: 'first', name: 'probe' };
        yield { type: 'tool_call_end', id: 'first' };
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 3 } };
        return;
      }
      current = 'text';
      yield { type: 'text_delta', text: 'response' };
      current = 'stop';
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 7 } };
    },
  };
  const active = () => calls === (second ? 2 : 1);
  const fail = (): never => {
    if (aborting) session.abort();
    throw marker;
  };
  const session = new AgentSession({
    sessionId: 'independent-r7',
    agentRef: 'probe-agent',
    agent: AgentSchema.parse({
      id: 'probe-agent',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      system_prompt: 'offline',
      tools: ['probe'],
    }),
    context: SessionContextSchema.parse({
      workingDir: '/workspace/offline',
      fsScopeTier: 'sandboxed',
    }),
    deps: {
      resolveProvider: () => provider,
      tools: [countedTool],
      registry: createToolRegistry({ tools: [countedTool], host: {} }),
      maxTurns: 1,
      reserveEffectTurnKey: () => ++key,
      effects: (correlation) => journal.for(correlation),
      keyFor: () => 'fake-offline',
      sleep: () => Promise.resolve(),
      now: () => 0,
      newAbortController: createAbortController,
      whenReady: () => {
        if (site === 'ready' && active() && current === 'stop') fail();
        return Promise.resolve();
      },
      emit: (e) => {
        events.push(e);
        if (
          active() &&
          ((site === 'cost' && e.type === 'cost:updated') ||
            (site === 'token' && e.type === 'agent:token'))
        )
          fail();
      },
    },
  });
  session.start();
  return { session, events, marker, reflection, count: () => ({ calls, tools }) };
}

describe('tool-round callback provenance', () => {
  for (const site of ['cost', 'token', 'ready'] as const)
    for (const second of [false, true])
      for (const hostile of [false, true])
        for (const aborting of [false, true])
          it(`${site} second=${second} hostile=${hostile} abort=${aborting}`, async () => {
            const h = sessionFixture(site, second, aborting, hostile);
            const observed = await h.session.sendMessage('run').then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(
              observed === (aborting ? undefined : h.marker),
              'original callback identity',
            ).toBe(true);
            const base = second ? { input: 2, output: 3 } : { input: 0, output: 0 };
            const expected =
              site === 'token' ? base : { input: base.input + 5, output: base.output + 7 };
            expect(h.events.filter((e) => e.type === 'session:turn_completed')).toEqual([
              expect.objectContaining({
                stopReason: aborting ? 'aborted' : 'error',
                tokensUsed: expected,
              }),
            ]);
            expect(h.count()).toEqual({ calls: second ? 2 : 1, tools: second ? 1 : 0 });
            await h.session.sendMessage('blocked');
            expect(h.count().calls).toBe(second ? 2 : 1);
            expect(h.events.at(-1)).toMatchObject({ error: { code: 'turn_limit' } });
            expect(JSON.stringify(h.events)).not.toContain('private');
          });
});
