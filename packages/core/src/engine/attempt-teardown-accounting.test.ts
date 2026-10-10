import { describe, expect, it } from 'vitest';
import {
  FallbackChain,
  CostTracker,
  LlmProviderError,
  makeLlmError,
  type AttemptRecord,
  type LlmProvider,
  type StreamChunk,
} from '@relavium/llm';
import { AgentSchema, SessionContextSchema } from '@relavium/shared';
import { AgentSession, type SessionStreamEvent } from './agent-session.js';
import { AgentTurnError } from './agent-turn.js';
import { createAbortController } from './execution-host.js';
import { createToolRegistry } from '../tools/registry.js';

const pricing = new Map([
  [
    'r11-disposal',
    {
      provider: 'openai' as const,
      nativeId: 'r11-disposal',
      displayName: 'r11-disposal',
      contextWindowTokens: 10000,
      maxOutputTokens: 100,
      inputPerMtokMicrocents: 1000000,
      outputPerMtokMicrocents: 2000000,
      cachedInputPerMtokMicrocents: 3000000,
    },
  ],
]);
function provider(failed: boolean, onCall: () => void): LlmProvider {
  const original = makeLlmError({
    provider: 'openai',
    kind: 'auth',
    message: 'original provider refusal',
    status: 401,
  });
  return {
    id: 'openai',
    customEndpoint: true,
    supports: {
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      promptCache: true,
      reasoning: false,
      media: {
        input: { image: false, audio: false, video: false, document: false },
        outputCombinations: [],
      },
    },
    generate: () => {
      onCall();
      if (failed) throw new LlmProviderError(original);
      return Promise.resolve({
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 },
      });
    },
    stream: async function* (): AsyncGenerator<StreamChunk> {
      await Promise.resolve();
      onCall();
      if (failed) {
        yield { type: 'error', error: original };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield {
        type: 'stop',
        stopReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 },
      };
    },
  };
}
describe('R11 independent deadline disposal outcome accounting', () => {
  for (const path of ['generate', 'stream'] as const)
    for (const failed of [false, true])
      for (const fault of ['none', 'raw', 'typed'] as const)
        it(`${path} providerFailed=${failed} cleanup=${fault}`, async () => {
          let calls = 0;
          const records: AttemptRecord[] = [];
          const tracker = new CostTracker(pricing);
          const marker =
            fault === 'typed'
              ? new AgentTurnError('provider_unavailable', 'private timer cleanup', true)
              : new Error('private timer cleanup');
          const p = provider(failed, () => {
            calls++;
          });
          const chain = new FallbackChain(
            [{ provider: p, model: 'r11-disposal', maxAttempts: 2 }],
            {
              keyFor: () => 'synthetic',
              sleep: () => Promise.resolve(),
              newAbortController: createAbortController,
              setTimer: () => () => {
                if (fault !== 'none') throw marker;
              },
              costTracker: tracker,
              onAttempt: (row) => {
                records.push(row);
              },
            },
          );
          const request = {
            model: 'r11-disposal',
            messages: [],
            signal: createAbortController().signal,
          };
          const chunks: StreamChunk[] = [];
          let escaped: unknown;
          try {
            if (path === 'generate') await chain.generate(request);
            else for await (const chunk of chain.stream(request)) chunks.push(chunk);
          } catch (error) {
            escaped = error;
          }
          expect(calls).toBe(1);
          expect.soft(records).toHaveLength(1);
          if (fault === 'none') {
            if (failed)
              expect(records[0]).toMatchObject({
                providerInvoked: true,
                outcome: 'failed',
                error: { kind: 'auth', status: 401 },
              });
            else
              expect(records[0]).toMatchObject({
                providerInvoked: true,
                outcome: 'succeeded',
                usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2 },
                cost: { costMicrocents: 17 },
              });
          } else {
            // An existing provider refusal keeps precedence; successful cleanup failure is a fixed,
            // non-retryable seam error. Neither path grants the host throwable's class any authority.
            const expectedKind = failed ? 'auth' : 'unknown';
            expect.soft(records[0]).toMatchObject({
              providerInvoked: true,
              outcome: 'failed',
              error: { kind: expectedKind },
            });
            if (!failed)
              expect.soft(records[0]).toMatchObject({
                usage: { inputTokens: 5, outputTokens: 3 },
                cost: { costMicrocents: 17 },
              });
            if (path === 'generate') {
              expect(escaped).toBeInstanceOf(LlmProviderError);
              if (!(escaped instanceof LlmProviderError))
                throw new Error('missing typed seam failure');
              expect(escaped.llmError).toMatchObject({ kind: expectedKind, retryable: false });
              if (!failed) expect(Object.is(escaped.llmError.cause, marker)).toBe(true);
              expect(escaped.llmError.message).not.toContain('private');
            } else {
              expect(escaped).toBeUndefined();
              const terminal = chunks.at(-1);
              expect(terminal).toMatchObject({
                type: 'error',
                error: { kind: expectedKind, retryable: false },
              });
              if (terminal?.type !== 'error') throw new Error('missing stream failure');
              if (!failed) expect(Object.is(terminal.error.cause, marker)).toBe(true);
              expect(terminal.error.message).not.toContain('private');
            }
          }
        });
  for (const failed of [false, true])
    it(`actual Session precontent engagement survives cleanup, providerFailed=${failed}`, async () => {
      let calls = 0,
        turn = 0;
      const events: SessionStreamEvent[] = [];
      const marker = new Error('private timer cleanup');
      const p = provider(failed, () => {
        calls++;
      });
      const session = new AgentSession({
        sessionId: 'r11-cleanup-session',
        agentRef: 'a',
        agent: AgentSchema.parse({
          id: 'a',
          provider: 'openai',
          model: 'r11-disposal',
          system_prompt: 'offline',
        }),
        context: SessionContextSchema.parse({ workingDir: '/offline', fsScopeTier: 'sandboxed' }),
        deps: {
          resolveProvider: () => p,
          keyFor: () => 'synthetic',
          sleep: () => Promise.resolve(),
          newAbortController: createAbortController,
          setTimer: () => () => {
            throw marker;
          },
          reserveEffectTurnKey: () => ++turn,
          tools: [],
          registry: createToolRegistry({ tools: [], host: {} }),
          maxTurns: 1,
          autoCompact: false,
          resolvePrice: pricing,
          emit: (e) => {
            events.push(e);
          },
        },
      });
      session.start();
      const first = await session.sendMessage('one').then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(first).toBeUndefined();
      expect(events.at(-1)).toMatchObject({
        error: { code: failed ? 'provider_auth' : 'internal', retryable: false },
      });
      expect(JSON.stringify(events)).not.toContain('private timer cleanup');
      expect.soft(events.at(-1)).toMatchObject({
        type: 'session:turn_completed',
        tokensUsed: failed ? { input: 0, output: 0 } : { input: 5, output: 3 },
      });
      await session.sendMessage('two').catch(() => undefined);
      expect.soft(calls).toBe(1);
      expect
        .soft(events.at(-1))
        .toMatchObject({ type: 'session:turn_completed', error: { code: 'turn_limit' } });
      if (!failed)
        expect
          .soft(events.filter((e) => e.type === 'cost:updated'))
          .toMatchObject([{ costMicrocents: 17 }]);
    });
});
