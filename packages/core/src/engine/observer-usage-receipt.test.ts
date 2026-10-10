import { expect, it } from 'vitest';
import type { LlmProvider, LlmResult } from '@relavium/llm';
import { createOpenAiAdapter } from '@relavium/llm/adapters';
import { UsageCoverageFold, unwiredEffectJournal, type UsageEvidence } from '@relavium/shared';
import {
  captureAgentTurnOutcome,
  DEFAULT_AGENT_TURN_LIMITS,
  type AgentTurnParams,
} from './agent-turn.js';
import {
  MoneyDurability,
  type SettledAttemptDraft,
  type UsageDispositionDraft,
} from './money-durability.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const streaming of [false, true]) {
  for (const failureMode of ['none', 'attempt', 'attempt-and-cleanup']) {
    const throws = failureMode !== 'none';
    for (const [name, evidence] of Object.entries({
      positive: { kind: 'complete', usage: { inputTokens: 3, outputTokens: 2 } },
      zero: { kind: 'complete', usage: { inputTokens: 0, outputTokens: 0 } },
      partial: { kind: 'partial', known: { outputTokens: 2 }, reason: 'missing_fields' },
      missing: { kind: 'missing', reason: 'not_reported' },
      invalid: { kind: 'complete', usage: { inputTokens: -1, outputTokens: 2 } },
    } satisfies Record<string, UsageEvidence>)) {
      it(`${streaming}/${failureMode}/${name}: an admission fault cannot strand late accounting authority`, async () => {
        const raw = deferred<LlmResult>();
        const entered = deferred<void>();
        const held: Promise<unknown>[] = [];
        const primary = Object.freeze({ admission: 'opaque primary fault' });
        const secondary = new Error('secondary conservative cleanup fault');
        const accountingFailures: unknown[] = [];
        const fold = new UsageCoverageFold();
        fold.start('complete');
        const rows: SettledAttemptDraft[] = [];
        const dispositions: UsageDispositionDraft[] = [];
        let estimates = 0;
        let actualSettlements = 0;
        let releases = 0;
        let calls = 0;
        let fire: () => void = () => {
          throw new Error('deadline not armed');
        };
        const provider: LlmProvider = {
          id: 'openai',
          supports: createOpenAiAdapter().supports,
          generate: () => {
            calls++;
            entered.resolve();
            return raw.promise;
          },
          async *stream() {
            calls++;
            entered.resolve();
            const result = await raw.promise;
            yield { type: 'stop', stopReason: result.stopReason, usage: result.usage };
          },
        };
        const money = new MoneyDurability({
          beginUsageInvocation: (draft) => {
            const invocation = Object.freeze({
              producerId: 'admission-receipt',
              ordinal: 1,
              dispatchId: 'turn',
              round: draft.round,
              chainAttempt: draft.chainAttempt,
            });
            fold.pending(draft.model, invocation);
            return Promise.resolve(invocation);
          },
          emitUsageDisposition: (draft) => {
            dispositions.push(draft);
            fold.disposition(
              draft.model,
              draft.invocation,
              draft.disposition,
              draft.receiptPending,
            );
          },
          emit: (draft) => {
            rows.push(draft);
            if (draft.invocation !== undefined) fold.complete(draft.model, draft.invocation);
          },
        });
        const abort = new AbortController();
        const params: AgentTurnParams = {
          nodeId: 'turn',
          messages: [],
          signal: abort.signal,
          ...(streaming ? {} : { outputModalities: ['text', 'audio'] }),
          planEntries: [{ provider, model: 'gpt-4o', maxAttempts: 1 }],
          chainCapabilities: {
            keyFor: () => 'offline',
            sleep: () => Promise.resolve(),
            newAbortController: () => new AbortController(),
            setTimer: (_ms, callback) => {
              fire = callback;
              return () => undefined;
            },
          },
          retainWork: (factory) => {
            const work = factory();
            held.push(work);
            void work.catch(() => undefined);
            return work;
          },
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
          money: {
            ...money.turnPort(() => 0),
            accountingFailure: (error) => {
              accountingFailures.push(error);
              money.accountingFailure(error);
            },
          },
          preEgress: () => ({
            settle: () => {
              actualSettlements++;
            },
            release: () => {
              releases++;
            },
            settleAtReservedEstimate: () => {
              // eslint-disable-next-line @typescript-eslint/only-throw-error -- Supplied admission callbacks may throw opaque non-Error values.
              if (++estimates === 1 && throws) throw primary;
              if (estimates === 2 && failureMode === 'attempt-and-cleanup') throw secondary;
            },
          }),
        };
        const running = captureAgentTurnOutcome(params);
        await entered.promise;
        fire();
        const outcome = await running;
        if (throws) {
          expect(outcome.kind).toBe('failed');
          if (outcome.kind === 'failed') {
            expect.soft(outcome.error).toBe(primary);
            expect(outcome.failureOrigin).toBe('turn');
          }
        } else expect(outcome.kind).toBe('failed');
        expect
          .soft(accountingFailures)
          .toEqual(failureMode === 'attempt-and-cleanup' ? [secondary] : []);
        expect.soft(money.durabilityBroken).toBe(failureMode === 'attempt-and-cleanup');
        const published = JSON.stringify(outcome);
        expect(fold.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: 1,
        });
        expect(fold.retainedInvocations).toBe(1);
        raw.resolve({ content: [], stopReason: 'stop', usage: evidence });
        await Promise.allSettled(held);
        await money.join();
        const complete = evidence.kind === 'complete' && name !== 'invalid';
        expect(rows).toHaveLength(complete ? 1 : 0);
        if (complete)
          expect(rows[0]).toMatchObject({
            invocation: {
              producerId: 'admission-receipt',
              ordinal: 1,
              dispatchId: 'turn',
              round: 0,
              chainAttempt: 1,
            },
            inputTokens: evidence.usage.inputTokens,
            outputTokens: evidence.usage.outputTokens,
            attemptNumber: 1,
          });
        expect(dispositions).toHaveLength(complete ? 1 : 2);
        expect(fold.snapshot().coverage).toEqual({
          unverified: false,
          pendingInvocations: 0,
          unknownCalls: complete ? 0 : 1,
        });
        expect(fold.retainedInvocations).toBe(0);
        expect(actualSettlements).toBe(0);
        expect(releases).toBe(0);
        expect(estimates).toBe(throws ? 2 : 1);
        expect(calls).toBe(1);
        expect(JSON.stringify(outcome)).toBe(published);
      });
    }
  }
}
