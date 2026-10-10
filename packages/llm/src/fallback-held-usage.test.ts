import { describe, expect, it } from 'vitest';
import { FallbackChain, type AttemptRecord } from './fallback-chain.js';
import { makeLlmError } from './llm-error.js';
import type { CapabilityFlags, LlmProvider, StreamChunk, Usage } from './types.js';

const supports: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

describe('held terminal accounting survives the real attempt race', () => {
  for (const terminal of ['stop', 'error'] as const) {
    for (const ending of ['eof', 'cancel', 'deadline'] as const) {
      for (const quantity of ['positive', 'zero', 'invalid', 'pricing-failure'] as const) {
        it(`${terminal}/${ending}/${quantity}: preserves only the first valid observation once`, async () => {
          const caller = new AbortController();
          const original = {
            inputTokens: quantity === 'zero' ? 0 : 19,
            outputTokens: quantity === 'zero' ? 0 : quantity === 'invalid' ? -1 : 7,
          };
          const expected: Usage = { ...original };
          let fire: (() => void) | undefined;
          let release: () => void = () => undefined;
          const confirmingRead = new Promise<void>((resolve) => {
            release = resolve;
          });
          let didClose: () => void = () => undefined;
          const closed = new Promise<void>((resolve) => {
            didClose = resolve;
          });
          let resumed = false;
          let fallbackCalls = 0;
          let activeTimers = 0;
          const provider: LlmProvider = {
            id: 'anthropic',
            supports,
            generate: () => Promise.reject(new Error('stream-only control')),
            async *stream() {
              try {
                yield { type: 'text_delta', text: 'already delivered' };
                yield terminal === 'stop'
                  ? { type: 'stop', stopReason: 'stop', usage: original }
                  : {
                      type: 'error',
                      error: {
                        ...makeLlmError({
                          provider: 'anthropic',
                          kind: 'context_overflow',
                          message: 'native failure',
                        }),
                        usage: original,
                      },
                    };
                resumed = true;
                original.outputTokens = 999;
                if (ending === 'cancel') caller.abort();
                if (ending === 'deadline') {
                  if (fire === undefined) throw new Error('attempt deadline was not armed');
                  fire();
                }
                if (ending !== 'eof') await confirmingRead;
              } finally {
                didClose();
              }
            },
          };
          const fallback: LlmProvider = {
            ...provider,
            id: 'openai',
            stream: () => {
              fallbackCalls++;
              throw new Error('a committed attempt must not fail over');
            },
          };
          const records: AttemptRecord[] = [];
          const folded: Usage[] = [];
          const chain = new FallbackChain(
            [
              { provider, model: 'claude-haiku-4-5', maxAttempts: 3 },
              { provider: fallback, model: 'gpt-4o-mini', maxAttempts: 1 },
            ],
            {
              keyFor: () => 'offline-key',
              sleep: () => Promise.resolve(),
              newAbortController: () => new AbortController(),
              setTimer: (_ms, callback) => {
                fire = callback;
                activeTimers++;
                return () => {
                  activeTimers--;
                };
              },
              costTracker: {
                record: (_model, usage) => {
                  expect(Object.isFrozen(usage)).toBe(true);
                  folded.push(usage);
                  if (quantity === 'pricing-failure') throw new Error('PRIVATE_PRICING_CAUSE');
                  const amount = usage.inputTokens + usage.outputTokens;
                  return { ...usage, costMicrocents: amount, cumulativeCostMicrocents: amount };
                },
              },
              onAttempt: (record) => records.push(record),
            },
          );
          const out: StreamChunk[] = [];
          for await (const chunk of chain.stream({
            model: 'claude-haiku-4-5',
            messages: [],
            signal: caller.signal,
          })) {
            out.push(chunk);
          }
          expect(records).toHaveLength(1);
          expect(fallbackCalls).toBe(0);
          expect(activeTimers).toBe(0);
          expect(resumed).toBe(quantity !== 'invalid');
          expect(records[0]?.contentReceived).toBe(true);
          expect(records[0]?.usage).toEqual(quantity === 'invalid' ? undefined : expected);
          expect(folded).toEqual(quantity === 'invalid' ? [] : [expected]);
          const failure = records[0]?.error;
          const kind =
            quantity === 'invalid' || quantity === 'pricing-failure'
              ? 'unknown'
              : ending === 'cancel'
                ? 'cancelled'
                : ending === 'deadline'
                  ? 'timeout'
                  : terminal === 'error'
                    ? 'context_overflow'
                    : undefined;
          expect(failure?.kind).toBe(kind);
          expect(failure?.message ?? '').not.toContain('PRIVATE_PRICING_CAUSE');
          if (quantity === 'pricing-failure') expect(records[0]?.priced).toBe(false);
          if (kind !== undefined) expect(out.at(-1)?.type).toBe('error');
          else expect(out.at(-1)?.type).toBe('stop');

          // Teardown and a late source completion cannot create another record or price again.
          release();
          await closed;
          expect(records).toHaveLength(1);
          expect(folded).toHaveLength(quantity === 'invalid' ? 0 : 1);
        });
      }
    }
  }
});
