import { expect, it } from 'vitest';
import type { LlmProvider } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { unwiredEffectJournal } from '@relavium/shared';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import type { TurnMoneyPort } from './money-durability.js';

function fixture(streaming: boolean, complete: boolean) {
  let calls = 0;
  const provider: LlmProvider = {
    id: 'openai',
    supports: createOpenAiAdapter().supports,
    generate: () => {
      calls++;
      return Promise.resolve({ content: [], stopReason: 'stop', usage: evidence() });
    },
    async *stream() {
      await Promise.resolve();
      calls++;
      yield { type: 'stop', stopReason: 'stop', usage: evidence() };
    },
  };
  function evidence() {
    return complete
      ? ({ kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } } as const)
      : ({ kind: 'missing', reason: 'not_reported' } as const);
  }
  const params: AgentTurnParams = {
    nodeId: 'turn',
    messages: [],
    signal: new AbortController().signal,
    ...(streaming ? {} : { outputModalities: ['text', 'audio'] }),
    planEntries: [{ provider, model: 'gpt-4o', maxAttempts: 2 }],
    chainCapabilities: { keyFor: () => 'offline', sleep: () => Promise.resolve() },
    emit: () => undefined,
    registry: {
      has: () => false,
      list: () => [],
      dispatch: () => Promise.reject(new Error('unexpected dispatch')),
    },
    dispatchContext: {
      nodeId: 'turn',
      grantedToolIds: new Set(),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effects: unwiredEffectJournal(),
      effectSlot: 0,
    },
    limits: DEFAULT_AGENT_TURN_LIMITS,
  };
  return { params, calls: () => calls };
}

// Supported host admission callbacks can throw opaque values. These exercise the public port,
// not a claim that the current built-in governor throws twice synchronously.
for (const streaming of [false, true]) {
  for (const location of ['actual-fallback', 'outer-cleanup']) {
    for (const [name, primary] of Object.entries({
      opaque: Object.freeze({ primary: true }),
      null: null,
      undefined,
    })) {
      for (const health of ['absent', 'retained', 'throws']) {
        it(`${streaming}/${location}/${name}/${health}: exact primary survives secondary settlement`, async () => {
          const h = fixture(streaming, location === 'actual-fallback');
          const secondary = new Error('secondary estimate failure');
          const diagnostic = new Error('diagnostic sink failure');
          const reported: unknown[] = [];
          let estimates = 0;
          let actuals = 0;
          let releases = 0;
          let admissions = 0;
          const money: TurnMoneyPort = {
            record: () => undefined,
            join: () => Promise.resolve(),
            ...(health === 'absent'
              ? {}
              : {
                  accountingFailure: (error: unknown) => {
                    reported.push(error);
                    if (health === 'throws') throw diagnostic;
                  },
                }),
          };
          const outcome = await captureAgentTurnOutcome({
            ...h.params,
            money,
            preEgress: () => {
              admissions++;
              return {
                settle: () => {
                  actuals++;
                  // eslint-disable-next-line @typescript-eslint/only-throw-error -- Host callbacks may throw any opaque value, including null/undefined.
                  throw primary;
                },
                release: () => {
                  releases++;
                },
                settleAtReservedEstimate: () => {
                  estimates++;
                  if (location === 'outer-cleanup' && estimates === 1) {
                    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Preserve the supported opaque callback fault exactly.
                    throw primary;
                  }
                  if (estimates === (location === 'actual-fallback' ? 1 : 2)) throw secondary;
                },
              };
            },
          });
          expect(outcome.kind).toBe('failed');
          if (outcome.kind !== 'failed') throw new Error('expected admission failure');
          expect.soft(outcome.error).toBe(primary);
          expect(outcome.failureOrigin).toBe('turn');
          expect(reported).toEqual(health === 'absent' ? [] : [secondary]);
          expect({ estimates, actuals, releases, admissions, calls: h.calls() }).toEqual({
            estimates: 2,
            actuals: location === 'actual-fallback' ? 1 : 0,
            releases: 0,
            admissions: 1,
            calls: 1,
          });
        });
      }
    }
  }
  it(`${streaming}: a standalone conservative failure remains observable`, async () => {
    const h = fixture(streaming, false);
    const primary = new Error('standalone conservative failure');
    let estimates = 0;
    const outcome = await captureAgentTurnOutcome({
      ...h.params,
      // A refused duplicate claim leaves the admission to the outer conservative sweep.
      money: {
        join: () => Promise.resolve(),
        record: () => undefined,
        beginUsageInvocation: () =>
          Promise.resolve({
            producerId: 'p',
            ordinal: 1,
            dispatchId: 'd',
            round: 0,
            chainAttempt: 1,
          }),
        claimUsage: () => false,
      },
      preEgress: () => ({
        settle: () => {
          throw new Error('unexpected actual');
        },
        release: () => {
          throw new Error('unexpected release');
        },
        settleAtReservedEstimate: () => {
          estimates++;
          throw primary;
        },
      }),
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.error).toBe(primary);
    expect(estimates).toBe(1);
    expect(h.calls()).toBe(1);
  });
}
