import { describe, expect, it } from 'vitest';
import { AgentSchema, SessionContextSchema, type RunOrSessionEvent } from '@relavium/shared';
import type { LlmProvider, StreamChunk } from '@relavium/llm';
import { AgentSession, type SessionDeps } from './agent-session.js';
import { createAbortController, createInMemoryEffectJournalStore } from './execution-host.js';
import { RunEventBus } from './event-bus.js';
import { createSessionEventSink } from './session-handle.js';
import { createToolRegistry } from '../tools/registry.js';
import { BUILTIN_TOOLS } from '../tools/builtins.js';

function gate() {
  let release = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
function make(deps: Partial<SessionDeps> = {}) {
  const events: RunOrSessionEvent[] = [];
  const bus = new RunEventBus({ now: () => '2026-10-05T00:00:00.000Z' });
  bus.subscribe((e) => {
    events.push(e);
  });
  let seq = 0;
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
      throw new Error('stream required');
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      yield { type: 'text_delta', text: 'answer' };
      yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
  const session = new AgentSession({
    sessionId: 'r11-sibling',
    agentRef: 'a',
    agent: AgentSchema.parse({
      id: 'a',
      provider: 'openai',
      model: 'gpt-4o',
      system_prompt: 'offline',
    }),
    context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
    deps: {
      resolveProvider: () => provider,
      keyFor: () => 'synthetic',
      newAbortController: createAbortController,
      sleep: () => Promise.resolve(),
      reserveEffectTurnKey: () => ++seq,
      tools: [],
      registry: createToolRegistry({ tools: [], host: {} }),
      autoCompact: false,
      emit: createSessionEventSink(bus, 'r11-sibling'),
      ...deps,
    },
  });
  session.start();
  return { session, events, provider };
}
describe('R11 sibling operation cancellation controls', () => {
  for (const action of ['none', 'abort', 'cancel'] as const)
    for (const reject of [false, true])
      it(`actual command registry ${action} with ${reject ? 'rejected' : 'successful'} host completion`, async () => {
        const entered = gate(),
          done = gate();
        let spawns = 0;
        const journal = createInMemoryEffectJournalStore();
        const registry = createToolRegistry({
          tools: BUILTIN_TOOLS,
          host: {
            process: {
              spawn: async () => {
                spawns++;
                entered.release();
                await done.promise;
                if (reject) throw new Error('private host rejection');
                return { exitCode: 0, stdout: 'synthetic', stderr: '', durationMs: 1 };
              },
            },
          },
        });
        const h = make({
          registry,
          tools: BUILTIN_TOOLS,
          toolPolicy: { allowedCommands: ['review-command'] },
          effects: (scope) => journal.for(scope),
        });
        const command = h.session.runUserCommand('review-command', []);
        await entered.promise;
        if (action === 'cancel') h.session.cancel();
        if (action === 'abort') h.session.abort();
        done.release();
        const outcome = await command;
        expect(outcome.kind).toBe(action !== 'none' ? 'cancelled' : reject ? 'failed' : 'ran');
        expect(spawns).toBe(1);
        expect(JSON.stringify(h.events)).not.toContain('private');
        if (action === 'cancel') expect(h.events.at(-1)?.type).toBe('session:cancelled');
        else await h.session.sendMessage('still usable');
      });
  for (const action of ['none', 'abort', 'cancel'] as const)
    it(`compact ${action} while provider result is suspended`, async () => {
      const entered = gate(),
        done = gate();
      let calls = 0;
      const h = make();
      h.provider.stream = async function* (): AsyncGenerator<StreamChunk> {
        calls++;
        if (calls === 3) {
          entered.release();
          await done.promise;
        }
        yield { type: 'text_delta', text: calls === 3 ? 'new summary' : 'answer' };
        yield { type: 'stop', stopReason: 'stop', usage: { inputTokens: 4, outputTokens: 1 } };
      };
      await h.session.sendMessage('first');
      await h.session.sendMessage('second');
      const compact = h.session.compact();
      await entered.promise;
      if (action === 'cancel') h.session.cancel();
      if (action === 'abort') h.session.abort();
      done.release();
      const outcome = await compact;
      expect(outcome.kind).toBe(action === 'none' ? 'compacted' : 'cancelled');
      expect(calls).toBe(3);
      expect(h.events.filter((e) => e.type === 'session:compacted')).toHaveLength(
        action === 'none' ? 1 : 0,
      );
    });
  for (const action of ['none', 'abort', 'cancel'] as const)
    for (const throwing of [false, true])
      it(`compaction tokensAfter estimator ${action}, throwing=${throwing}`, async () => {
        let estimates = 0;
        const h = make();
        h.provider.estimateTokens = () => {
          estimates++;
          if (estimates === 2) {
            if (action === 'cancel') h.session.cancel();
            if (action === 'abort') h.session.abort();
            if (throwing) throw new Error('private estimate');
          }
          return 1;
        };
        await h.session.sendMessage('first');
        await h.session.sendMessage('second');
        const outcome = await h.session.compact();
        // ADR-0096/0099 Step 8 makes installation atomic through the final cancellation check.
        expect.soft(outcome.kind).toBe(action === 'none' ? 'compacted' : 'cancelled');
        if (action === 'cancel') expect.soft(h.events.at(-1)?.type).toBe('session:cancelled');
        expect
          .soft(h.events.filter((e) => e.type === 'session:compacted'))
          .toHaveLength(action === 'none' ? 1 : 0);
        if (action === 'abort') {
          let messageCount = 0,
            serialized = '';
          const prior = h.provider.stream.bind(h.provider);
          h.provider.stream = (request) => {
            messageCount = request.messages.length;
            serialized = JSON.stringify(request.messages);
            return prior(request, 'synthetic');
          };
          await h.session.sendMessage('after aborted summary');
          expect(messageCount).toBe(5);
          expect(serialized).toContain('first');
          expect(serialized).toContain('second');
          expect(serialized).not.toContain('automatically summarised');
        }
      });
});
