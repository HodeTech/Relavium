import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { createToolRegistry } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import { AgentSession, type SessionDeps, type SessionStreamEvent } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';

const AGENT = AgentSchema.parse({
  id: 'observer-test',
  provider: 'anthropic',
  model: 'claude-opus-4-8',
  system_prompt: 'Use the offline tools.',
  tools: ['echo'],
});
const CONTEXT = SessionContextSchema.parse({
  workingDir: '/workspace/session-observer',
  fsScopeTier: 'sandboxed',
});
const OBSERVERS = ['agent:tool_call', 'agent:tool_result'] as const;

function harness(journaled: boolean, observe: (event: SessionStreamEvent) => void) {
  const events: SessionStreamEvent[] = [];
  const journal = createInMemoryEffectJournalStore();
  const counts = { provider: 0, tools: 0, keys: 0 };
  const tool: ToolDef = {
    id: 'echo',
    source: 'builtin',
    description: 'offline tool',
    parseArgs: (args) => args,
    llmVisibleParams: { type: 'object' },
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    ...(journaled ? { effect: (): 3 => 3 } : {}),
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
      reasoning: false,
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
      if (counts.provider === 1) {
        // The second slot must never dispatch after the first slot's observer fails.
        for (const id of ['first', 'later']) {
          yield { type: 'tool_call_start', id, name: 'echo' };
          yield { type: 'tool_call_end', id };
        }
        yield { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 2, outputTokens: 3 } };
      } else {
        yield { type: 'text_delta', text: 'unexpected second provider call' };
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
  let turnKey = 40;
  const deps: SessionDeps = {
    resolveProvider: () => provider,
    registry: createToolRegistry({ tools: [tool], host: {} }),
    tools: [tool],
    maxTurns: 1,
    reserveEffectTurnKey: () => ++turnKey,
    effects: (correlation) => journal.for(correlation),
    keyFor: () => {
      counts.keys += 1;
      return 'offline-key';
    },
    sleep: () => Promise.resolve(),
    newAbortController: createAbortController,
    emit: (event) => {
      events.push(event);
      observe(event);
    },
  };
  const session = new AgentSession({
    sessionId: 'observer-session',
    agentRef: AGENT.id,
    agent: AGENT,
    context: CONTEXT,
    deps,
  });
  session.start();
  return { session, events, counts, journal };
}

describe('successful tool observer failures retain session engagement (ADR-0055 EA2)', () => {
  for (const journaled of [false, true]) {
    it.each(OBSERVERS)(
      `%s failure retains billed usage and the hard turn cap (${journaled ? 'effect' : 'read'})`,
      async (observer) => {
        let throws = 0;
        const h = harness(journaled, (event) => {
          if (event.type === observer && throws++ === 0) throw new Error('private-observer-cause');
        });
        let rawFailure: unknown;
        try {
          await h.session.sendMessage('run the tools');
        } catch (err) {
          rawFailure = err;
        }
        await h.session.sendMessage('must be over the cap');
        expect(h.counts).toEqual({ provider: 1, tools: 1, keys: 1 });
        expect(rawFailure).toBeUndefined();
        const terminals = h.events.filter((event) => event.type === 'session:turn_completed');
        expect(terminals).toHaveLength(2);
        expect(terminals[0]).toMatchObject({
          stopReason: 'error',
          tokensUsed: { input: 2, output: 3 },
          error: { code: 'internal', retryable: false },
        });
        expect(terminals[1]).toMatchObject({
          tokensUsed: { input: 0, output: 0 },
          error: { code: 'turn_limit' },
        });
        expect(h.events.filter((event) => event.type === 'agent:tool_call')).toHaveLength(1);
        expect(h.events.filter((event) => event.type === 'agent:tool_result')).toHaveLength(
          observer === 'agent:tool_call' ? 0 : 1,
        );
        expect(JSON.stringify(h.events)).not.toContain('private-observer-cause');
        expect(h.journal.rows()).toHaveLength(journaled ? 1 : 0);
        if (journaled)
          expect(h.journal.rows()[0]).toMatchObject({
            slot: 0,
            state: 'committed',
            attempt: { providerAttempt: 1, toolCallId: 'session-tool:41:0' },
          });
      },
    );
  }

  it.each(OBSERVERS)(
    '%s abort plus observer failure keeps cancellation precedence',
    async (observer) => {
      let abort = (): void => {};
      const h = harness(true, (event) => {
        if (event.type === observer) {
          abort();
          throw new Error('private-observer-cause');
        }
      });
      abort = () => h.session.cancel();
      await expect(h.session.sendMessage('run the tools')).resolves.toBeUndefined();
      expect(h.counts).toEqual({ provider: 1, tools: 1, keys: 1 });
      expect(h.events.filter((event) => event.type === 'session:cancelled')).toHaveLength(1);
      expect(h.events.some((event) => event.type === 'session:turn_completed')).toBe(false);
      expect(h.journal.rows()).toHaveLength(1);
      expect(h.journal.rows()[0]).toMatchObject({ state: 'committed', slot: 0 });
      expect(JSON.stringify(h.events)).not.toContain('private-observer-cause');
    },
  );
});
