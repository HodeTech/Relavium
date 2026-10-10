import { describe, expect, it } from 'vitest';
import { InvalidUsageEvidenceError, type UsageEvidence } from '@relavium/shared';
import { snapshotLlmError } from './llm-error.js';
import { verifyStreamGrammar } from './stream-grammar.js';
import type { StreamChunk } from './types.js';

describe('every evidence arm is owned before the terminal confirming read', () => {
  for (const kind of ['complete', 'partial', 'missing'] as const)
    for (const terminal of ['stop', 'error'] as const) {
      it(`${kind}/${terminal}: provider aliases cannot rewrite the held observation`, async () => {
        const quantities = { inputTokens: 4, outputTokens: 2 };
        const usage: UsageEvidence =
          kind === 'complete'
            ? { kind, usage: quantities }
            : kind === 'partial'
              ? { kind, known: quantities, reason: 'missing_fields' }
              : { kind, reason: 'not_reported' };
        const expected = structuredClone(usage);
        async function* source(): AsyncGenerator<StreamChunk> {
          await Promise.resolve();
          yield terminal === 'stop'
            ? { type: 'stop', stopReason: 'stop', usage }
            : {
                type: 'error',
                error: {
                  provider: 'openai',
                  kind: 'transport',
                  retryable: true,
                  message: 'teardown',
                  usage,
                },
              };
          quantities.inputTokens = 99;
          if (usage.kind !== 'complete') usage.reason = 'invalid_fields';
        }
        const chunks: StreamChunk[] = [];
        for await (const chunk of verifyStreamGrammar(source(), 'openai')) chunks.push(chunk);
        const end = chunks.at(-1);
        const observed =
          end?.type === 'stop' ? end.usage : end?.type === 'error' ? end.error.usage : undefined;
        expect(observed).toEqual(expected);
        expect(Object.isFrozen(observed)).toBe(true);
      });
    }
  it('accountable error evidence uses the owned descriptor guard before Zod can read quantities', () => {
    let getters = 0;
    const known = {
      get outputTokens() {
        getters++;
        return 7;
      },
    };
    expect(() =>
      snapshotLlmError({
        provider: 'openai',
        kind: 'transport',
        retryable: true,
        message: 'teardown',
        usage: { kind: 'partial', known, reason: 'interrupted' },
      }),
    ).toThrow(InvalidUsageEvidenceError);
    expect(getters).toBe(0);
  });
});
